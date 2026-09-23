import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { ownerId as currentOwner, requireOwner } from "./auth";

/**
 * The account's own row. One per owner; its absence is what first run reads as
 * "new account", so nothing creates one speculatively — it is written when the
 * survey finishes or when the user skips out of it, and never before.
 */

async function mine(ctx: QueryCtx) {
  const owner = await currentOwner(ctx);
  if (!owner) return null;
  return await ctx.db
    .query("profiles")
    .withIndex("by_owner", (q) => q.eq("ownerId", owner))
    .unique();
}

export const get = query({
  args: {},
  handler: async (ctx) => await mine(ctx),
});

/**
 * What to call someone to the people they work with. `identities` is what
 * Clerk last vouched for; the profile's copy is the fallback, for an account
 * whose sign-in has not been confirmed since that table began.
 */
export async function personOf(ctx: QueryCtx, ownerId: string) {
  const [profile, identity] = await Promise.all([
    ctx.db
      .query("profiles")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique(),
    ctx.db
      .query("identities")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique(),
  ]);
  return {
    name: identity?.name ?? profile?.name ?? null,
    email: identity?.verifiedEmail ?? profile?.email ?? null,
    imageUrl: identity?.imageUrl ?? profile?.imageUrl ?? null,
  };
}

/**
 * Writes the row if it is missing so every later call can assume one. Returns
 * it, because callers that just created it need the id.
 */
async function ensure(ctx: MutationCtx) {
  const existing = await mine(ctx);
  if (existing) return existing;
  const ownerId = await requireOwner(ctx);
  const id = await ctx.db.insert("profiles", {
    ownerId,
    status: "surveying",
    createdAt: Date.now(),
  });
  return (await ctx.db.get(id))!;
}

/**
 * The row for an account whose first act is arriving through someone else's
 * door — a share link, an invitation, a join domain. The survey-and-seed
 * welcome is for people starting from nothing, so the row lands in the same
 * terminal state as declining the guided start. An account already
 * mid-survey keeps its own state; arriving is not an answer to the survey.
 *
 * The founder's letter is retired on the same row and for the same reason: it
 * asks the reader to report what they think of Nootles, and someone who came
 * here for one team's or one person's work has not met it yet.
 */
export async function ensureArrivalProfile(ctx: MutationCtx, ownerId: string) {
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique();
  if (profile) return;
  const now = Date.now();
  await ctx.db.insert("profiles", {
    ownerId,
    status: "skipped",
    hints: ["tester-note"],
    createdAt: now,
    completedAt: now,
  });
}

/**
 * Leaving first run from the welcome screen.
 *
 * Terminal on purpose: someone who declined the guided start once should not
 * meet it again on their next visit.
 */
export const skip = mutation({
  args: {},
  handler: async (ctx) => {
    const row = await ensure(ctx);
    await ctx.db.patch(row._id, { status: "skipped", completedAt: Date.now() });
  },
});

/**
 * A first-touch hint's lesson was demonstrated, so the hint is over.
 *
 * Append-only and idempotent: a hint that died stays dead, and the optimistic
 * update on the client may race a second call in before the first lands.
 */
export const seen = mutation({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const row = await ensure(ctx);
    const hints = row.hints ?? [];
    if (hints.includes(args.id)) return;
    await ctx.db.patch(row._id, { hints: [...hints, args.id] });
  },
});
