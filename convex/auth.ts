import { ConvexError } from "convex/values";
import type { Auth, UserIdentity } from "convex/server";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

/**
 * All tenancy lives here: every row carries the Clerk subject that created it,
 * and these functions are the only way to reach one. Going through them —
 * rather than comparing `ownerId` by hand at each call site — is what keeps
 * the check from being forgotten.
 *
 * Two families. The `Owned` family answers "is this mine": personal rows
 * (threads, checkpoints, profiles) never widen past their creator. The
 * `visible`/`editable` family answers "what am I to this project": sharing
 * grants a role per project (owner / editor / viewer), and anything reachable
 * through a project resolves its access through that role.
 */

/** Tables whose rows are owned. Derived, so a new table joins by having the field. */
export type Owned = {
  [K in TableNames]: Doc<K> extends { ownerId: string } ? K : never;
}[TableNames];

/**
 * The signed-in subject, or null. Null is routine rather than exceptional:
 * queries subscribe before Clerk has resolved a token, so reads have to be able
 * to answer "nobody yet" without throwing.
 */
export async function ownerId(ctx: { auth: Auth }): Promise<string | null> {
  return (await ctx.auth.getUserIdentity())?.subject ?? null;
}

/**
 * The operator standing in for this identity, or null for an ordinary session.
 *
 * A stand-in token (minted by `impersonationMint.ts`, issued by this very
 * deployment) carries the same `sub` as the user it answers for — which is what
 * makes every read resolve to their rows without a single call site knowing —
 * plus an `act` claim naming who is really behind it. Convex passes unknown
 * claims through untouched, so `act` is the one thing that distinguishes the
 * two, and it is deliberately flat: a string reads without narrowing, and this
 * is consulted on the hot path of every write.
 */
export function actorOf(identity: UserIdentity): string | null {
  return typeof identity.act === "string" ? identity.act : null;
}

/** The message a stand-in session gets instead of a write. */
/**
 * `ConvexError`, so the sentence survives. A production deployment redacts a
 * plain `Error`'s message, and this one is written to be read: the alternative
 * is an operator watching an edit fail as "Server Error" and wondering whether
 * the app is broken rather than whether they are standing in.
 */
const READ_ONLY = () =>
  new ConvexError("Read-only: this session is an operator standing in for you.");

/**
 * The whole of what makes impersonation safe.
 *
 * Every gate below that admits a WRITE calls this, so read-only is a property
 * of the four functions that grant write scope rather than something 139
 * mutations have to remember. A new mutation cannot opt out of it without
 * hand-rolling its own authorization, which is already the thing this file
 * exists to prevent.
 */
export async function refuseStandIn(ctx: { auth: Auth }): Promise<void> {
  if (await standInActor(ctx)) throw READ_ONLY();
}

/**
 * The same question asked without consequence, for the handful of places that
 * must bend rather than break: the presence heartbeat (an operator must not
 * appear in the user's own facepile) and the chrome that says whose account
 * you are looking at.
 */
export async function standInActor(ctx: { auth: Auth }): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  return identity ? actorOf(identity) : null;
}

/** For anything that writes — an unauthenticated write is never valid. */
export async function requireOwner(ctx: { auth: Auth }): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not signed in");
  if (actorOf(identity)) throw READ_ONLY();
  return identity.subject;
}

/**
 * The row, if it exists and belongs to the caller. Missing and not-yours both
 * answer null, so a stranger cannot probe which ids exist.
 *
 * `table` goes unused at runtime; it binds the type parameter so callers get
 * back a `Doc<"pages">` rather than a union of every owned table.
 */
/**
 * Whether a row is soft-deleted. Central so every access path answers the
 * same: a stamped row reads as missing everywhere except `trash.ts`, which
 * is the one module allowed to see the other side.
 */
export function isTrashed(doc: object): boolean {
  return "deletedAt" in doc && doc.deletedAt !== undefined;
}

export async function readOwned<T extends Owned>(
  ctx: QueryCtx,
  table: T,
  id: Id<T>,
): Promise<Doc<T> | null> {
  const owner = await ownerId(ctx);
  if (!owner) return null;
  const doc = await ctx.db.get(id);
  return doc && doc.ownerId === owner && !isTrashed(doc) ? doc : null;
}

/**
 * The same lookup, for callers that cannot proceed without the row — which in
 * practice means the ones about to write it. That is why this refuses an
 * operator's stand-in and `readOwned` does not: they are read scope and write
 * scope, and the two must never collapse into one check. The two queries that
 * legitimately need a throwing read (`share.links`, `share.collaborators`) say
 * so with `readOwned` and their own throw.
 */
export async function requireOwned<T extends Owned>(
  ctx: QueryCtx,
  table: T,
  id: Id<T>,
): Promise<Doc<T>> {
  await refuseStandIn(ctx);
  const doc = await readOwned(ctx, table, id);
  if (!doc) throw new Error("Not found");
  return doc;
}

/**
 * Ranked owner > editor > commenter > viewer. A commenter reads everything a
 * viewer does and may write one thing more: the threads in a page's comments
 * document (`prosemirror.channelAdmits`) — never the page itself, which is why
 * `requireEditable` does not admit them. It is the comment link's role.
 */
export type ProjectRole = "owner" | "editor" | "commenter" | "viewer";

/**
 * What the caller is to a loaded project.
 *
 * A claim names the role of the link it came through, but permission is always
 * re-derived against the tokens that are live NOW: killing the editor or the
 * comment link demotes its claimants to viewers while any link is still on
 * (the same move as Google downgrading a link from editor to viewer), and
 * killing every link closes the project to everyone but the owner. A claim row
 * alone admits nobody.
 *
 * `grantedRole` is the one thing a link does not decide: the owner answering
 * an access request hands the pen to one person, and no link turns on for it.
 * It survives the editor link being revoked — it was never that link's doing —
 * but not the project being unshared entirely, so revoking is still the one
 * move that closes the door on everybody at once.
 */
export async function roleForProject(
  ctx: QueryCtx,
  project: Doc<"projects">,
): Promise<ProjectRole | null> {
  const me = await ownerId(ctx);
  if (!me) return null;
  if (project.ownerId === me) return "owner";
  const claim = await ctx.db
    .query("shareClaims")
    .withIndex("by_project_and_grantee", (q) =>
      q.eq("projectId", project._id).eq("granteeId", me),
    )
    .unique();
  return claim ? claimRole(project, claim) : null;
}

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
 * Whether a role may remove other people's comments and threads: whoever
 * holds the pen on the page. Nobody may rewrite another person's words; what
 * else a comments append may change is `comments/policy.ts`, asked by
 * `ydoc.append` with this answer.
 */
export function moderatesComments(role: ProjectRole | null): boolean {
  return role === "owner" || role === "editor";
}

/**
 * Whether any share link on the project is live — the condition every claim
 * and the anonymous document read are contingent on.
 */
export function hasLiveLink(project: Doc<"projects">): boolean {
  return Boolean(project.shareToken || project.editShareToken || project.commentShareToken);
}

/** The caller's role in a project named by id, or null for missing/stranger. */
export async function projectRole(
  ctx: QueryCtx,
  projectId: Id<"projects">,
): Promise<ProjectRole | null> {
  const project = await ctx.db.get(projectId);
  return project ? await roleForProject(ctx, project) : null;
}

/**
 * Whether the caller may read a project's audit log: its owner, in their own
 * session. Not editors or commenters — the log names who did what across
 * everyone's access, which is the owner's to hold — and not an operator
 * standing in, whose reading someone's record is not something the owner's
 * token should vouch for. A trashed project has no log to read.
 *
 * The one place the answer lives, so the Teams workspace branch (a
 * workspace's admins read its projects' logs) is one more clause here.
 */
export async function mayReadAudit(
  ctx: QueryCtx,
  project: Doc<"projects">,
): Promise<boolean> {
  if (isTrashed(project) || (await standInActor(ctx))) return false;
  return (await roleForProject(ctx, project)) === "owner";
}

/** Tables that resolve their access through a project's role. */
type Shared = "projects" | "pages" | "folders";

async function projectOf<T extends Shared>(
  ctx: QueryCtx,
  doc: Doc<T>,
): Promise<Doc<"projects"> | null> {
  // TS cannot relate the generic Doc<T> to the closed union, hence the hop.
  const row = doc as unknown as Doc<"projects"> | Doc<"pages"> | Doc<"folders">;
  return "projectId" in row ? await ctx.db.get(row.projectId) : row;
}

/**
 * The row, if the caller holds any role on its project. The sibling of
 * `readOwned` for surfaces a share recipient may see; missing and
 * not-visible-to-you both answer null, so a stranger cannot probe which ids
 * exist.
 *
 * `table` goes unused at runtime, same as in `readOwned`: it binds the type
 * parameter so callers get back the table's own `Doc`.
 */
export async function readVisible<T extends Shared>(
  ctx: QueryCtx,
  table: T,
  id: Id<T>,
): Promise<Doc<T> | null> {
  const doc = (await ctx.db.get(id)) as Doc<T> | null;
  if (!doc || isTrashed(doc)) return null;
  const project = await projectOf(ctx, doc);
  if (!project || isTrashed(project)) return null;
  return (await roleForProject(ctx, project)) ? doc : null;
}

/**
 * The row, provided the caller may WRITE under its project — owner or editor.
 * Deliberately a separate gate from `requireOwned` rather than a loosening of
 * it: read scope and write scope must never be one check that drifts.
 */
export async function requireEditable<T extends Shared>(
  ctx: QueryCtx,
  table: T,
  id: Id<T>,
): Promise<Doc<T>> {
  await refuseStandIn(ctx);
  const doc = (await ctx.db.get(id)) as Doc<T> | null;
  if (doc && !isTrashed(doc)) {
    const project = await projectOf(ctx, doc);
    if (project && !isTrashed(project)) {
      const role = await roleForProject(ctx, project);
      if (role === "owner" || role === "editor") return doc;
    }
  }
  throw new Error("Not found");
}

/**
 * The page and its project, provided the caller may write its comments —
 * commenter, editor or owner. The comments document's own gate is the
 * channel check in `prosemirror.ts`; this is its sibling for the mutations
 * that act on a page's comments by page id rather than by docId.
 */
export async function requireCommentable(
  ctx: QueryCtx,
  pageId: Id<"pages">,
): Promise<{ page: Doc<"pages">; project: Doc<"projects"> }> {
  await refuseStandIn(ctx);
  const page = await ctx.db.get(pageId);
  if (page && !isTrashed(page)) {
    const project = await ctx.db.get(page.projectId);
    if (project && !isTrashed(project)) {
      const role = await roleForProject(ctx, project);
      if (channelAdmits({ channel: "comments", access: "write", role, linkLive: false })) {
        return { page, project };
      }
    }
  }
  throw new Error("Not found");
}
