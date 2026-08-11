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
import { GitHubError, json, request } from "./rest";
import { hasKey, MISSING_KEY, open, seal } from "./seal";

/**
 * The GitHub connection, one per account.
 *
 * Deliberately not per project: a token is who you are on GitHub, and repeating
 * it on every project would be asking the same question again and again. What is
 * per project is which repositories that identity is pointed at — `repos.ts`.
 *
 * A personal access token rather than an App because a token is the only thing
 * that works inside somebody else's organisation without an owner installing
 * anything: a classic token authorised for the org's SSO, or a fine-grained one
 * where the org permits them. Both are accepted; which one you pasted is read
 * off the prefix, and only affects what we can tell you about it afterwards.
 */

/** Fine-grained tokens announce themselves; everything else is classic. */
const FINE_GRAINED = "github_pat_";

export type Account = {
  login: string;
  hint: string;
  kind: "classic" | "fine-grained";
  scopes?: string[];
  orgs?: string[];
  connectedAt: number;
  invalidAt?: number;
};

/**
 * What the client is allowed to know: everything except the token.
 *
 * `ready` is separate from `account` because "this deployment cannot store a
 * secret yet" and "nobody has connected one" are different problems with
 * different fixes — and a connect form offered before the key exists is a form
 * that fails on submit.
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
 * Store a token, once GitHub has agreed it is one.
 *
 * The check is the point: a token pasted with a character missing, or never
 * authorised for the organisation it is needed in, fails here — where there is
 * a person watching and a field to correct it in — rather than three days later
 * in the middle of a chat turn.
 */
export const connect = action({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<Account> => {
    const ownerId = await requireOwner(ctx);
    if (!hasKey()) throw new ConvexError(MISSING_KEY);

    const token = args.token.trim();
    if (!token) throw new ConvexError("Paste a token first.");

    const res = await request(token, "/user");
    const user = (await res!.json()) as { login?: string };
    if (!user.login) {
      throw new ConvexError("GitHub answered without a login — that is not a user token.");
    }

    // Classic tokens report their scopes in a header; fine-grained ones report
    // nothing at all. An empty list is stored as absent rather than as `[]`,
    // because "we cannot tell" and "none" are not the same claim.
    const granted = res!.headers.get("x-oauth-scopes")?.trim();
    const scopes = granted
      ? granted.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

    // Best effort. A classic token without `read:org` sees only the memberships
    // that are public, which is still worth showing rather than failing over.
    const orgs = await json<{ login: string }[]>(token, "/user/orgs", {
      query: { per_page: 100 },
    })
      .then((rows) => rows?.map((o) => o.login))
      .catch(() => undefined);

    const account: Account = {
      login: user.login,
      hint: token.slice(-4),
      kind: token.startsWith(FINE_GRAINED) ? "fine-grained" : "classic",
      ...(scopes?.length ? { scopes } : {}),
      ...(orgs?.length ? { orgs } : {}),
      connectedAt: Date.now(),
    };
    await ctx.runMutation(internal.github.account.save, {
      ...account,
      ownerId,
      sealed: await seal(token),
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
 * Runs a GitHub call with the account's token, and remembers a token GitHub has
 * stopped accepting.
 *
 * The only place a stored token is ever opened. Every GitHub request this app
 * makes on a user's behalf goes through here, so there is one answer to where
 * the token goes and one place that notices when it dies — without which a
 * revoked token fails identically forever while the UI still reads "connected".
 *
 * `ownerId` is passed rather than derived because scheduled work has no caller:
 * the sync that runs after a repo is linked is nobody's request.
 */
export async function withToken<T>(
  ctx: ActionCtx,
  ownerId: string,
  call: (token: string) => Promise<T>,
): Promise<T> {
  const row: Doc<"githubAccounts"> | null = await ctx.runQuery(
    internal.github.account.forOwner,
    { ownerId },
  );
  if (!row) {
    throw new ConvexError(
      "No GitHub account is connected. Connect one in the project's context.",
    );
  }
  const token = await open(row.sealed);
  try {
    return await call(token);
  } catch (error) {
    if (error instanceof GitHubError && error.unauthorized) {
      await ctx.runMutation(internal.github.account.markInvalid, { ownerId });
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
    login: v.string(),
    hint: v.string(),
    kind: v.union(v.literal("classic"), v.literal("fine-grained")),
    scopes: v.optional(v.array(v.string())),
    orgs: v.optional(v.array(v.string())),
    connectedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await mine(ctx, args.ownerId);
    // Replaced rather than patched: reconnecting has to clear `invalidAt`, and
    // any scope the old token had that this one does not.
    if (row) await ctx.db.replace(row._id, args);
    else await ctx.db.insert("githubAccounts", args);
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
): Promise<Doc<"githubAccounts"> | null> {
  return await ctx.db
    .query("githubAccounts")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique();
}

function visible(row: Doc<"githubAccounts">): Account {
  return {
    login: row.login,
    hint: row.hint,
    kind: row.kind,
    ...(row.scopes ? { scopes: row.scopes } : {}),
    ...(row.orgs ? { orgs: row.orgs } : {}),
    connectedAt: row.connectedAt,
    ...(row.invalidAt ? { invalidAt: row.invalidAt } : {}),
  };
}
