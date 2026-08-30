import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  ownerId as currentOwner,
  isTrashed,
  requireOwned,
  requireOwner,
} from "./auth";

/**
 * What an account may do — the one place that answers it.
 *
 * The same shape of rule as `auth.ts`: access is resolved HERE and nowhere
 * else, so a new gate cannot quietly invent its own definition of "paid". Four
 * sources feed one answer, in order, first match winning:
 *
 *   1. the operator's VIP flag — a complete pass, outranking even a lapsed card
 *   2. a redeemed access code that has not lapsed
 *   3. a live Stripe subscription, as the webhook last mirrored it
 *   4. otherwise free, with what is left of the one-time allowance
 *
 * The payment provider is deliberately just one of those four and the last that
 * can say yes. Swapping Stripe for a merchant of record later changes who
 * writes `billingAccounts.subscription`, and nothing else in the app.
 *
 * The free allowance does NOT refill. It is a taste of the product, not a tier
 * to live in, and the counters that record it are therefore never reset.
 */

/**
 * The numbers themselves live in `limits.ts` and are re-exported here, so every
 * server caller keeps reading them from the module that enforces them. The
 * client imports the other end directly — see that file for why the split
 * exists at all.
 */
import { FREE_LIMITS, type Meter } from "./limits";

export { FREE_LIMITS, type Meter };

export type Plan = "free" | "pro";

/** Which of the four sources answered. `"none"` is a free account. */
export type Source = "none" | "vip" | "code" | "subscription";

export type Entitlement = {
  plan: Plan;
  source: Source;
  /** How much allowance remains. `null` on pro — there is nothing to count. */
  left: Record<Meter, number> | null;
  /** How much has been spent. `null` on pro, for the same reason. */
  used: Record<Meter, number> | null;
  /** When pro lapses. Absent = it does not (VIP, or a permanent code grant). */
  expiresAt?: number;
  /** Subscribed, but set to stop at the end of the period. */
  cancelAtPeriodEnd?: boolean;
};

/**
 * Stripe statuses that keep the door open.
 *
 * `past_due` is in deliberately: a card that failed a retry is a payment
 * problem, not a decision to leave, and Stripe is still retrying. Locking
 * someone out mid-dunning loses the customer the retry was about to recover.
 * A subscription that truly ends becomes `canceled`, which is not here.
 */
const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

/** The error every gate throws, shaped so the client can draw the right wall. */
export type QuotaRefusal = { code: "quota"; meter: Meter; limit: number };

/**
 * `ConvexError` rather than `Error`, for the same reason `auth.ts` uses one: a
 * production deployment redacts a plain `Error`, and the difference between
 * "you are out of chats" and "the server broke" is the difference between an
 * upgrade prompt and a bug report.
 */
export function quotaRefusal(meter: Meter): ConvexError<QuotaRefusal> {
  return new ConvexError({ code: "quota", meter, limit: FREE_LIMITS[meter] });
}

/** True when `e` is this module's refusal — the client's narrowing hook. */
export function isQuotaRefusal(e: unknown): e is ConvexError<QuotaRefusal> {
  return (
    e instanceof ConvexError &&
    typeof e.data === "object" &&
    e.data !== null &&
    (e.data as { code?: unknown }).code === "quota"
  );
}

async function accountOf(
  ctx: QueryCtx,
  owner: string,
): Promise<Doc<"billingAccounts"> | null> {
  return await ctx.db
    .query("billingAccounts")
    .withIndex("by_owner", (q) => q.eq("ownerId", owner))
    .unique();
}

/**
 * Live projects this account owns, counted rather than stored.
 *
 * A stored count drifts the moment a project is trashed and restored, and this
 * is only ever asked one project short of the limit — so the bounded read is
 * both cheaper to keep right and cheap enough to do. Projects shared WITH
 * someone are not theirs and never counted; a free collaborator on a paid
 * project keeps working.
 */
async function liveProjects(ctx: QueryCtx, owner: string): Promise<number> {
  const rows = await ctx.db
    .query("projects")
    .withIndex("by_owner", (q) => q.eq("ownerId", owner))
    .take(FREE_LIMITS.projects + 1);
  return rows.filter((p) => !isTrashed(p)).length;
}

/** The furthest-out live code grant, or null if none is still standing. */
async function codeGrant(
  ctx: QueryCtx,
  owner: string,
  now: number,
): Promise<{ expiresAt?: number } | null> {
  const rows = await ctx.db
    .query("codeRedemptions")
    .withIndex("by_owner", (q) => q.eq("ownerId", owner))
    .collect();
  let best: { expiresAt?: number } | null = null;
  for (const row of rows) {
    if (row.expiresAt !== undefined && row.expiresAt <= now) continue;
    // A permanent grant beats every dated one and ends the search.
    if (row.expiresAt === undefined) return {};
    if (best?.expiresAt === undefined || row.expiresAt > best.expiresAt) {
      best = { expiresAt: row.expiresAt };
    }
  }
  return best;
}

/**
 * A pro answer. The meters are explicitly null rather than absent — `hasRoom`
 * reads that null as "nothing to count", and an omitted field would read as a
 * meter of zero, which is the exact opposite.
 */
function pro(source: Source, rest: Partial<Entitlement> = {}): Entitlement {
  return { plan: "pro", source, left: null, used: null, ...rest };
}

/**
 * The whole answer for one account. Everything else in the app reads this.
 */
export async function entitlementOf(
  ctx: QueryCtx,
  owner: string,
): Promise<Entitlement> {
  const now = Date.now();
  const account = await accountOf(ctx, owner);

  if (account?.vip) return pro("vip");

  const code = await codeGrant(ctx, owner, now);
  if (code) return pro("code", code);

  const sub = account?.subscription;
  if (sub && LIVE_STATUSES.has(sub.status)) {
    return pro("subscription", {
      expiresAt: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    });
  }

  const used: Record<Meter, number> = {
    projects: await liveProjects(ctx, owner),
    completions: account?.acceptedCompletions ?? 0,
    chats: account?.chatConversations ?? 0,
  };
  return {
    plan: "free",
    source: "none",
    used,
    // Clamped: a meter can saturate past its limit in a race, and "-3 left" is
    // not a thing to show anyone.
    left: {
      projects: Math.max(0, FREE_LIMITS.projects - used.projects),
      completions: Math.max(0, FREE_LIMITS.completions - used.completions),
      chats: Math.max(0, FREE_LIMITS.chats - used.chats),
    },
  };
}

/** Whether one meter still has room. Pro always does. */
export function hasRoom(entitlement: Entitlement, meter: Meter): boolean {
  return entitlement.left === null || entitlement.left[meter] > 0;
}

/**
 * The gate. Throws `quotaRefusal` when the meter is spent, and otherwise
 * returns the entitlement so the caller does not read it twice.
 *
 * Callers pass the owner they have already resolved through `requireOwner`,
 * which is what keeps a stand-in session out: an operator cannot spend
 * somebody else's allowance because they cannot get past that call at all.
 */
export async function requireQuota(
  ctx: QueryCtx,
  owner: string,
  meter: Meter,
): Promise<Entitlement> {
  const entitlement = await entitlementOf(ctx, owner);
  if (!hasRoom(entitlement, meter)) throw quotaRefusal(meter);
  return entitlement;
}

/** The account row, created on first use. Absence means "free, untouched". */
export async function ensureAccount(
  ctx: MutationCtx,
  owner: string,
): Promise<Doc<"billingAccounts">> {
  const existing = await accountOf(ctx, owner);
  if (existing) return existing;
  const id = await ctx.db.insert("billingAccounts", {
    ownerId: owner,
    acceptedCompletions: 0,
    chatConversations: 0,
    createdAt: Date.now(),
  });
  return (await ctx.db.get(id))!;
}

/**
 * Charges one unit against a meter. Deliberately does NOT throw.
 *
 * Refusing is the gate's job, and the gate runs before the work. By the time
 * something is being charged the work has already happened — an accepted
 * suggestion is already in the document — and turning that into an error would
 * show the user a failure for something that plainly succeeded. A meter that
 * saturates a little past its limit in a race is the cheaper wrong.
 *
 * `projects` is not chargeable: it is counted off the projects themselves.
 */
export async function spendMeter(
  ctx: MutationCtx,
  owner: string,
  meter: Exclude<Meter, "projects">,
): Promise<void> {
  const account = await ensureAccount(ctx, owner);
  const field =
    meter === "completions" ? "acceptedCompletions" : "chatConversations";
  await ctx.db.patch(account._id, { [field]: account[field] + 1 });
}

/**
 * Charges a conversation, once, the first time it reaches the model.
 *
 * Called by `/api/chat` before every turn, including the several requests one
 * turn takes as client tools are answered — `billedAt` is what makes that
 * idempotent. A thread already charged is waved through even with the
 * allowance spent, because it was paid for when it started and stopping
 * mid-conversation would punish the user for continuing to talk.
 *
 * Note the order: the quota is checked BEFORE the stamp, so a refusal leaves
 * the thread uncharged and the user can come back to it after upgrading.
 */
export const beginChat = mutation({
  args: { threadId: v.id("chatThreads") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const thread = await requireOwned(ctx, "chatThreads", args.threadId);
    if (thread.billedAt !== undefined) return null;
    const owner = await requireOwner(ctx);
    const entitlement = await requireQuota(ctx, owner, "chats");
    // Pro accounts are not metered, so there is nothing to stamp: were they to
    // lapse, the threads they started while paying should not each be holding
    // a slot of the free allowance they never spent.
    if (entitlement.plan === "free") {
      await ctx.db.patch(args.threadId, { billedAt: Date.now() });
      await spendMeter(ctx, owner, "chats");
    }
    return null;
  },
});

/**
 * Records that this account was stopped by a wall.
 *
 * Called by the wall itself, as it is drawn. Deliberately a separate act from
 * the refusal that caused it: the server refuses in several places and the
 * user is only ever SHOWN one wall, and it is the showing that the funnel is
 * about. What we want to know is who was told no and then didn't pay.
 *
 * Never throws for the caller's benefit — a paywall that produces an error
 * toast because it failed to log itself is worse than not knowing.
 */
export const sawWall = mutation({
  args: { meter: v.union(v.literal("projects"), v.literal("completions"), v.literal("chats")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    const account = await ensureAccount(ctx, owner);
    const now = Date.now();
    const walls = account.walls ?? {
      firstAt: now,
      lastAt: now,
      projects: 0,
      completions: 0,
      chats: 0,
    };
    await ctx.db.patch(account._id, {
      walls: { ...walls, lastAt: now, [args.meter]: walls[args.meter] + 1 },
    });
    return null;
  },
});

/**
 * The caller's own entitlement, subscribed by the app so every wall opens the
 * instant a code is redeemed or a checkout completes — without a reload.
 *
 * Signed out answers `null` — "no answer", not "a spent free plan". The
 * distinction is load-bearing: queries subscribe before Clerk has resolved a
 * token, and a share-link visitor never resolves one at all. A zeroed
 * allowance would have both of them read as somebody who had used everything
 * up, and the app would draw walls at people who are not even signed in.
 */
export const mine = query({
  args: {},
  handler: async (ctx): Promise<Entitlement | null> => {
    const owner = await currentOwner(ctx);
    return owner ? await entitlementOf(ctx, owner) : null;
  },
});
