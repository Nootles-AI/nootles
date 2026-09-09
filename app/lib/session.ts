import { auth } from "@clerk/nextjs/server";

/**
 * The caller's Convex token, or null if they are not signed in.
 *
 * `proxy.ts` already turns anonymous requests away, so this is the second of two
 * locks rather than the only one — but these routes spend the model key, and a
 * matcher is one edit away from not covering them.
 *
 * The token is the raw Clerk session token: the dashboard's Convex integration
 * puts `aud: "convex"` on it, which is what `convex/auth.config.ts` checks.
 */
export async function sessionToken(): Promise<string | null> {
  const { getToken } = await auth();
  return await getToken();
}

/**
 * The caller's session, for a route whose one request outlives a token.
 *
 * The token above lives sixty seconds. The chat route streams for longer than
 * that — a whole design board read and a screen written back ran 62s — and
 * every Convex call it makes after the token's minute fails as unauthorised:
 * the cost ledger lost that turn, and a drawing put away after a slow artist
 * would go the same way. With the session id, `asSession` in `convexServer`
 * can mint a fresh token whenever the one it holds is too old.
 */
export async function session(): Promise<{ token: string; sessionId: string } | null> {
  const { getToken, sessionId } = await auth();
  const token = await getToken();
  return token && sessionId ? { token, sessionId } : null;
}
