import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { isTrashed, requireGithubCodeSeat, requireWorkspaceRole } from "../auth";
import { record as audit } from "../audit";
import { memberRole } from "../schema";
import { unlinkRepo } from "./repos";

/**
 * A workspace's GitHub App installations: the rows, what reads them, and what
 * GitHub's webhook (`convex/http.ts`) does to them. Recording one is
 * `app.install`'s, after GitHub has proved the admin can reach it.
 */

/** Pushes to a default branch inside this window become one re-index. */
export const PUSH_DEBOUNCE_MS = 10 * 60_000;

/** Why an installation cannot be read through, in words, or null when it can. */
export function unusable(row: Doc<"githubInstallations">): string | null {
  if (row.removedAt !== undefined) {
    return `The GitHub App was uninstalled from ${row.accountLogin}. Install it again to read its repositories.`;
  }
  if (row.suspendedAt !== undefined) {
    return `The GitHub App is suspended on ${row.accountLogin}. Unsuspend it on GitHub to read its repositories.`;
  }
  return null;
}

/** A workspace's row for a GitHub installation, whatever its state. */
export async function installationIn(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  installationId: number,
): Promise<Doc<"githubInstallations"> | null> {
  const rows = await ctx.db
    .query("githubInstallations")
    .withIndex("by_installation", (q) => q.eq("installationId", installationId))
    .collect();
  return rows.find((row) => row.workspaceId === workspaceId) ?? null;
}

export async function installationsOf(ctx: QueryCtx, workspaceId: Id<"workspaces">) {
  return await ctx.db
    .query("githubInstallations")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
}

export const row = internalQuery({
  args: { id: v.id("githubInstallations") },
  handler: async (ctx, args) => await ctx.db.get(args.id),
});

export const saveToken = internalMutation({
  args: { id: v.id("githubInstallations"), sealed: v.string(), expiresAt: v.number() },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.id))) return;
    await ctx.db.patch(args.id, { token: { sealed: args.sealed, expiresAt: args.expiresAt } });
  },
});

/**
 * The caller's seat in the workspace, at `min` or above — asked by actions,
 * which cannot read the database themselves. Throws like
 * `requireWorkspaceRole`, because it is that.
 */
export const seat = internalQuery({
  args: { workspaceId: v.id("workspaces"), min: memberRole },
  handler: async (ctx, args) => {
    const { membership } = await requireWorkspaceRole(ctx, args.workspaceId, args.min);
    return membership;
  },
});

/**
 * The workspace's installations a member may list repositories through —
 * one the GitHub organisation rule lets read its code.
 */
export const usable = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    await requireGithubCodeSeat(ctx, args.workspaceId);
    return (await installationsOf(ctx, args.workspaceId)).filter((row) => !unusable(row));
  },
});

/**
 * Which credential reads a linked repository: the installation it was linked
 * through, or its linker's own connection — unless the workspace has turned
 * those off, or the installation is gone. `credential.ts` acts on the answer.
 */
export const credentialFor = internalQuery({
  args: { repoId: v.id("projectRepos") },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { kind: "installation"; installation: Id<"githubInstallations"> }
    | { kind: "personal"; ownerId: string }
    | { kind: "refused"; reason: string }
  > => {
    const repo = await ctx.db.get(args.repoId);
    const project = repo && (await ctx.db.get(repo.projectId));
    if (!repo || !project) return { kind: "refused", reason: "That repository is no longer linked." };
    if (repo.installationId !== undefined) {
      const installation = project.workspaceId
        ? await installationIn(ctx, project.workspaceId, repo.installationId)
        : null;
      if (!installation) {
        return {
          kind: "refused",
          reason: "The GitHub App installation this repository was linked through is no longer part of this workspace.",
        };
      }
      const refused = unusable(installation);
      return refused
        ? { kind: "refused", reason: refused }
        : { kind: "installation", installation: installation._id };
    }
    if (project.workspaceId) {
      const workspace = await ctx.db.get(project.workspaceId);
      if (workspace?.settings.allowPersonalTokens === false) {
        return { kind: "refused", reason: PERSONAL_OFF };
      }
    }
    return { kind: "personal", ownerId: repo.ownerId };
  },
});

export const PERSONAL_OFF =
  "This workspace reads repositories only through its GitHub App. Link the " +
  "repository from the App’s repositories, or ask an admin to allow personal connections.";

/**
 * Attaches an installation to a workspace — after `app.install` has had
 * GitHub prove the caller can reach it. The admin check is made again here,
 * in the transaction that writes, whatever the action asked before.
 * Installing again (after an uninstall, or to change which repositories it
 * reads) refreshes the one row.
 */
export const record = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    installationId: v.number(),
    accountLogin: v.string(),
    accountType: v.union(v.literal("Organization"), v.literal("User")),
    repositorySelection: v.union(v.literal("all"), v.literal("selected")),
    suspended: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { membership } = await requireWorkspaceRole(ctx, args.workspaceId, "admin");
    const now = Date.now();
    const facts = {
      accountLogin: args.accountLogin,
      accountType: args.accountType,
      repositorySelection: args.repositorySelection,
    };
    const suspendedAt = args.suspended ? now : undefined;
    const existing = await installationIn(ctx, args.workspaceId, args.installationId);
    await audit(ctx, {
      workspaceId: args.workspaceId,
      actorId: membership.userId,
      action: "github.installation.record",
      subjectKind: "githubInstallation",
      subjectId: String(args.installationId),
      meta: {
        account: args.accountLogin,
        repositories: args.repositorySelection,
        suspended: args.suspended,
        reinstalled: !!existing,
      },
    });
    if (existing) {
      await ctx.db.patch(existing._id, {
        ...facts,
        suspendedAt,
        removedAt: undefined,
        // Minted before an uninstall, it is dead; before an update, it may
        // not see what the installation reads now.
        token: undefined,
      });
      return existing._id;
    }
    return await ctx.db.insert("githubInstallations", {
      workspaceId: args.workspaceId,
      installationId: args.installationId,
      ...facts,
      ...(suspendedAt ? { suspendedAt } : {}),
      installedBy: membership.userId,
      createdAt: now,
    });
  },
});

// ---- Webhook -------------------------------------------------------------
// Each handler sets state rather than toggling it, so a delivery GitHub
// retries lands the same way twice.

/**
 * A push: every repository linked through this installation, whose default
 * branch it was, is read again — once per window however many pushes arrive,
 * since the run reads the branch's head when it starts.
 */
export const onPush = internalMutation({
  args: { installationId: v.number(), fullName: v.string(), branch: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const repo of await linkedThrough(ctx, args.installationId, args.fullName)) {
      if (repo.defaultBranch !== args.branch) continue;
      const project = await ctx.db.get(repo.projectId);
      if (!project || isTrashed(project)) continue;
      if (repo.pushReindexAt !== undefined && repo.pushReindexAt > now) continue;
      await ctx.db.patch(repo._id, { pushReindexAt: now + PUSH_DEBOUNCE_MS });
      await ctx.scheduler.runAfter(PUSH_DEBOUNCE_MS, internal.github.installations.pushReindex, {
        repoId: repo._id,
      });
    }
  },
});

/**
 * How many windows a push waits out a run already under way. An hour is far
 * past any action's time limit, so a run still "indexing" by then was killed
 * before it could say so, and waiting longer would wait forever.
 */
export const PUSH_MAX_WAITS = 6;

/** The debounced half of `onPush`. A run already under way is waited out. */
export const pushReindex = internalMutation({
  args: { repoId: v.id("projectRepos"), waited: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repoId);
    if (!repo) return;
    const state = repo.index?.state;
    const waited = args.waited ?? 0;
    if ((state === "queued" || state === "indexing") && waited < PUSH_MAX_WAITS) {
      await ctx.db.patch(repo._id, { pushReindexAt: Date.now() + PUSH_DEBOUNCE_MS });
      await ctx.scheduler.runAfter(PUSH_DEBOUNCE_MS, internal.github.installations.pushReindex, {
        repoId: repo._id,
        waited: waited + 1,
      });
      return;
    }
    await ctx.db.patch(repo._id, {
      pushReindexAt: undefined,
      index: { ...repo.index, state: "queued" },
    });
    await ctx.scheduler.runAfter(0, internal.github.indexer.run, { repoId: repo._id });
  },
});

/**
 * An installation uninstalled, suspended or unsuspended on GitHub. An
 * uninstall also unlinks every repository read through it: nothing can read
 * them now, and what was indexed from them should not outlive the grant.
 */
export const onInstallation = internalMutation({
  args: {
    installationId: v.number(),
    action: v.union(v.literal("deleted"), v.literal("suspend"), v.literal("unsuspend")),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("githubInstallations")
      .withIndex("by_installation", (q) => q.eq("installationId", args.installationId))
      .collect();
    const unlinked = new Map<Id<"workspaces">, number>();
    if (args.action === "deleted") {
      for (const repo of await linkedThrough(ctx, args.installationId)) {
        await unlinkRepo(ctx, repo._id);
        const workspaceId = (await ctx.db.get(repo.projectId))?.workspaceId;
        if (workspaceId) unlinked.set(workspaceId, (unlinked.get(workspaceId) ?? 0) + 1);
      }
    }
    for (const row of rows) {
      let changed = false;
      if (args.action === "deleted") {
        if (row.removedAt === undefined) {
          await ctx.db.patch(row._id, { removedAt: now, token: undefined });
          changed = true;
        }
      } else if (args.action === "suspend") {
        if (row.suspendedAt === undefined) {
          await ctx.db.patch(row._id, { suspendedAt: now, token: undefined });
          changed = true;
        }
      } else if (row.suspendedAt !== undefined) {
        await ctx.db.patch(row._id, { suspendedAt: undefined });
        changed = true;
      }
      if (!changed) continue;
      await audit(ctx, {
        workspaceId: row.workspaceId,
        actorId: "github",
        actorKind: "system",
        action: {
          deleted: "github.installation.remove",
          suspend: "github.installation.suspend",
          unsuspend: "github.installation.unsuspend",
        }[args.action],
        subjectKind: "githubInstallation",
        subjectId: String(args.installationId),
        meta: {
          account: row.accountLogin,
          ...(args.action === "deleted" ? { unlinked: unlinked.get(row.workspaceId) ?? 0 } : {}),
        },
      });
    }
  },
});

/** Repositories taken out of an installation are unlinked wherever they were read through it. */
export const onRepositories = internalMutation({
  args: {
    installationId: v.number(),
    removed: v.array(v.string()),
    selection: v.optional(v.union(v.literal("all"), v.literal("selected"))),
  },
  handler: async (ctx, args) => {
    for (const fullName of args.removed) {
      for (const repo of await linkedThrough(ctx, args.installationId, fullName)) {
        await unlinkRepo(ctx, repo._id);
        const project = await ctx.db.get(repo.projectId);
        if (!project?.workspaceId) continue;
        await audit(ctx, {
          workspaceId: project.workspaceId,
          actorId: "github",
          actorKind: "system",
          action: "repo.unlink",
          subjectKind: "repo",
          subjectId: repo._id,
          meta: {
            repo: repo.fullName,
            projectId: project._id,
            project: project.title,
            reason: "removed from the GitHub App",
          },
        });
      }
    }
    if (!args.selection) return;
    const rows = await ctx.db
      .query("githubInstallations")
      .withIndex("by_installation", (q) => q.eq("installationId", args.installationId))
      .collect();
    for (const row of rows) {
      if (row.repositorySelection !== args.selection) {
        await ctx.db.patch(row._id, { repositorySelection: args.selection });
      }
    }
  },
});

/**
 * Someone left a GitHub organisation: in every workspace this installation
 * serves whose rule names that organisation, whoever passed the rule as that
 * login has to pass it again.
 */
export const onOrgMemberRemoved = internalMutation({
  args: { installationId: v.number(), org: v.string(), login: v.string() },
  handler: async (ctx, args) => {
    const org = args.org.toLowerCase();
    const login = args.login.toLowerCase();
    const rows = await ctx.db
      .query("githubInstallations")
      .withIndex("by_installation", (q) => q.eq("installationId", args.installationId))
      .collect();
    for (const workspaceId of new Set(rows.map((row) => row.workspaceId))) {
      const workspace = await ctx.db.get(workspaceId);
      if (workspace?.settings.requireGithubOrg?.toLowerCase() !== org) continue;
      const seats = await ctx.db
        .query("memberships")
        .withIndex("by_workspace_status_role", (q) =>
          q.eq("workspaceId", workspaceId).eq("status", "active"),
        )
        .collect();
      for (const seat of seats) {
        if (seat.githubOrgLogin?.toLowerCase() !== login) continue;
        await ctx.db.patch(seat._id, { githubOrgVerifiedAt: undefined, githubOrgLogin: undefined });
      }
    }
  },
});

/** Repositories linked through an installation — one of them, when named. */
async function linkedThrough(
  ctx: MutationCtx,
  installationId: number,
  fullName?: string,
): Promise<Doc<"projectRepos">[]> {
  return await ctx.db
    .query("projectRepos")
    .withIndex("by_installation_and_fullName", (q) =>
      fullName === undefined
        ? q.eq("installationId", installationId)
        : q.eq("installationId", installationId).eq("fullName", fullName),
    )
    .collect();
}
