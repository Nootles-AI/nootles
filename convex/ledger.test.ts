/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { signCall, type SignedCall } from "./ai/callSignature";
import { utcDay } from "./plans";

/**
 * The cost ledger a workspace is billed from. Anyone signed in can call its
 * writer, so a row is believed — billed, and counted against a guest's day —
 * only when the Next server signed it with the secret the two share. A row
 * that claims what no call could cost is not kept at all; one whose signature
 * is missing, stale or does not hold is kept, unsigned, saying which (NT-82).
 */

const modules = import.meta.glob("./**/*.ts");

const SECRET = "a-shared-ledger-secret";
const MEMBER = { subject: "user_member" };
const GUEST = { subject: "user_guest" };

type Identity = { subject: string };
type T = TestConvex<typeof schema>;
type Call = Omit<SignedCall, "ownerId" | "signedAt"> & {
  feature: "chat";
  latencyMs: number;
  status: "ok";
};

beforeEach(() => vi.stubEnv("AI_LEDGER_SECRET", SECRET));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function world(t: T) {
  return await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      slug: "acme",
      name: "Acme",
      createdBy: MEMBER.subject,
      plan: "team",
      settings: { linkSharing: true, guestCodeAccess: false, joinDomains: [], autoJoin: false },
      createdAt: 1,
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userId: MEMBER.subject,
      role: "member",
      status: "active",
      joinedAt: 1,
    });
    await ctx.db.insert("memberships", {
      workspaceId,
      userId: GUEST.subject,
      role: "guest",
      status: "active",
      joinedAt: 1,
    });
    const projectId = await ctx.db.insert("projects", {
      ownerId: MEMBER.subject,
      title: "P",
      createdAt: 1,
      workspaceId,
      editShareToken: "edit-token",
    });
    await ctx.db.insert("shareClaims", {
      projectId,
      granteeId: GUEST.subject,
      role: "editor",
      createdAt: 1,
    });
    return { workspaceId, projectId };
  });
}

const call = (projectId: Id<"projects">, costUsd = 0.4): Call => ({
  feature: "chat",
  model: "m",
  projectId,
  promptTokens: 1000,
  completionTokens: 200,
  costUsd,
  latencyMs: 1,
  status: "ok",
});

/** What the Next route sends: the call, and its signature for `who`. */
async function signed(who: Identity, row: Call, { secret = SECRET, signedAt = Date.now() } = {}) {
  return {
    ...row,
    signedAt,
    signature: await signCall(secret, { ownerId: who.subject, ...row, signedAt }),
  };
}

const rows = (t: T) => t.run(async (ctx) => await ctx.db.query("aiCalls").collect());
const days = (t: T) => t.run(async (ctx) => await ctx.db.query("guestAiSpend").collect());

describe("a signed row", () => {
  test("is believed, and charged to the workspace the project is in", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t);
    await t
      .withIdentity(MEMBER)
      .mutation(api.ai.calls.record, await signed(MEMBER, call(projectId)));
    expect(await rows(t)).toMatchObject([
      { ownerId: MEMBER.subject, workspaceId, costUsd: 0.4, signed: true },
    ]);
    // A member holds a seat: nothing of theirs is a guest's day.
    expect(await days(t)).toEqual([]);
  });

  test("of a guest's adds to their day, and every one after it too", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t);
    const guest = t.withIdentity(GUEST);
    await guest.mutation(api.ai.calls.record, await signed(GUEST, call(projectId, 0.4)));
    await guest.mutation(api.ai.calls.record, await signed(GUEST, call(projectId, 0.35)));
    const [day] = await days(t);
    expect(day).toMatchObject({ workspaceId, userId: GUEST.subject, day: utcDay(Date.now()) });
    expect(day.costUsd).toBeCloseTo(0.75);
  });

  test("that does not hold is kept unsigned, says why, and is never counted (NT-82)", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await world(t);
    const guest = t.withIdentity(GUEST);
    const honest = await signed(GUEST, call(projectId, 0.4));
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    const attempts: [string, Promise<unknown>][] = [
      // The cost changed after signing.
      ["invalid", guest.mutation(api.ai.calls.record, { ...honest, costUsd: 0.01 })],
      // Another workspace's project, under the same signature.
      ["invalid", guest.mutation(api.ai.calls.record, { ...honest, projectId: undefined })],
      // Signed for somebody else.
      ["invalid", t.withIdentity(MEMBER).mutation(api.ai.calls.record, honest)],
      // Signed with a secret that is not the deployment's: Vercel's and Convex's differ.
      ["invalid", guest.mutation(api.ai.calls.record, await signed(GUEST, call(projectId), { secret: "guess" }))],
      // Not hex at all.
      ["invalid", guest.mutation(api.ai.calls.record, { ...honest, signature: "forged" })],
      // Signed long ago, or by a clock running far ahead.
      ["stale", guest.mutation(api.ai.calls.record, await signed(GUEST, call(projectId), { signedAt: Date.now() - 60 * 60_000 }))],
      ["stale", guest.mutation(api.ai.calls.record, await signed(GUEST, call(projectId), { signedAt: Date.now() + 10 * 60_000 }))],
    ];
    for (const [, attempt] of attempts) await attempt;

    const kept = await rows(t);
    expect(kept.map((r: Doc<"aiCalls">) => [r.unverified, r.signed])).toEqual(
      attempts.map(([why]) => [why, undefined]),
    );
    expect(await days(t)).toEqual([]);
    // Said where an operator looks, by reason alone — never the row's cost or model.
    expect(warned.mock.calls.map(([line]) => line)).toEqual(
      attempts.map(([why]) => `[ledger] chat row kept unsigned: signature ${why}`),
    );
    warned.mockRestore();
  });
});

describe("an unsigned row", () => {
  test("is kept, but never counted", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await t.withIdentity(GUEST).mutation(api.ai.calls.record, call(projectId, 50));
    const [row] = await rows(t);
    expect(row).toMatchObject({ workspaceId, costUsd: 50, unverified: "missing" });
    expect(row.signed).toBeUndefined();
    expect(await days(t)).toEqual([]);
  });

  test("is all a deployment without the secret writes, whatever it is sent", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await world(t);
    const row = await signed(GUEST, call(projectId));
    vi.stubEnv("AI_LEDGER_SECRET", "");
    await t.withIdentity(GUEST).mutation(api.ai.calls.record, row);
    // Nothing to check it against, so nothing to say about it: billing is off here by design.
    expect((await rows(t)).map((r: Doc<"aiCalls">) => [r.signed, r.unverified])).toEqual([[undefined, undefined]]);
    expect(await days(t)).toEqual([]);
  });
});

describe("a row no call could have made", () => {
  test("is refused, signed or not", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await world(t);
    const member = t.withIdentity(MEMBER);
    const absurd: Partial<Call>[] = [
      { costUsd: -1 },
      { costUsd: Number.NaN },
      { costUsd: Number.POSITIVE_INFINITY },
      { costUsd: 1_000 },
      { promptTokens: -5 },
      { completionTokens: 1e12 },
      { latencyMs: -1 },
      { model: "m".repeat(500) },
    ];
    for (const change of absurd) {
      const row = { ...call(projectId), ...change };
      for (const args of [row, await signed(MEMBER, row)]) {
        await expect(member.mutation(api.ai.calls.record, args)).rejects.toThrow(
          "That isn’t a model call anything could have made.",
        );
      }
    }
    expect(await rows(t)).toEqual([]);
  });
});
