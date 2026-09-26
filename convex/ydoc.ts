import { internalMutation, mutation, query } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import * as Y from "yjs";
import { components, internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { recordDocumentEdit } from "./audit";
import { moderatesComments, ownerId, type ProjectRole } from "./auth";
import { ANY_CHANNEL, checkAppend, checkRead, checkWrite, pageForDoc } from "./prosemirror";
import { COMMENTS_REFUSED, refuseCommentsUpdate } from "@/app/lib/comments/policy";
import { stampProject } from "./projects";
import { joinUpdateRows, UPDATE_CHUNK_BYTES } from "./yshape";

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
 * editor role admits the same writers on both pipelines. This log is the one
 * pipeline that also carries a page's comments document, so it asks the gate
 * for both channels, and the gate applies each channel's own rule. A page's
 * update is never looked inside; a comments update is, because a commenter's
 * bytes could otherwise sign someone else's name (`comments/policy.ts`).
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
/**
 * The heaviest snapshot `load` carries inline. Half the budget, so the log
 * that rides with it always has room for a real page of itself.
 */
const LOAD_SNAPSHOT_BYTES = READ_BUDGET / 2;
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
    const { page, channel } = await checkRead(ctx, args.docId, ANY_CHANNEL);
    // A comments document is born on Yjs by `comments.ensureDoc` and never had
    // a legacy pipeline to ask about; `page.yjs` is the page document's flag.
    if (channel === "comments") {
      return (await ydocRow(ctx, args.docId)) ? "yjs" : "empty";
    }
    // The page's own flag first: this query is subscribed to for the life of
    // every open editor, and the `ydocs` row it would otherwise read is
    // rewritten by every flush — an invalidation twice a second for an answer
    // that changes once in a document's life. `append` stamps the flag.
    if (page.yjs) return "yjs";
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
    await checkRead(ctx, args.docId, ANY_CHANNEL);
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
    await checkRead(ctx, args.docId, ANY_CHANNEL);
    const chunk = await ctx.db
      .query("ySnapshots")
      .withIndex("by_doc_and_gen_and_part", (q) =>
        q.eq("docId", args.docId).eq("gen", args.gen).eq("part", args.part),
      )
      .unique();
    return chunk?.data ?? null;
  },
});

const updateRow = v.object({
  seq: v.number(),
  update: v.bytes(),
  part: v.optional(v.number()),
  parts: v.optional(v.number()),
});

/**
 * The log after a cursor, oldest first, closed on weight. Walked rather than
 * taken, so the page can be closed the moment it is heavy enough — and only
 * ever at the end of a whole update, so a chunk group is never torn across
 * the boundary.
 */
async function readLog(
  ctx: QueryCtx,
  docId: string,
  afterSeq: number,
  budget: number,
) {
  const rows: Doc<"yUpdates">[] = [];
  let bytes = 0;
  for await (const row of ctx.db
    .query("yUpdates")
    .withIndex("by_doc_and_seq", (q) => q.eq("docId", docId).gt("seq", afterSeq))) {
    rows.push(row);
    bytes += row.update.byteLength;
    if (!endsUpdate(row)) continue;
    if (bytes >= budget || rows.length >= MAX_ROWS) break;
  }
  return rows.map((r) => ({
    seq: r.seq,
    update: r.update,
    ...(r.part !== undefined ? { part: r.part } : {}),
    ...(r.parts !== undefined ? { parts: r.parts } : {}),
  }));
}

/**
 * The log after a cursor, oldest first, bounded by weight — the caller loops
 * until its cursor reaches `meta.seq`, so a page may be as short as one
 * update. Reading past a fold is harmless (see module note).
 */
export const updatesSince = query({
  args: { docId: v.string(), afterSeq: v.number() },
  returns: v.array(updateRow),
  handler: async (ctx, args) => {
    await checkRead(ctx, args.docId, ANY_CHANNEL);
    return await readLog(ctx, args.docId, args.afterSeq, READ_BUDGET);
  },
});

/**
 * Opening a document in one round trip: `meta`, the snapshot if the caller is
 * behind it, and the first page of the log after that.
 *
 * The three were separate queries asked in a row, and a row of queries is
 * what opening a page costs — measured, the server's work and the bytes are
 * noise beside the round trips. A typical document is a few kilobytes, so
 * nearly every open ends here; `snapshot` and `updatesSince` remain for the
 * documents that do not fit and for the log a long-open tab keeps paging.
 *
 * `snapshot` is null both when the caller does not need one and when it is
 * too heavy to ride along — the caller tells them apart by its own cursor,
 * and fetches a heavy one by chunk the way it always has. No log rides with
 * a heavy snapshot either: the two together are what would cross the read
 * ceiling.
 */
export const load = query({
  args: { docId: v.string(), afterSeq: v.number() },
  returns: v.union(
    v.null(),
    v.object({
      seq: v.number(),
      snapshotSeq: v.number(),
      snapshotParts: v.number(),
      snapshot: v.union(v.null(), v.array(v.bytes())),
      updates: v.array(updateRow),
    }),
  ),
  handler: async (ctx, args) => {
    await checkRead(ctx, args.docId, ANY_CHANNEL);
    const row = await ydocRow(ctx, args.docId);
    if (!row) return null;
    const meta = {
      seq: row.seq,
      snapshotSeq: row.snapshotSeq,
      snapshotParts: row.snapshotParts,
    };

    let from = args.afterSeq;
    let snapshot: ArrayBuffer[] | null = null;
    let weight = 0;
    if (args.afterSeq < row.snapshotSeq && row.snapshotParts > 0) {
      const heavy = { ...meta, snapshot: null, updates: [] };
      if ((row.snapshotBytes ?? 0) > LOAD_SNAPSHOT_BYTES) return heavy;
      snapshot = [];
      // Index order is part order, so the chunks arrive ready to join.
      for await (const chunk of ctx.db
        .query("ySnapshots")
        .withIndex("by_doc_and_gen_and_part", (q) =>
          q.eq("docId", args.docId).eq("gen", row.snapshotSeq),
        )) {
        snapshot.push(chunk.data);
        weight += chunk.data.byteLength;
        if (weight > LOAD_SNAPSHOT_BYTES) return heavy;
      }
      // A fold replacing the generation mid-read cannot happen inside one
      // transaction; a short count means the row and its chunks disagree.
      if (snapshot.length !== row.snapshotParts) return heavy;
      from = row.snapshotSeq;
    }
    return {
      ...meta,
      snapshot,
      updates: await readLog(ctx, args.docId, from, READ_BUDGET - weight),
    };
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
    const access = await checkAppend(ctx, args.docId, ANY_CHANNEL);
    const chunks =
      args.chunks ?? (args.update !== undefined ? [args.update] : []);
    if (access.channel === "comments") {
      await judgeCommentsUpdate(ctx, args.docId, chunks, access.role);
    }
    const seq = await appendYUpdate(ctx, args.docId, chunks);
    // Here rather than in `appendYUpdate`, which the migrators share: this
    // is the one place a flush is known to be a person's. A comments append is
    // no edit of the page; its events are the notices' (`commentNotices`).
    if (access.channel === "document") await recordDocumentEdit(ctx, access);
    return seq;
  },
});

function joinBytes(parts: readonly ArrayBuffer[]): Uint8Array {
  const whole = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(new Uint8Array(part), at);
    at += part.byteLength;
  }
  return whole;
}

/** The chunks of a row's current snapshot, in part order (the index's). */
async function readSnapshot(ctx: QueryCtx, row: Doc<"ydocs">) {
  if (row.snapshotParts === 0) return [];
  return await ctx.db
    .query("ySnapshots")
    .withIndex("by_doc_and_gen_and_part", (q) =>
      q.eq("docId", row.docId).eq("gen", row.snapshotSeq),
    )
    .collect();
}

/**
 * Refuses, with nothing written, a comments append that `comments/policy.ts`
 * says may not land: the update is applied to the document as stored and the
 * states before and after are compared. A comments document is small and
 * folds every {@link COMPACT_EVERY} appends, so all of it is read; one past
 * the read budget is refused rather than judged on part of itself.
 */
async function judgeCommentsUpdate(
  ctx: MutationCtx,
  docId: string,
  chunks: ArrayBuffer[],
  role: ProjectRole | null,
) {
  const refused = (message: string) => new ConvexError({ code: COMMENTS_REFUSED, message });
  const userId = await ownerId(ctx);
  const row = await ydocRow(ctx, docId);
  if (!userId || !row) throw new Error("Not found");
  const snapshot = await readSnapshot(ctx, row);
  let bytes = snapshot.reduce((n, c) => n + c.data.byteLength, 0);
  const log: Doc<"yUpdates">[] = [];
  for await (const update of ctx.db
    .query("yUpdates")
    .withIndex("by_doc_and_seq", (q) => q.eq("docId", docId).gt("seq", row.snapshotSeq))) {
    log.push(update);
    bytes += update.update.byteLength;
    if (bytes > READ_BUDGET) throw refused("These comments are too large to change.");
  }
  const state = [
    ...(snapshot.length ? [joinBytes(snapshot.map((c) => c.data))] : []),
    ...joinUpdateRows(log).map((u) => u.update),
  ];
  const refusal = refuseCommentsUpdate(state, joinBytes(chunks), {
    userId,
    moderator: moderatesComments(role),
  });
  if (refusal) throw refused(refusal.message);
}

/**
 * The append itself, after authorization: one merged update (already split
 * into row-sized chunks) landed at the next dense seq, with the page-stamp and
 * compaction bookkeeping. Factored out so the step-12 elected migrator writes
 * the canonical NML root through the exact same wire path an ordinary flush
 * uses — the NML root then rides the same snapshot/compaction/provider
 * machinery with no second sync channel. Callers own authorization first.
 *
 * A `quiet` append is nobody's edit — a server rewriting stored form — so it
 * leaves the page's and the project's edited stamps where they were.
 */
export async function appendYUpdate(
  ctx: MutationCtx,
  docId: string,
  chunks: ArrayBuffer[],
  opts: { quiet?: boolean } = {},
): Promise<number> {
  const row = await ydocRow(ctx, docId);
  if (!row) throw new Error("Not a Yjs document");
  if (!chunks.length) throw new Error("Nothing to append");
  const seq = row.seq + 1;
  for (let part = 0; part < chunks.length; part++) {
    await ctx.db.insert("yUpdates", {
      docId,
      seq,
      update: chunks[part],
      ...(chunks.length > 1 ? { part, parts: chunks.length } : {}),
    });
  }
  const now = Date.now();
  await ctx.db.patch(row._id, { seq, updatedAt: now });

  // The same coarse edited-stamp the legacy pipeline hung on snapshots, plus
  // the pipeline flag `state` reads — stamped here rather than in `init`
  // because docs that migrated before the flag existed would never get it.
  // A comments document matches no page here (`pageForDoc` is the document
  // channel), so a thread written is not the page edited.
  const page = await pageForDoc(ctx, docId);
  if (page) {
    const touched = !opts.quiet && now - (page.updatedAt ?? 0) > TOUCH_EVERY_MS;
    if (touched || !page.yjs) {
      await ctx.db.patch(page._id, {
        ...(touched ? { updatedAt: now } : {}),
        ...(page.yjs ? {} : { yjs: true }),
      });
    }
    if (touched) await stampProject(ctx, page.projectId, now);
  }

  // Modulo rather than >=, so one threshold crossing schedules one compact
  // even while further appends land before it runs.
  const pending = seq - row.snapshotSeq;
  if (pending > 0 && pending % COMPACT_EVERY === 0) {
    if ((row.snapshotBytes ?? 0) >= READ_BUDGET) {
      // `compact` would read the whole snapshot only to find it too heavy to
      // fold. Said here instead, where the doc is still being written to, so
      // a document growing past what the fold can carry is visible rather
      // than silently accumulating log forever.
      console.warn(
        `ydoc: ${docId} holds a ${row.snapshotBytes}-byte snapshot; its log no longer folds`,
      );
    } else {
      await ctx.scheduler.runAfter(0, internal.ydoc.compact, {
        docId,
        targetSeq: seq,
      });
    }
  }
  return seq;
}

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
    // The document channel only: a comments document is born with its root
    // already in it (`comments.ensureDoc`), so no client ever races to init one.
    await checkWrite(ctx, args.docId);
    const row = await ydocRow(ctx, args.docId);
    if (row && row.seq > 0) return { migrated: false };
    const born = {
      seq: 1,
      migratedFromVersion: args.legacyVersion,
      updatedAt: Date.now(),
    };
    // A page born on Yjs (`pages.create`) holds its row with nothing written
    // yet, and the first writer still wins it — how an import fills its page.
    if (row) await ctx.db.patch(row._id, born);
    else await ctx.db.insert("ydocs", { docId: args.docId, snapshotSeq: 0, snapshotParts: 0, ...born });
    await ctx.db.insert("yUpdates", {
      docId: args.docId,
      seq: 1,
      update: args.update,
    });
    // The flag `state` and the editor read, stamped at birth: left to the
    // first `append`, a page that is opened but never edited goes without it.
    const page = await pageForDoc(ctx, args.docId);
    if (page && !page.yjs) await ctx.db.patch(page._id, { yjs: true });
    return { migrated: true };
  },
});

/**
 * Registers a brand-new doc as Yjs-native before any client has state to
 * `init` with, optionally born holding `initial` as update #1 — which is how a
 * document whose root must exist exactly once gets it without two clients
 * racing to write it. A helper, not a mutation: callers have authorized the
 * page first (`comments.ensureDoc`).
 */
export async function registerYDoc(
  ctx: MutationCtx,
  docId: string,
  initial?: ArrayBuffer,
) {
  await ctx.db.insert("ydocs", {
    docId,
    seq: initial ? 1 : 0,
    snapshotSeq: 0,
    snapshotParts: 0,
    updatedAt: Date.now(),
  });
  if (initial) await ctx.db.insert("yUpdates", { docId, seq: 1, update: initial });
}

/**
 * Deletes a document's every row — snapshot chunks, log, then the `ydocs` row
 * itself — once whatever named it is gone. One bite per transaction, measured
 * in bytes as the readers are (a delete reads the row it removes), and
 * rescheduled until nothing is left. Callers schedule it from their own purge.
 */
export const purge = internalMutation({
  args: { docId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    let bytes = 0;
    const doomed: Array<Id<"ySnapshots"> | Id<"yUpdates">> = [];
    const room = () => bytes < READ_BUDGET && doomed.length < MAX_ROWS;
    for await (const chunk of ctx.db
      .query("ySnapshots")
      .withIndex("by_doc_and_gen_and_part", (q) => q.eq("docId", args.docId))) {
      if (!room()) break;
      doomed.push(chunk._id);
      bytes += chunk.data.byteLength;
    }
    for await (const update of ctx.db
      .query("yUpdates")
      .withIndex("by_doc_and_seq", (q) => q.eq("docId", args.docId))) {
      if (!room()) break;
      doomed.push(update._id);
      bytes += update.update.byteLength;
    }
    await Promise.all(doomed.map((id) => ctx.db.delete(id)));
    if (!room()) {
      await ctx.scheduler.runAfter(0, internal.ydoc.purge, args);
      return null;
    }
    const row = await ydocRow(ctx, args.docId);
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

/**
 * A document's whole update history as raw bytes — the snapshot's joined
 * chunks, then every log update after it, in order — without building a
 * Y.Doc, and the `seq` it was read at. Rebuilding and decoding a document near
 * the size limits costs well over a hundred megabytes of heap, which an
 * isolate cannot hold, so that is left to the Node actions this feeds
 * (`nmlVerify.ts`, `diagramBand.ts`); reading bytes is cheap. `{ tooLarge }`
 * when the history outweighs one read, `null` when there is no such document
 * or its snapshot is torn.
 */
export async function readStoredUpdates(
  ctx: QueryCtx,
  docId: string,
): Promise<{ seq: number; updates: ArrayBuffer[] } | { tooLarge: true } | null> {
  const row = await ydocRow(ctx, docId);
  if (!row) return null;
  // Said by the row, so a snapshot too heavy to use is never read to find out.
  if ((row.snapshotBytes ?? 0) > READ_BUDGET) return { tooLarge: true };
  const updates: ArrayBuffer[] = [];
  let bytes = 0;
  if (row.snapshotParts > 0) {
    const chunks: ArrayBuffer[] = [];
    for await (const chunk of ctx.db
      .query("ySnapshots")
      .withIndex("by_doc_and_gen_and_part", (q) => q.eq("docId", docId).eq("gen", row.snapshotSeq))) {
      bytes += chunk.data.byteLength;
      if (bytes > READ_BUDGET) return { tooLarge: true };
      chunks.push(chunk.data);
    }
    // A short count means the row and its chunks disagree; half a snapshot is not a document.
    if (chunks.length !== row.snapshotParts) return null;
    updates.push(joinBytes(chunks).buffer as ArrayBuffer);
  }
  const log: Doc<"yUpdates">[] = [];
  for await (const update of ctx.db
    .query("yUpdates")
    .withIndex("by_doc_and_seq", (q) => q.eq("docId", docId).gt("seq", row.snapshotSeq))) {
    bytes += update.update.byteLength;
    if (bytes > READ_BUDGET) return { tooLarge: true };
    log.push(update);
  }
  for (const { update } of joinUpdateRows(log)) {
    updates.push(update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength) as ArrayBuffer);
  }
  return { seq: row.seq, updates };
}

/**
 * A document's whole stored state, rebuilt — for the rare server read that
 * must know what a document says rather than relay its bytes. Null when there
 * is no such document, or when snapshot and log together outweigh one read.
 */
export async function readYDoc(ctx: QueryCtx, docId: string): Promise<Y.Doc | null> {
  const stored = await readStoredUpdates(ctx, docId);
  if (!stored || "tooLarge" in stored) return null;
  const doc = new Y.Doc();
  for (const update of stored.updates) Y.applyUpdate(doc, new Uint8Array(update));
  return doc;
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

    const oldChunks = await readSnapshot(ctx, row);
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
      // Recorded so `append` can stop scheduling a pass whose only work is
      // reading this snapshot to reach this line.
      if (row.snapshotBytes !== oldBytes) {
        await ctx.db.patch(row._id, { snapshotBytes: oldBytes });
      }
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
      // A chunked update says how heavy it is on its first row: every part
      // but the last is a full chunk. Asked BEFORE the rest is read, because
      // reading is the cost — a 7MiB update read to be told it does not fit,
      // on top of a full budget and the deletes that re-read it, is what put
      // a pass over the platform's ceiling and left a log unable to fold.
      if (
        update.part === 0 &&
        update.parts !== undefined &&
        bytes + update.parts * UPDATE_CHUNK_BYTES > READ_BUDGET
      ) {
        break;
      }
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
    if (oldChunks.length) Y.applyUpdate(doc, joinBytes(oldChunks.map((c) => c.data)));
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
      snapshotBytes: encoded.byteLength,
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
