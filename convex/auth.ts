import type { Auth } from "convex/server";
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

/** For anything that writes — an unauthenticated write is never valid. */
export async function requireOwner(ctx: { auth: Auth }): Promise<string> {
  const owner = await ownerId(ctx);
  if (!owner) throw new Error("Not signed in");
  return owner;
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
  return doc && doc.ownerId === owner ? doc : null;
}

/** The same lookup, for callers that cannot proceed without the row. */
export async function requireOwned<T extends Owned>(
  ctx: QueryCtx,
  table: T,
  id: Id<T>,
): Promise<Doc<T>> {
  const doc = await readOwned(ctx, table, id);
  if (!doc) throw new Error("Not found");
  return doc;
}

export type ProjectRole = "owner" | "editor" | "viewer";

/**
 * What the caller is to a loaded project.
 *
 * A claim names the role of the link it came through, but permission is always
 * re-derived against the tokens that are live NOW: killing the editor link
 * demotes its claimants to viewers while any link is still on (the same move
 * as Google downgrading a link from editor to viewer), and killing both links
 * closes the project to everyone but the owner. A claim row alone admits
 * nobody.
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
  if (!claim) return null;
  if (claim.role === "editor" && project.editShareToken) return "editor";
  return project.shareToken || project.editShareToken ? "viewer" : null;
}

/** The caller's role in a project named by id, or null for missing/stranger. */
export async function projectRole(
  ctx: QueryCtx,
  projectId: Id<"projects">,
): Promise<ProjectRole | null> {
  const project = await ctx.db.get(projectId);
  return project ? await roleForProject(ctx, project) : null;
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
  if (!doc) return null;
  const project = await projectOf(ctx, doc);
  if (!project) return null;
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
  const doc = (await ctx.db.get(id)) as Doc<T> | null;
  if (doc) {
    const project = await projectOf(ctx, doc);
    if (project) {
      const role = await roleForProject(ctx, project);
      if (role === "owner" || role === "editor") return doc;
    }
  }
  throw new Error("Not found");
}
