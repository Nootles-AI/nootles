import * as Y from "yjs";
import { decodeNmlDocument, isNmlOrigin, type NmlTransactionOrigin } from "../yjs";
import type { NmlDocument } from "../schema";

/**
 * Step 11 — canonical undo/redo for the NML layer.
 *
 * The durable undo unit is a canonical Yjs transaction, exactly as the frozen
 * v1 decision requires ("origin-scoped `Y.UndoManager`; semantic inverses for
 * review/restore only"). This wraps a `Y.UndoManager` over the whole canonical
 * `Y.Doc` and gates it on the attributed `NmlTransactionOrigin` every NML
 * command carries, so:
 *
 * - Only the local human's own edits are linearly undoable. A collaborator's
 *   edits arrive through the provider (origin = the provider, not an NML
 *   origin) and model/system batches are a different `actor.kind`; neither is
 *   tracked, so they stay *view-only* (visible in the shared history but not
 *   taken back by ⌘Z) — the "retain view-only local history" requirement, and
 *   what makes undo preserve unrelated concurrent work (the step gate).
 * - An undo/redo is itself a new canonical transaction. It changes the `nml`
 *   root, so every bridge's `observeNmlChanges` subscription reconciles it into
 *   ProseMirror like any other canonical change — undo propagates to every
 *   client and view with no special path.
 *
 * Scope is the doc itself rather than the `nml` root map: NML edits mutate
 * deeply-nested shared types (prose `Y.Text`, block maps, table cells), whose
 * parents — not the root — appear in `changedParentTypes`, so a root-scoped
 * manager would silently miss them. `captureTransaction` is the precise gate;
 * scoping the doc only widens *what may be captured*, never what is.
 */

/**
 * Commands whose consecutive same-actor transactions may coalesce into one undo
 * step within the capture window. Everything else (splits, moves, marks, paste,
 * canvas gestures, domain edits) is a discrete step, matching "typing groups;
 * structure is discrete".
 */
const TYPING_COMMANDS: ReadonlySet<string> = new Set(["plain-text-edit"]);

/** The v1 frozen typing-group window. */
const DEFAULT_CAPTURE_MS = 750;

export type NmlHistoryOptions = {
  /**
   * Only this human's own edits are linearly undoable; absent means "any human
   * on this client", which is the same thing since remote humans never commit
   * here (their edits arrive as provider-origin updates).
   */
  localUserId?: string;
  /** Coalescing window for typing, ms. Defaults to the frozen 750ms. */
  captureTimeoutMs?: number;
};

export class NmlHistory {
  readonly manager: Y.UndoManager;
  private readonly doc: Y.Doc;
  private readonly localUserId?: string;
  private readonly onBefore: (transaction: Y.Transaction) => void;
  /** `${userId}:${command}` of the group currently open for coalescing, or null. */
  private openGroup: string | null = null;

  constructor(doc: Y.Doc, options: NmlHistoryOptions = {}) {
    this.doc = doc;
    this.localUserId = options.localUserId;
    // `captureTransaction` closes over `manager`, but only runs after
    // construction returns, so the reference is safe.
    const manager: Y.UndoManager = new Y.UndoManager(doc, {
      captureTimeout: options.captureTimeoutMs ?? DEFAULT_CAPTURE_MS,
      // NML command origins are plain objects, so they match by constructor
      // (`Object`); the manager also tracks its own undo/redo inverses (it adds
      // itself to `trackedOrigins`). The real filter is `captureTransaction`.
      trackedOrigins: new Set<unknown>([Object]),
      captureTransaction: (transaction) =>
        transaction.origin === manager || this.isLocalHuman(transaction.origin),
    });
    this.manager = manager;
    // Close the open coalescing group at a boundary — a non-typing command, or
    // a change of actor/command — so the next edit becomes its own undo step.
    this.onBefore = (transaction) => {
      if (!this.isLocalHuman(transaction.origin)) return;
      const origin = transaction.origin as NmlTransactionOrigin;
      const group = `${origin.actor.userId}:${origin.command}`;
      const mergeable = TYPING_COMMANDS.has(origin.command);
      if (!mergeable || this.openGroup !== group) manager.stopCapturing();
      this.openGroup = mergeable ? group : null;
    };
    doc.on("beforeTransaction", this.onBefore);
  }

  private isLocalHuman(origin: unknown): origin is NmlTransactionOrigin {
    return (
      isNmlOrigin(origin) &&
      origin.actor.kind === "human" &&
      (this.localUserId === undefined || origin.actor.userId === this.localUserId)
    );
  }

  canUndo(): boolean {
    return this.manager.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.manager.redoStack.length > 0;
  }

  /** Undo the newest local group; returns false when there is nothing to undo. */
  undo(): boolean {
    return this.manager.undo() !== null;
  }

  redo(): boolean {
    return this.manager.redo() !== null;
  }

  /** End the current typing group so the next edit starts a fresh undo step. */
  breakGroup(): void {
    this.manager.stopCapturing();
    this.openGroup = null;
  }

  /**
   * Drop the whole timeline. Used when the document is rewound/rewritten off the
   * timeline, where stale stack items would resurrect content the rewrite
   * replaced (the same hazard `endTextHistory` guards for the legacy editor).
   */
  clear(): void {
    this.manager.clear();
    this.openGroup = null;
  }

  destroy(): void {
    this.doc.off("beforeTransaction", this.onBefore);
    this.manager.destroy();
  }
}

/**
 * One `NmlHistory` per `Y.Doc`, so undo survives a bridge remount and a page
 * revisit (the provider keeps the doc warm) — the same lifetime the legacy
 * text domain keeps its manager for, and the reason it is keyed on the doc
 * rather than owned by the view.
 */
const histories = new WeakMap<Y.Doc, NmlHistory>();

export function nmlHistoryFor(doc: Y.Doc, options?: NmlHistoryOptions): NmlHistory {
  let history = histories.get(doc);
  if (!history) {
    history = new NmlHistory(doc, options);
    histories.set(doc, history);
  }
  return history;
}

/**
 * Review-side history: rewind of model/system batches, the "checkpoints, rewind"
 * of step 11 and the substrate step 14's AI review plugs into.
 *
 * A batch is committed as one attributed transaction (the executor wraps a whole
 * command batch in one `doc.transact`), so each batch is exactly one rewind unit
 * — no time-coalescing (`captureTimeout: 0`, each batch discrete). Rewind is a
 * CRDT-level reversal, NOT a semantic re-issue of inverse commands: it re-adds
 * the batch's exact deleted structs and removes its inserted ones, which is what
 * lets it **restore content a batch deleted** (the semantic structure layer's
 * deletion tombstones refuse re-inserting a removed id) while Yjs rebasing keeps
 * an unrelated collaborator's concurrent edits intact. Human linear undo
 * (`NmlHistory`) and this review log track disjoint origin kinds, so they never
 * consume each other's work.
 */
export class NmlReviewHistory {
  readonly manager: Y.UndoManager;
  private readonly doc: Y.Doc;

  constructor(doc: Y.Doc) {
    this.doc = doc;
    // `captureTransaction` closes over `manager`, but only runs after
    // construction returns, so the reference is safe.
    const manager: Y.UndoManager = new Y.UndoManager(doc, {
      // Each batch is its own rewind step; never merge two batches by time.
      captureTimeout: 0,
      trackedOrigins: new Set<unknown>([Object]),
      captureTransaction: (transaction) =>
        transaction.origin === manager ||
        (isNmlOrigin(transaction.origin) &&
          (transaction.origin.actor.kind === "model" || transaction.origin.actor.kind === "system")),
    });
    this.manager = manager;
  }

  canRewind(): boolean {
    return this.manager.undoStack.length > 0;
  }

  canReapply(): boolean {
    return this.manager.redoStack.length > 0;
  }

  /** Rewind the newest model/system batch; false when there is none. */
  rewind(): boolean {
    return this.manager.undo() !== null;
  }

  /** Re-apply the most recently rewound batch. */
  reapply(): boolean {
    return this.manager.redo() !== null;
  }

  clear(): void {
    this.manager.clear();
  }

  destroy(): void {
    this.manager.destroy();
  }
}

const reviewHistories = new WeakMap<Y.Doc, NmlReviewHistory>();

export function nmlReviewHistoryFor(doc: Y.Doc): NmlReviewHistory {
  let history = reviewHistories.get(doc);
  if (!history) {
    history = new NmlReviewHistory(doc);
    reviewHistories.set(doc, history);
  }
  return history;
}

/**
 * A content snapshot for the recovery affordance: when a rewind or undo would
 * orphan in-flight local content (a collaborator deleted the target), the panel
 * shows the checkpoint's copy of the affected node rather than dropping it. This
 * is the display/copy substrate; step 14 adds semantic restore of a snapshot.
 */
export type NmlCheckpoint = { document: NmlDocument };

export function nmlCheckpoint(doc: Y.Doc): NmlCheckpoint {
  return { document: decodeNmlDocument(doc) };
}

/** The content of one node in a checkpoint, for a content-free recovery record. */
export function checkpointBlock(checkpoint: NmlCheckpoint, nodeId: string): NmlDocument["blocks"][number] | null {
  const find = (blocks: NmlDocument["blocks"]): NmlDocument["blocks"][number] | null => {
    for (const block of blocks) {
      if (block.id === nodeId) return block;
      const nested = find(block.children);
      if (nested) return nested;
    }
    return null;
  };
  return find(checkpoint.document.blocks);
}
