import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
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
    identityOf(ctx, ownerId),
  ]);
  return {
    name: identity?.name ?? profile?.name ?? null,
    email: identity?.verifiedEmail ?? profile?.email ?? null,
    imageUrl: identity?.imageUrl ?? profile?.imageUrl ?? null,
  };
}

export async function identityOf(ctx: QueryCtx, ownerId: string) {
  return await ctx.db
    .query("identities")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique();
}

/**
 * The profile's copy of what `identities` holds, for the screens that read
 * the profile. Only what is there: a copy never takes a value off the row.
 *
 * Every profile row is made with it, not just patched by later stamps. The
 * app confirms who someone is on their first signed-in render, before any
 * profile exists, and the next confirmation is a day away — so a row made
 * without it would be faceless for that day, and forever for anyone who
 * never came back.
 */
export function faceOf(
  identity: Pick<Doc<"identities">, "verifiedEmail" | "name" | "imageUrl"> | null,
) {
  return {
    ...(identity?.verifiedEmail && { email: identity.verifiedEmail }),
    ...(identity?.name && { name: identity.name }),
    ...(identity?.imageUrl && { imageUrl: identity.imageUrl }),
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
    ...faceOf(await identityOf(ctx, ownerId)),
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
    ...faceOf(await identityOf(ctx, ownerId)),
    status: "skipped",
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
