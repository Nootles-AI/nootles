import { internalMutation, mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { readVisible, requireEditable, requireOwner } from "../auth";
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
    await requireEditable(ctx, "pages", args.pageId);
    // The log answers "who changed this", so a row carries its author — the
    // editor who made the op — not the page's owner.
    const ownerId = await requireOwner(ctx);
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
        op: forLog(op),
        source: args.source,
        chatPromptId: args.chatPromptId,
        createdAt,
      });
    }
    return check.data.ops.length;
  },
});

/**
 * An op as the log stores it: a prop string past {@link VALUE_LIMIT} is kept by
 * name and length only.
 *
 * A drawn storyboard travels as ONE updateBlockProps whose data is the whole
 * board — measured at 2.27MiB on a nine-shot Recraft board, past the 1MiB
 * value ceiling, which failed the append and with it the user's ACCEPT. The
 * log is history, not truth: the document holds the content.
 *
 * Elided whenever the value is large, not only when the row would otherwise not
 * fit. A payload that merely fits is still the accepted diagram sent to Convex
 * a second time, kept forever, and charged again to whatever reads the feed.
 * Validation above ran on the real op; only storage sees the stub.
 */
const VALUE_LIMIT = 10_000;

function forLog(op: Record<string, unknown>): Record<string, unknown> {
  const props = op.props as Record<string, unknown> | undefined;
  if (!props) return op;
  return {
    ...op,
    props: Object.fromEntries(
      Object.entries(props).map(([name, value]) => [
        name,
        typeof value === "string" && value.length > VALUE_LIMIT
          ? `<!-- ${value.length} chars elided from the log; the document holds the content -->`
          : value,
      ]),
    ),
  };
}

/**
 * How far back the spine remembers. The feed is context for the next few turns,
 * not an audit trail, and a page edited daily writes rows daily forever.
 */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** One sweep's bite. Rows are small now, but a fold of them still is not. */
const PURGE_BATCH = 512;

export const purgeOld = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const stale = await ctx.db
      .query("opLog")
      .withIndex("by_creation_time", (q) =>
        q.lt("_creationTime", Date.now() - KEEP_MS),
      )
      .take(PURGE_BATCH);
    await Promise.all(stale.map((row) => ctx.db.delete(row._id)));
    return stale.length;
  },
});

export const feed = query({
  args: { pageId: v.id("pages"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await readVisible(ctx, "pages", args.pageId))) return [];
    const rows = await ctx.db
      .query("opLog")
      .withIndex("by_page", (q) => q.eq("pageId", args.pageId))
      .order("desc")
      .take(args.limit ?? 100);
    return rows.reverse();
  },
});
