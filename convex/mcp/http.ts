import { httpAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { issuer } from "./oauth";
import { handleMcp, PARSE_ERROR, type McpBackend } from "./protocol";
import {
  CHALLENGE,
  SCOPE,
  grantedScope,
  mintToken,
  redirectWith,
  sha256Hex,
  validRedirectUri,
} from "./tokens";

/**
 * The MCP endpoint and its OAuth front door, as Convex HTTP actions on the
 * deployment's `.site` domain — the same host that already serves this
 * deployment's OIDC discovery for operator stand-ins.
 *
 *   /.well-known/oauth-protected-resource[/mcp]   RFC 9728: where to get a token
 *   /.well-known/oauth-authorization-server       RFC 8414: how
 *   /oauth/register                                RFC 7591: dynamic client registration
 *   /oauth/authorize                               → the app's consent page
 *   /oauth/token, /oauth/revoke                    code + PKCE, rotating refresh
 *   /mcp                                           the server (`protocol.ts`)
 *
 * The one person-facing step, consent, happens in the Nootles app itself
 * (`/mcp/authorize`), signed in with Clerk as ever; everything here is
 * machine-to-machine and CORS-open, because a token, not a cookie, is what
 * authorizes it.
 */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id, mcp-protocol-version, retry-after",
  "access-control-max-age": "86400",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...headers },
  });
}

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

export const preflight = httpAction(async () => new Response(null, { status: 204, headers: CORS }));

function site(): string {
  return issuer().replace(/\/$/, "");
}

const resourceUrl = () => `${site()}/mcp`;
const resourceMetadataUrl = () => `${site()}/.well-known/oauth-protected-resource/mcp`;

function appUrl(): string | null {
  const url = process.env.APP_URL?.trim();
  return url ? url.replace(/\/$/, "") : null;
}

// ---- Discovery ----------------------------------------------------------------------

export const protectedResource = httpAction(async () =>
  json(
    {
      resource: resourceUrl(),
      authorization_servers: [site()],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Nootles",
    },
    200,
    { "cache-control": "public, max-age=300" },
  ),
);

export const authorizationServer = httpAction(async () =>
  json(
    {
      issuer: site(),
      authorization_endpoint: `${site()}/oauth/authorize`,
      token_endpoint: `${site()}/oauth/token`,
      registration_endpoint: `${site()}/oauth/register`,
      revocation_endpoint: `${site()}/oauth/revoke`,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: [SCOPE],
      authorization_response_iss_parameter_supported: true,
    },
    200,
    { "cache-control": "public, max-age=300" },
  ),
);

// ---- Registration -------------------------------------------------------------------

const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
type AuthMethod = (typeof AUTH_METHODS)[number];

function registrationError(description: string, error = "invalid_client_metadata") {
  return json({ error, error_description: description }, 400, NO_STORE);
}

export const register = httpAction(async (ctx, request) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return registrationError("Body must be JSON.");
  }
  if (typeof body !== "object" || body === null) return registrationError("Body must be a JSON object.");
  const meta = body as Record<string, unknown>;

  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string")) {
    return registrationError("redirect_uris must list 1 to 10 URIs.", "invalid_redirect_uri");
  }
  if (!uris.every(validRedirectUri)) {
    return registrationError("Each redirect URI must be https, or http on localhost.", "invalid_redirect_uri");
  }
  const method = (meta.token_endpoint_auth_method ?? "none") as AuthMethod;
  if (!AUTH_METHODS.includes(method)) return registrationError("Unsupported token_endpoint_auth_method.");
  const grants = meta.grant_types ?? ["authorization_code", "refresh_token"];
  if (!Array.isArray(grants) || !grants.every((g) => g === "authorization_code" || g === "refresh_token")) {
    return registrationError("Only authorization_code and refresh_token grants are supported.");
  }
  const responses = meta.response_types ?? ["code"];
  if (!Array.isArray(responses) || !responses.every((r) => r === "code")) {
    return registrationError("Only the code response type is supported.");
  }
  if (meta.scope !== undefined && (typeof meta.scope !== "string" || !grantedScope(meta.scope))) {
    return registrationError(`The only scope is ${SCOPE}.`);
  }
  const rawName = typeof meta.client_name === "string" ? meta.client_name.trim() : "";
  const name = (rawName || "MCP client").slice(0, 80);

  const clientId = mintToken("client");
  const secret = method === "none" ? undefined : mintToken("secret");
  const registered = await ctx.runMutation(internal.mcp.oauth.registerClient, {
    clientId,
    name,
    redirectUris: uris,
    authMethod: method,
    secretHash: secret ? await sha256Hex(secret) : undefined,
  });
  if (!registered) {
    return json({ error: "temporarily_unavailable", error_description: "Too many registrations. Try again later." }, 429, {
      ...NO_STORE,
      "retry-after": "60",
    });
  }
  return json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: SCOPE,
    },
    201,
    NO_STORE,
  );
});

// ---- Authorization ---------------------------------------------------------------------

/** For errors that must not be redirected: the client or its redirect is unknown. */
function errorPage(message: string, status = 400): Response {
  const escaped = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Nootles</title>` +
      `<body style="font:14px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#3d3d3a">` +
      `<p style="max-width:28rem;padding:24px;text-align:center">${escaped}</p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE } },
  );
}

/** A resource indicator (RFC 8707) names this server, or is absent. */
function acceptsResource(resource: string | null): boolean {
  if (resource === null) return true;
  const normal = resource.replace(/\/$/, "");
  return normal === resourceUrl() || normal === site();
}

export const authorize = httpAction(async (ctx, request) => {
  const params = new URL(request.url).searchParams;
  const clientId = params.get("client_id");
  if (!clientId) return errorPage("This sign-in link is missing its client. Start again from your MCP client.");
  const client = await ctx.runQuery(internal.mcp.oauth.clientFor, { clientId });
  if (!client) return errorPage("This MCP client is not registered with Nootles. Reconnect it from the client to register again.");

  const asked = params.get("redirect_uri");
  const redirectUri = asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : null);
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return errorPage("This sign-in link's redirect address does not match the client's registration.");
  }

  const state = params.get("state") ?? undefined;
  const fail = (error: string, description: string) =>
    Response.redirect(redirectWith(redirectUri, { error, error_description: description, iss: site() }, state), 302);

  if (params.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  const challenge = params.get("code_challenge");
  if (!challenge || !CHALLENGE.test(challenge)) return fail("invalid_request", "A PKCE code_challenge is required.");
  if (params.get("code_challenge_method") !== "S256") return fail("invalid_request", "code_challenge_method must be S256.");
  const scope = grantedScope(params.get("scope"));
  if (!scope) return fail("invalid_scope", `The only scope is ${SCOPE}.`);
  const resource = params.get("resource");
  if (!acceptsResource(resource)) return fail("invalid_target", "This server only issues tokens for its own /mcp resource.");

  const app = appUrl();
  if (!app) return errorPage("Nootles is not configured to take MCP sign-ins on this deployment.", 500);

  const key = mintToken("request");
  const opened = await ctx.runMutation(internal.mcp.oauth.openRequest, {
    keyHash: await sha256Hex(key),
    clientId,
    redirectUri,
    codeChallenge: challenge,
    state,
    scope,
    resource: resource ?? undefined,
  });
  if (!opened) return fail("temporarily_unavailable", "Too many sign-in attempts. Try again later.");
  return Response.redirect(`${app}/mcp/authorize?request=${encodeURIComponent(key)}`, 302);
});

// ---- Token + revocation ----------------------------------------------------------------

async function formOf(request: Request): Promise<URLSearchParams | null> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(body ?? {})) if (typeof v === "string") form.set(k, v);
      return form;
    }
    return new URLSearchParams(await request.text());
  } catch {
    return null;
  }
}

/** HTTP Basic client credentials, form-decoded as RFC 6749 §2.3.1 requires. */
function basicCredentials(request: Request): { clientId: string; secret: string } | null {
  const header = request.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("basic ")) return null;
  try {
    const decoded = atob(header.slice(6).trim());
    const at = decoded.indexOf(":");
    if (at < 0) return null;
    return {
      clientId: decodeURIComponent(decoded.slice(0, at).replace(/\+/g, " ")),
      secret: decodeURIComponent(decoded.slice(at + 1).replace(/\+/g, " ")),
    };
  } catch {
    return null;
  }
}

const tokenFail = (error: string, description: string) =>
  json({ error, error_description: description }, error === "invalid_client" ? 401 : 400, NO_STORE);

export const token = httpAction(async (ctx, request) => {
  const form = await formOf(request);
  if (!form) return tokenFail("invalid_request", "Could not read the request body.");
  const basic = basicCredentials(request);
  const clientId = basic?.clientId ?? form.get("client_id");
  const clientSecret = basic?.secret ?? form.get("client_secret") ?? undefined;
  if (!clientId) return tokenFail("invalid_client", "client_id is required.");

  const access = mintToken("access");
  const refresh = mintToken("refresh");
  const grantType = form.get("grant_type");
  let outcome;
  if (grantType === "authorization_code") {
    const code = form.get("code");
    const redirectUri = form.get("redirect_uri");
    const verifier = form.get("code_verifier");
    if (!code || !redirectUri || !verifier) {
      return tokenFail("invalid_request", "code, redirect_uri and code_verifier are required.");
    }
    outcome = await ctx.runMutation(internal.mcp.oauth.redeemCode, {
      codeHash: await sha256Hex(code),
      clientId,
      clientSecret,
      redirectUri,
      codeVerifier: verifier,
      resource: form.get("resource") ?? undefined,
      accessHash: await sha256Hex(access),
      refreshHash: await sha256Hex(refresh),
    });
  } else if (grantType === "refresh_token") {
    const presented = form.get("refresh_token");
    if (!presented) return tokenFail("invalid_request", "refresh_token is required.");
    outcome = await ctx.runMutation(internal.mcp.oauth.rotateGrant, {
      refreshHash: await sha256Hex(presented),
      clientId,
      clientSecret,
      scope: form.get("scope") ?? undefined,
      accessHash: await sha256Hex(access),
      nextRefreshHash: await sha256Hex(refresh),
    });
  } else {
    return tokenFail("unsupported_grant_type", "Use authorization_code or refresh_token.");
  }
  if (!outcome.ok) return tokenFail(outcome.error, outcome.description);
  return json(
    {
      access_token: access,
      token_type: "Bearer",
      expires_in: outcome.expiresIn,
      refresh_token: refresh,
      scope: outcome.scope,
    },
    200,
    NO_STORE,
  );
});

export const revoke = httpAction(async (ctx, request) => {
  const form = await formOf(request);
  const presented = form?.get("token");
  if (presented) await ctx.runMutation(internal.mcp.oauth.revokeToken, { tokenHash: await sha256Hex(presented) });
  // RFC 7009 §2.2: an unknown or already-revoked token is still a 200.
  return new Response(null, { status: 200, headers: { ...CORS, ...NO_STORE } });
});

// ---- The MCP endpoint --------------------------------------------------------------------

function challenge(error: string, description: string): Response {
  const attrs = [
    `resource_metadata="${resourceMetadataUrl()}"`,
    `scope="${SCOPE}"`,
    ...(error ? [`error="${error}"`, `error_description="${description.replace(/"/g, "'")}"`] : []),
  ];
  return json({ error: error || "unauthorized", error_description: description }, 401, {
    "www-authenticate": `Bearer ${attrs.join(", ")}`,
  });
}

function backendFor(ctx: ActionCtx, subject: string, grantId: Id<"mcpGrants">): McpBackend {
  return {
    appUrl: appUrl(),
    listDocs: (args) => ctx.runAction(internal.mcp.read.listDocs, { subject, ...args }),
    readDoc: (args) =>
      ctx.runAction(internal.mcp.read.readDoc, {
        subject,
        grantId,
        ref: args.ref,
        focusBlockId: args.focusBlockId,
        window: args.window,
      }),
  };
}

export const mcp = httpAction(async (ctx, request) => {
  const header = request.headers.get("authorization") ?? "";
  const bearer = /^bearer\s+(\S+)$/i.exec(header.trim())?.[1];
  if (!bearer) return challenge("", "Sign in to Nootles to use this MCP server.");

  const admitted = await ctx.runMutation(internal.mcp.oauth.admitBearer, { accessHash: await sha256Hex(bearer) });
  if (!admitted.ok) {
    if (admitted.status === 429) {
      return json({ error: admitted.error, error_description: admitted.description }, 429, {
        "retry-after": String(Math.max(1, Math.ceil((admitted.retryAfterMs ?? 1000) / 1000))),
      });
    }
    if (admitted.status === 401) return challenge("invalid_token", admitted.description);
    // A policy refusal, not a credential problem: no challenge, so a client does
    // not loop through sign-in to earn the same answer.
    return json({ error: admitted.error, error_description: admitted.description }, 403);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } }, 400);
  }
  const answer = await handleMcp(body, backendFor(ctx, admitted.subject, admitted.grantId));
  if (answer === null) return new Response(null, { status: 202, headers: CORS });
  return json(answer);
});

/** No server-initiated stream and no session to end: POST is the whole transport. */
export const mcpOther = httpAction(async () =>
  new Response(null, { status: 405, headers: { ...CORS, allow: "POST, OPTIONS" } }),
);
