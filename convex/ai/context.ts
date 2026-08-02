import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { readOwned, requireOwned } from "../auth";

/**
 * The per-project Context Sheet — an evolving list of Q&A that primes every LLM
 * request. Entries are human-added or AI-generated; answers can be filled in
 * later (a model may ask, then answer once it learns).
 */

const source = v.union(v.literal("human"), v.literal("ai"));

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    if (!(await readOwned(ctx, "projects", args.projectId))) return [];
    return await ctx.db
      .query("contextSheet")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

export const add = mutation({
  args: {
    projectId: v.id("projects"),
    question: v.string(),
    answer: v.optional(v.string()),
    source,
  },
  handler: async (ctx, args) => {
    const { ownerId } = await requireOwned(ctx, "projects", args.projectId);
    return await ctx.db.insert("contextSheet", {
      ownerId,
      projectId: args.projectId,
      question: args.question,
      answer: args.answer,
      source: args.source,
      createdAt: Date.now(),
    });
  },
});

export const answer = mutation({
  args: { id: v.id("contextSheet"), answer: v.string() },
  handler: async (ctx, args) => {
    await requireOwned(ctx, "contextSheet", args.id);
    await ctx.db.patch(args.id, { answer: args.answer });
  },
});

export const remove = mutation({
  args: { id: v.id("contextSheet") },
  handler: async (ctx, args) => {
    await requireOwned(ctx, "contextSheet", args.id);
    await ctx.db.delete(args.id);
  },
});
