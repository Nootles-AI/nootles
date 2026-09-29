/**
 * What an affiliate link is: its address, the cookie it leaves, where it may
 * send someone, and the signature that makes a click count.
 *
 * Shared by `affiliates.ts` and the Next route that serves `/r/<slug>`, so the
 * two cannot disagree about a slug, a cookie or a canonical form. Constants and
 * pure functions only, and Web Crypto only, which both runtimes have: nothing
 * here may import from `_generated`, and nothing here may register a function.
 */

import { utcDay } from "./plans";

/** How long after their last click a visitor can still be attributed. */
export const ATTRIBUTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How far before a visitor's first click an account's earliest server-side
 * trace may be and still count as new. Both instants are this deployment's
 * own, so this is not for clock skew: it is for order — somebody who signed
 * up and then, minutes later, clicked the link that sent them.
 */
export const NEW_ACCOUNT_TOLERANCE_MS = 10 * 60 * 1000;

/** The first-party cookie that carries a click from `/r/<slug>` to sign-in. */
export const REF_COOKIE = "nt_ref";

/** Where a link goes when its affiliate is unknown, disabled or misconfigured. */
export const DEFAULT_DESTINATION = "https://nootles.com/";

export const AFFILIATE_SLUG_MIN = 2;
export const AFFILIATE_SLUG_MAX = 40;

/** Slugs that would read as the app's or the company's own rather than a person's. */
const RESERVED = new Set([
  "admin",
  "api",
  "app",
  "billing",
  "help",
  "login",
  "new",
  "nootles",
  "ops",
  "r",
  "settings",
  "sign-in",
  "sign-up",
  "signin",
  "signup",
  "support",
  "team",
  "www",
]);

/**
 * The form a slug is stored and looked up in — lowercase letters, digits and
 * single dashes — or null when there is no usable slug in `raw`.
 *
 * Refuses rather than truncates a long one: a link somebody pasted with extra
 * on the end must not quietly land on a different affiliate.
 */
export function normalizeAffiliateSlug(raw: string): string | null {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length < AFFILIATE_SLUG_MIN || slug.length > AFFILIATE_SLUG_MAX) return null;
  return RESERVED.has(slug) ? null : slug;
}

const DESTINATION_HOSTS = new Set(["nootles.com", "www.nootles.com", "app.nootles.com"]);

/**
 * Whether a link may send someone to `url`. Only our own sites over https, on
 * the default port, with no credentials in the address — the route redirects
 * without a word to whatever this admits, so anything looser is an open
 * redirect wearing our domain.
 *
 * The raw string is held to the same bar as the parsed one: a backslash, a
 * space or a control character is how a string parses one way here and
 * another in a browser.
 */
export function isAllowedDestination(url: string): boolean {
  if (!url.startsWith("https://") || /[\s\\\u0000-\u001f\u007f]/.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    DESTINATION_HOSTS.has(parsed.hostname) &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `id` is a visitor id: a UUID, as `crypto.randomUUID` writes one. */
export function isVisitorId(id: string): boolean {
  return UUID.test(id);
}

export type Ref = { slug: string; visitorId: string; clickedAt: number };

/** The cookie's value: `slug.visitorId.clickedAt`. None of the three can hold a dot. */
export function formatRef(ref: Ref): string {
  return `${ref.slug}.${ref.visitorId}.${ref.clickedAt}`;
}

/**
 * A cookie's value read back, or null for anything `formatRef` could not have
 * written. The cookie is the visitor's to edit, so this is untrusted input:
 * `attribute` looks the visit up server-side and takes the click's time from
 * there, never from here.
 */
export function parseRef(raw: string): Ref | null {
  if (raw.length > 128) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [rawSlug, visitorId, at] = parts;
  const slug = normalizeAffiliateSlug(rawSlug);
  if (slug !== rawSlug || !isVisitorId(visitorId) || !/^\d{1,15}$/.test(at)) return null;
  return { slug, visitorId, clickedAt: Number(at) };
}

/** The UTC day an instant falls on, `YYYY-MM-DD` — the unit of `affiliateDays`. */
export function dayKey(ms: number): string {
  return utcDay(ms);
}

/**
 * The secret as configured, or null for none. Trimmed, because an env var set
 * from a pasted line can carry a newline on one side and not the other, and
 * the two would then never agree.
 */
export function clickSecret(raw: string | undefined): string | null {
  return raw?.trim() || null;
}

/**
 * What the route signs for a click: which link, which visitor, and when — the
 * last so a captured signature is only good for minutes. Same shape and the
 * same reasoning as the ledger's (`ai/callSignature.ts`).
 */
export type SignedClick = { slug: string; visitorId: string; signedAt: number };

/** What is signed: every field, in a fixed order. */
export function canonicalClick(click: SignedClick): string {
  return JSON.stringify([click.slug, click.visitorId, click.signedAt]);
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
export async function signClick(secret: string, click: SignedClick): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await keyFor(secret),
    new TextEncoder().encode(canonicalClick(click)),
  );
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether `signature` is this click's. Web Crypto's own verify, so the compare
 * takes the same time wherever the two differ; a malformed one is simply false.
 */
export async function verifyClick(
  secret: string,
  click: SignedClick,
  signature: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const mac = new Uint8Array(32);
  for (let i = 0; i < 32; i++) mac[i] = parseInt(signature.slice(i * 2, i * 2 + 2), 16);
  return await crypto.subtle.verify(
    "HMAC",
    await keyFor(secret),
    mac,
    new TextEncoder().encode(canonicalClick(click)),
  );
}
