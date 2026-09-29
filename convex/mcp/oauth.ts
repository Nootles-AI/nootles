import { v, type Infer } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { RateLimiter, HOUR } from "@convex-dev/rate-limiter";
import { components, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { ownerId, requireOwner, standInActor } from "../auth";
import { isInternalOwner } from "../nmlMigration";
import { isRateRefusal, limitMode } from "../requestLimits";
import {
  ACCESS_TTL_MS,
  CODE_TTL_MS,
  REFRESH_TTL_MS,
  REQUEST_TTL_MS,
  mintToken,
  pkceMatches,
  redirectWith,
  sha256Hex,
  timingSafeEqual,
  WRITE_SCOPE,
  hasScope,
  withoutWrite,
} from "./tokens";

/**
 * The authorization server behind `/mcp` (NT-121): who may hold a token, what
 * one is worth, and how it ends.
 *
 * A token is opaque and stored only as its hash. It is not a Convex identity:
 * `auth.config.ts` knows nothing of it, so it opens no query or mutation — only
 * the MCP endpoint, which resolves it here and passes the subject to functions
 * that take it as an argument (`auth.agentOwnsPage`). That is what keeps a
 * leaked MCP token from being a key to the rest of the API.
 *
 * Holding one needs three things at every call, not just at consent: the MCP
 * switch on, the subject still on the internal-owner list, and the grant live.
 * Removing someone from `internalOwners` therefore cuts their agent off on its
 * next request, with nothing to revoke by hand.
 */

// ---- Shared -------------------------------------------------------------------

async function mcpEnabled(ctx: QueryCtx): Promise<boolean> {
  return (await ctx.db.query("mcpState").first())?.enabled ?? false;
}

/** Why a signed-in person may not connect an agent, or null when they may. */
async function ineligibility(ctx: QueryCtx, subject: string): Promise<"mcp-off" | "not-internal" | null> {
  if (!(await mcpEnabled(ctx))) return "mcp-off";
  if (!(await isInternalOwner(ctx, subject))) return "not-internal";
  return null;
}

async function clientRow(ctx: QueryCtx, clientId: string): Promise<Doc<"mcpClients"> | null> {
  return await ctx.db
    .query("mcpClients")
    .withIndex("by_client_id", (q) => q.eq("clientId", clientId))
    .unique();
}

/**
 * A confidential client proves itself with its secret; a public one (the usual
 * MCP client, relying on PKCE) sends none and must not be asked for one.
 */
async function clientAuthenticates(client: Doc<"mcpClients">, secret: string | undefined): Promise<boolean> {
  if (client.authMethod === "none") return true;
  if (!secret || !client.secretHash) return false;
  return timingSafeEqual(await sha256Hex(secret), client.secretHash);
}

async function touchClient(ctx: MutationCtx, client: Doc<"mcpClients">) {
  await ctx.db.patch(client._id, { lastUsedAt: Date.now() });
}

async function revoke(ctx: MutationCtx, grant: Doc<"mcpGrants">) {
  if (grant.revokedAt !== undefined) return;
  const now = Date.now();
  // Past its refresh horizon is what the sweep collects, so a revoked grant
  // lingers a day — long enough to recognize a replayed token — then goes.
  await ctx.db.patch(grant._id, {
    revokedAt: now,
    refreshExpiresAt: Math.min(grant.refreshExpiresAt, now + 24 * 60 * 60 * 1000),
  });
}

type TokenError = { ok: false; error: string; description: string };
const tokenError = (error: string, description: string): TokenError => ({ ok: false, error, description });

const tokenErrorValidator = v.object({ ok: v.literal(false), error: v.string(), description: v.string() });

// ---- Operator controls ----------------------------------------------------------

/**
 * The MCP master switch. `npx convex run mcp/oauth:setMcpEnabled '{"enabled":false}'`
 * refuses every token on its next call and every consent; turning it back on
 * restores grants that were not revoked meanwhile.
 */
export const setMcpEnabled = internalMutation({
  args: { enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("mcpState").first();
    if (row) await ctx.db.patch(row._id, { enabled: args.enabled, updatedAt: Date.now() });
    else await ctx.db.insert("mcpState", { enabled: args.enabled, updatedAt: Date.now() });
    return null;
  },
});

/** What an operator needs to see: the switch and every standing grant, content-free. */
export const mcpStatus = internalQuery({
  args: {},
  returns: v.object({
    enabled: v.boolean(),
    grants: v.array(
      v.object({
        grantId: v.id("mcpGrants"),
        subject: v.string(),
        clientName: v.string(),
        createdAt: v.number(),
        lastUsedAt: v.optional(v.number()),
        revokedAt: v.optional(v.number()),
      }),
    ),
  }),
  handler: async (ctx) => {
    const grants = await ctx.db.query("mcpGrants").take(200);
    return {
      enabled: await mcpEnabled(ctx),
      grants: grants.map((g) => ({
        grantId: g._id,
        subject: g.subject,
        clientName: g.clientName,
        createdAt: g.createdAt,
        lastUsedAt: g.lastUsedAt,
        revokedAt: g.revokedAt,
      })),
    };
  },
});

/** Revoke one grant, or every grant a subject holds. */
export const revokeGrants = internalMutation({
  args: { grantId: v.optional(v.id("mcpGrants")), subject: v.optional(v.string()) },
  returns: v.object({ revoked: v.number() }),
  handler: async (ctx, args) => {
    const grants: Doc<"mcpGrants">[] = [];
    if (args.grantId) {
      const grant = await ctx.db.get(args.grantId);
      if (grant) grants.push(grant);
    }
    if (args.subject) {
      const subject = args.subject;
      grants.push(
        ...(await ctx.db.query("mcpGrants").withIndex("by_subject", (q) => q.eq("subject", subject)).take(500)),
      );
    }
    let revoked = 0;
    for (const grant of grants) {
      if (grant.revokedAt === undefined) revoked++;
      await revoke(ctx, grant);
    }
    return { revoked };
  },
});

// ---- Registration (RFC 7591) ----------------------------------------------------

/**
 * Registration and authorization requests are open to anyone — that is what
 * lets a new client find its way in — so each writes a row nobody vouched for.
 * A fleet-wide window bounds how fast those rows can pile up between sweeps;
 * an honest client registers once and asks for consent a handful of times.
 */
const openDoor = new RateLimiter(components.rateLimiter, {
  mcpRegistration: { kind: "fixed window", rate: 200, period: HOUR },
  mcpAuthorization: { kind: "fixed window", rate: 1000, period: HOUR },
});

export const registerClient = internalMutation({
  args: {
    clientId: v.string(),
    name: v.string(),
    redirectUris: v.array(v.string()),
    authMethod: v.union(v.literal("none"), v.literal("client_secret_post"), v.literal("client_secret_basic")),
    secretHash: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!(await openDoor.limit(ctx, "mcpRegistration")).ok) return false;
    await ctx.db.insert("mcpClients", { ...args, createdAt: Date.now() });
    return true;
  },
});

export const clientFor = internalQuery({
  args: { clientId: v.string() },
  returns: v.union(v.null(), v.object({ name: v.string(), redirectUris: v.array(v.string()) })),
  handler: async (ctx, args) => {
    const client = await clientRow(ctx, args.clientId);
    return client ? { name: client.name, redirectUris: client.redirectUris } : null;
  },
});

// ---- Authorization + consent -----------------------------------------------------

/** `/oauth/authorize` parks a checked request here for the consent page. */
export const openRequest = internalMutation({
  args: {
    keyHash: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    state: v.optional(v.string()),
    scope: v.string(),
    resource: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!(await openDoor.limit(ctx, "mcpAuthorization")).ok) return false;
    await ctx.db.insert("mcpAuthRequests", { ...args, expiresAt: Date.now() + REQUEST_TTL_MS });
    return true;
  },
});

async function liveRequest(ctx: QueryCtx, key: string): Promise<Doc<"mcpAuthRequests"> | null> {
  const keyHash = await sha256Hex(key);
  return await ctx.db
    .query("mcpAuthRequests")
    .withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash))
    .unique();
}

/**
 * What the consent page shows. Expiry is judged by the mutations that act on
 * the request, not here — a query's clock is cached — so a request that lapses
 * while the page is open still reads as pending and is refused on the click.
 */
export const pendingRequest = query({
  args: { request: v.string() },
  returns: v.union(
    v.null(),
    v.object({ status: v.literal("missing") }),
    v.object({
      status: v.literal("pending"),
      clientName: v.string(),
      redirectOrigin: v.string(),
      scope: v.string(),
      expiresAt: v.number(),
      refusal: v.union(
        v.null(),
        v.literal("mcp-off"),
        v.literal("not-internal"),
        v.literal("stand-in"),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const subject = await ownerId(ctx);
    if (!subject) return null;
    const row = await liveRequest(ctx, args.request);
    const client = row && (await clientRow(ctx, row.clientId));
    if (!row || !client) return { status: "missing" as const };
    const refusal = (await standInActor(ctx)) ? "stand-in" as const : await ineligibility(ctx, subject);
    return {
      status: "pending" as const,
      clientName: client.name,
      redirectOrigin: new URL(row.redirectUri).origin,
      scope: row.scope,
      expiresAt: row.expiresAt,
      refusal,
    };
  },
});

const consentOutcome = v.union(
  v.object({ status: v.literal("redirect"), redirectTo: v.string() }),
  v.object({
    status: v.literal("refused"),
    reason: v.union(v.literal("expired"), v.literal("mcp-off"), v.literal("not-internal")),
  }),
);

const issuedCode = v.union(
  v.object({ status: v.literal("issued"), redirectUri: v.string(), state: v.optional(v.string()) }),
  v.object({
    status: v.literal("refused"),
    reason: v.union(v.literal("expired"), v.literal("mcp-off"), v.literal("not-internal")),
  }),
);

/**
 * Allow. An action only because the code must be minted from real randomness;
 * everything that decides is `issueCode`, which reads the signed-in person from
 * the session this action passes through — a stand-in is refused by both.
 */
export const approve = action({
  /** `allowEdits: false` narrows a request that asked to write down to reading. */
  args: { request: v.string(), allowEdits: v.optional(v.boolean()) },
  returns: consentOutcome,
  handler: async (ctx, args): Promise<Infer<typeof consentOutcome>> => {
    await requireOwner(ctx);
    const code = mintToken("code");
    const issued: Infer<typeof issuedCode> = await ctx.runMutation(internal.mcp.oauth.issueCode, {
      requestKeyHash: await sha256Hex(args.request),
      codeHash: await sha256Hex(code),
      allowEdits: args.allowEdits ?? true,
    });
    if (issued.status === "refused") return issued;
    return {
      status: "redirect" as const,
      redirectTo: redirectWith(issued.redirectUri, { code, iss: issuer() }, issued.state),
    };
  },
});


export const issueCode = internalMutation({
  args: { requestKeyHash: v.string(), codeHash: v.string(), allowEdits: v.boolean() },
  returns: issuedCode,
  handler: async (ctx, args) => {
    const subject = await requireOwner(ctx);
    const row = await ctx.db
      .query("mcpAuthRequests")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", args.requestKeyHash))
      .unique();
    const client = row && (await clientRow(ctx, row.clientId));
    if (!row || !client || row.expiresAt < Date.now()) return { status: "refused" as const, reason: "expired" as const };
    const refusal = await ineligibility(ctx, subject);
    if (refusal) return { status: "refused" as const, reason: refusal };
    await ctx.db.delete(row._id);
    await ctx.db.insert("mcpAuthCodes", {
      codeHash: args.codeHash,
      subject,
      clientId: row.clientId,
      redirectUri: row.redirectUri,
      codeChallenge: row.codeChallenge,
      scope: args.allowEdits ? row.scope : withoutWrite(row.scope),
      resource: row.resource,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    await touchClient(ctx, client);
    return { status: "issued" as const, redirectUri: row.redirectUri, state: row.state };
  },
});

/** Deny: the request is spent and the client hears `access_denied`. */
export const deny = mutation({
  args: { request: v.string() },
  returns: v.union(v.null(), v.object({ redirectTo: v.string() })),
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const row = await liveRequest(ctx, args.request);
    if (!row) return null;
    await ctx.db.delete(row._id);
    return {
      redirectTo: redirectWith(
        row.redirectUri,
        { error: "access_denied", error_description: "The person declined.", iss: issuer() },
        row.state,
      ),
    };
  },
});

/** Named in every redirect (RFC 9207) so a client can tell which server answered. */
export function issuer(): string {
  const site = process.env.CONVEX_SITE_URL;
  if (!site) throw new Error("CONVEX_SITE_URL is not set on this deployment.");
  return site;
}

// ---- Token endpoint ---------------------------------------------------------------

const tokenIssued = v.object({
  ok: v.literal(true),
  scope: v.string(),
  expiresIn: v.number(),
});

/**
 * `authorization_code` → a new grant. Every check in one transaction, so two
 * racing redemptions of one code cannot both win, and a second presentation of
 * a spent code revokes what the first minted (the code may have been stolen).
 */
export const redeemCode = internalMutation({
  args: {
    codeHash: v.string(),
    clientId: v.string(),
    clientSecret: v.optional(v.string()),
    redirectUri: v.string(),
    codeVerifier: v.string(),
    resource: v.optional(v.string()),
    accessHash: v.string(),
    refreshHash: v.string(),
  },
  returns: v.union(tokenIssued, tokenErrorValidator),
  handler: async (ctx, args) => {
    const code = await ctx.db
      .query("mcpAuthCodes")
      .withIndex("by_code_hash", (q) => q.eq("codeHash", args.codeHash))
      .unique();
    if (!code) return tokenError("invalid_grant", "Unknown authorization code.");
    if (code.usedAt !== undefined) {
      const minted = code.grantId && (await ctx.db.get(code.grantId));
      if (minted) await revoke(ctx, minted);
      return tokenError("invalid_grant", "Authorization code already used.");
    }
    const client = await clientRow(ctx, args.clientId);
    if (!client || code.clientId !== args.clientId) return tokenError("invalid_grant", "Code was issued to another client.");
    if (!(await clientAuthenticates(client, args.clientSecret))) return tokenError("invalid_client", "Client authentication failed.");
    if (code.expiresAt < Date.now()) return tokenError("invalid_grant", "Authorization code expired.");
    if (code.redirectUri !== args.redirectUri) return tokenError("invalid_grant", "redirect_uri does not match the authorization request.");
    if (args.resource !== undefined && code.resource !== undefined && args.resource !== code.resource) {
      return tokenError("invalid_target", "resource does not match the authorization request.");
    }
    if (!(await pkceMatches(args.codeVerifier, code.codeChallenge))) return tokenError("invalid_grant", "PKCE verification failed.");
    // Spent whatever happens next, so a code refused for eligibility is not retried.
    await ctx.db.patch(code._id, { usedAt: Date.now() });
    if (await ineligibility(ctx, code.subject)) return tokenError("invalid_grant", "Access to MCP has been withdrawn.");

    const now = Date.now();
    const grantId: Id<"mcpGrants"> = await ctx.db.insert("mcpGrants", {
      subject: code.subject,
      clientId: client.clientId,
      clientName: client.name,
      scope: code.scope,
      accessHash: args.accessHash,
      accessExpiresAt: now + ACCESS_TTL_MS,
      refreshHash: args.refreshHash,
      refreshExpiresAt: now + REFRESH_TTL_MS,
      createdAt: now,
    });
    await ctx.db.patch(code._id, { grantId });
    await touchClient(ctx, client);
    return { ok: true as const, scope: code.scope, expiresIn: ACCESS_TTL_MS / 1000 };
  },
});

/**
 * `refresh_token` → the grant's next pair. Both tokens rotate; the refresh
 * token just replaced is remembered, and seeing it again means two parties
 * hold this grant — so it ends for both.
 */
export const rotateGrant = internalMutation({
  args: {
    refreshHash: v.string(),
    clientId: v.string(),
    clientSecret: v.optional(v.string()),
    scope: v.optional(v.string()),
    accessHash: v.string(),
    nextRefreshHash: v.string(),
  },
  returns: v.union(tokenIssued, tokenErrorValidator),
  handler: async (ctx, args) => {
    const grant = await ctx.db
      .query("mcpGrants")
      .withIndex("by_refresh_hash", (q) => q.eq("refreshHash", args.refreshHash))
      .unique();
    if (!grant) {
      const replayed = await ctx.db
        .query("mcpGrants")
        .withIndex("by_prev_refresh_hash", (q) => q.eq("prevRefreshHash", args.refreshHash))
        .unique();
      if (replayed) await revoke(ctx, replayed);
      return tokenError("invalid_grant", "Unknown or reused refresh token.");
    }
    const now = Date.now();
    if (grant.revokedAt !== undefined || grant.refreshExpiresAt < now) {
      return tokenError("invalid_grant", "Refresh token expired or revoked.");
    }
    const client = await clientRow(ctx, args.clientId);
    if (!client || grant.clientId !== args.clientId) return tokenError("invalid_grant", "Refresh token was issued to another client.");
    if (!(await clientAuthenticates(client, args.clientSecret))) return tokenError("invalid_client", "Client authentication failed.");
    if (args.scope !== undefined && args.scope !== grant.scope) return tokenError("invalid_scope", "Scope cannot be widened.");
    if (await ineligibility(ctx, grant.subject)) return tokenError("invalid_grant", "Access to MCP has been withdrawn.");
    await ctx.db.patch(grant._id, {
      prevRefreshHash: grant.refreshHash,
      refreshHash: args.nextRefreshHash,
      refreshExpiresAt: now + REFRESH_TTL_MS,
      accessHash: args.accessHash,
      accessExpiresAt: now + ACCESS_TTL_MS,
    });
    await touchClient(ctx, client);
    return { ok: true as const, scope: grant.scope, expiresIn: ACCESS_TTL_MS / 1000 };
  },
});

/** RFC 7009: either token of a grant ends the grant. Unknown tokens are not an error. */
export const revokeToken = internalMutation({
  args: { tokenHash: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const grant =
      (await ctx.db.query("mcpGrants").withIndex("by_access_hash", (q) => q.eq("accessHash", args.tokenHash)).unique()) ??
      (await ctx.db.query("mcpGrants").withIndex("by_refresh_hash", (q) => q.eq("refreshHash", args.tokenHash)).unique());
    if (grant) await revoke(ctx, grant);
    return null;
  },
});

// ---- The resource server's gate ---------------------------------------------------

/**
 * Every `/mcp` request passes here first: the bearer token resolved to a live
 * grant, the switch and the allowlist re-checked, and one unit of the subject's
 * `mcpRequest` budget spent — all in the transaction that reads the grant, so
 * the key the limiter charges is the one the token names.
 *
 * MCP enforces its limit under `observe` as well. That mode exists to learn
 * what the human lanes' traffic looks like before refusing a person; an agent
 * loop has no debounce to learn from, and nothing here is worth letting it run
 * unbounded. `off` still turns it off.
 */
export const admitBearer = internalMutation({
  args: { accessHash: v.string() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      subject: v.string(),
      grantId: v.id("mcpGrants"),
      clientName: v.string(),
      scope: v.string(),
    }),
    v.object({
      ok: v.literal(false),
      status: v.union(v.literal(401), v.literal(403), v.literal(429)),
      error: v.string(),
      description: v.string(),
      retryAfterMs: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const grant = await ctx.db
      .query("mcpGrants")
      .withIndex("by_access_hash", (q) => q.eq("accessHash", args.accessHash))
      .unique();
    const now = Date.now();
    if (!grant || grant.revokedAt !== undefined || grant.accessExpiresAt < now) {
      return { ok: false as const, status: 401 as const, error: "invalid_token", description: "The access token is invalid, expired or revoked." };
    }
    const refusal = await ineligibility(ctx, grant.subject);
    if (refusal) {
      return {
        ok: false as const,
        status: 403 as const,
        error: "access_denied",
        description: refusal === "mcp-off" ? "MCP is turned off for Nootles." : "This account is not enabled for MCP.",
      };
    }
    if (limitMode() !== "off") {
      try {
        await ctx.runMutation(internal.requestLimits.debitFor, { bucket: "mcpRequest", subject: grant.subject });
      } catch (error) {
        if (!isRateRefusal(error)) throw error;
        console.warn(`mcp: refused a request on the ${error.data.scope} bucket; retry after ${error.data.retryAfterMs}ms`);
        return {
          ok: false as const,
          status: 429 as const,
          error: "rate_limited",
          description: "Too many requests. Slow down and retry.",
          retryAfterMs: error.data.retryAfterMs,
        };
      }
    }
    if (grant.lastUsedAt === undefined || now - grant.lastUsedAt > 60_000) {
      await ctx.db.patch(grant._id, { lastUsedAt: now });
    }
    return { ok: true as const, subject: grant.subject, grantId: grant._id, clientName: grant.clientName, scope: grant.scope };
  },
});

/**
 * A write's last look at the grant behind it, inside the transaction that
 * writes: the token was checked when the request came in, but an edit takes
 * long enough for a disconnect, the switch or the allowlist to land meanwhile.
 */
export async function grantMayWrite(
  ctx: QueryCtx,
  grantId: Id<"mcpGrants">,
  subject: string,
): Promise<boolean> {
  const grant = await ctx.db.get(grantId);
  if (!grant || grant.subject !== subject || grant.revokedAt !== undefined) return false;
  if (!hasScope(grant.scope, WRITE_SCOPE)) return false;
  return (await ineligibility(ctx, subject)) === null;
}

// ---- The person's own connections ---------------------------------------------------

export const myConnections = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      enabled: v.boolean(),
      eligible: v.boolean(),
      /** What to paste into a client: this deployment's MCP endpoint. */
      serverUrl: v.union(v.string(), v.null()),
      connections: v.array(
        v.object({
          grantId: v.id("mcpGrants"),
          clientName: v.string(),
          canEdit: v.boolean(),
          createdAt: v.number(),
          lastUsedAt: v.optional(v.number()),
        }),
      ),
    }),
  ),
  handler: async (ctx) => {
    const subject = await ownerId(ctx);
    if (!subject) return null;
    const grants = await ctx.db
      .query("mcpGrants")
      .withIndex("by_subject", (q) => q.eq("subject", subject))
      .take(100);
    return {
      enabled: await mcpEnabled(ctx),
      eligible: await isInternalOwner(ctx, subject),
      serverUrl: process.env.CONVEX_SITE_URL ? `${process.env.CONVEX_SITE_URL.replace(/\/$/, "")}/mcp` : null,
      connections: grants
        .filter((g) => g.revokedAt === undefined)
        .map((g) => ({
          grantId: g._id,
          clientName: g.clientName,
          canEdit: hasScope(g.scope, WRITE_SCOPE),
          createdAt: g.createdAt,
          lastUsedAt: g.lastUsedAt,
        })),
    };
  },
});

export const disconnect = mutation({
  args: { grantId: v.id("mcpGrants") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const subject = await requireOwner(ctx);
    const grant = await ctx.db.get(args.grantId);
    if (!grant || grant.subject !== subject) throw new Error("Not found");
    await revoke(ctx, grant);
    return null;
  },
});

// ---- Housekeeping -----------------------------------------------------------------

const SWEEP_BATCH = 100;

/**
 * Lapsed requests and codes, dead grants, and clients registered but never
 * used. Hourly; a full batch reschedules itself so a backlog drains.
 */
export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    let full = false;
    const requests = await ctx.db
      .query("mcpAuthRequests")
      .withIndex("by_expires", (q) => q.lt("expiresAt", now))
      .take(SWEEP_BATCH);
    for (const row of requests) await ctx.db.delete(row._id);
    full ||= requests.length === SWEEP_BATCH;

    // Spent codes stay an hour past expiry, for the replay check.
    const codes = await ctx.db
      .query("mcpAuthCodes")
      .withIndex("by_expires", (q) => q.lt("expiresAt", now - 60 * 60 * 1000))
      .take(SWEEP_BATCH);
    for (const row of codes) await ctx.db.delete(row._id);
    full ||= codes.length === SWEEP_BATCH;

    const grants = await ctx.db
      .query("mcpGrants")
      .withIndex("by_refresh_expires", (q) => q.lt("refreshExpiresAt", now))
      .take(SWEEP_BATCH);
    for (const row of grants) await ctx.db.delete(row._id);
    full ||= grants.length === SWEEP_BATCH;

    const unused = await ctx.db
      .query("mcpClients")
      .withIndex("by_last_used_and_created", (q) =>
        q.eq("lastUsedAt", undefined).lt("createdAt", now - 24 * 60 * 60 * 1000),
      )
      .take(SWEEP_BATCH);
    for (const client of unused) await ctx.db.delete(client._id);
    full ||= unused.length === SWEEP_BATCH;

    if (full) await ctx.scheduler.runAfter(0, internal.mcp.oauth.sweep, {});
    return null;
  },
});
