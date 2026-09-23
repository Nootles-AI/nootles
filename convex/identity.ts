import { v } from "convex/values";
import type { UserIdentity } from "convex/server";
import { action, internalMutation, internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireOwner } from "./auth";

/**
 * Who an account is, as far as its sign-in will vouch: a verified address, a
 * name, a picture — stamped into `identities`, where `auth.verifiedEmail` and
 * the people lists read them, and copied onto the profile for the operator's
 * screens.
 *
 * Clerk's default session token carries none of it, only the subject. So when
 * the token is silent this asks Clerk's Backend API with the deployment's own
 * secret key, and a confirmed address is trusted for a day before it is asked
 * about again. Nothing here takes a value from the client: the one public
 * function has no arguments.
 */

const FRESH_MS = 24 * 60 * 60 * 1000;
/** The invitation page waits on this; a stalled Clerk must not hold it. */
const CLERK_TIMEOUT_MS = 5000;

/** What a source vouched for. A null `email` is an answer: none verified. */
type Vouched = { email: string | null; name?: string; imageUrl?: string };

/**
 * Brings the caller's stamp up to date, and answers the address
 * `auth.verifiedEmail` will now give them — null for none. A failure to reach
 * Clerk is no answer, so whatever was stamped before stands.
 */
export const sync = action({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx): Promise<string | null> => {
    const ownerId = await requireOwner(ctx);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const stamped = await ctx.runQuery(internal.identity.stamped, { ownerId });
    if (stamped && Date.now() - stamped.at < FRESH_MS) return stamped.email;

    const vouched = fromToken(identity) ?? (await fromClerk(ownerId));
    if (!vouched) return stamped?.email ?? null;
    await ctx.runMutation(internal.identity.stamp, { ownerId, ...vouched });
    return vouched.email;
  },
});

export const stamped = internalQuery({
  args: { ownerId: v.string() },
  returns: v.union(v.object({ email: v.string(), at: v.number() }), v.null()),
  handler: async (ctx, { ownerId }) => {
    const row = await identityOf(ctx, ownerId);
    if (!row?.verifiedEmail || row.verifiedEmailAt === undefined) return null;
    return { email: row.verifiedEmail, at: row.verifiedEmailAt };
  },
});

/**
 * Writes what a source vouched for. An address it no longer vouches for is
 * taken off, not kept: a primary address changed or unverified since is not
 * one to join a domain with. The profile's copy only ever gains values — a
 * missing row stays missing, since that is first run's signal.
 */
export const stamp = internalMutation({
  args: {
    ownerId: v.string(),
    email: v.union(v.string(), v.null()),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { ownerId, email, name, imageUrl }) => {
    const fields = {
      verifiedEmail: email ?? undefined,
      verifiedEmailAt: email ? Date.now() : undefined,
      name,
      imageUrl,
    };
    const row = await identityOf(ctx, ownerId);
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("identities", { ownerId, ...fields });

    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
    const copy = {
      ...(email && { email }),
      ...(name && { name }),
      ...(imageUrl && { imageUrl }),
    };
    if (profile && Object.keys(copy).length) await ctx.db.patch(profile._id, copy);
    return null;
  },
});

async function identityOf(ctx: QueryCtx, ownerId: string) {
  return await ctx.db
    .query("identities")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique();
}

/** The session token's own claims, when it carries an address it doesn't disown. */
function fromToken(identity: UserIdentity): Vouched | undefined {
  if (!identity.email || identity.emailVerified === false) return undefined;
  return {
    email: identity.email.trim().toLowerCase(),
    name: identity.name?.trim() || undefined,
    imageUrl: identity.pictureUrl || undefined,
  };
}

type ClerkUser = {
  primary_email_address_id?: string | null;
  email_addresses?: {
    id: string;
    email_address: string;
    verification?: { status?: string } | null;
  }[];
  first_name?: string | null;
  last_name?: string | null;
  image_url?: string | null;
  has_image?: boolean;
};

/**
 * The user as Clerk's Backend API has them, or undefined for no answer — no
 * key configured, or Clerk unreachable, slow or refusing. Only the primary
 * address counts, and only once Clerk has verified it: a secondary address is
 * one the account added, not the one it signs in as. `image_url` is Clerk's
 * generated placeholder when `has_image` is false, and the monogram says that
 * better.
 */
async function fromClerk(userId: string): Promise<Vouched | undefined> {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLERK_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal },
    );
    if (!response.ok) return undefined;
    const user = (await response.json()) as ClerkUser;
    const primary = user.email_addresses?.find(
      (address) => address.id === user.primary_email_address_id,
    );
    const email =
      primary?.verification?.status === "verified"
        ? primary.email_address.trim().toLowerCase()
        : "";
    const name = [user.first_name, user.last_name]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(" ");
    return {
      email: email || null,
      name: name || undefined,
      imageUrl: (user.has_image !== false && user.image_url) || undefined,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
