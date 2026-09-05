import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type QueryCtx,
} from "../_generated/server";
import { ownerId as currentOwner, requireOwner } from "../auth";
import { NotionError, json } from "./rest";
import { hasKey, MISSING_KEY, open, seal } from "./seal";

/**
 * The Notion connection, one per account.
 *
 * Not per project, for the same reason the GitHub one is not: a token is who
 * you are on Notion, and asking again per project would be asking the same
 * question twice. What is per project is which pages get imported into it.
 *
 * The token arrives already exchanged. `/api/notion/callback` does the OAuth
 * dance because that is where the Clerk session cookie is — Notion redirects a
 * browser, and a browser landing on a Convex HTTP action would arrive as
 * nobody. This action's job is to verify what it was handed and seal it.
 */

export type Account = {
  workspaceName: string;
  workspaceIcon?: string;
  hint: string;
  connectedAt: number;
  invalidAt?: number;
};

/**
 * What the client is allowed to know: everything except the token.
 *
 * `ready` is separate from `account` because "this deployment cannot store a
 * secret yet" and "nobody has connected one" are different problems with
 * different fixes — and a connect button offered before the key exists is a
 * button that fails on press.
 */
export const status = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ ready: boolean; blocker: string; account: Account | null }> => {
    const owner = await currentOwner(ctx);
    const row = owner ? await mine(ctx, owner) : null;
    return {
      ready: hasKey(),
      blocker: hasKey() ? "" : MISSING_KEY,
      account: row ? visible(row) : null,
    };
  },
});

/**
 * Store an access token the callback route has just exchanged.
 *
 * The `/users/me` call is the point: it proves the token works before a row
 * claims a connection exists, and it is the only way to learn the bot's own id
 * — which the import needs in order to tell its own edits from a person's.
 */
export const connect = action({
  args: {
    token: v.string(),
    workspaceId: v.string(),
    workspaceName: v.string(),
    workspaceIcon: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Account> => {
    const ownerId = await requireOwner(ctx);
    if (!hasKey()) throw new ConvexError(MISSING_KEY);

    const token = args.token.trim();
    if (!token) throw new ConvexError("Notion returned no access token.");

    const bot = await json<{ id?: string; bot?: unknown }>(token, "/users/me");
    if (!bot?.id) {
      throw new ConvexError("Notion answered without a bot id — that is not an integration token.");
    }

    const account: Account = {
      workspaceName: args.workspaceName || "Notion",
      ...(args.workspaceIcon ? { workspaceIcon: args.workspaceIcon } : {}),
      hint: token.slice(-4),
      connectedAt: Date.now(),
    };
    await ctx.runMutation(internal.notion.account.save, {
      ownerId,
      sealed: await seal(token),
      workspaceId: args.workspaceId,
      workspaceName: account.workspaceName,
      ...(args.workspaceIcon ? { workspaceIcon: args.workspaceIcon } : {}),
      botId: bot.id,
      hint: account.hint,
      connectedAt: account.connectedAt,
    });
    return account;
  },
});

export const disconnect = mutation({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireOwner(ctx);
    const row = await mine(ctx, ownerId);
    if (row) await ctx.db.delete(row._id);
  },
});

/**
 * Runs a Notion call with the account's token, and remembers a token Notion has
 * stopped accepting.
 *
 * The only place a stored token is ever opened. Notion issues no refresh token
 * and its access tokens do not expire, so a 401 means exactly one thing — the
 * user revoked the connection — and there is nothing to retry. Recording it is
 * what lets the UI say "reconnect" instead of failing identically forever while
 * still reading "connected".
 *
 * `ownerId` is passed rather than derived because the import job has no caller:
 * a page being converted an hour in is nobody's request.
 */
export async function withToken<T>(
  ctx: ActionCtx,
  ownerId: string,
  call: (token: string) => Promise<T>,
): Promise<T> {
  const row: Doc<"notionAccounts"> | null = await ctx.runQuery(
    internal.notion.account.forOwner,
    { ownerId },
  );
  if (!row) {
    throw new ConvexError("No Notion account is connected. Connect one to import pages.");
  }
  const token = await open(row.sealed);
  try {
    return await call(token);
  } catch (error) {
    if (error instanceof NotionError && error.unauthorized) {
      await ctx.runMutation(internal.notion.account.markInvalid, { ownerId });
    }
    throw error;
  }
}

// ---- Internal ------------------------------------------------------------

export const forOwner = internalQuery({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => await mine(ctx, args.ownerId),
});

export const save = internalMutation({
  args: {
    ownerId: v.string(),
    sealed: v.string(),
    workspaceId: v.string(),
    workspaceName: v.string(),
    workspaceIcon: v.optional(v.string()),
    botId: v.string(),
    hint: v.string(),
    connectedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await mine(ctx, args.ownerId);
    // Replaced rather than patched: reconnecting has to clear `invalidAt`, and
    // the workspace may not be the one connected last time.
    if (row) await ctx.db.replace(row._id, args);
    else await ctx.db.insert("notionAccounts", args);
  },
});

export const markInvalid = internalMutation({
  args: { ownerId: v.string() },
  handler: async (ctx, args) => {
    const row = await mine(ctx, args.ownerId);
    if (row && !row.invalidAt) await ctx.db.patch(row._id, { invalidAt: Date.now() });
  },
});

/** The owner's row, or null. One per owner, so the index answers uniquely. */
async function mine(
  ctx: QueryCtx,
  ownerId: string,
): Promise<Doc<"notionAccounts"> | null> {
  return await ctx.db
    .query("notionAccounts")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique();
}

function visible(row: Doc<"notionAccounts">): Account {
  return {
    workspaceName: row.workspaceName,
    ...(row.workspaceIcon ? { workspaceIcon: row.workspaceIcon } : {}),
    hint: row.hint,
    connectedAt: row.connectedAt,
    ...(row.invalidAt ? { invalidAt: row.invalidAt } : {}),
  };
}
