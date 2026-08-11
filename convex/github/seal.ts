/**
 * The stored access token, sealed.
 *
 * A GitHub token is the one secret in this database that belongs to somebody
 * else's systems — it can read every repository its owner can — so it is not
 * kept as text. AES-GCM under a key the deployment holds in an environment
 * variable means a copy of the data is not a copy of the credential.
 *
 * The key is required rather than optional. Sealing "when configured" would
 * leave rows whose safety you cannot tell by looking at them, which is worse
 * than not sealing at all.
 */

const ALGORITHM = "AES-GCM";
/** AES-256. GitHub tokens are short; the key is the only size that matters. */
const KEY_BYTES = 32;
/** The GCM standard, and what `crypto.subtle` expects without further argument. */
const IV_BYTES = 12;

export const MISSING_KEY =
  "GITHUB_TOKEN_KEY is not set on this deployment, so a GitHub token cannot be " +
  "stored safely. Set one with: npx convex env set GITHUB_TOKEN_KEY " +
  '"$(openssl rand -base64 32)"';

/** Whether a token could be stored at all — asked before the form is offered. */
export function hasKey(): boolean {
  return !!process.env.GITHUB_TOKEN_KEY;
}

async function key(): Promise<CryptoKey> {
  const configured = process.env.GITHUB_TOKEN_KEY;
  if (!configured) throw new Error(MISSING_KEY);
  const raw = decode(configured);
  if (raw.length !== KEY_BYTES) {
    throw new Error(
      `GITHUB_TOKEN_KEY must be ${KEY_BYTES} bytes of base64; it is ${raw.length}.`,
    );
  }
  return await crypto.subtle.importKey("raw", raw, ALGORITHM, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Ciphertext as base64, the random iv carried in front of it. */
export async function seal(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const body = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    await key(),
    new TextEncoder().encode(plain),
  );
  const joined = new Uint8Array(iv.length + body.byteLength);
  joined.set(iv);
  joined.set(new Uint8Array(body), iv.length);
  return encode(joined);
}

export async function open(sealed: string): Promise<string> {
  const joined = decode(sealed);
  const plain = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: joined.subarray(0, IV_BYTES) },
    await key(),
    joined.subarray(IV_BYTES),
  );
  return new TextDecoder().decode(plain);
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* The explicit buffer parameter is what keeps these assignable to BufferSource:
   a bare `Uint8Array` is over `ArrayBufferLike`, which admits SharedArrayBuffer
   and so is not what `crypto.subtle` accepts. */
function decode(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
