import { mutation } from "../_generated/server";
import { v } from "convex/values";
import { requireOwner } from "../auth";

/**
 * The LLM ledger: one row per model request, written fire-and-forget by the
 * API routes after each stream ends. Public rather than internal because the
 * routes act *as the user* through a session-token ConvexHttpClient, which
 * cannot reach internal functions — ownerId is derived server-side, so the
 * worst a client can do is pollute its own ledger.
 */
export const record = mutation({
  args: {
    feature: v.union(
      v.literal("fim"),
      v.literal("reformat"),
      v.literal("diagram"),
      v.literal("chat"),
    ),
    model: v.string(),
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    cacheReadTokens: v.optional(v.number()),
    cacheWriteTokens: v.optional(v.number()),
    latencyMs: v.number(),
    ttfbMs: v.optional(v.number()),
    status: v.union(
      v.literal("ok"),
      v.literal("error"),
      v.literal("aborted"),
      v.literal("timeout"),
    ),
    errorCode: v.optional(v.string()),
    costUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireOwner(ctx);
    await ctx.db.insert("aiCalls", { ownerId, ...args, createdAt: Date.now() });
  },
});
