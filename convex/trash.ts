import { v } from "convex/values";
import { internalMutation, mutation, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { isTrashed, managesProject, projectRole, requireOwner } from "./auth";
import { recordInProject } from "./audit";
import { containerOf, requireQuotaIn } from "./entitlements";
import { removePageCascade } from "./pages";
import { purgeProject, refreshPageSummary } from "./projects";

/**
 * The other side of soft delete — the one module allowed to see trashed rows.
 *
 * `restore` is what the sidebar's undo replays: a delete's own return value
 * (exactly the rows it marked) handed back. There is no browsing UI yet; the
 * timeline is the way back, and the purge below is the horizon.
 */

/** How long a deleted row stays restorable — the AI checkpoints' window. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

type Touched = {
  folders: { doc: Doc<"folders">; project: Doc<"projects"> }[];
  pages: { doc: Doc<"pages">; project: Doc<"projects"> }[];
};

/**
 * Logs a restore or re-delete as the operation it replays, not as each row it
 * touched: a folder's undo hands back the whole cascade, and the log should
 * read as that one folder, with its page count, the way `folders.remove`
 * wrote it. A row under another folder of the same call is counted there.
 */
async function recordTouched(ctx: MutationCtx, verb: "restore" | "delete", rows: Touched) {
  const named = new Set<Id<"folders">>(rows.folders.map((f) => f.doc._id));
  /** The highest folder of this call above `folderId`, itself included. */
  const topOf = async (folderId: Id<"folders"> | undefined) => {
    let top: Id<"folders"> | null = null;
    const seen = new Set<Id<"folders">>();
    for (let id = folderId; id && !seen.has(id); ) {
      seen.add(id);
      if (named.has(id)) top = id;
      id = (await ctx.db.get(id))?.parentId;
    }
    return top;
  };

  const pagesUnder = new Map<Id<"folders">, number>();
  const loose: Touched["pages"] = [];
  for (const row of rows.pages) {
    const top = await topOf(row.doc.folderId);
    if (top) pagesUnder.set(top, (pagesUnder.get(top) ?? 0) + 1);
    else loose.push(row);
  }
  for (const { doc, project } of rows.folders) {
    if ((await topOf(doc.parentId)) !== null) continue;
    await recordInProject(ctx, project, {
      action: `folder.${verb}`,
      subjectKind: "folder",
      subjectId: doc._id,
      meta: { folder: doc.title, pages: pagesUnder.get(doc._id) ?? 0 },
    });
  }
  for (const { doc, project } of loose) {
    await recordInProject(ctx, project, {
      action: `page.${verb}`,
      subjectKind: "page",
      subjectId: doc._id,
      meta: { page: doc.title },
    });
  }
}

export const restore = mutation({
  args: {
    pages: v.optional(v.array(v.id("pages"))),
    folders: v.optional(v.array(v.id("folders"))),
    projects: v.optional(v.array(v.id("projects"))),
  },
  handler: async (ctx, args) => {
    const caller = await requireOwner(ctx);
    const touched = new Set<Id<"projects">>();

    for (const id of args.projects ?? []) {
      const project = await ctx.db.get(id);
      if (!project || !isTrashed(project)) continue;
      if (!(await managesProject(ctx, project))) throw new Error("Not found");
      // A project coming back takes a free slot as surely as a new one;
      // otherwise deleting, creating and undoing is a way past the limit. Its
      // container's slot: a workspace's own, never the restorer's.
      await requireQuotaIn(ctx, containerOf(project, caller), "projects");
      await ctx.db.patch(id, { deletedAt: undefined });
      await recordInProject(ctx, project, {
        action: "project.restore",
        subjectKind: "project",
        subjectId: id,
      });
    }

    // Pages and folders restore into their LIVE project, at the caller's
    // editor-or-owner role there. requireEditable cannot serve here — it
    // reads trashed rows as missing, which is the point of it — so the same
    // gate is composed from its parts.
    const editable = async (projectId: Id<"projects">) => {
      const project = await ctx.db.get(projectId);
      if (!project || isTrashed(project)) throw new Error("Not found");
      const role = await projectRole(ctx, projectId);
      if (role !== "owner" && role !== "editor") throw new Error("Not found");
      return project;
    };

    const logged: Touched = { folders: [], pages: [] };
    for (const id of args.folders ?? []) {
      const folder = await ctx.db.get(id);
      if (!folder || !isTrashed(folder)) continue;
      const project = await editable(folder.projectId);
      await ctx.db.patch(id, { deletedAt: undefined });
      logged.folders.push({ doc: folder, project });
      touched.add(folder.projectId);
    }
    for (const id of args.pages ?? []) {
      const page = await ctx.db.get(id);
      if (!page || !isTrashed(page)) continue;
      const project = await editable(page.projectId);
      await ctx.db.patch(id, { deletedAt: undefined });
      logged.pages.push({ doc: page, project });
      touched.add(page.projectId);
    }
    await recordTouched(ctx, "restore", logged);

    for (const projectId of touched) await refreshPageSummary(ctx, projectId);
  },
});

/**
 * Re-trashes exact rows — the redo of a delete whose undo was `restore`.
 * Id lists rather than a cascade: the cascade already ran once and named
 * these rows, and re-deriving it could catch rows created since.
 */
export const remove = mutation({
  args: {
    pages: v.optional(v.array(v.id("pages"))),
    folders: v.optional(v.array(v.id("folders"))),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const touched = new Set<Id<"projects">>();
    const editable = async (projectId: Id<"projects">) => {
      const role = await projectRole(ctx, projectId);
      if (role !== "owner" && role !== "editor") throw new Error("Not found");
      return (await ctx.db.get(projectId))!;
    };
    const logged: Touched = { folders: [], pages: [] };
    for (const id of args.pages ?? []) {
      const page = await ctx.db.get(id);
      if (!page || isTrashed(page)) continue;
      const project = await editable(page.projectId);
      await ctx.db.patch(id, { deletedAt: now });
      logged.pages.push({ doc: page, project });
      touched.add(page.projectId);
    }
    for (const id of args.folders ?? []) {
      const folder = await ctx.db.get(id);
      if (!folder || isTrashed(folder)) continue;
      const project = await editable(folder.projectId);
      await ctx.db.patch(id, { deletedAt: now });
      logged.folders.push({ doc: folder, project });
      touched.add(folder.projectId);
    }
    await recordTouched(ctx, "delete", logged);
    for (const projectId of touched) await refreshPageSummary(ctx, projectId);
  },
});

/**
 * Hard-deletes what has sat in the trash past retention, with the cascades
 * the immediate deletes used to run. Folders purge as bare rows: their pages
 * carry their own stamps and purge on their own clock.
 */
export const purge = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - KEEP_MS;

    const pages = await ctx.db
      .query("pages")
      .withIndex("by_deleted", (q) => q.gt("deletedAt", 0).lt("deletedAt", cutoff))
      .collect();
    for (const page of pages) await removePageCascade(ctx, page);

    const folders = await ctx.db
      .query("folders")
      .withIndex("by_deleted", (q) => q.gt("deletedAt", 0).lt("deletedAt", cutoff))
      .collect();
    for (const folder of folders) await ctx.db.delete(folder._id);

    const projects = await ctx.db
      .query("projects")
      .withIndex("by_deleted", (q) => q.gt("deletedAt", 0).lt("deletedAt", cutoff))
      .collect();
    for (const project of projects) await purgeProject(ctx, project._id);
  },
});
