import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { readOwned, readVisible, requireEditable, requireOwner } from "../auth";

/**
 * Checkpoints — full snapshots for Cursor-style rewind, taken just before an AI
 * turn (keyed by chatPromptId). Because the canvas lives inside the block flow
 * (`props.data`), a snapshot of the BlockNote document captures both surfaces;
 * `canvasSnapshot` is kept for a future normalized-canvas model and is null now.
 *
 * Restore is performed client-side: fetch a snapshot and `editor.replaceBlocks`.
 */

export const create = mutation({
  args: {
    pageId: v.id("pages"),
    chatPromptId: v.string(),
    docSnapshot: v.any(),
    canvasSnapshot: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await requireEditable(ctx, "pages", args.pageId);
    // A checkpoint belongs to whoever asked for the turn, not to the page's
    // owner: it is the "before" of THEIR review, and `get`'s row-ownership
    // check is what keeps one collaborator's rewind out of another's hands.
    const ownerId = await requireOwner(ctx);
    return await ctx.db.insert("checkpoints", {
      ownerId,
      pageId: args.pageId,
      chatPromptId: args.chatPromptId,
      docSnapshot: args.docSnapshot,
      canvasSnapshot: args.canvasSnapshot ?? null,
      createdAt: Date.now(),
    });
  },
});

export const list = query({
  args: { pageId: v.id("pages"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await readVisible(ctx, "pages", args.pageId))) return [];
    const rows = await ctx.db
      .query("checkpoints")
      .withIndex("by_page", (q) => q.eq("pageId", args.pageId))
      .order("desc")
      .take(args.limit ?? 50);
    return rows.reverse();
  },
});

export const get = query({
  args: { id: v.id("checkpoints") },
  handler: async (ctx, args) => await readOwned(ctx, "checkpoints", args.id),
});
