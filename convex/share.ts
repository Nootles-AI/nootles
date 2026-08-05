import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireOwned } from "./auth";

/**
 * Read-only project sharing. Security is capability-based: the share token is
 * an unguessable UUID minted here, and `view` is the only public door — it
 * hands out page titles and docIds, nothing else. Document *content* is then
 * read through the ordinary prosemirror sync endpoints, whose read check admits
 * docs whose project is shared (see `prosemirror.ts`).
 */

export const setSharing = mutation({
  args: { projectId: v.id("projects"), enabled: v.boolean() },
  handler: async (ctx, args) => {
    const project = await requireOwned(ctx, "projects", args.projectId);
    if (!args.enabled) {
      await ctx.db.patch(args.projectId, { shareToken: undefined });
      return null;
    }
    // Re-enabling reuses the token: turning sharing off and on again should
    // not silently break a link that was only ever meant to be paused.
    const token = project.shareToken ?? crypto.randomUUID();
    if (!project.shareToken) {
      await ctx.db.patch(args.projectId, { shareToken: token });
    }
    return token;
  },
});

export const view = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    if (!args.token) return null;
    const project = await ctx.db
      .query("projects")
      .withIndex("by_share_token", (q) => q.eq("shareToken", args.token))
      .unique();
    if (!project) return null;
    // Ordered by the index (projectId, order) — the sidebar's own order.
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .collect();
    return {
      title: project.title,
      // `_id` rides along for the mention chips: a chip names a page by id,
      // and the share surface has to answer which of its pages that is.
      pages: pages.map((p) => ({ _id: p._id, title: p.title, docId: p.docId })),
    };
  },
});
