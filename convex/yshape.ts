/**
 * How an oversized Yjs update travels — pure byte arithmetic, no imports, so
 * the browser provider, the page readers and the server compactor all share
 * one definition (the `operations.ts` bargain, for sync).
 *
 * A drawn storyboard lands in the document as one string inside one Y
 * transaction, so its update is one value — measured past 2MiB, over Convex's
 * 1MiB ceiling, and an append that big failed forever on the provider's retry
 * loop: the accepted board simply never reached the server. Updates too big
 * for one row are split into parts and written IN ONE MUTATION, so a group is
 * transactionally all-or-nothing and readers never see a torn update. Rows
 * without `parts` are whole — every update written before this existed reads
 * exactly as it always did.
 */

/** Stay well inside the 1MiB value ceiling; row overhead rides on top. */
export const UPDATE_CHUNK_BYTES = 800_000;

export type UpdateRow = {
  seq: number;
  update: ArrayBuffer;
  part?: number;
  parts?: number;
};

/** An update as the byte slices `append` stores — one entry per row. */
export function splitUpdate(update: Uint8Array): ArrayBuffer[] {
  if (update.byteLength <= UPDATE_CHUNK_BYTES) {
    return [
      update.buffer.slice(
        update.byteOffset,
        update.byteOffset + update.byteLength,
      ) as ArrayBuffer,
    ];
  }
  const out: ArrayBuffer[] = [];
  for (let at = 0; at < update.byteLength; at += UPDATE_CHUNK_BYTES) {
    const slice = update.slice(at, at + UPDATE_CHUNK_BYTES);
    out.push(
      slice.buffer.slice(
        slice.byteOffset,
        slice.byteOffset + slice.byteLength,
      ) as ArrayBuffer,
    );
  }
  return out;
}

/**
 * Rows back into whole updates, in seq order. Parts of one update share a seq
 * and are contiguous — they were written in one transaction — so grouping is
 * a single pass. A group somehow missing parts is dropped rather than applied
 * torn: a missing update is recoverable by a later pull, a corrupt one is not.
 */
export function joinUpdateRows(
  rows: readonly UpdateRow[],
): { seq: number; update: Uint8Array }[] {
  const out: { seq: number; update: Uint8Array }[] = [];
  for (let i = 0; i < rows.length; ) {
    const row = rows[i];
    if (!row.parts || row.parts <= 1) {
      out.push({ seq: row.seq, update: new Uint8Array(row.update) });
      i++;
      continue;
    }
    const group = rows
      .slice(i, i + row.parts)
      .filter((r) => r.seq === row.seq)
      .sort((a, b) => (a.part ?? 0) - (b.part ?? 0));
    i += group.length;
    if (group.length !== row.parts) continue;
    const total = group.reduce((sum, r) => sum + r.update.byteLength, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const r of group) {
      joined.set(new Uint8Array(r.update), at);
      at += r.update.byteLength;
    }
    out.push({ seq: row.seq, update: joined });
  }
  return out;
}
