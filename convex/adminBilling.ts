import { ConvexError, v } from "convex/values";
import StripeSDK from "stripe";
import { internal } from "./_generated/api";
import { action, internalQuery, mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { requireAdmin } from "./admin";
import { normalizeCode } from "./accessCodes";
import { entitlementOf, ensureAccount, type Entitlement } from "./entitlements";

/**
 * Billing as the operator sees it: who is paying, who was let in for free, and
 * the two levers for letting someone in — a code, or the VIP flag.
 *
 * Split out of `admin.ts` rather than added to it: that file is already the
 * feedback inbox and the agent's queues, and money is a third subject. Same
 * contract though — every function takes the dashboard's session token and
 * opens with `requireAdmin`.
 */

/** Far past any real number of codes; a bound, not a working size. */
const CAP = 500;

/**
 * No `O`/`0`, `I`/`1`, `S`/`5` — these get read off a screenshot and typed by
 * hand, and a code that can be transcribed two ways is a support ticket.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRTUVWXY2346789";

function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** The name to put to an owner id, for a screen full of them. */
async function who(ctx: QueryCtx, ownerId: string) {
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique();
  return {
    ownerId,
    email: profile?.email ?? null,
    name: profile?.name ?? null,
  };
}

// ---- Access codes ---------------------------------------------------------

export const codeList = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const rows = await ctx.db.query("accessCodes").take(CAP);
    const now = Date.now();
    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((row) => ({
        id: row._id,
        code: row.code,
        label: row.label,
        maxRedemptions: row.maxRedemptions ?? null,
        redemptions: row.redemptions,
        durationDays: row.durationDays ?? null,
        expiresAt: row.expiresAt ?? null,
        disabledAt: row.disabledAt ?? null,
        // Decided here rather than in the dashboard: a clock read during render
        // is a value that changes without a re-render to explain it, which the
        // dashboard's lint refuses on exactly those grounds.
        redeemable:
          row.disabledAt === undefined &&
          (row.expiresAt === undefined || row.expiresAt > now) &&
          (row.maxRedemptions === undefined || row.redemptions < row.maxRedemptions),
        createdAt: row.createdAt,
      }));
  },
});

/**
 * Mints a code. `code` is optional — a memorable one for a launch, a generated
 * one for a single person — and is normalized the same way redemption
 * normalizes what is typed, so the two can never disagree.
 */
export const codeCreate = mutation({
  args: {
    token: v.string(),
    label: v.string(),
    code: v.optional(v.string()),
    /** Absent = unlimited redemptions. */
    maxRedemptions: v.optional(v.number()),
    /** Absent = the grant never lapses. */
    durationDays: v.optional(v.number()),
    /** Absent = the code stays redeemable forever. */
    expiresAt: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const label = args.label.trim();
    if (!label) throw new ConvexError("A code needs a label — what is it for?");

    const code = args.code ? normalizeCode(args.code) : generateCode();
    if (code.length < 4) throw new ConvexError("That code is too short to be one.");
    const clash = await ctx.db
      .query("accessCodes")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (clash) throw new ConvexError(`${code} already exists.`);

    await ctx.db.insert("accessCodes", {
      code,
      label,
      redemptions: 0,
      maxRedemptions: args.maxRedemptions,
      durationDays: args.durationDays,
      expiresAt: args.expiresAt,
      createdAt: Date.now(),
    });
    return code;
  },
});

/**
 * Withdraws a code, or brings it back.
 *
 * Grants already made are untouched: taking a code out of circulation stops
 * new people using it, and is not a way to reach into accounts that already
 * have access. Revoking one of those is `setVip(false)` plus deleting the
 * redemption, which is deliberately a separate, deliberate act.
 */
export const codeSetDisabled = mutation({
  args: { token: v.string(), id: v.id("accessCodes"), disabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    await ctx.db.patch(args.id, {
      disabledAt: args.disabled ? Date.now() : undefined,
    });
    return null;
  },
});

/** Who used one code, and whether their grant is still standing. */
export const codeRedemptions = query({
  args: { token: v.string(), id: v.id("accessCodes") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const rows = await ctx.db
      .query("codeRedemptions")
      .withIndex("by_code", (q) => q.eq("codeId", args.id))
      .take(CAP);
    const now = Date.now();
    return await Promise.all(
      rows
        .sort((a, b) => b.redeemedAt - a.redeemedAt)
        .map(async (row) => ({
          ...(await who(ctx, row.ownerId)),
          redeemedAt: row.redeemedAt,
          expiresAt: row.expiresAt ?? null,
          live: row.expiresAt === undefined || row.expiresAt > now,
        })),
    );
  },
});

// ---- VIP ------------------------------------------------------------------

/**
 * The complete pass, and the only lever that outranks a lapsed card.
 *
 * The note is required on the way in for the same reason `impersonations`
 * requires a reason: an unexplained free account six months later is
 * indistinguishable from a mistake, and the session that set it is recorded so
 * there is an answer to "who did this".
 */
export const setVip = mutation({
  args: {
    token: v.string(),
    ownerId: v.string(),
    vip: v.boolean(),
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await requireAdmin(ctx, args.token);
    const note = args.note?.trim();
    if (args.vip && !note) throw new ConvexError("Say why this account is VIP.");
    const account = await ensureAccount(ctx, args.ownerId);
    await ctx.db.patch(account._id, {
      vip: args.vip,
      // The last reason stands after the flag is cleared — the record of why
      // someone WAS let in outlives the letting in.
      ...(args.vip ? { vipNote: note, vipSetAt: Date.now(), vipSetBy: session._id } : {}),
    });
    return null;
  },
});

// ---- Per-account and roll-up reads ----------------------------------------

/** One account's standing, for the user detail page. */
export const accountFor = query({
  args: { token: v.string(), ownerId: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const account = await ctx.db
      .query("billingAccounts")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    return {
      entitlement: await entitlementOf(ctx, args.ownerId),
      vipNote: account?.vipNote ?? null,
      vipSetAt: account?.vipSetAt ?? null,
      stripeCustomerId: account?.stripeCustomerId ?? null,
      subscription: account?.subscription ?? null,
      // Where this person met the paywall and whether they went as far as
      // Stripe — the two facts that turn "they are on free" into a reason.
      walls: account?.walls ?? null,
      checkoutAt: account?.checkoutAt ?? null,
      checkouts: account?.checkouts ?? 0,
    };
  },
});

/**
 * Everyone who is on pro and how they got there — the one screen that answers
 * "who is actually paying, and who did we let in".
 *
 * Scans `billingAccounts` rather than joining from Stripe: a row exists for
 * every account that has spent anything or been given anything, which is a far
 * smaller set than the user table and the only set this question is about.
 * Code grants are picked up separately, since redeeming one writes no account
 * row.
 */
export const proAccounts = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const accounts = await ctx.db.query("billingAccounts").take(CAP);
    const redeemed = await ctx.db.query("codeRedemptions").take(CAP);
    const owners = new Set([
      ...accounts.map((a) => a.ownerId),
      ...redeemed.map((r) => r.ownerId),
    ]);

    const rows = await Promise.all(
      [...owners].map(async (ownerId) => ({
        ...(await who(ctx, ownerId)),
        entitlement: await entitlementOf(ctx, ownerId),
      })),
    );
    return rows
      .filter((row) => row.entitlement.plan === "pro")
      .sort((a, b) => (a.email ?? a.ownerId).localeCompare(b.email ?? b.ownerId));
  },
});

// ---- Revenue and the paywall funnel ---------------------------------------

/**
 * Every account that has ever touched billing, with what it pays and how it
 * got where it is.
 *
 * `billingAccounts` is the right table to scan: a row exists for anyone who
 * has spent a completion, met a wall, opened checkout or been comped, which is
 * a far smaller set than the user table and exactly the set these questions
 * are about. Amounts are NOT here — the price is Stripe's, and joining it on
 * is `revenue`'s job, which can actually ask.
 */
export type BillingRosterRow = {
  ownerId: string;
  email: string | null;
  name: string | null;
  entitlement: Entitlement;
  priceId: string | null;
  interval: "month" | "year" | null;
  status: string | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  stripeCustomerId: string | null;
  walls: {
    firstAt: number;
    lastAt: number;
    projects: number;
    completions: number;
    chats: number;
  } | null;
  checkoutAt: number | null;
  checkouts: number;
  used: { completions: number; chats: number };
};

export const billingRoster = internalQuery({
  args: {},
  // Annotated because `revenue`, in this same file, calls it: without a
  // written type the two infer through each other and TypeScript gives up on
  // both.
  handler: async (ctx): Promise<BillingRosterRow[]> => {
    const accounts = await ctx.db.query("billingAccounts").take(CAP);
    // Somebody can be on Pro through a code without ever writing an account
    // row, so the redemptions have to be swept in too or the roster would miss
    // exactly the people who were let in for free.
    const redeemed = await ctx.db.query("codeRedemptions").take(CAP);
    const owners = new Set([
      ...accounts.map((a) => a.ownerId),
      ...redeemed.map((r) => r.ownerId),
    ]);
    const byOwner = new Map(accounts.map((a) => [a.ownerId, a]));

    return await Promise.all(
      [...owners].map(async (ownerId) => {
        const account = byOwner.get(ownerId);
        return {
          ...(await who(ctx, ownerId)),
          entitlement: await entitlementOf(ctx, ownerId),
          priceId: account?.subscription?.priceId ?? null,
          interval: account?.subscription?.interval ?? null,
          status: account?.subscription?.status ?? null,
          currentPeriodEnd: account?.subscription?.currentPeriodEnd ?? null,
          cancelAtPeriodEnd: account?.subscription?.cancelAtPeriodEnd ?? false,
          stripeCustomerId: account?.stripeCustomerId ?? null,
          walls: account?.walls ?? null,
          checkoutAt: account?.checkoutAt ?? null,
          checkouts: account?.checkouts ?? 0,
          used: account
            ? {
                completions: account.acceptedCompletions,
                chats: account.chatConversations,
              }
            : { completions: 0, chats: 0 },
        };
      }),
    );
  },
});

const CENTS_PER_MONTH = 1;

/**
 * What each customer actually pays, and the monthly total.
 *
 * An action because the amount lives in Stripe and nowhere else. It is read
 * once per distinct price — there are two — and joined onto the mirrored
 * subscriptions, so the figures cannot drift from what is being charged the
 * way a price copied into our own tables would.
 *
 * Annual plans are divided by twelve so one column can be added up. That is
 * MRR by the usual convention and it is a convention, not a fact: the cash
 * arrived in one lump. Stripe's own dashboard is the place for revenue
 * accounting; this is the place for "who pays me, and how much".
 */
export type RevenueReport = {
  paying: {
    ownerId: string;
    email: string | null;
    name: string | null;
    interval: "month" | "year" | null;
    status: string | null;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: number | null;
    amount: number | null;
    currency: string | null;
    monthly: number | null;
  }[];
  mrr: number;
  currency: string | null;
  unpriced: number;
};

export const revenue = action({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<RevenueReport> => {
    await ctx.runQuery(internal.adminBilling.checkAdmin, { token: args.token });
    const roster = await ctx.runQuery(internal.adminBilling.billingRoster, {});

    const priceIds: string[] = [
      ...new Set(roster.map((r) => r.priceId).filter((id) => id !== null)),
    ];
    const prices = new Map<string, { amount: number; currency: string }>();
    if (priceIds.length) {
      const stripe = stripeSdk();
      for (const id of priceIds) {
        const found = await stripe.prices.retrieve(id).catch(() => null);
        if (found?.unit_amount != null) {
          prices.set(id, { amount: found.unit_amount, currency: found.currency });
        }
      }
    }

    const paying = roster
      .filter((row) => row.entitlement.source === "subscription")
      .map((row) => {
        const price = row.priceId ? (prices.get(row.priceId) ?? null) : null;
        return {
          ownerId: row.ownerId,
          email: row.email,
          name: row.name,
          interval: row.interval,
          status: row.status,
          cancelAtPeriodEnd: row.cancelAtPeriodEnd,
          currentPeriodEnd: row.currentPeriodEnd,
          /** What they are charged each period, in the smallest unit. */
          amount: price?.amount ?? null,
          currency: price?.currency ?? null,
          /** The same, normalized to a month, so the column adds up. */
          monthly:
            price === null
              ? null
              : row.interval === "year"
                ? Math.round(price.amount / 12)
                : price.amount * CENTS_PER_MONTH,
        };
      })
      .sort((a, b) => (b.monthly ?? 0) - (a.monthly ?? 0));

    return {
      paying,
      mrr: paying.reduce((sum, row) => sum + (row.monthly ?? 0), 0),
      /** Every paying row shares one currency in practice; the first one names it. */
      currency: paying.find((row) => row.currency)?.currency ?? null,
      unpriced: paying.filter((row) => row.monthly === null).length,
    };
  },
});

/**
 * Who was stopped by the paywall, and what happened next.
 *
 * The list is deliberately of people who were told no and are STILL not
 * paying — the ones who converted are on the paying table and are not a
 * question. Sorted by how hard they hit it, because somebody who met the wall
 * eleven times and never paid is telling you something a one-timer is not.
 */
export const funnel = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const accounts = await ctx.db.query("billingAccounts").take(CAP);

    const rows = await Promise.all(
      accounts
        .filter((a) => a.walls !== undefined)
        .map(async (account) => {
          const entitlement = await entitlementOf(ctx, account.ownerId);
          const walls = account.walls!;
          return {
            ...(await who(ctx, account.ownerId)),
            plan: entitlement.plan,
            source: entitlement.source,
            firstAt: walls.firstAt,
            lastAt: walls.lastAt,
            hits: walls.projects + walls.completions + walls.chats,
            projects: walls.projects,
            completions: walls.completions,
            chats: walls.chats,
            checkouts: account.checkouts ?? 0,
            checkoutAt: account.checkoutAt ?? null,
          };
        }),
    );

    const walled = rows.length;
    const reachedCheckout = rows.filter((r) => r.checkouts > 0).length;
    const converted = rows.filter((r) => r.source === "subscription").length;

    return {
      walled,
      reachedCheckout,
      converted,
      /** Told no, and still not paying by any route — the list worth reading. */
      stalled: rows
        .filter((r) => r.plan === "free")
        .sort((a, b) => b.hits - a.hits || b.lastAt - a.lastAt),
    };
  },
});

// ---- Discount codes (Stripe promotion codes) -------------------------------

/**
 * Discounts are Stripe's, not ours.
 *
 * The distinction that decides everything below: an `accessCode` grants access
 * for nothing and never reaches a payment, while a discount reduces a price
 * that is still being charged — proration, tax, currency and the invoice all
 * follow from it, and every one of those is Stripe's to get right. So these
 * functions are a window onto Stripe's promotion codes rather than a table of
 * our own, and the field where one is typed is Stripe's checkout page.
 */

/** The token check, reachable from an action — which cannot read the database. */
export const checkAdmin = internalQuery({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    return null;
  },
});

function stripeSdk(): StripeSDK {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new ConvexError("No Stripe key is set on this deployment.");
  return new StripeSDK(key);
}

const discount = v.object({
  id: v.string(),
  code: v.string(),
  active: v.boolean(),
  /** One of the two is set; the other is null. */
  percentOff: v.union(v.number(), v.null()),
  amountOff: v.union(v.number(), v.null()),
  currency: v.union(v.string(), v.null()),
  /** "once" | "forever" | "repeating" — how long it rides a subscription. */
  duration: v.string(),
  redemptions: v.number(),
  maxRedemptions: v.union(v.number(), v.null()),
  /** Seconds, as Stripe reports it; the dashboard converts. */
  expiresAt: v.union(v.number(), v.null()),
});

export const discountList = action({
  args: { token: v.string() },
  returns: v.array(discount),
  handler: async (ctx, args) => {
    await ctx.runQuery(internal.adminBilling.checkAdmin, { token: args.token });
    // Expanded, because unexpanded the promotion carries only the coupon's id
    // — and the id is the one thing about a discount nobody needs to read.
    const rows = await stripeSdk().promotionCodes.list({
      limit: 100,
      expand: ["data.promotion.coupon"],
    });
    return rows.data.map((row) => {
      const coupon = row.promotion.coupon;
      const full = typeof coupon === "object" && coupon !== null ? coupon : null;
      return {
        id: row.id,
        code: row.code,
        active: row.active,
        percentOff: full?.percent_off ?? null,
        amountOff: full?.amount_off ?? null,
        currency: full?.currency ?? null,
        duration: full?.duration ?? "once",
        redemptions: row.times_redeemed,
        maxRedemptions: row.max_redemptions ?? null,
        expiresAt: row.expires_at ?? null,
      };
    });
  },
});

/**
 * Mints a coupon and the code that redeems it, in one go.
 *
 * Two Stripe objects rather than one because Stripe separates the discount
 * from the word people type for it — one coupon can have several codes. We
 * never need that, so the operator is asked for one thing and gets both.
 *
 * `forever` is offered beside `once` because on a subscription they are
 * genuinely different offers: a first-month discount and a permanently cheaper
 * price. Nothing here can express "three months off" — that is `repeating`,
 * and it is the kind of thing worth building when it is actually wanted.
 */
export const discountCreate = action({
  args: {
    token: v.string(),
    /** What it is for. Rides along on the coupon so Stripe's dashboard says so too. */
    label: v.string(),
    code: v.string(),
    percentOff: v.optional(v.number()),
    /** In the currency's smallest unit, with `currency` set alongside. */
    amountOff: v.optional(v.number()),
    currency: v.optional(v.string()),
    forever: v.boolean(),
    maxRedemptions: v.optional(v.number()),
    /** Milliseconds, as the rest of this codebase counts time. */
    expiresAt: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    await ctx.runQuery(internal.adminBilling.checkAdmin, { token: args.token });
    const label = args.label.trim();
    if (!label) throw new ConvexError("A discount needs a name — what is it for?");
    const code = normalizeCode(args.code);
    if (code.length < 4) throw new ConvexError("That code is too short to be one.");
    if (!args.percentOff && !args.amountOff) {
      throw new ConvexError("Say how much comes off — a percentage or an amount.");
    }

    const stripe = stripeSdk();
    const coupon = await stripe.coupons.create({
      name: label,
      duration: args.forever ? "forever" : "once",
      ...(args.percentOff
        ? { percent_off: args.percentOff }
        : {
            amount_off: args.amountOff!,
            currency: (args.currency ?? "usd").toLowerCase(),
          }),
    });
    const promotion = await stripe.promotionCodes.create({
      promotion: { type: "coupon", coupon: coupon.id },
      code,
      ...(args.maxRedemptions ? { max_redemptions: args.maxRedemptions } : {}),
      // Stripe counts in seconds; everything else here counts in milliseconds,
      // and the two have to be converted somewhere.
      ...(args.expiresAt ? { expires_at: Math.floor(args.expiresAt / 1000) } : {}),
    });
    return promotion.code;
  },
});

/**
 * Turns a discount off, or back on.
 *
 * Stripe does not let a promotion code be deleted, which is the right shape:
 * an order that used one has to keep making sense years later, and the only
 * honest way to stop a code is to stop it working from now on.
 */
export const discountSetActive = action({
  args: { token: v.string(), id: v.string(), active: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.runQuery(internal.adminBilling.checkAdmin, { token: args.token });
    await stripeSdk().promotionCodes.update(args.id, { active: args.active });
    return null;
  },
});
