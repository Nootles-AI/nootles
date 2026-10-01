import { httpRouter, type GenericActionCtx } from "convex/server";
import { registerRoutes } from "@convex-dev/stripe";
import type Stripe from "stripe";
import { components, internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { checkoutDiscountOf, teamBuyerOf } from "./billing";
import { httpAction } from "./_generated/server";
import { deliver, signatureValid } from "./github/webhook";
import { clerkWebhook } from "./identity";
import * as mcp from "./mcp/http";
import { workspaceEventOf } from "./teamBilling";

/**
 * The deployment as an OIDC issuer, for operator stand-in sessions.
 *
 * Convex verifies a token by fetching `{domain}/.well-known/openid-configuration`
 * and then the `jwks_uri` it names. Serving both from the deployment that also
 * signs the tokens (`impersonationMint.ts`) keeps the whole mechanism inside
 * one blast radius: no second host to keep alive, and no way for a dev key to
 * be honoured in production.
 *
 * The public half sits in an env var rather than being derived from the private
 * one, so this handler holds no crypto at all — it hands back what
 * `scripts/gen-impersonation-key.mjs` computed.
 */
const http = httpRouter();

/** Short enough that rotating a key takes effect while you are still watching. */
const CACHE = "public, max-age=300";

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": CACHE },
  });
}

http.route({
  path: "/.well-known/openid-configuration",
  method: "GET",
  handler: httpAction(async () => {
    const issuer = process.env.CONVEX_SITE_URL;
    return json({
      issuer,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      // A discovery document must name an authorization endpoint. Stand-in
      // tokens never use it — an operator action mints them — and the one it
      // names is MCP's (NT-121, below), whose tokens are opaque and are not
      // what the JWKS here verifies.
      authorization_endpoint: `${issuer}/oauth/authorize`,
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    });
  }),
});

http.route({
  path: "/.well-known/jwks.json",
  method: "GET",
  handler: httpAction(async () =>
    // Unconfigured answers an empty key set rather than an error: every token
    // then fails to verify, which is the right posture for a missing key.
    json(JSON.parse(process.env.IMPERSONATION_JWKS ?? '{"keys":[]}')),
  ),
});

/**
 * MCP (NT-121): the OAuth front door and the server, all in `mcp/http.ts`. The
 * protected-resource document is served at both the bare and the path-suffixed
 * well-known address, since clients look in either (RFC 9728 §3.1).
 */
for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
  http.route({ path, method: "GET", handler: mcp.protectedResource });
  http.route({ path, method: "OPTIONS", handler: mcp.preflight });
}
http.route({ path: "/.well-known/oauth-authorization-server", method: "GET", handler: mcp.authorizationServer });
http.route({ path: "/.well-known/oauth-authorization-server", method: "OPTIONS", handler: mcp.preflight });
http.route({ path: "/oauth/register", method: "POST", handler: mcp.register });
http.route({ path: "/oauth/register", method: "OPTIONS", handler: mcp.preflight });
http.route({ path: "/oauth/authorize", method: "GET", handler: mcp.authorize });
http.route({ path: "/oauth/token", method: "POST", handler: mcp.token });
http.route({ path: "/oauth/token", method: "OPTIONS", handler: mcp.preflight });
http.route({ path: "/oauth/revoke", method: "POST", handler: mcp.revoke });
http.route({ path: "/oauth/revoke", method: "OPTIONS", handler: mcp.preflight });
http.route({ path: "/mcp", method: "POST", handler: mcp.mcp });
http.route({ path: "/mcp", method: "OPTIONS", handler: mcp.preflight });
http.route({ path: "/mcp", method: "GET", handler: mcp.mcpOther });
http.route({ path: "/mcp", method: "DELETE", handler: mcp.mcpOther });

/**
 * A tab's goodbye as it unloads (NT-137): `navigator.sendBeacon` from
 * `YConvexProvider` on `pagehide`, because the websocket `presence.leave`
 * rides dies with the page. The body is `{docId, sessionId, clientId}` sent as
 * text/plain, which keeps the beacon a simple request with no preflight; the
 * answer is never read. No auth, exactly as `presence.leave` takes none: the
 * unguessable session id is the capability, and it can only hang up itself.
 */
http.route({
  path: "/presence/leave",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const leaving = leavingOf(await req.text().catch(() => ""));
    if (!leaving) return new Response(null, { status: 400 });
    await ctx.runMutation(internal.presence.leaveByBeacon, leaving);
    return new Response(null, { status: 204 });
  }),
});

/** What a beacon names, or null for anything that is not a well-formed goodbye. */
export function leavingOf(body: string): { docId: string; sessionId: string; clientId?: number } | null {
  if (body.length > 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { docId, sessionId, clientId } = parsed as Record<string, unknown>;
  if (typeof docId !== "string" || !docId || docId.length > 256) return null;
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256) return null;
  if (clientId !== undefined && !Number.isSafeInteger(clientId)) return null;
  return { docId, sessionId, ...(clientId === undefined ? {} : { clientId: clientId as number }) };
}

/** Clerk's webhook: a change to an account's addresses in Clerk (`identity.ts`). */
http.route({ path: "/clerk/webhook", method: "POST", handler: clerkWebhook });

/**
 * Stripe's webhook.
 *
 * The component verifies the signature and keeps its own tables in step with
 * Stripe; the handler below runs after that and copies the result onto the
 * account, where `entitlements.ts` reads it. Mirroring rather than joining
 * keeps the entitlement read local — it is on the hot path of every completion
 * — and a handler that throws returns 500, which Stripe retries, so the two
 * copies converge rather than drift.
 *
 * `onEvent` rather than a list of subscription events: an invoice paid, a
 * payment recovered and a plan changed all move where an account stands, and
 * enumerating which ones do is a list that would go stale silently. Re-reading
 * one account is cheap enough not to need the distinction.
 *
 * Exported so what it routes where can be tested without a signed delivery.
 */
export async function onStripeEvent(
  ctx: Pick<GenericActionCtx<DataModel>, "runAction" | "runMutation">,
  event: Stripe.Event,
): Promise<void> {
  // Affiliate bookkeeping: who bought a workspace's plan, and a checkout that
  // took an affiliate's promotion code. Measurement, so it never fails the
  // delivery: a webhook that returned 500 over a referral would hold back the
  // mirror below until Stripe retried.
  // Each on its own, so one failing cannot cost the other.
  const buyer = teamBuyerOf(event);
  const discount = checkoutDiscountOf(event);
  const sessionId = (event.data.object as { id?: string }).id;
  if (buyer) {
    try {
      await ctx.runMutation(internal.teamBilling.recordBuyer, buyer);
    } catch (error) {
      console.error(`[affiliates] checkout ${sessionId}: buyer not recorded:`, error);
    }
  }
  if (discount) {
    try {
      await ctx.runAction(internal.billing.attributeCheckout, discount);
    } catch (error) {
      console.error(`[affiliates] checkout ${sessionId}: code not attributed:`, error);
    }
  }

  const object = event.data.object as { metadata?: Record<string, string> | null };
  // A workspace's customer, checkout and subscription name it as `orgId`
  // (`billing.startTeamCheckout`), and are never anybody's own: its mirror
  // is `teamBilling.mirror`, which reads Stripe for both of its items.
  if (object.metadata?.orgId) {
    const target = workspaceEventOf(object);
    if (target) await ctx.runAction(internal.teamBilling.mirror, target);
    return;
  }
  // Written by `billing.startCheckout` as `subscriptionMetadata`, which is
  // also how the component links its own rows to a user.
  const userId = object.metadata?.userId;
  if (!userId) return;
  await ctx.runMutation(internal.billing.mirrorSubscription, { userId });
}

registerRoutes(http, components.stripe, { onEvent: onStripeEvent });

/**
 * The GitHub App's webhook (docs/github-app.md). Here rather than in Next
 * because GitHub carries no Clerk session, and what it changes is internal.
 * The signature is checked over the raw bytes before anything is parsed; a
 * delivery that fails it learns nothing but 401.
 */
http.route({
  path: "/github/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const secret = process.env.GITHUB_APP_WEBHOOK_SECRET;
    if (!secret) return new Response("GitHub App webhook is not configured", { status: 503 });
    const body = await req.arrayBuffer();
    if (!(await signatureValid(secret, body, req.headers.get("x-hub-signature-256")))) {
      return new Response("Bad signature", { status: 401 });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return new Response("Body is not JSON", { status: 400 });
    }
    if (!payload || typeof payload !== "object") {
      return new Response("Body is not an object", { status: 400 });
    }
    await deliver(ctx, req.headers.get("x-github-event") ?? "", payload);
    return new Response(null, { status: 200 });
  }),
});

export default http;
