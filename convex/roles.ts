import type { Doc } from "./_generated/dataModel";

/**
 * The pure half of `auth.ts`: what a role is, what a claim grants, what a
 * channel admits and how workspace seats rank, as decisions over rows already
 * loaded. Kept free of any import that defines a Convex function, so a
 * browser — the comment UI's access, the workspace screens' seat rules, the
 * harnesses' stand-in gate — holds the very same rule without bundling the
 * server. `auth.ts` re-exports all of it and remains the only place access is
 * resolved.
 */

/**
 * Ranked owner > editor > commenter > viewer. A commenter reads everything a
 * viewer does and may write one thing more: the threads in a page's comments
 * document (`prosemirror.channelAdmits`) — never the page itself, which is why
 * `requireEditable` does not admit them. It is the comment link's role.
 */
export type ProjectRole = "owner" | "editor" | "commenter" | "viewer";

/** A share link, by the role it admits. */
export type LinkRole = "viewer" | "commenter" | "editor";

/** Where each link keeps its token and its expiry on the project row. */
export const LINK_FIELDS = {
  viewer: { token: "shareToken", expiresAt: "shareExpiresAt" },
  commenter: { token: "commentShareToken", expiresAt: "commentShareExpiresAt" },
  editor: { token: "editShareToken", expiresAt: "editShareExpiresAt" },
} as const;

/** Whether a project's link of this role is on and has not run out. */
export function linkLive(project: Doc<"projects">, role: LinkRole, now: number): boolean {
  const { token, expiresAt } = LINK_FIELDS[role];
  const until = project[expiresAt];
  return !!project[token] && (until === undefined || until > now);
}

/**
 * What a claim grants on its project at `now` — `roleForProject` for someone
 * other than the caller, so the owner's list of who has access gives the same
 * answer each claimant's own session gets. Whether the project's links admit
 * anyone at all (`auth.linksOpen`) is the caller's to have asked first.
 *
 * A claim that has run out grants nothing, and neither does one whose link has
 * run out — a revoked link is different: its claimants are still viewers
 * while another link is on.
 */
export function claimRole(
  project: Doc<"projects">,
  claim: Doc<"shareClaims">,
  now: number,
): Exclude<ProjectRole, "owner"> | null {
  if (!project.shareToken && !project.editShareToken && !project.commentShareToken) return null;
  if (claim.grantedRole === "editor") return "editor";
  if (claim.expiresAt !== undefined && claim.expiresAt <= now) return null;
  const cameBy = project[LINK_FIELDS[claim.role].expiresAt];
  if (cameBy !== undefined && cameBy <= now) return null;
  if (claim.role === "editor" && linkLive(project, "editor", now)) return "editor";
  // A claim records one link, so an editor whose link dies is a viewer even
  // while the comment link lives — until they open that link, which
  // `share.claim` then records. Nothing here may assume they ever held it.
  if (claim.role === "commenter" && linkLive(project, "commenter", now)) return "commenter";
  return hasLiveLink(project, now) ? "viewer" : null;
}

/**
 * Which of a page's two Yjs documents a docId names: the page itself, or its
 * comment threads. Decided by `prosemirror.pageAndChannelForDoc` from which
 * index matched — never from the id's spelling.
 */
export type DocChannel = "document" | "comments";

/**
 * The whole rule for reaching a page's documents, as a pure decision so it can
 * be read in one place and tested without a database.
 *
 * - Any resolved role reads either channel.
 * - The document channel writes for editor and owner; the comments channel for
 *   commenter, editor and owner.
 * - With no role, a live share link still admits a READ of the document —
 *   the docId is the capability there (see `prosemirror.checkRead`) — but
 *   never of the comments. A signed-out link visitor has no identity to be
 *   answerable for a conversation with, so comments fail closed until links
 *   require sign-in.
 *
 * The stand-in rule is not here: it depends on the session, not the role, and
 * the gates apply it before asking this.
 */
export function channelAdmits(request: {
  channel: DocChannel;
  access: "read" | "write";
  role: ProjectRole | null;
  /** Whether the project has any live share link. */
  linkLive: boolean;
}): boolean {
  const { channel, access, role, linkLive } = request;
  if (access === "read") return role !== null || (channel === "document" && linkLive);
  if (role === "owner" || role === "editor") return true;
  return channel === "comments" && role === "commenter";
}

/**
 * The `ConvexError` code of a document append refused for who is asking: the
 * pen was taken — a link run out, a demotion, a project trashed. A retry
 * cannot land it, so the provider holds the change and says so rather than
 * retrying it forever (`YConvexProvider`).
 */
export const WRITE_REFUSED = "write_refused";

/**
 * Whether a role may remove other people's comments and threads: whoever
 * holds the pen on the page. Nobody may rewrite another person's words; what
 * else a comments append may change is `comments/policy.ts`, asked by
 * `ydoc.append` with this answer.
 */
export function moderatesComments(role: ProjectRole | null): boolean {
  return role === "owner" || role === "editor";
}

/**
 * Whether any share link on the project is live at `now` — the condition every
 * claim and the anonymous document read are contingent on.
 */
export function hasLiveLink(project: Doc<"projects">, now: number): boolean {
  return (Object.keys(LINK_FIELDS) as LinkRole[]).some((role) => linkLive(project, role, now));
}

/** A seat in a workspace, ranked owner > admin > member > guest. */
export type WorkspaceRole = Doc<"memberships">["role"];

const SEAT_RANK: Record<WorkspaceRole, number> = { guest: 0, member: 1, admin: 2, owner: 3 };

/** Whether a seat reaches `min`. No seat reaches anything. */
export function atLeast(role: WorkspaceRole | null, min: WorkspaceRole): boolean {
  return role !== null && SEAT_RANK[role] >= SEAT_RANK[min];
}

/**
 * Whether a seat of rank `actor` may move someone's seat from `from` to `to`.
 * An invitation is a seat from nobody (`from` null) and a removal a seat to
 * nobody (`to` null). Admins run the members and the guests; admins and
 * owners are the owners' to appoint and dismiss, so no admin promotes someone
 * to their own rank or removes a peer.
 */
export function mayAssignSeat(
  actor: WorkspaceRole,
  from: WorkspaceRole | null,
  to: WorkspaceRole | null,
): boolean {
  if (actor === "owner") return true;
  const belowAdmin = (role: WorkspaceRole | null) => role === null || !atLeast(role, "admin");
  return actor === "admin" && belowAdmin(from) && belowAdmin(to);
}

/** The domain of an address, for a workspace's join domains. */
export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

