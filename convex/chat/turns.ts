import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import {
  ownerId as currentOwner,
  projectRole,
  readOwned,
  requireOwned,
} from "../auth";

/**
 * One agent turn that touched the document, and where its review stands.
 *
 * The row exists so that closing the tab mid-review is survivable. The edits are
 * already in the document — they were applied for real, because an approximation
 * is not what the user should be asked to judge — so without this the page would
 * come back changed with no way left to say no.
 *
 * `trace` is what the applier did, `hunks` is what the user is being asked
 * about. Keyed by `chatPromptId`, which is also what ties the turn to its
 * checkpoints and its op-log rows.
 */

const status = v.union(
  v.literal("streaming"),
  v.literal("pending"),
  v.literal("accepted"),
  v.literal("rejected"),
  v.literal("failed"),
);

export const save = mutation({
  args: {
    threadId: v.id("chatThreads"),
    projectId: v.id("projects"),
    chatPromptId: v.string(),
    pageIds: v.array(v.id("pages")),
    checkpointIds: v.array(v.id("checkpoints")),
    trace: v.any(),
    hunks: v.any(),
    status,
  },
  handler: async (ctx, args) => {
    const { ownerId } = await requireOwned(ctx, "chatThreads", args.threadId);
    const existing = await ctx.db
      .query("chatTurns")
      .withIndex("by_prompt", (q) => q.eq("chatPromptId", args.chatPromptId))
      .unique();

    // chatPromptId is client-supplied, so the upsert has to re-check: owning the
    // thread does not entitle you to overwrite someone else's turn.
    if (existing && existing.ownerId !== ownerId) throw new Error("Not found");

    if (existing) {
      await ctx.db.patch(existing._id, {
        pageIds: args.pageIds,
        checkpointIds: args.checkpointIds,
        trace: args.trace,
        hunks: args.hunks,
        status: args.status,
      });
      return existing._id;
    }
    return await ctx.db.insert("chatTurns", {
      ownerId,
      threadId: args.threadId,
      projectId: args.projectId,
      chatPromptId: args.chatPromptId,
      pageIds: args.pageIds,
      checkpointIds: args.checkpointIds,
      trace: args.trace,
      hunks: args.hunks,
      status: args.status,
      createdAt: Date.now(),
    });
  },
});

/** Stamps that the user restored the pre-turn checkpoint — a whole-turn no. */
export const markRewound = mutation({
  args: { chatPromptId: v.string() },
  handler: async (ctx, args) => {
    const owner = await currentOwner(ctx);
    if (!owner) throw new Error("Not signed in");
    const row = await ctx.db
      .query("chatTurns")
      .withIndex("by_prompt", (q) => q.eq("chatPromptId", args.chatPromptId))
      .unique();
    if (!row || row.ownerId !== owner) throw new Error("Not found");
    await ctx.db.patch(row._id, { rewoundAt: Date.now() });
  },
});

/** One turn, whatever became of it — the row a rewind is planned from. */
export const byPrompt = query({
  args: { chatPromptId: v.string() },
  handler: async (ctx, args) => {
    const owner = await currentOwner(ctx);
    if (!owner) return null;
    const row = await ctx.db
      .query("chatTurns")
      .withIndex("by_prompt", (q) => q.eq("chatPromptId", args.chatPromptId))
      .unique();
    return row?.ownerId === owner ? row : null;
  },
});

/**
 * Which prompts in a thread can still be rewound to, and to what.
 *
 * Answering a review settles it but does not spend the checkpoint: keeping a
 * change is a decision like any other, and "put it back the way it was before I
 * asked" has to survive it. Deliberately thin — the transcript only needs to
 * know which messages get the affordance.
 */
export const restorable = query({
  args: { threadId: v.id("chatThreads") },
  handler: async (ctx, args) => {
    if (!(await readOwned(ctx, "chatThreads", args.threadId))) return [];
    const rows = await ctx.db
      .query("chatTurns")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .collect();
    return rows
      .filter((t) => t.checkpointIds.length)
      .map((t) => ({
        chatPromptId: t.chatPromptId,
        pageCount: t.pageIds.length,
        status: t.status,
      }));
  },
});

/**
 * Turns whose changes are on the page but unanswered. "streaming" is in there
 * because a reload is one of the ways a stream ends — the row never got the
 * chance to say so, and the edits are no less unreviewed for it.
 *
 * Only the caller's own turns: a review is between a person and their AI, so
 * one collaborator's pending answer is never another's banner.
 *
 * Thin on purpose. This is subscribed to for the life of a project page, and
 * every `save` during a streaming turn re-runs it — carrying `trace` and
 * `hunks` it would push the turn's whole packed luggage back to the client
 * that just uploaded it, several times per turn, for hydration to discard.
 * The blobs are fetched per turn from {@link byPrompt} when hydration wants
 * them.
 */
export const unreviewed = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const me = await currentOwner(ctx);
    if (!me) return [];
    const role = await projectRole(ctx, args.projectId);
    if (role !== "owner" && role !== "editor") return [];
    const groups = await Promise.all(
      (["streaming", "pending"] as const).map((s) =>
        ctx.db
          .query("chatTurns")
          .withIndex("by_project_status", (q) =>
            q.eq("projectId", args.projectId).eq("status", s),
          )
          .collect(),
      ),
    );
    return groups
      .flat()
      .filter((t) => t.ownerId === me)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((t) => ({
        chatPromptId: t.chatPromptId,
        threadId: t.threadId,
        projectId: t.projectId,
        pageIds: t.pageIds,
        checkpointIds: t.checkpointIds,
        status: t.status,
        rewoundAt: t.rewoundAt ?? null,
        createdAt: t.createdAt,
      }));
  },
});
