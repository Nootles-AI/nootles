import { atLeast, mayAssignSeat, type WorkspaceRole } from "@/convex/auth";

/**
 * What the members screens offer whom, in words.
 *
 * The rules are `auth.ts`'s — `mayAssignSeat` is the one the server holds
 * every invitation, role change and removal to — and these only read them
 * ahead of time, so a choice the server would refuse is drawn refused, with
 * its reason, rather than offered and then refused. Nothing here decides
 * anything the server does not decide again.
 */

export const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

export const ROLE_HINT: Record<WorkspaceRole, string> = {
  owner: "Runs everything, down to deleting the workspace",
  admin: "Invites people and runs the workspace’s settings",
  member: "Sees the workspace’s projects and makes new ones",
  guest: "Sees only the projects shared with them",
};

/** The same, said to whoever is offered the seat, of the workspace as "it". */
export const ROLE_OFFER: Record<WorkspaceRole, string> = {
  owner: "You’ll run everything in it, down to deleting it.",
  admin: "You’ll see its projects, invite people and run its settings.",
  member: "You’ll see its projects and can make new ones.",
  guest: "You’ll see only the projects shared with you.",
};

/** The seats a menu offers. Guests are in the schema, not in the menus. */
const OFFERED: readonly WorkspaceRole[] = ["owner", "admin", "member"];

/** What an invitation can ask someone in as, from this screen. */
export const INVITED = ["member", "admin"] as const;
export type Invited = (typeof INVITED)[number];

/** A role on offer, and why it is refused — null when it is not. */
export type Choice = { role: WorkspaceRole; why: string | null };

export type Person = { role: WorkspaceRole; isMe: boolean };

/**
 * How many owners a workspace has, since the last one is never unmade, and
 * how many people in all, since the last one has nobody to hand it to.
 */
export type Headcount = { owners: number; people: number };

/** Why the one owner can do nothing to their own seat. */
function onlyOwner(count: Headcount): string {
  return count.people < 2
    ? "You’re the only one in this workspace. Invite someone and make them an owner first."
    : "You’re the only owner. Make someone else an owner first.";
}

const an = (role: WorkspaceRole) =>
  `${role === "admin" || role === "owner" ? "an" : "a"} ${role}`;

/**
 * The roles `actor` may move `target` between, in the order the menu lists
 * them — the one they hold included, and a guest's own seat kept on the list
 * so it has somewhere to be ticked.
 */
export function roleChoices(actor: WorkspaceRole, target: Person, count: Headcount): Choice[] {
  const roles = target.role === "guest" ? [...OFFERED, "guest" as const] : OFFERED;
  return roles.map((role) => ({ role, why: roleProblem(actor, target, role, count) }));
}

function roleProblem(
  actor: WorkspaceRole,
  target: Person,
  role: WorkspaceRole,
  count: Headcount,
): string | null {
  if (role === target.role) return null;
  if (target.isMe && actor !== "owner") return "You can’t change your own role.";
  if (!mayAssignSeat(actor, target.role, role)) {
    return atLeast(target.role, "admin")
      ? `Only an owner can change ${an(target.role)}’s role.`
      : `Only an owner can make someone ${an(role)}.`;
  }
  if (target.role === "owner" && count.owners < 2) {
    return target.isMe
      ? onlyOwner(count)
      : "A workspace needs an owner. Make someone else an owner first.";
  }
  return null;
}

/**
 * A person's menu's refusals, each said once. When every seat it refuses is
 * refused for one reason, that reason heads the menu instead of repeating
 * under each — and the way out, refused for that reason and something more,
 * says only the more, as a sentence of its own (`apart`): it sits rows below
 * the caption, so it cannot read on from it. The one owner's own row is
 * refused everything because they are the one owner, and leaving says where
 * the other way out is (`LEAVE_INSTEAD`).
 */
export function sayOnce(
  choices: readonly Choice[],
  out: string | null,
  apart: string | null = null,
): { caption: string | null; out: string | null } {
  const reasons = choices.flatMap((c) => (c.why ? [c.why] : []));
  const caption = reasons.length > 1 && reasons.every((r) => r === reasons[0]) ? reasons[0] : null;
  if (!caption || !out) return { caption, out };
  return { caption, out: out.startsWith(caption.replace(/\.$/, "")) ? apart : out };
}

/** Why `actor` may not take `target`'s seat away, or null when they may. */
export function removeProblem(actor: WorkspaceRole, target: WorkspaceRole): string | null {
  return mayAssignSeat(actor, target, null) ? null : `Only an owner can remove ${an(target)}.`;
}

/** Why someone of rank `role` may not leave, or null when they may. */
export function leaveProblem(role: WorkspaceRole, count: Headcount): string | null {
  return role === "owner" && count.owners < 2
    ? `${onlyOwner(count).replace(/\.$/, "")}, or delete the workspace.`
    : null;
}

/** The rest of `leaveProblem`, for under a caption that has said why. */
export const LEAVE_INSTEAD = "You can delete the workspace instead, under General.";

/** Why `actor` may not ask someone in as `role`, or null when they may. */
export function inviteProblem(actor: WorkspaceRole, role: WorkspaceRole): string | null {
  return mayAssignSeat(actor, null, role) ? null : `Only an owner can invite ${an(role)}.`;
}

/**
 * Why `actor` may not withdraw or renew an invitation for `role`, or null
 * when they may. Renewing sends the same role again, which is the same
 * question as sending it.
 */
export function invitationProblem(actor: WorkspaceRole, role: WorkspaceRole): string | null {
  return mayAssignSeat(actor, role, null)
    ? null
    : `Only an owner can change ${an(role)}’s invitation.`;
}

/**
 * Who inherits what a leaving member made: the longest-standing owner who is
 * not them, as `members.leave` picks. Null while there is nobody else.
 */
export function heirOf<T extends Person & { joinedAt: number }>(people: readonly T[]): T | null {
  return (
    people
      .filter((p) => p.role === "owner" && !p.isMe)
      .sort((a, b) => a.joinedAt - b.joinedAt)[0] ?? null
  );
}

const DAY_MS = 86_400_000;

/** How long an invitation has left, as the list's column says it. */
export function expiresIn(expiresAt: number, now: number): string {
  const left = expiresAt - now;
  if (left <= 0) return "Expired";
  if (left < DAY_MS) return "Today";
  const days = Math.round(left / DAY_MS);
  return days === 1 ? "In 1 day" : `In ${days} days`;
}
