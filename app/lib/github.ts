import { ConvexError } from "convex/values";
import type { Listed } from "@/convex/github/repos";

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

/**
 * The App's repositories with the person's own beside them: one row per
 * repository, the App's where both reach it, since that is the credential a
 * workspace project should read with. Most recently pushed first.
 */
export function mergeRepos(installed: readonly Listed[], own: readonly Listed[]): Listed[] {
  const seen = new Set(installed.map((r) => r.fullName.toLowerCase()));
  return [...installed, ...own.filter((r) => !seen.has(r.fullName.toLowerCase()))].sort((a, b) =>
    (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""),
  );
}
