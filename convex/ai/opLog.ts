import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { readOwned, requireOwned } from "../auth";
import { parseBatch } from "./operations";

/**
 * The op log — the append-only Context Spine feed. Every applied op batch (human
 * or AI) is recorded here, one row per op, so a future model can read the recent
 * history of changes to a page. Ops are shape-validated against the vocabulary
 * on write (defense in depth; the client already validated + applied).
 */

const source = v.union(v.literal("human"), v.literal("ai"));

export const appendBatch = mutation({
  args: {
    pageId: v.id("pages"),
    chatPromptId: v.optional(v.string()),
    source,
    ops: v.array(v.any()),
  },
  handler: async (ctx, args) => {
    const { ownerId } = await requireOwned(ctx, "pages", args.pageId);
    const check = parseBatch({
      pageId: args.pageId,
      chatPromptId: args.chatPromptId,
      ops: args.ops,
    });
    if (!check.success) {
      throw new Error(
        `Invalid op batch: ${check.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const createdAt = Date.now();
    for (const op of check.data.ops) {
      await ctx.db.insert("opLog", {
        ownerId,
        pageId: args.pageId,
        op,
        source: args.source,
        chatPromptId: args.chatPromptId,
        createdAt,
      });
    }
    return check.data.ops.length;
  },
});

export const feed = query({
  args: { pageId: v.id("pages"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await readOwned(ctx, "pages", args.pageId))) return [];
    const rows = await ctx.db
      .query("opLog")
      .withIndex("by_page", (q) => q.eq("pageId", args.pageId))
      .order("desc")
      .take(args.limit ?? 100);
    return rows.reverse();
  },
});
