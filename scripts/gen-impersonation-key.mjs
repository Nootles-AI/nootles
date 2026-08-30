/**
 * Mints the signing key for operator stand-in sessions.
 *
 * Nootles is its own OIDC provider for exactly one purpose: the ops dashboard
 * hands a founder a short-lived token that reads as a chosen user. Convex
 * verifies it against the JWKS served from `convex/http.ts`, so both halves of
 * the pair live in Convex deployment env vars and nowhere else.
 *
 *   node scripts/gen-impersonation-key.mjs
 *
 * Prints the two `npx convex env set` commands. Run them against one
 * deployment at a time — dev and prod hold different keys, so a token minted
 * against dev is worthless in prod, which is the property you want.
 *
 * Rotation is re-running this: the new public half replaces the old in the
 * JWKS, and every token signed by the retired key stops verifying at once.
 */
import { createHash, generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

const jwk = publicKey.export({ format: "jwk" });

/** RFC 7638 thumbprint — a name for the key derived from the key itself. */
const kid = createHash("sha256")
  .update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }))
  .digest("base64url");

/**
 * The private half as base64 DER, not PEM.
 *
 * A PEM is multi-line, and a multi-line value does not survive being pasted:
 * inside double quotes a shell leaves `\n` as a literal backslash-n, so the
 * key arrives looking right and parsing as garbage. Base64 DER is one line of
 * `[A-Za-z0-9+/=]` — nothing a shell, a dashboard field, or a CI secret store
 * can transform. `impersonationMint.ts` reads it back in exactly this form.
 */
const der = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const jwks = JSON.stringify({
  keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }],
});

/**
 * Both variables, for one deployment. Never mix a key across deployments.
 *
 * Single quotes: the JWKS is JSON and full of double quotes, and neither value
 * can contain a single quote, so this is the one quoting that needs no
 * escaping and survives a copy-paste intact.
 */
const commands = (flag) =>
  [
    `  npx convex env set ${flag}IMPERSONATION_PRIVATE_KEY -- '${der}'`,
    "",
    `  npx convex env set ${flag}IMPERSONATION_JWKS -- '${jwks}'`,
  ].join("\n");

process.stdout.write(
  [
    "A fresh keypair. Run BOTH commands from one block, and only one block —",
    "a key is per-deployment, and mixing them means tokens that never verify.",
    "",
    "── PRODUCTION ─────────────────────────────────────────────────────────",
    commands("--prod "),
    "",
    "── DEV ────────────────────────────────────────────────────────────────",
    commands(""),
    "",
    "The private half is a master key: it can mint a session for any user.",
    "Do not commit it, and do not paste it anywhere it will be logged.",
    "",
  ].join("\n"),
);
