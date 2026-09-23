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
 * `visible`/`editable`/`manageable` family answers "what am I to this
 * project": a role per project (owner / editor / viewer), resolved from the
 * project's container — its creator's account, or a workspace seat — and
 * then from share links. Anything reachable through a project resolves its
 * access through that role.
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
 * Whether a row is soft-deleted. Central so every access path answers the
 * same: a stamped row reads as missing everywhere except `trash.ts`, which
 * is the one module allowed to see the other side.
 */
export function isTrashed(doc: object): boolean {
  return "deletedAt" in doc && doc.deletedAt !== undefined;
}

/**
 * The row, if it exists and belongs to the caller. Missing and not-yours both
 * answer null, so a stranger cannot probe which ids exist.
 *
 * `table` goes unused at runtime; it binds the type parameter so callers get
 * back a `Doc<"pages">` rather than a union of every owned table.
 */
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

export type WorkspaceRole = Doc<"memberships">["role"];

const RANK: Record<WorkspaceRole, number> = { guest: 0, member: 1, admin: 2, owner: 3 };

/**
 * Someone's live seat in a workspace, or null.
 *
 * Reads the membership row and nothing else, because this sits on the path of
 * every document read in a workspace project: were it to read the workspace
 * row too, an admin flipping one setting would re-run every open document's
 * subscription. A deleted workspace needs no look here — deleting it retires
 * every seat in the same mutation.
 */
export async function activeMembership(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  userId: string,
): Promise<Doc<"memberships"> | null> {
  const seat = await ctx.db
    .query("memberships")
    .withIndex("by_workspace_user", (q) =>
      q.eq("workspaceId", workspaceId).eq("userId", userId),
    )
    .unique();
  return seat?.status === "active" ? seat : null;
}

/**
 * The caller's seat in a workspace, for surfaces about the workspace itself
 * (its settings, its people). Null for signed out, never a member, removed,
 * or a deleted workspace — all four read as "no such workspace".
 */
export async function workspaceRole(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<WorkspaceRole | null> {
  const me = await ownerId(ctx);
  if (!me) return null;
  const workspace = await ctx.db.get(workspaceId);
  if (!workspace || workspace.deletedAt !== undefined) return null;
  return (await activeMembership(ctx, workspaceId, me))?.role ?? null;
}

/**
 * The gate for acting on a workspace: a seat at `min` or above
 * (owner > admin > member > guest). Someone with no seat learns nothing — the
 * same "Not found" as a workspace that does not exist — while a member short
 * of the rank is told so, since they already know the workspace is there.
 */
export async function requireWorkspaceRole(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  min: WorkspaceRole,
): Promise<{ workspace: Doc<"workspaces">; membership: Doc<"memberships"> }> {
  await refuseStandIn(ctx);
  const me = await ownerId(ctx);
  const workspace = await ctx.db.get(workspaceId);
  const membership =
    me && workspace && workspace.deletedAt === undefined
      ? await activeMembership(ctx, workspaceId, me)
      : null;
  if (!workspace || !membership) throw new Error("Not found");
  if (RANK[membership.role] < RANK[min]) {
    throw new ConvexError(
      min === "member" ? "A guest can’t do that here." : `Only a workspace ${min} can do that.`,
    );
  }
  return { workspace, membership };
}

export type ProjectRole = "owner" | "editor" | "viewer";

/**
 * What the caller is to a loaded project.
 *
 * The container answers first. A personal project's owner is its creator. A
 * workspace project's owners are the workspace's owners and admins; a member
 * edits it, unless it is private and someone else's; a guest holds nothing by
 * their seat. The creator of a workspace project is NOT its owner — that is
 * the whole difference between the two containers — and neither is anyone
 * whose seat was taken away, whatever the row says.
 *
 * Share links answer for everyone the container did not. A claim names the
 * role of the link it came through, but permission is always
 * re-derived against the tokens that are live NOW: killing the editor link
 * demotes its claimants to viewers while any link is still on (the same move
 * as Google downgrading a link from editor to viewer), and killing both links
 * closes the project to everyone but the owner. A claim row alone admits
 * nobody.
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
  if (project.workspaceId) {
    const seat = await activeMembership(ctx, project.workspaceId, me);
    if (seat?.role === "owner" || seat?.role === "admin") return "owner";
    if (
      seat?.role === "member" &&
      (project.visibility !== "private" || project.ownerId === me)
    ) {
      return "editor";
    }
  } else if (project.ownerId === me) {
    return "owner";
  }
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
): "editor" | "viewer" | null {
  if (!project.shareToken && !project.editShareToken) return null;
  if (claim.grantedRole === "editor") return "editor";
  if (claim.role === "editor" && project.editShareToken) return "editor";
  return "viewer";
}

/**
 * The caller's role in a project named by id, or null for missing, trashed or
 * stranger — a trashed project is nobody's to act in until it is restored.
 */
export async function projectRole(
  ctx: QueryCtx,
  projectId: Id<"projects">,
): Promise<ProjectRole | null> {
  const project = await ctx.db.get(projectId);
  return project && !isTrashed(project) ? await roleForProject(ctx, project) : null;
}

/** Tables that resolve their access through a project's role. */
type Shared = "projects" | "pages" | "folders";

/** Tables whose every row hangs off one project. Derived, like `Owned`. */
type ProjectScoped = {
  [K in TableNames]: Doc<K> extends { projectId: Id<"projects"> } ? K : never;
}[TableNames];

async function projectOf<T extends "projects" | ProjectScoped>(
  ctx: QueryCtx,
  doc: Doc<T>,
): Promise<Doc<"projects"> | null> {
  // TS cannot relate the generic Doc<T> to the closed union, hence the hop.
  const row = doc as unknown as Doc<"projects"> | { projectId: Id<"projects"> };
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
 * The row, if the caller may MANAGE its project — rename or delete it, share
 * it, answer its access requests, choose what context it reads. That is role
 * "owner": a personal project's creator, a workspace's owners and admins. The
 * read half, so an operator's stand-in can still see who a project is shared
 * with; `requireManageable` is the write half.
 *
 * Works for the project itself and for any row hanging off one (a linked
 * repository, a context file), because those answer to the project's role
 * rather than to whoever's `ownerId` they carry.
 */
export async function readManageable<T extends "projects" | ProjectScoped>(
  ctx: QueryCtx,
  table: T,
  id: Id<T>,
): Promise<Doc<T> | null> {
  const doc = (await ctx.db.get(id)) as Doc<T> | null;
  if (!doc || isTrashed(doc)) return null;
  const project = await projectOf(ctx, doc);
  if (!project || isTrashed(project)) return null;
  return (await roleForProject(ctx, project)) === "owner" ? doc : null;
}

export async function requireManageable<T extends "projects" | ProjectScoped>(
  ctx: QueryCtx,
  table: T,
  id: Id<T>,
): Promise<Doc<T>> {
  await refuseStandIn(ctx);
  const doc = await readManageable(ctx, table, id);
  if (!doc) throw new Error("Not found");
  return doc;
}

/**
 * {@link readManageable}'s question for a project in the trash, which that
 * gate reads as missing — asked only by `trash.restore`, the one module
 * allowed past the stamp.
 */
export async function managesProject(
  ctx: QueryCtx,
  project: Doc<"projects">,
): Promise<boolean> {
  return (await roleForProject(ctx, project)) === "owner";
}
