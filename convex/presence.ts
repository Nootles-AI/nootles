import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { ownerId } from "./auth";
import { checkRead } from "./prosemirror";

/**
 * The presence channel: who is on a doc, and where their caret is. Announcing
 * yourself is a read-level act — a share-link viewer's cursor is as real as
 * an editor's — so everything here is gated by the same `checkRead` the doc
 * itself is.
 *
 * Liveness is time-based, never event-based: a closed laptop sends no
 * goodbye. `leave` is a courtesy for the common case; the truth is
 * `updatedAt`, which clients judge against their own clock and a cron sweeps.
 */

/** A row older than this is a ghost; the cron deletes, clients ignore sooner. */
const EXPIRE_MS = 60_000;

export const heartbeat = mutation({
  args: {
    docId: v.string(),
    sessionId: v.string(),
    clientId: v.number(),
    user: v.object({
      name: v.string(),
      color: v.string(),
      imageUrl: v.optional(v.string()),
    }),
    state: v.bytes(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await checkRead(ctx, args.docId);
    const me = await ownerId(ctx);
    const existing = await ctx.db
      .query("presence")
      .withIndex("by_doc_and_session", (q) =>
        q.eq("docId", args.docId).eq("sessionId", args.sessionId),
      )
      .unique();
    const row = {
      docId: args.docId,
      sessionId: args.sessionId,
      clientId: args.clientId,
      userId: me ?? undefined,
      user: args.user,
      state: args.state,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert("presence", row);
    return null;
  },
});

/**
 * Everyone announced on a doc, ghosts included — staleness is the CLIENT's
 * judgement, because a query that read the clock would go stale itself.
 */
export const list = query({
  args: { docId: v.string() },
  handler: async (ctx, args) => {
    await checkRead(ctx, args.docId);
    const rows = await ctx.db
      .query("presence")
      .withIndex("by_doc", (q) => q.eq("docId", args.docId))
      .take(100);
    return rows.map((r) => ({
      sessionId: r.sessionId,
      clientId: r.clientId,
      userId: r.userId ?? null,
      user: r.user,
      state: r.state,
      updatedAt: r.updatedAt,
    }));
  },
});

export const leave = mutation({
  args: { docId: v.string(), sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    // No auth beyond the session id itself: you can only ever hang up your
    // own unguessable session, and a read check would stop a guest from
    // leaving a doc whose link was just revoked — the one moment leaving is
    // exactly what should happen.
    const existing = await ctx.db
      .query("presence")
      .withIndex("by_doc_and_session", (q) =>
        q.eq("docId", args.docId).eq("sessionId", args.sessionId),
      )
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});

/** The cron's sweep of sessions that never said goodbye. */
export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const horizon = Date.now() - EXPIRE_MS;
    const stale = await ctx.db
      .query("presence")
      .withIndex("by_updated", (q) => q.lt("updatedAt", horizon))
      .take(100);
    await Promise.all(stale.map((r) => ctx.db.delete(r._id)));
    return null;
  },
});
