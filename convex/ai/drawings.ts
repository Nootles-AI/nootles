import { internal } from "../_generated/api";
import { internalMutation, mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { requireOwner } from "../auth";

/**
 * The draw tool's holding pen — see the schema note on `drawings`.
 *
 * `put` is called by the chat route as the user (the draw tool executes
 * server-side, and its ConvexHttpClient carries the session), and `get` by the
 * browser when `edit_page` redeems refs. Both sides key on the owner as well
 * as the ref: a ref is a capability only within the account that drew it.
 */
export const put = mutation({
  args: { ref: v.string(), data: v.string() },
  handler: async (ctx, args) => {
    const ownerId = await requireOwner(ctx);
    // Upsert: the ref is the brief's fingerprint, so a redraw of the same
    // brief is the same row — the newest rendering wins, never a duplicate.
    const existing = await ctx.db
      .query("drawings")
      .withIndex("by_owner_and_ref", (q) => q.eq("ownerId", ownerId).eq("ref", args.ref))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { data: args.data, createdAt: Date.now() });
    } else {
      await ctx.db.insert("drawings", {
        ownerId,
        ref: args.ref,
        data: args.data,
        createdAt: Date.now(),
      });
    }
    return null;
  },
});

export const get = query({
  args: { refs: v.array(v.string()) },
  handler: async (ctx, args) => {
    const ownerId = await requireOwner(ctx);
    const out: Record<string, string> = {};
    for (const ref of args.refs.slice(0, 64)) {
      const row = await ctx.db
        .query("drawings")
        .withIndex("by_owner_and_ref", (q) => q.eq("ownerId", ownerId).eq("ref", ref))
        .unique();
      if (row) out[ref] = row.data;
    }
    return out;
  },
});

/**
 * A drawing either got placed — in which case the document holds it and the
 * row is scaffolding — or the turn moved on without it. A day is far past
 * either story's end.
 */
/**
 * What one sweep may read. A drawing is ~100KB of path data and a delete
 * re-reads the row it removes, so a sweep counted in ROWS — 256 of them — is
 * a transaction past the platform's read ceiling, which is a sweep that never
 * completes and a table that only grows. Counted in bytes instead, with the
 * rest left to a pass scheduled behind this one.
 */
const PURGE_BYTES = 4 * 1024 * 1024;

export const purgeStale = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let bytes = 0;
    let purged = 0;
    for await (const row of ctx.db
      .query("drawings")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))) {
      await ctx.db.delete(row._id);
      purged++;
      bytes += row.data.length;
      if (bytes >= PURGE_BYTES) {
        await ctx.scheduler.runAfter(0, internal.ai.drawings.purgeStale, {});
        break;
      }
    }
    return purged;
  },
});
