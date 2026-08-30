"use client";

/**
 * The browser half of an operator stand-in session.
 *
 * A cookie rather than sessionStorage for one reason: `proxy.ts` has to see it
 * too, so it can keep the AI routes — which spend the model key and write as
 * whoever asked — shut for the duration. Same-origin, and its lifetime is the
 * token's own, so the tab cannot outlive the session it is holding.
 *
 * Nothing here verifies anything. The signature is Convex's business; this only
 * decides what the chrome says and when to stop.
 */

export const IMPERSONATION_COOKIE = "nt_imp";

/** `exp`, in ms — 0 for anything unreadable, which reads as "already over". */
export function expiryOf(token: string): number {
  try {
    const claims = token.split(".")[1];
    const json = atob(claims.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** The token this tab is standing in with, or null. Expired counts as null. */
export function impersonationToken(): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${IMPERSONATION_COOKIE}=`;
  const token = document.cookie
    .split("; ")
    .find((c) => c.startsWith(prefix))
    ?.slice(prefix.length);
  if (!token) return null;
  return expiryOf(token) > Date.now() ? token : null;
}

export function beginImpersonation(token: string): void {
  const seconds = Math.max(0, Math.floor((expiryOf(token) - Date.now()) / 1000));
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${IMPERSONATION_COOKIE}=${token}; Path=/; Max-Age=${seconds}; SameSite=Strict${secure}`;
}

export function endImpersonation(): void {
  document.cookie = `${IMPERSONATION_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict`;
}
