import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { readOwned, requireOwned } from "../auth";
import { removeDocument, upsertDocument } from "../context/documents";

/**
 * Notion pages linked to a project as context: the Notion counterpart of a
 * linked repository. The page stays in Notion; `contextRead.run` reads its
 * text into the context graph as a document, with the linker's token, and
 * again whenever it is re-read.
 */

export const listForProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    if (!(await readOwned(ctx, "projects", args.projectId))) return [];
    return await ctx.db
      .query("projectNotion")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

export const link = mutation({
  args: {
    projectId: v.id("projects"),
    pages: v.array(
      v.object({ pageId: v.string(), title: v.string(), emoji: v.optional(v.string()) }),
    ),
  },
  handler: async (ctx, args) => {
    const { ownerId } = await requireOwned(ctx, "projects", args.projectId);
    const now = Date.now();
    const seen = new Set<string>();
    for (const page of args.pages) {
      if (seen.has(page.pageId)) continue;
      seen.add(page.pageId);
      const already = await ctx.db
        .query("projectNotion")
        .withIndex("by_project_and_pageId", (q) =>
          q.eq("projectId", args.projectId).eq("pageId", page.pageId),
        )
        .first();
      if (already) continue;
      const rowId = await ctx.db.insert("projectNotion", {
        ownerId,
        projectId: args.projectId,
        pageId: page.pageId,
        title: page.title,
        ...(page.emoji ? { emoji: page.emoji } : {}),
        url: `https://www.notion.so/${page.pageId.replace(/-/g, "")}`,
        index: { state: "queued" },
        addedAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.notion.contextRead.run, { rowId });
    }
  },
});

export const unlink = mutation({
  args: { rowId: v.id("projectNotion") },
  handler: async (ctx, args) => {
    const row = await requireOwned(ctx, "projectNotion", args.rowId);
    await ctx.db.delete(row._id);
    await removeDocument(ctx, row.projectId, externalIdOf(row.pageId));
  },
});

/** Read the page again. Refused while a read is waiting or running. */
export const reindex = mutation({
  args: { rowId: v.id("projectNotion") },
  handler: async (ctx, args) => {
    const row = await requireOwned(ctx, "projectNotion", args.rowId);
    if (row.index.state === "queued" || row.index.state === "reading") return;
    await ctx.db.patch(row._id, { index: { ...row.index, state: "queued" } });
    await ctx.scheduler.runAfter(0, internal.notion.contextRead.run, { rowId: row._id });
  },
});

// ---- Internal ------------------------------------------------------------

export const row = internalQuery({
  args: { rowId: v.id("projectNotion") },
  handler: async (ctx, args) => await ctx.db.get(args.rowId),
});

export const setIndex = internalMutation({
  args: {
    rowId: v.id("projectNotion"),
    index: v.object({
      state: v.union(
        v.literal("queued"),
        v.literal("reading"),
        v.literal("ready"),
        v.literal("failed"),
      ),
      error: v.optional(v.string()),
      at: v.optional(v.number()),
      chars: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.rowId);
    if (!row) return;
    // A failure keeps the last good read's facts: the document it wrote is
    // still in the graph, and the row should say so while it says why the
    // refresh did not land.
    const index = args.index.state === "failed" ? { ...row.index, ...args.index } : args.index;
    await ctx.db.patch(row._id, { index });
  },
});

/** A read's result, written as the page's document in the context graph. */
export const write = internalMutation({
  args: {
    rowId: v.id("projectNotion"),
    title: v.string(),
    text: v.string(),
    headings: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.rowId);
    // Unlinked while it was being read: the document went with the row.
    if (!row) return;
    const title = args.title.trim() || row.title;
    await upsertDocument(ctx, {
      projectId: row.projectId,
      source: "notion",
      externalId: externalIdOf(row.pageId),
      title,
      ...(row.url ? { url: row.url } : {}),
      memberId: row.ownerId,
      text: args.text,
      headings: args.headings,
    });
    await ctx.db.patch(row._id, {
      ...(title !== row.title ? { title } : {}),
      index: { state: "ready", at: Date.now(), chars: args.text.length },
    });
  },
});

const externalIdOf = (pageId: string) => `notion:${pageId}`;
