import { ConvexError, v } from "convex/values";
import { requireAdmin } from "./admin";
import { standInActor } from "./auth";
import { internalMutation, query } from "./_generated/server";

/**
 * Operator stand-in sessions: the founder looking at the app through a user's
 * account, to see the bug they are describing.
 *
 * Three pieces, and this file is the ledger between them. `impersonationMint.ts`
 * signs the token (Node runtime, hence the split), `http.ts` publishes the key
 * that verifies it, and the write gates in `auth.ts` refuse everything it asks
 * for beyond reading. What is left here is the part that decides WHETHER: an
 * operator session, a real user, a reason, and a row saying it happened.
 *
 * The session is read-only by construction, not by policy — see `auth.ts`.
 */

/**
 * How long a stand-in lasts. Long enough to reproduce something, short enough
 * that expiry is a sufficient answer to "how do I end one" — there is no
 * revocation, because the token is verified by signature and never read back
 * against this table.
 */
export const SESSION_MS = 30 * 60 * 1000;

/**
 * Records the intent and hands back what the token will say.
 *
 * Internal, and a mutation rather than part of the action, so the audit row and
 * the checks that justify it commit together: an action that crashed after
 * writing would still have written, and one that signed before writing could
 * mint a session no row remembers.
 */
export const begin = internalMutation({
  args: { token: v.string(), subject: v.string(), reason: v.string() },
  returns: v.object({
    jti: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
  }),
  handler: async (ctx, args) => {
    const session = await requireAdmin(ctx, args.token);
    const reason = args.reason.trim();
    // ConvexError throughout: a production deployment redacts a plain Error's
    // message, and every failure here is one an operator can fix if only they
    // are told which one it is.
    if (reason.length < 3) throw new ConvexError("A reason is required.");
    // A subject with no profile is a typo, and a typo would mint a working
    // token for a tenant that owns nothing — every screen empty, and half an
    // hour spent debugging the wrong thing.
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.subject))
      .unique();
    if (!profile) throw new ConvexError("No account on file under that id.");
    const issuedAt = Date.now();
    const expiresAt = issuedAt + SESSION_MS;
    const jti = await ctx.db.insert("impersonations", {
      adminSessionId: session._id,
      subject: args.subject,
      reason,
      issuedAt,
      expiresAt,
    });
    return { jti, issuedAt, expiresAt };
  },
});

/**
 * The id as a person-sized handle. The same form the ops dashboard's
 * `shortUser` shows, so a nameless account reads identically on both ends —
 * an operator should not have to match a 32-character string by eye to know
 * they landed on the account they clicked.
 */
function shortSubject(subject: string): string {
  return subject.replace(/^user_/, "").slice(0, 8);
}

/**
 * Whose account this session is looking at, or null when it is your own.
 *
 * Runs as the stood-in identity, so it reads their profile the ordinary way.
 * The app asks this to draw the banner — the token itself is what the server
 * believes, and nothing here is trusted for access.
 *
 * `label` is the single answer to "who is this", resolved here rather than in
 * the banner so there is one ordering to change. `.trim() ||` rather than
 * `??`: a profile stamped with an empty string is as nameless as one never
 * stamped at all, and `??` would put that empty string in the banner.
 */
export const current = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      subject: v.string(),
      actor: v.string(),
      label: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    const actor = await standInActor(ctx);
    if (!identity || !actor) return null;
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_owner", (q) => q.eq("ownerId", identity.subject))
      .unique();
    return {
      subject: identity.subject,
      actor,
      label:
        profile?.name?.trim() ||
        profile?.email?.trim() ||
        shortSubject(identity.subject),
    };
  },
});

/** The log, newest first — the ops dashboard's account of itself. */
export const history = query({
  args: { token: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const rows = await ctx.db
      .query("impersonations")
      .order("desc")
      .take(Math.min(args.limit ?? 50, 200));
    return await Promise.all(
      rows.map(async (row) => {
        const profile = await ctx.db
          .query("profiles")
          .withIndex("by_owner", (q) => q.eq("ownerId", row.subject))
          .unique();
        return { ...row, email: profile?.email ?? null };
      }),
    );
  },
});
