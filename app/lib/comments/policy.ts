import * as Y from "yjs";
import { NML_RECEIPTS_ROOT } from "@/app/lib/nml/commands";
import type { NmlCommentBlock, NmlCommentThreadBlock, NmlDocument } from "@/app/lib/nml/schema";
import { validateDocument } from "@/app/lib/nml/validate";
import { decodeNmlDocument, NML_YJS_ROOT, NML_YJS_STRUCTURE_KEY } from "@/app/lib/nml/yjs";

/**
 * What the server lets one append do to a comments document. The channel gate
 * decides who may write at all; this decides what their bytes may change,
 * judged on the document they would leave behind rather than on the update:
 *
 * - it still decodes and validates as the same comments document, holding no
 *   root but NML's and the executor's receipts;
 * - a comment is written under the writer's own name, and only its author
 *   changes it afterwards — nobody, owner included, rewrites another
 *   person's words;
 * - a comment or thread is removed by its author, or by whoever holds the pen
 *   (a moderator: owner or editor). A thread's author is its first comment's,
 *   and removing a thread removes its replies with it;
 * - whoever may remove something may put it back exactly as it was, which is
 *   what undoing a deletion writes;
 * - anyone may re-anchor, resolve or reopen a thread, but a resolution is
 *   stamped with the writer's own name — unless it puts back one the thread
 *   really had, which is what undoing a reopen writes.
 *
 * `thread_resolution` is the one validation issue let through: concurrent
 * resolve/reopen from honest replicas merge into it, and the store's repair
 * heals it on the next write.
 */

/** The `ConvexError` code of a refused comments append, which the provider does not retry. */
export const COMMENTS_REFUSED = "comments_refused";

export type CommentsRefusal = { code: typeof COMMENTS_REFUSED; message: string };

export type CommentsWriter = { userId: string; moderator: boolean };

const ROOTS: ReadonlySet<string> = new Set([NML_YJS_ROOT, NML_RECEIPTS_ROOT]);
const MERGE_ARTIFACT = "thread_resolution";

function refuse(message: string): CommentsRefusal {
  return { code: COMMENTS_REFUSED, message };
}

/** Kept un-collected, so what a key held before it was overwritten can still be read. */
function replay(state: readonly Uint8Array[]): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  for (const update of state) Y.applyUpdate(doc, update);
  return doc;
}

/**
 * Whether block `id`'s prop `key` held `value` before this update — now, or
 * before being overwritten — read off the key's item chain against the state
 * vector from before. Content a compaction has collected reads as never held.
 */
function heldBefore(doc: Y.Doc, known: Map<number, number>, id: string, key: string, value: unknown): boolean {
  const block = registryEntry(doc, id)?.content.getContent()[0];
  const props = block instanceof Y.Map ? block.get("props") : null;
  if (!(props instanceof Y.Map)) return false;
  for (let item = props._map.get(key) ?? null; item; item = item.left as Y.Item | null) {
    if (existedBefore(item, known) && item.content.getContent()[0] === value) return true;
  }
  return false;
}

/** The registry's item for block `id`: its content is the block's map. */
function registryEntry(doc: Y.Doc, id: string): Y.Item | null {
  const structure = doc.getMap(NML_YJS_ROOT).get(NML_YJS_STRUCTURE_KEY);
  const registry = structure instanceof Y.Map ? structure.get("registry") : null;
  return registry instanceof Y.Map ? (registry._map.get(id) ?? null) : null;
}

function existedBefore(item: Y.Item | null, known: Map<number, number>): boolean {
  return item !== null && item.id.clock < (known.get(item.id.client) ?? 0);
}

function decoded(doc: Y.Doc): NmlDocument | null {
  try {
    return decodeNmlDocument(doc);
  } catch {
    return null;
  }
}

/**
 * Every block the document has held, as last written: a removed block keeps
 * its content and only gains a deletion flag, so lifting the flags reads it.
 */
function everHeld(state: readonly Uint8Array[]): NmlDocument | null {
  const doc = replay(state);
  try {
    const structure = doc.getMap(NML_YJS_ROOT).get(NML_YJS_STRUCTURE_KEY);
    const deletions = structure instanceof Y.Map ? structure.get("deletions") : null;
    if (deletions instanceof Y.Map) deletions.clear();
    return decoded(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Why `update` may not land on the comments document `state` (the stored
 * updates, in order) holds, or null when it may.
 */
export function refuseCommentsUpdate(
  state: readonly Uint8Array[],
  update: Uint8Array,
  writer: CommentsWriter,
): CommentsRefusal | null {
  const doc = replay(state);
  try {
    const before = decoded(doc);
    if (before?.kind !== "comments") return refuse("This comments document cannot be read, so it cannot be written to.");
    const known = Y.decodeStateVector(Y.encodeStateVector(doc));
    try {
      Y.applyUpdate(doc, update);
    } catch {
      return refuse("That change is not a readable update.");
    }
    // Structs waiting on state the server lacks would land unjudged whenever it arrived.
    if (doc.store.pendingStructs || doc.store.pendingDs) {
      return refuse("That change depends on changes the server does not have.");
    }
    for (const name of doc.share.keys()) {
      if (!ROOTS.has(name)) return refuse("A comments document holds nothing but comments.");
    }
    const after = decoded(doc);
    if (after?.kind !== "comments" || after.documentId !== before.documentId) {
      return refuse("That change would leave the comments unreadable.");
    }
    const issue = validateDocument(after).find((candidate) => candidate.code !== MERGE_ARTIFACT);
    if (issue) return refuse(`That change would leave the comments invalid: ${issue.message}`);
    return refuseCommentsChange(before, after, writer, {
      blocks: () => everHeld(state),
      registered: (id) => existedBefore(registryEntry(doc, id), known),
      resolvedBy: (threadId, userId) => heldBefore(doc, known, threadId, "resolvedBy", userId),
    });
  } finally {
    doc.destroy();
  }
}

type Placed = { comment: NmlCommentBlock; threadId: string };
type Index = { threads: Map<string, NmlCommentThreadBlock>; comments: Map<string, Placed> };

function indexOf(document: NmlDocument | null): Index {
  const threads = new Map<string, NmlCommentThreadBlock>();
  const comments = new Map<string, Placed>();
  for (const block of document?.blocks ?? []) {
    if (block.type !== "commentThread") continue;
    threads.set(block.id, block);
    for (const child of block.children) {
      if (child.type === "comment") comments.set(child.id, { comment: child, threadId: block.id });
    }
  }
  return { threads, comments };
}

function firstComment(thread: NmlCommentThreadBlock): NmlCommentBlock | undefined {
  return thread.children.find((child): child is NmlCommentBlock => child.type === "comment");
}

/** Everything about a comment that is its author's to change — words, stamps, and which thread it is in. */
function fingerprint({ comment, threadId }: Placed): string {
  return JSON.stringify([threadId, comment.content, Object.entries(comment.props).sort(([a], [b]) => (a < b ? -1 : 1))]);
}

/** What the document held before, asked only when something comes back. */
export type CommentsPast = {
  /** Every block it has held, as last written — deleted ones included. */
  blocks: () => NmlDocument | null;
  /** Whether a block with this id existed before, live or deleted. */
  registered: (id: string) => boolean;
  /** Whether a thread was once resolved by `userId`. */
  resolvedBy: (threadId: string, userId: string) => boolean;
};

const NO_PAST: CommentsPast = { blocks: () => null, registered: () => false, resolvedBy: () => false };

/** The authorship rules, over two decoded states of one comments document. */
export function refuseCommentsChange(
  before: NmlDocument,
  after: NmlDocument,
  writer: CommentsWriter,
  past: CommentsPast = NO_PAST,
): CommentsRefusal | null {
  const was = indexOf(before);
  const now = indexOf(after);
  let held: Index | undefined;
  const ever = () => (held ??= indexOf(past.blocks()));
  const mine = (authorId: string | undefined) => authorId === writer.userId;
  /** A thread back from deletion that this writer could have deleted — judged by its author as it was, not as the update says. */
  const reinstated = (threadId: string) => {
    if (!now.threads.has(threadId) || was.threads.has(threadId)) return false;
    const past = ever().threads.get(threadId);
    return past !== undefined && (writer.moderator || mine(firstComment(past)?.props.authorId));
  };

  for (const [id, placed] of now.comments) {
    const prior = was.comments.get(id);
    if (!prior) {
      if (!past.registered(id)) {
        if (mine(placed.comment.props.authorId)) continue;
        return refuse("A comment can only be written in your own name.");
      }
      // Back from deletion: exactly as it was, by someone who could have removed it.
      const earlier = ever().comments.get(id);
      const restored = earlier !== undefined && fingerprint(earlier) === fingerprint(placed);
      const allowed = mine(earlier?.comment.props.authorId) || writer.moderator || reinstated(placed.threadId);
      if (!restored || !allowed) return refuse("A comment can only be written in your own name.");
    } else if (fingerprint(prior) !== fingerprint(placed)) {
      if (!mine(prior.comment.props.authorId) || !mine(placed.comment.props.authorId)) {
        return refuse("Only a comment's author can change it.");
      }
    }
  }
  for (const [id, prior] of was.comments) {
    // A thread removed takes its comments with it, under the thread's rule.
    if (now.comments.has(id) || !now.threads.has(prior.threadId)) continue;
    if (!mine(prior.comment.props.authorId) && !writer.moderator) {
      return refuse("Only a comment's author, an owner or an editor can delete it.");
    }
  }
  for (const [id, thread] of was.threads) {
    if (now.threads.has(id)) continue;
    if (!mine(firstComment(thread)?.props.authorId) && !writer.moderator) {
      return refuse("Only a thread's author, an owner or an editor can delete it.");
    }
  }
  for (const [id, thread] of now.threads) {
    const opening = firstComment(thread);
    const prior = was.threads.get(id);
    if (!prior) {
      if (!opening || !(mine(opening.props.authorId) || reinstated(id))) {
        return refuse("A thread can only be started in your own name.");
      }
    } else if (opening?.id !== firstComment(prior)?.id) {
      return refuse("A thread's opening comment cannot change.");
    }
    const { status, resolvedBy } = thread.props;
    // Resolving without a name is resolving in nobody's: validation lets the
    // half-stamped shape through only for what merges leave behind.
    if (status === "resolved" && resolvedBy === undefined && (prior ?? ever().threads.get(id))?.props.status !== "resolved") {
      return refuse("A thread can only be resolved in your own name.");
    }
    if (resolvedBy === undefined || mine(resolvedBy) || resolvedBy === prior?.props.resolvedBy) continue;
    // Putting back a resolution the thread really had — undoing a reopen, or
    // a reply that reopened — is not resolving in someone's name.
    if (!past.resolvedBy(id, resolvedBy)) return refuse("A thread can only be resolved in your own name.");
  }
  return null;
}
