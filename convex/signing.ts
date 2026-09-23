"use node";

import { Buffer } from "node:buffer";
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { ConvexError } from "convex/values";

/**
 * RS256 signing, for the two tokens this deployment mints: an operator's
 * stand-in (`impersonationMint.ts`) and a GitHub App's JWT
 * (`github/appAuth.ts`). Node-only, because the private key wants Node's
 * crypto — so only `"use node"` modules may import this.
 */

/**
 * A private key from base64 PKCS#8 DER.
 *
 * DER rather than PEM because a PEM is multi-line, and a multi-line secret
 * does not survive the journey to an env var: a shell leaves `\n` inside
 * double quotes as a literal backslash-n, and the key then arrives looking
 * correct and parsing as garbage. `unreadable` says what to do about it,
 * rather than surfacing as a bare "Server Error".
 */
export function signingKey(value: string, unreadable: string): KeyObject {
  try {
    return createPrivateKey({
      key: Buffer.from(value, "base64"),
      format: "der",
      type: "pkcs8",
    });
  } catch {
    throw new ConvexError(unreadable);
  }
}

/** A compact JWS: `header.payload.signature`, signed RSA-SHA256. */
export function signJwt(header: object, payload: object, key: KeyObject): string {
  const input = `${segment(header)}.${segment(payload)}`;
  const signature = createSign("RSA-SHA256").update(input).end().sign(key).toString("base64url");
  return `${input}.${signature}`;
}

function segment(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
