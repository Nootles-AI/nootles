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
) {
  await t.run(async (ctx) => {
    await ctx.runMutation(components.stripe.private.handleSubscriptionCreated, {
      stripeSubscriptionId: id,
      stripeCustomerId: "cus_me",
      status,
      currentPeriodEnd: now() + endsInDays * DAY,
      cancelAtPeriodEnd: false,
      priceId,
      metadata: { userId: ME.subject },
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
