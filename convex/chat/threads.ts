import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import {
  ownerId as currentOwner,
  projectRole,
  readOwned,
  requireEditable,
  requireOwned,
  requireOwner,
} from "../auth";

/**
 * Chat threads, scoped to a project but personal to their author: each
 * person's AI is their own, so a shared project holds one set of threads per
 * collaborator and nobody reads anyone else's.
 *
 * A thread is the unit the user switches between in the chat list, and it
 * outlives switching pages — the agent may open several pages inside one turn,
 * so binding a conversation to a page would cut it in half.
 */

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const me = await currentOwner(ctx);
    if (!me) return [];
    const role = await projectRole(ctx, args.projectId);
    if (role !== "owner" && role !== "editor") return [];
    const rows = await ctx.db
      .query("chatThreads")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .collect();
    return rows.filter((t) => t.ownerId === me);
  },
});

export const get = query({
  args: { threadId: v.id("chatThreads") },
  handler: async (ctx, args) => await readOwned(ctx, "chatThreads", args.threadId),
});

export const create = mutation({
  args: { projectId: v.id("projects"), title: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireEditable(ctx, "projects", args.projectId);
    // The thread belongs to its author, not the project's owner — unlike pages,
    // a conversation is personal, and `readOwned` on it is what keeps an
    // editor's chat invisible to everyone else.
    const ownerId = await requireOwner(ctx);
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
    await requireOwned(ctx, "chatThreads", args.threadId);
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
    await requireOwned(ctx, "chatThreads", args.threadId);
    await ctx.db.patch(args.threadId, { updatedAt: Date.now() });
  },
});

/**
 * Deletes a thread and its messages.
 *
 * Checkpoints and op-log rows are deliberately NOT deleted: they belong to the
 * page's history, not the conversation's, and the document still reflects the
 * edits a deleted thread made.
 *
 * Neither is a turn the user has not answered yet. Its changes are already in
 * the document — they were applied for real — so deleting the row would leave
 * the page changed with the diff gone and no way left to say no. The review is
 * found by project rather than by thread, so an orphaned turn still resolves;
 * once answered, it is swept with everything else.
 */
export const remove = mutation({
  args: { threadId: v.id("chatThreads") },
  handler: async (ctx, args) => {
    await requireOwned(ctx, "chatThreads", args.threadId);
    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();
    await Promise.all(messages.map((m) => ctx.db.delete(m._id)));

    const turns = await ctx.db
      .query("chatTurns")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();
    const settled = turns.filter(
      (t) => t.status !== "pending" && t.status !== "streaming",
    );
    await Promise.all(settled.map((t) => ctx.db.delete(t._id)));

    await ctx.db.delete(args.threadId);
  },
});
