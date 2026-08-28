import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { isTrashed, projectRole, requireOwner } from "./auth";
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

export const restore = mutation({
  args: {
    pages: v.optional(v.array(v.id("pages"))),
    folders: v.optional(v.array(v.id("folders"))),
    projects: v.optional(v.array(v.id("projects"))),
  },
  handler: async (ctx, args) => {
    const me = await requireOwner(ctx);
    const touched = new Set<Id<"projects">>();

    for (const id of args.projects ?? []) {
      const project = await ctx.db.get(id);
      if (!project || !isTrashed(project)) continue;
      if (project.ownerId !== me) throw new Error("Not found");
      await ctx.db.patch(id, { deletedAt: undefined });
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
    };

    for (const id of args.folders ?? []) {
      const folder = await ctx.db.get(id);
      if (!folder || !isTrashed(folder)) continue;
      await editable(folder.projectId);
      await ctx.db.patch(id, { deletedAt: undefined });
      touched.add(folder.projectId);
    }
    for (const id of args.pages ?? []) {
      const page = await ctx.db.get(id);
      if (!page || !isTrashed(page)) continue;
      await editable(page.projectId);
      await ctx.db.patch(id, { deletedAt: undefined });
      touched.add(page.projectId);
    }

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
    };
    for (const id of args.pages ?? []) {
      const page = await ctx.db.get(id);
      if (!page || isTrashed(page)) continue;
      await editable(page.projectId);
      await ctx.db.patch(id, { deletedAt: now });
      touched.add(page.projectId);
    }
    for (const id of args.folders ?? []) {
      const folder = await ctx.db.get(id);
      if (!folder || isTrashed(folder)) continue;
      await editable(folder.projectId);
      await ctx.db.patch(id, { deletedAt: now });
      touched.add(folder.projectId);
    }
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
