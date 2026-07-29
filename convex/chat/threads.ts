import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { getOwnerId } from "../auth";

/**
 * Chat threads, scoped to a project.
 *
 * A thread is the unit the user switches between in the chat list, and it
 * outlives switching pages — the agent may open several pages inside one turn,
 * so binding a conversation to a page would cut it in half.
 */

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const ownerId = await getOwnerId(ctx);
    return await ctx.db
      .query("chatThreads")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .collect()
      .then((rows) => rows.filter((r) => r.ownerId === ownerId));
  },
});

export const get = query({
  args: { threadId: v.id("chatThreads") },
  handler: async (ctx, args) => await ctx.db.get(args.threadId),
});

export const create = mutation({
  args: { projectId: v.id("projects"), title: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const ownerId = await getOwnerId(ctx);
    const now = Date.now();
    return await ctx.db.insert("chatThreads", {
      ownerId,
      projectId: args.projectId,
      // Empty until the first message names it; the list shows "New chat".
      title: args.title ?? "",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const rename = mutation({
  args: { threadId: v.id("chatThreads"), title: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.threadId, {
      title: args.title,
      updatedAt: Date.now(),
    });
  },
});

/** Bumps a thread to the top of the list without rewriting its title. */
export const touch = mutation({
  args: { threadId: v.id("chatThreads") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.threadId, { updatedAt: Date.now() });
  },
});

/**
 * Deletes a thread and its messages and turns.
 *
 * Checkpoints and op-log rows are deliberately NOT deleted: they belong to the
 * page's history, not the conversation's, and the document still reflects the
 * edits a deleted thread made.
 */
export const remove = mutation({
  args: { threadId: v.id("chatThreads") },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();
    await Promise.all(messages.map((m) => ctx.db.delete(m._id)));

    const turns = await ctx.db
      .query("chatTurns")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();
    await Promise.all(turns.map((t) => ctx.db.delete(t._id)));

    await ctx.db.delete(args.threadId);
  },
});
