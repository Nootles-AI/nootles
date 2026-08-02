import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { readOwned, requireOwned } from "../auth";

/**
 * Telemetry for the ambient suggestion pipeline. Every proposal that reaches
 * the gate is recorded with its outcome, so we can measure precision (how often
 * a shown suggestion is accepted) and tune the heuristics — and, later, use it
 * as training data.
 */

export const log = mutation({
  args: {
    pageId: v.id("pages"),
    kind: v.string(),
    gateOk: v.boolean(),
    shown: v.boolean(),
    outcome: v.union(
      v.literal("gated"),
      v.literal("accepted"),
      v.literal("dismissed"),
      v.literal("superseded"),
      v.literal("failed"),
    ),
    latencyMs: v.number(),
  },
  handler: async (ctx, args) => {
    const { ownerId } = await requireOwned(ctx, "pages", args.pageId);
    await ctx.db.insert("suggestionLog", {
      ownerId,
      ...args,
      createdAt: Date.now(),
    });
  },
});

/** Recent suggestion outcomes for a page — the acceptance-rate read-out. */
export const recent = query({
  args: { pageId: v.id("pages"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await readOwned(ctx, "pages", args.pageId))) return [];
    const rows = await ctx.db
      .query("suggestionLog")
      .withIndex("by_page", (q) => q.eq("pageId", args.pageId))
      .order("desc")
      .take(args.limit ?? 100);
    return rows;
  },
});
