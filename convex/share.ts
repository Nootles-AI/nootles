import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  activeMembership,
  claimOf,
  claimRole,
  codeGrantRefusal,
  containerRole,
  isTrashed,
  LINK_FIELDS,
  linkLive,
  linkShows,
  linksOpen,
  type LinkRole,
  ownerId,
  readManageable,
  requireEditable,
  requireManageable,
  requireOwner,
  roleForProject,
  seatRole,
  sendsLinks,
} from "./auth";
import { recordInProject } from "./audit";
import { ensureArrivalProfile, personOf } from "./profiles";

/**
 * Link sharing, one link per role. Security is capability-based: each token is
 * an unguessable UUID minted here, and `view` is the only public door — it
 * hands out the navigation tree (page and folder titles, docIds, and where
 * each row sits), nothing else. Document *content* is then
 * read through the ordinary sync endpoints, whose read check admits docs whose
 * project has a live link (see `prosemirror.ts`).
 *
 * A link can be given an expiry, and a workspace can turn links off or open
 * them only to people signed in — all of it decided in `auth.ts`.
 *
 * Signing in through a link leaves a claim (`auth.ts` derives roles from it),
 * which is also what puts the project under "Shared with me".
 */

const role = v.union(v.literal("viewer"), v.literal("commenter"), v.literal("editor"));

/** Each link grants everything the one before it does, and one thing more. */
const RANK: Record<LinkRole, number> = { viewer: 0, commenter: 1, editor: 2 };

const DAY_MS = 24 * 60 * 60 * 1000;

/** The project a live token names, and which role that token grants. */
async function projectForToken(
  ctx: QueryCtx,
  token: string,
  now: number,
): Promise<{ project: Doc<"projects">; role: LinkRole } | null> {
  if (!token) return null;
  const found =
    (await ctx.db
      .query("projects")
      .withIndex("by_share_token", (q) => q.eq("shareToken", token))
      .unique()
      .then((project) => project && { project, role: "viewer" as const })) ??
    (await ctx.db
      .query("projects")
      .withIndex("by_comment_share_token", (q) => q.eq("commentShareToken", token))
      .unique()
      .then((project) => project && { project, role: "commenter" as const })) ??
    (await ctx.db
      .query("projects")
      .withIndex("by_edit_share_token", (q) => q.eq("editShareToken", token))
      .unique()
      .then((project) => project && { project, role: "editor" as const }));
  if (!found || isTrashed(found.project) || !linkLive(found.project, found.role, now)) return null;
  return found;
}

/** A new link's expiry when none is asked for: its workspace's default, if it sets one. */
async function defaultDays(ctx: QueryCtx, project: Doc<"projects">): Promise<number | null> {
  if (!project.workspaceId) return null;
  return (await ctx.db.get(project.workspaceId))?.settings.linkTtlDays ?? null;
}

/**
 * Every link as the share dialog draws them, to whoever may hand one out
 * (`sendsLinks`). `manages` says which dialog to draw — only a manager
 * changes a link.
 *
 * Reads, so it goes by the project's role without `refuseStandIn`, the write
 * gate: that would blind an operator standing in for a manager, the one
 * session most likely to be asking who a project is shared with.
 *
 * `allowed` is false while the project's workspace allows no links; the
 * tokens then admit nobody, and `setLink` refuses to turn one on. An expiry
 * in the past is a link that has run out.
 */
export const links = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    const role = project && !isTrashed(project) ? await roleForProject(ctx, project) : null;
    if (!project || !sendsLinks(role)) throw new Error("Not found");
    return {
      viewer: project.shareToken ?? null,
      commenter: project.commentShareToken ?? null,
      editor: project.editShareToken ?? null,
      expiresAt: {
        viewer: project.shareExpiresAt ?? null,
        commenter: project.commentShareExpiresAt ?? null,
        editor: project.editShareExpiresAt ?? null,
      },
      manages: role === "owner",
      allowed: await linksOpen(ctx, project),
      /** What a new link's expiry starts at, in days; null is never. */
      defaultDays: await defaultDays(ctx, project),
    };
  },
});

/**
 * Turns a link on or off, or changes when it runs out. `expiresInDays` is
 * 1–365, or null for never; left out, a live link keeps its expiry and a new
 * one starts at its workspace's default. A link that has run out is not
 * revived: turning it on again mints a new one, so the old address stays dead.
 *
 * An editor may only hand a link out (`sendsLinks`): on, with no expiry asked,
 * which answers the live link as it stands or makes one at the default. Off
 * and a new expiry reach everyone who came in by the link, so they are the
 * project's managers' alone.
 */
export const setLink = mutation({
  args: {
    projectId: v.id("projects"),
    role,
    enabled: v.boolean(),
    expiresInDays: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const project = await requireEditable(ctx, "projects", args.projectId);
    const role = await roleForProject(ctx, project);
    if (role !== "owner" && (!args.enabled || args.expiresInDays !== undefined)) {
      throw new ConvexError("Only people who manage this project can change its links.");
    }
    const fields = LINK_FIELDS[args.role];
    if (!args.enabled) {
      // Disabling IS revoking: the token goes, the old URL dies, and everyone
      // who claimed through it loses the role it granted (see `auth.ts`).
      await ctx.db.patch(args.projectId, {
        [fields.token]: undefined,
        [fields.expiresAt]: undefined,
      });
      if (project[fields.token]) {
        await recordInProject(ctx, project, {
          action: "share.link.off",
          subjectKind: "project",
          subjectId: project._id,
          meta: { role: args.role },
        });
      }
      return null;
    }
    if (!(await linksOpen(ctx, project))) {
      throw new ConvexError("Link sharing is turned off in this workspace.");
    }
    const now = Date.now();
    const live = linkLive(project, args.role, now);
    const token = live ? project[fields.token]! : crypto.randomUUID();
    const expiresAt =
      args.expiresInDays === undefined && live
        ? project[fields.expiresAt]
        : expiryAfter(
            args.expiresInDays === undefined ? await defaultDays(ctx, project) : args.expiresInDays,
            now,
          );
    if (token !== project[fields.token] || expiresAt !== project[fields.expiresAt]) {
      await ctx.db.patch(args.projectId, {
        [fields.token]: token,
        [fields.expiresAt]: expiresAt,
      });
      if (expiresAt !== undefined && expiresAt !== project[fields.expiresAt]) {
        await ctx.scheduler.runAt(expiresAt, internal.share.lapse, { projectId: args.projectId, at: expiresAt });
      }
      await recordInProject(ctx, project, {
        action: live ? "share.link.expiry" : "share.link.on",
        subjectKind: "project",
        subjectId: project._id,
        meta: { role: args.role, expiresAt: expiresAt ?? null },
      });
    }
    await carryExpiry(ctx, args.projectId, args.role, expiresAt, now);
    return token;
  },
});

/**
 * A link's expiry, arriving. Who holds a role through a link, and who reads a
 * page by one, is decided against the clock inside queries, and a query is
 * not re-run as time passes: without a write at this moment, someone whose
 * editor link just ran out goes on being shown the pen, typing into a page
 * that refuses every change (NT-80). So `setLink` schedules this for each
 * expiry it sets, and it stamps the project whether or not the link still
 * holds that expiry — a claim keeps the one it came with after its link is
 * turned off (`carryExpiry`).
 */
export const lapse = internalMutation({
  args: { projectId: v.id("projects"), at: v.number() },
  returns: v.null(),
  handler: async (ctx, { projectId, at }) => {
    const project = await ctx.db.get(projectId);
    if (!project || (project.linksLapsedAt ?? 0) >= at) return null;
    await ctx.db.patch(projectId, { linksLapsedAt: at });
    return null;
  },
});

function expiryAfter(days: number | null, now: number): number | undefined {
  if (days === null) return undefined;
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new ConvexError("Links can expire after 1 to 365 days.");
  }
  return now + days * DAY_MS;
}

/**
 * A claim keeps the expiry of the link it came through, so moving a link's
 * date moves its people's with it. A claim that has already run out stays
 * out: visiting the link again is how its holder comes back.
 */
async function carryExpiry(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  role: LinkRole,
  expiresAt: number | undefined,
  now: number,
) {
  const claims = await ctx.db
    .query("shareClaims")
    .withIndex("by_project_and_grantee", (q) => q.eq("projectId", projectId))
    .collect();
  for (const claim of claims) {
    if (claim.role !== role || claim.expiresAt === expiresAt) continue;
    if (claim.expiresAt !== undefined && claim.expiresAt <= now) continue;
    await ctx.db.patch(claim._id, { expiresAt });
  }
}

/**
 * What a link opens onto, before any sign-in: the project's tree, as the
 * sidebar would draw it. Null for a link that is off or has run out;
 * `{ access: "paused" }` for a live one in a workspace that allows no links.
 *
 * `access` is `linkShows`'s answer. A workspace project's link opens to
 * nobody signed out ("sign-in": no title, no pages), and to someone signed in
 * without a role only enough to claim it ("claim": no pages yet).
 */
export const view = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const found = await projectForToken(ctx, args.token, Date.now());
    if (!found) return null;
    // Paused, not dead: it works again, as it was, when the workspace allows
    // links. Said as that alone — nothing about the project or its workspace.
    if (!(await linksOpen(ctx, found.project))) return { access: "paused" as const };
    const access = await linkShows(ctx, found.project);
    const tree = access === "tree";
    // Both ordered by the index (projectId, order) — the sidebar's own order,
    // one line per level shared by folders and pages alike.
    const pages = tree
      ? (
          await ctx.db
            .query("pages")
            .withIndex("by_project", (q) => q.eq("projectId", found.project._id))
            .collect()
        ).filter((p) => !isTrashed(p))
      : [];
    const folders = tree
      ? (
          await ctx.db
            .query("folders")
            .withIndex("by_project", (q) => q.eq("projectId", found.project._id))
            .collect()
        ).filter((f) => !isTrashed(f))
      : [];
    return {
      projectId: found.project._id,
      role: found.role,
      access,
      title: access === "sign-in" ? "" : found.project.title,
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
 * grants and until the link runs out. Idempotent, upserting to the higher role
 * in `RANK` — a viewer later handed the comment or editor link is promoted,
 * and a commenter who opens the viewer link is never demoted by it — and a
 * claim that had run out starts again from the link it came back by. "Higher"
 * is judged against what the claim grants now, so an editor whose link was
 * turned off, handed the live comment link instead, becomes its commenter.
 * Whoever
 * the project's container already gives a role — its owner, or a seat in its
 * workspace — passes through unrecorded: they are not in by the link, and a
 * claim would list them among its people as if they were.
 *
 * An account whose first act is a claim was CREATED by this document, so the
 * claim writes the profile row first run reads as "not new"
 * (`ensureArrivalProfile`).
 */
export const claim = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const me = await requireOwner(ctx);
    const now = Date.now();
    const found = await projectForToken(ctx, args.token, now);
    if (!found || !(await linksOpen(ctx, found.project))) throw new Error("Not found");

    await ensureArrivalProfile(ctx, me);

    if (await containerRole(ctx, found.project, me)) return found.project._id;
    const expiresAt = found.project[LINK_FIELDS[found.role].expiresAt];
    const existing = await claimOf(ctx, found.project._id, me);
    const logClaim = () =>
      recordInProject(ctx, found.project, {
        action: "share.claim",
        subjectKind: "user",
        subjectId: me,
        meta: { role: found.role, renewed: !!existing },
      });
    if (!existing) {
      await ctx.db.insert("shareClaims", {
        projectId: found.project._id,
        granteeId: me,
        role: found.role,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        createdAt: now,
      });
      await logClaim();
    } else {
      const lapsed = existing.expiresAt !== undefined && existing.expiresAt <= now;
      // Ranked by what the claim grants now: a role whose link has died
      // stands as a viewer's, so a live lower link still lifts it.
      const standing = linkLive(found.project, existing.role, now) ? existing.role : "viewer";
      if (lapsed || existing.role === found.role || RANK[found.role] > RANK[standing]) {
        await ctx.db.patch(existing._id, { role: found.role, expiresAt });
        // Visiting again is not news; coming back after running out, or up to the pen, is.
        if (lapsed || existing.role !== found.role) await logClaim();
      }
    }
    return found.project._id;
  },
});

/**
 * Who holds a role in this project through a claim, for the share dialog's
 * access list. Whoever manages the project.
 *
 * On a workspace project each person says whether they are one of its
 * guests, and whether a manager let them see its code (`setCodeAccess`).
 * `expiresAt` is when their access through the link runs out; null is never.
 * `paused` while the workspace allows no links: they hold nothing now, and
 * get `role` back when links are turned on.
 */
/** Reads, so `readManageable` rather than the write gate — see `links` above. */
export const collaborators = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await readManageable(ctx, "projects", args.projectId);
    if (!project) throw new Error("Not found");
    // Paused links keep their people, who come back as they were when links
    // are on again: they are listed, marked, so a manager can let one go first.
    const paused = !(await linksOpen(ctx, project));
    const claims = await ctx.db
      .query("shareClaims")
      .withIndex("by_project_and_grantee", (q) =>
        q.eq("projectId", args.projectId),
      )
      .collect();
    const now = Date.now();
    const people = await Promise.all(
      claims.map(async (claim) => {
        // What they are, not what let them in: the claim outlives the links,
        // so a revoked link has to take its people off this list too, the
        // same as it takes away their access.
        const role = claimRole(project, claim, now);
        if (!role) return null;
        const seat = project.workspaceId
          ? await activeMembership(ctx, project.workspaceId, claim.granteeId)
          : null;
        // In by their seat, which no removal here reaches: a claim written
        // before `claim` passed them by, or before they had the seat.
        if (seatRole(project, claim.granteeId, seat)) return null;
        const person = await personOf(ctx, claim.granteeId);
        return {
          granteeId: claim.granteeId,
          role,
          ...person,
          expiresAt: claim.grantedRole ? null : (claim.expiresAt ?? null),
          guest: seat?.role === "guest",
          codeAccess: claim.codeAccess === true,
          paused,
        };
      }),
    );
    return people.filter((person) => person !== null);
  },
});

/**
 * Takes one person's access away: their claim, and whatever they asked for.
 * Whoever manages the project. The link they came by stays on — while it is
 * live they can come back through it, which is what revoking the link is for.
 */
export const revokeClaim = mutation({
  args: { projectId: v.id("projects"), granteeId: v.string() },
  handler: async (ctx, args) => {
    const project = await requireManageable(ctx, "projects", args.projectId);
    const claim = await claimOf(ctx, args.projectId, args.granteeId);
    if (claim) {
      await ctx.db.delete(claim._id);
      await recordInProject(ctx, project, {
        action: "share.claim.revoke",
        subjectKind: "user",
        subjectId: args.granteeId,
        meta: { role: claim.grantedRole ?? claim.role },
      });
    }
    const request = await ctx.db
      .query("accessRequests")
      .withIndex("by_project_and_requester", (q) =>
        q.eq("projectId", args.projectId).eq("requesterId", args.granteeId),
      )
      .unique();
    if (request) await ctx.db.delete(request._id);
    return null;
  },
});

/**
 * Lets a workspace guest into the repository half of a project's context, or
 * back out of it. Whoever manages the project, and letting in only where the
 * workspace allows guests code at all (`codeGrantRefusal`); taking it away is
 * always allowed.
 */
export const setCodeAccess = mutation({
  args: { projectId: v.id("projects"), granteeId: v.string(), allowed: v.boolean() },
  handler: async (ctx, args) => {
    const project = await requireManageable(ctx, "projects", args.projectId);
    const claim = await claimOf(ctx, args.projectId, args.granteeId);
    if (!claim) throw new Error("Not found");
    if (args.allowed) {
      const refusal = await codeGrantRefusal(ctx, project, args.granteeId);
      if (refusal) throw new ConvexError(refusal);
    }
    if ((claim.codeAccess === true) === args.allowed) return null;
    await ctx.db.patch(claim._id, { codeAccess: args.allowed ? true : undefined });
    await recordInProject(ctx, project, {
      action: args.allowed ? "share.code.grant" : "share.code.revoke",
      subjectKind: "user",
      subjectId: args.granteeId,
    });
    return null;
  },
});

/**
 * Asking for the pen from a read-only project, and the owner's answer.
 *
 * A request needs no new capability of its own: only someone who can already
 * see the project can ask about it, and granting reaches for `grantedRole` on
 * the claim they already have — so the answer promotes one person rather than
 * widening a link. Nothing here is a door: a denial leaves them exactly the
 * viewer or commenter they were.
 */

/** Who is asking, as the owner's toast draws them. */
async function requesterCard(ctx: QueryCtx, request: Doc<"accessRequests">) {
  const [person, project] = await Promise.all([
    personOf(ctx, request.requesterId),
    ctx.db.get(request.projectId),
  ]);
  return {
    requestId: request._id,
    projectId: request.projectId,
    projectTitle: project?.title ?? "",
    ...person,
    createdAt: request.createdAt,
  };
}

/**
 * "May I edit this?" — only someone without the pen — a viewer or a
 * commenter — has anything to ask, and asking twice is
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
    if (role === "owner" || role === "editor") return null;

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
      workspaceId: project.workspaceId,
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
 * Everyone waiting on the caller, across every project they manage — the
 * owner's inbox, which is why it is keyed on the owner rather than on a
 * project: the toast has to find them wherever they are standing, including
 * the project list.
 *
 * Two doors in: the projects they created, and every workspace they run. A
 * workspace project's creator is not necessarily one of the people who can
 * answer it, so each request is asked whether the caller manages its project
 * now rather than trusted for the index it came through.
 */
export const incomingRequests = query({
  args: {},
  handler: async (ctx) => {
    const me = await ownerId(ctx);
    if (!me) return [];
    const mine = await ctx.db
      .query("accessRequests")
      .withIndex("by_owner_and_status", (q) =>
        q.eq("projectOwnerId", me).eq("status", "pending"),
      )
      .collect();
    const seats = await ctx.db
      .query("memberships")
      .withIndex("by_user_status", (q) => q.eq("userId", me).eq("status", "active"))
      .collect();
    const theirs = await Promise.all(
      seats
        .filter((seat) => seat.role === "owner" || seat.role === "admin")
        .map((seat) =>
          ctx.db
            .query("accessRequests")
            .withIndex("by_workspace_and_status", (q) =>
              q.eq("workspaceId", seat.workspaceId).eq("status", "pending"),
            )
            .collect(),
        ),
    );

    const seen = new Set<string>();
    const requests: Doc<"accessRequests">[] = [];
    for (const request of [...mine, ...theirs.flat()]) {
      if (seen.has(request._id)) continue;
      seen.add(request._id);
      if (await readManageable(ctx, "projects", request.projectId)) requests.push(request);
    }
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
    const request = await ctx.db.get(args.requestId);
    if (!request) throw new Error("Not found");
    const project = await requireManageable(ctx, "projects", request.projectId);

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
    await recordInProject(ctx, project, {
      action: args.grant ? "share.request.grant" : "share.request.deny",
      subjectKind: "user",
      subjectId: request.requesterId,
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
