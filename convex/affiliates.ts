import { v, type Infer } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  ATTRIBUTION_WINDOW_MS,
  DEFAULT_DESTINATION,
  NEW_ACCOUNT_TOLERANCE_MS,
  clickSecret,
  dayKey,
  isAllowedDestination,
  isVisitorId,
  normalizeAffiliateSlug,
  parseRef,
  verifyClick,
} from "./affiliateRules";
import { requireOwner } from "./auth";

/**
 * Affiliate links: counting the clicks on `/r/<slug>`, and deciding which
 * affiliate — if any — brought an account. Measurement only. The operator's
 * side (creating links, the stats) is in `adminBilling.ts`; the rules both
 * sides and the Next route share are in `affiliateRules.ts`.
 */

/**
 * How far a click's signature may sit from our clock. Behind covers a slow
 * route; ahead, a clock running fast. The same bounds as the ledger's.
 */
const SIGNED_BEHIND_MS = 10 * 60_000;
const SIGNED_AHEAD_MS = 60_000;

async function affiliateBySlug(ctx: QueryCtx, slug: string) {
  return await ctx.db
    .query("affiliates")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .first();
}

function destinationOf(affiliate: Doc<"affiliates"> | null): string {
  return affiliate && !affiliate.disabledAt && isAllowedDestination(affiliate.destination)
    ? affiliate.destination
    : DEFAULT_DESTINATION;
}

/**
 * A click on an affiliate's link, from the `/r/<slug>` route: where to send
 * the visitor, and — when the route signed it — one more click counted.
 * `counted` says which, so the route moves the visitor's `nt_ref` cookie only
 * for a click that can later be attributed, and never lets one that cannot
 * (a disabled link, a mismatched secret) replace one that can.
 *
 * Public because the route calls it signed out, before anyone has an account.
 * That is why it needs the signature: only the Next server holds
 * `AFFILIATE_CLICK_SECRET`, so a call from anywhere else cannot inflate a
 * link's numbers. It never throws for any of that, because a visitor whose
 * click did not count must still land somewhere; it answers the destination
 * whatever happens, and logs why nothing was recorded. (It can still fail as
 * any mutation can — a burst of clicks contends on one `affiliateDays` row —
 * so the route falls back to the default destination on an error.)
 *
 * The signature is over the normalized slug, so the route may pass the path
 * segment as typed.
 *
 * `affiliateDays.visitors` counts a visitor once per day: on their first click
 * for this affiliate, or their first since the UTC day turned. Their visit's
 * `lastAt` still holds the previous click when this one lands, which is how
 * that is known without another row. The link's all-time totals go to
 * `affiliateTotals`; the affiliate's own row is never written here, since
 * every attribution reads it.
 */
export const recordClick = mutation({
  args: {
    slug: v.string(),
    visitorId: v.string(),
    signedAt: v.number(),
    signature: v.string(),
  },
  returns: v.object({ destination: v.string(), counted: v.boolean() }),
  handler: async (ctx, args) => {
    const slug = normalizeAffiliateSlug(args.slug);
    const affiliate = slug ? await affiliateBySlug(ctx, slug) : null;
    const destination = destinationOf(affiliate);
    if (!affiliate || affiliate.disabledAt) return { destination, counted: false };

    const secret = clickSecret(process.env.AFFILIATE_CLICK_SECRET);
    const now = Date.now();
    let refused: string | undefined;
    if (!secret) refused = "no secret on this deployment";
    else if (!isVisitorId(args.visitorId)) refused = "visitor id is not a UUID";
    else if (
      !Number.isFinite(args.signedAt) ||
      args.signedAt < now - SIGNED_BEHIND_MS ||
      args.signedAt > now + SIGNED_AHEAD_MS
    ) {
      refused = "signature stale";
    } else if (
      !(await verifyClick(
        secret,
        { slug: affiliate.slug, visitorId: args.visitorId, signedAt: args.signedAt },
        args.signature,
      ))
    ) {
      refused = "signature invalid";
    }
    if (refused) {
      console.warn(`[affiliates] click on ${affiliate.slug} not counted: ${refused}`);
      return { destination, counted: false };
    }

    const today = dayKey(now);
    const visit = await ctx.db
      .query("affiliateVisits")
      .withIndex("by_affiliate_and_visitor", (q) =>
        q.eq("affiliateId", affiliate._id).eq("visitorId", args.visitorId),
      )
      .unique();
    const newToday = !visit || dayKey(visit.lastAt) !== today;
    if (visit) {
      await ctx.db.patch(visit._id, { clicks: visit.clicks + 1, lastAt: now });
    } else {
      await ctx.db.insert("affiliateVisits", {
        affiliateId: affiliate._id,
        visitorId: args.visitorId,
        firstAt: now,
        lastAt: now,
        clicks: 1,
      });
    }

    const day = await ctx.db
      .query("affiliateDays")
      .withIndex("by_affiliate_and_day", (q) =>
        q.eq("affiliateId", affiliate._id).eq("day", today),
      )
      .unique();
    if (day) {
      await ctx.db.patch(day._id, {
        clicks: day.clicks + 1,
        visitors: day.visitors + (newToday ? 1 : 0),
      });
    } else {
      await ctx.db.insert("affiliateDays", {
        affiliateId: affiliate._id,
        day: today,
        clicks: 1,
        visitors: 1,
      });
    }

    const totals = await ctx.db
      .query("affiliateTotals")
      .withIndex("by_affiliate", (q) => q.eq("affiliateId", affiliate._id))
      .unique();
    if (totals) {
      await ctx.db.patch(totals._id, {
        clicks: totals.clicks + 1,
        visitors: totals.visitors + (visit ? 0 : 1),
      });
    } else {
      await ctx.db.insert("affiliateTotals", { affiliateId: affiliate._id, clicks: 1, visitors: 1 });
    }
    return { destination, counted: true };
  },
});

const outcome = v.object({
  status: v.union(v.literal("attributed"), v.literal("already"), v.literal("ignored")),
  affiliate: v.union(v.string(), v.null()),
  reason: v.optional(v.string()),
});

type Outcome = Infer<typeof outcome>;

const ignored = (reason: string): Outcome => ({ status: "ignored", affiliate: null, reason });

async function attributionOf(ctx: QueryCtx, ownerId: string) {
  return await ctx.db
    .query("affiliateAttributions")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .first();
}

/** "already", naming the affiliate an account was attributed to — or null if it was not. */
async function alreadyAttributed(ctx: QueryCtx, ownerId: string): Promise<Outcome | null> {
  const existing = await attributionOf(ctx, ownerId);
  if (!existing) return null;
  const affiliate = await ctx.db.get(existing.affiliateId);
  return { status: "already", affiliate: affiliate?.slug ?? null };
}

/**
 * When the server first saw this account, or null if it never has: the
 * earliest `_creationTime` among the rows an account leaves behind as it
 * arrives — its identity stamp, its profile, its billing row, a redeemed code,
 * a personal project. Each index orders an owner's rows by creation, so the
 * first of each is that table's earliest.
 *
 * Read off the rows rather than asked of Clerk, because the question is
 * whether this account had been using Nootles before the click, and a row is
 * the evidence of that.
 */
async function firstSeen(ctx: QueryCtx, ownerId: string): Promise<number | null> {
  const firsts = await Promise.all([
    ctx.db.query("identities").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).first(),
    ctx.db.query("profiles").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).first(),
    ctx.db.query("billingAccounts").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).first(),
    ctx.db.query("codeRedemptions").withIndex("by_owner", (q) => q.eq("ownerId", ownerId)).first(),
    // Personal projects only: a workspace project passes to an heir when its
    // creator leaves (`members.ts`), and would make a new heir look old.
    ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .filter((q) => q.eq(q.field("workspaceId"), undefined))
      .first(),
  ]);
  const times = firsts.flatMap((row) => (row ? [row._creationTime] : []));
  return times.length ? Math.min(...times) : null;
}

/**
 * Claims the signed-in account for the affiliate whose link it arrived by,
 * from the `nt_ref` cookie the route left. The app calls it whenever that
 * cookie is present and clears the cookie afterwards, so it is idempotent and
 * refusing is routine: `ignored` says why, and nothing throws but the write
 * gate itself, which refuses an operator standing in as it does everywhere.
 *
 * Only a NEW account is attributed. "New" is measured against this visitor's
 * first click for the affiliate: the account's first server-side trace
 * (`firstSeen`) may be no more than `NEW_ACCOUNT_TOLERANCE_MS` older than
 * it. That is what lets someone who arrived through a share link — whose
 * profile `share.claim` writes before this runs — still count, while someone
 * who was already here and later clicks a link does not.
 *
 * The cookie only names the visit; every date is read off the visit row. Last
 * click wins because the route rewrites the cookie on every click, and an
 * attribution, once written, is never replaced.
 */
export const attribute = mutation({
  args: { ref: v.string() },
  returns: outcome,
  handler: async (ctx, args): Promise<Outcome> => {
    const ownerId = await requireOwner(ctx);
    const already = await alreadyAttributed(ctx, ownerId);
    if (already) return already;

    const ref = parseRef(args.ref);
    if (!ref) return ignored("malformed");
    const affiliate = await affiliateBySlug(ctx, ref.slug);
    if (!affiliate) return ignored("unknown affiliate");
    if (affiliate.disabledAt) return ignored("disabled");
    if (affiliate.ownerId === ownerId) return ignored("self-referral");

    const visit = await ctx.db
      .query("affiliateVisits")
      .withIndex("by_affiliate_and_visitor", (q) =>
        q.eq("affiliateId", affiliate._id).eq("visitorId", ref.visitorId),
      )
      .unique();
    if (!visit) return ignored("no such visit");
    const now = Date.now();
    if (visit.lastAt < now - ATTRIBUTION_WINDOW_MS) return ignored("expired");

    const seen = await firstSeen(ctx, ownerId);
    if (seen !== null && seen < visit.firstAt - NEW_ACCOUNT_TOLERANCE_MS) {
      return ignored("existing account");
    }

    await ctx.db.insert("affiliateAttributions", {
      ownerId,
      affiliateId: affiliate._id,
      visitorId: visit.visitorId,
      clickedAt: visit.lastAt,
      attributedAt: now,
      via: "link",
    });
    await countSignup(ctx, affiliate);
    return { status: "attributed", affiliate: affiliate.slug };
  },
});

async function countSignup(ctx: MutationCtx, affiliate: Doc<"affiliates">) {
  await ctx.db.patch(affiliate._id, { signups: (affiliate.signups ?? 0) + 1 });
}

/** The slug of the affiliate an account is attributed to, for checkout's metadata. */
export const slugFor = internalQuery({
  args: { ownerId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const attribution = await attributionOf(ctx, args.ownerId);
    const affiliate = attribution && (await ctx.db.get(attribution.affiliateId));
    return affiliate?.slug ?? null;
  },
});

/**
 * Claims an account for the affiliate whose Stripe promotion code its
 * completed checkout used, at `at`. For people who typed a code and never
 * clicked a link, so it yields to any attribution already made; and it counts
 * only an account first seen within the attribution window before that
 * checkout, since a code redeemed by an old customer is a discount, not a
 * referral.
 */
export const attributeByCode = internalMutation({
  args: { ownerId: v.string(), promotionCodeId: v.string(), at: v.number() },
  returns: outcome,
  handler: async (ctx, args): Promise<Outcome> => {
    const already = await alreadyAttributed(ctx, args.ownerId);
    if (already) return already;

    const affiliate = await affiliateByPromotionCode(ctx, args.promotionCodeId);
    if (!affiliate) return ignored("no affiliate for that code");
    if (affiliate.ownerId === args.ownerId) return ignored("self-referral");

    const seen = await firstSeen(ctx, args.ownerId);
    if (seen !== null && seen < args.at - ATTRIBUTION_WINDOW_MS) {
      return ignored("existing account");
    }

    await ctx.db.insert("affiliateAttributions", {
      ownerId: args.ownerId,
      affiliateId: affiliate._id,
      attributedAt: Date.now(),
      via: "code",
    });
    await countSignup(ctx, affiliate);
    return { status: "attributed", affiliate: affiliate.slug };
  },
});

/** The enabled affiliate a promotion code is linked to, if any. */
async function affiliateByPromotionCode(
  ctx: QueryCtx,
  promotionCodeId: string,
): Promise<Doc<"affiliates"> | null> {
  for await (const affiliate of ctx.db
    .query("affiliates")
    .withIndex("by_promotion_code_id", (q) => q.eq("promotionCodeId", promotionCodeId))) {
    if (!affiliate.disabledAt) return affiliate;
  }
  return null;
}
