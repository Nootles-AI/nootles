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
 * Owned tables whose `ownerId` does NOT say who may act on the row. Projects,
 * pages and folders carry their creator (or the project's, copied); a linked
 * repository, file or Notion page carries whose credential or upload it is;
 * the context sheet copies the project's. Every one of them is the project's
 * to govern, so it answers to the project's role — and `readOwned` refuses
 * them at the type level, because on a workspace project `ownerId` equality
 * would hand the creator what belongs to the workspace's admins.
 */
type ProjectGoverned =
  | Shared
  | "contextSheet"
  | "projectRepos"
  | "projectFiles"
  | "projectNotion";

/** Rows that really are one person's own: threads, checkpoints, accounts. */
type Personal = Exclude<Owned, ProjectGoverned>;

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
 * A row made inside a project stays yours only while the project does: it
 * has to be live, and you have to still hold a role on it. That is what takes
 * a removed member's conversations and checkpoints — which quote the
 * project's pages and code verbatim — away with their seat.
 *
 * `table` goes unused at runtime; it binds the type parameter so callers get
 * back a `Doc<"chatThreads">` rather than a union of every owned table.
 */
export async function readOwned<T extends Personal>(
  ctx: QueryCtx,
  table: T,
  id: Id<T>,
): Promise<Doc<T> | null> {
  const owner = await ownerId(ctx);
  if (!owner) return null;
  const doc = await ctx.db.get(id);
  if (!doc || doc.ownerId !== owner || isTrashed(doc)) return null;
  const project = await projectMadeIn(ctx, doc);
  if (project === undefined) return doc;
  if (!project || isTrashed(project)) return null;
  return (await roleForProject(ctx, project)) ? doc : null;
}

/**
 * The project a personal row was made in: directly, or through the page or
 * thread it hangs off. Undefined for rows that belong to no project at all.
 */
async function projectMadeIn(
  ctx: QueryCtx,
  row: object,
): Promise<Doc<"projects"> | null | undefined> {
  const { projectId, pageId, threadId } = row as {
    projectId?: Id<"projects">;
    pageId?: Id<"pages">;
    threadId?: Id<"chatThreads">;
  };
  if (projectId) return await ctx.db.get(projectId);
  const parent = pageId
    ? await ctx.db.get(pageId)
    : threadId
      ? await ctx.db.get(threadId)
      : undefined;
  if (parent === undefined) return undefined;
  return parent && (await ctx.db.get(parent.projectId));
}

/**
 * The same lookup, for callers that cannot proceed without the row — which in
 * practice means the ones about to write it. That is why this refuses an
 * operator's stand-in and `readOwned` does not: they are read scope and write
 * scope, and the two must never collapse into one check. The queries that
 * legitimately need a throwing read (`share.links`, `share.collaborators`) say
 * so with the read gate and their own throw.
 */
export async function requireOwned<T extends Personal>(
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
  if (!atLeast(membership.role, min)) {
    throw new ConvexError(
      min === "member" ? "A guest can’t do that here." : `Only a workspace ${min} can do that.`,
    );
  }
  return { workspace, membership };
}

/** Whether a seat reaches `min`. No seat reaches anything. */
export function atLeast(role: WorkspaceRole | null, min: WorkspaceRole): boolean {
  return role !== null && RANK[role] >= RANK[min];
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

/**
 * How long Clerk's word on an address stands without being asked again:
 * three of `identity.sync`'s daily re-checks, so Clerk can be down for a day
 * or two before anyone notices. It bounds how long an address taken off a
 * Clerk account can go on admitting its old holder when the Clerk webhook
 * misses the change and their client stops asking.
 */
export const STAMP_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The caller's email address, lowercased, when their sign-in vouches for it.
 * This is what an invitation is bound to and what proves a join domain, so an
 * address the token calls unverified is no answer.
 *
 * The token speaks first, when it carries the claim at all. A session token
 * with no email in it — Clerk's default — falls back to what `identity.sync`
 * last confirmed with Clerk itself, which the client has no way to write.
 *
 * A gate that admits someone passes `now` — a mutation may read the clock —
 * and a stamp older than `STAMP_MAX_AGE_MS` by then is no answer. A query may
 * not, so it takes the stamp as it stands, and `identity.expire` takes the
 * address off a stamp once it passes that age.
 */
export async function verifiedEmail(
  ctx: QueryCtx,
  { now }: { now?: number } = {},
): Promise<string | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  if (identity.email && identity.emailVerified !== false) {
    return identity.email.trim().toLowerCase();
  }
  const stamped = await ctx.db
    .query("identities")
    .withIndex("by_owner", (q) => q.eq("ownerId", identity.subject))
    .unique();
  if (!stamped?.verifiedEmail) return null;
  if (now !== undefined && now - (stamped.verifiedEmailAt ?? 0) > STAMP_MAX_AGE_MS) return null;
  return stamped.verifiedEmail;
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

/**
 * The seat someone takes without an invitation, or null for none: auto-join
 * is on and their verified address is on one of the workspace's domains.
 * `seat` is their row, whatever its status, and an active one stays as it is.
 *
 * Someone who left may come back this way, but no higher than they left: a
 * guest returns a guest, or leaving and rejoining would undo an admin's
 * demotion. Someone an admin removed may not come back this way at all —
 * being on the domain is what let them in the first time, so it cannot be
 * what overrules the removal.
 */
export function domainSeat(
  workspace: Doc<"workspaces">,
  email: string | null,
  seat: Doc<"memberships"> | null,
): WorkspaceRole | null {
  if (!email || workspace.deletedAt !== undefined || !workspace.settings.autoJoin) return null;
  if (!workspace.settings.joinDomains.includes(domainOf(email))) return null;
  if (!seat) return "member";
  if (seat.status === "active") return seat.role;
  if (seat.removedBy !== seat.userId) return null;
  return seat.role === "guest" ? "guest" : "member";
}

/**
 * The seat an invitation gives the person it names, or null for none. `seat`
 * is their row, whatever its status.
 *
 * An invitation is a way in, never a promotion: someone already in keeps the
 * role they hold, which only `setRole` changes — or an invitation still open
 * from before a demotion would undo it. Whatever happened to a seat since the
 * invitation was sent is the later word on it: an admin's removal withdraws
 * it, and leaving caps it where `domainSeat` would, so leaving and coming back
 * undoes no demotion either. Only an invitation sent or renewed since gives
 * all it names.
 */
export function invitedSeat(
  invitation: Doc<"invitations">,
  seat: Doc<"memberships"> | null,
): WorkspaceRole | null {
  if (!seat) return invitation.role;
  if (seat.status === "active") return seat.role;
  if (invitation.createdAt >= (seat.removedAt ?? Infinity)) return invitation.role;
  if (seat.removedBy !== seat.userId) return null;
  const left = seat.role === "guest" ? "guest" : "member";
  return atLeast(invitation.role, left) ? left : invitation.role;
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
 * Share links answer for everyone the container did not, signed in, and only
 * while the project's links admit anyone at all (`linksOpen`). A claim names
 * the role of the link it came through, but permission is always
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
 *
 * The clock is read here, and only on this path: a seat never expires. A
 * query is not re-run merely because time passes, so a link that runs out
 * while a document is open refuses that session's next write at once, and
 * its reads the next time anything they read changes or the page reloads.
 */
export async function roleForProject(
  ctx: QueryCtx,
  project: Doc<"projects">,
): Promise<ProjectRole | null> {
  const me = await ownerId(ctx);
  if (!me) return null;
  const role = await containerRole(ctx, project, me);
  if (role) return role;
  const claim = await claimOf(ctx, project._id, me);
  if (!claim || !(await linksOpen(ctx, project))) return null;
  return claimRole(project, claim, Date.now());
}

/** Someone's claim on a project, whatever it grants now. */
export async function claimOf(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  granteeId: string,
): Promise<Doc<"shareClaims"> | null> {
  return await ctx.db
    .query("shareClaims")
    .withIndex("by_project_and_grantee", (q) =>
      q.eq("projectId", projectId).eq("granteeId", granteeId),
    )
    .unique();
}

export type LinkRole = "viewer" | "editor";

/** Where each link keeps its token and its expiry on the project row. */
export const LINK_FIELDS = {
  viewer: { token: "shareToken", expiresAt: "shareExpiresAt" },
  editor: { token: "editShareToken", expiresAt: "editShareExpiresAt" },
} as const;

/** Whether a project's link of this role is on and has not run out. */
export function linkLive(project: Doc<"projects">, role: LinkRole, now: number): boolean {
  const { token, expiresAt } = LINK_FIELDS[role];
  const until = project[expiresAt];
  return !!project[token] && (until === undefined || until > now);
}

/**
 * Whether a project's share links admit anyone at all. A personal project's
 * always may. A workspace's may while its admins allow links there: turning
 * that off stops every link and every claim made through one at once, and
 * deletes nothing, so turning it back on restores them as they were.
 *
 * The one read of the workspace row on a document's access path, and only on
 * the way in through a link — never for a seat (see `activeMembership`).
 */
export async function linksOpen(ctx: QueryCtx, project: Doc<"projects">): Promise<boolean> {
  if (!project.workspaceId) return true;
  const workspace = await ctx.db.get(project.workspaceId);
  return !!workspace && workspace.deletedAt === undefined && workspace.settings.linkSharing;
}

/**
 * The workspace whose paused share links are all that keep the caller out of
 * a project: they hold a claim that would admit them again the moment its
 * admins turn links back on. Null for anyone kept out by anything else. It
 * tells them nothing they did not hold already, since the claim is theirs.
 */
export async function pausedFor(
  ctx: QueryCtx,
  project: Doc<"projects">,
): Promise<Doc<"workspaces"> | null> {
  if (!project.workspaceId || isTrashed(project)) return null;
  const me = await ownerId(ctx);
  if (!me || (await containerRole(ctx, project, me))) return null;
  const claim = await claimOf(ctx, project._id, me);
  if (!claim || !claimRole(project, claim, Date.now())) return null;
  const workspace = await ctx.db.get(project.workspaceId);
  if (!workspace || workspace.deletedAt !== undefined || workspace.settings.linkSharing) {
    return null;
  }
  return workspace;
}

/** The role a project's container gives someone, before any share link is asked. */
export async function containerRole(
  ctx: QueryCtx,
  project: Doc<"projects">,
  me: string,
): Promise<ProjectRole | null> {
  const seat = project.workspaceId ? await activeMembership(ctx, project.workspaceId, me) : null;
  return seatRole(project, me, seat);
}

/**
 * What someone holds in a project without any link: its owner on a personal
 * project, or what their seat — `activeMembership` in the project's workspace,
 * read by the caller — gives them on a workspace's. Whoever it gives a role
 * never comes in by a link, so a claim of theirs would grant nothing and
 * taking it away would take nothing.
 */
export function seatRole(
  project: Doc<"projects">,
  userId: string,
  seat: Doc<"memberships"> | null,
): ProjectRole | null {
  if (!project.workspaceId) return project.ownerId === userId ? "owner" : null;
  if (seat?.role === "owner" || seat?.role === "admin") return "owner";
  if (seat?.role === "member" && (project.visibility !== "private" || project.ownerId === userId)) {
    return "editor";
  }
  return null;
}

/**
 * Whether the caller may read a project's linked repositories live — any
 * path, any ref, a code search — with the connection of whoever linked each.
 * That reaches past the context graph a share link reads (indexed files at
 * the default branch), so it goes no further than the project's container:
 * its owner, or a workspace seat that edits it. No share link, an editor's
 * included, spends someone else's GitHub connection this way. And it is code,
 * so `canReadCode` has to say yes as well.
 */
export async function readsLinkedCode(
  ctx: QueryCtx,
  projectId: Id<"projects">,
): Promise<boolean> {
  const me = await ownerId(ctx);
  const project = await ctx.db.get(projectId);
  if (!me || !project || isTrashed(project)) return false;
  return (await containerRole(ctx, project, me)) !== null && (await canReadCode(ctx, project));
}

/**
 * Whether the caller may read the repository half of a project's context:
 * the code map in every pack, code in search results and the graph, and an
 * indexed file's text. Pages and documents are not code, and stay readable to
 * every role; what this refuses is simply absent.
 *
 * A personal project's code is read by everyone it is shared with, as it
 * always was. A workspace's is its members' — subject to the workspace's
 * GitHub organisation rule — and a guest's only where the workspace lets
 * guests see code and a manager let this one. Someone in by link alone reads
 * none of it.
 */
export async function canReadCode(ctx: QueryCtx, project: Doc<"projects">): Promise<boolean> {
  if (isTrashed(project) || !(await roleForProject(ctx, project))) return false;
  if (!project.workspaceId) return true;
  const me = await ownerId(ctx);
  const seat = me && (await activeMembership(ctx, project.workspaceId, me));
  if (!me || !seat) return false;
  if (seat.role !== "guest") return await passesGithubOrgRule(ctx, seat);
  const workspace = await ctx.db.get(project.workspaceId);
  if (!workspace?.settings.guestCodeAccess) return false;
  return (await claimOf(ctx, project._id, me))?.codeAccess === true;
}

/**
 * The workspace's GitHub organisation rule (`settings.requireGithubOrg`), for
 * a member about to read code. The hook the GitHub App fills in, since only it
 * can check the rule; until then every member passes.
 */
async function passesGithubOrgRule(
  _ctx: QueryCtx,
  _seat: Doc<"memberships">,
): Promise<boolean> {
  return true;
}

/**
 * Why a manager may not let `granteeId` into a project's code, or null when
 * they may. Only a guest is ever let in this way — a member reads it already,
 * and someone in by link alone never does — and only while their workspace
 * allows it.
 */
export async function codeGrantRefusal(
  ctx: QueryCtx,
  project: Doc<"projects">,
  granteeId: string,
): Promise<string | null> {
  if (!project.workspaceId) {
    return "Everyone a personal project is shared with reads its code context already.";
  }
  const workspace = await ctx.db.get(project.workspaceId);
  if (!workspace?.settings.guestCodeAccess) {
    return "This workspace doesn’t let guests see code context.";
  }
  const seat = await activeMembership(ctx, project.workspaceId, granteeId);
  if (seat?.role !== "guest") return "Only a guest of the workspace can be given code context.";
  return null;
}

/**
 * What a claim grants on its project at `now` — `roleForProject` for someone
 * other than the caller, so the owner's list of who has access gives the same
 * answer each claimant's own session gets. Whether the project's links admit
 * anyone at all (`linksOpen`) is the caller's to have asked first.
 *
 * A claim that has run out grants nothing, and neither does one whose link has
 * run out — a revoked link is different: its claimants are still viewers
 * while the other link is on.
 */
export function claimRole(
  project: Doc<"projects">,
  claim: Doc<"shareClaims">,
  now: number,
): "editor" | "viewer" | null {
  if (!project.shareToken && !project.editShareToken) return null;
  if (claim.grantedRole === "editor") return "editor";
  if (claim.expiresAt !== undefined && claim.expiresAt <= now) return null;
  const cameBy = project[LINK_FIELDS[claim.role].expiresAt];
  if (cameBy !== undefined && cameBy <= now) return null;
  if (claim.role === "editor" && linkLive(project, "editor", now)) return "editor";
  return linkLive(project, "viewer", now) || linkLive(project, "editor", now) ? "viewer" : null;
}

/**
 * Whether the caller may read a project's documents — the check every sync
 * endpoint makes, since those are reached by docId rather than through a
 * page row. Anyone with a role may. So may anyone at all holding the docId of
 * a personal project's page while one of its links is live: there is no token
 * to inspect on those endpoints, so the docId, which `share.view` hands out
 * only while a link is live, is the capability. A workspace project's
 * documents open to no one signed out, and to no one without a role.
 */
export async function readsDocuments(ctx: QueryCtx, project: Doc<"projects">): Promise<boolean> {
  if (isTrashed(project)) return false;
  if (await roleForProject(ctx, project)) return true;
  if (project.workspaceId) return false;
  const now = Date.now();
  return linkLive(project, "viewer", now) || linkLive(project, "editor", now);
}

/**
 * What a live link shows the caller before anything is claimed. A personal
 * project's shows its whole tree to anyone, signed in or not. A workspace
 * project's shows nothing to someone signed out ("sign-in"), and to someone
 * signed in without a role only enough to claim it ("claim"): its pages are
 * for those who hold one.
 */
export async function linkShows(
  ctx: QueryCtx,
  project: Doc<"projects">,
): Promise<"tree" | "claim" | "sign-in"> {
  if (!project.workspaceId) return "tree";
  if (!(await ownerId(ctx))) return "sign-in";
  return (await roleForProject(ctx, project)) ? "tree" : "claim";
}

/**
 * Whether the caller may carry pages from project `from` into project `to` —
 * a copy, or a cut and paste. Within one workspace, or out of a personal
 * project, whoever can read them may. Out of a workspace, into a personal
 * project or another workspace, only its members may: a guest or someone in
 * by link reads what they were shown, and takes none of it away.
 */
export async function mayCarryOut(
  ctx: QueryCtx,
  from: Doc<"projects">,
  to: Doc<"projects">,
): Promise<boolean> {
  if (!from.workspaceId || from.workspaceId === to.workspaceId) return true;
  const me = await ownerId(ctx);
  const seat = me && (await activeMembership(ctx, from.workspaceId, me));
  return !!seat && seat.role !== "guest";
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
 * The row, if the caller holds a writing role — owner or editor — on its
 * project. The question without the gate: what a workspace pays for is the
 * work of the people who can write in its projects, and asking that must not
 * throw.
 */
export async function readEditable<T extends Shared>(
  ctx: QueryCtx,
  table: T,
  id: Id<T>,
): Promise<Doc<T> | null> {
  const doc = (await ctx.db.get(id)) as Doc<T> | null;
  if (!doc || isTrashed(doc)) return null;
  const project = await projectOf(ctx, doc);
  if (!project || isTrashed(project)) return null;
  const role = await roleForProject(ctx, project);
  return role === "owner" || role === "editor" ? doc : null;
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
  const doc = await readEditable(ctx, table, id);
  if (!doc) throw new Error("Not found");
  return doc;
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

/**
 * How long a project stays its creator's to take back without its managers.
 * Long enough for an import that failed partway to clean up after itself,
 * short enough that nothing a team came to rely on is still inside it.
 */
export const DISCARD_WINDOW_MS = 15 * 60 * 1000;

/**
 * The project, provided the caller may throw it away as never having happened:
 * they made it, a moment ago, and nobody else has laid a finger on it.
 *
 * This is how a member undoes their own failed import. In a workspace the
 * creator only edits a project — deleting one is its owners' and admins' —
 * so without this a run that stopped halfway would leave an empty project
 * behind that its maker cannot remove. Everything here narrows that one
 * exception back down to "nothing anyone could miss": the maker still writes
 * in it through their seat (a share link is no one's way to discard), the
 * window is short, and any trace of another person — a page they made, a
 * share or request, a conversation, context they attached, their cursor in a
 * page — makes it the project's managers' again.
 */
export async function requireDiscardable(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  now: number,
): Promise<Doc<"projects">> {
  await refuseStandIn(ctx);
  const me = await ownerId(ctx);
  const project = await ctx.db.get(projectId);
  if (!me || !project || isTrashed(project) || project.ownerId !== me) throw new Error("Not found");
  const role = await containerRole(ctx, project, me);
  if (role !== "owner" && role !== "editor") throw new Error("Not found");
  if (now - project.createdAt > DISCARD_WINDOW_MS) {
    throw new ConvexError("This project is too old to discard.");
  }
  if (await touchedByOthers(ctx, project, me)) {
    throw new ConvexError("Someone else has worked in this project, so it can’t be discarded.");
  }
  return project;
}

/** Whether anyone but `me` has left a mark on a project that can be seen cheaply. */
async function touchedByOthers(
  ctx: QueryCtx,
  project: Doc<"projects">,
  me: string,
): Promise<boolean> {
  if (project.shareToken || project.editShareToken) return true;
  const projectId = project._id;
  const claim = await ctx.db
    .query("shareClaims")
    .withIndex("by_project_and_grantee", (q) => q.eq("projectId", projectId))
    .first();
  if (claim) return true;
  const request = await ctx.db
    .query("accessRequests")
    .withIndex("by_project_and_requester", (q) => q.eq("projectId", projectId))
    .first();
  if (request) return true;

  // Trashed rows count too: something someone made and then deleted was
  // still their work.
  const pages = await ctx.db
    .query("pages")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  if (pages.some((page) => (page.createdBy ?? page.ownerId) !== me)) return true;
  for (const page of pages) {
    const present = await ctx.db
      .query("presence")
      .withIndex("by_doc", (q) => q.eq("docId", page.docId))
      .collect();
    if (present.some((p) => p.userId !== me)) return true;
  }

  for (const table of ["chatThreads", "contextSheet", "projectRepos", "projectFiles", "projectNotion"] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    if (rows.some((row) => row.ownerId !== me)) return true;
  }
  return false;
}
