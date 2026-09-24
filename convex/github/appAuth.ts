"use node";

import { ConvexError, v } from "convex/values";
import type { KeyObject } from "node:crypto";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import { signingKey, signJwt } from "../signing";
import { unusable } from "./installations";
import { GitHubError, json } from "./rest";
import { open, seal } from "./seal";

/**
 * Speaking as the Nootles GitHub App (docs/github-app.md).
 *
 * The App proves itself with a short JWT signed by its private key, and trades
 * that for an installation token: an hour's read of the repositories one
 * installation was given. The JWT never leaves this module; the installation
 * token is cached sealed on the installation's row and handed to
 * `credential.ts`, the one place that decides which token a call is made with.
 */

/** A token with less than this left is re-minted rather than handed out. */
const MIN_LEFT_MS = 5 * 60_000;

/**
 * The App's JWT. Back-dated a minute for clock drift, and valid for nine —
 * GitHub refuses one that claims more than ten.
 */
export function appJwt(appId: string, key: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  return signJwt({ alg: "RS256", typ: "JWT" }, { iat: now - 60, exp: now + 540, iss: appId }, key);
}

function appKey(): { appId: string; key: KeyObject } {
  const appId = process.env.GITHUB_APP_ID;
  const value = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !value) {
    throw new ConvexError(
      "The GitHub App is not set up on this deployment: GITHUB_APP_ID and " +
        "GITHUB_APP_PRIVATE_KEY are missing (docs/github-app.md).",
    );
  }
  return {
    appId,
    key: signingKey(
      value,
      "GITHUB_APP_PRIVATE_KEY is unreadable. It is the base64 of the key as " +
        "PKCS#8 DER — see docs/github-app.md for the one-line conversion.",
    ),
  };
}

/**
 * An installation token for one of a workspace's installations: the cached
 * one while it has five minutes left, otherwise a new one. `fresh` skips the
 * cache — asked after GitHub refused the cached token, which happens when an
 * installation's permissions change under it.
 */
export const token = internalAction({
  args: { installation: v.id("githubInstallations"), fresh: v.optional(v.boolean()) },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const row: Doc<"githubInstallations"> | null = await ctx.runQuery(
      internal.github.installations.row,
      { id: args.installation },
    );
    if (!row) throw new ConvexError("That GitHub App installation is no longer part of this workspace.");
    const refused = unusable(row);
    if (refused) throw new ConvexError(refused);

    const now = Date.now();
    if (!args.fresh && row.token && row.token.expiresAt - now > MIN_LEFT_MS) {
      return await open(row.token.sealed);
    }

    const { appId, key } = appKey();
    let minted: { token: string; expires_at: string } | null;
    try {
      minted = await json<{ token: string; expires_at: string }>(
        appJwt(appId, key, now),
        `/app/installations/${row.installationId}/access_tokens`,
        { method: "POST" },
      );
    } catch (error) {
      throw mintRefused(row, error, now);
    }
    if (!minted?.token) throw new ConvexError("GitHub minted no installation token.");
    const expiresAt = Date.parse(minted.expires_at);
    await ctx.runMutation(internal.github.installations.saveToken, {
      id: row._id,
      sealed: await seal(minted.token),
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : now + 55 * 60_000,
    });
    return minted.token;
  },
});

/**
 * GitHub refusing to mint, said as what happened to the installation. Its
 * webhook marks an uninstall or a suspension, but a delivery can be late or
 * lost, and until it lands GitHub's own answer is the only word — which
 * `rest.explain` would put in a personal token's terms.
 */
function mintRefused(row: Doc<"githubInstallations">, error: unknown, now: number): unknown {
  if (!(error instanceof GitHubError)) return error;
  if (error.status === 404) return new ConvexError(unusable({ ...row, removedAt: now })!);
  if (error.status === 403 && !error.rateLimited) {
    return new ConvexError(unusable({ ...row, suspendedAt: now })!);
  }
  if (error.status === 401) {
    return new ConvexError(
      "GitHub refused the Nootles GitHub App’s own credentials. An admin of this " +
        "deployment should check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY (docs/github-app.md).",
    );
  }
  return error;
}
