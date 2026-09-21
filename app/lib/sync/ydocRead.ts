import type { ConvexReactClient } from "convex/react";
import { api } from "@/convex/_generated/api";
import { joinUpdateRows } from "@/convex/yshape";

/**
 * Reassembling a stored Y.Doc — the one definition of the wire protocol's read
 * half, shared by the editor's provider, the thumbnail reader and the AI's
 * `read_page`.
 *
 * It exists because the pieces are SLICES, not updates. A snapshot generation is
 * one encoded update cut into rows, and an oversized log entry is the same
 * (`yshape`); applied one at a time they parse as garbage. That bug stayed
 * latent until documents grew big enough to be stored in parts, and every reader
 * that reimplements the join is a place it can come back.
 */

type YClient = Pick<ConvexReactClient, "query">;

export type YDocMeta = { snapshotSeq: number; snapshotParts: number };

/**
 * A snapshot generation as the single update it was cut from.
 *
 * `null` when the generation is gone — a newer fold replaced it mid-read — or
 * when there is no snapshot at all. Nothing has been applied in that case, so
 * the caller re-reads from fresh meta rather than applying a torn document.
 *
 * Chunks are fetched together: the part count is known upfront, and a document
 * past one chunk should not cost a round trip per 800KiB of itself.
 */
export async function fetchSnapshotUpdate(
  client: YClient,
  docId: string,
  meta: YDocMeta,
): Promise<Uint8Array | null> {
  if (meta.snapshotParts <= 0) return null;
  const fetched = await Promise.all(
    Array.from({ length: meta.snapshotParts }, (_, part) =>
      client.query(api.ydoc.snapshot, { docId, gen: meta.snapshotSeq, part }),
    ),
  );
  if (fetched.some((chunk) => chunk === null)) return null;
  return joinChunks(fetched as ArrayBuffer[]);
}

/**
 * Pages the update log after `afterSeq`, handing each whole update to `apply`,
 * and answers with the seq reached.
 *
 * Stops as soon as a page cannot be consumed to its last row: that means its
 * trailing multi-row update is still being written, and re-asking would return
 * the same incomplete group forever.
 */
export async function applyUpdatesSince(
  client: YClient,
  docId: string,
  afterSeq: number,
  apply: (update: Uint8Array) => void,
): Promise<number> {
  let cursor = afterSeq;
  for (;;) {
    const rows = await client.query(api.ydoc.updatesSince, {
      docId,
      afterSeq: cursor,
    });
    if (!rows.length) return cursor;
    for (const row of joinUpdateRows(rows)) {
      apply(row.update);
      cursor = Math.max(cursor, row.seq);
    }
    if (cursor < rows[rows.length - 1].seq) return cursor;
  }
}

function joinChunks(chunks: readonly ArrayBuffer[]): Uint8Array {
  const whole = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    whole.set(new Uint8Array(chunk), at);
    at += chunk.byteLength;
  }
  return whole;
}

/**
 * Brings a holder of `cursor` up to the stored document, in one round trip
 * wherever the document allows it: `ydoc.load` answers with the snapshot and
 * the log together, and only a document too heavy for that is fetched the
 * long way — its snapshot by chunk, its log by page.
 *
 * Null when the document has no Yjs row. `torn` means a fold replaced the
 * snapshot generation mid-read: nothing of it was applied, the cursor has not
 * moved, and the caller reads again rather than applying the tail alone.
 */
export async function openYDoc(
  client: YClient,
  docId: string,
  cursor: number,
  apply: (update: Uint8Array) => void,
): Promise<{ seq: number; cursor: number; torn: boolean } | null> {
  const loaded = await client.query(api.ydoc.load, { docId, afterSeq: cursor });
  if (!loaded) return null;
  if (cursor < loaded.snapshotSeq && loaded.snapshotParts > 0) {
    const snapshot = loaded.snapshot
      ? joinChunks(loaded.snapshot)
      : await fetchSnapshotUpdate(client, docId, loaded);
    if (!snapshot) return { seq: loaded.seq, cursor, torn: true };
    apply(snapshot);
    cursor = loaded.snapshotSeq;
  }
  for (const row of joinUpdateRows(loaded.updates)) {
    apply(row.update);
    cursor = Math.max(cursor, row.seq);
  }
  if (cursor < loaded.seq) {
    cursor = await applyUpdatesSince(client, docId, cursor, apply);
  }
  return { seq: loaded.seq, cursor, torn: false };
}

/**
 * A whole stored document, snapshot first and then the tail, for a caller that
 * reads once and is done. Empty when the document has no Yjs row yet.
 *
 * Re-read when a fold replaces the generation mid-read: the tail alone is not
 * the document, and half of one is worse than another round trip. The loop
 * only turns when a compaction lands inside it.
 */
export async function readYDocUpdates(
  client: YClient,
  docId: string,
): Promise<Uint8Array[]> {
  for (;;) {
    const updates: Uint8Array[] = [];
    const opened = await openYDoc(client, docId, 0, (update) => updates.push(update));
    if (!opened) return [];
    if (!opened.torn) return updates;
  }
}
