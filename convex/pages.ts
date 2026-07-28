import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getOwnerId } from "./auth";

export const listByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("pages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

export const get = query({
  args: { pageId: v.id("pages") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.pageId);
  },
});

export const create = mutation({
  args: { projectId: v.id("projects"), title: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const ownerId = await getOwnerId(ctx);
    // Append after the current last page.
    const siblings = await ctx.db
      .query("pages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const order = siblings.reduce((m, p) => Math.max(m, p.order + 1), 0);
    return await ctx.db.insert("pages", {
      ownerId,
      projectId: args.projectId,
      // Empty by default so the doc shows its grayed "Untitled" placeholder;
      // the sidebar renders an "Untitled" fallback for empty titles.
      title: args.title ?? "",
      order,
      docId: crypto.randomUUID(),
      createdAt: Date.now(),
    });
  },
});

export const setMode = mutation({
  args: {
    pageId: v.id("pages"),
    mode: v.union(v.literal("compose"), v.literal("transcribe")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.pageId, { mode: args.mode });
  },
});

export const rename = mutation({
  args: { pageId: v.id("pages"), title: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.pageId, { title: args.title });
  },
});
