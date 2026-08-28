import { internalMutation, internalQuery, mutation } from "../_generated/server";
import { v } from "convex/values";
import { requireOwner } from "../auth";

/**
 * The holding pen for `find_images` — see the schema note on `foundImages`.
 *
 * Written by the chat route as the user (the tool executes server-side, and its
 * ConvexHttpClient carries the session) and read back by the ingest action when
 * an `add` op redeems a ref. The model only ever holds the ref.
 */

const FOUND = {
  ref: v.string(),
  url: v.string(),
  w: v.number(),
  h: v.number(),
  alt: v.string(),
  hex: v.string(),
  credit: v.string(),
  report: v.optional(v.string()),
};

export const put = mutation({
  args: { found: v.array(v.object(FOUND)) },
  handler: async (ctx, args) => {
    const ownerId = await requireOwner(ctx);
    const now = Date.now();
    for (const found of args.found.slice(0, 32)) {
      const existing = await ctx.db
        .query("foundImages")
        .withIndex("by_owner_and_ref", (q) => q.eq("ownerId", ownerId).eq("ref", found.ref))
        .unique();
      if (existing) await ctx.db.patch(existing._id, { ...found, createdAt: now });
      else await ctx.db.insert("foundImages", { ownerId, ...found, createdAt: now });
    }
    return null;
  },
});

/**
 * Internal: only the ingest action reads these, and it must not be possible to
 * ask this for a URL from anywhere a model's words could reach.
 */
export const get = internalQuery({
  args: { ownerId: v.string(), refs: v.array(v.string()) },
  handler: async (ctx, args) => {
    const out = [];
    for (const ref of args.refs.slice(0, 32)) {
      const row = await ctx.db
        .query("foundImages")
        .withIndex("by_owner_and_ref", (q) => q.eq("ownerId", args.ownerId).eq("ref", ref))
        .unique();
      if (row) out.push(row);
    }
    return out;
  },
});

/**
 * A found picture was either added to an album — in which case the document
 * holds a copy in our own storage and the row is scaffolding — or the turn
 * moved on without it. A day is well past either ending.
 */
export const purgeStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const stale = await ctx.db
      .query("foundImages")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .take(256);
    await Promise.all(stale.map((row) => ctx.db.delete(row._id)));
    return stale.length;
  },
});
