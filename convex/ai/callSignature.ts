/**
 * The ledger's signature: an HMAC-SHA256 under `AI_LEDGER_SECRET` over the
 * part of an `aiCalls` row money is worked out from. The Next routes sign
 * each row as they record it (`app/lib/ai/recordCall.ts`), and
 * `ai/calls.record` signs it again and compares.
 *
 * The writer is a public mutation — the routes act as the user, so anyone
 * with a session can call it, with any cost and any project. That was
 * harmless while the ledger was only ops' view of spend; a workspace is billed
 * from it. Only the Next server holds the secret, so only a row it wrote can
 * carry a signature that verifies.
 *
 * Shared by both ends so the canonical form cannot drift, and Web Crypto only,
 * which both runtimes have. No `_generated` imports, for the same reason as
 * `limits.ts`.
 */

export type SignedCall = {
  /** The Clerk subject, from the session on one side and the token on the other. */
  ownerId: string;
  projectId?: string;
  feature: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  /** When the route signed it — bounds how long a signature is any good. */
  signedAt: number;
};

/** What is signed: every field, in a fixed order, absent as null. */
export function canonicalCall(call: SignedCall): string {
  return JSON.stringify([
    call.ownerId,
    call.projectId ?? null,
    call.feature,
    call.model,
    call.promptTokens ?? null,
    call.completionTokens ?? null,
    call.cacheReadTokens ?? null,
    call.cacheWriteTokens ?? null,
    call.costUsd ?? null,
    call.signedAt,
  ]);
}

/**
 * The secret as configured, or null for none. Trimmed, because an env var set
 * from a pasted line can carry a newline on one side and not the other, and
 * the two would then never agree.
 */
export function ledgerSecret(raw: string | undefined): string | null {
  return raw?.trim() || null;
}

async function keyFor(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** The signature, as lowercase hex. */
export async function signCall(secret: string, call: SignedCall): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await keyFor(secret),
    new TextEncoder().encode(canonicalCall(call)),
  );
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether `signature` is this call's. Web Crypto's own verify, so the compare
 * takes the same time wherever the two differ; a malformed one is simply false.
 */
export async function verifyCall(
  secret: string,
  call: SignedCall,
  signature: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const mac = new Uint8Array(32);
  for (let i = 0; i < 32; i++) mac[i] = parseInt(signature.slice(i * 2, i * 2 + 2), 16);
  return await crypto.subtle.verify(
    "HMAC",
    await keyFor(secret),
    mac,
    new TextEncoder().encode(canonicalCall(call)),
  );
}
