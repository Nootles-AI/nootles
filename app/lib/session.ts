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
