/**
 * Svix's webhook signature, which is how Clerk signs what it sends. The
 * signature is an HMAC-SHA256 of `${id}.${timestamp}.${body}` under the
 * endpoint's `whsec_` secret, sent as a space-separated list of
 * `v1,<base64>` — more than one while a secret is being rotated. The
 * timestamp is part of what is signed, so bounding it is what stops a
 * captured delivery from being replayed.
 */

const TOLERANCE_MS = 5 * 60 * 1000;

export async function verifySvix(
  secret: string,
  headers: Headers,
  body: string,
  now: number,
): Promise<boolean> {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  const keyBytes = base64(secret.replace(/^whsec_/, ""));
  if (!id || !timestamp || !signatures || !keyBytes?.length) return false;
  const sentAt = Number(timestamp) * 1000;
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > TOLERANCE_MS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${id}.${timestamp}.${body}`),
    ),
  );
  return signatures.split(" ").some((entry) => {
    const [version, signature] = entry.split(",");
    const given = version === "v1" && signature ? base64(signature) : null;
    return given !== null && sameBytes(expected, given);
  });
}

/** Null for anything that isn't base64, which no signature or secret is. */
function base64(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Time spent does not depend on where the bytes differ. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
