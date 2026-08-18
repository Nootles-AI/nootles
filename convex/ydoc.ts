import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import * as Y from "yjs";
import { components, internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { checkRead, checkWrite, pageForDoc } from "./prosemirror";
import { joinUpdateRows } from "./yshape";

/**
 * Yjs document sync: an update log folded into chunked snapshots, one doc per
 * page, pushed to clients through the reactivity of `meta`.
 *
 * The protocol leans on two facts. Convex mutations are serializable
 * transactions, so bumping `ydocs.seq` in `append` makes sequence numbers
 * dense without locks — and makes the compactor race-free, because a compact
 * and an append conflict on the same row and one of them simply retries. And
 * Yjs update application is commutative and idempotent, so `seq` is only ever
 * a fetch cursor: applying an update twice, or one already folded into a
 * newer snapshot, is a no-op. Correctness never depends on delivery order.
 *
 * Access control is exactly the legacy pipeline's: `checkRead` / `checkWrite`
 * from `prosemirror.ts`, so a share link admits the same readers and an
 * editor role admits the same writers on both pipelines.
 */

/** Fold the log into a fresh snapshot once it holds this many updates. */
const COMPACT_EVERY = 200;
/** Snapshot chunk size, safely under Convex's 1MiB value cap. */
const CHUNK_BYTES = 800 * 1024;
/**
 * What one read of the log may weigh. A function that reads past 16MiB is
 * killed by the platform, and an update row now holds up to 800KiB of a
 * chunked value — so a page of the log has to be measured in BYTES, not rows:
 * twenty of them is a dead query, and counting rows cannot see that coming.
 * Both readers below stop at a whole update, never inside a chunk group.
 */
const READ_BUDGET = 6 * 1024 * 1024;
/** A backstop for logs of tiny updates, where bytes alone would never stop. */
const MAX_ROWS = 500;
/** How coarsely `append` stamps pages.updatedAt (the debounce lives here now). */
const TOUCH_EVERY_MS = 30_000;

/** True at the last row of an update — a whole one, or a chunk group's end. */
function endsUpdate(row: Doc<"yUpdates">): boolean {
  return row.parts === undefined || row.part === row.parts - 1;
}

async function ydocRow(ctx: { db: QueryCtx["db"] }, docId: string) {
  return await ctx.db
    .query("ydocs")
    .withIndex("by_doc", (q) => q.eq("docId", docId))
    .unique();
}

/**
 * Which pipeline a doc lives on. "empty" means neither has content — a page
 * that was created but never opened — and the client may `init` it directly.
 */
export const state = query({
  args: { docId: v.string() },
  returns: v.union(v.literal("yjs"), v.literal("legacy"), v.literal("empty")),
  handler: async (ctx, args) => {
    await checkRead(ctx, args.docId);
    if (await ydocRow(ctx, args.docId)) return "yjs";
    const legacy: number | null = await ctx.runQuery(
      components.prosemirrorSync.lib.latestVersion,
      { id: args.docId },
    );
    return legacy === null ? "empty" : "legacy";
  },
});

/**
 * The version channel: the one small reactive read every client subscribes
 * to. A change in `seq` is the wake-up; everything heavy is fetched by
 * cursor, non-reactively, from `snapshot` and `updatesSince`.
 */
export const meta = query({
  args: { docId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      seq: v.number(),
      snapshotSeq: v.number(),
      snapshotParts: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await checkRead(ctx, args.docId);
    const row = await ydocRow(ctx, args.docId);
    if (!row) return null;
    return {
      seq: row.seq,
      snapshotSeq: row.snapshotSeq,
      snapshotParts: row.snapshotParts,
    };
  },
});

export const snapshot = query({
  args: { docId: v.string(), gen: v.number(), part: v.number() },
  returns: v.union(v.null(), v.bytes()),
  handler: async (ctx, args) => {
    await checkRead(ctx, args.docId);
    const chunk = await ctx.db
      .query("ySnapshots")
      .withIndex("by_doc_and_gen_and_part", (q) =>
        q.eq("docId", args.docId).eq("gen", args.gen).eq("part", args.part),
      )
      .unique();
    return chunk?.data ?? null;
  },
});

/**
 * The log after a cursor, oldest first, bounded by weight — the caller loops
 * until its cursor reaches `meta.seq`, so a page may be as short as one
 * update. Reading past a fold is harmless (see module note).
 */
export const updatesSince = query({
  args: { docId: v.string(), afterSeq: v.number() },
  returns: v.array(
    v.object({
      seq: v.number(),
      update: v.bytes(),
      part: v.optional(v.number()),
      parts: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    await checkRead(ctx, args.docId);
    // Walked rather than taken, so the page can be closed on weight the
    // moment it is heavy enough — and only ever at the end of a whole update,
    // so a chunk group is never torn across the boundary.
    const rows: Doc<"yUpdates">[] = [];
    let bytes = 0;
    for await (const row of ctx.db
      .query("yUpdates")
      .withIndex("by_doc_and_seq", (q) =>
        q.eq("docId", args.docId).gt("seq", args.afterSeq),
      )) {
      rows.push(row);
      bytes += row.update.byteLength;
      if (!endsUpdate(row)) continue;
      if (bytes >= READ_BUDGET || rows.length >= MAX_ROWS) break;
    }
    return rows.map((r) => ({
      seq: r.seq,
      update: r.update,
      ...(r.part !== undefined ? { part: r.part } : {}),
      ...(r.parts !== undefined ? { parts: r.parts } : {}),
    }));
  },
});

/**
 * One client flush: a merged Yjs update appended to the log. Returns the seq
 * it landed at, so the sender can advance its own cursor without waiting to
 * hear its update back.
 */
export const append = mutation({
  args: {
    docId: v.string(),
    update: v.optional(v.bytes()),
    /**
     * The same update, pre-split by `yshape.splitUpdate` when it would not
     * fit one row. All parts in ONE call, so the group is transactionally
     * whole — a reader can never see half an update. Exactly one of
     * `update`/`chunks` is given.
     */
    chunks: v.optional(v.array(v.bytes())),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    await checkWrite(ctx, args.docId);
    const row = await ydocRow(ctx, args.docId);
    if (!row) throw new Error("Not a Yjs document");
    const chunks =
      args.chunks ?? (args.update !== undefined ? [args.update] : []);
    if (!chunks.length) throw new Error("Nothing to append");
    const seq = row.seq + 1;
    for (let part = 0; part < chunks.length; part++) {
      await ctx.db.insert("yUpdates", {
        docId: args.docId,
        seq,
        update: chunks[part],
        ...(chunks.length > 1 ? { part, parts: chunks.length } : {}),
      });
    }
    const now = Date.now();
    await ctx.db.patch(row._id, { seq, updatedAt: now });

    // The same coarse edited-stamp the legacy pipeline hung on snapshots.
    const page = await pageForDoc(ctx, args.docId);
    if (page && now - (page.updatedAt ?? 0) > TOUCH_EVERY_MS) {
      await ctx.db.patch(page._id, { updatedAt: now });
    }

    // Modulo rather than >=, so one threshold crossing schedules one compact
    // even while further appends land before it runs.
    const pending = seq - row.snapshotSeq;
    if (pending > 0 && pending % COMPACT_EVERY === 0) {
      await ctx.scheduler.runAfter(0, internal.ydoc.compact, {
        docId: args.docId,
        targetSeq: seq,
      });
    }
    return seq;
  },
});

/**
 * Makes a doc Yjs-native, first writer wins: the row's existence is the whole
 * guard, and the loser is told rather than failed — it discards its local doc
 * and syncs the winner's. The initial state rides as update #1; the first
 * compaction folds it like any other.
 */
export const init = mutation({
  args: {
    docId: v.string(),
    update: v.bytes(),
    /** The legacy version this doc was converted from, absent for new docs. */
    legacyVersion: v.optional(v.number()),
  },
  returns: v.object({ migrated: v.boolean() }),
  handler: async (ctx, args) => {
    await checkWrite(ctx, args.docId);
    if (await ydocRow(ctx, args.docId)) return { migrated: false };
    await ctx.db.insert("ydocs", {
      docId: args.docId,
      seq: 1,
      snapshotSeq: 0,
      snapshotParts: 0,
      migratedFromVersion: args.legacyVersion,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("yUpdates", {
      docId: args.docId,
      seq: 1,
      update: args.update,
    });
    return { migrated: true };
  },
});

/**
 * Registers a brand-new page's doc as Yjs-native before any client has state
 * to `init` with. A helper, not a mutation: only `pages.create` (which has
 * already authorized the project) may call it.
 */
export async function registerYDoc(ctx: MutationCtx, docId: string) {
  await ctx.db.insert("ydocs", {
    docId,
    seq: 0,
    snapshotSeq: 0,
    snapshotParts: 0,
    updatedAt: Date.now(),
  });
}

/**
 * Folds the log into a fresh snapshot. A mutation on purpose: transactional
 * isolation is what erases the compactor/writer race, and yjs is pure JS
 * that runs fine in the default runtime. GC happens by construction — a doc
 * rebuilt from updates and re-encoded drops tombstoned content the raw
 * update concatenation would keep.
 */
export const compact = internalMutation({
  args: { docId: v.string(), targetSeq: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ydocRow(ctx, args.docId);
    if (!row || args.targetSeq <= row.snapshotSeq) return null;

    const oldChunks =
      row.snapshotParts > 0
        ? await ctx.db
            .query("ySnapshots")
            .withIndex("by_doc_and_gen_and_part", (q) =>
              q.eq("docId", args.docId).eq("gen", row.snapshotSeq),
            )
            .collect()
        : [];
    // As much of the log as fits beside the old snapshot, no more: a doc whose
    // updates outweigh one read is folded over several passes, each one a
    // whole transaction that leaves a usable snapshot behind. Folding all of
    // it at once is what a big storyboard's log cannot survive.
    //
    // The budget is checked BEFORE a group joins the fold, and everything read
    // here is also deleted below — a delete reads the row it removes, so the
    // true cost of a pass is twice this. `READ_BUDGET` is set so that doubling
    // still clears the platform's ceiling with room over.
    const oldBytes = oldChunks.reduce((n, c) => n + c.data.byteLength, 0);
    const folded: Doc<"yUpdates">[] = [];
    if (oldBytes >= READ_BUDGET) {
      // The state alone outweighs a pass. Nothing safe to do — and nothing
      // broken by leaving it: readers page through the log as they always do.
      console.warn(
        `ydoc: ${args.docId} holds a ${oldBytes}-byte snapshot; too heavy to fold`,
      );
      return null;
    }
    let bytes = oldBytes;
    let group: Doc<"yUpdates">[] = [];
    let groupBytes = 0;
    for await (const update of ctx.db
      .query("yUpdates")
      .withIndex("by_doc_and_seq", (q) =>
        q.eq("docId", args.docId).gt("seq", row.snapshotSeq),
      )) {
      if (update.seq > args.targetSeq) break;
      group.push(update);
      groupBytes += update.update.byteLength;
      if (!endsUpdate(update)) continue;
      if (bytes + groupBytes > READ_BUDGET) break;
      folded.push(...group);
      bytes += groupBytes;
      group = [];
      groupBytes = 0;
    }
    // Not one update fits beside the state: same answer as above, and the
    // same reason it is safe.
    if (!folded.length) return null;
    // The fold reaches as far as it read, which may be short of the target —
    // the rest is another pass's work, scheduled below.
    const reached = folded[folded.length - 1].seq;

    const doc = new Y.Doc({ gc: true });
    // The old snapshot's chunks are byte slices of ONE encoded update —
    // rejoined before applying, half of one is not a smaller snapshot.
    const ordered = [...oldChunks].sort((a, b) => a.part - b.part);
    if (ordered.length) {
      const whole = new Uint8Array(ordered.reduce((n, c) => n + c.data.byteLength, 0));
      let at = 0;
      for (const chunk of ordered) {
        whole.set(new Uint8Array(chunk.data), at);
        at += chunk.data.byteLength;
      }
      Y.applyUpdate(doc, whole);
    }
    // Joined before applying: a chunked update's rows are byte slices, not
    // updates, and half of one is not a smaller edit — it is garbage.
    for (const u of joinUpdateRows(folded)) {
      Y.applyUpdate(doc, u.update);
    }
    const encoded = Y.encodeStateAsUpdate(doc);
    doc.destroy();

    const parts = Math.max(1, Math.ceil(encoded.byteLength / CHUNK_BYTES));
    for (let part = 0; part < parts; part++) {
      const slice = encoded.slice(part * CHUNK_BYTES, (part + 1) * CHUNK_BYTES);
      await ctx.db.insert("ySnapshots", {
        docId: args.docId,
        gen: reached,
        part,
        data: slice.buffer.slice(
          slice.byteOffset,
          slice.byteOffset + slice.byteLength,
        ),
      });
    }
    await Promise.all(oldChunks.map((c) => ctx.db.delete(c._id)));
    await Promise.all(folded.map((u) => ctx.db.delete(u._id)));
    await ctx.db.patch(row._id, {
      snapshotSeq: reached,
      snapshotParts: parts,
    });
    // Still behind: carry on in a fresh transaction, from the snapshot this
    // pass just wrote. A reader arriving between passes sees a whole doc.
    if (reached < args.targetSeq) {
      await ctx.scheduler.runAfter(0, internal.ydoc.compact, {
        docId: args.docId,
        targetSeq: args.targetSeq,
      });
    }
    return null;
  },
});
