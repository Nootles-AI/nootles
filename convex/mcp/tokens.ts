/**
 * The OAuth vocabulary shared by the HTTP handlers and the functions behind
 * them. Pure: Web Crypto and string checks only, so it runs in the isolate,
 * an HTTP action and a test alike.
 */

/** List and read your served documents. */
export const READ_SCOPE = "docs:read";
/** Edit them, each edit attributed to the agent and undoable (NT-123). */
export const WRITE_SCOPE = "docs:write";
export const SCOPES = [READ_SCOPE, WRITE_SCOPE] as const;
/** What a client that names no scope is asking for: everything, decided at consent. */
export const ALL_SCOPES = SCOPES.join(" ");

export function hasScope(granted: string, scope: (typeof SCOPES)[number]): boolean {
  return granted.split(/\s+/).includes(scope);
}

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;
export const REQUEST_TTL_MS = 10 * 60 * 1000;

/** What a secret is called in a log line or error — never the secret itself. */
export type TokenKind = "access" | "refresh" | "code" | "request" | "client" | "secret";

const PREFIX: Record<TokenKind, string> = {
  access: "nta_",
  refresh: "ntr_",
  code: "ntc_",
  request: "ntq_",
  client: "ntcl_",
  secret: "nts_",
};

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 256 random bits, prefixed so a leaked token says what it is. Only ever called
 * from an action or an HTTP action: a query's or mutation's randomness is
 * seeded for determinism, which is the wrong property for a secret.
 */
export function mintToken(kind: TokenKind): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return PREFIX[kind] + base64url(bytes);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** RFC 7636: a verifier is 43–128 unreserved characters. */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
/** An S256 challenge is the base64url of a SHA-256: always 43 characters. */
export const CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;

export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!VERIFIER.test(verifier)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return timingSafeEqual(base64url(new Uint8Array(digest)), challenge);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A redirect URI a client may register: https anywhere, or http on loopback for
 * a native app's local listener (RFC 8252 §7.3). No fragment, no credentials in
 * the URL, and nothing but these two schemes — a custom scheme is how a
 * malicious page would ask the browser to hand the code to an app of its choice.
 */
export function validRedirectUri(uri: string): boolean {
  if (uri.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK.has(url.hostname);
}

/**
 * `scope` as asked for, in canonical order; absent asks for everything. Write
 * brings read with it — an agent cannot edit what it cannot see. Anything
 * unknown fails the whole request rather than being quietly dropped.
 */
export function grantedScope(requested: string | null | undefined): string | null {
  if (!requested) return ALL_SCOPES;
  const asked = new Set(requested.split(/\s+/).filter(Boolean));
  if (asked.size === 0 || ![...asked].every((s) => (SCOPES as readonly string[]).includes(s))) return null;
  if (asked.has(WRITE_SCOPE)) asked.add(READ_SCOPE);
  return SCOPES.filter((s) => asked.has(s)).join(" ");
}

/** A consent that turned edits off keeps what was asked for, less writing. */
export function withoutWrite(scope: string): string {
  return scope.split(/\s+/).filter((s) => s && s !== WRITE_SCOPE).join(" ") || READ_SCOPE;
}

/** The redirect back to the client, carrying `params` and the client's state. */
export function redirectWith(
  redirectUri: string,
  params: Record<string, string>,
  state: string | undefined,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (state !== undefined) url.searchParams.set("state", state);
  return url.toString();
}
