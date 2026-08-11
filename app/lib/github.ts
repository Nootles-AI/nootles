import { ConvexError } from "convex/values";

/**
 * What went wrong with a GitHub call, in words.
 *
 * Convex redacts the message of an ordinary thrown error before it leaves the
 * server, so everything worth reading — an unauthorised organisation, a spent
 * rate limit, a repository the token cannot see — is thrown as a `ConvexError`
 * carrying the sentence. This is the one place that unwraps it, so neither the
 * interface nor the agent is ever handed "[Request ID: …] Server Error".
 */
export function reason(error: unknown, fallback = "GitHub could not be reached."): string {
  if (error instanceof ConvexError) return String(error.data);
  return fallback;
}
