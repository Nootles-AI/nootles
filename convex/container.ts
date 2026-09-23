import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { claimRole, linksOpen, seatRole, type ProjectRole } from "./auth";

/**
 * Who a project's container knows — the one answer to "who can I mention",
 * and to "may this person be told about a comment here".
 *
 * The Teams design turns every project into a container: a person's account,
 * or a workspace. Its membership is what a mention menu lists, and asking the
 * same question with two lookups would give the product two answers to it. So
 * there is one resolver, keyed by container kind, and every caller asks the
 * same functions.
 */

export type Container =
  | { kind: "account"; userId: string }
  | { kind: "workspace"; workspaceId: Id<"workspaces"> };

export function containerOf(project: Doc<"projects">): Container {
  return project.workspaceId
    ? { kind: "workspace", workspaceId: project.workspaceId }
    : { kind: "account", userId: project.ownerId };
}

export type Member = {
  /** Clerk subject. */
  userId: string;
  /** What they are to the project now, as their own session would resolve it. */
  role: ProjectRole;
};

export type Person = Member & { name: string | null; imageUrl: string | null };

/**
 * Everyone who can open the project. A personal project's people are its
 * owner, first, and the claimants whose claim still resolves — a claim whose
 * links were all revoked admits nobody (`auth.claimRole`), so it lists nobody
 * either. A workspace project's are the seats its container gives a role
 * (`auth.seatRole`), then whoever its links let in while the workspace allows
 * them. A viewer is here: they can open the project, and so can read the
 * thread they were named in.
 */
export async function containerMembers(
  ctx: QueryCtx,
  project: Doc<"projects">,
): Promise<Member[]> {
  const container = containerOf(project);
  const members: Member[] = [];
  const inBySeat = new Set<string>();
  if (container.kind === "account") {
    members.push({ userId: container.userId, role: "owner" });
    inBySeat.add(container.userId);
  } else {
    const seats = await ctx.db
      .query("memberships")
      .withIndex("by_workspace_status_role", (q) =>
        q.eq("workspaceId", container.workspaceId).eq("status", "active"),
      )
      .collect();
    for (const seat of seats) {
      const role = seatRole(project, seat.userId, seat);
      if (role) {
        members.push({ userId: seat.userId, role });
        inBySeat.add(seat.userId);
      }
    }
    if (!(await linksOpen(ctx, project))) return members;
  }
  const claims = await ctx.db
    .query("shareClaims")
    .withIndex("by_project_and_grantee", (q) => q.eq("projectId", project._id))
    .collect();
  const now = Date.now();
  for (const claim of claims) {
    const role = claimRole(project, claim, now);
    if (role && !inBySeat.has(claim.granteeId)) {
      members.push({ userId: claim.granteeId, role });
    }
  }
  return members;
}

/** The same people, with the name and face their profile carries. */
export async function mentionablePeople(
  ctx: QueryCtx,
  project: Doc<"projects">,
): Promise<Person[]> {
  const members = await containerMembers(ctx, project);
  return await Promise.all(
    members.map(async (member) => {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_owner", (q) => q.eq("ownerId", member.userId))
        .unique();
      return {
        ...member,
        name: profile?.name ?? null,
        imageUrl: profile?.imageUrl ?? null,
      };
    }),
  );
}
