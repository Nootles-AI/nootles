import { mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { readVisible, requireEditable } from "./auth";
import {
  clonePage,
  endOrder,
  folderIn,
  levelOf,
  removePageCascade,
} from "./pages";
import { refreshPageSummary } from "./projects";
import { rowIcon } from "./schema";

/**
 * Sidebar folders — the project's navigation tree. Pure structure: a folder
 * holds page rows and other folders, never content, so nothing here touches a
 * document. Access rides the same project role as pages (`auth.ts`). Moving a
 * folder is `tree.move`'s job, the same verb that moves a page.
 */

async function projectFolders(
  ctx: MutationCtx,
  projectId: Id<"projects">,
): Promise<Doc<"folders">[]> {
  return await ctx.db
    .query("folders")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
}

async function projectPages(
  ctx: MutationCtx,
  projectId: Id<"projects">,
): Promise<Doc<"pages">[]> {
  return await ctx.db
    .query("pages")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
}

export const listByProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    if (!(await readVisible(ctx, "projects", args.projectId))) return [];
    return await ctx.db
      .query("folders")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    /** Containing folder; absent = the project's top level. */
    parentId: v.optional(v.id("folders")),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Owner inherited from the authorized parent, as everywhere else.
    const { ownerId } = await requireEditable(ctx, "projects", args.projectId);
    if (args.parentId) await folderIn(ctx, args.projectId, args.parentId);
    const siblings = levelOf(
      await projectFolders(ctx, args.projectId),
      await projectPages(ctx, args.projectId),
      args.parentId ?? null,
    );
    return await ctx.db.insert("folders", {
      ownerId,
      projectId: args.projectId,
      // Empty like a new page: the row renders its "Untitled" fallback while
      // the rename the sidebar opens on creation is still being typed.
      title: args.title ?? "",
      parentId: args.parentId,
      order: endOrder(siblings),
      createdAt: Date.now(),
    });
  },
});

export const rename = mutation({
  args: { folderId: v.id("folders"), title: v.string() },
  handler: async (ctx, args) => {
    await requireEditable(ctx, "folders", args.folderId);
    await ctx.db.patch(args.folderId, { title: args.title });
  },
});

/** Sets or clears the folder's icon; omitting `icon` clears it. */
export const setIcon = mutation({
  args: { folderId: v.id("folders"), icon: v.optional(rowIcon) },
  handler: async (ctx, args) => {
    await requireEditable(ctx, "folders", args.folderId);
    await ctx.db.patch(args.folderId, { icon: args.icon });
  },
});

/**
 * Deletes a folder and everything below it — subfolders, and every page they
 * hold with the full page cascade. Irreversible; the UI confirms first.
 */
export const remove = mutation({
  args: { folderId: v.id("folders") },
  handler: async (ctx, args) => {
    const folder = await requireEditable(ctx, "folders", args.folderId);
    await removeFolderCascade(ctx, folder);
    await refreshPageSummary(ctx, folder.projectId);
  },
});

/**
 * The cascade itself, shared with `tree.copyTo` (whose move half deletes what
 * it has copied). Caller has authorized the folder.
 */
export async function removeFolderCascade(
  ctx: MutationCtx,
  folder: Doc<"folders">,
) {
  const all = await projectFolders(ctx, folder.projectId);

  const doomed = new Set<Id<"folders">>([folder._id]);
  // One pass per level; the tree is loaded, so this is set lookups, not reads.
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of all) {
      if (f.parentId && doomed.has(f.parentId) && !doomed.has(f._id)) {
        doomed.add(f._id);
        grew = true;
      }
    }
  }

  const pages = await projectPages(ctx, folder.projectId);
  for (const page of pages) {
    if (page.folderId && doomed.has(page.folderId)) {
      await removePageCascade(ctx, page);
    }
  }
  for (const id of doomed) await ctx.db.delete(id);
}

/**
 * A deep copy of a folder — subfolders and pages, documents included —
 * appended under `parentId`. Naming follows `pages.duplicate`: only the copy
 * pasted beside its source is renamed.
 */
export const duplicate = mutation({
  args: {
    folderId: v.id("folders"),
    parentId: v.optional(v.id("folders")),
  },
  handler: async (ctx, args) => {
    const folder = await requireEditable(ctx, "folders", args.folderId);
    if (args.parentId) await folderIn(ctx, folder.projectId, args.parentId);
    const all = await projectFolders(ctx, folder.projectId);
    const pages = await projectPages(ctx, folder.projectId);
    const siblings = levelOf(all, pages, args.parentId ?? null);
    const beside = (folder.parentId ?? null) === (args.parentId ?? null);
    const copyId = await cloneFolder(
      ctx,
      all,
      pages,
      folder,
      args.parentId,
      {
        title: beside ? `${folder.title || "Untitled"} copy` : folder.title,
        order: endOrder(siblings),
      },
      { projectId: folder.projectId, ownerId: folder.ownerId },
    );
    await refreshPageSummary(ctx, folder.projectId);
    return copyId;
  },
});

/**
 * Recursion over a snapshot of the tree taken before any insert, so the copy
 * never meets its own clones. Children keep their titles and orders — only the
 * root of the copy is placed. Every row lands in `home` — the source's own
 * project when duplicating, another project entirely under `tree.copyTo`.
 */
export async function cloneFolder(
  ctx: MutationCtx,
  all: Doc<"folders">[],
  pages: Doc<"pages">[],
  src: Doc<"folders">,
  parentId: Id<"folders"> | undefined,
  placed: { title: string; order: number },
  home: { projectId: Id<"projects">; ownerId: string },
): Promise<Id<"folders">> {
  const id = await ctx.db.insert("folders", {
    ownerId: home.ownerId,
    projectId: home.projectId,
    title: placed.title,
    icon: src.icon,
    parentId,
    order: placed.order,
    createdAt: Date.now(),
  });
  for (const child of all.filter((f) => f.parentId === src._id)) {
    await cloneFolder(
      ctx,
      all,
      pages,
      child,
      id,
      { title: child.title, order: child.order },
      home,
    );
  }
  for (const page of pages.filter((p) => p.folderId === src._id)) {
    await clonePage(ctx, page, id, { title: page.title, order: page.order }, home);
  }
  return id;
}
