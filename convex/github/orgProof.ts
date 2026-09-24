import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type QueryCtx,
} from "../_generated/server";
import { activeMembership, requireOwner } from "../auth";
import { withToken } from "./account";
import { withInstallation } from "./credential";
import { orgInstallation, unusable } from "./installations";
import { GitHubError, json, request } from "./rest";

/**
 * Proving the workspace's GitHub organisation rule, one member at a time.
 *
 * Two questions, each asked of the one party that can answer it. Who the
 * member is on GitHub comes from their own connection (`account.ts`):
 * `GET /user` needs no permission any organisation can withhold. Whether that
 * account is in the organisation comes from the workspace's GitHub App,
 * installed on it — `GET /orgs/{org}/members/{login}` with the installation's
 * token — so an organisation that keeps third-party OAuth apps out of its
 * membership list doesn't keep the answer from us.
 *
 * Once the account is known, the App asks again every night (`recheck`) and
 * each pass renews the proof, so a member connects GitHub once and is checked
 * after that without doing anything. Nothing calls GitHub on a page load; the
 * organisation's webhook takes a pass away the moment someone leaves.
 */

const RECONNECT = "Nootles couldn’t confirm who you are on GitHub. Reconnect GitHub, then check again.";

/** Seats a night's check asks about in one run, before handing on to the next. */
export const RECHECK_BATCH = 50;
/** Workspaces the nightly sweep reads in one run. */
const SWEEP_BATCH = 200;

type Proof = { required: boolean; verified: boolean; login: string | null };

/** The member's own check, pressed — or run for them once they connect GitHub. */
export const verify = action({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args): Promise<Proof> => {
    const me = await requireOwner(ctx);
    return await prove(ctx, me, args.workspaceId);
  },
});

async function prove(ctx: ActionCtx, userId: string, workspaceId: Id<"workspaces">): Promise<Proof> {
  const target: Target | null = await ctx.runQuery(internal.github.orgProof.target, {
    workspaceId,
    userId,
  });
  if (!target) return { required: false, verified: true, login: null };
  if (target.blocked !== null) throw new ConvexError(target.blocked);
  const { login, id } = await identify(ctx, userId);
  const member = await isMember(ctx, target.installation, target.org, login);
  await ctx.runMutation(internal.github.orgProof.stamp, {
    workspaceId,
    userId,
    org: target.org,
    login,
    githubUserId: id,
    member,
  });
  return { required: true, verified: member, login };
}

/** Who the member is on GitHub, by their own connection. */
async function identify(ctx: ActionCtx, userId: string): Promise<{ login: string; id: number }> {
  let user: { login?: string; id?: number } | null;
  try {
    user = await withToken(ctx, userId, (token) => json<{ login?: string; id?: number }>(token, "/user"));
  } catch (error) {
    if (error instanceof GitHubError && !error.rateLimited) throw new ConvexError(RECONNECT);
    throw error;
  }
  if (!user?.login || typeof user.id !== "number") throw new ConvexError(RECONNECT);
  return { login: user.login, id: user.id };
}

/**
 * Whether `login` is in `org`, as the App's installation there sees it: 204 is
 * yes, 404 no. A 302 is GitHub saying the asker can't see the full list —
 * never an App with Members read, but it isn't a yes, and following it would
 * ask the public list instead.
 */
async function isMember(
  ctx: ActionCtx,
  installation: Id<"githubInstallations">,
  org: string,
  login: string,
): Promise<boolean> {
  return await withInstallation(ctx, installation, async (token) => {
    try {
      const path = `/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(login)}`;
      return (await request(token, path, { allowMissing: true, redirect: "manual" })) !== null;
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      if (error.status === 302) return false;
      if (error.status === 403 && !error.rateLimited) {
        throw new ConvexError(
          `The workspace’s GitHub App can’t read ${org}’s members. An admin can grant it “Members: read” on GitHub.`,
        );
      }
      throw error;
    }
  });
}

type Target =
  | { org: string; installation: Id<"githubInstallations">; blocked: null }
  | { org: string; installation: null; blocked: string };

/** Why the App can't be asked about `org`, or the installation to ask through. */
async function targetFor(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  org: string,
): Promise<Target> {
  const row = await orgInstallation(ctx, workspaceId, org);
  if (!row || row.removedAt !== undefined) {
    return {
      org,
      installation: null,
      blocked: `The GitHub App is no longer installed on ${org}, so Nootles can’t check who’s in it. An admin can install it again.`,
    };
  }
  if (unusable(row)) {
    return {
      org,
      installation: null,
      blocked: `The GitHub App is suspended on ${org}, so Nootles can’t check who’s in it. An admin can unsuspend it on GitHub.`,
    };
  }
  return { org, installation: row._id, blocked: null };
}

/**
 * The organisation a seat is held to and how to ask about it — null when the
 * workspace has no rule. Someone without an active seat learns nothing.
 */
export const target = internalQuery({
  args: { workspaceId: v.id("workspaces"), userId: v.string() },
  handler: async (ctx, args): Promise<Target | null> => {
    const seat = await activeMembership(ctx, args.workspaceId, args.userId);
    if (!seat) throw new ConvexError("Not found");
    const org = (await ctx.db.get(args.workspaceId))?.settings.requireGithubOrg;
    return org ? await targetFor(ctx, args.workspaceId, org) : null;
  },
});

/**
 * Records what GitHub answered: who the member is, and whether the
 * organisation has them. An answer about an organisation the rule no longer
 * names is dropped.
 */
export const stamp = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.string(),
    org: v.string(),
    login: v.string(),
    githubUserId: v.number(),
    member: v.boolean(),
  },
  handler: async (ctx, args) => {
    const seat = await activeMembership(ctx, args.workspaceId, args.userId);
    const workspace = await ctx.db.get(args.workspaceId);
    if (!seat || workspace?.settings.requireGithubOrg !== args.org) return;
    await ctx.db.patch(seat._id, {
      githubOrgLogin: args.login,
      githubUserId: args.githubUserId,
      githubOrgVerifiedAt: args.member ? Date.now() : undefined,
    });
  },
});

// ---- Connecting ----------------------------------------------------------

/**
 * Whether connecting GitHub has anything to prove for `userId`: a seat in a
 * workspace with the rule. Asked by the connection's save, which then
 * schedules `onConnect`.
 */
export async function provesOnConnect(ctx: QueryCtx, userId: string): Promise<boolean> {
  return (await ruledWorkspaces(ctx, userId)).length > 0;
}

async function ruledWorkspaces(ctx: QueryCtx, userId: string): Promise<Id<"workspaces">[]> {
  const seats = await ctx.db
    .query("memberships")
    .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "active"))
    .collect();
  const ruled: Id<"workspaces">[] = [];
  for (const seat of seats) {
    const workspace = await ctx.db.get(seat.workspaceId);
    if (workspace && workspace.deletedAt === undefined && workspace.settings.requireGithubOrg) {
      ruled.push(workspace._id);
    }
  }
  return ruled;
}

export const ruled = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, args) => await ruledWorkspaces(ctx, args.userId),
});

/** A new GitHub connection proves every rule its owner is held to, unasked. */
export const onConnect = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    const workspaces: Id<"workspaces">[] = await ctx.runQuery(internal.github.orgProof.ruled, args);
    for (const workspaceId of workspaces) {
      try {
        await prove(ctx, args.userId, workspaceId);
      } catch (error) {
        // Their page says why when they check themselves; nobody is waiting here.
        console.warn(`GitHub organisation check on connect failed for ${workspaceId}:`, error);
      }
    }
  },
});

// ---- The nightly check ---------------------------------------------------

/**
 * Every workspace with the rule gets its known GitHub accounts asked about
 * again — a bounded page of workspaces per run, each handing on to the next.
 */
export const sweep = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("workspaces").paginate({ cursor: args.cursor, numItems: SWEEP_BATCH });
    for (const workspace of page.page) {
      if (workspace.deletedAt !== undefined || !workspace.settings.requireGithubOrg) continue;
      await ctx.scheduler.runAfter(0, internal.github.orgProof.recheck, {
        workspaceId: workspace._id,
        cursor: null,
      });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.github.orgProof.sweep, { cursor: page.continueCursor });
    }
  },
});

/** One page of a workspace's active seats that have a GitHub account on record. */
export const batch = internalQuery({
  args: { workspaceId: v.id("workspaces"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    const org = workspace?.deletedAt === undefined ? workspace?.settings.requireGithubOrg : undefined;
    if (!org) return null;
    const page = await ctx.db
      .query("memberships")
      .withIndex("by_workspace_status_role", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("status", "active"),
      )
      .paginate({ cursor: args.cursor, numItems: RECHECK_BATCH });
    return {
      target: await targetFor(ctx, args.workspaceId, org),
      seats: page.page.flatMap((seat) =>
        seat.githubOrgLogin ? [{ seatId: seat._id, login: seat.githubOrgLogin }] : [],
      ),
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

/**
 * One workspace's check, a page at a time, with the App's token alone. An
 * App that can't be asked — suspended, uninstalled, refused — changes nothing:
 * not knowing isn't a no, and the proofs it would have renewed run out on
 * their own. Running it twice lands the same.
 */
export const recheck = internalAction({
  args: { workspaceId: v.id("workspaces"), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.runQuery(internal.github.orgProof.batch, args);
    if (!page) return;
    const { target } = page;
    if (target.blocked !== null) {
      console.warn(`GitHub organisation recheck skipped for ${args.workspaceId}: ${target.blocked}`);
      return;
    }
    const results: { seatId: Id<"memberships">; login: string; member: boolean }[] = [];
    let stopped = false;
    for (const seat of page.seats) {
      try {
        results.push({ ...seat, member: await isMember(ctx, target.installation, target.org, seat.login) });
      } catch (error) {
        // The App, not the member: nothing further in this workspace will fare better tonight.
        console.warn(`GitHub organisation recheck stopped for ${args.workspaceId}:`, error);
        stopped = true;
        break;
      }
    }
    if (results.length) {
      await ctx.runMutation(internal.github.orgProof.renew, {
        workspaceId: args.workspaceId,
        org: target.org,
        results,
      });
    }
    if (!stopped && page.cursor !== null) {
      await ctx.scheduler.runAfter(0, internal.github.orgProof.recheck, {
        workspaceId: args.workspaceId,
        cursor: page.cursor,
      });
    }
  },
});

/**
 * The night's answers: a member's proof renewed, anyone else's cleared. An
 * answer about a login the seat no longer holds, or an organisation the rule
 * no longer names, is dropped.
 */
export const renew = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    org: v.string(),
    results: v.array(v.object({ seatId: v.id("memberships"), login: v.string(), member: v.boolean() })),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (workspace?.settings.requireGithubOrg !== args.org) return;
    const now = Date.now();
    for (const result of args.results) {
      const seat = await ctx.db.get(result.seatId);
      if (!seat || seat.status !== "active" || seat.workspaceId !== args.workspaceId) continue;
      if (seat.githubOrgLogin !== result.login) continue;
      if (result.member) await ctx.db.patch(seat._id, { githubOrgVerifiedAt: now });
      else if (seat.githubOrgVerifiedAt !== undefined) {
        await ctx.db.patch(seat._id, { githubOrgVerifiedAt: undefined });
      }
    }
  },
});
