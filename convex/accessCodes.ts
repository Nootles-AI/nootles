import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireOwner } from "./auth";

/**
 * Free-access codes, from the holder's side. Creating and managing them is the
 * operator's job and lives in `adminBilling.ts`.
 *
 * Deliberately not Stripe's promotion codes: those reduce a price, and this is
 * the case where no money moves at all — a friend, a reviewer, a support
 * apology — which Stripe has no representation for. Discount codes ARE Stripe's
 * and are typed into its checkout, not here.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type CodeRefusalReason =
  /** No such code. Also what a blank or punctuation-only entry gets. */
  | "unknown"
  /** Withdrawn by the operator. */
  | "disabled"
  /** The code's own window has closed. */
  | "expired"
  /** Its redemptions are all taken. */
  | "exhausted"
  /** This account has had it before. One per person, spent or not. */
  | "already";

export type CodeRefusal = { code: "accessCode"; reason: CodeRefusalReason };

/**
 * `ConvexError` so the sentence survives production redaction, and structured
 * so the field can say which of the five things went wrong — "that code doesn't
 * exist" and "you've already used that one" call for different next steps.
 */
function refuse(reason: CodeRefusalReason): ConvexError<CodeRefusal> {
  return new ConvexError({ code: "accessCode", reason });
}

/** True when `e` is a refusal from this module. */
export function isCodeRefusal(e: unknown): e is ConvexError<CodeRefusal> {
  return (
    e instanceof ConvexError &&
    typeof e.data === "object" &&
    e.data !== null &&
    (e.data as { code?: unknown }).code === "accessCode"
  );
}

/**
 * The form a code is stored and compared in: letters and digits, uppercased.
 *
 * Everything else is dropped, so `nootles-2026`, `NOOTLES 2026` and
 * `Nootles2026` are one code. People retype these off a screenshot or a DM,
 * and a hyphen they did or didn't copy is not a reason to turn them away.
 */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Takes a code for this account.
 *
 * One redemption per person per code, whether or not the grant it gave has
 * since lapsed — otherwise a "one month free" code is an unlimited
 * subscription to anyone who remembers to retype it.
 *
 * The grant's expiry is computed here and stored on the redemption rather than
 * being derived from the code later, so shortening a code afterwards cannot
 * retroactively cut short access somebody is already holding.
 */
export const redeem = mutation({
  args: { code: v.string() },
  returns: v.object({ expiresAt: v.optional(v.number()) }),
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    const code = normalizeCode(args.code);
    if (!code) throw refuse("unknown");

    const row = await ctx.db
      .query("accessCodes")
      .withIndex("by_code", (q) => q.eq("code", code))
      .unique();
    if (!row) throw refuse("unknown");
    if (row.disabledAt !== undefined) throw refuse("disabled");

    const now = Date.now();
    if (row.expiresAt !== undefined && row.expiresAt <= now) throw refuse("expired");

    // Asked before the cap, so somebody retyping their own code is told what
    // actually happened rather than that the code ran out.
    const mine = await ctx.db
      .query("codeRedemptions")
      .withIndex("by_owner_and_code", (q) =>
        q.eq("ownerId", owner).eq("codeId", row._id),
      )
      .unique();
    if (mine) throw refuse("already");

    if (row.maxRedemptions !== undefined && row.redemptions >= row.maxRedemptions) {
      throw refuse("exhausted");
    }

    const expiresAt =
      row.durationDays === undefined ? undefined : now + row.durationDays * DAY_MS;
    await ctx.db.insert("codeRedemptions", {
      codeId: row._id,
      ownerId: owner,
      redeemedAt: now,
      expiresAt,
    });
    await ctx.db.patch(row._id, { redemptions: row.redemptions + 1 });
    return { expiresAt };
  },
});
