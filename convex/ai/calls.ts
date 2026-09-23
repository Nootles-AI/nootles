import { mutation } from "../_generated/server";
import { v } from "convex/values";
import { requireOwner } from "../auth";
import { containerFor } from "../entitlements";

/**
 * The LLM ledger: one row per model request, written fire-and-forget by the
 * API routes after each stream ends. Public rather than internal because the
 * routes act *as the user* through a session-token ConvexHttpClient, which
 * cannot reach internal functions. ownerId is derived server-side, and so is
 * the workspace a row is charged to, so a client can only file rows against
 * containers it spends in. The cost itself is still the client's word — a
 * ledger a workspace is billed from has to stop taking it.
 */
export const record = mutation({
  args: {
    feature: v.union(
      v.literal("fim"),
      v.literal("reformat"),
      v.literal("diagram"),
      v.literal("chat"),
      v.literal("categorize"),
      v.literal("feedback"),
      v.literal("album"),
      v.literal("context"),
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
    /**
     * The project the call was made in, as the request named it. Only ever
     * used to find the paying workspace, through the caller's own role — so it
     * is a string, and a bad one records the row against the caller rather
     * than losing it.
     */
    projectId: v.optional(v.string()),
  },
  handler: async (ctx, { projectId, ...call }) => {
    const ownerId = await requireOwner(ctx);
    const container = projectId ? await containerFor(ctx, projectId, ownerId) : null;
    await ctx.db.insert("aiCalls", {
      ownerId,
      ...call,
      ...(container?.kind === "workspace" ? { workspaceId: container.workspaceId } : {}),
      createdAt: Date.now(),
    });
  },
});
