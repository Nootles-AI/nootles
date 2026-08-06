import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { feedbackCategory } from "./schema";

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

const feedbackStatus = v.union(
  v.literal("new"),
  v.literal("seen"),
  v.literal("in_progress"),
  v.literal("done"),
  v.literal("declined"),
);

export const feedbackList = query({
  args: {
    token: v.string(),
    paginationOpts: paginationOptsValidator,
    kind: v.optional(v.union(v.literal("issue"), v.literal("wish"))),
    status: v.optional(feedbackStatus),
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
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: await Promise.all(
        result.page.map(async (row) => ({
          ...row,
          screenshotUrl: row.screenshotStorageId
            ? await ctx.storage.getUrl(row.screenshotStorageId)
            : null,
        })),
      ),
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
    if (!row) return null;
    return {
      ...row,
      screenshotUrl: row.screenshotStorageId
        ? await ctx.storage.getUrl(row.screenshotStorageId)
        : null,
    };
  },
});

export const feedbackSetStatus = mutation({
  args: { token: v.string(), id: v.id("feedback"), status: feedbackStatus },
  handler: async (ctx, args) => {
    await requireAdmin(ctx, args.token);
    await ctx.db.patch(args.id, { status: args.status });
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
