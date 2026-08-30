/**
 * Mints the signing key for operator stand-in sessions.
 *
 * Nootles is its own OIDC provider for exactly one purpose: the ops dashboard
 * hands a founder a short-lived token that reads as a chosen user. Convex
 * verifies it against the JWKS served from `convex/http.ts`, so both halves of
 * the pair live in Convex deployment env vars and nowhere else.
 *
 *   node scripts/gen-impersonation-key.mjs --prod   sets both, on production
 *   node scripts/gen-impersonation-key.mjs --dev    sets both, on dev
 *   node scripts/gen-impersonation-key.mjs          prints the commands instead
 *
 * Prefer the first two. The copy-paste path has now been wrong twice — a shell
 * is an eager reader of anything a key contains — and the flags hand the value
 * to `convex` as one argv element, where no shell ever sees it. Nothing prints
 * the private half at all.
 *
 * One deployment at a time, always: dev and prod hold different keys, so a
 * token minted against dev is worthless in prod, which is the property you
 * want. Rotation is re-running this — the new public half replaces the old in
 * the JWKS, and every token signed by the retired key stops verifying at once.
 */
import { spawnSync } from "node:child_process";
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

const target = process.argv.includes("--prod")
  ? "prod"
  : process.argv.includes("--dev")
    ? "dev"
    : null;

if (!target) {
  process.stdout.write(
    [
      "A fresh keypair. Run BOTH commands from one block, and only one block —",
      "a key is per-deployment, and mixing them means tokens that never verify.",
      "",
      "Or skip the paste entirely, which is the safer path:",
      "",
      "  node scripts/gen-impersonation-key.mjs --prod",
      "  node scripts/gen-impersonation-key.mjs --dev",
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
  process.exit(0);
}

/**
 * Hands the value to `convex` as one argv element. No shell is involved, so
 * there is nothing to quote and nothing to expand — which is the whole reason
 * this mode exists.
 */
function set(name, value) {
  const args = ["convex", "env", "set"];
  if (target === "prod") args.push("--prod");
  args.push(name, "--", value);
  const result = spawnSync("npx", args, { stdio: ["ignore", "ignore", "inherit"] });
  if (result.status !== 0) {
    process.stderr.write(`\nFailed to set ${name}. Nothing further was set.\n`);
    process.exit(1);
  }
  process.stdout.write(`  set ${name}\n`);
}

process.stdout.write(`Keying ${target}…\n`);
// The private half first: a deployment holding a published JWKS it cannot sign
// for is worse than one that is plainly unconfigured.
set("IMPERSONATION_PRIVATE_KEY", der);
set("IMPERSONATION_JWKS", jwks);
process.stdout.write(
  [
    "",
    `Done. Key ${kid.slice(0, 12)}… is live on ${target}.`,
    target === "prod"
      ? "Any stand-in session minted before now has stopped verifying."
      : "",
    "",
  ]
    .filter(Boolean)
    .join("\n"),
);
