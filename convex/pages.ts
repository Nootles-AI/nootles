import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { readVisible, requireEditable } from "./auth";

export const listByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    if (!(await readVisible(ctx, "projects", args.projectId))) return [];
    return await ctx.db
      .query("pages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

export const get = query({
  args: { pageId: v.id("pages") },
  handler: async (ctx, args) => await readVisible(ctx, "pages", args.pageId),
});

/** The named folder, provided it hangs off the given project. */
async function folderIn(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  folderId: Id<"folders">,
): Promise<Doc<"folders">> {
  const folder = await ctx.db.get(folderId);
  if (!folder || folder.projectId !== projectId) throw new Error("Not found");
  return folder;
}

/** The project's pages that live directly in `folderId` (null = top level). */
async function siblingsIn(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  folderId: Id<"folders"> | null,
  except?: Id<"pages">,
): Promise<Doc<"pages">[]> {
  const pages = await ctx.db
    .query("pages")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  return pages.filter(
    (p) => p._id !== except && (p.folderId ?? null) === folderId,
  );
}

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    title: v.optional(v.string()),
    /** Place the page directly after this one instead of at the end. */
    after: v.optional(v.id("pages")),
    /** Sidebar folder to create it in; absent = the anchor's folder, or top level. */
    folderId: v.optional(v.id("folders")),
  },
  handler: async (ctx, args) => {
    // Owner inherited from the authorized parent rather than re-derived, so a
    // page can never disagree with the project it hangs off — a page an editor
    // creates still belongs to the project's owner.
    const { ownerId } = await requireEditable(ctx, "projects", args.projectId);
    if (args.folderId) await folderIn(ctx, args.projectId, args.folderId);
    const anchor = args.after ? await ctx.db.get(args.after) : null;
    // An unnamed folder falls back to the anchor's, so "after that page" lands
    // beside it rather than silently at the top level.
    const folderId = args.folderId ?? anchor?.folderId;
    const siblings = await siblingsIn(ctx, args.projectId, folderId ?? null);
    const placed = args.after ? orderAfter(siblings, args.after) : null;
    return await ctx.db.insert("pages", {
      ownerId,
      projectId: args.projectId,
      // Empty by default so the doc shows its grayed "Untitled" placeholder;
      // the sidebar renders an "Untitled" fallback for empty titles.
      title: args.title ?? "",
      folderId,
      order: placed ?? endOrder(siblings),
      docId: crypto.randomUUID(),
      createdAt: Date.now(),
    });
  },
});

/**
 * Halfway between a row and the one after it, so inserting in the middle never
 * renumbers its neighbours. Null when there is nothing to follow — an id from
 * another parent, or one that has since been deleted — which appends instead.
 */
export function orderAfter(
  siblings: ReadonlyArray<{ _id: string; order: number }>,
  after: string,
): number | null {
  const anchor = siblings.find((p) => p._id === after);
  if (!anchor) return null;
  const following = siblings.map((p) => p.order).filter((o) => o > anchor.order);
  return following.length
    ? (anchor.order + Math.min(...following)) / 2
    : anchor.order + 1;
}

/** Past every sibling — where an append lands. */
export function endOrder(siblings: ReadonlyArray<{ order: number }>): number {
  return siblings.reduce((m, s) => Math.max(m, s.order + 1), 0);
}

/** Before every sibling — where "no anchor" lands. */
export function frontOrder(siblings: ReadonlyArray<{ order: number }>): number {
  return siblings.length ? Math.min(...siblings.map((s) => s.order)) - 1 : 0;
}

/**
 * Moves a page in the sidebar tree: into `folderId` (absent = top level), after
 * the named sibling there, or to the front when none is named. Fractional
 * orders (see {@link orderAfter}) mean only the moved page is written. A stale
 * anchor — deleted, or living elsewhere — appends rather than guessing, because
 * the folder half of the move must still land.
 */
export const move = mutation({
  args: {
    pageId: v.id("pages"),
    folderId: v.optional(v.id("folders")),
    after: v.optional(v.id("pages")),
  },
  handler: async (ctx, args) => {
    const page = await requireEditable(ctx, "pages", args.pageId);
    if (args.after === args.pageId) return;
    if (args.folderId) await folderIn(ctx, page.projectId, args.folderId);
    const siblings = await siblingsIn(
      ctx,
      page.projectId,
      args.folderId ?? null,
      args.pageId,
    );
    const order = args.after
      ? (orderAfter(siblings, args.after) ?? endOrder(siblings))
      : frontOrder(siblings);
    await ctx.db.patch(args.pageId, { order, folderId: args.folderId });
  },
});

/**
 * A full copy of a page — row, mode, and document — appended to `folderId`.
 * Only the copy pasted beside its source is renamed, because there "which one
 * is which" is a question; anywhere else the answer is the folder it landed in.
 */
export const duplicate = mutation({
  args: {
    pageId: v.id("pages"),
    folderId: v.optional(v.id("folders")),
  },
  handler: async (ctx, args) => {
    const page = await requireEditable(ctx, "pages", args.pageId);
    if (args.folderId) await folderIn(ctx, page.projectId, args.folderId);
    const siblings = await siblingsIn(ctx, page.projectId, args.folderId ?? null);
    const beside = (page.folderId ?? null) === (args.folderId ?? null);
    return await clonePage(ctx, page, args.folderId, {
      title: beside ? `${page.title || "Untitled"} copy` : page.title,
      order: endOrder(siblings),
    });
  },
});

/**
 * The write half of {@link duplicate}, shared with folder duplication (which
 * clones every page a folder holds). Caller has authorized the source page.
 */
export async function clonePage(
  ctx: MutationCtx,
  page: Doc<"pages">,
  folderId: Id<"folders"> | undefined,
  placed: { title: string; order: number },
): Promise<Id<"pages">> {
  const docId = crypto.randomUUID();
  await copyDoc(ctx, page.docId, docId);
  return await ctx.db.insert("pages", {
    ownerId: page.ownerId,
    projectId: page.projectId,
    title: placed.title,
    mode: page.mode,
    folderId,
    order: placed.order,
    docId,
    createdAt: Date.now(),
  });
}

/**
 * Copies a document's content under a new docId, whichever pipeline holds it.
 *
 * Yjs-native docs copy as verbatim rows — updates are opaque commutative bytes,
 * so the copy is exact, diagrams included (their CRDT maps live inside the same
 * Y.Doc). Legacy docs copy as their latest snapshot plus the steps written
 * after it, forwarded verbatim; the snapshot alone can sit arbitrarily far
 * behind the document (see `projects.listForScreen`), so the steps must ride
 * along. A doc on neither pipeline has never been opened — nothing to copy.
 */
async function copyDoc(ctx: MutationCtx, from: string, to: string) {
  const ydoc = await ctx.db
    .query("ydocs")
    .withIndex("by_doc", (q) => q.eq("docId", from))
    .unique();
  if (ydoc) {
    await ctx.db.insert("ydocs", {
      docId: to,
      seq: ydoc.seq,
      snapshotSeq: ydoc.snapshotSeq,
      snapshotParts: ydoc.snapshotParts,
      updatedAt: Date.now(),
    });
    const updates = await ctx.db
      .query("yUpdates")
      .withIndex("by_doc_and_seq", (q) => q.eq("docId", from))
      .collect();
    for (const u of updates) {
      await ctx.db.insert("yUpdates", { docId: to, seq: u.seq, update: u.update });
    }
    const chunks = await ctx.db
      .query("ySnapshots")
      .withIndex("by_doc_and_gen_and_part", (q) => q.eq("docId", from))
      .collect();
    for (const c of chunks) {
      await ctx.db.insert("ySnapshots", {
        docId: to,
        gen: c.gen,
        part: c.part,
        data: c.data,
      });
    }
    return;
  }

  const snap: { content: string | null; version?: number } = await ctx.runQuery(
    components.prosemirrorSync.lib.getSnapshot,
    { id: from },
  );
  if (snap.content === null || snap.version === undefined) return;
  await ctx.runMutation(components.prosemirrorSync.lib.submitSnapshot, {
    id: to,
    version: snap.version,
    content: snap.content,
  });
  const trailing: { steps: string[] } = await ctx.runQuery(
    components.prosemirrorSync.lib.getSteps,
    { id: from, version: snap.version },
  );
  if (trailing.steps.length) {
    await ctx.runMutation(components.prosemirrorSync.lib.submitSteps, {
      id: to,
      version: snap.version,
      clientId: "duplicate",
      steps: trailing.steps,
    });
  }
}

export const setMode = mutation({
  args: {
    pageId: v.id("pages"),
    mode: v.union(v.literal("create"), v.literal("complete")),
  },
  handler: async (ctx, args) => {
    await requireEditable(ctx, "pages", args.pageId);
    await ctx.db.patch(args.pageId, { mode: args.mode });
  },
});

export const rename = mutation({
  args: { pageId: v.id("pages"), title: v.string() },
  handler: async (ctx, args) => {
    await requireEditable(ctx, "pages", args.pageId);
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
    const page = await requireEditable(ctx, "pages", args.pageId);
    await removePageCascade(ctx, page);
  },
});

/**
 * The cascade itself, shared with `folders.remove` (which runs it for every
 * page a deleted folder holds). Caller has authorized the page.
 */
export async function removePageCascade(ctx: MutationCtx, page: Doc<"pages">) {
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

  await forgetTurns(ctx, page);
  await ctx.db.delete(page._id);
}

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
