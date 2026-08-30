/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import {
  FREE_LIMITS,
  entitlementOf,
  isQuotaRefusal,
  requireQuota,
  spendMeter,
} from "./entitlements";
import schema from "./schema";

/**
 * The resolution order is the whole point of this module, so most of what is
 * checked here is precedence: which of the four sources wins when more than one
 * has an opinion, and what happens as each of them lapses.
 */

const modules = import.meta.glob("./**/*.ts");

const ME = { subject: "user_me" };
const HOUR = 60 * 60 * 1000;

async function account(
  t: TestConvex<typeof schema>,
  fields: Partial<{
    vip: boolean;
    acceptedCompletions: number;
    chatConversations: number;
    subscription: {
      status: string;
      interval: "month" | "year";
      currentPeriodEnd: number;
      cancelAtPeriodEnd: boolean;
      priceId: string;
      subscriptionId: string;
      updatedAt: number;
    };
  }> = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("billingAccounts", {
      ownerId: ME.subject,
      acceptedCompletions: 0,
      chatConversations: 0,
      createdAt: 1,
      ...fields,
    });
  });
}

function subscription(status: string, endsIn = HOUR) {
  return {
    status,
    interval: "month" as const,
    currentPeriodEnd: Date.now() + endsIn,
    cancelAtPeriodEnd: false,
    priceId: "price_test",
    subscriptionId: "sub_test",
    updatedAt: 1,
  };
}

async function redeem(
  t: TestConvex<typeof schema>,
  expiresAt: number | undefined,
) {
  await t.run(async (ctx) => {
    const codeId = await ctx.db.insert("accessCodes", {
      code: "FRIENDS",
      label: "Friends",
      redemptions: 1,
      createdAt: 1,
    });
    await ctx.db.insert("codeRedemptions", {
      codeId,
      ownerId: ME.subject,
      redeemedAt: 1,
      expiresAt,
    });
  });
}

async function resolve(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => await entitlementOf(ctx, ME.subject));
}

async function project(
  t: TestConvex<typeof schema>,
  opts: { trashed?: boolean; ownerId?: string } = {},
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("projects", {
      ownerId: opts.ownerId ?? ME.subject,
      title: "P",
      createdAt: 1,
      ...(opts.trashed ? { deletedAt: 2 } : {}),
    });
  });
}

describe("entitlementOf", () => {
  test("an account nobody has touched is free with the whole allowance", async () => {
    const t = convexTest(schema, modules);
    expect(await resolve(t)).toMatchObject({
      plan: "free",
      source: "none",
      left: {
        projects: FREE_LIMITS.projects,
        completions: FREE_LIMITS.completions,
        chats: FREE_LIMITS.chats,
      },
    });
  });

  test("VIP outranks a spent allowance and a dead subscription alike", async () => {
    const t = convexTest(schema, modules);
    await account(t, {
      vip: true,
      acceptedCompletions: 9999,
      chatConversations: 9999,
      subscription: subscription("canceled"),
    });
    expect(await resolve(t)).toEqual({
      plan: "pro",
      source: "vip",
      left: null,
      used: null,
    });
  });

  test("a permanent code grant is pro with no expiry", async () => {
    const t = convexTest(schema, modules);
    await redeem(t, undefined);
    expect(await resolve(t)).toEqual({
      plan: "pro",
      source: "code",
      left: null,
      used: null,
    });
  });

  test("a lapsed code grant falls back to free", async () => {
    const t = convexTest(schema, modules);
    await redeem(t, Date.now() - HOUR);
    expect(await resolve(t)).toMatchObject({ plan: "free", source: "none" });
  });

  test("a code outranks a subscription, so the grant's date is the one shown", async () => {
    const t = convexTest(schema, modules);
    const expiresAt = Date.now() + 5 * HOUR;
    await account(t, { subscription: subscription("active") });
    await redeem(t, expiresAt);
    expect(await resolve(t)).toEqual({
      plan: "pro",
      source: "code",
      expiresAt,
      left: null,
      used: null,
    });
  });

  test.each([
    ["active", "pro"],
    ["trialing", "pro"],
    // Still in Stripe's retry loop — locking them out loses the customer the
    // retry was about to recover.
    ["past_due", "pro"],
    ["canceled", "free"],
    ["incomplete", "free"],
    ["unpaid", "free"],
  ])("a %s subscription resolves to %s", async (status, plan) => {
    const t = convexTest(schema, modules);
    await account(t, { subscription: subscription(status) });
    expect(await resolve(t)).toMatchObject({ plan });
  });

  test("a subscription set to end still says so while it runs", async () => {
    const t = convexTest(schema, modules);
    await account(t, {
      subscription: { ...subscription("active"), cancelAtPeriodEnd: true },
    });
    expect(await resolve(t)).toMatchObject({
      plan: "pro",
      source: "subscription",
      cancelAtPeriodEnd: true,
    });
  });

  test("a saturated meter reads zero left, never a negative", async () => {
    const t = convexTest(schema, modules);
    await account(t, { acceptedCompletions: FREE_LIMITS.completions + 7 });
    const e = await resolve(t);
    expect(e.left?.completions).toBe(0);
    expect(e.used?.completions).toBe(FREE_LIMITS.completions + 7);
  });
});

describe("the projects meter", () => {
  test("counts live projects, and a trashed one gives its slot back", async () => {
    const t = convexTest(schema, modules);
    await project(t);
    await project(t, { trashed: true });
    expect((await resolve(t)).left?.projects).toBe(FREE_LIMITS.projects - 1);
  });

  test("someone else's project is not counted against you", async () => {
    const t = convexTest(schema, modules);
    await project(t, { ownerId: "user_someone_else" });
    expect((await resolve(t)).left?.projects).toBe(FREE_LIMITS.projects);
  });
});

describe("requireQuota", () => {
  test("refuses at the limit, with the meter named", async () => {
    const t = convexTest(schema, modules);
    await account(t, { chatConversations: FREE_LIMITS.chats });
    await expect(
      t.run(async (ctx) => await requireQuota(ctx, ME.subject, "chats")),
    ).rejects.toSatisfy(
      (e: unknown) => isQuotaRefusal(e) && e.data.meter === "chats",
    );
  });

  test("lets the last one through, and refuses the one after", async () => {
    const t = convexTest(schema, modules);
    await account(t, { chatConversations: FREE_LIMITS.chats - 1 });
    await t.run(async (ctx) => await requireQuota(ctx, ME.subject, "chats"));
    await t.run(async (ctx) => await spendMeter(ctx, ME.subject, "chats"));
    await expect(
      t.run(async (ctx) => await requireQuota(ctx, ME.subject, "chats")),
    ).rejects.toThrow();
  });

  test("never refuses a pro account", async () => {
    const t = convexTest(schema, modules);
    await account(t, { vip: true, chatConversations: 9999 });
    await t.run(async (ctx) => await requireQuota(ctx, ME.subject, "chats"));
  });
});

describe("spendMeter", () => {
  test("creates the account row on first use", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => await spendMeter(ctx, ME.subject, "completions"));
    expect((await resolve(t)).used?.completions).toBe(1);
  });
});

describe("the gates", () => {
  test("projects.create refuses once the free slots are full", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < FREE_LIMITS.projects; i++) await project(t);
    await expect(
      t.withIdentity(ME).mutation(api.projects.create, { title: "One more" }),
    ).rejects.toSatisfy(
      (e: unknown) => isQuotaRefusal(e) && e.data.meter === "projects",
    );
  });

  test("the tutorial's seeded project is not metered, so a new account can have one", async () => {
    const t = convexTest(schema, modules);
    // Two projects already, which is the whole allowance — the tutorial path
    // must still seed, because it is what a brand new account arrives into.
    for (let i = 0; i < FREE_LIMITS.projects; i++) await project(t);
    await t.withIdentity(ME).mutation(api.onboarding.createSeededProject, {
      title: "Tutorial",
      template: "plan",
      defaultMode: "create",
      pages: [],
      context: [],
      priorChat: { title: "T", asked: "a", answered: "b" },
    });
  });

  test("accepting a suggestion spends a completion; dismissing one does not", async () => {
    const t = convexTest(schema, modules);
    const pageId = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", {
        ownerId: ME.subject,
        title: "P",
        createdAt: 1,
      });
      return await ctx.db.insert("pages", {
        ownerId: ME.subject,
        projectId,
        title: "",
        order: 0,
        docId: crypto.randomUUID(),
        createdAt: 1,
      });
    });
    const settled = { pageId, kind: "code", gateOk: true, shown: true, latencyMs: 1 };
    await t
      .withIdentity(ME)
      .mutation(api.ai.suggestions.log, { ...settled, outcome: "dismissed" });
    expect((await resolve(t)).used?.completions).toBe(0);
    await t
      .withIdentity(ME)
      .mutation(api.ai.suggestions.log, { ...settled, outcome: "accepted" });
    expect((await resolve(t)).used?.completions).toBe(1);
  });
});

describe("beginChat", () => {
  async function thread(t: TestConvex<typeof schema>) {
    return await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", {
        ownerId: ME.subject,
        title: "P",
        createdAt: 1,
      });
      return await ctx.db.insert("chatThreads", {
        ownerId: ME.subject,
        projectId,
        title: "",
        createdAt: 1,
        updatedAt: 1,
      });
    });
  }

  test("charges a conversation once, however many requests it takes", async () => {
    const t = convexTest(schema, modules);
    const threadId = await thread(t);
    const me = t.withIdentity(ME);
    await me.mutation(api.entitlements.beginChat, { threadId });
    await me.mutation(api.entitlements.beginChat, { threadId });
    await me.mutation(api.entitlements.beginChat, { threadId });
    expect((await resolve(t)).used?.chats).toBe(1);
  });

  test("a conversation already paid for keeps working after the allowance runs out", async () => {
    const t = convexTest(schema, modules);
    const threadId = await thread(t);
    const me = t.withIdentity(ME);
    await me.mutation(api.entitlements.beginChat, { threadId });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billingAccounts")
        .withIndex("by_owner", (q) => q.eq("ownerId", ME.subject))
        .unique();
      await ctx.db.patch(row!._id, { chatConversations: FREE_LIMITS.chats });
    });
    // The next NEW conversation is refused...
    const other = await thread(t);
    await expect(
      me.mutation(api.entitlements.beginChat, { threadId: other }),
    ).rejects.toThrow();
    // ...but this one is not interrupted mid-sentence.
    await me.mutation(api.entitlements.beginChat, { threadId });
  });

  test("a pro account's threads are left unstamped, so lapsing costs them nothing", async () => {
    const t = convexTest(schema, modules);
    await account(t, { vip: true });
    const threadId = await thread(t);
    await t.withIdentity(ME).mutation(api.entitlements.beginChat, { threadId });
    const row = await t.run(async (ctx) => await ctx.db.get(threadId));
    expect(row?.billedAt).toBeUndefined();
    await t.run(async (ctx) => {
      const acc = await ctx.db
        .query("billingAccounts")
        .withIndex("by_owner", (q) => q.eq("ownerId", ME.subject))
        .unique();
      expect(acc?.chatConversations).toBe(0);
    });
  });

  test("refuses somebody else's thread", async () => {
    const t = convexTest(schema, modules);
    const threadId = await thread(t);
    await expect(
      t
        .withIdentity({ subject: "user_stranger" })
        .mutation(api.entitlements.beginChat, { threadId }),
    ).rejects.toThrow();
  });
});

describe("grandfathering", () => {
  test("conversations that predate the paywall are never charged", async () => {
    const t = convexTest(schema, modules);
    const threadId = await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", {
        ownerId: ME.subject,
        title: "P",
        createdAt: 1,
      });
      // No `billedAt` — written before the meter existed.
      return await ctx.db.insert("chatThreads", {
        ownerId: ME.subject,
        projectId,
        title: "An old conversation",
        createdAt: 1000,
        updatedAt: 1000,
      });
    });

    await t.mutation(internal.migrations.grandfatherChatThreads, {});
    expect(
      await t.run(async (ctx) => (await ctx.db.get(threadId))?.billedAt),
    ).toBe(1000);

    // And carrying on in it now spends nothing.
    await t.withIdentity(ME).mutation(api.entitlements.beginChat, { threadId });
    expect((await resolve(t)).used?.chats).toBe(0);
  });

  test("running it twice changes nothing", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", {
        ownerId: ME.subject,
        title: "P",
        createdAt: 1,
      });
      await ctx.db.insert("chatThreads", {
        ownerId: ME.subject,
        projectId,
        title: "",
        createdAt: 1000,
        updatedAt: 1000,
      });
    });
    await t.mutation(internal.migrations.grandfatherChatThreads, {});
    expect(
      await t.mutation(internal.migrations.grandfatherChatThreads, {}),
    ).toMatchObject({ seen: 1, stamped: 0, done: true });
  });
});

describe("sawWall", () => {
  test("counts each wall separately and keeps the first and last times", async () => {
    const t = convexTest(schema, modules);
    const me = t.withIdentity(ME);
    await me.mutation(api.entitlements.sawWall, { meter: "projects" });
    await me.mutation(api.entitlements.sawWall, { meter: "chats" });
    await me.mutation(api.entitlements.sawWall, { meter: "chats" });

    const walls = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billingAccounts")
        .withIndex("by_owner", (q) => q.eq("ownerId", ME.subject))
        .unique();
      return row?.walls;
    });
    expect(walls).toMatchObject({ projects: 1, completions: 0, chats: 2 });
    expect(walls!.lastAt).toBeGreaterThanOrEqual(walls!.firstAt);
  });

  test("refuses an operator standing in, so looking never becomes data", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t
        .withIdentity({ ...ME, act: "operator" })
        .mutation(api.entitlements.sawWall, { meter: "chats" }),
    ).rejects.toThrow();
  });
});

describe("the mine query", () => {
  // Null, not a zeroed free plan: a share-link visitor and the moment before
  // Clerk resolves must not read as somebody who spent their whole allowance.
  test("answers null when nobody is signed in", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.entitlements.mine, {})).toBeNull();
  });

  test("answers the caller's own entitlement", async () => {
    const t = convexTest(schema, modules);
    await account(t, { vip: true });
    expect(
      await t.withIdentity(ME).query(api.entitlements.mine, {}),
    ).toMatchObject({ plan: "pro", source: "vip" });
  });
});
