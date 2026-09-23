import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { claimRole, type ProjectRole } from "./auth";

/**
 * Who a project's container knows — the one answer to "who can I mention",
 * and to "may this person be told about a comment here".
 *
 * The Teams design turns every project into a container: a person's account
 * today, a workspace once Teams lands. Its membership is what a mention menu
 * lists, and asking the same question with two lookups would give the product
 * two answers to it. So there is one resolver, keyed by container kind; the
 * workspace branch joins `containerOf` and `containerMembers`, and every
 * caller keeps asking the same functions.
 */

export type Container = { kind: "account"; userId: string };

export function containerOf(project: Doc<"projects">): Container {
  return { kind: "account", userId: project.ownerId };
}

export type Member = {
  /** Clerk subject. */
  userId: string;
  /** What they are to the project now, as their own session would resolve it. */
  role: ProjectRole;
};

export type Person = Member & { name: string | null; imageUrl: string | null };

/**
 * Everyone who can open the project, owner first. A personal project's
 * people are its owner and the claimants whose claim still resolves — a claim
 * whose links were all revoked admits nobody (`auth.claimRole`), so it lists
 * nobody either. A viewer is here: they can open the project, and so can read
 * the thread they were named in.
 */
export async function containerMembers(
  ctx: QueryCtx,
  project: Doc<"projects">,
): Promise<Member[]> {
  const container = containerOf(project);
  const members: Member[] = [{ userId: container.userId, role: "owner" }];
  const claims = await ctx.db
    .query("shareClaims")
    .withIndex("by_project_and_grantee", (q) => q.eq("projectId", project._id))
    .collect();
  for (const claim of claims) {
    const role = claimRole(project, claim);
    if (role && claim.granteeId !== container.userId) {
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
