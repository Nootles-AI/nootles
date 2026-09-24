import { ConvexError } from "convex/values";

/**
 * What to say when a workspace write fails: the server's own sentence when it
 * refused in words (`ConvexError` with a string), and `fallback` for anything
 * else — a dropped connection, a "Not found" that must not say more.
 */
export function refusal(error: unknown, fallback: string): string {
  return error instanceof ConvexError && typeof error.data === "string" ? error.data : fallback;
}
