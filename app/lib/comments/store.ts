import * as Y from "yjs";
import {
  executeNmlCommands,
  inlineLength,
  NmlCommandConflict,
  type ExecuteNmlCommandsOptions,
  type NmlCommand,
} from "@/app/lib/nml/commands";
import { normalizeInline } from "@/app/lib/nml/normalize";
import type {
  NmlCommentBlock,
  NmlCommentThreadBlock,
  NmlDocument,
  NmlInlineContent,
} from "@/app/lib/nml/schema";
import {
  decodeNmlDocument,
  NML_YJS_ROOT,
  type NmlTransactionOrigin,
} from "@/app/lib/nml/yjs";
import type { AnchorWrite } from "./anchorWrite";
import { commentText, threadsOf, type CommentAnchor, type Thread } from "./types";

/**
 * The comments document as a small typed API: read its threads, and change
 * them only through the NML command executor, one attributed transaction per
 * action — the same verbs a person, the assistant and anchor maintenance all
 * use.
 *
 * Decisions this module makes:
 *
 * - **A mention is plain text.** A body is NML inline content, and `@Ada` is
 *   just the characters `@Ada` in it — nothing is added to NML's marks or
 *   inline attributes. Who gets told is a recipient list the composer hands to
 *   the notice mutation beside the write; the document does not keep it.
 *   A body is one paragraph of NML prose, so its whitespace collapses as any
 *   paragraph's does.
 * - **Deleting a thread's first comment deletes the thread**, as in Google
 *   Docs: the opening comment is the thread. Deleting a reply removes the
 *   reply alone.
 * - **Replying to a resolved thread reopens it**, as in Docs, in the same
 *   transaction.
 * - **Only a comment's author may edit or delete it.** That is this client's
 *   manners, not a security boundary: comment bytes are client-written and
 *   the server never reads them, so `authorId` is not proof of anything.
 *   `deleteThread` carries no author rule — who may remove a whole
 *   discussion depends on the viewer's role, which the caller knows and this
 *   module does not.
 * - **Anchor maintenance is a system write.** Re-homing, rewriting `exact`
 *   and orphaning are the document keeping itself current, not anything a
 *   person did, so they carry a `system` origin that no undo tracks, write
 *   nothing when nothing would change, and write nothing at all under a
 *   review fork.
 */

export class CommentsStoreError extends Error {
  constructor(
    readonly code: "not_loaded" | "missing" | "not_author" | "empty_body" | "forked",
    message: string,
  ) {
    super(message);
    this.name = "CommentsStoreError";
  }
}

/** A comment's words: plain text, or NML inline content for marks and links. */
export type CommentBody = string | NmlInlineContent;

/** Who a store writes as. Anchor maintenance always writes as `system`. */
export type CommentsActor = { userId: string; kind: "human" | "model" };

type Authorize = ExecuteNmlCommandsOptions["authorize"];

// ---- Reading ----------------------------------------------------------------

function hasRoot(doc: Y.Doc): boolean {
  return doc.getMap(NML_YJS_ROOT).size > 0;
}

/** Every thread, in document order; none before the document's root has synced. */
export function readThreads(doc: Y.Doc): Thread[] {
  return hasRoot(doc) ? threadsOf(decodeNmlDocument(doc)) : [];
}

type ThreadsCache = {
  listeners: Set<() => void>;
  snapshot: Thread[];
  stale: boolean;
};

const NO_THREADS: Thread[] = [];
const caches = new WeakMap<Y.Doc, ThreadsCache>();

function cacheFor(doc: Y.Doc): ThreadsCache {
  let cache = caches.get(doc);
  if (!cache) {
    const created: ThreadsCache = { listeners: new Set(), snapshot: NO_THREADS, stale: true };
    const root = doc.getMap(NML_YJS_ROOT);
    // Receipts and other roots change without touching a thread; only a
    // transaction under the NML root can.
    doc.on("afterTransaction", (transaction: Y.Transaction) => {
      if (!(transaction.changedParentTypes as Map<unknown, unknown>).has(root)) return;
      created.stale = true;
      for (const listener of created.listeners) listener();
    });
    caches.set(doc, created);
    cache = created;
  }
  return cache;
}

/**
 * The threads as an immutable snapshot, the same array until the document
 * changes — `useSyncExternalStore`'s `getSnapshot`. A state that will not
 * decode keeps the last good snapshot rather than blanking the panel.
 */
export function threadsSnapshot(doc: Y.Doc): Thread[] {
  const cache = cacheFor(doc);
  if (cache.stale) {
    cache.stale = false;
    try {
      cache.snapshot = readThreads(doc);
    } catch {
      // Kept: the next change decodes again.
    }
  }
  return cache.snapshot;
}

/** Calls `listener` after every change to the threads; returns the unsubscribe. */
export function observeThreads(doc: Y.Doc, listener: () => void): () => void {
  const { listeners } = cacheFor(doc);
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// ---- Writing ----------------------------------------------------------------

type Actor = NmlTransactionOrigin["actor"];

/**
 * What one action decided against the document as it stood: the commands to
 * run (none for a no-op) and what the caller gets back either way.
 */
type Plan<T> = {
  result: T;
  commands?: NmlCommand[];
  command?: string;
  idempotencyKey?: string;
};

/**
 * Transactions one action may take: a repair, and the retries of an action
 * whose document moved under an asynchronous authorize.
 */
const ATTEMPTS = 4;

const REOPEN = { status: "open", resolvedBy: undefined, resolvedAt: undefined } as const;

function randomId(): string {
  return crypto.randomUUID();
}

function load(doc: Y.Doc): NmlDocument {
  if (!hasRoot(doc)) throw new CommentsStoreError("not_loaded", "The comments document has not loaded.");
  const document = decodeNmlDocument(doc);
  if (document.kind !== "comments") throw new Error("Not a comments document.");
  return document;
}

/**
 * Commands that put every thread's resolution back in step with its status.
 * Resolving writes status and both stamps and reopening clears them, but
 * concurrent resolve/reopen sequences can merge one replica's status beside
 * another's stamps — and the executor validates the whole document, so one
 * such thread would refuse every later write to the page's comments.
 * The repair is deterministic (reopen, stamps cleared), so replicas that make
 * it concurrently converge.
 */
function repairs(document: NmlDocument): NmlCommand[] {
  return document.blocks.flatMap((block): NmlCommand[] => {
    if (block.type !== "commentThread") return [];
    const { status, resolvedBy, resolvedAt } = block.props;
    const stamped = resolvedBy !== undefined && resolvedAt !== undefined;
    const partial = resolvedBy !== undefined || resolvedAt !== undefined;
    if (status === "resolved" ? stamped : !partial) return [];
    return [{ type: "setNodeProps", nodeId: block.id, patch: REOPEN }];
  });
}

/**
 * Conflicts that mean the document moved between planning and writing, under
 * an asynchronous authorize: a new update (`stale_state`), a deletion the
 * state vector cannot show (`missing_node`), or the same creation landing
 * from a concurrent call (`idempotency_mismatch`). Each is planned again.
 */
const MOVED: ReadonlySet<string> = new Set(["stale_state", "missing_node", "idempotency_mismatch"]);

/**
 * Plan an action against the current document and commit it. The plan and
 * the write happen in one turn unless `authorize` is asynchronous; then the
 * decision is pinned to the state it was made against, and a document that
 * moved meanwhile is planned again rather than written stale.
 *
 * A repair is written only ahead of an action that writes — never for a
 * no-op, a refusal, or a write refused under a review fork.
 */
async function commit<T>(
  doc: Y.Doc,
  write: { actor: Actor; authorize: Authorize },
  plan: (document: NmlDocument) => Plan<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    if (attempt > ATTEMPTS) throw new Error("The comments document kept changing under this write.");
    const document = load(doc);
    const step = plan(document);
    if (!step.commands?.length) return step.result;
    const repair = repairs(document);
    const command = repair.length ? "comments.repair" : step.command!;
    const transactionId = `${command}:${randomId()}`;
    try {
      await executeNmlCommands({
        doc,
        documentId: document.documentId,
        commands: repair.length ? repair : step.commands,
        origin: {
          version: 1,
          transactionId,
          actor: repair.length ? { userId: write.actor.userId, kind: "system" } : write.actor,
          command,
        },
        idempotencyKey: repair.length ? transactionId : step.idempotencyKey ?? transactionId,
        authorize: write.authorize,
        preconditions: { stateVector: Y.encodeStateVector(doc) },
      });
    } catch (error) {
      if (error instanceof NmlCommandConflict && MOVED.has(error.code)) continue;
      throw error;
    }
    if (!repair.length) return step.result;
  }
}

function findThread(document: NmlDocument, threadId: string): NmlCommentThreadBlock | null {
  const block = document.blocks.find((candidate) => candidate.id === threadId);
  return block?.type === "commentThread" ? block : null;
}

function findComment(
  document: NmlDocument,
  commentId: string,
): { thread: NmlCommentThreadBlock; comment: NmlCommentBlock; first: boolean } | null {
  for (const block of document.blocks) {
    if (block.type !== "commentThread") continue;
    const comments = block.children.filter((child): child is NmlCommentBlock => child.type === "comment");
    const index = comments.findIndex((child) => child.id === commentId);
    if (index >= 0) return { thread: block, comment: comments[index], first: index === 0 };
  }
  return null;
}

/** A body as the document will hold it: normalized, so it reads back unchanged. */
function contentOf(body: CommentBody): NmlInlineContent {
  const content = normalizeInline(typeof body === "string" ? [{ type: "text", text: body, marks: [] }] : body);
  if (!commentText(content).trim()) throw new CommentsStoreError("empty_body", "A comment needs some words.");
  return content;
}

/** Structural equality, blind to the order keys were written in. */
function sameContent(a: NmlInlineContent, b: NmlInlineContent): boolean {
  const canonical = (value: unknown) =>
    JSON.stringify(value, (_key, entry: unknown) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? Object.fromEntries(Object.entries(entry).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
        : entry,
    );
  return canonical(a) === canonical(b);
}

function missing(what: string, id: string): CommentsStoreError {
  return new CommentsStoreError("missing", `${what} ${id} is not in the comments document.`);
}

/** The props a write would change, or null when it would change nothing. */
function anchorPatch(
  props: NmlCommentThreadBlock["props"],
  write: AnchorWrite,
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  const fields = Object.entries(write.anchor ?? {}).filter(([, value]) => value !== undefined);
  const anchor: CommentAnchor = { ...props.anchor, ...Object.fromEntries(fields) };
  if (fields.some(([key]) => anchor[key as keyof CommentAnchor] !== props.anchor[key as keyof CommentAnchor])) {
    patch.anchor = anchor;
  }
  if (write.ambiguous === true && props.ambiguous !== true) patch.ambiguous = true;
  if (write.ambiguous === false && props.ambiguous === true) patch.ambiguous = undefined;
  // Orphaning keeps the first time it was seen: every client resolving an
  // orphan would otherwise restamp it, and the stamp is only a cache.
  if (typeof write.orphanedAt === "number" && props.orphanedAt === undefined) patch.orphanedAt = write.orphanedAt;
  if (write.orphanedAt === null && props.orphanedAt !== undefined) patch.orphanedAt = undefined;
  return Object.keys(patch).length ? patch : null;
}

/**
 * Persist what resolving a thread's anchor found. Idempotent: a write equal
 * to what the thread already says makes no transaction — no Yjs update —
 * and two replicas making the same write concurrently converge on one value.
 * A thread deleted meanwhile is nothing to maintain.
 *
 * `forked` is the review-fork rule (docs/commenting-plan.md §3): a resolve
 * against a review's fork must persist nothing — the fork's text is a
 * proposal, and a discard puts the original back. Any `orphanedAt` is refused
 * outright there, and so is any other write that would change the thread; a
 * write that changes nothing is still just nothing.
 *
 * Resolves true when it wrote.
 */
export async function applyAnchorWrite(
  doc: Y.Doc,
  threadId: string,
  write: AnchorWrite,
  options: { userId: string; authorize: Authorize; forked?: boolean },
): Promise<boolean> {
  const refuse = () =>
    new CommentsStoreError("forked", "An anchor resolved against a review's fork is not persisted.");
  if (options.forked && write.orphanedAt !== undefined) throw refuse();
  return commit(doc, { actor: { userId: options.userId, kind: "system" }, authorize: options.authorize }, (document) => {
    const thread = findThread(document, threadId);
    const patch = thread && anchorPatch(thread.props, write);
    if (!patch) return { result: false };
    if (options.forked) throw refuse();
    return { result: true, command: "comments.anchor", commands: [{ type: "setNodeProps", nodeId: threadId, patch }] };
  });
}

export type CommentsStoreOptions = {
  /** Who this store writes as — the person, or the assistant on their behalf. */
  actor: CommentsActor;
  /** Asked before every write; the caller's `canComment`, typically. */
  authorize: Authorize;
  /** Timestamps; `Date.now` unless a test pins them. */
  now?: () => number;
  /** New thread and comment ids; random UUIDs, as NML mints them elsewhere. */
  createId?: () => string;
};

/**
 * One person's (or the assistant's) hands on one comments document. Every
 * write resolves once its transaction has landed locally; the provider ships
 * it from there.
 *
 * Creating a thread or a comment is idempotent on its id: a caller replaying
 * an action (the assistant's turn replay) passes the same id and gets it
 * back, with nothing written a second time.
 */
export class CommentsStore {
  readonly doc: Y.Doc;
  private readonly options: CommentsStoreOptions;

  constructor(doc: Y.Doc, options: CommentsStoreOptions) {
    this.doc = doc;
    this.options = options;
  }

  threads(): Thread[] {
    return readThreads(this.doc);
  }

  private now(at?: number): number {
    return at ?? (this.options.now ?? Date.now)();
  }

  private newId(): string {
    return (this.options.createId ?? randomId)();
  }

  private commit<T>(plan: (document: NmlDocument) => Plan<T>): Promise<T> {
    return commit(this.doc, this.options, plan);
  }

  /**
   * Start a thread on `anchor` with its first comment; resolves the thread's id.
   * `ambiguous` records that the anchor's words appear more than once with the
   * same context — what `anchorForQuote` says of an anchor it mints.
   */
  async createThread(input: {
    anchor: CommentAnchor;
    ambiguous?: boolean;
    body: CommentBody;
    authorId: string;
    threadId?: string;
    commentId?: string;
    at?: number;
  }): Promise<string> {
    const content = contentOf(input.body);
    const threadId = input.threadId ?? this.newId();
    const commentId = input.commentId ?? this.newId();
    const createdAt = this.now(input.at);
    return this.commit((document) => {
      if (findThread(document, threadId)) return { result: threadId };
      return {
        result: threadId,
        command: "comments.create-thread",
        idempotencyKey: `comments.create-thread:${threadId}`,
        commands: [{
          type: "insertNodes",
          parentId: null,
          nodes: [{
            id: threadId,
            type: "commentThread",
            props: { anchor: { ...input.anchor }, status: "open", ...(input.ambiguous ? { ambiguous: true as const } : {}) },
            children: [{ id: commentId, type: "comment", props: { authorId: input.authorId, createdAt }, content, children: [] }],
          }],
        }],
      };
    });
  }

  /** Add a comment to the end of a thread, reopening it if resolved; resolves the comment's id. */
  async reply(input: {
    threadId: string;
    body: CommentBody;
    authorId: string;
    commentId?: string;
    at?: number;
  }): Promise<string> {
    const content = contentOf(input.body);
    const commentId = input.commentId ?? this.newId();
    const createdAt = this.now(input.at);
    return this.commit((document) => {
      if (findComment(document, commentId)) return { result: commentId };
      const thread = findThread(document, input.threadId);
      if (!thread) throw missing("Thread", input.threadId);
      const commands: NmlCommand[] = [{
        type: "insertNodes",
        parentId: thread.id,
        nodes: [{ id: commentId, type: "comment", props: { authorId: input.authorId, createdAt }, content, children: [] }],
      }];
      if (thread.props.status === "resolved") commands.push({ type: "setNodeProps", nodeId: thread.id, patch: REOPEN });
      return { result: commentId, command: "comments.reply", idempotencyKey: `comments.reply:${commentId}`, commands };
    });
  }

  /** Rewrite a comment's words and stamp `editedAt`; author only. Resolves false for no change. */
  async editComment(input: { commentId: string; body: CommentBody; editorId: string; at?: number }): Promise<boolean> {
    const content = contentOf(input.body);
    const editedAt = this.now(input.at);
    return this.commit((document) => {
      const found = findComment(document, input.commentId);
      if (!found) throw missing("Comment", input.commentId);
      if (found.comment.props.authorId !== input.editorId) {
        throw new CommentsStoreError("not_author", "Only a comment's author can edit it.");
      }
      if (sameContent(found.comment.content, content)) return { result: false };
      return {
        result: true,
        command: "comments.edit",
        commands: [
          { type: "replaceInline", nodeId: input.commentId, range: { from: 0, to: inlineLength(found.comment.content) }, content },
          { type: "setNodeProps", nodeId: input.commentId, patch: { editedAt } },
        ],
      };
    });
  }

  /**
   * Delete a comment; author only. The first comment is the thread, so
   * deleting it deletes the thread — resolves which was removed.
   */
  async deleteComment(input: { commentId: string; by: string }): Promise<"comment" | "thread"> {
    return this.commit((document) => {
      const found = findComment(document, input.commentId);
      if (!found) throw missing("Comment", input.commentId);
      if (found.comment.props.authorId !== input.by) {
        throw new CommentsStoreError("not_author", "Only a comment's author can delete it.");
      }
      return found.first
        ? { result: "thread" as const, command: "comments.delete-thread", commands: [{ type: "removeNodes", nodeIds: [found.thread.id] }] }
        : { result: "comment" as const, command: "comments.delete", commands: [{ type: "removeNodes", nodeIds: [input.commentId] }] };
    });
  }

  /** Resolve a thread; resolves false when it already was. */
  async resolve(input: { threadId: string; by: string; at?: number }): Promise<boolean> {
    const resolvedAt = this.now(input.at);
    return this.commit((document) => {
      const thread = findThread(document, input.threadId);
      if (!thread) throw missing("Thread", input.threadId);
      if (thread.props.status === "resolved") return { result: false };
      return {
        result: true,
        command: "comments.resolve",
        commands: [{ type: "setNodeProps", nodeId: thread.id, patch: { status: "resolved", resolvedBy: input.by, resolvedAt } }],
      };
    });
  }

  /** Reopen a resolved thread; resolves false when it was open. */
  async reopen(input: { threadId: string }): Promise<boolean> {
    return this.commit((document) => {
      const thread = findThread(document, input.threadId);
      if (!thread) throw missing("Thread", input.threadId);
      if (thread.props.status === "open") return { result: false };
      return { result: true, command: "comments.reopen", commands: [{ type: "setNodeProps", nodeId: thread.id, patch: REOPEN }] };
    });
  }

  /** Delete a whole thread and its comments. Who may is the caller's rule. */
  async deleteThread(input: { threadId: string }): Promise<void> {
    return this.commit((document) => {
      if (!findThread(document, input.threadId)) throw missing("Thread", input.threadId);
      return { result: undefined, command: "comments.delete-thread", commands: [{ type: "removeNodes", nodeIds: [input.threadId] }] };
    });
  }

  /** `applyAnchorWrite` as this store's user — always a system write. */
  applyAnchorWrite(threadId: string, write: AnchorWrite, options: { forked?: boolean } = {}): Promise<boolean> {
    return applyAnchorWrite(this.doc, threadId, write, {
      userId: this.options.actor.userId,
      authorize: this.options.authorize,
      forked: options.forked,
    });
  }
}
