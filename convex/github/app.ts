import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { action, mutation, query } from "../_generated/server";
import { atLeast, ownerId as currentOwner, requireWorkspaceRole, workspaceRole } from "../auth";
import { withInstallation } from "./credential";
import { installationsOf, unusable } from "./installations";
import { listed, type Listed, type Repo } from "./repos";
import { json } from "./rest";
import { hasKey } from "./seal";

/**
 * The Nootles GitHub App, as a workspace sees it (docs/github-app.md): whether
 * this deployment has one, installing it, the repositories it reads, and the
 * workspace's GitHub organisation rule. The OAuth connection in `account.ts`
 * stays what personal projects read with.
 */

/** Every variable the App needs on the Convex side, in the order the doc sets them. */
const CONVEX_VARS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
] as const;

function blocker(): string {
  const missing: string[] = CONVEX_VARS.filter((name) => !process.env[name]);
  if (!hasKey()) missing.push("GITHUB_TOKEN_KEY");
  return missing.length
    ? `The GitHub App isn’t set up on this deployment (missing ${missing.join(", ")}). See docs/github-app.md.`
    : "";
}

/** Where GitHub keeps an installation's settings: an organisation's, or a person's. */
export function manageUrl(row: Pick<Doc<"githubInstallations">, "accountType" | "accountLogin" | "installationId">) {
  return row.accountType === "Organization"
    ? `https://github.com/organizations/${row.accountLogin}/settings/installations/${row.installationId}`
    : `https://github.com/settings/installations/${row.installationId}`;
}

/**
 * The workspace's GitHub picture, for its members: the integrations screen,
 * the install route's admin check, and the context panel's "why is the code
 * hidden" line. Null for anyone else — a guest's code is a manager's grant,
 * not this.
 */
export const status = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const role = await workspaceRole(ctx, args.workspaceId);
    const workspace = atLeast(role, "member") && (await ctx.db.get(args.workspaceId));
    const me = await currentOwner(ctx);
    if (!role || !workspace || !me) return null;
    const seat = await ctx.db
      .query("memberships")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", args.workspaceId).eq("userId", me))
      .unique();
    const why = blocker();
    return {
      slug: workspace.slug,
      ready: !why,
      blocker: why,
      canManage: atLeast(role, "admin"),
      installations: (await installationsOf(ctx, args.workspaceId)).map((row) => ({
        _id: row._id,
        installationId: row.installationId,
        accountLogin: row.accountLogin,
        accountType: row.accountType,
        repositorySelection: row.repositorySelection,
        ...(row.suspendedAt !== undefined ? { suspendedAt: row.suspendedAt } : {}),
        ...(row.removedAt !== undefined ? { removedAt: row.removedAt } : {}),
        manageUrl: manageUrl(row),
      })),
      allowPersonalTokens: workspace.settings.allowPersonalTokens !== false,
      requireGithubOrg: workspace.settings.requireGithubOrg ?? null,
      orgProof: {
        verifiedAt: seat?.githubOrgVerifiedAt ?? null,
        login: seat?.githubOrgLogin ?? null,
      },
    };
  },
});

/**
 * Attaches an installation to the workspace, once GitHub has proved the caller
 * can reach it.
 *
 * The `installation_id` GitHub puts on the setup URL is only a claim — anyone
 * can type one. So the App asks for user authorization during installation,
 * and `code` is that authorization: it is traded for a token that acts as
 * this GitHub user, and GitHub's own list of the installations they can reach
 * has to include the id. Without that, anyone could attach another
 * organisation's installation to their workspace. Done here rather than in
 * Next because this action is callable directly — the proof has to be made
 * wherever the recording is.
 */
export const install = action({
  args: { workspaceId: v.id("workspaces"), installationId: v.number(), code: v.string() },
  handler: async (ctx, args): Promise<null> => {
    await ctx.runQuery(internal.github.installations.seat, {
      workspaceId: args.workspaceId,
      min: "admin",
    });
    const clientId = process.env.GITHUB_APP_CLIENT_ID;
    const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new ConvexError(blocker() || "The GitHub App isn’t set up.");

    const userToken = await exchangeCode(clientId, clientSecret, args.code);
    const found = await reachableInstallation(userToken, args.installationId);
    if (!found) {
      throw new ConvexError(
        "GitHub doesn’t list that installation among the ones you can reach, so it can’t be added.",
      );
    }
    await ctx.runMutation(internal.github.installations.record, {
      workspaceId: args.workspaceId,
      installationId: found.id,
      accountLogin: found.account.login,
      accountType: found.account.type === "Organization" ? "Organization" : "User",
      repositorySelection: found.repository_selection === "all" ? "all" : "selected",
      suspended: !!found.suspended_at,
    });
    return null;
  },
});

type Installation = {
  id: number;
  account: { login: string; type: string };
  repository_selection: string;
  suspended_at?: string | null;
};

/** Enough pages for anyone; an account in more installations than this is not a person. */
const INSTALLATION_PAGES = 10;

/**
 * The installation, if the user behind `userToken` can reach it — GitHub's
 * `/user/installations`, which answers only for a user-to-server token of
 * this App. Null when it is not among them.
 */
export async function reachableInstallation(
  userToken: string,
  installationId: number,
): Promise<Installation | null> {
  for (let page = 1; page <= INSTALLATION_PAGES; page += 1) {
    const answer = await json<{ installations?: Installation[] }>(userToken, "/user/installations", {
      query: { per_page: 100, page },
    });
    const rows = answer?.installations ?? [];
    const found = rows.find((row) => row.id === installationId);
    if (found) return found;
    if (rows.length < 100) return null;
  }
  return null;
}

/**
 * Trades the code from "request user authorization during installation" for
 * a user-to-server token. GitHub answers a failed exchange with a 200 and an
 * `error` field, so both are read; the detail is not passed on, since it can
 * describe the client secret.
 */
export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const body = (await res.json().catch(() => null)) as { access_token?: string } | null;
  if (!res.ok || !body?.access_token) {
    throw new ConvexError("GitHub didn’t accept the installation’s authorization. Try installing again.");
  }
  return body.access_token;
}

/**
 * The repositories the workspace's installations read, most recently pushed
 * first, each naming the installation it came through — what a workspace
 * project's pickers offer. Any member may list them; linking one is the
 * project's manager's, or a member making a new project.
 */
export const available = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<Listed[]> => {
    const installations: Doc<"githubInstallations">[] = await ctx.runQuery(
      internal.github.installations.usable,
      { workspaceId: args.workspaceId },
    );
    const lists = await Promise.all(
      installations.map((row) =>
        withInstallation(ctx, row._id, async (token) => {
          const answer = await json<{ repositories?: Repo[] }>(token, "/installation/repositories", {
            query: { per_page: 100 },
          });
          return (answer?.repositories ?? []).map((repo) => ({
            ...listed(repo),
            installationId: row.installationId,
          }));
        }),
      ),
    );
    return lists
      .flat()
      .sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
  },
});

/**
 * The GitHub organisation rule: every non-guest reads the workspace's code
 * only while they have shown, recently, that they belong to `org`
 * (`auth.passesGithubOrgRule`, `orgProof.verify`). It must be an organisation
 * the App is installed on, so its webhook can say when someone leaves. Moving
 * the rule to another organisation starts everyone's proof over.
 */
export const setOrgRule = mutation({
  args: { workspaceId: v.id("workspaces"), org: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const { workspace } = await requireWorkspaceRole(ctx, args.workspaceId, "admin");
    let org: string | undefined;
    if (args.org !== null) {
      const wanted = args.org.trim().toLowerCase();
      const installation = (await installationsOf(ctx, workspace._id)).find(
        (row) =>
          row.accountType === "Organization" &&
          !unusable(row) &&
          row.accountLogin.toLowerCase() === wanted,
      );
      if (!installation) {
        throw new ConvexError("Choose an organisation the GitHub App is installed on.");
      }
      org = installation.accountLogin;
    }
    const before = workspace.settings.requireGithubOrg;
    await ctx.db.patch(workspace._id, { settings: { ...workspace.settings, requireGithubOrg: org } });
    if (org === undefined || before?.toLowerCase() === org.toLowerCase()) return null;
    const seats = await ctx.db
      .query("memberships")
      .withIndex("by_workspace_status_role", (q) =>
        q.eq("workspaceId", workspace._id).eq("status", "active"),
      )
      .collect();
    for (const seat of seats) {
      if (seat.githubOrgVerifiedAt !== undefined || seat.githubOrgLogin !== undefined) {
        await ctx.db.patch(seat._id, { githubOrgVerifiedAt: undefined, githubOrgLogin: undefined });
      }
    }
    return null;
  },
});
