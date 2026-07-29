import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { getOwnerId } from "../auth";

/**
 * Thread messages, stored as the AI SDK's own `UIMessage.parts`.
 *
 * Keeping the parts verbatim is what makes a reloaded thread faithful: tool
 * calls and their results are already parts, so the transcript re-renders the
 * way it streamed, and `convertToModelMessages` hands the model exactly what it
 * saw the first time. A bespoke message table would be a second representation
 * to keep in sync with the SDK's, and it would drift.
 */

const role = v.union(
  v.literal("user"),
  v.literal("assistant"),
  v.literal("system"),
);

const attachment = v.object({
  storageId: v.id("_storage"),
  partIndex: v.number(),
  mediaType: v.string(),
  filename: v.optional(v.string()),
});

export const list = query({
  args: { threadId: v.id("chatThreads") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();

    // Attachment URLs expire, so they are derived on read rather than stored.
    return await Promise.all(
      rows.map(async (row) => ({
        ...row,
        attachmentUrls: row.attachments
          ? await Promise.all(
              row.attachments.map(async (a) => ({
                partIndex: a.partIndex,
                url: await ctx.storage.getUrl(a.storageId),
              })),
            )
          : undefined,
      })),
    );
  },
});

/**
 * Writes a message, keyed on the SDK's message id.
 *
 * Idempotent on `uiId` because the same assistant message is saved twice by
 * design — once when the server stream ends and once when the client settles —
 * and a turn that is retried must not leave a duplicate behind.
 */
export const put = mutation({
  args: {
    threadId: v.id("chatThreads"),
    uiId: v.string(),
    role,
    parts: v.any(),
    metadata: v.optional(v.any()),
    chatPromptId: v.optional(v.string()),
    pageIdAtSend: v.optional(v.id("pages")),
    attachments: v.optional(v.array(attachment)),
  },
  handler: async (ctx, args) => {
    const ownerId = await getOwnerId(ctx);
    const existing = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();

    const match = existing.find((m) => m.uiId === args.uiId);
    if (match) {
      await ctx.db.patch(match._id, {
        parts: args.parts,
        metadata: args.metadata,
        chatPromptId: args.chatPromptId ?? match.chatPromptId,
      });
      return match._id;
    }

    const seq = existing.reduce((max, m) => Math.max(max, m.seq), -1) + 1;
    const id = await ctx.db.insert("chatMessages", {
      ownerId,
      threadId: args.threadId,
      uiId: args.uiId,
      role: args.role,
      seq,
      parts: args.parts,
      metadata: args.metadata,
      chatPromptId: args.chatPromptId,
      pageIdAtSend: args.pageIdAtSend,
      attachments: args.attachments,
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.threadId, { updatedAt: Date.now() });
    return id;
  },
});

/**
 * Drops a message and everything after it — the conversation half of a rewind.
 *
 * Addressed by the SDK's own message id rather than by `seq`, so the caller
 * names the message it can actually see. A message that is already gone deletes
 * nothing rather than guessing at a position: rewinding twice to the same place
 * should be the second one doing nothing, not taking the thread with it.
 */
export const truncateFrom = mutation({
  args: { threadId: v.id("chatThreads"), uiId: v.string() },
  handler: async (ctx, args) => {
    const from = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .filter((q) => q.eq(q.field("uiId"), args.uiId))
      .first();
    if (!from) return 0;

    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread", (q) =>
        q.eq("threadId", args.threadId).gte("seq", from.seq),
      )
      .collect();
    await Promise.all(rows.map((r) => ctx.db.delete(r._id)));
    return rows.length;
  },
});
