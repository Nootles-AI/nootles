import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { activeMembership, claimOf, claimRole, linksOpen, seatRole, type ProjectRole } from "./auth";
import { personOf } from "./profiles";

/**
 * Who a project's container knows — the one answer to "who can I mention",
 * and to "may this person be told about a comment here".
 *
 * A project lives in a person's account or in a workspace. Its people are
 * whoever its container gives a role — the account's owner, or the
 * workspace's seats as `auth.seatRole` reads them, so a private project lists
 * only its admins and its creator — and then whoever a share link let in,
 * while the project's links admit anyone. Each is exactly the role their own
 * session would resolve (`auth.roleForProject`), so a mention menu never
 * offers someone a notice's link would not open for.
 */

export type Member = {
  /** Clerk subject. */
  userId: string;
  /** What they are to the project now, as their own session would resolve it. */
  role: ProjectRole;
};

export type Person = Member & { name: string | null; imageUrl: string | null };

/**
 * Everyone who can open the project, owners first. A claim whose links were
 * all revoked, or have run out, admits nobody (`auth.claimRole`), so it lists
 * nobody either. A viewer is here: they can open the project, and so can read
 * the thread they were named in.
 */
export async function containerMembers(
  ctx: QueryCtx,
  project: Doc<"projects">,
): Promise<Member[]> {
  const members: Member[] = [];
  const seated = new Set<string>();
  if (project.workspaceId) {
    const { workspaceId } = project;
    const seatsAs = (role?: Doc<"memberships">["role"]) =>
      ctx.db
        .query("memberships")
        .withIndex("by_workspace_status_role", (q) => {
          const active = q.eq("workspaceId", workspaceId).eq("status", "active");
          return role ? active.eq("role", role) : active;
        })
        .collect();
    // A private project is its owners', its admins' and its creator's alone,
    // so it reads those seats rather than every member's.
    const seats =
      project.visibility === "private"
        ? [
            ...(await seatsAs("owner")),
            ...(await seatsAs("admin")),
            ...[await activeMembership(ctx, workspaceId, project.ownerId)].filter(
              (seat): seat is Doc<"memberships"> => seat?.role === "member",
            ),
          ]
        : await seatsAs();
    for (const seat of seats) {
      const role = seatRole(project, seat.userId, seat);
      if (!role) continue;
      seated.add(seat.userId);
      members.push({ userId: seat.userId, role });
    }
  } else {
    seated.add(project.ownerId);
    members.push({ userId: project.ownerId, role: "owner" });
  }
  if (!(await linksOpen(ctx, project))) return ranked(members);
  const claims = await ctx.db
    .query("shareClaims")
    .withIndex("by_project_and_grantee", (q) => q.eq("projectId", project._id))
    .collect();
  const now = Date.now();
  for (const claim of claims) {
    // A seat that gives a role answers for its holder whatever they claimed;
    // a guest's gives none, so their claim does (`roleForProject`).
    if (seated.has(claim.granteeId)) continue;
    const role = claimRole(project, claim, now);
    if (role) members.push({ userId: claim.granteeId, role });
  }
  return ranked(members);
}

const RANK: Record<ProjectRole, number> = { owner: 0, editor: 1, commenter: 2, viewer: 3 };

function ranked(members: Member[]): Member[] {
  return members.sort((a, b) => RANK[a.role] - RANK[b.role]);
}

/**
 * One person's role in the project, or null — {@link containerMembers} asked
 * of a single id, as point reads, for callers checking a few names against a
 * workspace that may seat many.
 */
export async function memberRole(
  ctx: QueryCtx,
  project: Doc<"projects">,
  userId: string,
): Promise<ProjectRole | null> {
  const seat = project.workspaceId ? await activeMembership(ctx, project.workspaceId, userId) : null;
  const role = seatRole(project, userId, seat);
  if (role) return role;
  const claim = await claimOf(ctx, project._id, userId);
  if (!claim || !(await linksOpen(ctx, project))) return null;
  return claimRole(project, claim, Date.now());
}

/** The same people, with the name and face they are known by. */
export async function mentionablePeople(
  ctx: QueryCtx,
  project: Doc<"projects">,
): Promise<Person[]> {
  const members = await containerMembers(ctx, project);
  return await Promise.all(
    members.map(async (member) => {
      const { name, imageUrl } = await personOf(ctx, member.userId);
      return { ...member, name, imageUrl };
    }),
  );
}
