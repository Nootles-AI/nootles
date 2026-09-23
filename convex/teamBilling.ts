import { v, type Infer } from "convex/values";
import StripeSDK from "stripe";
import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { atLeast, requireWorkspaceRole, workspaceRole } from "./auth";
import { isLiveStatus, workspaceStanding, workspaceSubscriptionLive } from "./entitlements";

/**
 * A workspace's Team subscription, kept in step with Stripe.
 *
 * A workspace pays through a Stripe customer of its own, made with
 * `metadata.orgId` and never looked up by anyone's email, so no member's own
 * billing can be handed the workspace's or the other way round. It buys one
 * subscription with two items, told apart by price: seats, licensed, one per
 * owner, admin and member; and AI usage, metered through a Billing Meter. The
 * Stripe component mirrors only a subscription's first item, so this module
 * keeps its own copy in `workspaceBilling`, which is what `entitlements.ts`
 * reads.
 *
 * Seats follow the membership list on their own (`scheduleSeatSync`); usage
 * past the seats' allowance is reported each night (`reportUsage`). Both
 * write to Stripe from actions, and both are shaped so a retry repeats rather
 * than doubles what was sent.
 */

/** Not a Stripe status: a customer made at checkout that has bought nothing yet. */
const NO_SUBSCRIPTION = "none";

/** Long enough that inviting a handful of people is one proration, not five. */
const SEAT_SYNC_DELAY_MS = 60_000;

/**
 * How long a scheduled seat sync is waited on before it is taken for lost.
 * Convex runs a scheduled action at most once: one that dies before it takes
 * its sync would otherwise leave every later change waiting on it for good.
 */
const SEAT_SYNC_LOST_MS = SEAT_SYNC_DELAY_MS + 10 * 60_000;

/** Stripe statuses a subscription never comes back from, and ours for none bought. */
const CLOSED_STATUSES = new Set([NO_SUBSCRIPTION, "canceled", "incomplete_expired"]);

/**
 * How far behind the clock a usage report stops. A row is stamped when its
 * mutation starts and seen once it commits, so the last moments before a
 * report are left for the next one rather than read while still filling.
 */
const SETTLE_MS = 5 * 60_000;

/** Rows summed per read, well inside a query's limits. */
const SPEND_PAGE = 1000;

/** Sends of one report after the first, spaced so all fall in Stripe's day of deduplication. */
const REPORT_RETRIES = 3;
const REPORT_RETRY_MS = 15 * 60_000;

const DEFAULT_ALLOWANCE_USD = 10;

// ---- Configuration -----------------------------------------------------------

/** The two Team prices, or null on a deployment that has not set them. */
export function teamPrices(): { seat: string; usage: string } | null {
  const seat = process.env.STRIPE_PRICE_TEAM_SEAT;
  const usage = process.env.STRIPE_PRICE_TEAM_USAGE;
  return seat && usage ? { seat, usage } : null;
}

/** Whether a price is one of Team's, which no one's own plan ever is. */
export function isTeamPrice(priceId: string): boolean {
  return (
    priceId !== "" &&
    (priceId === process.env.STRIPE_PRICE_TEAM_SEAT ||
      priceId === process.env.STRIPE_PRICE_TEAM_USAGE)
  );
}

/**
 * Whether Team can be sold from this deployment: both prices, the meter usage
 * is reported to, and somewhere for Stripe to send people back to. Without
 * all four, checkout would take money for usage nothing could bill.
 */
export function teamBillingConfigured(): boolean {
  return !!teamPrices() && !!process.env.STRIPE_TEAM_METER_EVENT && !!process.env.APP_URL;
}

/** The AI spend each paid seat brings into a period before usage is billed, in dollars. */
export function allowancePerSeatUsd(): number {
  const raw = process.env.TEAM_AI_ALLOWANCE_USD?.trim();
  const usd = raw ? Number(raw) : DEFAULT_ALLOWANCE_USD;
  return Number.isFinite(usd) && usd >= 0 ? usd : DEFAULT_ALLOWANCE_USD;
}

function stripeSdk(): StripeSDK {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set on this deployment.");
  return new StripeSDK(key);
}

// ---- Reads -------------------------------------------------------------------

/**
 * Whether Stripe still holds the workspace's subscription open, live or not.
 * An unpaid, paused or incomplete one keeps its seat item and its place on the
 * meter, so buying another beside it would bill the workspace twice.
 */
export function subscriptionOpen(
  billing: Pick<Doc<"workspaceBilling">, "subscriptionId" | "status"> | null,
): boolean {
  return !!billing?.subscriptionId && !CLOSED_STATUSES.has(billing.status);
}

/** Whether a seat sync is scheduled and still due to run. */
export function seatSyncWaiting(
  billing: Pick<Doc<"workspaceBilling">, "seatSyncPendingAt">,
  now: number,
): boolean {
  return (
    billing.seatSyncPendingAt !== undefined && now - billing.seatSyncPendingAt < SEAT_SYNC_LOST_MS
  );
}

async function billingOf(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"workspaceBilling"> | null> {
  return await ctx.db
    .query("workspaceBilling")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/**
 * The seats a workspace pays for: everyone with a live seat of member or
 * above — `holdsSeat`'s definition. Guests and open invitations cost nothing.
 */
export async function seatsInUse(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<number> {
  const seats = await ctx.db
    .query("memberships")
    .withIndex("by_workspace_status_role", (q) =>
      q.eq("workspaceId", workspaceId).eq("status", "active"),
    )
    .collect();
  return seats.filter((seat) => atLeast(seat.role, "member")).length;
}

/**
 * What checkout and the billing portal need, for an admin or owner of the
 * workspace. `requireWorkspaceRole` refuses anyone else, and an operator
 * standing in for one: nothing is bought or cancelled in somebody's name.
 */
export const desk = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    name: v.string(),
    slug: v.string(),
    seats: v.number(),
    customerId: v.union(v.string(), v.null()),
    live: v.boolean(),
    open: v.boolean(),
  }),
  handler: async (ctx, { workspaceId }) => {
    const { workspace } = await requireWorkspaceRole(ctx, workspaceId, "admin");
    const billing = await billingOf(ctx, workspaceId);
    return {
      name: workspace.name,
      slug: workspace.slug,
      seats: await seatsInUse(ctx, workspaceId),
      customerId: billing?.stripeCustomerId ?? null,
      live: workspaceSubscriptionLive(billing, Date.now()),
      open: subscriptionOpen(billing),
    };
  },
});

/**
 * Records the workspace's customer, just made. Returns the one to use: two
 * checkouts racing get the same customer from Stripe's idempotency key, and
 * the first to land here keeps its row.
 */
export const rememberCustomer = internalMutation({
  args: { workspaceId: v.id("workspaces"), stripeCustomerId: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const existing = await billingOf(ctx, args.workspaceId);
    if (existing) return existing.stripeCustomerId;
    await ctx.db.insert("workspaceBilling", {
      workspaceId: args.workspaceId,
      stripeCustomerId: args.stripeCustomerId,
      status: NO_SUBSCRIPTION,
      seats: 0,
      periodStart: 0,
      periodEnd: 0,
      aiAllowanceUsd: 0,
      updatedAt: Date.now(),
    });
    return args.stripeCustomerId;
  },
});

/** Whether a Stripe customer is a workspace's — which a person's checkout must never reuse. */
export const isWorkspaceCustomer = internalQuery({
  args: { stripeCustomerId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("workspaceBilling")
      .withIndex("by_customer", (q) => q.eq("stripeCustomerId", args.stripeCustomerId))
      .first();
    return row !== null;
  },
});

// ---- The mirror ----------------------------------------------------------------

/**
 * The workspace a webhook's object belongs to, and its customer — for the
 * subscriptions, checkout sessions and customers Nootles made for one, which
 * all carry `metadata.orgId`. Null for anything else.
 */
export function workspaceEventOf(object: unknown): { orgId: string; customerId: string } | null {
  const o = object as {
    object?: string;
    id?: string;
    customer?: string | { id?: string } | null;
    metadata?: Record<string, string> | null;
  };
  const orgId = o.metadata?.orgId;
  if (!orgId) return null;
  const customerId =
    o.object === "customer"
      ? o.id
      : typeof o.customer === "string"
        ? o.customer
        : o.customer?.id;
  return customerId ? { orgId, customerId } : null;
}

/**
 * Which workspace an `orgId` names, and the customer to read. The customer
 * already on record wins over the event's: a workspace pays through one.
 */
export const mirrorTarget = internalQuery({
  args: { orgId: v.string(), customerId: v.string() },
  returns: v.union(
    v.object({ workspaceId: v.id("workspaces"), customerId: v.string() }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const workspaceId = ctx.db.normalizeId("workspaces", args.orgId);
    if (!workspaceId || !(await ctx.db.get(workspaceId))) return null;
    const billing = await billingOf(ctx, workspaceId);
    return { workspaceId, customerId: billing?.stripeCustomerId ?? args.customerId };
  },
});

/** The part of a Stripe subscription the mirror reads. */
type Subscription = {
  id: string;
  status: string;
  created: number;
  cancel_at_period_end?: boolean | null;
  items: {
    data: {
      id: string;
      price: { id: string };
      quantity?: number | null;
      current_period_start: number;
      current_period_end: number;
    }[];
  };
};

function periodEndOf(subscription: Subscription): number {
  return Math.max(0, ...subscription.items.data.map((item) => item.current_period_end));
}

/**
 * The subscription that speaks for a workspace, by the personal mirror's rule:
 * a live one outranks every dead one — a cancelled plan keeps the period it
 * died in, which can reach past the plan bought after it — and between alike
 * the furthest period end, then the newest, decides.
 */
export function bestSubscription<S extends Subscription>(subscriptions: S[]): S | null {
  return subscriptions.reduce<S | null>((winner, row) => {
    if (!winner) return row;
    const live = isLiveStatus(row.status);
    if (live !== isLiveStatus(winner.status)) return live ? row : winner;
    const reach = periodEndOf(row) - periodEndOf(winner);
    if (reach !== 0) return reach > 0 ? row : winner;
    return row.created > winner.created ? row : winner;
  }, null);
}

const mirrored = v.object({
  subscriptionId: v.string(),
  status: v.string(),
  seatItemId: v.optional(v.string()),
  usageItemId: v.optional(v.string()),
  seats: v.number(),
  periodStart: v.number(),
  periodEnd: v.number(),
  cancelAtPeriodEnd: v.boolean(),
});

/**
 * One subscription as `workspaceBilling` holds it. Its two items are found by
 * price, never by position: Stripe keeps them in no promised order, and a
 * metered item read as the seats would bill a team of one.
 */
export function mirrorOf(
  subscription: Subscription,
  prices: { seat: string; usage: string },
): Infer<typeof mirrored> {
  const items = subscription.items.data;
  const seat = items.find((item) => item.price.id === prices.seat);
  const usage = items.find((item) => item.price.id === prices.usage);
  const period = seat ?? items[0];
  return {
    subscriptionId: subscription.id,
    status: subscription.status,
    seatItemId: seat?.id,
    usageItemId: usage?.id,
    seats: seat?.quantity ?? 0,
    periodStart: (period?.current_period_start ?? 0) * 1000,
    periodEnd: (period?.current_period_end ?? 0) * 1000,
    cancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
  };
}

/**
 * Re-reads a workspace's subscription from Stripe and writes it down. Called
 * by the webhook for every event about a workspace.
 *
 * Asks Stripe rather than trusting the event: deliveries arrive out of order,
 * and a late one describes a subscription as it was. Listing all of the
 * customer's subscriptions, not just the one the event named, is what keeps a
 * late event about a plan cancelled months ago from speaking over the one
 * bought since. Idempotent, like the personal mirror, so Stripe's retries are
 * harmless and a failure's retry is the repair.
 */
export const mirror = internalAction({
  args: { orgId: v.string(), customerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const target = await ctx.runQuery(internal.teamBilling.mirrorTarget, args);
    if (!target) return null;
    const prices = teamPrices();
    if (!prices) throw new Error("A workspace subscription changed, but no Team prices are set.");
    const listed = await stripeSdk().subscriptions.list({
      customer: target.customerId,
      status: "all",
      limit: 100,
    });
    const best = bestSubscription(
      listed.data.filter((subscription) => subscription.metadata?.orgId === target.workspaceId),
    );
    await ctx.runMutation(internal.teamBilling.applyMirror, {
      workspaceId: target.workspaceId,
      stripeCustomerId: target.customerId,
      subscription: best ? mirrorOf(best, prices) : null,
    });
    return null;
  },
});

export const applyMirror = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    stripeCustomerId: v.string(),
    subscription: v.union(mirrored, v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { workspaceId, stripeCustomerId, subscription }) => {
    const now = Date.now();
    const fields = subscription
      ? { ...subscription, aiAllowanceUsd: subscription.seats * allowancePerSeatUsd() }
      : {
          subscriptionId: undefined,
          seatItemId: undefined,
          usageItemId: undefined,
          status: NO_SUBSCRIPTION,
          cancelAtPeriodEnd: undefined,
        };
    const existing = await billingOf(ctx, workspaceId);
    if (existing) {
      await ctx.db.patch(existing._id, { ...fields, updatedAt: now });
    } else {
      await ctx.db.insert("workspaceBilling", {
        workspaceId,
        stripeCustomerId,
        seats: 0,
        periodStart: 0,
        periodEnd: 0,
        aiAllowanceUsd: 0,
        ...fields,
        updatedAt: now,
      });
    }
    // Someone may have come or gone between checkout and the subscription
    // landing, when there was nothing yet to sync their seat to.
    if (
      subscription?.seatItemId &&
      isLiveStatus(subscription.status) &&
      (await seatsInUse(ctx, workspaceId)) !== subscription.seats
    ) {
      await scheduleSeatSync(ctx, workspaceId);
    }
    return null;
  },
});

// ---- Seats ---------------------------------------------------------------------

/**
 * Asks for the workspace's seat count to be pushed to Stripe. Called by every
 * change to who holds a seat, in the same mutation. Coalesced: while one sync
 * is waiting, further changes add nothing, since the sync counts the seats
 * when it runs rather than applying each change. A workspace with nothing live
 * to update has nothing to schedule; checkout counts afresh. A sync that has
 * waited past its time is taken for lost and scheduled again
 * (`seatSyncWaiting`); two landing is harmless, since each counts afresh.
 */
export async function scheduleSeatSync(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<void> {
  const billing = await billingOf(ctx, workspaceId);
  if (!billing?.seatItemId || !isLiveStatus(billing.status)) return;
  const now = Date.now();
  if (seatSyncWaiting(billing, now)) return;
  await ctx.db.patch(billing._id, { seatSyncPendingAt: now });
  await ctx.scheduler.runAfter(SEAT_SYNC_DELAY_MS, internal.teamBilling.syncSeats, {
    workspaceId,
  });
}

/**
 * Takes the waiting sync and says what it should do. Clearing the flag first
 * is what makes a change landing while the sync runs schedule another.
 */
export const takeSeatSync = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.null(),
    v.object({ kind: v.literal("seats"), seatItemId: v.string(), seats: v.number() }),
    v.object({ kind: v.literal("cancel"), subscriptionId: v.string() }),
  ),
  handler: async (ctx, { workspaceId }) => {
    const billing = await billingOf(ctx, workspaceId);
    if (!billing) return null;
    if (billing.seatSyncPendingAt !== undefined) {
      await ctx.db.patch(billing._id, { seatSyncPendingAt: undefined });
    }
    if (!billing.subscriptionId || !billing.seatItemId || !isLiveStatus(billing.status)) {
      return null;
    }
    // A deleted workspace has no seats left and no one to open its billing
    // settings, so it stops paying when the period it paid for ends.
    const workspace = await ctx.db.get(workspaceId);
    if (!workspace || workspace.deletedAt !== undefined) {
      return billing.cancelAtPeriodEnd
        ? null
        : { kind: "cancel" as const, subscriptionId: billing.subscriptionId };
    }
    const seats = await seatsInUse(ctx, workspaceId);
    return seats === billing.seats
      ? null
      : { kind: "seats" as const, seatItemId: billing.seatItemId, seats };
  },
});

/**
 * Pushes the seat count to the subscription's seat item, prorated. The item
 * directly, found by price at mirror time: the component's own quantity
 * update changes the first item, which may be the metered one.
 */
export const syncSeats = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    const sync = await ctx.runMutation(internal.teamBilling.takeSeatSync, { workspaceId });
    if (!sync) return null;
    if (sync.kind === "cancel") {
      await stripeSdk().subscriptions.update(sync.subscriptionId, { cancel_at_period_end: true });
      return null;
    }
    await stripeSdk().subscriptionItems.update(sync.seatItemId, {
      quantity: sync.seats,
      proration_behavior: "create_prorations",
    });
    await ctx.runMutation(internal.teamBilling.recordSeats, { workspaceId, seats: sync.seats });
    return null;
  },
});

export const recordSeats = internalMutation({
  args: { workspaceId: v.id("workspaces"), seats: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, seats }) => {
    const billing = await billingOf(ctx, workspaceId);
    if (!billing) return null;
    await ctx.db.patch(billing._id, {
      seats,
      aiAllowanceUsd: seats * allowancePerSeatUsd(),
      updatedAt: Date.now(),
    });
    return null;
  },
});

// ---- Usage -----------------------------------------------------------------------

type UsagePeriod = NonNullable<Doc<"workspaceBilling">["usagePeriod"]>;

/**
 * Whole cents of spend past an allowance. Floored: a fraction of a cent waits
 * in the running total until it makes a whole one, rather than being rounded
 * up night after night.
 */
export function overageCents(spentUsd: number, allowanceUsd: number): number {
  return Math.max(0, Math.floor((spentUsd - allowanceUsd) * 100 + 1e-6));
}

const range = v.object({ from: v.number(), to: v.number() });

/**
 * The spend one report covers: from where the last left off to a little
 * before now, cut at the period's end. After a renewal, `tail` is what was
 * left of the period before — counted against that period's allowance — and
 * `current` starts at the new period.
 */
export type UsageWindow = {
  from: number;
  through: number;
  tail: { from: number; to: number } | null;
  current: { from: number; to: number } | null;
};

export function usageWindow(
  billing: Pick<
    Doc<"workspaceBilling">,
    "periodStart" | "periodEnd" | "usageReportedThrough" | "usagePeriod"
  >,
  now: number,
): UsageWindow | null {
  const from = billing.usageReportedThrough ?? billing.periodStart;
  const previous = billing.usagePeriod;
  const tailTo =
    previous && previous.start !== billing.periodStart
      ? Math.min(previous.end, billing.periodStart)
      : from;
  const tail = from < tailTo ? { from, to: tailTo } : null;
  const currentFrom = Math.max(from, billing.periodStart);
  const currentTo = Math.min(now - SETTLE_MS, billing.periodEnd);
  const current = currentTo > currentFrom ? { from: currentFrom, to: currentTo } : null;
  const through = current?.to ?? tail?.to;
  return through === undefined ? null : { from, through, tail, current };
}

/**
 * What to send, and where the count stands after. `reportedCents` is what the
 * period has already been billed, so each report sends only what the period
 * owes beyond it: a report never takes back, and seats added mid-period —
 * which raise the allowance — never turn into a refund.
 */
export function nextReport(
  previous: UsagePeriod | undefined,
  period: { start: number; end: number; allowanceUsd: number },
  tailUsd: number,
  currentUsd: number,
): { cents: number; period: UsagePeriod } {
  let cents = 0;
  let spentUsd = currentUsd;
  let reportedCents = 0;
  if (previous?.start === period.start) {
    spentUsd += previous.spentUsd;
    reportedCents = previous.reportedCents;
  } else if (previous) {
    cents += Math.max(
      0,
      overageCents(previous.spentUsd + tailUsd, previous.allowanceUsd) - previous.reportedCents,
    );
  }
  const owed = Math.max(0, overageCents(spentUsd, period.allowanceUsd) - reportedCents);
  return {
    cents: cents + owed,
    period: { ...period, spentUsd, reportedCents: reportedCents + owed },
  };
}

/**
 * Adds one signed call's cost to its maker's running total for the workspace's
 * current period (`workspaceSpend`). Nothing while the workspace has no
 * subscription: there is no period to count it in, and the screen shows no
 * usage then.
 */
export async function addPeriodSpend(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  userId: string,
  costUsd: number,
  guest: boolean,
): Promise<void> {
  const billing = await billingOf(ctx, workspaceId);
  if (!billing?.subscriptionId) return;
  const periodStart = billing.periodStart;
  const row = await ctx.db
    .query("workspaceSpend")
    .withIndex("by_workspace_and_period_and_user", (q) =>
      q.eq("workspaceId", workspaceId).eq("periodStart", periodStart).eq("userId", userId),
    )
    .unique();
  const seatUsd = guest ? 0 : costUsd;
  const guestUsd = guest ? costUsd : 0;
  if (row) {
    await ctx.db.patch(row._id, {
      seatUsd: row.seatUsd + seatUsd,
      guestUsd: row.guestUsd + guestUsd,
    });
  } else {
    await ctx.db.insert("workspaceSpend", { workspaceId, periodStart, userId, seatUsd, guestUsd });
  }
}

/** Signed spend a workspace's calls made in `[from, to)`, one page at a time. */
export const signedSpend = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    from: v.number(),
    to: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({ usd: v.number(), cursor: v.string(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("aiCalls")
      .withIndex("by_workspace_and_createdAt", (q) =>
        q.eq("workspaceId", args.workspaceId).gte("createdAt", args.from).lt("createdAt", args.to),
      )
      .paginate({ numItems: SPEND_PAGE, cursor: args.cursor });
    let usd = 0;
    // Unsigned rows carry whatever cost their writer claimed (`ai/calls.ts`).
    for (const row of page.page) if (row.signed && row.costUsd) usd += row.costUsd;
    return { usd, cursor: page.continueCursor, done: page.isDone };
  },
});

async function sumSpend(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  window: { from: number; to: number } | null,
): Promise<number> {
  if (!window) return 0;
  let usd = 0;
  let cursor: string | null = null;
  for (;;) {
    const page: { usd: number; cursor: string; done: boolean } = await ctx.runQuery(
      internal.teamBilling.signedSpend,
      { workspaceId, ...window, cursor },
    );
    usd += page.usd;
    if (page.done) return usd;
    cursor = page.cursor;
  }
}

const report = v.object({ identifier: v.string(), cents: v.number(), customerId: v.string() });

/**
 * What tonight's report for one workspace is: a report already counted and
 * not yet acknowledged, to send again; or the spend to count; or nothing — no
 * live subscription, no usage item, or no time has passed.
 */
export const usageJob = internalQuery({
  args: { workspaceId: v.id("workspaces"), now: v.number() },
  returns: v.union(
    v.null(),
    v.object({ kind: v.literal("resend"), report }),
    v.object({
      kind: v.literal("count"),
      periodStart: v.number(),
      window: v.object({
        from: v.number(),
        through: v.number(),
        tail: v.union(range, v.null()),
        current: v.union(range, v.null()),
      }),
    }),
  ),
  handler: async (ctx, { workspaceId, now }) => {
    const billing = await billingOf(ctx, workspaceId);
    if (!billing?.usageItemId || !workspaceSubscriptionLive(billing, now)) return null;
    if (billing.pendingUsage) {
      return {
        kind: "resend" as const,
        report: { ...billing.pendingUsage, customerId: billing.stripeCustomerId },
      };
    }
    const window = usageWindow(billing, now);
    return window ? { kind: "count" as const, periodStart: billing.periodStart, window } : null;
  },
});

/**
 * Counts one report and moves the watermark past it, in one transaction, then
 * hands back what to send. Refuses — returning null — if the row moved since
 * the spend was summed: another report ran, or the period changed under it.
 * The identifier is fixed here, before anything reaches Stripe, so a send
 * that fails is retried as the same event.
 */
export const claimUsage = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    from: v.number(),
    periodStart: v.number(),
    through: v.number(),
    tailUsd: v.number(),
    currentUsd: v.number(),
  },
  returns: v.union(report, v.null()),
  handler: async (ctx, args) => {
    const billing = await billingOf(ctx, args.workspaceId);
    if (
      !billing ||
      billing.pendingUsage ||
      billing.periodStart !== args.periodStart ||
      (billing.usageReportedThrough ?? billing.periodStart) !== args.from
    ) {
      return null;
    }
    const { cents, period } = nextReport(
      billing.usagePeriod,
      { start: billing.periodStart, end: billing.periodEnd, allowanceUsd: billing.aiAllowanceUsd },
      args.tailUsd,
      args.currentUsd,
    );
    const identifier = `${args.workspaceId}:${billing.periodStart}:${args.through}`;
    await ctx.db.patch(billing._id, {
      usageReportedThrough: args.through,
      usagePeriod: period,
      pendingUsage: cents > 0 ? { identifier, cents } : undefined,
    });
    return cents > 0 ? { identifier, cents, customerId: billing.stripeCustomerId } : null;
  },
});

export const settleUsage = internalMutation({
  args: { workspaceId: v.id("workspaces"), identifier: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const billing = await billingOf(ctx, args.workspaceId);
    if (billing?.pendingUsage?.identifier === args.identifier) {
      await ctx.db.patch(billing._id, { pendingUsage: undefined });
    }
    return null;
  },
});

/**
 * One workspace's report: its overage since the last, in whole cents, as one
 * meter event. The identifier (`<workspace>:<periodStart>:<through>`) is what
 * makes a resend of the same report one charge at Stripe; a failed send is
 * retried a few times within the hour and otherwise by the next night's run,
 * still under that identifier.
 */
export const reportWorkspaceUsage = internalAction({
  args: { workspaceId: v.id("workspaces"), attempt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { workspaceId, attempt = 0 }) => {
    const eventName = process.env.STRIPE_TEAM_METER_EVENT;
    if (!eventName) return null;
    const job = await ctx.runQuery(internal.teamBilling.usageJob, { workspaceId, now: Date.now() });
    if (!job) return null;
    let toSend = job.kind === "resend" ? job.report : null;
    if (job.kind === "count") {
      const { window } = job;
      toSend = await ctx.runMutation(internal.teamBilling.claimUsage, {
        workspaceId,
        from: window.from,
        periodStart: job.periodStart,
        through: window.through,
        tailUsd: await sumSpend(ctx, workspaceId, window.tail),
        currentUsd: await sumSpend(ctx, workspaceId, window.current),
      });
    }
    if (!toSend) return null;
    try {
      await stripeSdk().billing.meterEvents.create({
        event_name: eventName,
        payload: { stripe_customer_id: toSend.customerId, value: String(toSend.cents) },
        identifier: toSend.identifier,
      });
    } catch (error) {
      if (attempt < REPORT_RETRIES) {
        await ctx.scheduler.runAfter(
          REPORT_RETRY_MS * 2 ** attempt,
          internal.teamBilling.reportWorkspaceUsage,
          { workspaceId, attempt: attempt + 1 },
        );
      }
      throw error;
    }
    await ctx.runMutation(internal.teamBilling.settleUsage, {
      workspaceId,
      identifier: toSend.identifier,
    });
    return null;
  },
});

/**
 * The nightly run: a usage report for every workspace with a live
 * subscription, and a seat sync for any whose seats have drifted from what
 * Stripe was last told — a sync that failed is retried here rather than in a
 * loop of its own. A page of workspaces at a time.
 */
export const reportUsage = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const page = await ctx.db
      .query("workspaceBilling")
      .paginate({ numItems: 100, cursor: args.cursor ?? null });
    const reporting = !!process.env.STRIPE_TEAM_METER_EVENT;
    for (const billing of page.page) {
      if (!workspaceSubscriptionLive(billing, now)) continue;
      if (reporting && billing.usageItemId) {
        await ctx.scheduler.runAfter(0, internal.teamBilling.reportWorkspaceUsage, {
          workspaceId: billing.workspaceId,
        });
      }
      if (
        billing.seatItemId &&
        !seatSyncWaiting(billing, now) &&
        (await seatsInUse(ctx, billing.workspaceId)) !== billing.seats
      ) {
        await scheduleSeatSync(ctx, billing.workspaceId);
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.teamBilling.reportUsage, {
        cursor: page.continueCursor,
      });
    }
    return null;
  },
});

// ---- The billing screen ---------------------------------------------------------

/** One row per person who spent in the period — far past any real workspace's. */
const SPENDERS_CAP = 5000;

/**
 * What the workspace's billing screen shows, for anyone with a seat of member
 * or above — admins act on it, members read it. Null for guests and everyone
 * else.
 *
 * `usage` is the current period's signed AI spend against the seats'
 * allowance, and what guests spent of it; present only while a subscription
 * is live. `configured` false is a deployment Team cannot be bought on.
 */
export const summary = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, { workspaceId }) => {
    const role = await workspaceRole(ctx, workspaceId);
    if (!role || !atLeast(role, "member")) return null;
    const billing = await billingOf(ctx, workspaceId);
    const standing = await workspaceStanding(ctx, workspaceId);
    const live = workspaceSubscriptionLive(billing, Date.now());
    const hasSubscription = !!billing?.subscriptionId;

    let usage: { allowanceUsd: number; spentUsd: number; guestUsd: number } | null = null;
    if (billing && live) {
      const spenders = await ctx.db
        .query("workspaceSpend")
        .withIndex("by_workspace_and_period_and_user", (q) =>
          q.eq("workspaceId", workspaceId).eq("periodStart", billing.periodStart),
        )
        .take(SPENDERS_CAP);
      let spentUsd = 0;
      let guestUsd = 0;
      for (const row of spenders) {
        spentUsd += row.seatUsd + row.guestUsd;
        guestUsd += row.guestUsd;
      }
      usage = { allowanceUsd: billing.aiAllowanceUsd, spentUsd, guestUsd };
    }

    return {
      role,
      canManage: atLeast(role, "admin"),
      configured: teamBillingConfigured(),
      plan: standing.plan,
      source: standing.source,
      /** There is a customer to open the billing portal for. */
      manageable: billing !== null,
      /**
       * A subscription Stripe holds open but no longer counts as paid for:
       * settled in the portal, never replaced by a second checkout.
       */
      unsettled: !live && subscriptionOpen(billing),
      subscription:
        billing && hasSubscription
          ? {
              status: billing.status,
              live,
              seats: billing.seats,
              periodStart: billing.periodStart,
              periodEnd: billing.periodEnd,
              cancelAtPeriodEnd: billing.cancelAtPeriodEnd ?? false,
            }
          : null,
      seatsInUse: await seatsInUse(ctx, workspaceId),
      allowancePerSeatUsd: allowancePerSeatUsd(),
      usage,
    };
  },
});

/**
 * What the caller should be asked about the workspace's plan, if anything: an
 * admin or owner, on a deployment it can be bought on, of a workspace with no
 * plan — to start one, or, while Stripe holds an unpaid one open, to settle
 * that instead. Apart from `summary` so the home's one line does not re-run
 * with every AI call the workspace makes.
 */
export const unpaid = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), v.literal("start"), v.literal("settle")),
  handler: async (ctx, { workspaceId }) => {
    const role = await workspaceRole(ctx, workspaceId);
    if (!role || !atLeast(role, "admin") || !teamBillingConfigured()) return null;
    if ((await workspaceStanding(ctx, workspaceId)).source !== "none") return null;
    return subscriptionOpen(await billingOf(ctx, workspaceId)) ? "settle" : "start";
  },
});
