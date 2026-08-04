import { ConvexHttpClient } from "convex/browser";

/**
 * A Convex client that reads and writes AS the caller.
 *
 * `token` is their Clerk session token. Convex scopes every row by owner, so a
 * client without it reads an empty project — the routes act on the user's data
 * as the user, never as the server.
 */
export function asUser(token: string): ConvexHttpClient {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set");
  const convex = new ConvexHttpClient(url);
  convex.setAuth(token);
  return convex;
}
