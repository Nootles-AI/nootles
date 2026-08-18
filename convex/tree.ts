import { mutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { requireEditable } from "./auth";
import { folderIn, levelOf, placeBetween } from "./pages";

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
  },
});
