"use node";

import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Signing a stand-in token. Its own file because of `"use node"`: the private
 * key wants Node's crypto, and the runtime directive is per-module — the rest
 * of the mechanism (the ledger, the read-side query) stays on V8 in
 * `impersonation.ts`.
 *
 * The token is an ordinary OIDC id token that this deployment both issues and
 * verifies. Two claims carry the whole idea:
 *
 *   sub  the user being stood in for, so every existing read resolves to their
 *        rows without a single query knowing anything happened
 *   act  who is really behind it — the claim the write gates in `auth.ts` look
 *        for, and the only thing distinguishing this from the real user's token
 */

/** The public half's name, so the key can be rotated without a redeploy. */
function keyId(jwks: string): string {
  const parsed = JSON.parse(jwks) as { keys?: { kid?: string }[] };
  const kid = parsed.keys?.[0]?.kid;
  if (!kid) throw new ConvexError("IMPERSONATION_JWKS has no key in it.");
  return kid;
}

/**
 * The signing key, from the base64 DER `gen-impersonation-key.mjs` prints.
 *
 * DER rather than PEM because a PEM is multi-line, and a multi-line secret
 * does not survive the journey to an env var: a shell leaves `\n` inside
 * double quotes as a literal backslash-n, and the key then arrives looking
 * correct and parsing as garbage. This has been the failure once already, so
 * the unreadable case says what to do about it rather than surfacing as a
 * bare "Server Error".
 */
function signingKey(value: string): KeyObject {
  try {
    return createPrivateKey({
      key: Buffer.from(value, "base64"),
      format: "der",
      type: "pkcs8",
    });
  } catch {
    throw new ConvexError(
      "The signing key is unreadable. Re-run scripts/gen-impersonation-key.mjs " +
        "and set both variables again on this deployment.",
    );
  }
}

function segment(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export const start = action({
  args: {
    /** An operator session token — see `admin.login`. */
    token: v.string(),
    /** The Clerk subject to stand in for. */
    subject: v.string(),
    reason: v.string(),
  },
  returns: v.object({ token: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args): Promise<{ token: string; expiresAt: number }> => {
    const key = process.env.IMPERSONATION_PRIVATE_KEY;
    const jwks = process.env.IMPERSONATION_JWKS;
    const issuer = process.env.CONVEX_SITE_URL;
    if (!key || !jwks || !issuer) {
      // ConvexError, not Error: a production deployment redacts a plain
      // Error's message, and "Server Error" is not a thing an operator can
      // act on. Everything reachable by a misconfiguration says so out loud.
      throw new ConvexError(
        "Impersonation is not configured on this deployment. Run " +
          "scripts/gen-impersonation-key.mjs and set both variables.",
      );
    }

    // Read the key and name it before anything is written: a deployment whose
    // key will not parse should say so, not leave a ledger of sessions that
    // were never issued.
    const signer = signingKey(key);
    const kid = keyId(jwks);

    // Then the ledger: an unauthorized ask must not reach the key, and a token
    // that exists in no ledger must not exist at all.
    const grant = await ctx.runMutation(internal.impersonation.begin, args);

    const header = { alg: "RS256", typ: "JWT", kid };
    const payload = {
      iss: issuer,
      // `aud` matches the `applicationID` in `auth.config.ts` — the same value
      // Clerk's integration stamps, so Convex admits both issuers alike.
      aud: "convex",
      sub: args.subject,
      iat: Math.floor(grant.issuedAt / 1000),
      exp: Math.floor(grant.expiresAt / 1000),
      jti: grant.jti,
      // Flat rather than RFC 8693's `{ sub }` object: this is read on the hot
      // path of every write, and a string needs no narrowing there.
      act: "ops",
    };

    const signingInput = `${segment(header)}.${segment(payload)}`;
    const signature = createSign("RSA-SHA256")
      .update(signingInput)
      .end()
      .sign(signer)
      .toString("base64url");

    // The caller opens `{app origin}/impersonate#{token}` — in the fragment,
    // which browsers send to no server and write to no referrer.
    return { token: `${signingInput}.${signature}`, expiresAt: grant.expiresAt };
  },
});
