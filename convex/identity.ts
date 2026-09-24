import { ConvexError, v } from "convex/values";
import type { UserIdentity } from "convex/server";
import { action, httpAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireOwner, STAMP_MAX_AGE_MS } from "./auth";
import { faceOf, identityOf } from "./profiles";
import { verifySvix } from "./svix";

/**
 * Who an account is, as far as its sign-in will vouch: a verified address, a
 * name, a picture — stamped into `identities`, where `auth.verifiedEmail` and
 * the people lists read them, and copied onto the profile for the operator's
 * screens.
 *
 * Clerk's default session token carries none of it, only the subject. So when
 * the token is silent this asks Clerk's Backend API with the deployment's own
 * secret key: when the account's app asks and its stamp is a day old — never
 * more than once a minute, whatever the answer — and whenever Clerk's webhook
 * says the account changed. An address Clerk has not
 * vouched for in `STAMP_MAX_AGE_MS` admits nobody. Nothing here takes a value
 * from the client: the one public function has no arguments, and the webhook
 * takes only what Clerk has signed.
 */

/** How old a stamp may be before the account's own app asks Clerk again. */
const FRESH_MS = 24 * 60 * 60 * 1000;
/**
 * How long after asking Clerk an account's app is given the last answer
 * rather than asking again. A day's freshness covers only a stamped address;
 * this bounds everything else — an account with no verified address, a
 * lapsed stamp, a client in a loop — to one Clerk call a minute.
 */
const ANSWERED_MS = 60 * 1000;
/** Stamps lapsed per run of `expire`, which goes again while there are more. */
const EXPIRE_BATCH = 100;
/**
 * The invitation page waits on this; a stalled Clerk must not hold it. Also
 * the wait after an ask that has not answered, so an account has at most one
 * outstanding while Clerk is slow or failing, and its app can soon retry.
 */
const CLERK_TIMEOUT_MS = 5000;

/** What a source vouched for. A null `email` is an answer: none verified. */
type Vouched = { email: string | null; name?: string; imageUrl?: string };

/**
 * Brings the caller's stamp up to date, and answers the address
 * `auth.verifiedEmail` will now give them — null for none. A failure to reach
 * Clerk is no answer, so whatever was stamped before stands; with nothing
 * stamped before, it throws `{ code: "unanswered" }` rather than claim there
 * is no address, and the app asks again.
 */
export const sync = action({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx): Promise<string | null> => {
    const ownerId = await requireOwner(ctx);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const check = await ctx.runMutation(internal.identity.begin, { ownerId });

    // Only Clerk is rationed: the token's own word costs nothing to take.
    const token = fromToken(identity);
    const vouched = check.ask
      ? (token ?? (await fromClerk(ownerId)))
      : check.known === undefined
        ? token
        : undefined;
    if (vouched) {
      await ctx.runMutation(internal.identity.stamp, { ownerId, ...vouched });
      return vouched.email;
    }
    if (check.known === undefined) throw new ConvexError({ code: "unanswered" });
    return check.known;
  },
});

/**
 * Whether this call may ask, decided and recorded in one transaction so that
 * calls racing each other — a first visit's, or a loop's — ask once between
 * them. `known` is what was answered last: an address, null for none, or
 * undefined when nothing has been.
 */
export const begin = internalMutation({
  args: { ownerId: v.string() },
  returns: v.object({
    ask: v.boolean(),
    known: v.optional(v.union(v.string(), v.null())),
  }),
  handler: async (ctx, { ownerId }) => {
    const now = Date.now();
    const row = await identityOf(ctx, ownerId);
    const known = row?.verifiedEmail ?? (row?.answeredAt === undefined ? undefined : null);
    if (row?.verifiedEmail && now - (row.verifiedEmailAt ?? 0) < FRESH_MS) {
      return { ask: false, known };
    }
    if (row?.checkedAt !== undefined) {
      const answered = (row.answeredAt ?? -1) >= row.checkedAt;
      if (now - row.checkedAt < (answered ? ANSWERED_MS : CLERK_TIMEOUT_MS)) {
        return { ask: false, known };
      }
    }
    if (row) await ctx.db.patch(row._id, { checkedAt: now });
    else await ctx.db.insert("identities", { ownerId, checkedAt: now });
    return { ask: true, known };
  },
});

/**
 * Writes what a source vouched for. An address it no longer vouches for is
 * taken off, not kept: a primary address changed or unverified since is not
 * one to join a domain with. The profile's copy only ever gains values — a
 * missing row stays missing, since that is first run's signal, and is made
 * with the copy when it is made.
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
    const now = Date.now();
    const fields = {
      verifiedEmail: email ?? undefined,
      verifiedEmailAt: email ? now : undefined,
      checkedAt: now,
      answeredAt: now,
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
    const copy = faceOf(fields);
    if (profile && Object.keys(copy).length) await ctx.db.patch(profile._id, copy);
    return null;
  },
});

/** What taking an address off a stamp writes; the name and picture stay. */
const LAPSED = { verifiedEmail: undefined, verifiedEmailAt: undefined };

/** A deleted account's address, which is nobody's to vouch for any more. */
export const forget = internalMutation({
  args: { ownerId: v.string() },
  returns: v.null(),
  handler: async (ctx, { ownerId }) => {
    const row = await identityOf(ctx, ownerId);
    if (row) await ctx.db.patch(row._id, LAPSED);
    return null;
  },
});

/**
 * Takes the address off every stamp older than `STAMP_MAX_AGE_MS`. The gates
 * that admit someone judge a stamp's age themselves; this is for the queries,
 * which may not read the clock, so that the doors they show do not outlive
 * the ones the gates would open.
 */
export const expire = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const lapsed = await ctx.db
      .query("identities")
      .withIndex("by_verifiedEmailAt", (q) =>
        q.gte("verifiedEmailAt", 0).lt("verifiedEmailAt", Date.now() - STAMP_MAX_AGE_MS),
      )
      .take(EXPIRE_BATCH);
    for (const row of lapsed) await ctx.db.patch(row._id, LAPSED);
    if (lapsed.length === EXPIRE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.identity.expire, {});
    }
    return null;
  },
});

/**
 * Clerk's webhook, routed in `http.ts`, for `user.created`, `user.updated` and
 * `user.deleted`. An address removed or replaced in Clerk — by the account
 * itself or by an operator in the dashboard — reaches the stamp without
 * waiting on the account's own app to ask, which it may never do.
 *
 * The event is only a signal. Svix promises no order and retries a failed
 * delivery for hours, so a late one could carry an address taken off since;
 * what gets stamped is what Clerk says now. A deleted account is the
 * exception, with nobody left to ask about. When Clerk gives no answer the
 * 503 has Svix deliver the event again later.
 */
export const clerkWebhook = httpAction(async (ctx, request) => {
  const body = await request.text();
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret || !(await verifySvix(secret, request.headers, body, Date.now()))) {
    return new Response("Unverified", { status: 401 });
  }
  let event: { type?: unknown; data?: { id?: unknown } | null };
  try {
    event = JSON.parse(body);
  } catch {
    return new Response("Unreadable", { status: 400 });
  }
  const ownerId = typeof event.data?.id === "string" ? event.data.id : null;
  if (ownerId && event.type === "user.deleted") {
    await ctx.runMutation(internal.identity.forget, { ownerId });
  } else if (ownerId && (event.type === "user.created" || event.type === "user.updated")) {
    const vouched = await fromClerk(ownerId);
    if (!vouched) return new Response("Clerk gave no answer", { status: 503 });
    await ctx.runMutation(internal.identity.stamp, { ownerId, ...vouched });
  }
  return new Response(null, { status: 204 });
});

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
