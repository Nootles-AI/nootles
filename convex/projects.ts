import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getOwnerId } from "./auth";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await getOwnerId(ctx);
    return await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .collect();
  },
});

export const create = mutation({
  args: { title: v.string(), description: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const ownerId = await getOwnerId(ctx);
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      ownerId,
      title: args.title,
      description: args.description,
      createdAt: now,
    });
    // Seed one page so a new project is immediately usable. Empty title so the
    // doc shows its placeholder; the sidebar renders an "Untitled" fallback.
    await ctx.db.insert("pages", {
      ownerId,
      projectId,
      title: "",
      order: 0,
      docId: crypto.randomUUID(),
      createdAt: now,
    });
    return projectId;
  },
});
