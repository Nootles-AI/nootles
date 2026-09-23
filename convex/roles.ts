import type { Doc } from "./_generated/dataModel";

/**
 * The pure half of `auth.ts`: what a role is, what a claim grants and what a
 * channel admits, as decisions over rows already loaded. Kept free of any
 * import that defines a Convex function, so a browser — the comment UI's
 * access, the harnesses' stand-in gate — holds the very same rule. `auth.ts`
 * re-exports all of it and remains the only place access is resolved.
 */

/**
 * Ranked owner > editor > commenter > viewer. A commenter reads everything a
 * viewer does and may write one thing more: the threads in a page's comments
 * document (`prosemirror.channelAdmits`) — never the page itself, which is why
 * `requireEditable` does not admit them. It is the comment link's role.
 */
export type ProjectRole = "owner" | "editor" | "commenter" | "viewer";

/**
 * What a claim grants on its project now — `roleForProject` for someone other
 * than the caller, so the owner's list of who has access gives the same answer
 * each claimant's own session gets.
 */
export function claimRole(
  project: Doc<"projects">,
  claim: Doc<"shareClaims">,
): Exclude<ProjectRole, "owner"> | null {
  if (!hasLiveLink(project)) return null;
  if (claim.grantedRole === "editor") return "editor";
  if (claim.role === "editor" && project.editShareToken) return "editor";
  // A claim records one link, so an editor whose link dies is a viewer even
  // while the comment link lives — until they open that link, which
  // `share.claim` then records. Nothing here may assume they ever held it.
  if (claim.role === "commenter" && project.commentShareToken) return "commenter";
  return "viewer";
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
 * Whether any share link on the project is live — the condition every claim
 * and the anonymous document read are contingent on.
 */
export function hasLiveLink(project: Doc<"projects">): boolean {
  return Boolean(project.shareToken || project.editShareToken || project.commentShareToken);
}
