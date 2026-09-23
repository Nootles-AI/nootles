import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { withToken } from "./account";
import { GitHubError } from "./rest";

/**
 * Which token a call about a linked repository is made with — decided here and
 * nowhere else, for the tools, the summary and the indexer alike.
 *
 * A repository linked through the workspace's GitHub App is read with that
 * installation's token. Everything else is read with its linker's own
 * connection (`account.withToken`), exactly as before the App existed —
 * unless its workspace has turned personal connections off.
 */
export async function withRepoToken<T>(
  ctx: ActionCtx,
  repo: Doc<"projectRepos">,
  call: (token: string) => Promise<T>,
): Promise<T> {
  const route = await ctx.runQuery(internal.github.installations.credentialFor, {
    repoId: repo._id,
  });
  if (route.kind === "refused") throw new ConvexError(route.reason);
  if (route.kind === "installation") return await withInstallation(ctx, route.installation, call);
  return await withToken(ctx, route.ownerId, call);
}

/**
 * A call with an installation's token. A 401 means the cached token no longer
 * holds — an installation whose permissions changed says so this way — so the
 * cache is skipped and the call made once more.
 */
export async function withInstallation<T>(
  ctx: ActionCtx,
  installation: Id<"githubInstallations">,
  call: (token: string) => Promise<T>,
): Promise<T> {
  const cached: string = await ctx.runAction(internal.github.appAuth.token, { installation });
  try {
    return await call(cached);
  } catch (error) {
    if (!(error instanceof GitHubError && error.unauthorized)) throw error;
  }
  const fresh: string = await ctx.runAction(internal.github.appAuth.token, {
    installation,
    fresh: true,
  });
  return await call(fresh);
}
