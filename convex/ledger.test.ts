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
 * that claims what no call could cost is not kept at all; one that merely
 * lacks a signature is kept, unsigned.
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
afterEach(() => vi.unstubAllEnvs());

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

  test("that does not hold is refused, and leaves nothing", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await world(t);
    const guest = t.withIdentity(GUEST);
    const honest = await signed(GUEST, call(projectId, 0.4));
    const refused = "That ledger row’s signature doesn’t hold.";

    // The cost changed after signing.
    await expect(
      guest.mutation(api.ai.calls.record, { ...honest, costUsd: 0.01 }),
    ).rejects.toThrow(refused);
    // Another workspace's project, under the same signature.
    await expect(
      guest.mutation(api.ai.calls.record, { ...honest, projectId: undefined }),
    ).rejects.toThrow(refused);
    // Signed for somebody else.
    await expect(
      t.withIdentity(MEMBER).mutation(api.ai.calls.record, honest),
    ).rejects.toThrow(refused);
    // Signed with a secret that is not the deployment's.
    await expect(
      guest.mutation(api.ai.calls.record, await signed(GUEST, call(projectId), { secret: "guess" })),
    ).rejects.toThrow(refused);
    // Not hex at all.
    await expect(
      guest.mutation(api.ai.calls.record, { ...honest, signature: "forged" }),
    ).rejects.toThrow(refused);
    // Signed long ago, or far ahead of the clock.
    for (const signedAt of [Date.now() - 60 * 60_000, Date.now() + 10 * 60_000]) {
      await expect(
        guest.mutation(api.ai.calls.record, await signed(GUEST, call(projectId), { signedAt })),
      ).rejects.toThrow(refused);
    }
    expect(await rows(t)).toEqual([]);
    expect(await days(t)).toEqual([]);
  });
});

describe("an unsigned row", () => {
  test("is kept, but never counted", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t);
    await t.withIdentity(GUEST).mutation(api.ai.calls.record, call(projectId, 50));
    const [row] = await rows(t);
    expect(row).toMatchObject({ workspaceId, costUsd: 50 });
    expect(row.signed).toBeUndefined();
    expect(await days(t)).toEqual([]);
  });

  test("is all a deployment without the secret writes, whatever it is sent", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await world(t);
    const row = await signed(GUEST, call(projectId));
    vi.stubEnv("AI_LEDGER_SECRET", "");
    await t.withIdentity(GUEST).mutation(api.ai.calls.record, row);
    expect((await rows(t)).map((r: Doc<"aiCalls">) => r.signed)).toEqual([undefined]);
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
