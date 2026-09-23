/** Stands in for this origin where only a bare path is acceptable. */
const PATHS_ONLY = "https://nootles.invalid";

/**
 * Where a sign-in lands afterwards: a path on this origin, or home.
 *
 * Read from Clerk's `redirect_url` on the door (an absolute URL, checked
 * against `origin`) and from the callback's own `?return=` (always a path we
 * wrote, so checked against nothing but itself). Anything that resolves off
 * the origin — another host, `//host`, `/\host`, a `javascript:` URL — is
 * someone else's address and is not followed, and the sign-in round trip is
 * never a destination of its own.
 */
export function returnPath(raw: string | null | undefined, origin: string = PATHS_ONLY): string {
  if (!raw) return "/";
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return "/";
  }
  if (url.origin !== origin) return "/";
  if (/^\/(sign-in|sso-callback)(\/|$)/.test(url.pathname)) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
