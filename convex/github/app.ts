import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { action, mutation, query } from "../_generated/server";
import {
  atLeast,
  ownerId as currentOwner,
  GITHUB_ORG_PROOF_MS,
  requireWorkspaceRole,
  workspaceRole,
} from "../auth";
import { recordByCaller } from "../audit";
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
  "GITHUB_APP_SLUG",
] as const;

/** What this deployment still lacks to install and read through the App; empty when it has it all. */
function missing(): string[] {
  const names: string[] = CONVEX_VARS.filter((name) => !process.env[name]);
  if (!hasKey()) names.push("GITHUB_TOKEN_KEY");
  return names;
}

/**
 * Why an install was refused, for the setup route to say in its own words:
 * `ConvexError({ refused })`. Each asks something different of the person —
 * a retry helps only `unauthorised`.
 */
export type InstallRefusal = "unconfigured" | "unauthorised" | "unreachable" | "not_owner" | "not_holder";

function refuse(refused: InstallRefusal): ConvexError<{ refused: InstallRefusal }> {
  return new ConvexError({ refused });
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
    const lacking = missing();
    return {
      slug: workspace.slug,
      ready: lacking.length === 0,
      missing: lacking,
      /** The App's URL name, which its install link is built on — one fact with `ready`. */
      appSlug: process.env.GITHUB_APP_SLUG || null,
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
        /** `auth.passesGithubOrgRule`'s answer, so the page never reckons the window itself. */
        passes:
          !workspace.settings.requireGithubOrg ||
          (seat?.githubOrgVerifiedAt !== undefined &&
            Date.now() - seat.githubOrgVerifiedAt < GITHUB_ORG_PROOF_MS),
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
 * this GitHub user. GitHub's own list of the installations they can reach
 * has to include the id, and they have to hold its account
 * (`controlsAccount`). Without both, anyone could attach another
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
    if (!clientId || !clientSecret || missing().length) throw refuse("unconfigured");

    const userToken = await exchangeCode(clientId, clientSecret, args.code);
    const found = await reachableInstallation(userToken, args.installationId);
    if (!found) throw refuse("unreachable");
    if (!(await controlsAccount(userToken, found.account))) {
      throw refuse(found.account.type === "Organization" ? "not_owner" : "not_holder");
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
 * Whether the user behind `userToken` holds the account an installation is
 * on: that user themselves, or an active owner of that organisation. Reaching
 * an installation is not enough — GitHub lists one for anyone who can read a
 * single repository it covers, and attaching it hands a workspace the
 * installation's token, which reads every repository it covers.
 */
export async function controlsAccount(
  userToken: string,
  account: Installation["account"],
): Promise<boolean> {
  if (account.type === "Organization") {
    const membership = await json<{ state?: string; role?: string }>(
      userToken,
      `/user/memberships/orgs/${encodeURIComponent(account.login)}`,
      { allowMissing: true },
    );
    return membership?.state === "active" && membership.role === "admin";
  }
  const me = await json<{ login?: string }>(userToken, "/user");
  return !!me?.login && me.login.toLowerCase() === account.login.toLowerCase();
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
    throw refuse("unauthorised");
  }
  return body.access_token;
}

/**
 * The repositories the workspace's installations read, most recently pushed
 * first, each naming the installation it came through — what a workspace
 * project's pickers offer. Any member the GitHub organisation rule lets read
 * code may list them; linking one is the project's manager's, or a member
 * making a new project. One installation GitHub refuses leaves the others
 * listed; only when every one fails does the list fail, with GitHub's reason.
 */
export const available = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<Listed[]> => {
    const installations: Doc<"githubInstallations">[] = await ctx.runQuery(
      internal.github.installations.usable,
      { workspaceId: args.workspaceId },
    );
    const settled = await Promise.allSettled(
      installations.map((row) =>
        withInstallation(ctx, row._id, async (token) =>
          (await installationRepositories(token)).map((repo) => ({
            ...listed(repo),
            installationId: row.installationId,
          })),
        ),
      ),
    );
    const lists = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (!lists.length && failed) throw failed.reason;
    return lists
      .flat()
      .sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
  },
});

/** GitHub's page size cap; past this many pages an installation's list stops. */
const REPOSITORY_PAGE = 100;
export const REPOSITORY_PAGES = 30;

/**
 * Every repository an installation reads, up to `REPOSITORY_PAGES` pages.
 * The first page says how many there are, so the rest are asked for at once.
 */
async function installationRepositories(token: string): Promise<Repo[]> {
  type Page = { total_count?: number; repositories?: Repo[] };
  const page = (n: number) =>
    json<Page>(token, "/installation/repositories", { query: { per_page: REPOSITORY_PAGE, page: n } });
  const first = await page(1);
  const repos = first?.repositories ?? [];
  const pages = Math.min(
    REPOSITORY_PAGES,
    Math.ceil((first?.total_count ?? repos.length) / REPOSITORY_PAGE),
  );
  if (repos.length < REPOSITORY_PAGE || pages <= 1) return repos;
  const rest = await Promise.all(
    Array.from({ length: pages - 1 }, (_, i) => page(i + 2)),
  );
  return [...repos, ...rest.flatMap((answer) => answer?.repositories ?? [])];
}

/**
 * The GitHub organisation rule: every non-guest reads the workspace's code
 * only while GitHub has said, recently, that they belong to `org`
 * (`auth.passesGithubOrgRule`, `orgProof`). It must be an organisation the App
 * is installed on: the App is what asks, and its webhook says when someone
 * leaves. Moving the rule to another organisation starts everyone's proof over.
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
    if (before !== org) {
      await recordByCaller(ctx, workspace._id, {
        action: "github.orgRule",
        subjectKind: "workspace",
        subjectId: workspace._id,
        meta: { from: before ?? null, to: org ?? null },
      });
    }
    if (org === undefined || before?.toLowerCase() === org.toLowerCase()) return null;
    const seats = await ctx.db
      .query("memberships")
      .withIndex("by_workspace_status_role", (q) =>
        q.eq("workspaceId", workspace._id).eq("status", "active"),
      )
      .collect();
    for (const seat of seats) {
      if (seat.githubOrgVerifiedAt !== undefined) {
        await ctx.db.patch(seat._id, { githubOrgVerifiedAt: undefined });
      }
    }
    // Everyone whose GitHub account is already known is asked about now,
    // rather than left out until the night's check.
    await ctx.scheduler.runAfter(0, internal.github.orgProof.recheck, {
      workspaceId: workspace._id,
      cursor: null,
    });
    return null;
  },
});
