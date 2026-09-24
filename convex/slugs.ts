/**
 * What a workspace's address may be.
 *
 * Split out of `workspaces.ts` so the browser can preview an address with the
 * very rules the server keeps it by, without importing a module that
 * registers functions. Constants and pure functions only: nothing here may
 * import from `_generated`, and nothing here may register a function.
 */

export const SLUG_MIN = 3;
export const SLUG_MAX = 32;

/** Addresses that would read as one of `/w/`'s own pages rather than a workspace. */
const RESERVED = new Set([
  "new",
  "join",
  "invite",
  "settings",
  "members",
  "billing",
  "audit",
  "integrations",
  "api",
  "p",
  "w",
  "admin",
  "help",
  "support",
  "www",
  "app",
  "nootles",
]);

/**
 * An address as it is being typed: {@link normalizeSlug} short of trimming
 * the end, so the dash someone has just typed between two words survives
 * until the second one arrives.
 */
export function typingSlug(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, SLUG_MAX);
}

/**
 * What an address becomes: lowercase letters, digits and single dashes, at
 * most 32 characters. It truncates rather than refuses, so a preview shows
 * exactly the address that will be kept.
 */
export function normalizeSlug(raw: string): string {
  return typingSlug(raw).replace(/-+$/, "");
}

/** Why a normalized address cannot be used, in words, or null if it can. */
export function slugProblem(slug: string): string | null {
  if (slug.length < SLUG_MIN) {
    return `A workspace address needs at least ${SLUG_MIN} letters or numbers.`;
  }
  if (RESERVED.has(slug)) return `“${slug}” is reserved. Try another address.`;
  return null;
}

export const SLUG_TAKEN = "That address is taken. Try another.";
