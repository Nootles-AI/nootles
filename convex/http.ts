import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

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

export default http;
