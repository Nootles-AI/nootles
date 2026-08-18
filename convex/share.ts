import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { requireOwned, requireOwner } from "./auth";

/**
 * Link sharing, one link per role. Security is capability-based: each token is
 * an unguessable UUID minted here, and `view` is the only public door — it
 * hands out the navigation tree (page and folder titles, docIds, and where
 * each row sits), nothing else. Document *content* is then
 * read through the ordinary sync endpoints, whose read check admits docs whose
 * project has a live link (see `prosemirror.ts`).
 *
 * Signing in through a link leaves a claim (`auth.ts` derives roles from it),
 * which is also what puts the project under "Shared with me".
 */

const role = v.union(v.literal("viewer"), v.literal("editor"));

const tokenField = {
  viewer: "shareToken",
  editor: "editShareToken",
} as const;

/** The project a live token names, and which role that token grants. */
async function projectForToken(
  ctx: QueryCtx,
  token: string,
): Promise<{ project: Doc<"projects">; role: "viewer" | "editor" } | null> {
  if (!token) return null;
  const asViewer = await ctx.db
    .query("projects")
    .withIndex("by_share_token", (q) => q.eq("shareToken", token))
    .unique();
  if (asViewer) return { project: asViewer, role: "viewer" };
  const asEditor = await ctx.db
    .query("projects")
    .withIndex("by_edit_share_token", (q) => q.eq("editShareToken", token))
    .unique();
  return asEditor ? { project: asEditor, role: "editor" } : null;
}

/** Both links as the share dialog draws them. Owner only. */
export const links = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await requireOwned(ctx, "projects", args.projectId);
    return {
      viewer: project.shareToken ?? null,
      editor: project.editShareToken ?? null,
    };
  },
});

export const setLink = mutation({
  args: { projectId: v.id("projects"), role, enabled: v.boolean() },
  handler: async (ctx, args) => {
    const project = await requireOwned(ctx, "projects", args.projectId);
    const field = tokenField[args.role];
    if (!args.enabled) {
      // Disabling IS revoking: the token goes, the old URL dies, and everyone
      // who claimed through it loses the role it granted (see `auth.ts`).
      await ctx.db.patch(args.projectId, { [field]: undefined });
      return null;
    }
    const token = project[field] ?? crypto.randomUUID();
    if (!project[field]) {
      await ctx.db.patch(args.projectId, { [field]: token });
    }
    return token;
  },
});

export const view = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const found = await projectForToken(ctx, args.token);
    if (!found) return null;
    // Both ordered by the index (projectId, order) — the sidebar's own order,
    // one line per level shared by folders and pages alike.
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_project", (q) => q.eq("projectId", found.project._id))
      .collect();
    const folders = await ctx.db
      .query("folders")
      .withIndex("by_project", (q) => q.eq("projectId", found.project._id))
      .collect();
    return {
      projectId: found.project._id,
      role: found.role,
      title: found.project.title,
      // A shared project keeps its shape: `folderId` and `order` are what let
      // the share rail rebuild the owner's tree from the same code the sidebar
      // uses. `_id` rides along for the mention chips too — a chip names a page
      // by id, and the share surface has to answer which of its pages that is.
      pages: pages.map((p) => ({
        _id: p._id,
        title: p.title,
        docId: p.docId,
        folderId: p.folderId,
        order: p.order,
      })),
      folders: folders.map((f) => ({
        _id: f._id,
        title: f.title,
        parentId: f.parentId,
        order: f.order,
      })),
    };
  },
});

/**
 * What signing in through a link does: records who came, at the role the link
 * grants. Idempotent, upserting to the higher role — a viewer later handed the
 * editor link is promoted, never demoted. The owner passes through unrecorded;
 * their own project has nothing to claim.
 *
 * An account whose first act is a claim was CREATED by this document, and the
 * survey-and-seed welcome is for people starting from nothing — so the claim
 * writes the profile row first run reads as "not new", in the same terminal
 * state as declining the guided start. An account already mid-survey keeps
 * its own state; joining a doc is not an answer to the survey.
 */
export const claim = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const me = await requireOwner(ctx);
    const found = await projectForToken(ctx, args.token);
    if (!found) throw new Error("Not found");

    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_owner", (q) => q.eq("ownerId", me))
      .unique();
    if (!profile) {
      await ctx.db.insert("profiles", {
        ownerId: me,
        status: "skipped",
        createdAt: Date.now(),
        completedAt: Date.now(),
      });
    }

    if (found.project.ownerId === me) return found.project._id;
    const existing = await ctx.db
      .query("shareClaims")
      .withIndex("by_project_and_grantee", (q) =>
        q.eq("projectId", found.project._id).eq("granteeId", me),
      )
      .unique();
    if (!existing) {
      await ctx.db.insert("shareClaims", {
        projectId: found.project._id,
        granteeId: me,
        role: found.role,
        createdAt: Date.now(),
      });
    } else if (existing.role === "viewer" && found.role === "editor") {
      await ctx.db.patch(existing._id, { role: "editor" });
    }
    return found.project._id;
  },
});

/**
 * Who has claimed this project, for the share dialog's access list. Owner only,
 * and read-only in v1 — removing someone means revoking the link they came by.
 */
export const collaborators = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireOwned(ctx, "projects", args.projectId);
    const claims = await ctx.db
      .query("shareClaims")
      .withIndex("by_project_and_grantee", (q) =>
        q.eq("projectId", args.projectId),
      )
      .collect();
    return await Promise.all(
      claims.map(async (claim) => {
        const profile = await ctx.db
          .query("profiles")
          .withIndex("by_owner", (q) => q.eq("ownerId", claim.granteeId))
          .unique();
        return {
          granteeId: claim.granteeId,
          role: claim.role,
          name: profile?.name ?? null,
          email: profile?.email ?? null,
          imageUrl: profile?.imageUrl ?? null,
        };
      }),
    );
  },
});
