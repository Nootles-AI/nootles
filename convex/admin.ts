import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { feedbackCategory, feedbackStatus } from "./schema";
import { setDuplicate, setStatus } from "./tickets";

/**
 * The operator's window: cross-tenant reads for the founder dashboard
 * (nootles-ops). Auth is deliberately small: one username/password pair in
 * deployment env vars (ADMIN_USER / ADMIN_PASSWORD), exchanged by `login`
 * for a 30-day session token, which every function here requires. Sessions
 * are rows, so revoking is deleting them; the password never leaves the
 * login call. Brute force is answered by the password's entropy — set a
 * long random one, not a memorable one.
 */

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/** Equal, in time independent of where they differ. */
function sameSecret(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function requireAdmin(ctx: QueryCtx, token: string) {
  const session = await ctx.db
    .query("adminSessions")
    .withIndex("by_token", (q) => q.eq("token", token))
    .unique();
  if (!session || session.expiresAt < Date.now()) throw new Error("Not authorized");
}

export const login = mutation({
  args: { username: v.string(), password: v.string() },
  handler: async (ctx, args) => {
    const user = process.env.ADMIN_USER;
    const pass = process.env.ADMIN_PASSWORD;
    if (
      !user ||
      !pass ||
      !sameSecret(args.username, user) ||
      !sameSecret(args.password, pass)
    ) {
      throw new Error("Wrong username or password");
    }
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    await ctx.db.insert("adminSessions", {
      token,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_MS,
    });
    return token;
  },
});

export const logout = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("adminSessions")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (session) await ctx.db.delete(session._id);
  },
});

/** Never throws — the dashboard uses it to decide login form vs. content. */
export const validate = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("adminSessions")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    return !!session && session.expiresAt >= Date.now();
  },
});

// ---- Feedback -------------------------------------------------------------

/** The dashboard needs a URL where the row keeps a storage id. */
async function withScreenshot(ctx: QueryCtx, row: Doc<"feedback">) {
  return {
    ...row,
    screenshotUrl: row.screenshotStorageId
      ? await ctx.storage.getUrl(row.screenshotStorageId)
      : null,
  };
}

/**
 * A ticket as the detail page needs it: its screenshot, the pull requests that
 * name it, and — when it repeats another — the name to send the reader to.
 */
async function withDetail(ctx: QueryCtx, row: Doc<"feedback">) {
  const prs = await ctx.db
    .query("ticketPrs")
    .withIndex("by_ticket", (q) => q.eq("ticketId", row._id))
    .take(20);
  const parent = row.duplicateOf ? await ctx.db.get(row.duplicateOf) : null;
  const duplicates = await ctx.db
    .query("feedback")
    .withIndex("by_duplicateOf", (q) => q.eq("duplicateOf", row._id))
    .take(50);
  return {
    ...(await withScreenshot(ctx, row)),
    prs: prs.sort((a, b) => b.firstSeenAt - a.firstSeenAt),
    duplicateOfNumber: parent?.number ?? null,
    duplicateNumbers: duplicates.map((d) => d.number).sort((a, b) => a - b),
  };
}

export const feedbackList = query({
  args: {
    token: v.string(),
    paginationOpts: paginationOptsValidator,
    kind: v.optional(v.union(v.literal("issue"), v.literal("wish"))),
    status: v.optional(feedbackStatus),
    /** Duplicates are hidden by default — triaging the same report twice is
     *  the thing linking them was meant to stop. */
    includeDuplicates: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const base = args.status
      ? ctx.db
          .query("feedback")
          .withIndex("by_status", (q) => q.eq("status", args.status!))
      : ctx.db.query("feedback");
    const result = await base
      .order("desc")
      .filter((q) => (args.kind ? q.eq(q.field("kind"), args.kind) : true))
      .filter((q) =>
        args.includeDuplicates
          ? true
          : q.eq(q.field("duplicateOf"), undefined),
      )
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: await Promise.all(result.page.map((row) => withScreenshot(ctx, row))),
    };
  },
});

/** Unread count for the nav badge. Bounded — past 99 it reads "99+" anyway. */
export const feedbackNewCount = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const rows = await ctx.db
      .query("feedback")
      .withIndex("by_status", (q) => q.eq("status", "new"))
      .take(100);
    return rows.length;
  },
});

export const feedbackGet = query({
  args: { token: v.string(), id: v.id("feedback") },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const row = await ctx.db.get(args.id);
    return row ? await withDetail(ctx, row) : null;
  },
});

/**
 * The same ticket by its `NT-{number}` name — what the dashboard's own URLs and
 * the PR poller both resolve, since neither has a Convex id to hand.
 */
export const feedbackByNumber = query({
  args: { token: v.string(), number: v.number() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const row = await ctx.db
      .query("feedback")
      .withIndex("by_number", (q) => q.eq("number", args.number))
      .unique();
    return row ? await withDetail(ctx, row) : null;
  },
});

export const feedbackSetStatus = mutation({
  args: { token: v.string(), id: v.id("feedback"), status: feedbackStatus },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    // Through the shared helper, so marking one report done answers everyone
    // who filed the same one.
    await setStatus(ctx, args.id, args.status);
  },
});

/**
 * Mark a ticket as repeating another, or clear it with a null target. The
 * chain-collapsing and self-reference rules live in `tickets.ts`.
 */
export const feedbackSetDuplicate = mutation({
  args: {
    token: v.string(),
    id: v.id("feedback"),
    duplicateOf: v.union(v.id("feedback"), v.null()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    await setDuplicate(ctx, args.id, args.duplicateOf, "human");
  },
});

/**
 * Keep a ticket away from the agent, or let it back in.
 *
 * The flag is only half of it — `triageQueue` and `implementQueue` filter on it
 * so a skipped ticket is never handed out in the first place. That is what
 * makes this a boundary rather than an instruction the agent could drift past.
 */
export const feedbackSetAgentSkip = mutation({
  args: { token: v.string(), id: v.id("feedback"), skip: v.boolean() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    await ctx.db.patch(args.id, { agentSkip: args.skip || undefined });
  },
});

/** Absent priority clears it — "no priority" is the absence, not a value. */
export const feedbackSetPriority = mutation({
  args: {
    token: v.string(),
    id: v.id("feedback"),
    priority: v.optional(
      v.union(
        v.literal("urgent"),
        v.literal("high"),
        v.literal("medium"),
        v.literal("low"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    await ctx.db.patch(args.id, { priority: args.priority });
  },
});

/** Re-file a report under the surface it is actually about. */
export const feedbackSetCategory = mutation({
  args: {
    token: v.string(),
    id: v.id("feedback"),
    category: v.optional(feedbackCategory),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    await ctx.db.patch(args.id, { category: args.category });
  },
});

/** A bug report that was really a wish, or the reverse, moves between tabs. */
export const feedbackSetKind = mutation({
  args: {
    token: v.string(),
    id: v.id("feedback"),
    kind: v.union(v.literal("issue"), v.literal("wish")),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    await ctx.db.patch(args.id, { kind: args.kind });
  },
});

// ---- Suggestions ----------------------------------------------------------

const CAP = 5000;

export const suggestionStats = query({
  args: { token: v.string(), sinceMs: v.number() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const rows = await ctx.db
      .query("suggestionLog")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", args.sinceMs))
      .take(CAP);
    type Bucket = {
      kind: string;
      shown: number;
      accepted: number;
      dismissed: number;
      superseded: number;
      failed: number;
      gated: number;
      undone: number;
      latencyTotal: number;
      decisionTotal: number;
      decisionCount: number;
      survivalTotal: number;
      survivalCount: number;
    };
    const buckets = new Map<string, Bucket>();
    for (const row of rows) {
      let b = buckets.get(row.kind);
      if (!b) {
        b = {
          kind: row.kind,
          shown: 0,
          accepted: 0,
          dismissed: 0,
          superseded: 0,
          failed: 0,
          gated: 0,
          undone: 0,
          latencyTotal: 0,
          decisionTotal: 0,
          decisionCount: 0,
          survivalTotal: 0,
          survivalCount: 0,
        };
        buckets.set(row.kind, b);
      }
      if (row.shown) b.shown += 1;
      b[row.outcome] += 1;
      b.latencyTotal += row.latencyMs;
      if (row.decisionMs !== undefined) {
        b.decisionTotal += row.decisionMs;
        b.decisionCount += 1;
      }
      if (row.survivalScore !== undefined) {
        b.survivalTotal += row.survivalScore;
        b.survivalCount += 1;
      }
      if (row.undoneWithinMs !== undefined) b.undone += 1;
    }
    return {
      sampled: rows.length,
      capped: rows.length === CAP,
      kinds: [...buckets.values()].sort((a, b) => b.shown - a.shown),
    };
  },
});

export const suggestionRecent = query({
  args: {
    token: v.string(),
    limit: v.optional(v.number()),
    kind: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    return await ctx.db
      .query("suggestionLog")
      .order("desc")
      .filter((q) => (args.kind ? q.eq(q.field("kind"), args.kind) : true))
      .take(Math.min(args.limit ?? 50, 200));
  },
});

// ---- AI calls -------------------------------------------------------------

export const aiCallStats = query({
  args: { token: v.string(), sinceMs: v.number() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const rows = await ctx.db
      .query("aiCalls")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", args.sinceMs))
      .take(CAP);
    type Bucket = {
      feature: string;
      calls: number;
      errors: number;
      aborted: number;
      promptTokens: number;
      completionTokens: number;
      costUsd: number;
      latencies: number[];
    };
    const buckets = new Map<string, Bucket>();
    const byDay = new Map<string, number>();
    const byOwner = new Map<string, number>();
    for (const row of rows) {
      let b = buckets.get(row.feature);
      if (!b) {
        b = {
          feature: row.feature,
          calls: 0,
          errors: 0,
          aborted: 0,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0,
          latencies: [],
        };
        buckets.set(row.feature, b);
      }
      b.calls += 1;
      if (row.status === "error" || row.status === "timeout") b.errors += 1;
      if (row.status === "aborted") b.aborted += 1;
      b.promptTokens += row.promptTokens ?? 0;
      b.completionTokens += row.completionTokens ?? 0;
      b.costUsd += row.costUsd ?? 0;
      b.latencies.push(row.latencyMs);
      const day = new Date(row.createdAt).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + (row.costUsd ?? 0));
      byOwner.set(row.ownerId, (byOwner.get(row.ownerId) ?? 0) + (row.costUsd ?? 0));
    }
    const pct = (sorted: number[], p: number) =>
      sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : 0;
    return {
      sampled: rows.length,
      capped: rows.length === CAP,
      features: [...buckets.values()]
        .map(({ latencies, ...b }) => {
          const sorted = [...latencies].sort((x, y) => x - y);
          return { ...b, p50: pct(sorted, 0.5), p95: pct(sorted, 0.95) };
        })
        .sort((a, b) => b.costUsd - a.costUsd),
      costByDay: [...byDay.entries()]
        .map(([day, costUsd]) => ({ day, costUsd }))
        .sort((a, b) => a.day.localeCompare(b.day)),
      spenders: [...byOwner.entries()]
        .map(([ownerId, costUsd]) => ({ ownerId, costUsd }))
        .sort((a, b) => b.costUsd - a.costUsd)
        .slice(0, 20),
    };
  },
});

export const aiCallRecent = query({
  args: { token: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    return await ctx.db
      .query("aiCalls")
      .order("desc")
      .take(Math.min(args.limit ?? 50, 200));
  },
});

// ---- Users ------------------------------------------------------------------

/**
 * Who is here, who just arrived, who actually used the thing. "Active" is
 * derived from AI traffic (aiCalls + suggestionLog owners in range) — typing
 * fires the completion lane, so any real editing session leaves tracks there.
 */
export const userStats = query({
  args: { token: v.string(), sinceMs: v.number() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);

    const profiles = await ctx.db.query("profiles").take(CAP);
    const newUsers = profiles.filter((p) => p.createdAt >= args.sinceMs).length;
    const roles = new Map<string, number>();
    for (const p of profiles) {
      const role = p.role?.trim() || "(not answered)";
      roles.set(role, (roles.get(role) ?? 0) + 1);
    }

    const active = new Set<string>();
    const calls = await ctx.db
      .query("aiCalls")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", args.sinceMs))
      .take(CAP);
    for (const c of calls) active.add(c.ownerId);
    const suggestions = await ctx.db
      .query("suggestionLog")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", args.sinceMs))
      .take(CAP);
    for (const s of suggestions) active.add(s.ownerId);

    const pages = await ctx.db
      .query("pages")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", args.sinceMs))
      .take(CAP);
    const reports = await ctx.db
      .query("feedback")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", args.sinceMs))
      .take(CAP);

    return {
      totalUsers: profiles.length,
      totalCapped: profiles.length === CAP,
      newUsers,
      activeUsers: active.size,
      pagesCreated: pages.length,
      reports: reports.length,
      roles: [...roles.entries()]
        .map(([role, count]) => ({ role, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12),
    };
  },
});

/**
 * Every account, with enough context to recognize a friend: email (stamped
 * from the identity), survey answers, whether the founder letter was seen,
 * and when they last generated any AI traffic.
 */
export const userList = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const profiles = await ctx.db.query("profiles").take(1000);
    return await Promise.all(
      profiles
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(async (p) => {
          const lastCall = await ctx.db
            .query("aiCalls")
            .withIndex("by_owner", (q) => q.eq("ownerId", p.ownerId))
            .order("desc")
            .first();
          return {
            ownerId: p.ownerId,
            email: p.email ?? null,
            name: p.name ?? null,
            imageUrl: p.imageUrl ?? null,
            role: p.role ?? null,
            useCase: p.useCase ?? null,
            status: p.status,
            createdAt: p.createdAt,
            letterSeen: (p.hints ?? []).includes("tester-note"),
            lastActiveAt: lastCall?.createdAt ?? null,
          };
        }),
    );
  },
});

/**
 * One user, watched closely: milestones (letter, tutorial), what the AI saw
 * them accept, what their usage costs, what they made and reported.
 */
export const userDetail = query({
  args: { token: v.string(), ownerId: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .unique();
    if (!profile) return null;

    const projects = await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .take(200);
    let pageCount = 0;
    let tutorial: { edited: boolean; aiRows: number } | null = null;
    for (const project of projects) {
      const pages = await ctx.db
        .query("pages")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .take(200);
      pageCount += pages.length;
      if (profile.seed?.projectId === project._id) {
        let edited = false;
        let aiRows = 0;
        for (const page of pages) {
          if (page.updatedAt !== undefined && page.updatedAt > page.createdAt + 60_000) {
            edited = true;
          }
          const rows = await ctx.db
            .query("suggestionLog")
            .withIndex("by_page", (q) => q.eq("pageId", page._id))
            .take(200);
          aiRows += rows.length;
        }
        tutorial = { edited, aiRows };
      }
    }

    const suggestions = await ctx.db
      .query("suggestionLog")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(2000);
    const kinds = new Map<string, { shown: number; accepted: number }>();
    let firstAcceptedAt: number | null = null;
    for (const s of suggestions) {
      let k = kinds.get(s.kind);
      if (!k) {
        k = { shown: 0, accepted: 0 };
        kinds.set(s.kind, k);
      }
      if (s.shown) k.shown += 1;
      if (s.outcome === "accepted") {
        k.accepted += 1;
        if (firstAcceptedAt === null || s.createdAt < firstAcceptedAt) {
          firstAcceptedAt = s.createdAt;
        }
      }
    }

    const calls = await ctx.db
      .query("aiCalls")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(2000);
    const features = new Map<string, { calls: number; costUsd: number }>();
    for (const c of calls) {
      let f = features.get(c.feature);
      if (!f) {
        f = { calls: 0, costUsd: 0 };
        features.set(c.feature, f);
      }
      f.calls += 1;
      f.costUsd += c.costUsd ?? 0;
    }

    const reports = await ctx.db
      .query("feedback")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .order("desc")
      .take(100);

    return {
      profile: {
        ownerId: profile.ownerId,
        email: profile.email ?? null,
        name: profile.name ?? null,
        imageUrl: profile.imageUrl ?? null,
        role: profile.role ?? null,
        useCase: profile.useCase ?? null,
        status: profile.status,
        createdAt: profile.createdAt,
        hints: profile.hints ?? [],
        letterSeen: (profile.hints ?? []).includes("tester-note"),
        hasSeed: !!profile.seed,
      },
      tutorial,
      projects: projects.map((p) => ({
        id: p._id,
        title: p.title,
        createdAt: p.createdAt,
        shared: !!p.shareToken,
      })),
      pageCount,
      suggestionKinds: [...kinds.entries()]
        .map(([kind, k]) => ({ kind, ...k }))
        .sort((a, b) => b.shown - a.shown),
      suggestionsSampled: suggestions.length,
      firstAcceptedAt,
      features: [...features.entries()]
        .map(([feature, f]) => ({ feature, ...f }))
        .sort((a, b) => b.calls - a.calls),
      lastActiveAt: calls[0]?.createdAt ?? null,
      reports: reports.map((r) => ({
        id: r._id,
        number: r.number,
        kind: r.kind,
        text: r.text.slice(0, 120),
        status: r.status,
        createdAt: r.createdAt,
      })),
    };
  },
});

// ---- Chat + surveys ---------------------------------------------------------

export const chatStats = query({
  args: { token: v.string(), sinceMs: v.number() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const turns = await ctx.db
      .query("chatTurns")
      .withIndex("by_creation_time", (q) => q.gte("_creationTime", args.sinceMs))
      .take(CAP);
    const byStatus = new Map<string, number>();
    let rewound = 0;
    for (const t of turns) {
      byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
      if (t.rewoundAt !== undefined) rewound += 1;
    }
    return {
      turns: turns.length,
      rewound,
      byStatus: [...byStatus.entries()].map(([status, count]) => ({ status, count })),
    };
  },
});

export const surveyList = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    return await ctx.db.query("surveyResponses").order("desc").take(200);
  },
});

// ---- The agent's queues ----------------------------------------------------

/**
 * Everything the nightly agent may do is decided here, in what these queries
 * return — not in the instructions it is given.
 *
 * The agent holds the same admin token the dashboard does, so a rule kept in a
 * prompt is a rule it could drift past. A rule kept in a `WHERE` clause is one
 * it never sees the rows for. That is the whole design: `agentSkip`, the
 * cooling window, duplicates and the kill switch are all filters here.
 */

/** Defaults for a deployment where nobody has written the config row yet. */
const DEFAULT_CONFIG = {
  agentEnabled: false,
  implementEnabled: false,
  maxPerRun: 5,
  coolingHours: 12,
  scoreThreshold: 70,
};

async function config(ctx: QueryCtx) {
  const row = await ctx.db.query("opsConfig").unique();
  return row ?? DEFAULT_CONFIG;
}

/** How many tickets a queue will scan. Bounded, per the query guidelines. */
const QUEUE_SCAN = 500;

export const opsConfigGet = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const row = await ctx.db.query("opsConfig").unique();
    return { ...(row ?? DEFAULT_CONFIG), configured: row !== null };
  },
});

export const opsConfigSet = mutation({
  args: {
    token: v.string(),
    agentEnabled: v.boolean(),
    implementEnabled: v.boolean(),
    maxPerRun: v.number(),
    coolingHours: v.number(),
    scoreThreshold: v.number(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const { token: _token, ...values } = args;
    const row = await ctx.db.query("opsConfig").unique();
    if (row) await ctx.db.patch(row._id, values);
    else await ctx.db.insert("opsConfig", values);
  },
});

/**
 * Tickets worth reading tonight.
 *
 * `now` is an argument rather than `Date.now()`: a query must not read the wall
 * clock — it would not re-run as time passed, and the cached result would go
 * quietly stale. The caller supplies its own clock, the same way `aiCallStats`
 * takes `sinceMs`.
 */
export const triageQueue = query({
  args: { token: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const cfg = await config(ctx);
    if (!cfg.agentEnabled) return { enabled: false, tickets: [] };

    const cutoff = args.now - cfg.coolingHours * 60 * 60 * 1000;
    const rows = await ctx.db
      .query("feedback")
      .order("desc")
      .filter((q) =>
        q.and(
          // Never handed out: the operator said hands off.
          q.eq(q.field("agentSkip"), undefined),
          // A duplicate is answered by the ticket it points at.
          q.eq(q.field("duplicateOf"), undefined),
          // Scored already; re-reading it would only re-score it.
          q.eq(q.field("triagedAt"), undefined),
          // Young enough that nobody has had a chance to look yet.
          q.lte(q.field("createdAt"), cutoff),
        ),
      )
      .take(QUEUE_SCAN);

    return {
      enabled: true,
      tickets: await Promise.all(
        rows.slice(0, cfg.maxPerRun).map((row) => withDetail(ctx, row)),
      ),
    };
  },
});

/**
 * Tickets concrete enough to attempt, and not attempted before. Everything
 * `triageQueue` excludes is excluded here too.
 */
export const implementQueue = query({
  args: { token: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    const cfg = await config(ctx);
    if (!cfg.agentEnabled || !cfg.implementEnabled) {
      return { enabled: false, tickets: [] };
    }

    const rows = await ctx.db
      .query("feedback")
      .order("desc")
      .filter((q) =>
        q.and(
          q.eq(q.field("agentSkip"), undefined),
          q.eq(q.field("duplicateOf"), undefined),
          // Tried once already — success or failure, it is not tonight's work.
          q.eq(q.field("agentAttemptedAt"), undefined),
          q.gte(q.field("triageScore"), cfg.scoreThreshold),
          q.neq(q.field("status"), "done"),
          q.neq(q.field("status"), "declined"),
          q.neq(q.field("status"), "pr_filed"),
        ),
      )
      .take(QUEUE_SCAN);

    const ranked = rows.sort(
      (a, b) => (b.triageScore ?? 0) - (a.triageScore ?? 0),
    );
    return {
      enabled: true,
      tickets: await Promise.all(
        ranked.slice(0, cfg.maxPerRun).map((row) => withDetail(ctx, row)),
      ),
    };
  },
});

/** What the agent concluded about a ticket. */
export const feedbackSetTriage = mutation({
  args: {
    token: v.string(),
    id: v.id("feedback"),
    score: v.number(),
    notes: v.string(),
    rubricVersion: v.string(),
    runId: v.optional(v.id("agentRuns")),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    await ctx.db.patch(args.id, {
      triageScore: args.score,
      triageNotes: args.notes,
      rubricVersion: args.rubricVersion,
      triagedAt: args.now,
      ...(args.runId ? { triageRunId: args.runId } : {}),
    });
  },
});

/** That the agent tried — which is what stops it trying again tomorrow. */
export const feedbackRecordAgentAttempt = mutation({
  args: {
    token: v.string(),
    id: v.id("feedback"),
    outcome: v.union(
      v.literal("filed"),
      v.literal("failed"),
      v.literal("declined"),
    ),
    runId: v.optional(v.id("agentRuns")),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    await ctx.db.patch(args.id, {
      agentAttemptedAt: args.now,
      agentOutcome: args.outcome,
      ...(args.runId ? { agentRunId: args.runId } : {}),
    });
  },
});

/** The agent's own duplicate call, kept distinguishable from the operator's. */
export const feedbackSetDuplicateByAgent = mutation({
  args: {
    token: v.string(),
    id: v.id("feedback"),
    duplicateOf: v.id("feedback"),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    await setDuplicate(ctx, args.id, args.duplicateOf, "agent");
  },
});

// ---- The run ledger --------------------------------------------------------

export const runStart = mutation({
  args: {
    token: v.string(),
    kind: v.union(v.literal("triage"), v.literal("implement")),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    return await ctx.db.insert("agentRuns", {
      kind: args.kind,
      startedAt: args.now,
      status: "running",
      ticketsRead: 0,
      duplicatesLinked: 0,
      scored: 0,
      prsFiled: 0,
      errors: [],
    });
  },
});

/** Errors are capped: a run that fails a hundred ways says so in ten. */
const MAX_ERRORS = 10;

export const runFinish = mutation({
  args: {
    token: v.string(),
    id: v.id("agentRuns"),
    status: v.union(v.literal("ok"), v.literal("failed")),
    ticketsRead: v.number(),
    duplicatesLinked: v.number(),
    scored: v.number(),
    prsFiled: v.number(),
    errors: v.array(v.string()),
    notes: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    await ctx.db.patch(args.id, {
      status: args.status,
      finishedAt: args.now,
      ticketsRead: args.ticketsRead,
      duplicatesLinked: args.duplicatesLinked,
      scored: args.scored,
      prsFiled: args.prsFiled,
      errors: args.errors.slice(0, MAX_ERRORS).map((e) => e.slice(0, 500)),
      ...(args.notes ? { notes: args.notes.slice(0, 2000) } : {}),
    });
  },
});

/** The morning's read: what ran, what it touched, and what broke. */
export const runList = query({
  args: { token: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    return await ctx.db
      .query("agentRuns")
      .withIndex("by_startedAt")
      .order("desc")
      .take(Math.min(args.limit ?? 20, 100));
  },
});
