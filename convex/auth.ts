import type { Auth } from "convex/server";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

/**
 * Ownership is the only tenancy boundary in v0: every row carries the Clerk
 * subject that created it, and these four functions are the only way to reach
 * one. Going through them — rather than comparing `ownerId` by hand at each call
 * site — is what keeps the check from being forgotten.
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
