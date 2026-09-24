import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  activeMembership,
  atLeast,
  domainOf,
  domainSeat,
  invitedSeat,
  mayAssignSeat,
  ownerId as currentOwner,
  requireOwner,
  requireWorkspaceRole,
  verifiedEmail,
  workspaceRole,
  type WorkspaceRole,
} from "./auth";
import { record, recordInProject } from "./workspaceAudit";
import { normalizeEmail, NOT_AN_EMAIL, plausibleEmail } from "./emails";
import { unlinkRepo } from "./github/repos";
import { unlinkPage } from "./notion/context";
import { ensureArrivalProfile, personOf } from "./profiles";
import { invitedRole, memberRole } from "./schema";
import { scheduleSeatSync } from "./teamBilling";

/**
 * Who is in a workspace, and the three ways in: an invitation bound to one
 * email address, a join domain, or being made an owner when it was created.
 * The way out is removal or leaving, and both run the same cascade
 * (`unseat`). What a seat lets anyone do is `auth.ts`'s to say.
 */

const INVITATION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The people list's order: owners first, guests last. */
const LISTED: WorkspaceRole[] = ["owner", "admin", "member", "guest"];

/** Someone's row in a workspace whatever its status — the one row per person. */
async function seatOf(ctx: QueryCtx, workspaceId: Id<"workspaces">, userId: string) {
  return await ctx.db
    .query("memberships")
    .withIndex("by_workspace_user", (q) =>
      q.eq("workspaceId", workspaceId).eq("userId", userId),
    )
    .unique();
}

/** Longest-standing first. */
async function ownersOf(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
  const owners = await ctx.db
    .query("memberships")
    .withIndex("by_workspace_status_role", (q) =>
      q.eq("workspaceId", workspaceId).eq("status", "active").eq("role", "owner"),
    )
    .collect();
  return owners.sort((a, b) => a.joinedAt - b.joinedAt || a._creationTime - b._creationTime);
}

const pending = (invitation: Doc<"invitations">) =>
  invitation.acceptedAt === undefined && invitation.revokedAt === undefined;

/** The address an invitation is kept under, refused unless it could be one. */
function invitedEmail(raw: string): string {
  if (!plausibleEmail(raw)) throw new ConvexError(NOT_AN_EMAIL);
  return normalizeEmail(raw);
}

/** `ada@acme.com` → `a••@acme.com`: enough to recognise an account, not to learn one. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const hidden = Math.min(Math.max(local.length - 1, 2), 6);
  return `${local.slice(0, 1)}${"•".repeat(hidden)}${email.slice(at)}`;
}

/**
 * Puts someone in: a new row, or their old one back. A seat already held is
 * left as it is — a way in is never a way up, and `setRole` is the one place
 * a seat changes rank.
 */
async function giveSeat(
  ctx: MutationCtx,
  seat: Doc<"memberships"> | null,
  workspaceId: Id<"workspaces">,
  userId: string,
  role: WorkspaceRole,
  invitedBy?: string,
) {
  const now = Date.now();
  if (!seat) {
    await ctx.db.insert("memberships", {
      workspaceId,
      userId,
      role,
      status: "active",
      invitedBy,
      joinedAt: now,
    });
  } else if (seat.status === "removed") {
    await ctx.db.patch(seat._id, {
      role,
      status: "active",
      invitedBy,
      joinedAt: now,
      removedAt: undefined,
      removedBy: undefined,
    });
  }
  await scheduleSeatSync(ctx, workspaceId);
}

/**
 * Where someone just let in lands, as the switcher lists a workspace — enough
 * for the page they go to next to draw before it has asked for itself. A seat
 * already held keeps its rank (`giveSeat`), so that is the rank reported.
 */
function arrival(
  workspace: Doc<"workspaces">,
  seat: Doc<"memberships"> | null,
  role: WorkspaceRole,
) {
  return {
    workspaceId: workspace._id,
    slug: workspace.slug,
    name: workspace.name,
    role: seat?.status === "active" ? seat.role : role,
  };
}

/**
 * Takes a seat away, and with it everything that seat was the reason for.
 *
 * - Projects they made in the workspace pass to `heir`, and so do the access
 *   requests waiting on those projects, so the creator's own inbox stops
 *   finding them. Pages and folders keep their `ownerId`: nothing reads it
 *   for access, and NML migration keys on it.
 * - Repositories and Notion pages they linked with their own connection are
 *   unlinked: it stops serving the workspace when they stop being in it —
 *   and they could no longer unlink them themselves. A repository read
 *   through the workspace's GitHub App stays; the App is the workspace's.
 * - Their share-link claims and access requests on the workspace's projects
 *   go, or the link path would hand back what the seat just lost. Claims on
 *   anyone else's projects stay.
 * - Invitations they sent and nobody has answered are withdrawn.
 *
 * Their threads, turns and checkpoints stay theirs but unreadable: `readOwned`
 * asks for a live role on the project they were made in.
 */
async function unseat(
  ctx: MutationCtx,
  seat: Doc<"memberships">,
  removedBy: string,
  heir: string,
) {
  const { workspaceId, userId } = seat;
  const now = Date.now();
  await ctx.db.patch(seat._id, { status: "removed", removedAt: now, removedBy });
  await scheduleSeatSync(ctx, workspaceId);

  const projects = await ctx.db
    .query("projects")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  const reason =
    removedBy === userId ? "linked by a member who left" : "linked by a member who was removed";
  for (const project of projects) {
    const repos = await ctx.db
      .query("projectRepos")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .collect();
    for (const repo of repos) {
      if (repo.ownerId !== userId || repo.installationId !== undefined) continue;
      await unlinkRepo(ctx, repo._id);
      await recordInProject(
        ctx,
        project,
        {
          action: "repo.unlink",
          subjectKind: "repo",
          subjectId: repo._id,
          meta: { repo: repo.fullName, reason },
        },
        removedBy,
      );
    }
    const pages = await ctx.db
      .query("projectNotion")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .collect();
    for (const page of pages) {
      if (page.ownerId !== userId) continue;
      await unlinkPage(ctx, page);
      await recordInProject(
        ctx,
        project,
        {
          action: "notion.unlink",
          subjectKind: "notion",
          subjectId: page._id,
          meta: { page: page.title, reason },
        },
        removedBy,
      );
    }

    if (project.ownerId !== userId) continue;
    await ctx.db.patch(project._id, { ownerId: heir });
    const requests = await ctx.db
      .query("accessRequests")
      .withIndex("by_project_and_requester", (q) => q.eq("projectId", project._id))
      .collect();
    for (const request of requests) {
      await ctx.db.patch(request._id, { projectOwnerId: heir });
    }
  }

  const inWorkspace = async (projectId: Id<"projects">) =>
    (await ctx.db.get(projectId))?.workspaceId === workspaceId;
  const claims = await ctx.db
    .query("shareClaims")
    .withIndex("by_grantee", (q) => q.eq("granteeId", userId))
    .collect();
  for (const claim of claims) {
    if (await inWorkspace(claim.projectId)) await ctx.db.delete(claim._id);
  }
  const asked = await ctx.db
    .query("accessRequests")
    .withIndex("by_requester_and_status", (q) => q.eq("requesterId", userId))
    .collect();
  for (const request of asked) {
    if (await inWorkspace(request.projectId)) await ctx.db.delete(request._id);
  }

  await withdrawSent(ctx, workspaceId, userId, null);
}

/**
 * Withdraws the open invitations someone sent that a seat of rank `role`
 * could not send — every one, once they hold no seat. An invitation speaks
 * with its sender's authority only while they still have it: kept past a
 * demotion, it would go on handing out the rank the demotion took away.
 */
async function withdrawSent(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  userId: string,
  role: WorkspaceRole | null,
) {
  const invitations = await ctx.db
    .query("invitations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  const now = Date.now();
  for (const invitation of invitations) {
    if (invitation.invitedBy !== userId || !pending(invitation)) continue;
    if (role && mayAssignSeat(role, null, invitation.role)) continue;
    await ctx.db.patch(invitation._id, { revokedAt: now });
  }
}

/**
 * The people in a workspace, for anyone with a member's seat or better —
 * guests see the projects they were let into, not who else is here. Admins
 * also get the invitations still open, with their links, since handing a link
 * out again is what an admin does with one. Null for anyone else.
 */
export const list = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const role = await workspaceRole(ctx, args.workspaceId);
    if (!role || !atLeast(role, "member")) return null;
    const me = await currentOwner(ctx);

    const seats = await ctx.db
      .query("memberships")
      .withIndex("by_workspace_status_role", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("status", "active"),
      )
      .collect();
    const members = await Promise.all(
      seats.map(async (seat) => {
        const person = await personOf(ctx, seat.userId);
        return {
          userId: seat.userId,
          role: seat.role,
          joinedAt: seat.joinedAt,
          ...person,
          isMe: seat.userId === me,
        };
      }),
    );
    members.sort(
      (a, b) =>
        LISTED.indexOf(a.role) - LISTED.indexOf(b.role) ||
        (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? "") ||
        a.joinedAt - b.joinedAt,
    );

    const invitations = atLeast(role, "admin")
      ? (
          await ctx.db
            .query("invitations")
            .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
            .collect()
        )
          .filter(pending)
          .map((invitation) => ({
            invitationId: invitation._id,
            email: invitation.email,
            role: invitation.role,
            token: invitation.token,
            createdAt: invitation.createdAt,
            expiresAt: invitation.expiresAt,
          }))
      : [];

    return { role, members, invitations };
  },
});

/**
 * Asks an email address in. Admins invite members and guests; only an owner
 * invites an admin. Asking an address that already has an open invitation
 * renews that one — a new link, a fresh fortnight, the role asked for now —
 * so the old link stops working and the list never shows the same person
 * twice. `replaced` says a link that still worked has stopped, so the inviter
 * can be told the one they may have sent is dead.
 */
export const invite = mutation({
  args: { workspaceId: v.id("workspaces"), email: v.string(), role: invitedRole },
  handler: async (ctx, args) => {
    const { workspace, membership } = await requireWorkspaceRole(ctx, args.workspaceId, "admin");
    const email = invitedEmail(args.email);
    const open = (
      await ctx.db
        .query("invitations")
        .withIndex("by_email", (q) => q.eq("email", email))
        .collect()
    ).find((invitation) => invitation.workspaceId === args.workspaceId && pending(invitation));
    if (!mayAssignSeat(membership.role, open?.role ?? null, args.role)) {
      throw new ConvexError(
        args.role === "admin"
          ? "Only a workspace owner can invite an admin."
          : "Only a workspace owner can change an admin’s invitation.",
      );
    }

    const seats = await ctx.db
      .query("memberships")
      .withIndex("by_workspace_status_role", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("status", "active"),
      )
      .collect();
    for (const seat of seats) {
      if ((await personOf(ctx, seat.userId)).email?.toLowerCase() === email) {
        throw new ConvexError(`${email} is already in ${workspace.name}.`);
      }
    }

    const token = crypto.randomUUID();
    const now = Date.now();
    const fields = {
      role: args.role,
      token,
      invitedBy: membership.userId,
      createdAt: now,
      expiresAt: now + INVITATION_DAYS * DAY_MS,
    };
    const logInvite = (invitationId: Id<"invitations">) =>
      record(ctx, {
        workspaceId: args.workspaceId,
        actorId: membership.userId,
        action: "member.invite",
        subjectKind: "invitation",
        subjectId: invitationId,
        meta: { email, role: args.role, renewed: !!open },
      });
    if (open) {
      await ctx.db.patch(open._id, fields);
      await logInvite(open._id);
      return {
        invitationId: open._id,
        token,
        expiresAt: fields.expiresAt,
        replaced: open.expiresAt > now,
      };
    }
    const invitationId = await ctx.db.insert("invitations", {
      workspaceId: args.workspaceId,
      email,
      ...fields,
    });
    await logInvite(invitationId);
    return { invitationId, token, expiresAt: fields.expiresAt, replaced: false };
  },
});

export const revokeInvite = mutation({
  args: { invitationId: v.id("invitations") },
  handler: async (ctx, args) => {
    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation) throw new Error("Not found");
    const { membership } = await requireWorkspaceRole(ctx, invitation.workspaceId, "admin");
    if (!mayAssignSeat(membership.role, invitation.role, null)) {
      throw new ConvexError("Only a workspace owner can withdraw an admin’s invitation.");
    }
    if (invitation.acceptedAt !== undefined) {
      throw new ConvexError("That invitation has already been accepted.");
    }
    if (invitation.revokedAt === undefined) {
      await ctx.db.patch(invitation._id, { revokedAt: Date.now() });
      await record(ctx, {
        workspaceId: invitation.workspaceId,
        actorId: membership.userId,
        action: "member.invite.revoke",
        subjectKind: "invitation",
        subjectId: invitation._id,
        meta: { email: invitation.email, role: invitation.role },
      });
    }
    return null;
  },
});

/**
 * What the invitation page shows. Someone signed in as anyone but the address
 * it was sent to learns only that it is for another account, and which one in
 * outline — not the workspace, not who sent it — so a forwarded or leaked
 * link reveals nothing. A sign-in that vouches for no address at all — none
 * given, or one not verified — is told that instead, since it may well be the
 * right person, and learns no more. Null for a token that names no
 * invitation, or nobody signed in.
 */
export const invitation = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const me = await currentOwner(ctx);
    if (!me) return null;
    const invitation = await ctx.db
      .query("invitations")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    const workspace = invitation && (await ctx.db.get(invitation.workspaceId));
    if (!invitation || !workspace) return null;

    const email = await verifiedEmail(ctx);
    if (email === null) return { state: "unconfirmed" as const };
    if (email !== invitation.email) {
      return { state: "wrong-account" as const, email: maskEmail(invitation.email) };
    }
    // In the order `acceptInvite` asks, so the page says what accepting would.
    const seat = await seatOf(ctx, workspace._id, me);
    const role = invitedSeat(invitation, seat);
    // A deleted workspace first: it withdrew every invitation as it went, and
    // there is nobody left in it to ask for another.
    const state =
      workspace.deletedAt !== undefined
        ? ("gone" as const)
        : invitation.revokedAt !== undefined
          ? ("revoked" as const)
          : invitation.acceptedAt !== undefined || seat?.status === "active"
            ? ("accepted" as const)
            : !role
              ? ("revoked" as const)
              : invitation.expiresAt <= Date.now()
                ? ("expired" as const)
                : ("valid" as const);
    const inviter = await personOf(ctx, invitation.invitedBy);
    return {
      state,
      email: invitation.email,
      role: role ?? invitation.role,
      workspaceName: workspace.name,
      inviterName: inviter.name ?? inviter.email,
      // Where to go once in: only for someone who is.
      slug:
        state === "accepted" && (await workspaceRole(ctx, workspace._id))
          ? workspace.slug
          : null,
    };
  },
});

/**
 * Takes the seat an invitation offers — `invitedSeat` says which. The
 * signed-in address must be the one it was sent to, verified — the token
 * alone is not enough, so a link that travels further than intended admits no
 * one else. Accepting twice, or while already in, is answered with the
 * workspace again.
 */
export const acceptInvite = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const me = await requireOwner(ctx);
    const invitation = await ctx.db
      .query("invitations")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    const workspace = invitation && (await ctx.db.get(invitation.workspaceId));
    if (!invitation || !workspace || workspace.deletedAt !== undefined) {
      throw new Error("Not found");
    }
    if ((await verifiedEmail(ctx, { now: Date.now() })) !== invitation.email) {
      throw new ConvexError("This invitation is for another account.");
    }
    if (invitation.revokedAt !== undefined) {
      throw new ConvexError("This invitation was withdrawn.");
    }
    const seat = await seatOf(ctx, workspace._id, me);
    if (invitation.acceptedAt !== undefined) {
      if (invitation.acceptedBy === me && seat?.status === "active") {
        return arrival(workspace, seat, seat.role);
      }
      throw new ConvexError("This invitation has already been used.");
    }
    const role = invitedSeat(invitation, seat);
    if (!role) throw new ConvexError("This invitation was withdrawn.");
    if (seat?.status !== "active" && invitation.expiresAt <= Date.now()) {
      throw new ConvexError("This invitation has expired. Ask for a new one.");
    }

    await giveSeat(ctx, seat, workspace._id, me, role, invitation.invitedBy);
    await ctx.db.patch(invitation._id, { acceptedAt: Date.now(), acceptedBy: me });
    if (seat?.status !== "active") {
      await record(ctx, {
        workspaceId: workspace._id,
        actorId: me,
        action: "member.join",
        subjectKind: "user",
        subjectId: me,
        meta: {
          via: "invitation",
          role,
          email: invitation.email,
          invitedBy: invitation.invitedBy,
          invitationId: invitation._id,
        },
      });
    }
    await ensureArrivalProfile(ctx, me);
    return arrival(workspace, seat, role);
  },
});

/**
 * Doors open to the caller that they have not walked through: invitations to
 * their address, and workspaces their address's domain lets them join. For
 * the switcher's "Join" rows.
 */
export const joinable = query({
  args: {},
  handler: async (ctx) => {
    const me = await currentOwner(ctx);
    const email = await verifiedEmail(ctx);
    if (!me || !email) return [];
    const now = Date.now();
    const doors: {
      workspaceId: Id<"workspaces">;
      name: string;
      role: WorkspaceRole;
      via: "invitation" | "domain";
      token: string | null;
    }[] = [];

    const invitations = await ctx.db
      .query("invitations")
      .withIndex("by_email", (q) => q.eq("email", email))
      .collect();
    for (const invitation of invitations) {
      if (!pending(invitation) || invitation.expiresAt <= now) continue;
      const workspace = await ctx.db.get(invitation.workspaceId);
      if (!workspace || workspace.deletedAt !== undefined) continue;
      const seat = await seatOf(ctx, workspace._id, me);
      const role = invitedSeat(invitation, seat);
      if (seat?.status === "active" || !role) continue;
      doors.push({
        workspaceId: workspace._id,
        name: workspace.name,
        role,
        via: "invitation",
        token: invitation.token,
      });
    }

    const domains = await ctx.db
      .query("workspaceDomains")
      .withIndex("by_domain", (q) => q.eq("domain", domainOf(email)))
      .collect();
    for (const { workspaceId } of domains) {
      if (doors.some((door) => door.workspaceId === workspaceId)) continue;
      const workspace = await ctx.db.get(workspaceId);
      const seat = await seatOf(ctx, workspaceId, me);
      if (!workspace || seat?.status === "active") continue;
      const role = domainSeat(workspace, email, seat);
      if (role) doors.push({ workspaceId, name: workspace.name, role, via: "domain", token: null });
    }

    return doors.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * Walks through a join domain, into the seat `domainSeat` names. Joining twice
 * is harmless. An invitation still open to the same address is answered by
 * the arrival: left open, it would be a second way in, waiting for whatever
 * happens to the seat next.
 */
export const joinByDomain = mutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const me = await requireOwner(ctx);
    const now = Date.now();
    const email = await verifiedEmail(ctx, { now });
    const workspace = await ctx.db.get(args.workspaceId);
    const seat = await seatOf(ctx, args.workspaceId, me);
    const role = workspace && domainSeat(workspace, email, seat);
    if (!workspace || !email || !role) throw new Error("Not found");
    if (seat?.status !== "active") {
      await giveSeat(ctx, seat, workspace._id, me, role);
      await record(ctx, {
        workspaceId: workspace._id,
        actorId: me,
        action: "member.join",
        subjectKind: "user",
        subjectId: me,
        meta: { via: "domain", role, email },
      });
    }

    const invitations = await ctx.db
      .query("invitations")
      .withIndex("by_email", (q) => q.eq("email", email))
      .collect();
    for (const invitation of invitations) {
      if (invitation.workspaceId === workspace._id && pending(invitation)) {
        await ctx.db.patch(invitation._id, { acceptedAt: now, acceptedBy: me });
      }
    }
    await ensureArrivalProfile(ctx, me);
    return arrival(workspace, seat, role);
  },
});

/**
 * Changes someone's role. Admins move people between member and guest;
 * making or unmaking an admin or an owner is an owner's. A workspace always
 * keeps an owner: an owner can step down only once there is another. The
 * invitations they sent that their new rank could not send go with the old
 * one.
 */
export const setRole = mutation({
  args: { workspaceId: v.id("workspaces"), userId: v.string(), role: memberRole },
  handler: async (ctx, args) => {
    const { membership } = await requireWorkspaceRole(ctx, args.workspaceId, "admin");
    const target = await activeMembership(ctx, args.workspaceId, args.userId);
    if (!target) throw new Error("Not found");
    if (target.role === args.role) return null;
    if (!mayAssignSeat(membership.role, target.role, args.role)) {
      throw new ConvexError(
        target.userId === membership.userId
          ? "You can’t change your own role."
          : "Only a workspace owner can do that.",
      );
    }
    if (target.role === "owner" && (await ownersOf(ctx, args.workspaceId)).length < 2) {
      throw new ConvexError("A workspace needs an owner. Make someone else an owner first.");
    }
    await ctx.db.patch(target._id, { role: args.role });
    await record(ctx, {
      workspaceId: args.workspaceId,
      actorId: membership.userId,
      action: "member.role",
      subjectKind: "user",
      subjectId: target.userId,
      meta: { from: target.role, to: args.role },
    });
    await withdrawSent(ctx, args.workspaceId, target.userId, args.role);
    await scheduleSeatSync(ctx, args.workspaceId);
    return null;
  },
});

/**
 * Removes someone. Admins remove members and guests; an admin or an owner is
 * removed by an owner. Whatever the removed person made passes to whoever
 * removed them.
 */
export const remove = mutation({
  args: { workspaceId: v.id("workspaces"), userId: v.string() },
  handler: async (ctx, args) => {
    const { membership } = await requireWorkspaceRole(ctx, args.workspaceId, "admin");
    if (args.userId === membership.userId) {
      throw new ConvexError("To leave a workspace, use Leave instead.");
    }
    const target = await activeMembership(ctx, args.workspaceId, args.userId);
    if (!target) throw new Error("Not found");
    if (!mayAssignSeat(membership.role, target.role, null)) {
      throw new ConvexError("Only a workspace owner can remove an admin or an owner.");
    }
    await unseat(ctx, target, membership.userId, membership.userId);
    await record(ctx, {
      workspaceId: args.workspaceId,
      actorId: membership.userId,
      action: "member.remove",
      subjectKind: "user",
      subjectId: target.userId,
      meta: { role: target.role },
    });
    return null;
  },
});

/**
 * Leaves a workspace. What the leaver made passes to its longest-standing
 * owner; the last owner cannot leave, since a workspace nobody runs is one
 * nobody can delete.
 */
export const leave = mutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const { membership } = await requireWorkspaceRole(ctx, args.workspaceId, "guest");
    const heir = (await ownersOf(ctx, args.workspaceId)).find(
      (owner) => owner.userId !== membership.userId,
    );
    if (!heir) {
      throw new ConvexError(
        "You’re the only owner. Make someone else an owner first, or delete the workspace.",
      );
    }
    await unseat(ctx, membership, membership.userId, heir.userId);
    await record(ctx, {
      workspaceId: args.workspaceId,
      actorId: membership.userId,
      action: "member.leave",
      subjectKind: "user",
      subjectId: membership.userId,
      meta: { role: membership.role, heir: heir.userId },
    });
    return null;
  },
});
