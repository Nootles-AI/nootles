import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { isAuditId, recordAudit } from "./audit";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  ownerId as currentOwner,
  holdsSeat,
  isTrashed,
  readEditable,
  requireEditable,
  requireOwned,
  requireOwner,
  workspaceRole,
} from "./auth";
import {
  isFeature,
  isPlanName,
  PLAN_OVERRIDE,
  PLANS,
  utcDay,
  type Feature,
  type Features,
  type PlanName,
} from "./plans";

/**
 * What an account may do — the one place that answers it.
 *
 * The same shape of rule as `auth.ts`: access is resolved HERE and nowhere
 * else, so a new gate cannot quietly invent its own definition of "paid". Four
 * sources feed one answer, in order, first match winning:
 *
 *   1. the operator's VIP flag — a complete pass, outranking even a lapsed card
 *   2. a redeemed access code that has not lapsed
 *   3. a live Stripe subscription, as the webhook last mirrored it, not long
 *      past the end of its period
 *   4. otherwise free, with what is left of the one-time allowance
 *
 * The payment provider is deliberately just one of those four and the last that
 * can say yes. Swapping Stripe for a merchant of record later changes who
 * writes `billingAccounts.subscription`, and nothing else in the app.
 *
 * The free allowance does NOT refill. It is a taste of the product, not a tier
 * to live in, and the counters that record it are therefore never reset.
 *
 * A workspace answers the same question from its own sources — an operator's
 * grant, its Team subscription, else free (`workspaceStanding`) — and the
 * project a piece of work is done in decides which of the two is asked
 * (`containerFor`). The two never interact: a seat buys nothing in its
 * holder's own projects, and Pro buys nothing in a workspace's.
 */

/**
 * The numbers themselves live in `limits.ts` and are re-exported here, so every
 * server caller keeps reading them from the module that enforces them. The
 * client imports the other end directly — see that file for why the split
 * exists at all.
 */
import { FREE_LIMITS, type Meter } from "./limits";

export { FREE_LIMITS, type Meter };

export type Plan = "free" | "pro";

/**
 * Which of the four sources answered. `"none"` is a free account;
 * `"workspace"` is not an account's answer at all but a workspace project's
 * (see `entitlementIn`).
 */
export type Source = "none" | "vip" | "code" | "subscription" | "workspace";

export type Entitlement = {
  plan: Plan;
  source: Source;
  /** How much allowance remains. `null` on pro — there is nothing to count. */
  left: Record<Meter, number> | null;
  /** How much has been spent. `null` on pro, for the same reason. */
  used: Record<Meter, number> | null;
  /** When pro lapses. Absent = it does not (VIP, or a permanent code grant). */
  expiresAt?: number;
  /** Subscribed, but set to stop at the end of the period. */
  cancelAtPeriodEnd?: boolean;
};

/**
 * Stripe statuses that keep the door open.
 *
 * `past_due` is in deliberately: a card that failed a retry is a payment
 * problem, not a decision to leave, and Stripe is still retrying. Locking
 * someone out mid-dunning loses the customer the retry was about to recover.
 * A subscription that truly ends becomes `canceled`, which is not here.
 */
const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export function isLiveStatus(status: string): boolean {
  return LIVE_STATUSES.has(status);
}

/**
 * How long a live subscription is still believed once its period has ended.
 *
 * The mirror is only as fresh as the last webhook to land, and Stripe neither
 * orders deliveries nor gives up on one quickly: a failed delivery is retried
 * for up to three days. A renewal can therefore arrive late, which must not
 * lock out someone who has paid. An older event can also land after a
 * cancellation and put `active` back, or the cancellation may never land.
 * Three days after the period ends, the renewal's own event has had every
 * retry Stripe gives it. A subscription that still reads live at that point
 * has only not been told it is over.
 */
const WEBHOOK_RETRY_WINDOW = 3 * 24 * 60 * 60 * 1000;

/**
 * The instant a mirrored subscription is paid through, in milliseconds.
 *
 * The mirror keeps Stripe's period end verbatim, and Stripe counts seconds.
 * Every reader converts through here, so no screen is handed the one instant
 * in the codebase that is not milliseconds.
 */
export function paidThrough(
  sub: Pick<NonNullable<Doc<"billingAccounts">["subscription"]>, "currentPeriodEnd">,
): number {
  return sub.currentPeriodEnd * 1000;
}

/** What a refusal names: one of the free allowance's meters, or a guest's day of AI. */
export type RefusedMeter = Meter | "guestAi";

/**
 * The error every gate throws, shaped so the client can draw the right wall.
 * `limit` is the meter's count, or for `guestAi` the day's cap in dollars.
 */
export type QuotaRefusal = { code: "quota"; meter: RefusedMeter; limit: number };

/**
 * `ConvexError` rather than `Error`, for the same reason `auth.ts` uses one: a
 * production deployment redacts a plain `Error`, and the difference between
 * "you are out of chats" and "the server broke" is the difference between an
 * upgrade prompt and a bug report.
 */
export function quotaRefusal(meter: Meter): ConvexError<QuotaRefusal> {
  return new ConvexError({ code: "quota", meter, limit: FREE_LIMITS[meter] });
}

/** A guest who has spent their day of a workspace's AI. See `guestAllowance`. */
export function guestCapRefusal(capUsd: number): ConvexError<QuotaRefusal> {
  return new ConvexError({ code: "quota", meter: "guestAi", limit: capUsd });
}

/** True when `e` is this module's refusal — the client's narrowing hook. */
export function isQuotaRefusal(e: unknown): e is ConvexError<QuotaRefusal> {
  return (
    e instanceof ConvexError &&
    typeof e.data === "object" &&
    e.data !== null &&
    (e.data as { code?: unknown }).code === "quota"
  );
}

async function accountOf(
  ctx: QueryCtx,
  owner: string,
): Promise<Doc<"billingAccounts"> | null> {
  return await ctx.db
    .query("billingAccounts")
    .withIndex("by_owner", (q) => q.eq("ownerId", owner))
    .unique();
}

/**
 * Live personal projects this account owns, counted rather than stored.
 *
 * A stored count drifts the moment a project is trashed and restored, and this
 * is only ever asked one project short of the limit — so the bounded read is
 * both cheaper to keep right and cheap enough to do. The index does the
 * filtering, so the bound cuts only rows that count: trashed projects taken
 * first and dropped after once let two in the bin hide a third live one.
 *
 * Projects shared WITH someone are not theirs and never counted; a free
 * collaborator on a paid project keeps working. Nor are the workspace projects
 * they made — those are the workspace's, whoever made them.
 */
async function liveProjects(ctx: QueryCtx, owner: string): Promise<number> {
  const rows = await ctx.db
    .query("projects")
    .withIndex("by_owner_and_workspace_and_deleted", (q) =>
      q.eq("ownerId", owner).eq("workspaceId", undefined).eq("deletedAt", undefined),
    )
    .take(FREE_LIMITS.projects + 1);
  return rows.length;
}

/** The furthest-out live code grant, or null if none is still standing. */
async function codeGrant(
  ctx: QueryCtx,
  owner: string,
  now: number,
): Promise<{ expiresAt?: number } | null> {
  const rows = await ctx.db
    .query("codeRedemptions")
    .withIndex("by_owner", (q) => q.eq("ownerId", owner))
    .collect();
  let best: { expiresAt?: number } | null = null;
  for (const row of rows) {
    if (row.expiresAt !== undefined && row.expiresAt <= now) continue;
    // A permanent grant beats every dated one and ends the search.
    if (row.expiresAt === undefined) return {};
    if (best?.expiresAt === undefined || row.expiresAt > best.expiresAt) {
      best = { expiresAt: row.expiresAt };
    }
  }
  return best;
}

/**
 * A pro answer. The meters are explicitly null rather than absent — `hasRoom`
 * reads that null as "nothing to count", and an omitted field would read as a
 * meter of zero, which is the exact opposite.
 */
function pro(source: Source, rest: Partial<Entitlement> = {}): Entitlement {
  return { plan: "pro", source, left: null, used: null, ...rest };
}

/** A free answer, from what has been spent. */
function free(source: Source, used: Record<Meter, number>): Entitlement {
  return {
    plan: "free",
    source,
    used,
    // Clamped: a meter can saturate past its limit in a race, and "-3 left" is
    // not a thing to show anyone.
    left: {
      projects: Math.max(0, FREE_LIMITS.projects - used.projects),
      completions: Math.max(0, FREE_LIMITS.completions - used.completions),
      chats: Math.max(0, FREE_LIMITS.chats - used.chats),
    },
  };
}

/**
 * The whole answer for one account. Everything else in the app reads this.
 */
export async function entitlementOf(
  ctx: QueryCtx,
  owner: string,
): Promise<Entitlement> {
  const now = Date.now();
  const account = await accountOf(ctx, owner);

  if (account?.vip) return pro("vip");

  const code = await codeGrant(ctx, owner, now);
  if (code) return pro("code", code);

  const sub = account?.subscription;
  if (sub && isLiveStatus(sub.status)) {
    const until = paidThrough(sub);
    if (until + WEBHOOK_RETRY_WINDOW > now) {
      return pro("subscription", {
        expiresAt: until,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      });
    }
  }

  return free("none", {
    projects: await liveProjects(ctx, owner),
    completions: account?.acceptedCompletions ?? 0,
    chats: account?.chatConversations ?? 0,
  });
}

/**
 * Features a plan switches on or off, as opposed to meters it counts. Comments
 * are on for every plan: commenting costs no model call and is not something
 * to meter. The flag exists so every gate that asks — minting, discovery, and
 * the comments channel itself — has one answer to ask for.
 */
export const PLAN_FEATURES = {
  free: { comments: true },
  pro: { comments: true },
} as const satisfies Record<Plan, { comments: boolean }>;

export type Feature = keyof (typeof PLAN_FEATURES)[Plan];

const ON_EVERY_PLAN = (feature: Feature) =>
  Object.values(PLAN_FEATURES).every((plan) => plan[feature]);

type OverrideScope = Doc<"entitlementOverrides">["scope"];

async function overrideRow(
  ctx: QueryCtx,
  scope: OverrideScope,
  scopeId: string,
  feature: Feature,
): Promise<Doc<"entitlementOverrides"> | null> {
  return await ctx.db
    .query("entitlementOverrides")
    .withIndex("by_scope_and_feature", (q) =>
      q.eq("scope", scope).eq("scopeId", scopeId).eq("feature", feature),
    )
    .unique();
}

/**
 * An override's answer for one scope, or null when there is none. A row that
 * exists is standing: expiry deletes it (`expireOverride`, scheduled for
 * `expiresAt`) rather than being compared against the clock here, because a
 * subscribed query is not rerun when time passes and would go on answering
 * with a lapsed override.
 */
async function overrideOf(
  ctx: QueryCtx,
  scope: OverrideScope,
  scopeId: string,
  feature: Feature,
): Promise<boolean | null> {
  return (await overrideRow(ctx, scope, scopeId, feature))?.value ?? null;
}

/**
 * Whether a feature is on for a project: an override row for the project,
 * else one for its owner's account, else the owner's plan. Decided by the
 * project OWNER, never the caller: a free commenter on a paid project comments.
 *
 * Asked on every comments-channel read, so the common case stays two indexed
 * point reads of rows that almost never exist. A feature on for every plan
 * needs no plan at all — resolving it reads the owner's account and projects,
 * and would put every open comments doc in their read set.
 */
export async function projectFeature(
  ctx: QueryCtx,
  project: Doc<"projects">,
  feature: Feature,
): Promise<boolean> {
  const forced =
    (await overrideOf(ctx, "project", project._id, feature)) ??
    (await overrideOf(ctx, "account", project.ownerId, feature));
  if (forced !== null) return forced;
  if (ON_EVERY_PLAN(feature)) return true;
  const { plan } = await entitlementOf(ctx, project.ownerId);
  return PLAN_FEATURES[plan][feature];
}

/**
 * Whether a project's pages may carry comments. On for every plan; an
 * override row is how an abused project or account is switched off, and
 * because minting, discovery and the comments channel of the gate all ask
 * here, switching it off closes existing comments documents too.
 */
export async function commentsEnabled(
  ctx: QueryCtx,
  project: Doc<"projects">,
): Promise<boolean> {
  return await projectFeature(ctx, project, "comments");
}

/** A project override goes in that project's log, where its owner would look. */
async function auditOverride(
  ctx: MutationCtx,
  row: Pick<Doc<"entitlementOverrides">, "scope" | "scopeId" | "feature">,
  actor: { actorId: string; actorKind: "operator" | "system" },
  action: string,
): Promise<void> {
  if (row.scope !== "project") return;
  const projectId = ctx.db.normalizeId("projects", row.scopeId);
  if (!projectId) return;
  await recordAudit(ctx, {
    projectId,
    ...actor,
    action,
    subjectKind: "feature",
    subjectId: row.feature,
  });
}

/**
 * Forces a feature on or off for one project or account — or, with `value:
 * null`, removes the override so the plan answers again. `expiresAt` schedules
 * the removal. Internal: an operator runs it from the dashboard (`npx convex
 * run`); nootles-ops has no wrapper for it yet.
 *
 * A project override is recorded in that project's audit log. An account
 * override is not: it spans every project the account owns, and there is no
 * account-level log for it to go in until workspaces bring one.
 */
export const setOverride = internalMutation({
  args: {
    scope: v.union(v.literal("project"), v.literal("account")),
    scopeId: v.string(),
    feature: v.literal("comments"),
    value: v.union(v.boolean(), v.null()),
    note: v.string(),
    /** The operator's own id (their Clerk subject) — id-shaped, for the audit log. */
    grantedBy: v.string(),
    expiresAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { scope, scopeId, feature, value, note, grantedBy, expiresAt } = args;
    if (!isAuditId(grantedBy)) {
      throw new Error("grantedBy must be the operator's id, not a name or an address.");
    }
    if (scope === "project") {
      const projectId = ctx.db.normalizeId("projects", scopeId);
      const project = projectId ? await ctx.db.get(projectId) : null;
      if (!project || isTrashed(project)) throw new Error("No live project has that id.");
    }
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      throw new Error("An override cannot expire in the past.");
    }

    const existing = await overrideRow(ctx, scope, scopeId, feature);
    if (value === null && !existing) return null;
    if (existing) await ctx.db.delete(existing._id);
    if (value !== null) {
      const overrideId = await ctx.db.insert("entitlementOverrides", {
        scope,
        scopeId,
        feature,
        value,
        note,
        grantedBy,
        grantedAt: Date.now(),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });
      if (expiresAt !== undefined) {
        await ctx.scheduler.runAt(expiresAt, internal.entitlements.expireOverride, { overrideId });
      }
    }
    await auditOverride(
      ctx,
      args,
      { actorId: grantedBy, actorKind: "operator" },
      value === null ? "entitlement.clear" : value ? "entitlement.grant" : "entitlement.revoke",
    );
    return null;
  },
});

/**
 * An override's lapse, run at its `expiresAt`. A row replaced since has a new
 * id, so the job scheduled for the old one finds nothing and does nothing.
 */
export const expireOverride = internalMutation({
  args: { overrideId: v.id("entitlementOverrides") },
  returns: v.null(),
  handler: async (ctx, { overrideId }) => {
    const row = await ctx.db.get(overrideId);
    if (!row) return null;
    await ctx.db.delete(row._id);
    await auditOverride(ctx, row, { actorId: "system", actorKind: "system" }, "entitlement.expire");
    return null;
  },
});

/** Whether one meter still has room. Pro always does. */
export function hasRoom(entitlement: Entitlement, meter: Meter): boolean {
  return entitlement.left === null || entitlement.left[meter] > 0;
}

/**
 * Whose allowance a piece of AI work spends: one person's account, or a
 * workspace's. Asked of the project the work is done in, never of the person
 * alone — the same person has chat in a team project and not in their own.
 */
export type Container =
  | { kind: "account"; ownerId: string }
  | { kind: "workspace"; workspaceId: Id<"workspaces"> };

/**
 * The container of work `caller` does in `project`, for a caller already
 * known to write there. A workspace project's work is the workspace's. A
 * personal project's is the caller's own — on somebody else's shared project
 * too, as it always was: an editor spends their own allowance.
 */
export function containerOf(project: Doc<"projects">, caller: string): Container {
  return project.workspaceId
    ? { kind: "workspace", workspaceId: project.workspaceId }
    : { kind: "account", ownerId: caller };
}

/**
 * {@link containerOf} for a project a request merely NAMES, which is whatever
 * anyone sends. A workspace pays only for someone who can write in its project
 * — a member, or a guest an editor link let in — so naming a project you only
 * read, have no part in, or that does not exist spends your own allowance.
 * Takes a string rather than an id for the same reason: a malformed one falls
 * back to the caller's account instead of failing a lookup that fails open.
 */
export async function containerFor(
  ctx: QueryCtx,
  projectId: string,
  caller: string,
): Promise<Container> {
  const id = ctx.db.normalizeId("projects", projectId);
  const project = id && (await readEditable(ctx, "projects", id));
  return project ? containerOf(project, caller) : { kind: "account", ownerId: caller };
}

/** Far past the handful of features there are; a bound, not a working size. */
const OVERRIDE_CAP = 50;

/**
 * What a workspace is on: the plan column in force, what put it there, and
 * every feature once its overrides are laid over that column.
 */
export type WorkspaceStanding = {
  plan: PlanName;
  /** An operator's grant of a plan, a live subscription, or neither — free. */
  source: "override" | "subscription" | "none";
  features: Features;
  /** When the subscription it stands on lapses. */
  expiresAt?: number;
};

/**
 * Whether a workspace's subscription still counts — by the same rule an
 * account's does, and for the same reasons (see `WEBHOOK_RETRY_WINDOW`).
 */
export function workspaceSubscriptionLive(
  billing: Pick<Doc<"workspaceBilling">, "status" | "periodEnd"> | null,
  now: number,
): boolean {
  return (
    billing !== null &&
    isLiveStatus(billing.status) &&
    billing.periodEnd + WEBHOOK_RETRY_WINDOW > now
  );
}

/**
 * The whole answer for one workspace, first match winning, as an account's:
 *
 *   1. an operator's grant of a plan (`feature: "plan"`) — what internal
 *      testers run on, and a promise sales made without a card
 *   2. a live Team subscription: the workspace's own plan
 *   3. otherwise free, on an allowance of its own (`workspaceEntitlement`)
 *
 * Then any other override replaces its feature, whichever plan answered.
 * An override past its `expiresAt`, or of a type its feature does not take,
 * is not there.
 */
export async function workspaceStanding(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<WorkspaceStanding> {
  const now = Date.now();
  const rows = await ctx.db
    .query("workspaceEntitlements")
    .withIndex("by_workspace_and_feature", (q) => q.eq("workspaceId", workspaceId))
    .take(OVERRIDE_CAP);
  const overrides = new Map(
    rows
      .filter((row) => row.expiresAt === undefined || row.expiresAt > now)
      .map((row) => [row.feature, row.value]),
  );

  let standing: Omit<WorkspaceStanding, "features">;
  const granted = overrides.get(PLAN_OVERRIDE);
  if (isPlanName(granted)) {
    standing = { plan: granted, source: "override" };
  } else {
    const billing = await ctx.db
      .query("workspaceBilling")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    // The workspace row only once there is a plan to read off it, so an
    // unpaid workspace's answer does not re-run on every settings change.
    const workspace = workspaceSubscriptionLive(billing, now)
      ? await ctx.db.get(workspaceId)
      : null;
    standing =
      billing && workspace
        ? { plan: workspace.plan, source: "subscription", expiresAt: billing.periodEnd }
        : { plan: "free", source: "none" };
  }

  const features: Features = { ...PLANS[standing.plan] };
  for (const [feature, value] of overrides) {
    if (isFeature(feature) && typeof value === typeof features[feature]) {
      (features as Record<Feature, Features[Feature]>)[feature] = value as Features[Feature];
    }
  }
  return { ...standing, features };
}

/** The resolver: one feature, for whichever container is asking. */
export async function entitlement<F extends Feature>(
  ctx: QueryCtx,
  container: Container,
  feature: F,
): Promise<Features[F]> {
  const features =
    container.kind === "workspace"
      ? (await workspaceStanding(ctx, container.workspaceId)).features
      : PLANS[(await entitlementOf(ctx, container.ownerId)).plan];
  return features[feature];
}

async function workspaceMeters(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"workspaceMeters"> | null> {
  return await ctx.db
    .query("workspaceMeters")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/** {@link liveProjects} for a workspace: every live project in it, whoever made it. */
async function liveWorkspaceProjects(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<number> {
  const rows = await ctx.db
    .query("projects")
    .withIndex("by_workspace_and_deleted", (q) =>
      q.eq("workspaceId", workspaceId).eq("deletedAt", undefined),
    )
    .take(FREE_LIMITS.projects + 1);
  return rows.length;
}

/**
 * A workspace's meters under its standing. Without the `unmetered` feature it
 * is free, and spends one allowance for everybody in it — the same numbers
 * one account gets, so a team that has not paid has not bought ten chats a
 * head.
 */
async function workspaceEntitlement(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  standing: WorkspaceStanding,
): Promise<Entitlement> {
  if (standing.features.unmetered) {
    return pro("workspace", standing.expiresAt === undefined ? {} : { expiresAt: standing.expiresAt });
  }
  const meters = await workspaceMeters(ctx, workspaceId);
  return free("workspace", {
    projects: await liveWorkspaceProjects(ctx, workspaceId),
    completions: meters?.acceptedCompletions ?? 0,
    chats: meters?.chatConversations ?? 0,
  });
}

/** What a container may do: an account's own answer, or its workspace's. */
export async function entitlementIn(
  ctx: QueryCtx,
  container: Container,
): Promise<Entitlement> {
  if (container.kind === "account") return await entitlementOf(ctx, container.ownerId);
  return await workspaceEntitlement(
    ctx,
    container.workspaceId,
    await workspaceStanding(ctx, container.workspaceId),
  );
}

/**
 * A guest's day of a workspace's AI. `day` is the UTC day it was counted on:
 * an answer kept past midnight says nothing about the day after, and whoever
 * holds one compares it with their own.
 */
export type GuestAllowance = { day: string; capUsd: number; spentUsd: number };

/**
 * What is left of the caller's day in the container, when they are a guest in
 * a workspace — anyone doing its work without a paid seat. Null for everyone
 * else, which costs a member one membership read.
 */
export async function guestAllowance(
  ctx: QueryCtx,
  container: Container,
  caller: string,
): Promise<GuestAllowance | null> {
  if (container.kind === "account") return null;
  if (await holdsSeat(ctx, container.workspaceId, caller)) return null;
  const day = utcDay(Date.now());
  const spent = await ctx.db
    .query("guestAiSpend")
    .withIndex("by_workspace_and_day_and_user", (q) =>
      q.eq("workspaceId", container.workspaceId).eq("day", day).eq("userId", caller),
    )
    .unique();
  return {
    day,
    capUsd: await entitlement(ctx, container, "guestDailyAiUsd"),
    spentUsd: spent?.costUsd ?? 0,
  };
}

/** The guest cap as a gate: throws `guestCapRefusal` once the day is spent. */
export async function requireGuestRoom(
  ctx: QueryCtx,
  container: Container,
  caller: string,
): Promise<void> {
  const allowance = await guestAllowance(ctx, container, caller);
  if (allowance && allowance.spentUsd >= allowance.capUsd) {
    throw guestCapRefusal(allowance.capUsd);
  }
}

/**
 * Adds signed spend to a guest's day. Called by the ledger for a row it has
 * verified; the cap is read from here, never from the rows themselves.
 */
export async function spendGuestDay(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  userId: string,
  day: string,
  costUsd: number,
): Promise<void> {
  const row = await ctx.db
    .query("guestAiSpend")
    .withIndex("by_workspace_and_day_and_user", (q) =>
      q.eq("workspaceId", workspaceId).eq("day", day).eq("userId", userId),
    )
    .unique();
  if (row) await ctx.db.patch(row._id, { costUsd: row.costUsd + costUsd });
  else await ctx.db.insert("guestAiSpend", { workspaceId, day, userId, costUsd });
}

/**
 * The gate. Throws `quotaRefusal` when the meter is spent, and otherwise
 * returns the entitlement so the caller does not read it twice.
 *
 * Callers pass the owner they have already resolved through `requireOwner`,
 * which is what keeps a stand-in session out: an operator cannot spend
 * somebody else's allowance because they cannot get past that call at all.
 */
export async function requireQuota(
  ctx: QueryCtx,
  owner: string,
  meter: Meter,
): Promise<Entitlement> {
  return await requireQuotaIn(ctx, { kind: "account", ownerId: owner }, meter);
}

/** {@link requireQuota} for a container: an account, or a workspace's own allowance. */
export async function requireQuotaIn(
  ctx: QueryCtx,
  container: Container,
  meter: Meter,
): Promise<Entitlement> {
  const entitlement = await entitlementIn(ctx, container);
  if (!hasRoom(entitlement, meter)) throw quotaRefusal(meter);
  return entitlement;
}

/** The account row, created on first use. Absence means "free, untouched". */
export async function ensureAccount(
  ctx: MutationCtx,
  owner: string,
): Promise<Doc<"billingAccounts">> {
  const existing = await accountOf(ctx, owner);
  if (existing) return existing;
  const id = await ctx.db.insert("billingAccounts", {
    ownerId: owner,
    acceptedCompletions: 0,
    chatConversations: 0,
    createdAt: Date.now(),
  });
  return (await ctx.db.get(id))!;
}

/**
 * Charges one unit against a meter. Deliberately does NOT throw.
 *
 * Refusing is the gate's job, and the gate runs before the work. By the time
 * something is being charged the work has already happened — an accepted
 * suggestion is already in the document — and turning that into an error would
 * show the user a failure for something that plainly succeeded. A meter that
 * saturates a little past its limit in a race is the cheaper wrong.
 *
 * `projects` is not chargeable: it is counted off the projects themselves.
 */
export async function spendMeter(
  ctx: MutationCtx,
  owner: string,
  meter: Exclude<Meter, "projects">,
): Promise<void> {
  const account = await ensureAccount(ctx, owner);
  const field =
    meter === "completions" ? "acceptedCompletions" : "chatConversations";
  await ctx.db.patch(account._id, { [field]: account[field] + 1 });
}

/** {@link spendMeter} for a workspace's own allowance. Never throws, for the same reason. */
async function spendWorkspaceMeter(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  meter: Exclude<Meter, "projects">,
): Promise<void> {
  const field = meter === "completions" ? "acceptedCompletions" : "chatConversations";
  const meters = await workspaceMeters(ctx, workspaceId);
  if (meters) {
    await ctx.db.patch(meters._id, { [field]: meters[field] + 1 });
    return;
  }
  await ctx.db.insert("workspaceMeters", {
    workspaceId,
    acceptedCompletions: 0,
    chatConversations: 0,
    [field]: 1,
    createdAt: Date.now(),
  });
}

/**
 * {@link spendMeter} for work done in a container, so a workspace's work never
 * touches anyone's own. A workspace counts only while it is on the free
 * allowance: on a live plan what it spends is the cost ledger, and lapsing
 * must not wall it for work it paid for.
 */
export async function spendMeterIn(
  ctx: MutationCtx,
  container: Container,
  meter: Exclude<Meter, "projects">,
): Promise<void> {
  if (container.kind === "account") {
    await spendMeter(ctx, container.ownerId, meter);
    return;
  }
  const standing = await workspaceStanding(ctx, container.workspaceId);
  if (!standing.features.unmetered) {
    await spendWorkspaceMeter(ctx, container.workspaceId, meter);
  }
}

/**
 * Charges a conversation, once, the first time it reaches the model.
 *
 * Called by `/api/chat` before every turn, including the several requests one
 * turn takes as client tools are answered — `billedAt` is what makes that
 * idempotent. A thread already charged is waved through even with the
 * allowance spent, because it was paid for when it started and stopping
 * mid-conversation would punish the user for continuing to talk.
 *
 * Note the order: the quota is checked BEFORE the stamp, so a refusal leaves
 * the thread uncharged and the user can come back to it after upgrading.
 */
export const beginChat = mutation({
  args: {
    threadId: v.id("chatThreads"),
    /**
     * The project the route reads into the turn. Optional only so a route one
     * deploy behind still chats; the thread names its project either way, and
     * that is what is charged.
     */
    projectId: v.optional(v.id("projects")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const thread = await requireOwned(ctx, "chatThreads", args.threadId);
    // A thread from one project carrying another's context would be charged to
    // a container the conversation is not about.
    if (args.projectId !== undefined && args.projectId !== thread.projectId) {
      throw new Error("Not found");
    }
    // Ahead of the paid-for wave-through below: a thread started while the
    // caller could write is no pass once they can only read.
    const project = await requireEditable(ctx, "projects", thread.projectId);
    const owner = await requireOwner(ctx);
    const container = containerOf(project, owner);
    // Also ahead of it: a guest's day runs out mid-conversation as surely as
    // at the start of one.
    await requireGuestRoom(ctx, container, owner);
    if (thread.billedAt !== undefined) return null;
    const entitlement = await entitlementIn(ctx, container);
    if (!hasRoom(entitlement, "chats")) throw quotaRefusal("chats");
    // Pro accounts are not metered, so there is nothing to stamp: were they to
    // lapse, the threads they started while paying should not each be holding
    // a slot of the free allowance they never spent. The same holds for a
    // workspace on a live plan; one on the free allowance spends its own.
    if (entitlement.plan === "free") {
      await ctx.db.patch(args.threadId, { billedAt: Date.now() });
      if (container.kind === "account") await spendMeter(ctx, owner, "chats");
      else await spendWorkspaceMeter(ctx, container.workspaceId, "chats");
    }
    return null;
  },
});

/**
 * Records that this account was stopped by a wall.
 *
 * Called by the wall itself, as it is drawn. Deliberately a separate act from
 * the refusal that caused it: the server refuses in several places and the
 * user is only ever SHOWN one wall, and it is the showing that the funnel is
 * about. What we want to know is who was told no and then didn't pay.
 *
 * Never throws for the caller's benefit — a paywall that produces an error
 * toast because it failed to log itself is worse than not knowing.
 */
export const sawWall = mutation({
  args: { meter: v.union(v.literal("projects"), v.literal("completions"), v.literal("chats")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    const account = await ensureAccount(ctx, owner);
    const now = Date.now();
    const walls = account.walls ?? {
      firstAt: now,
      lastAt: now,
      projects: 0,
      completions: 0,
      chats: 0,
    };
    await ctx.db.patch(account._id, {
      walls: { ...walls, lastAt: now, [args.meter]: walls[args.meter] + 1 },
    });
    return null;
  },
});

/**
 * The caller's own entitlement, subscribed by the app so every wall opens the
 * instant a code is redeemed or a checkout completes — without a reload.
 *
 * Signed out answers `null` — "no answer", not "a spent free plan". The
 * distinction is load-bearing: queries subscribe before Clerk has resolved a
 * token, and a share-link visitor never resolves one at all. A zeroed
 * allowance would have both of them read as somebody who had used everything
 * up, and the app would draw walls at people who are not even signed in.
 */
export const mine = query({
  args: {},
  handler: async (ctx): Promise<Entitlement | null> => {
    const owner = await currentOwner(ctx);
    return owner ? await entitlementOf(ctx, owner) : null;
  },
});

/**
 * Everything one container is entitled to: whose it is, the plan column in
 * force, every feature resolved, the meters, and — for a guest working in a
 * workspace project — what is left of their day.
 */
export type Standing = {
  container:
    | { kind: "account" }
    | { kind: "workspace"; workspaceId: Id<"workspaces">; name: string };
  plan: PlanName;
  features: Features;
  entitlement: Entitlement;
  guestAi: GuestAllowance | null;
};

async function standingIn(
  ctx: QueryCtx,
  container: Container,
  caller: string,
): Promise<Standing> {
  if (container.kind === "account") {
    const entitlement = await entitlementOf(ctx, container.ownerId);
    return {
      container: { kind: "account" },
      plan: entitlement.plan,
      features: PLANS[entitlement.plan],
      entitlement,
      guestAi: null,
    };
  }
  const { workspaceId } = container;
  const standing = await workspaceStanding(ctx, workspaceId);
  return {
    container: {
      kind: "workspace",
      workspaceId,
      name: (await ctx.db.get(workspaceId))?.name ?? "",
    },
    plan: standing.plan,
    features: standing.features,
    entitlement: await workspaceEntitlement(ctx, workspaceId, standing),
    guestAi: await guestAllowance(ctx, container, caller),
  };
}

/**
 * The one query the client reads its plan from (`usePlan`, `useEntitlement`),
 * and what the API routes' pre-checks ask. Signed out answers null, for the
 * same reason as `mine`.
 *
 * Inside a project, the project decides — the workspace's in a workspace
 * project the caller writes in, their own otherwise (see
 * {@link containerFor}). Without one, a workspace named by id answers for
 * someone with a seat in it, as its home and settings ask; anyone else, and
 * no argument at all, gets their own account.
 */
export const forContainer = query({
  args: {
    projectId: v.optional(v.string()),
    workspaceId: v.optional(v.id("workspaces")),
  },
  handler: async (ctx, args): Promise<Standing | null> => {
    const owner = await currentOwner(ctx);
    if (!owner) return null;
    let container: Container = { kind: "account", ownerId: owner };
    if (args.projectId !== undefined) {
      container = await containerFor(ctx, args.projectId, owner);
    } else if (args.workspaceId && (await workspaceRole(ctx, args.workspaceId))) {
      container = { kind: "workspace", workspaceId: args.workspaceId };
    }
    return await standingIn(ctx, container, owner);
  },
});
