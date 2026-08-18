import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { ownerId, requireOwned, requireOwner, roleForProject } from "./auth";

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
 *
 * The founder's letter is retired on the same row and for the same reason: it
 * asks the reader to report what they think of Nootles, and someone who came
 * here to read one shared document has not met it yet.
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
        hints: ["tester-note"],
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
          // What they are, not what let them in: someone granted the pen by
          // name reads as an editor here even while the editor link is off.
          role: claim.grantedRole ?? claim.role,
          name: profile?.name ?? null,
          email: profile?.email ?? null,
          imageUrl: profile?.imageUrl ?? null,
        };
      }),
    );
  },
});

/**
 * Asking for the pen from a read-only project, and the owner's answer.
 *
 * A request needs no new capability of its own: only someone who can already
 * see the project can ask about it, and granting reaches for `grantedRole` on
 * the claim they already have — so the answer promotes one person rather than
 * widening a link. Nothing here is a door: a denial leaves them exactly the
 * viewer they were.
 */

/** Who is asking, as the owner's toast draws them. */
async function requesterCard(ctx: QueryCtx, request: Doc<"accessRequests">) {
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_owner", (q) => q.eq("ownerId", request.requesterId))
    .unique();
  const project = await ctx.db.get(request.projectId);
  return {
    requestId: request._id,
    projectId: request.projectId,
    projectTitle: project?.title ?? "",
    name: profile?.name ?? null,
    email: profile?.email ?? null,
    imageUrl: profile?.imageUrl ?? null,
    createdAt: request.createdAt,
  };
}

/**
 * "May I edit this?" — only a viewer has anything to ask, and asking twice is
 * the same question: the row is reused rather than appended to, so an owner who
 * dismissed one never faces a pile of it. A previously declined request goes
 * back to pending, which is the whole of what a decline means.
 */
export const requestEdit = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const me = await requireOwner(ctx);
    const project = await ctx.db.get(args.projectId);
    if (!project) throw new Error("Not found");
    // Through the same gate every other reader passes: a stranger cannot use
    // this to learn that a project id exists.
    const role = await roleForProject(ctx, project);
    if (!role) throw new Error("Not found");
    // Owners and editors have the pen already; nothing to ask for.
    if (role !== "viewer") return null;

    const existing = await ctx.db
      .query("accessRequests")
      .withIndex("by_project_and_requester", (q) =>
        q.eq("projectId", args.projectId).eq("requesterId", me),
      )
      .unique();
    if (existing) {
      if (existing.status !== "pending") {
        await ctx.db.patch(existing._id, {
          status: "pending",
          createdAt: Date.now(),
          decidedAt: undefined,
          seenAt: undefined,
        });
      }
      return existing._id;
    }
    return await ctx.db.insert("accessRequests", {
      projectId: args.projectId,
      requesterId: me,
      projectOwnerId: project.ownerId,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

/** Where the caller's own request stands, so the button can stop asking. */
export const myEditRequest = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const me = await ownerId(ctx);
    if (!me) return null;
    const request = await ctx.db
      .query("accessRequests")
      .withIndex("by_project_and_requester", (q) =>
        q.eq("projectId", args.projectId).eq("requesterId", me),
      )
      .unique();
    return request ? { status: request.status } : null;
  },
});

/**
 * Everyone waiting on the caller, across every project they own — the owner's
 * inbox, which is why it is keyed on the owner rather than on a project: the
 * toast has to find them wherever they are standing, including the project list.
 */
export const incomingRequests = query({
  args: {},
  handler: async (ctx) => {
    const me = await ownerId(ctx);
    if (!me) return [];
    const requests = await ctx.db
      .query("accessRequests")
      .withIndex("by_owner_and_status", (q) =>
        q.eq("projectOwnerId", me).eq("status", "pending"),
      )
      .collect();
    return await Promise.all(requests.map((r) => requesterCard(ctx, r)));
  },
});

/**
 * The owner's answer. Granting writes `grantedRole` onto the claim the
 * requester already holds — the promotion is per person, and no link changes.
 *
 * A requester with no claim row cannot be granted: the claim is what a share
 * link left behind, and without one there is nothing this project has admitted
 * them to. In practice unreachable — asking requires a live role, which
 * requires a claim — but it is the invariant, so it is checked rather than
 * assumed.
 */
export const decideRequest = mutation({
  args: { requestId: v.id("accessRequests"), grant: v.boolean() },
  handler: async (ctx, args) => {
    const me = await requireOwner(ctx);
    const request = await ctx.db.get(args.requestId);
    if (!request || request.projectOwnerId !== me) throw new Error("Not found");

    if (args.grant) {
      const claim = await ctx.db
        .query("shareClaims")
        .withIndex("by_project_and_grantee", (q) =>
          q.eq("projectId", request.projectId).eq("granteeId", request.requesterId),
        )
        .unique();
      if (!claim) throw new Error("Not found");
      await ctx.db.patch(claim._id, { grantedRole: "editor" });
    }
    await ctx.db.patch(args.requestId, {
      status: args.grant ? "granted" : "denied",
      decidedAt: Date.now(),
    });
    return null;
  },
});

/**
 * The good news, once. A decline is not in here on purpose: it is answered by
 * the request button simply coming back, not by a notice that someone said no.
 */
export const grantedForMe = query({
  args: {},
  handler: async (ctx) => {
    const me = await ownerId(ctx);
    if (!me) return [];
    const granted = await ctx.db
      .query("accessRequests")
      .withIndex("by_requester_and_status", (q) =>
        q.eq("requesterId", me).eq("status", "granted"),
      )
      .collect();
    return await Promise.all(
      granted
        .filter((r) => r.seenAt === undefined)
        .map(async (r) => {
          const project = await ctx.db.get(r.projectId);
          return {
            requestId: r._id,
            projectId: r.projectId,
            projectTitle: project?.title ?? "",
          };
        }),
    );
  },
});

/** Records that the grant was announced, so it is announced exactly once. */
export const markGrantsSeen = mutation({
  args: { requestIds: v.array(v.id("accessRequests")) },
  handler: async (ctx, args) => {
    const me = await requireOwner(ctx);
    const now = Date.now();
    for (const id of args.requestIds) {
      const request = await ctx.db.get(id);
      if (request?.requesterId === me && request.seenAt === undefined) {
        await ctx.db.patch(id, { seenAt: now });
      }
    }
    return null;
  },
});
