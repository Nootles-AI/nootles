import { v } from "convex/values";
import { internal } from "../_generated/api";
import { action, internalMutation, internalQuery } from "../_generated/server";
import { requireOwner, requireWorkspaceRole } from "../auth";
import { withToken } from "./account";
import { json } from "./rest";

/**
 * Proving the workspace's GitHub organisation rule, one member at a time.
 *
 * The member presses "Verify", and their own GitHub connection — the OAuth or
 * pasted token in `account.ts`, which holds `read:org` — asks GitHub whether
 * they are an active member of the organisation. Nothing calls GitHub on a
 * page load: a pass lasts `GITHUB_ORG_PROOF_MS` (`auth.ts`), and the
 * organisation's webhook takes it away sooner when they leave.
 */
export const verify = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<{ required: boolean; verified: boolean }> => {
    const me = await requireOwner(ctx);
    const org: string | null = await ctx.runQuery(internal.github.orgProof.rule, args);
    if (!org) return { required: false, verified: true };
    const membership = await withToken(ctx, me, (token) =>
      json<{ state?: string; user?: { login?: string } }>(
        token,
        `/user/memberships/orgs/${encodeURIComponent(org)}`,
        { allowMissing: true },
      ),
    );
    const login = membership?.state === "active" ? (membership.user?.login ?? null) : null;
    await ctx.runMutation(internal.github.orgProof.stamp, { ...args, org, login });
    return { required: true, verified: login !== null };
  },
});

export const rule = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const { workspace } = await requireWorkspaceRole(ctx, args.workspaceId, "guest");
    return workspace.settings.requireGithubOrg ?? null;
  },
});

/**
 * Records what GitHub answered: a pass as `login`, or none. An answer about an
 * organisation the rule no longer names is dropped.
 */
export const stamp = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    org: v.string(),
    login: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const { workspace, membership } = await requireWorkspaceRole(ctx, args.workspaceId, "guest");
    if (workspace.settings.requireGithubOrg !== args.org) return;
    await ctx.db.patch(
      membership._id,
      args.login
        ? { githubOrgVerifiedAt: Date.now(), githubOrgLogin: args.login }
        : { githubOrgVerifiedAt: undefined, githubOrgLogin: undefined },
    );
  },
});
