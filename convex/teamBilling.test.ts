/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  bestSubscription,
  nextReport,
  overageCents,
  usageWindow,
  workspaceEventOf,
} from "./teamBilling";

/**
 * A workspace's Team plan in Stripe: the customer and checkout it buys
 * through, the mirror of its two-item subscription, the seat count that
 * follows its members, and the nightly usage report. Stripe itself is
 * replaced throughout — every assertion about money is about what would have
 * been sent.
 */

const stripe = vi.hoisted(() => ({
  getOrCreateCustomer: vi.fn(),
  createCustomer: vi.fn(),
  createCheckoutSession: vi.fn(),
  createCustomerPortalSession: vi.fn(),
  listSubscriptions: vi.fn(),
  updateSubscription: vi.fn(),
  updateItem: vi.fn(),
  meterEvent: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class {
    subscriptions = { list: stripe.listSubscriptions, update: stripe.updateSubscription };
    subscriptionItems = { update: stripe.updateItem };
    billing = { meterEvents: { create: stripe.meterEvent } };
  },
}));

vi.mock("@convex-dev/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/stripe")>()),
  StripeSubscriptions: class {
    getOrCreateCustomer = stripe.getOrCreateCustomer;
    createCustomer = stripe.createCustomer;
    createCheckoutSession = stripe.createCheckoutSession;
    createCustomerPortalSession = stripe.createCustomerPortalSession;
  },
}));

const modules = import.meta.glob("./**/*.ts");

const OWNER = { subject: "user_ws_owner" };
const ADMIN = { subject: "user_ws_admin" };
const MEMBER = { subject: "user_member" };
const GUEST = { subject: "user_guest" };
const STRANGER = { subject: "user_stranger" };

const SEAT = "price_team_seat";
const USAGE = "price_team_usage";
const METER = "team_ai_cents";
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 23, 12);
const SETTLE = 5 * 60_000;

type Identity = { subject: string; act?: string };
type T = TestConvex<typeof schema>;

beforeEach(() => {
  // Scheduled work stays queued unless a test runs it.
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_team");
  vi.stubEnv("STRIPE_PRICE_TEAM_SEAT", SEAT);
  vi.stubEnv("STRIPE_PRICE_TEAM_USAGE", USAGE);
  vi.stubEnv("STRIPE_TEAM_METER_EVENT", METER);
  vi.stubEnv("TEAM_AI_ALLOWANCE_USD", "10");
  vi.stubEnv("APP_URL", "https://app.test/");
  stripe.createCustomer.mockResolvedValue({ customerId: "cus_ws" });
  stripe.createCheckoutSession.mockResolvedValue({ sessionId: "cs_1", url: "https://pay.test/cs_1" });
  stripe.createCustomerPortalSession.mockResolvedValue({ url: "https://pay.test/portal" });
  stripe.updateItem.mockResolvedValue({});
  stripe.updateSubscription.mockResolvedValue({});
  stripe.meterEvent.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

/** Acme: an owner, an admin and a member in paid seats, a guest, and an address invited. */
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
    await seat(GUEST, "guest");
    await ctx.db.insert("invitations", {
      workspaceId,
      email: "new@acme.test",
      role: "member",
      token: "invite-token",
      invitedBy: ADMIN.subject,
      createdAt: 1,
      expiresAt: NOW + 14 * DAY,
    });
    return { workspaceId };
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
      seatItemId: "si_seat",
      usageItemId: "si_usage",
      status: "active",
      seats: 3,
      periodStart: NOW - 10 * DAY,
      periodEnd: NOW + 20 * DAY,
      aiAllowanceUsd: 30,
      updatedAt: 1,
      ...fields,
    });
  });
}

const billingRow = (t: T, workspaceId: Id<"workspaces">) =>
  t.run(async (ctx) =>
    ctx.db
      .query("workspaceBilling")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique(),
  );

const scheduled = (t: T, name: string) =>
  t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (f) => f.name.includes(name) && f.state.kind === "pending",
    ),
  );

describe("checkout", () => {
  test("an admin's checkout makes the workspace a customer of its own and buys its seats and usage", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);

    const { url } = await t
      .withIdentity(ADMIN)
      .action(api.billing.startTeamCheckout, { workspaceId });

    expect(url).toBe("https://pay.test/cs_1");
    expect(stripe.createCustomer).toHaveBeenCalledOnce();
    const customer = stripe.createCustomer.mock.calls[0][1];
    // No email: the component's personal lookup matches customers by it.
    expect(customer).toEqual({
      name: "Acme",
      metadata: { orgId: workspaceId },
      idempotencyKey: `workspace_${workspaceId}`,
    });

    const back = "https://app.test/w/acme/settings/billing";
    const session = stripe.createCheckoutSession.mock.calls[0][1];
    expect(session).toMatchObject({
      customerId: "cus_ws",
      mode: "subscription",
      successUrl: `${back}?checkout=done`,
      cancelUrl: `${back}?checkout=cancelled`,
      metadata: { orgId: workspaceId },
      subscriptionMetadata: { orgId: workspaceId },
    });
    // Three paid seats: the guest and the open invitation cost nothing.
    expect(session.params.line_items).toEqual([
      { price: SEAT, quantity: 3 },
      { price: USAGE },
    ]);
    expect(session.subscriptionMetadata).not.toHaveProperty("userId");

    // A customer is not a plan.
    expect(await billingRow(t, workspaceId)).toMatchObject({
      stripeCustomerId: "cus_ws",
      status: "none",
    });
    expect(
      (await t.withIdentity(MEMBER).query(api.entitlements.forContainer, { workspaceId }))?.plan,
    ).toBe("free");

    // Asking again pays through the same customer.
    await t.withIdentity(OWNER).action(api.billing.startTeamCheckout, { workspaceId });
    expect(stripe.createCustomer).toHaveBeenCalledOnce();
    expect(stripe.createCheckoutSession.mock.calls[1][1].customerId).toBe("cus_ws");
  });

  test("a member, a guest, a stranger and an operator standing in are all refused", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const checkout = (who: Identity) =>
      t.withIdentity(who).action(api.billing.startTeamCheckout, { workspaceId });

    await expect(checkout(MEMBER)).rejects.toThrow("Only a workspace admin can do that.");
    await expect(checkout(GUEST)).rejects.toThrow("Only a workspace admin can do that.");
    await expect(checkout(STRANGER)).rejects.toThrow("Not found");
    await expect(checkout({ ...OWNER, act: "ops_session" })).rejects.toThrow("Read-only");
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  test("a deployment without Team's prices and meter says so", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    vi.stubEnv("STRIPE_TEAM_METER_EVENT", "");
    await expect(
      t.withIdentity(OWNER).action(api.billing.startTeamCheckout, { workspaceId }),
    ).rejects.toThrow("Team billing isn’t set up on this deployment.");
  });

  test("a workspace already paying is not sold a second plan", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await billing(t, workspaceId);
    await expect(
      t.withIdentity(OWNER).action(api.billing.startTeamCheckout, { workspaceId }),
    ).rejects.toThrow("Acme is already on the Team plan.");
  });

  test("a person's own checkout never lands on their workspace's customer", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await billing(t, workspaceId);
    vi.stubEnv("STRIPE_PRICE_MONTHLY", "price_pro_monthly");
    // The component's email fallback finds the workspace's customer.
    stripe.getOrCreateCustomer.mockResolvedValue({ customerId: "cus_ws", isNew: false });
    stripe.createCustomer.mockResolvedValue({ customerId: "cus_me" });
    const me = { ...OWNER, email: "owner@acme.test", name: "Ada" };

    await t.withIdentity(me).action(api.billing.startCheckout, { interval: "month" });

    expect(stripe.createCustomer.mock.calls[0][1]).toEqual({
      email: "owner@acme.test",
      name: "Ada",
      metadata: { userId: OWNER.subject },
      idempotencyKey: OWNER.subject,
    });
    expect(stripe.createCheckoutSession.mock.calls[0][1]).toMatchObject({
      customerId: "cus_me",
      subscriptionMetadata: { userId: OWNER.subject },
    });
  });

  test("the billing portal opens on the workspace's customer, for its admins", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const manage = (who: Identity) =>
      t.withIdentity(who).action(api.billing.manageTeam, { workspaceId });

    await expect(manage(ADMIN)).rejects.toThrow("There is no billing to manage yet.");
    await billing(t, workspaceId, { status: "canceled" });
    await expect(manage(MEMBER)).rejects.toThrow("Only a workspace admin can do that.");
    expect(await manage(ADMIN)).toEqual({ url: "https://pay.test/portal" });
    expect(stripe.createCustomerPortalSession.mock.calls[0][1]).toEqual({
      customerId: "cus_ws",
      returnUrl: "https://app.test/w/acme/settings/billing",
    });
  });
});

/** A Stripe subscription as `subscriptions.list` returns it — usage listed first. */
function subscription(
  id: string,
  orgId: string,
  fields: { status?: string; seats?: number; start?: number; end?: number; created?: number } = {},
) {
  const start = Math.floor((fields.start ?? NOW - 10 * DAY) / 1000);
  const end = Math.floor((fields.end ?? NOW + 20 * DAY) / 1000);
  const item = (suffix: string, price: string, quantity?: number) => ({
    id: `${id}_${suffix}`,
    price: { id: price },
    quantity,
    current_period_start: start,
    current_period_end: end,
  });
  return {
    id,
    status: fields.status ?? "active",
    created: fields.created ?? 1,
    cancel_at_period_end: false,
    metadata: { orgId },
    items: { data: [item("usage", USAGE), item("seat", SEAT, fields.seats ?? 3)] },
  };
}

describe("the mirror", () => {
  test("finds the seat and usage items by price, and puts the workspace on Team", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    stripe.listSubscriptions.mockResolvedValue({
      data: [subscription("sub_1", workspaceId, { seats: 3 })],
    });

    await t.action(internal.teamBilling.mirror, { orgId: workspaceId, customerId: "cus_ws" });

    expect(stripe.listSubscriptions).toHaveBeenCalledWith({
      customer: "cus_ws",
      status: "all",
      limit: 100,
    });
    expect(await billingRow(t, workspaceId)).toMatchObject({
      stripeCustomerId: "cus_ws",
      subscriptionId: "sub_1",
      seatItemId: "sub_1_seat",
      usageItemId: "sub_1_usage",
      status: "active",
      seats: 3,
      periodStart: Math.floor((NOW - 10 * DAY) / 1000) * 1000,
      periodEnd: Math.floor((NOW + 20 * DAY) / 1000) * 1000,
      cancelAtPeriodEnd: false,
      aiAllowanceUsd: 30,
    });
    expect(
      (await t.withIdentity(MEMBER).query(api.entitlements.forContainer, { workspaceId }))?.plan,
    ).toBe("team");
    // Stripe already has the seats there are.
    expect(await scheduled(t, "syncSeats")).toHaveLength(0);
  });

  test("a live subscription outranks a cancelled one reaching further, and another workspace's is not read", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await billing(t, workspaceId, { status: "none", subscriptionId: undefined });
    stripe.listSubscriptions.mockResolvedValue({
      data: [
        subscription("sub_old", workspaceId, { status: "canceled", end: NOW + 300 * DAY }),
        subscription("sub_new", workspaceId),
        subscription("sub_theirs", "some_other_workspace", { end: NOW + 400 * DAY, created: 9 }),
      ],
    });

    await t.action(internal.teamBilling.mirror, { orgId: workspaceId, customerId: "cus_ws" });

    expect((await billingRow(t, workspaceId))?.subscriptionId).toBe("sub_new");
  });

  test("the customer on record is the one read, and an orgId naming no workspace is dropped", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await billing(t, workspaceId);
    stripe.listSubscriptions.mockResolvedValue({ data: [] });

    await t.action(internal.teamBilling.mirror, { orgId: workspaceId, customerId: "cus_stray" });
    expect(stripe.listSubscriptions.mock.calls[0][0].customer).toBe("cus_ws");
    // Nothing left under the customer: no plan.
    const row = await billingRow(t, workspaceId);
    expect(row?.status).toBe("none");
    expect(row?.subscriptionId).toBeUndefined();

    await t.action(internal.teamBilling.mirror, { orgId: "not_a_workspace", customerId: "cus_x" });
    expect(stripe.listSubscriptions).toHaveBeenCalledOnce();
  });

  test("seats Stripe does not have yet are synced once the subscription lands", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    stripe.listSubscriptions.mockResolvedValue({
      data: [subscription("sub_1", workspaceId, { seats: 2 })],
    });

    await t.action(internal.teamBilling.mirror, { orgId: workspaceId, customerId: "cus_ws" });

    expect(await scheduled(t, "syncSeats")).toHaveLength(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(stripe.updateItem).toHaveBeenCalledWith("sub_1_seat", {
      quantity: 3,
      proration_behavior: "create_prorations",
    });
  });

  test("the webhook's objects name their workspace and customer by `orgId`", () => {
    expect(
      workspaceEventOf({ object: "subscription", id: "sub_1", customer: "cus_1", metadata: { orgId: "w" } }),
    ).toEqual({ orgId: "w", customerId: "cus_1" });
    expect(
      workspaceEventOf({ object: "checkout.session", customer: { id: "cus_2" }, metadata: { orgId: "w" } }),
    ).toEqual({ orgId: "w", customerId: "cus_2" });
    expect(workspaceEventOf({ object: "customer", id: "cus_3", metadata: { orgId: "w" } })).toEqual({
      orgId: "w",
      customerId: "cus_3",
    });
    expect(workspaceEventOf({ object: "subscription", customer: "cus_1", metadata: { userId: "u" } }))
      .toBeNull();
    expect(workspaceEventOf({ object: "checkout.session", customer: null, metadata: { orgId: "w" } }))
      .toBeNull();
  });

  test("between two live subscriptions the furthest period, then the newest, speaks", () => {
    const a = subscription("a", "w", { end: NOW + 10 * DAY });
    const b = subscription("b", "w", { end: NOW + 20 * DAY });
    const c = subscription("c", "w", { end: NOW + 20 * DAY, created: 5 });
    expect(bestSubscription([a, b])?.id).toBe("b");
    expect(bestSubscription([b, c])?.id).toBe("c");
    expect(bestSubscription([])).toBeNull();
  });
});

describe("seats", () => {
  test("a seat count leaves out guests and invitations, and changes wait for one sync", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await billing(t, workspaceId, { seats: 3 });

    await t
      .withIdentity(ADMIN)
      .mutation(api.members.setRole, { workspaceId, userId: GUEST.subject, role: "member" });
    await t
      .withIdentity(OWNER)
      .mutation(api.members.setRole, { workspaceId, userId: ADMIN.subject, role: "member" });

    expect(await scheduled(t, "syncSeats")).toHaveLength(1);
    expect((await billingRow(t, workspaceId))?.seatSyncPending).toBe(true);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(stripe.updateItem).toHaveBeenCalledOnce();
    expect(stripe.updateItem).toHaveBeenCalledWith("si_seat", {
      quantity: 4,
      proration_behavior: "create_prorations",
    });
    const row = await billingRow(t, workspaceId);
    expect(row).toMatchObject({ seats: 4, aiAllowanceUsd: 40 });
    expect(row?.seatSyncPending).toBeUndefined();

    // The sync is over, so the next change asks for another.
    await t
      .withIdentity(OWNER)
      .mutation(api.members.remove, { workspaceId, userId: MEMBER.subject });
    expect(await scheduled(t, "syncSeats")).toHaveLength(1);
  });

  test("a guest coming or going changes nothing Stripe is told", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await billing(t, workspaceId, { seats: 3 });

    await t.withIdentity(ADMIN).mutation(api.members.remove, { workspaceId, userId: GUEST.subject });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(stripe.updateItem).not.toHaveBeenCalled();
  });

  test("a workspace with nothing to update schedules nothing", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await billing(t, workspaceId, { status: "canceled" });

    await t
      .withIdentity(ADMIN)
      .mutation(api.members.setRole, { workspaceId, userId: GUEST.subject, role: "member" });

    expect(await scheduled(t, "syncSeats")).toHaveLength(0);
  });

  test("a deleted workspace's plan ends with the period it paid for", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await billing(t, workspaceId);

    await t.withIdentity(OWNER).mutation(api.workspaces.remove, { workspaceId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(stripe.updateSubscription).toHaveBeenCalledWith("sub_ws", {
      cancel_at_period_end: true,
    });
    expect(stripe.updateItem).not.toHaveBeenCalled();
  });
});

describe("the usage arithmetic", () => {
  test("overage is whole cents past the allowance, a fraction waiting for the rest of its cent", () => {
    expect(overageCents(34.237, 30)).toBe(423);
    expect(overageCents(10.07, 10)).toBe(7);
    expect(overageCents(10.005, 10)).toBe(0);
    expect(overageCents(29.99, 30)).toBe(0);
  });

  test("each report sends what the period owes past what it was already sent", () => {
    const period = { start: 0, end: 100, allowanceUsd: 30 };
    const first = nextReport(undefined, period, 0, 31);
    expect(first).toEqual({ cents: 100, period: { ...period, spentUsd: 31, reportedCents: 100 } });

    const second = nextReport(first.period, period, 0, 0.5);
    expect(second.cents).toBe(50);
    expect(second.period).toMatchObject({ spentUsd: 31.5, reportedCents: 150 });

    // A seat added mid-period raises the allowance and takes nothing back.
    const raised = nextReport(second.period, { ...period, allowanceUsd: 40 }, 0, 1);
    expect(raised.cents).toBe(0);
    expect(raised.period).toMatchObject({ spentUsd: 32.5, reportedCents: 150 });
  });

  test("after a renewal, the old period's last spend counts against the old allowance", () => {
    const old = { start: 0, end: 100, allowanceUsd: 30, spentUsd: 29, reportedCents: 0 };
    const renewed = nextReport(old, { start: 100, end: 200, allowanceUsd: 30 }, 2, 5);
    expect(renewed).toEqual({
      cents: 100,
      period: { start: 100, end: 200, allowanceUsd: 30, spentUsd: 5, reportedCents: 0 },
    });
  });

  test("a report's window stops short of now and at the period's end", () => {
    const row = { periodStart: 1000, periodEnd: 10_000_000, usageReportedThrough: undefined, usagePeriod: undefined };
    expect(usageWindow(row, 2_000_000)).toEqual({
      from: 1000,
      through: 2_000_000 - SETTLE,
      tail: null,
      current: { from: 1000, to: 2_000_000 - SETTLE },
    });
    expect(usageWindow({ ...row, periodEnd: 1_500_000 }, 2_000_000)?.through).toBe(1_500_000);
    expect(usageWindow({ ...row, usageReportedThrough: 2_000_000 - SETTLE }, 2_000_000)).toBeNull();

    const renewed = {
      periodStart: 5_000_000,
      periodEnd: 9_000_000,
      usageReportedThrough: 4_000_000,
      usagePeriod: { start: 1000, end: 5_000_000, allowanceUsd: 30, spentUsd: 1, reportedCents: 0 },
    };
    expect(usageWindow(renewed, 6_000_000)).toEqual({
      from: 4_000_000,
      through: 6_000_000 - SETTLE,
      tail: { from: 4_000_000, to: 5_000_000 },
      current: { from: 5_000_000, to: 6_000_000 - SETTLE },
    });
  });
});

async function call(
  t: T,
  workspaceId: Id<"workspaces"> | undefined,
  costUsd: number,
  createdAt: number,
  signed = true,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("aiCalls", {
      ownerId: MEMBER.subject,
      feature: "chat",
      model: "m",
      latencyMs: 1,
      status: "ok",
      costUsd,
      createdAt,
      ...(workspaceId ? { workspaceId } : {}),
      ...(signed ? { signed: true } : {}),
    });
  });
}

describe("the usage report", () => {
  test("the night's overage goes to the meter in cents, once, under an identifier that makes a resend the same event", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const { workspaceId: elsewhere } = await t.run(async (ctx) => ({
      workspaceId: await ctx.db.insert("workspaces", {
        slug: "globex",
        name: "Globex",
        createdBy: STRANGER.subject,
        plan: "team",
        settings: { linkSharing: true, guestCodeAccess: false, joinDomains: [], autoJoin: false },
        createdAt: 1,
      }),
    }));
    const periodStart = NOW - 10 * DAY;
    await billing(t, workspaceId, { periodStart });

    await call(t, workspaceId, 20, periodStart + DAY);
    await call(t, workspaceId, 14.237, NOW - DAY);
    await call(t, workspaceId, 500, NOW - DAY, false); // unsigned: a claim, not a cost
    await call(t, workspaceId, 7, periodStart - DAY); // before the plan
    await call(t, elsewhere, 9, NOW - DAY);
    await call(t, undefined, 9, NOW - DAY); // somebody's own
    await call(t, workspaceId, 3, NOW - 60_000); // still settling

    await t.action(internal.teamBilling.reportWorkspaceUsage, { workspaceId });

    const through = NOW - SETTLE;
    expect(stripe.meterEvent).toHaveBeenCalledOnce();
    expect(stripe.meterEvent).toHaveBeenCalledWith({
      event_name: METER,
      payload: { stripe_customer_id: "cus_ws", value: "423" },
      identifier: `${workspaceId}:${periodStart}:${through}`,
    });
    const row = await billingRow(t, workspaceId);
    expect(row?.usageReportedThrough).toBe(through);
    expect(row?.pendingUsage).toBeUndefined();
    expect(row?.usagePeriod?.reportedCents).toBe(423);
    expect(row?.usagePeriod?.spentUsd).toBeCloseTo(34.237);

    // Run again at once: nothing new, nothing sent.
    await t.action(internal.teamBilling.reportWorkspaceUsage, { workspaceId });
    expect(stripe.meterEvent).toHaveBeenCalledOnce();

    // The next night picks up where it stopped, the settling call included.
    vi.setSystemTime(NOW + DAY);
    await call(t, workspaceId, 1, NOW + DAY / 2);
    await t.action(internal.teamBilling.reportWorkspaceUsage, { workspaceId });
    expect(stripe.meterEvent).toHaveBeenLastCalledWith({
      event_name: METER,
      payload: { stripe_customer_id: "cus_ws", value: "400" },
      identifier: `${workspaceId}:${periodStart}:${NOW + DAY - SETTLE}`,
    });
  });

  test("a send Stripe refused is sent again as the same report, not counted again", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const periodStart = NOW - 10 * DAY;
    await billing(t, workspaceId, { periodStart });
    await call(t, workspaceId, 31, NOW - DAY);
    stripe.meterEvent.mockRejectedValueOnce(new Error("Stripe is having a moment"));

    await expect(
      t.action(internal.teamBilling.reportWorkspaceUsage, { workspaceId }),
    ).rejects.toThrow("Stripe is having a moment");
    const identifier = `${workspaceId}:${periodStart}:${NOW - SETTLE}`;
    expect((await billingRow(t, workspaceId))?.pendingUsage).toEqual({ identifier, cents: 100 });
    expect(await scheduled(t, "reportWorkspaceUsage")).toHaveLength(1);

    vi.setSystemTime(NOW + 20 * 60_000);
    await call(t, workspaceId, 5, NOW + 60_000);
    await t.action(internal.teamBilling.reportWorkspaceUsage, { workspaceId, attempt: 1 });

    expect(stripe.meterEvent).toHaveBeenCalledTimes(2);
    expect(stripe.meterEvent.mock.calls[1][0]).toEqual(stripe.meterEvent.mock.calls[0][0]);
    expect((await billingRow(t, workspaceId))?.pendingUsage).toBeUndefined();
  });

  test("spend inside the allowance sends nothing, and still counts toward the period", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await billing(t, workspaceId);
    await call(t, workspaceId, 12, NOW - DAY);

    await t.action(internal.teamBilling.reportWorkspaceUsage, { workspaceId });

    expect(stripe.meterEvent).not.toHaveBeenCalled();
    expect(await billingRow(t, workspaceId)).toMatchObject({
      usageReportedThrough: NOW - SETTLE,
      usagePeriod: { spentUsd: 12, reportedCents: 0, allowanceUsd: 30 },
    });
  });

  test("the night after a renewal finishes the old period against its own allowance", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const renewedAt = NOW - 2 * 60 * 60_000;
    await billing(t, workspaceId, {
      periodStart: renewedAt,
      periodEnd: renewedAt + 30 * DAY,
      usageReportedThrough: renewedAt - 20 * 60 * 60_000,
      usagePeriod: {
        start: renewedAt - 30 * DAY,
        end: renewedAt,
        allowanceUsd: 30,
        spentUsd: 29,
        reportedCents: 0,
      },
    });
    await call(t, workspaceId, 2, renewedAt - 60 * 60_000);
    await call(t, workspaceId, 5, renewedAt + 60 * 60_000);

    await t.action(internal.teamBilling.reportWorkspaceUsage, { workspaceId });

    expect(stripe.meterEvent.mock.calls[0][0].payload.value).toBe("100");
    expect((await billingRow(t, workspaceId))?.usagePeriod).toEqual({
      start: renewedAt,
      end: renewedAt + 30 * DAY,
      allowanceUsd: 30,
      spentUsd: 5,
      reportedCents: 0,
    });
  });

  test("the nightly run reports each live plan with a usage item, and re-syncs seats that drifted", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const { workspaceId: lapsed } = await world(t);
    await billing(t, workspaceId, { seats: 5 });
    await billing(t, lapsed, { status: "canceled", stripeCustomerId: "cus_lapsed" });

    await t.mutation(internal.teamBilling.reportUsage, {});

    const reports = await scheduled(t, "reportWorkspaceUsage");
    expect(reports.map((f) => f.args[0])).toEqual([{ workspaceId }]);
    expect(await scheduled(t, "syncSeats")).toHaveLength(1);
  });
});
