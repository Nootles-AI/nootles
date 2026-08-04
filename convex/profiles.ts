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
 * Leaving first run, from the welcome screen or from the middle of a tour.
 *
 * Terminal on purpose: someone who dismissed the guide once should not meet it
 * again on their next visit. The tour is left on the row rather than cleared,
 * so a "resume the guide" affordance stays possible without a migration.
 */
export const skip = mutation({
  args: {},
  handler: async (ctx) => {
    const row = await ensure(ctx);
    await ctx.db.patch(row._id, { status: "skipped", completedAt: Date.now() });
  },
});

/** Advancing a gated beat. */
export const setBeat = mutation({
  args: { beat: v.number() },
  handler: async (ctx, args) => {
    const row = await ensure(ctx);
    if (!row.tour) return;
    await ctx.db.patch(row._id, { tour: { ...row.tour, beat: args.beat } });
  },
});

/** Ticking one item off the free-tail checklist. */
export const check = mutation({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const row = await ensure(ctx);
    if (!row.tour || row.tour.done.includes(args.id)) return;
    await ctx.db.patch(row._id, {
      tour: { ...row.tour, done: [...row.tour.done, args.id] },
    });
  },
});

export const finish = mutation({
  args: {},
  handler: async (ctx) => {
    const row = await ensure(ctx);
    await ctx.db.patch(row._id, { status: "done", completedAt: Date.now() });
  },
});
