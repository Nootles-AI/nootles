import { httpRouter } from "convex/server";
import { registerRoutes } from "@convex-dev/stripe";
import { components, internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { deliver, signatureValid } from "./github/webhook";
import { clerkWebhook } from "./identity";

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
      // There is no interactive flow here — tokens are minted by an operator
      // action, never by a browser redirect — but a discovery document is
      // required to name an authorization endpoint, so it names one that 404s.
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
 */
registerRoutes(http, components.stripe, {
  onEvent: async (ctx, event) => {
    const object = event.data.object as { metadata?: Record<string, string> };
    // Written by `billing.startCheckout` as `subscriptionMetadata`, which is
    // also how the component links its own rows to a user.
    const userId = object.metadata?.userId;
    if (!userId) return;
    await ctx.runMutation(internal.billing.mirrorSubscription, { userId });
  },
});

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
