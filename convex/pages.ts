import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { readOwned, requireOwned } from "./auth";

export const listByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    if (!(await readOwned(ctx, "projects", args.projectId))) return [];
    return await ctx.db
      .query("pages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

export const get = query({
  args: { pageId: v.id("pages") },
  handler: async (ctx, args) => await readOwned(ctx, "pages", args.pageId),
});

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    title: v.optional(v.string()),
    /** Place the page directly after this one instead of at the end. */
    after: v.optional(v.id("pages")),
  },
  handler: async (ctx, args) => {
    // Owner inherited from the authorized parent rather than re-derived, so a
    // page can never disagree with the project it hangs off.
    const { ownerId } = await requireOwned(ctx, "projects", args.projectId);
    const siblings = await ctx.db
      .query("pages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    const placed = args.after ? orderAfter(siblings, args.after) : null;
    const order = placed ?? siblings.reduce((m, p) => Math.max(m, p.order + 1), 0);
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

/**
 * Halfway between a page and the one after it, so inserting in the middle never
 * renumbers its neighbours. Null when there is nothing to follow — an id from
 * another project, or one that has since been deleted — which appends instead.
 */
function orderAfter(siblings: Doc<"pages">[], after: Id<"pages">): number | null {
  const anchor = siblings.find((p) => p._id === after);
  if (!anchor) return null;
  const following = siblings.map((p) => p.order).filter((o) => o > anchor.order);
  return following.length
    ? (anchor.order + Math.min(...following)) / 2
    : anchor.order + 1;
}

export const setMode = mutation({
  args: {
    pageId: v.id("pages"),
    mode: v.union(v.literal("create"), v.literal("complete")),
  },
  handler: async (ctx, args) => {
    await requireOwned(ctx, "pages", args.pageId);
    await ctx.db.patch(args.pageId, { mode: args.mode });
  },
});

export const rename = mutation({
  args: { pageId: v.id("pages"), title: v.string() },
  handler: async (ctx, args) => {
    await requireOwned(ctx, "pages", args.pageId);
    await ctx.db.patch(args.pageId, { title: args.title, updatedAt: Date.now() });
  },
});

/**
 * Deletes a page and everything hanging off it — the same cascade
 * `projects.remove` runs for each of its pages.
 *
 * Irreversible; the UI confirms first. The prosemirror-sync document keyed by
 * `docId` is deliberately left alone: it belongs to the sync component rather
 * than this schema, and orphaning it costs storage, not correctness.
 */
export const remove = mutation({
  args: { pageId: v.id("pages") },
  handler: async (ctx, args) => {
    const page = await requireOwned(ctx, "pages", args.pageId);

    const canvases = await ctx.db
      .query("canvases")
      .withIndex("by_page", (q) => q.eq("pageId", args.pageId))
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
        .withIndex("by_page", (q) => q.eq("pageId", args.pageId))
        .collect();
      await Promise.all(rows.map((r) => ctx.db.delete(r._id)));
    }

    await forgetTurns(ctx, page);
    await ctx.db.delete(args.pageId);
  },
});

const TURN_STATUS = [
  "streaming",
  "pending",
  "accepted",
  "rejected",
  "failed",
] as const;

/**
 * Drops this page out of every turn that edited it.
 *
 * A turn is what a reload reads to find changes still awaiting an answer, and
 * its checkpoints have just gone with the page — so left behind it would come
 * back on every load with nothing left to undo. A turn that also edited other
 * pages keeps those: only this page's entry goes.
 */
async function forgetTurns(ctx: MutationCtx, page: Doc<"pages">) {
  const turns = (
    await Promise.all(
      TURN_STATUS.map((status) =>
        ctx.db
          .query("chatTurns")
          .withIndex("by_project_status", (q) =>
            q.eq("projectId", page.projectId).eq("status", status),
          )
          .collect(),
      ),
    )
  ).flat();

  const without = (blob: unknown) => {
    const held = blob as { pages?: Array<{ pageId: Id<"pages"> }> } | null | undefined;
    if (!held?.pages) return blob;
    return { ...held, pages: held.pages.filter((p) => p.pageId !== page._id) };
  };

  for (const turn of turns) {
    const at = turn.pageIds.indexOf(page._id);
    if (at === -1) continue;
    const pageIds = turn.pageIds.filter((_, i) => i !== at);
    if (!pageIds.length) {
      await ctx.db.delete(turn._id);
      continue;
    }
    await ctx.db.patch(turn._id, {
      pageIds,
      checkpointIds: turn.checkpointIds.filter((_, i) => i !== at),
      trace: without(turn.trace),
      hunks: without(turn.hunks),
    });
  }
}
