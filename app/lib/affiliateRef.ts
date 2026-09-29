import { ATTRIBUTION_WINDOW_MS, REF_COOKIE } from "@/convex/affiliateRules";

/**
 * The `nt_ref` cookie from both of its ends: the `/r/<slug>` route that
 * writes it and the claim effect (`AffiliateClaim`) that spends it. Pure, so
 * both, and their tests, read it the same way.
 */

/** How long the cookie lives: as long as a click can still be attributed. */
export const REF_MAX_AGE_S = ATTRIBUTION_WINDOW_MS / 1000;

/**
 * The cookie's raw value in a `Cookie` header or `document.cookie` — both are
 * `name=value` pairs split by `;` — or null. Raw because what it holds is
 * untrusted either way: the route runs it through `parseRef`, and `attribute`
 * looks the visit up server-side.
 */
export function refFromCookies(cookies: string | null | undefined): string | null {
  for (const pair of (cookies ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0 || pair.slice(0, eq).trim() !== REF_COOKIE) continue;
    const value = pair.slice(eq + 1).trim();
    return value || null;
  }
  return null;
}

/**
 * The ref this tab should claim, or null for none: only for a signed-in
 * session that is the person's own. An operator standing in is not the
 * person who clicked — and the server refuses their writes anyway — so their
 * cookie is left where it is.
 */
export function refToClaim(
  cookies: string,
  session: { authenticated: boolean; standingIn: boolean },
): string | null {
  if (!session.authenticated || session.standingIn) return null;
  return refFromCookies(cookies);
}

/**
 * What `document.cookie` is set to to forget the ref. The route writes it
 * host-only on `/`, so the same path with no domain is what removes it.
 */
export function clearedRefCookie(secure: boolean): string {
  return `${REF_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure ? "; Secure" : ""}`;
}
