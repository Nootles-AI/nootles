/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { isCodeRefusal, normalizeCode } from "./accessCodes";
import { entitlementOf } from "./entitlements";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const ME = { subject: "user_me" };
const YOU = { subject: "user_you" };
const DAY = 24 * 60 * 60 * 1000;

/** An operator session, which every `adminBilling` function is behind. */
async function admin(t: TestConvex<typeof schema>) {
  const token = "admin-token";
  await t.run(async (ctx) => {
    await ctx.db.insert("adminSessions", {
      token,
      createdAt: 1,
      expiresAt: Date.now() + DAY,
    });
  });
  return token;
}

async function code(
  t: TestConvex<typeof schema>,
  fields: Partial<{
    code: string;
    maxRedemptions: number;
    durationDays: number;
    expiresAt: number;
    disabledAt: number;
  }> = {},
): Promise<Id<"accessCodes">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("accessCodes", {
      code: "FRIENDS",
      label: "Friends and family",
      redemptions: 0,
      createdAt: 1,
      ...fields,
    }),
  );
}

function refusedWith(reason: string) {
  return (e: unknown) => isCodeRefusal(e) && e.data.reason === reason;
}

describe("normalizeCode", () => {
  test("reads a code however it was transcribed", () => {
    for (const written of ["nootles-2026", "NOOTLES 2026", " Nootles2026 "]) {
      expect(normalizeCode(written)).toBe("NOOTLES2026");
    }
  });
});

describe("redeem", () => {
  test("a good code makes the account pro", async () => {
    const t = convexTest(schema, modules);
    await code(t);
    const result = await t
      .withIdentity(ME)
      .mutation(api.accessCodes.redeem, { code: "friends" });
    expect(result.expiresAt).toBeUndefined();
    expect(
      await t.run(async (ctx) => await entitlementOf(ctx, ME.subject)),
    ).toMatchObject({ plan: "pro", source: "code" });
  });

  test("a dated code grants from the moment it is redeemed", async () => {
    const t = convexTest(schema, modules);
    await code(t, { durationDays: 30 });
    const before = Date.now();
    const { expiresAt } = await t
      .withIdentity(ME)
      .mutation(api.accessCodes.redeem, { code: "FRIENDS" });
    expect(expiresAt).toBeGreaterThanOrEqual(before + 30 * DAY);
  });

  test("shortening a code afterwards does not shorten a grant already held", async () => {
    const t = convexTest(schema, modules);
    const id = await code(t, { durationDays: 365 });
    const { expiresAt } = await t
      .withIdentity(ME)
      .mutation(api.accessCodes.redeem, { code: "FRIENDS" });
    await t.run(async (ctx) => await ctx.db.patch(id, { durationDays: 1 }));
    const redemption = await t.run(async (ctx) =>
      ctx.db
        .query("codeRedemptions")
        .withIndex("by_owner", (q) => q.eq("ownerId", ME.subject))
        .unique(),
    );
    expect(redemption?.expiresAt).toBe(expiresAt);
  });

  test.each([
    ["unknown", async (t: TestConvex<typeof schema>) => void (await code(t, { code: "OTHER" }))],
    ["disabled", async (t: TestConvex<typeof schema>) => void (await code(t, { disabledAt: 2 }))],
    [
      "expired",
      async (t: TestConvex<typeof schema>) =>
        void (await code(t, { expiresAt: Date.now() - DAY })),
    ],
  ])("refuses a %s code", async (reason, setup) => {
    const t = convexTest(schema, modules);
    await setup(t);
    await expect(
      t.withIdentity(ME).mutation(api.accessCodes.redeem, { code: "FRIENDS" }),
    ).rejects.toSatisfy(refusedWith(reason));
  });

  test("refuses once the redemptions are all taken", async () => {
    const t = convexTest(schema, modules);
    await code(t, { maxRedemptions: 1 });
    await t.withIdentity(ME).mutation(api.accessCodes.redeem, { code: "FRIENDS" });
    await expect(
      t.withIdentity(YOU).mutation(api.accessCodes.redeem, { code: "FRIENDS" }),
    ).rejects.toSatisfy(refusedWith("exhausted"));
  });

  test("one per person, even when the grant has lapsed", async () => {
    const t = convexTest(schema, modules);
    await code(t, { durationDays: 1 });
    await t.withIdentity(ME).mutation(api.accessCodes.redeem, { code: "FRIENDS" });
    // Lapse it — otherwise "a month free" would be a subscription to anyone
    // who remembers to retype the code.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("codeRedemptions")
        .withIndex("by_owner", (q) => q.eq("ownerId", ME.subject))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });
    await expect(
      t.withIdentity(ME).mutation(api.accessCodes.redeem, { code: "FRIENDS" }),
    ).rejects.toSatisfy(refusedWith("already"));
  });

  test("refuses a signed-out redemption", async () => {
    const t = convexTest(schema, modules);
    await code(t);
    await expect(
      t.mutation(api.accessCodes.redeem, { code: "FRIENDS" }),
    ).rejects.toThrow();
  });
});

describe("adminBilling", () => {
  test("every function is behind the operator's token", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.query(api.adminBilling.codeList, { token: "not-a-token" }),
    ).rejects.toThrow();
  });

  test("mints a readable code and refuses to mint it twice", async () => {
    const t = convexTest(schema, modules);
    const token = await admin(t);
    const minted = await t.mutation(api.adminBilling.codeCreate, {
      token,
      label: "Launch",
    });
    expect(minted).toMatch(/^[A-Z2-9]{10}$/);
    await expect(
      t.mutation(api.adminBilling.codeCreate, {
        token,
        label: "Again",
        code: minted.toLowerCase(),
      }),
    ).rejects.toThrow(/already exists/);
  });

  test("disabling a code stops new redemptions and leaves old grants alone", async () => {
    const t = convexTest(schema, modules);
    const token = await admin(t);
    const id = await code(t);
    await t.withIdentity(ME).mutation(api.accessCodes.redeem, { code: "FRIENDS" });
    await t.mutation(api.adminBilling.codeSetDisabled, { token, id, disabled: true });

    await expect(
      t.withIdentity(YOU).mutation(api.accessCodes.redeem, { code: "FRIENDS" }),
    ).rejects.toSatisfy(refusedWith("disabled"));
    expect(
      await t.run(async (ctx) => await entitlementOf(ctx, ME.subject)),
    ).toMatchObject({ plan: "pro" });
  });

  test("VIP needs a reason, and clearing it keeps the record of why", async () => {
    const t = convexTest(schema, modules);
    const token = await admin(t);
    await expect(
      t.mutation(api.adminBilling.setVip, { token, ownerId: ME.subject, vip: true }),
    ).rejects.toThrow(/why/);

    await t.mutation(api.adminBilling.setVip, {
      token,
      ownerId: ME.subject,
      vip: true,
      note: "Design partner",
    });
    expect(
      await t.query(api.adminBilling.accountFor, { token, ownerId: ME.subject }),
    ).toMatchObject({
      entitlement: { plan: "pro", source: "vip" },
      vipNote: "Design partner",
    });

    await t.mutation(api.adminBilling.setVip, {
      token,
      ownerId: ME.subject,
      vip: false,
    });
    expect(
      await t.query(api.adminBilling.accountFor, { token, ownerId: ME.subject }),
    ).toMatchObject({
      entitlement: { plan: "free" },
      vipNote: "Design partner",
    });
  });

  test("the pro roster finds both VIPs and code redeemers", async () => {
    const t = convexTest(schema, modules);
    const token = await admin(t);
    await code(t);
    await t.withIdentity(ME).mutation(api.accessCodes.redeem, { code: "FRIENDS" });
    await t.mutation(api.adminBilling.setVip, {
      token,
      ownerId: YOU.subject,
      vip: true,
      note: "Investor",
    });
    const rows = await t.query(api.adminBilling.proAccounts, { token });
    expect(rows.map((r) => [r.ownerId, r.entitlement.source]).sort()).toEqual([
      [ME.subject, "code"],
      [YOU.subject, "vip"],
    ]);
  });

  test("the funnel lists who was stopped and is still not paying", async () => {
    const t = convexTest(schema, modules);
    const token = await admin(t);
    // One person stopped twice and still on free; one stopped, then comped.
    await t.withIdentity(ME).mutation(api.entitlements.sawWall, { meter: "chats" });
    await t.withIdentity(ME).mutation(api.entitlements.sawWall, { meter: "chats" });
    await t
      .withIdentity(YOU)
      .mutation(api.entitlements.sawWall, { meter: "projects" });
    await t.mutation(api.adminBilling.setVip, {
      token,
      ownerId: YOU.subject,
      vip: true,
      note: "Design partner",
    });

    const report = await t.query(api.adminBilling.funnel, { token });
    expect(report.walled).toBe(2);
    // Comped, not converted — `converted` counts money, and a VIP paid none.
    expect(report.converted).toBe(0);
    expect(report.stalled.map((r) => r.ownerId)).toEqual([ME.subject]);
    expect(report.stalled[0]).toMatchObject({ hits: 2, chats: 2, checkouts: 0 });
  });

  test("someone who paid drops off the stalled list", async () => {
    const t = convexTest(schema, modules);
    const token = await admin(t);
    await t.withIdentity(ME).mutation(api.entitlements.sawWall, { meter: "chats" });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("billingAccounts")
        .withIndex("by_owner", (q) => q.eq("ownerId", ME.subject))
        .unique();
      await ctx.db.patch(row!._id, {
        checkouts: 1,
        checkoutAt: Date.now(),
        subscription: {
          status: "active",
          interval: "month",
          currentPeriodEnd: Date.now() + DAY,
          cancelAtPeriodEnd: false,
          priceId: "price_test",
          subscriptionId: "sub_test",
          updatedAt: 1,
        },
      });
    });

    const report = await t.query(api.adminBilling.funnel, { token });
    expect(report).toMatchObject({ walled: 1, reachedCheckout: 1, converted: 1 });
    expect(report.stalled).toEqual([]);
  });

  test("codeRedemptions names who used it and whether it still stands", async () => {
    const t = convexTest(schema, modules);
    const token = await admin(t);
    const id = await code(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("profiles", {
        ownerId: ME.subject,
        email: "me@example.com",
        status: "done",
        createdAt: 1,
      });
    });
    await t.withIdentity(ME).mutation(api.accessCodes.redeem, { code: "FRIENDS" });
    expect(await t.query(api.adminBilling.codeRedemptions, { token, id })).toEqual([
      {
        ownerId: ME.subject,
        email: "me@example.com",
        name: null,
        redeemedAt: expect.any(Number),
        expiresAt: null,
        live: true,
      },
    ]);
  });
});
