/**
 * What an invitation's address may be.
 *
 * Split out of `members.ts` so the invite form can judge an address by the
 * very rule the server keeps, without importing a module that registers
 * functions. Pure functions only: nothing here may import from `_generated`,
 * and nothing here may register a function.
 */

export const NOT_AN_EMAIL = "That doesn’t look like an email address.";

/** An address as it is kept: trimmed and lower-cased. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Something, an @, something, a dot, something — the most that can be known before sending. */
export function plausibleEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(raw));
}
