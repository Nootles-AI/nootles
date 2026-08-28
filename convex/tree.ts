import { mutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { readVisible, requireEditable } from "./auth";
import { cloneFolder, removeFolderCascade } from "./folders";
import {
  clonePage,
  folderIn,
  levelOf,
  placeBetween,
  removePageCascade,
} from "./pages";
import { refreshPageSummary } from "./projects";

/**
 * The sidebar tree's one move verb. Folders and pages share a single order
 * line per level, so a move is the same operation whichever kind — or mixture
 * of kinds — is being carried: the group lands together, in the order it was
 * handed over, under `parentId` (absent = top level), after the named row
 * there, or at the front when none is named.
 *
 * One mutation rather than one per kind, because a mixed selection must land
 * as one placement: two writers dividing the same gap would interleave their
 * halves. Fractional orders (see `pages.orderAfter`) mean only the carried
 * rows are written. A stale anchor — deleted, or living elsewhere — appends
 * rather than guessing, because the reparent half of the move must still land.
 */

type Moving =
  | { kind: "page"; doc: Doc<"pages"> }
  | { kind: "folder"; doc: Doc<"folders"> };

/**
 * Refuses a destination inside a moved folder itself. Walked over the
 * project's folders as loaded, with a visited guard so even a row cycle that
 * should never exist ends the walk instead of the function.
 */
function insideItself(
  all: Doc<"folders">[],
  folderId: Id<"folders">,
  destination: Id<"folders">,
): boolean {
  const byId = new Map(all.map((f) => [f._id, f]));
  const seen = new Set<Id<"folders">>();
  for (
    let node = byId.get(destination);
    node && !seen.has(node._id);
    node = node.parentId ? byId.get(node.parentId) : undefined
  ) {
    if (node._id === folderId) return true;
    seen.add(node._id);
  }
  return false;
}

export const move = mutation({
  args: {
    /** The carried rows, top-down — one, or a whole selection of either kind. */
    items: v.array(
      v.union(
        v.object({ kind: v.literal("page"), id: v.id("pages") }),
        v.object({ kind: v.literal("folder"), id: v.id("folders") }),
      ),
    ),
    parentId: v.optional(v.id("folders")),
    /** The level row to land after — either kind; one order line holds both. */
    after: v.optional(v.union(v.id("pages"), v.id("folders"))),
    /** Land past every sibling rather than at the front, when `after` is unset. */
    atEnd: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const moving: Moving[] = [];
    for (const item of args.items) {
      moving.push(
        item.kind === "page"
          ? { kind: "page", doc: await requireEditable(ctx, "pages", item.id) }
          : {
              kind: "folder",
              doc: await requireEditable(ctx, "folders", item.id),
            },
      );
    }
    if (!moving.length) return;
    const projectId = moving[0].doc.projectId;
    // One project per move: an anchor from another would place these rows
    // among orders that mean nothing to them.
    if (moving.some((m) => m.doc.projectId !== projectId)) {
      throw new Error("Not found");
    }

    const folders = await ctx.db
      .query("folders")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    if (args.parentId) {
      await folderIn(ctx, projectId, args.parentId);
      // Every carried folder is checked: a group is only as legal as its worst
      // member, and one of them swallowing the destination orphans the rest.
      for (const m of moving) {
        if (m.kind === "folder" && insideItself(folders, m.doc._id, args.parentId)) {
          throw new Error("Cannot move a folder into itself");
        }
      }
    }

    const pages = await ctx.db
      .query("pages")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    const carried = new Set<string>(args.items.map((i) => i.id));
    const rest = levelOf(folders, pages, args.parentId ?? null).filter(
      (r) => !carried.has(r._id),
    );
    // An anchor that is itself being carried cannot also be the thing to land
    // after; the group goes where that anchor was heading instead.
    const anchor =
      args.after && !carried.has(args.after)
        ? args.after
        : args.atEnd || args.after
          ? "end"
          : null;

    const orders = placeBetween(rest, anchor, moving.length);
    for (const [i, m] of moving.entries()) {
      if (m.kind === "page") {
        await ctx.db.patch(m.doc._id, {
          folderId: args.parentId,
          order: orders[i],
        });
      } else {
        await ctx.db.patch(m.doc._id, {
          parentId: args.parentId,
          order: orders[i],
        });
      }
    }
    // A reorder can change which page is first — the summary's preview.
    await refreshPageSummary(ctx, projectId);
  },
});

/** A project's whole tree, as {@link cloneFolder} recurses over it. */
async function treeRows(ctx: MutationCtx, projectId: Id<"projects">) {
  return {
    folders: await ctx.db
      .query("folders")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect(),
    pages: await ctx.db
      .query("pages")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect(),
  };
}

/**
 * The clipboard's crossing verb: copies rows — pages, folders with everything
 * below them — into another project, appended to one of its levels in the
 * order they were handed over. `move` also deletes the sources, which is what
 * pasting a cut means. Crossing must be a copy rather than a carry (new rows,
 * new documents) because `move` above refuses to mix projects: the sources'
 * orders mean nothing among the destination's. The copies belong wholly to
 * where they land — the destination project and its owner — and keep their
 * titles: a copy in another project is never beside its source, so
 * `pages.duplicate`'s "which one is which" question does not arise.
 *
 * Two projects, two gates. Landing takes the pen on the destination; reading
 * the sources takes any role on theirs — a copy takes nothing a viewer cannot
 * already see — except under `move`, whose delete takes the pen there too. A
 * source that has vanished since it was copied is skipped, the same way the
 * sidebar's paste skips rows its clipboard has outlived.
 */
export const copyTo = mutation({
  args: {
    /** The carried rows, top-down — the copies land in this order. */
    items: v.array(
      v.union(
        v.object({ kind: v.literal("page"), id: v.id("pages") }),
        v.object({ kind: v.literal("folder"), id: v.id("folders") }),
      ),
    ),
    /** The project the copies land in. */
    projectId: v.id("projects"),
    /** Folder of that project to land in; absent = its top level. */
    folderId: v.optional(v.id("folders")),
    /** Delete the sources once copied — a paste that spends a cut. */
    move: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const project = await requireEditable(ctx, "projects", args.projectId);
    if (args.folderId) await folderIn(ctx, args.projectId, args.folderId);

    const sources: Moving[] = [];
    for (const item of args.items) {
      if (item.kind === "page") {
        const doc = await readVisible(ctx, "pages", item.id);
        if (!doc) continue;
        if (args.move) await requireEditable(ctx, "pages", item.id);
        sources.push({ kind: "page", doc });
      } else {
        const doc = await readVisible(ctx, "folders", item.id);
        if (!doc) continue;
        if (args.move) await requireEditable(ctx, "folders", item.id);
        sources.push({ kind: "folder", doc });
      }
    }
    if (!sources.length) return;

    // Every tree is loaded once, before any insert: the destination's for the
    // placement, each source project's for its folders' recursion — and when
    // they are the same project, the shared snapshot is exactly what
    // `cloneFolder` wants, a tree the copy is not yet part of.
    const held = new Map<
      Id<"projects">,
      Awaited<ReturnType<typeof treeRows>>
    >();
    const treeOf = async (projectId: Id<"projects">) => {
      let tree = held.get(projectId);
      if (!tree) held.set(projectId, (tree = await treeRows(ctx, projectId)));
      return tree;
    };

    const dest = await treeOf(args.projectId);
    const siblings = levelOf(dest.folders, dest.pages, args.folderId ?? null);
    const orders = placeBetween(siblings, "end", sources.length);
    const home = { projectId: args.projectId, ownerId: project.ownerId };

    for (const [i, src] of sources.entries()) {
      const placed = { title: src.doc.title, order: orders[i] };
      if (src.kind === "page") {
        await clonePage(ctx, src.doc, args.folderId, placed, home);
      } else {
        const tree = await treeOf(src.doc.projectId);
        await cloneFolder(
          ctx,
          tree.folders,
          tree.pages,
          src.doc,
          args.folderId,
          placed,
          home,
        );
      }
    }

    if (args.move) {
      // Re-read before each delete: a group may overlap itself — a folder and
      // a row inside it — and the first cascade may have taken the second.
      for (const src of sources) {
        if (src.kind === "page") {
          const live = await ctx.db.get(src.doc._id);
          if (live) await removePageCascade(ctx, live);
        } else {
          const live = await ctx.db.get(src.doc._id);
          if (live) await removeFolderCascade(ctx, live);
        }
      }
    }

    // Both ends' denormalized summaries: the destination gained pages either
    // way, and a move took the sources' with it.
    await refreshPageSummary(ctx, args.projectId);
    if (args.move) {
      for (const projectId of new Set(sources.map((s) => s.doc.projectId))) {
        if (projectId !== args.projectId) await refreshPageSummary(ctx, projectId);
      }
    }
  },
});
