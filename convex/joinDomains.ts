/**
 * Which email domains may open a workspace to everyone on them.
 *
 * Split out of `workspaces.ts`, like `slugs.ts`, so the members screen can say
 * why a domain would be refused before anyone asks. Constants and pure
 * functions only: nothing here may import from `_generated`, and nothing here
 * may register a function.
 */

/**
 * Anyone can hold an address on these, so proving you hold one proves nothing
 * about which team you are on.
 */
const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "mail.com",
]);

export function isPersonalDomain(domain: string): boolean {
  return PERSONAL_DOMAINS.has(domain.trim().toLowerCase());
}
