import { internalMutation, mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { readOwned, readVisible, requireEditable, requireOwner } from "../auth";

/**
 * Checkpoints — full snapshots for Cursor-style rewind, taken just before an AI
 * turn (keyed by chatPromptId). Because a diagram lives inside the block flow
 * (`props.data`), a snapshot of the BlockNote document captures both surfaces.
 *
 * Restore is performed client-side: fetch a snapshot and `editor.replaceBlocks`.
 */

export const create = mutation({
  args: {
    pageId: v.id("pages"),
    chatPromptId: v.string(),
    docSnapshot: v.any(),
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
      createdAt: Date.now(),
    });
  },
});

/**
 * The history, without the history's weight: a row is a whole packed document,
 * and a list of fifty of them is fifty documents down the wire on every change.
 * Callers render labels from this and fetch the one snapshot they restore
 * through `get`.
 */
export const list = query({
  args: { pageId: v.id("pages"), limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      _id: v.id("checkpoints"),
      chatPromptId: v.string(),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    if (!(await readVisible(ctx, "pages", args.pageId))) return [];
    const rows = await ctx.db
      .query("checkpoints")
      .withIndex("by_page", (q) => q.eq("pageId", args.pageId))
      .order("desc")
      .take(args.limit ?? 50);
    return rows.reverse().map((row) => ({
      _id: row._id,
      chatPromptId: row.chatPromptId,
      createdAt: row.createdAt,
    }));
  },
});

/**
 * A checkpoint is the "before" of one review, and a review is answered in
 * minutes. Past the window where a rewind is still meaningful it is a full
 * packed document kept forever for nobody.
 */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** Small: each row is a whole document, so a big bite is a dead transaction. */
const PURGE_BATCH = 32;

export const purgeOld = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const stale = await ctx.db
      .query("checkpoints")
      .withIndex("by_creation_time", (q) =>
        q.lt("_creationTime", Date.now() - KEEP_MS),
      )
      .take(PURGE_BATCH);
    await Promise.all(stale.map((row) => ctx.db.delete(row._id)));
    return stale.length;
  },
});

export const get = query({
  args: { id: v.id("checkpoints") },
  handler: async (ctx, args) => await readOwned(ctx, "checkpoints", args.id),
});
