/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import componentSchema from "../node_modules/@convex-dev/stripe/src/component/schema";
import { api, components, internal } from "./_generated/api";
import schema from "./schema";

/**
 * The webhook mirror, fed the Stripe component's own rows the way its webhook
 * handlers write them. What is checked is which of an account's subscriptions
 * gets to speak for it, because that one choice decides whether someone who is
 * paying is treated as paying.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/stripe/src/component/**/*.ts",
);

const ME = { subject: "user_me" };
const ANNUAL = "price_annual";
const MONTHLY = "price_monthly";
/** Stripe's timestamps are seconds. */
const DAY = 24 * 60 * 60;
const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  vi.stubEnv("STRIPE_PRICE_ANNUAL", ANNUAL);
  vi.stubEnv("STRIPE_PRICE_MONTHLY", MONTHLY);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("stripe", componentSchema, componentModules);
  return t;
}

/** `customer.subscription.created`, as the component records it. */
async function subscribe(
  t: TestConvex<typeof schema>,
  id: string,
  priceId: string,
  endsInDays: number,
  status = "active",
  metadata: Record<string, string> = {},
) {
  await t.run(async (ctx) => {
    await ctx.runMutation(components.stripe.private.handleSubscriptionCreated, {
      stripeSubscriptionId: id,
      stripeCustomerId: "cus_me",
      status,
      currentPeriodEnd: now() + endsInDays * DAY,
      cancelAtPeriodEnd: false,
      priceId,
      metadata: { userId: ME.subject, ...metadata },
    });
  });
}

/** `customer.subscription.updated` with a new status and the same period. */
async function setStatus(t: TestConvex<typeof schema>, id: string, status: string) {
  await t.run(async (ctx) => {
    const [row] = (
      await ctx.runQuery(components.stripe.public.listSubscriptionsByUserId, {
        userId: ME.subject,
      })
    ).filter((r) => r.stripeSubscriptionId === id);
    await ctx.runMutation(components.stripe.private.handleSubscriptionUpdated, {
      stripeSubscriptionId: id,
      status,
      currentPeriodEnd: row.currentPeriodEnd,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    });
  });
}

/**
 * `customer.subscription.deleted`. The component keeps the row and the period
 * end it had, which for a plan cancelled outright can be most of a year away.
 */
async function cancel(t: TestConvex<typeof schema>, id: string) {
  await t.run(async (ctx) => {
    await ctx.runMutation(components.stripe.private.handleSubscriptionDeleted, {
      stripeSubscriptionId: id,
    });
  });
}

async function mirror(t: TestConvex<typeof schema>) {
  await t.mutation(internal.billing.mirrorSubscription, { userId: ME.subject });
  const account = await t.run(async (ctx) =>
    ctx.db
      .query("billingAccounts")
      .withIndex("by_owner", (q) => q.eq("ownerId", ME.subject))
      .unique(),
  );
  const entitlement = await t.withIdentity(ME).query(api.entitlements.mine, {});
  return { subscription: account?.subscription, entitlement };
}

describe("which subscription speaks for an account", () => {
  test("a customer who buys monthly after their annual plan was cancelled stays pro", async () => {
    const t = harness();
    await subscribe(t, "sub_annual", ANNUAL, 365);
    await cancel(t, "sub_annual");
    await subscribe(t, "sub_monthly", MONTHLY, 30);

    const { subscription, entitlement } = await mirror(t);
    expect(subscription).toMatchObject({
      subscriptionId: "sub_monthly",
      status: "active",
      interval: "month",
    });
    expect(entitlement).toMatchObject({ plan: "pro", source: "subscription" });
  });

  test("an annual renewal that failed until Stripe gave up does not outrank the plan bought after", async () => {
    const t = harness();
    await subscribe(t, "sub_annual", ANNUAL, 370);
    await setStatus(t, "sub_annual", "past_due");
    await cancel(t, "sub_annual");
    await subscribe(t, "sub_monthly", MONTHLY, 30);

    const { subscription, entitlement } = await mirror(t);
    expect(subscription?.subscriptionId).toBe("sub_monthly");
    expect(entitlement?.plan).toBe("pro");
  });

  test.each(["canceled", "unpaid", "incomplete", "incomplete_expired"])(
    "a %s row reaching further than a live one is passed over",
    async (dead) => {
      const t = harness();
      await subscribe(t, "sub_monthly", MONTHLY, 30);
      await subscribe(t, "sub_annual", ANNUAL, 365, dead);

      const { subscription, entitlement } = await mirror(t);
      expect(subscription?.subscriptionId).toBe("sub_monthly");
      expect(entitlement?.plan).toBe("pro");
    },
  );

  test("between two live rows the furthest-reaching period still decides", async () => {
    const t = harness();
    await subscribe(t, "sub_monthly", MONTHLY, 30);
    await subscribe(t, "sub_annual", ANNUAL, 365);
    await setStatus(t, "sub_annual", "past_due");

    const { subscription, entitlement } = await mirror(t);
    expect(subscription).toMatchObject({
      subscriptionId: "sub_annual",
      status: "past_due",
      interval: "year",
    });
    expect(entitlement?.plan).toBe("pro");
  });

  test("with nothing live, the furthest dead row is mirrored and the account is free", async () => {
    const t = harness();
    await subscribe(t, "sub_annual", ANNUAL, 365);
    await cancel(t, "sub_annual");
    await subscribe(t, "sub_monthly", MONTHLY, 30);
    await cancel(t, "sub_monthly");

    const { subscription, entitlement } = await mirror(t);
    expect(subscription).toMatchObject({
      subscriptionId: "sub_annual",
      status: "canceled",
    });
    expect(entitlement).toMatchObject({ plan: "free", source: "none" });
  });

  test("an account with no subscriptions mirrors none", async () => {
    const t = harness();
    const { subscription, entitlement } = await mirror(t);
    expect(subscription).toBeUndefined();
    expect(entitlement?.plan).toBe("free");
  });
});

/**
 * A workspace's Team subscription is bought by a person, but is never theirs:
 * were the personal mirror to take it, one seat's price would buy its buyer
 * Pro in every project of their own.
 */
describe("a workspace's subscription", () => {
  test("is not a person's, even carrying their id", async () => {
    const t = harness();
    await subscribe(t, "sub_team", MONTHLY, 30, "active", { orgId: "workspace_1" });

    const { subscription, entitlement } = await mirror(t);
    expect(subscription).toBeUndefined();
    expect(entitlement).toMatchObject({ plan: "free", source: "none" });
  });

  test("is not a person's on either Team price, and does not hide their own plan", async () => {
    vi.stubEnv("STRIPE_PRICE_TEAM_SEAT", "price_team_seat");
    vi.stubEnv("STRIPE_PRICE_TEAM_USAGE", "price_team_usage");
    const t = harness();
    await subscribe(t, "sub_seats", "price_team_seat", 365);
    await subscribe(t, "sub_usage", "price_team_usage", 365);
    await subscribe(t, "sub_monthly", MONTHLY, 30, "canceled");

    const { subscription, entitlement } = await mirror(t);
    expect(subscription?.subscriptionId).toBe("sub_monthly");
    expect(entitlement).toMatchObject({ plan: "free", source: "none" });
  });

  test("leaves someone on a retired Pro price on Pro", async () => {
    vi.stubEnv("STRIPE_PRICE_TEAM_SEAT", "price_team_seat");
    const t = harness();
    await subscribe(t, "sub_legacy", "price_pro_2025", 30);

    const { entitlement } = await mirror(t);
    expect(entitlement).toMatchObject({ plan: "pro", source: "subscription" });
  });
});

/**
 * Stripe does not order its deliveries, and retries a failed one for days. So
 * the `customer.subscription.updated` taken when somebody asked to cancel at
 * period end can land after the `deleted` that ended it, and the component
 * writes that snapshot's `active` back over `canceled`.
 */
async function replayScheduledCancel(t: TestConvex<typeof schema>, id: string) {
  await t.run(async (ctx) => {
    const [row] = (
      await ctx.runQuery(components.stripe.public.listSubscriptionsByUserId, {
        userId: ME.subject,
      })
    ).filter((r) => r.stripeSubscriptionId === id);
    await ctx.runMutation(components.stripe.private.handleSubscriptionUpdated, {
      stripeSubscriptionId: id,
      status: "active",
      currentPeriodEnd: row.currentPeriodEnd,
      cancelAtPeriodEnd: true,
    });
  });
}

describe("a cancellation undone by an older event landing after it", () => {
  test("runs on only while Stripe could still be delivering the renewal", async () => {
    const t = harness();
    await subscribe(t, "sub_monthly", MONTHLY, -1 / 24);
    await cancel(t, "sub_monthly");
    await replayScheduledCancel(t, "sub_monthly");

    const { subscription, entitlement } = await mirror(t);
    expect(subscription?.status).toBe("active");
    expect(entitlement).toMatchObject({
      plan: "pro",
      expiresAt: subscription!.currentPeriodEnd * 1000,
      cancelAtPeriodEnd: true,
    });
  });

  test("is free once three days have passed since the period ended", async () => {
    const t = harness();
    await subscribe(t, "sub_monthly", MONTHLY, -(3 + 1 / 24));
    await cancel(t, "sub_monthly");
    await replayScheduledCancel(t, "sub_monthly");

    const { subscription, entitlement } = await mirror(t);
    expect(subscription?.status).toBe("active");
    expect(entitlement).toMatchObject({ plan: "free", source: "none" });
  });
});

/**
 * The mirror holds Stripe's seconds, and the plan screen converts them. Ops is
 * a second reader of the same row, and was handed the seconds raw — which its
 * millisecond formatter put in January 1970.
 */
describe("the period end as ops reads it", () => {
  test("is the instant the plan screen shows, in milliseconds", async () => {
    const t = harness();
    await subscribe(t, "sub_monthly", MONTHLY, 30);
    const { subscription, entitlement } = await mirror(t);
    // Still seconds on the row: converting there as well would count twice.
    expect(subscription!.currentPeriodEnd).toBeLessThanOrEqual(now() + 30 * DAY);
    expect(subscription!.currentPeriodEnd).toBeGreaterThan(now() + 29 * DAY);
    const paidThrough = subscription!.currentPeriodEnd * 1000;
    expect(entitlement?.expiresAt).toBe(paidThrough);

    await t.run(async (ctx) => {
      await ctx.db.insert("adminSessions", {
        token: "admin-token",
        createdAt: 1,
        expiresAt: Date.now() + DAY * 1000,
      });
    });
    const account = await t.query(api.adminBilling.accountFor, {
      token: "admin-token",
      ownerId: ME.subject,
    });
    expect(account.subscription?.currentPeriodEnd).toBe(paidThrough);
    expect(account.entitlement.expiresAt).toBe(paidThrough);
    const roster = await t.query(internal.adminBilling.billingRoster, {});
    expect(roster).toMatchObject([{ ownerId: ME.subject, currentPeriodEnd: paidThrough }]);
  });
});
