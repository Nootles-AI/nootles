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
 * Keeps the profile's email current from the verified identity. Patch-only:
 * a missing row is first run's signal, and this must never fake one.
 */
export const stampEmail = mutation({
  args: {},
  handler: async (ctx) => {
    const row = await mine(ctx);
    if (!row) return;
    const email = (await ctx.auth.getUserIdentity())?.email;
    if (email && row.email !== email) await ctx.db.patch(row._id, { email });
  },
});

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
