/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { FREE_LIMITS, isQuotaRefusal } from "./entitlements";
import { PLANS, utcDay } from "./plans";

/**
 * What a workspace may do, and how that is decided: its plan column — Team
 * while its subscription is live or an operator has granted it, free
 * otherwise — with any override laid over it. An unpaid workspace is on the
 * free allowance, counted once for everybody in it and never against anyone's
 * own. A guest spends the workspace's AI up to a daily cap.
 */

const modules = import.meta.glob("./**/*.ts");

const OWNER = { subject: "user_ws_owner" };
const ADMIN = { subject: "user_ws_admin" };
const MEMBER = { subject: "user_member" };
const OTHER = { subject: "user_other_member" };
const GUEST = { subject: "user_guest" };
const STRANGER = { subject: "user_stranger" };

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 23, 12);

type Identity = { subject: string; act?: string };
type T = TestConvex<typeof schema>;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function world(t: T) {
  return await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      slug: "acme",
      name: "Acme",
      createdBy: OWNER.subject,
      plan: "team",
      settings: { linkSharing: true, guestCodeAccess: false, joinDomains: [], autoJoin: false },
      createdAt: 1,
    });
    await ctx.db.insert("workspaceSlugs", { slug: "acme", workspaceId });
    const seat = (who: Identity, role: Doc<"memberships">["role"]) =>
      ctx.db.insert("memberships", {
        workspaceId,
        userId: who.subject,
        role,
        status: "active",
        joinedAt: 1,
      });
    await seat(OWNER, "owner");
    await seat(ADMIN, "admin");
    await seat(MEMBER, "member");
    await seat(OTHER, "member");
    await seat(GUEST, "guest");
    return { workspaceId };
  });
}

/** A workspace project the guest and the stranger reach through its editor link. */
async function project(t: T, workspaceId: Id<"workspaces">, fields: Partial<Doc<"projects">> = {}) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      ownerId: MEMBER.subject,
      title: "P",
      createdAt: 1,
      workspaceId,
      editShareToken: "edit-token",
      ...fields,
    });
    for (const who of [GUEST, STRANGER]) {
      await ctx.db.insert("shareClaims", {
        projectId,
        granteeId: who.subject,
        role: "editor",
        createdAt: 1,
      });
    }
    const pageId = await ctx.db.insert("pages", {
      ownerId: MEMBER.subject,
      projectId,
      title: "",
      order: 0,
      docId: crypto.randomUUID(),
      createdAt: 1,
    });
    return { projectId, pageId };
  });
}

async function billing(
  t: T,
  workspaceId: Id<"workspaces">,
  fields: Partial<Doc<"workspaceBilling">> = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("workspaceBilling", {
      workspaceId,
      stripeCustomerId: "cus_ws",
      subscriptionId: "sub_ws",
      status: "active",
      seats: 3,
      periodStart: Date.now() - 10 * DAY,
      periodEnd: Date.now() + 20 * DAY,
      aiAllowanceUsd: 30,
      updatedAt: 1,
      ...fields,
    });
  });
}

async function override(
  t: T,
  workspaceId: Id<"workspaces">,
  feature: string,
  value: boolean | number | string,
  expiresAt?: number,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("workspaceEntitlements", {
      workspaceId,
      feature,
      value,
      note: "test",
      grantedBy: "test",
      grantedAt: 1,
      expiresAt,
    });
  });
}

const standing = (t: T, who: Identity, workspaceId: Id<"workspaces">) =>
  t.withIdentity(who).query(api.entitlements.forContainer, { workspaceId });

const refusedFor = (meter: string) => (e: unknown) =>
  isQuotaRefusal(e) && e.data.meter === meter;

describe("a workspace's plan", () => {
  test("without a subscription or a grant, it is free, on its own allowance", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    expect(await standing(t, MEMBER, workspaceId)).toEqual({
      container: { kind: "workspace", workspaceId, name: "Acme" },
      plan: "free",
      features: PLANS.free,
      entitlement: {
        plan: "free",
        source: "workspace",
        used: { projects: 0, completions: 0, chats: 0 },
        left: { ...FREE_LIMITS },
      },
      guestAi: null,
    });
  });

  test("a live subscription puts it on its plan until the period ends", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const periodEnd = Date.now() + 20 * DAY;
    await billing(t, workspaceId, { periodEnd });
    expect(await standing(t, MEMBER, workspaceId)).toMatchObject({
      plan: "team",
      features: PLANS.team,
      entitlement: { plan: "pro", source: "workspace", left: null, expiresAt: periodEnd },
    });
  });

  test("past due is still live; canceled, or long past its period, is not", async () => {
    const plan = async (fields: Partial<Doc<"workspaceBilling">>) => {
      const t = convexTest(schema, modules);
      const { workspaceId } = await world(t);
      await billing(t, workspaceId, fields);
      return (await standing(t, MEMBER, workspaceId))?.plan;
    };
    expect(await plan({ status: "past_due" })).toBe("team");
    expect(await plan({ status: "trialing" })).toBe("team");
    expect(await plan({ status: "canceled" })).toBe("free");
    expect(await plan({ status: "incomplete" })).toBe("free");
    // A late renewal is believed for the retry window, and not after it.
    expect(await plan({ periodEnd: Date.now() - DAY })).toBe("team");
    expect(await plan({ periodEnd: Date.now() - 4 * DAY })).toBe("free");
  });

  test("an operator's grant of a plan stands in for a subscription, until it expires", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await override(t, workspaceId, "plan", "team");
    expect(await standing(t, MEMBER, workspaceId)).toMatchObject({
      plan: "team",
      entitlement: { plan: "pro", left: null },
    });

    const lapsed = convexTest(schema, modules);
    const other = await world(lapsed);
    await override(lapsed, other.workspaceId, "plan", "team", Date.now() - 1);
    expect(await standing(lapsed, MEMBER, other.workspaceId)).toMatchObject({ plan: "free" });
  });

  test("a feature's override replaces it, whichever plan answered", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await billing(t, workspaceId);
    await override(t, workspaceId, "auditLog", false);
    await override(t, workspaceId, "guestDailyAiUsd", 5);
    // Of the wrong type, or naming nothing: not there.
    await override(t, workspaceId, "unmetered", "yes");
    await override(t, workspaceId, "sso", true);
    expect((await standing(t, MEMBER, workspaceId))?.features).toEqual({
      unmetered: true,
      auditLog: false,
      guestDailyAiUsd: 5,
    });
  });

  test("an unpaid workspace promised unmetered use is not walled", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await override(t, workspaceId, "unmetered", true);
    expect(await standing(t, MEMBER, workspaceId)).toMatchObject({
      plan: "free",
      entitlement: { plan: "pro", source: "workspace", left: null },
    });
  });

  test("asked by id, only a seat gets the workspace's answer", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await billing(t, workspaceId);
    expect((await standing(t, GUEST, workspaceId))?.plan).toBe("team");
    // No seat: their own account, and nothing about the workspace.
    expect(await standing(t, STRANGER, workspaceId)).toMatchObject({
      container: { kind: "account" },
      plan: "free",
      entitlement: { source: "none" },
    });
    expect(await t.query(api.entitlements.forContainer, { workspaceId })).toBeNull();
  });

  test("personal Pro buys nothing in an unpaid workspace, and a seat nothing in one's own", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("billingAccounts", {
        ownerId: MEMBER.subject,
        vip: true,
        acceptedCompletions: 0,
        chatConversations: 0,
        createdAt: 1,
      });
    });
    const team = await project(t, workspaceId);
    const me = t.withIdentity(MEMBER);
    expect(
      (await me.query(api.entitlements.forContainer, { projectId: team.projectId }))?.plan,
    ).toBe("free");
    expect((await me.query(api.entitlements.forContainer, {}))?.plan).toBe("pro");

    await billing(t, workspaceId);
    expect((await t.withIdentity(OTHER).query(api.entitlements.forContainer, {}))?.plan).toBe(
      "free",
    );
  });
});

describe("an unpaid workspace spends one allowance for everybody in it", () => {
  test("its chats are counted once, across its members, and never against theirs", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const { projectId } = await project(t, workspaceId);
    const chat = async (who: Identity) => {
      const caller = t.withIdentity(who);
      const threadId = await caller.mutation(api.chat.threads.create, { projectId });
      return caller.mutation(api.entitlements.beginChat, { threadId, projectId });
    };
    for (let i = 0; i < FREE_LIMITS.chats; i++) await chat(i % 2 ? MEMBER : OTHER);
    await expect(chat(ADMIN)).rejects.toSatisfy(refusedFor("chats"));

    const accounts = await t.run(async (ctx) => await ctx.db.query("billingAccounts").collect());
    expect(accounts).toEqual([]);
    expect((await standing(t, MEMBER, workspaceId))?.entitlement.left?.chats).toBe(0);
    // Their own projects are theirs as ever.
    const mine = await t.run(async (ctx) =>
      ctx.db.insert("projects", { ownerId: MEMBER.subject, title: "Mine", createdAt: 1 }),
    );
    const own = await t.withIdentity(MEMBER).mutation(api.chat.threads.create, { projectId: mine });
    await t.withIdentity(MEMBER).mutation(api.entitlements.beginChat, { threadId: own });
  });

  test("its accepted completions count while it is free, and not once it pays", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const { pageId } = await project(t, workspaceId);
    const accept = () =>
      t.withIdentity(MEMBER).mutation(api.ai.suggestions.log, {
        pageId,
        kind: "code",
        gateOk: true,
        shown: true,
        latencyMs: 1,
        outcome: "accepted",
      });
    await accept();
    await accept();
    expect((await standing(t, MEMBER, workspaceId))?.entitlement.used?.completions).toBe(2);

    await billing(t, workspaceId);
    await accept();
    const meters = await t.run(async (ctx) => await ctx.db.query("workspaceMeters").collect());
    expect(meters.map((row) => row.acceptedCompletions)).toEqual([2]);
  });

  test("its projects stop at the free limit, made or restored, and a plan lifts it", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const make = (who: Identity) =>
      t.withIdentity(who).mutation(api.projects.create, { title: "X", workspaceId });
    const first = await make(MEMBER);
    for (let i = 1; i < FREE_LIMITS.projects; i++) await make(OTHER);
    await expect(make(ADMIN)).rejects.toSatisfy(refusedFor("projects"));

    // A slot freed by the bin is taken back by the restore.
    await t.withIdentity(ADMIN).mutation(api.projects.remove, { projectId: first });
    await make(ADMIN);
    await expect(
      t.withIdentity(ADMIN).mutation(api.trash.restore, { projects: [first] }),
    ).rejects.toSatisfy(refusedFor("projects"));

    // None of it touched anyone's own limit.
    expect(
      (await t.withIdentity(MEMBER).query(api.entitlements.forContainer, {}))?.entitlement.used
        ?.projects,
    ).toBe(0);

    await override(t, workspaceId, "plan", "team");
    await t.withIdentity(ADMIN).mutation(api.trash.restore, { projects: [first] });
    await make(MEMBER);
  });
});

describe("a guest's day of a workspace's AI", () => {
  /** Signed spend for `who`, as the ledger leaves it. */
  const spend = (t: T, workspaceId: Id<"workspaces">, who: Identity, costUsd: number) =>
    t.run(async (ctx) => {
      await ctx.db.insert("guestAiSpend", {
        workspaceId,
        day: utcDay(Date.now()),
        userId: who.subject,
        costUsd,
      });
    });

  async function thread(t: T, who: Identity, projectId: Id<"projects">) {
    return await t.withIdentity(who).mutation(api.chat.threads.create, { projectId });
  }

  test("a guest is told their day, a member is not", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await billing(t, workspaceId);
    const { projectId } = await project(t, workspaceId);
    await spend(t, workspaceId, GUEST, 0.25);
    const ask = async (who: Identity) =>
      (await t.withIdentity(who).query(api.entitlements.forContainer, { projectId }))?.guestAi;
    expect(await ask(GUEST)).toEqual({ day: utcDay(Date.now()), capUsd: 1, spentUsd: 0.25 });
    // Let in by the link alone, a stranger is a guest here too.
    expect(await ask(STRANGER)).toEqual({ day: utcDay(Date.now()), capUsd: 1, spentUsd: 0 });
    expect(await ask(MEMBER)).toBeNull();
    expect(await ask(ADMIN)).toBeNull();
  });

  test("a guest past the cap is refused a chat, even one already under way", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await billing(t, workspaceId);
    const { projectId } = await project(t, workspaceId);
    const threadId = await thread(t, GUEST, projectId);
    const guest = t.withIdentity(GUEST);
    await guest.mutation(api.entitlements.beginChat, { threadId, projectId });

    await spend(t, workspaceId, GUEST, 1);
    const refusal = await guest
      .mutation(api.entitlements.beginChat, { threadId, projectId })
      .catch((e: unknown) => e);
    expect(isQuotaRefusal(refusal) && refusal.data).toEqual({
      code: "quota",
      meter: "guestAi",
      limit: 1,
    });

    // A member with the same spend is not a guest, and is not capped.
    await spend(t, workspaceId, MEMBER, 5);
    await t
      .withIdentity(MEMBER)
      .mutation(api.entitlements.beginChat, { threadId: await thread(t, MEMBER, projectId) });
  });

  test("the cap is the workspace's to raise, and a new day starts it again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await billing(t, workspaceId);
    const { projectId } = await project(t, workspaceId);
    await spend(t, workspaceId, GUEST, 1.5);
    const begin = async () =>
      t.withIdentity(GUEST).mutation(api.entitlements.beginChat, {
        threadId: await thread(t, GUEST, projectId),
      });
    await expect(begin()).rejects.toSatisfy(refusedFor("guestAi"));

    await override(t, workspaceId, "guestDailyAiUsd", 2);
    await begin();

    await t.run(async (ctx) => {
      const [row] = await ctx.db.query("workspaceEntitlements").collect();
      await ctx.db.patch(row._id, { value: 0 });
    });
    await expect(begin()).rejects.toSatisfy(refusedFor("guestAi"));
    // Zero is no AI at all for guests, the next day too.
    vi.setSystemTime(NOW + DAY);
    await expect(begin()).rejects.toSatisfy(refusedFor("guestAi"));
  });

  test("yesterday's spend is not today's", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await billing(t, workspaceId);
    const { projectId } = await project(t, workspaceId);
    await spend(t, workspaceId, GUEST, 3);
    vi.setSystemTime(NOW + DAY);
    await t.withIdentity(GUEST).mutation(api.entitlements.beginChat, {
      threadId: await thread(t, GUEST, projectId),
    });
  });
});

describe("the operator's overrides", () => {
  async function admin(t: T) {
    await t.run(async (ctx) => {
      await ctx.db.insert("adminSessions", {
        token: "ops",
        createdAt: 1,
        expiresAt: Date.now() + DAY,
      });
    });
    return "ops";
  }

  const set = (
    t: T,
    token: string,
    workspaceId: Id<"workspaces">,
    feature: string,
    value: boolean | number | string,
    note = "Promised on the Acme call",
  ) =>
    t.mutation(api.adminBilling.workspaceOverrideSet, { token, workspaceId, feature, value, note });

  test("need an operator session", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await expect(set(t, "nope", workspaceId, "plan", "team")).rejects.toThrow("Not authorized");
    await expect(
      t.query(api.adminBilling.workspaceOverrides, { token: "nope", workspaceId }),
    ).rejects.toThrow("Not authorized");
    await expect(
      t.mutation(api.adminBilling.workspaceOverrideClear, {
        token: "nope",
        workspaceId,
        feature: "plan",
      }),
    ).rejects.toThrow("Not authorized");
    await expect(t.query(api.adminBilling.workspaceList, { token: "nope" })).rejects.toThrow(
      "Not authorized",
    );
  });

  test("take only what a feature holds, and a reason", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const token = await admin(t);
    await expect(set(t, token, workspaceId, "plan", "platinum")).rejects.toThrow("A plan is one of");
    await expect(set(t, token, workspaceId, "sso", true)).rejects.toThrow("no feature called");
    await expect(set(t, token, workspaceId, "auditLog", 1)).rejects.toThrow("takes a boolean");
    await expect(set(t, token, workspaceId, "guestDailyAiUsd", -1)).rejects.toThrow(
      "no less than zero",
    );
    await expect(set(t, token, workspaceId, "plan", "team", "  ")).rejects.toThrow("Say why");
    expect(await t.run(async (ctx) => await ctx.db.query("workspaceEntitlements").collect())).toEqual(
      [],
    );
  });

  test("set, replace, list and clear, and the workspace follows", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const token = await admin(t);
    await set(t, token, workspaceId, "guestDailyAiUsd", 3);
    await set(t, token, workspaceId, "guestDailyAiUsd", 4);
    await set(t, token, workspaceId, "plan", "team");

    const listed = await t.query(api.adminBilling.workspaceOverrides, { token, workspaceId });
    expect(listed.standing).toMatchObject({ plan: "team", source: "override" });
    expect(listed.standing.features.guestDailyAiUsd).toBe(4);
    expect(listed.overrides.map((row) => [row.feature, row.value, row.live])).toEqual([
      ["guestDailyAiUsd", 4, true],
      ["plan", "team", true],
    ]);
    expect(await t.query(api.adminBilling.workspaceList, { token })).toMatchObject([
      { id: workspaceId, slug: "acme", plan: "team", source: "override" },
    ]);

    await t.mutation(api.adminBilling.workspaceOverrideClear, {
      token,
      workspaceId,
      feature: "plan",
    });
    expect((await standing(t, MEMBER, workspaceId))?.plan).toBe("free");
  });

  test("a tester's plan is granted from the command line by address", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await t.mutation(internal.adminBilling.grantWorkspaceOverride, {
      slug: "Acme",
      feature: "plan",
      value: "team",
      note: "Internal tester",
    });
    expect((await standing(t, MEMBER, workspaceId))?.plan).toBe("team");
    await expect(
      t.mutation(internal.adminBilling.grantWorkspaceOverride, {
        slug: "nowhere",
        feature: "plan",
        value: "team",
        note: "x",
      }),
    ).rejects.toThrow("No workspace answers");
  });

  test("the workspaces made before billing keep their plan, once", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const gone = await t.run(async (ctx) =>
      ctx.db.insert("workspaces", {
        slug: "gone",
        name: "Gone",
        createdBy: OWNER.subject,
        plan: "team",
        settings: { linkSharing: true, guestCodeAccess: false, joinDomains: [], autoJoin: false },
        createdAt: 1,
        deletedAt: 2,
      }),
    );
    const run = () =>
      t.mutation(internal.migrations.grandfatherWorkspaces, { note: "Before Team billing" });
    expect(await run()).toMatchObject({ seen: 2, granted: 1, done: true });
    expect(await run()).toMatchObject({ granted: 0 });
    expect((await standing(t, MEMBER, workspaceId))?.plan).toBe("team");
    const rows = await t.run(async (ctx) => await ctx.db.query("workspaceEntitlements").collect());
    expect(rows.map((row) => row.workspaceId)).toEqual([workspaceId]);
    expect(rows.some((row) => row.workspaceId === gone)).toBe(false);
  });
});
