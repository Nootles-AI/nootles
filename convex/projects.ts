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

/** Projects plus the page count the management screen shows per row. */
export const listWithCounts = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await getOwnerId(ctx);
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .collect();
    return await Promise.all(
      projects.map(async (p) => {
        const pages = await ctx.db
          .query("pages")
          .withIndex("by_project", (q) => q.eq("projectId", p._id))
          .collect();
        return {
          ...p,
          pageCount: pages.length,
          updatedAt: pages.reduce((m, pg) => Math.max(m, pg.createdAt), p.createdAt),
        };
      }),
    );
  },
});

export const rename = mutation({
  args: { projectId: v.id("projects"), title: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.projectId, { title: args.title });
  },
});

/**
 * Deletes a project and everything hanging off it. The hierarchy is bounded
 * (project → page → canvas → shape/edge) so this terminates, but it is a lot of
 * rows: a very large project could approach Convex's per-mutation write limit,
 * at which point this needs to become a paginated action.
 *
 * Irreversible — the UI asks for confirmation before calling it.
 */
export const remove = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    for (const page of pages) {
      const canvases = await ctx.db
        .query("canvases")
        .withIndex("by_page", (q) => q.eq("pageId", page._id))
        .collect();
      for (const canvas of canvases) {
        for (const table of ["shapes", "edges"] as const) {
          const rows = await ctx.db
            .query(table)
            .withIndex("by_canvas", (q) => q.eq("canvasId", canvas._id))
            .collect();
          await Promise.all(rows.map((r) => ctx.db.delete(r._id)));
        }
        await ctx.db.delete(canvas._id);
      }

      for (const table of ["opLog", "checkpoints", "suggestionLog"] as const) {
        const rows = await ctx.db
          .query(table)
          .withIndex("by_page", (q) => q.eq("pageId", page._id))
          .collect();
        await Promise.all(rows.map((r) => ctx.db.delete(r._id)));
      }

      await ctx.db.delete(page._id);
    }

    const sheet = await ctx.db
      .query("contextSheet")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    await Promise.all(sheet.map((r) => ctx.db.delete(r._id)));

    await ctx.db.delete(args.projectId);
  },
});
