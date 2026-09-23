import type { ResolutionWrite } from "./resolve";
import type { CommentAnchor } from "./types";

/**
 * What resolving a thread's anchor asks the comments document to remember —
 * the one contract between the resolver and the store that persists it.
 *
 * - `anchor`: fields to overwrite — `exact` (and its context) rewritten by a
 *   fuzzy hit, `blockId` re-homed by a document-wide one.
 * - `ambiguous`: `true` when the quotation matched more than once, `false`
 *   to clear it.
 * - `orphanedAt`: a time to mark the thread as resolving nowhere, `null` to
 *   clear the mark once it resolves again.
 *
 * Absent fields are left alone, and an empty write is no write at all.
 */
export type AnchorWrite = {
  anchor?: Partial<CommentAnchor>;
  ambiguous?: boolean;
  orphanedAt?: number | null;
};

/**
 * The store's form of a resolver's writes. The resolver says only whether the
 * thread is orphaned so every client's answer is identical; the time is
 * stamped here, and the store keeps the first stamp it ever saw.
 */
export function persistable(writes: ResolutionWrite, now: number): AnchorWrite {
  const out: AnchorWrite = {};
  if (writes.anchor !== undefined) out.anchor = writes.anchor;
  if (writes.ambiguous !== undefined) out.ambiguous = writes.ambiguous;
  if (writes.orphaned !== undefined) out.orphanedAt = writes.orphaned ? now : null;
  return out;
}
