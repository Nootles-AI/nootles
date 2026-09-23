import * as Y from "yjs";
import { isNmlOrigin } from "@/app/lib/nml/yjs";

/**
 * Undo for the comments document, and only for it: the page's own history
 * never reaches a comment and this never reaches the page, because the two
 * are separate Y.Docs (docs/commenting-plan.md §6).
 *
 * Modelled on `NmlHistory`, gated on the attributed origin every store write
 * carries, so only this person's own actions are undoable:
 *
 * - a collaborator's comments arrive through the provider, not as an NML
 *   origin, and are never taken back;
 * - the assistant's writes are `model` and anchor maintenance and repairs are
 *   `system` — neither is a thing this person did, so ⌘Z steps over them,
 *   and undoing a resolve leaves a re-homed anchor where maintenance put it.
 *
 * Every comment action is its own step; nothing coalesces by time.
 */

export type CommentsHistoryState = { canUndo: boolean; canRedo: boolean };

const IDLE: CommentsHistoryState = { canUndo: false, canRedo: false };

export class CommentsHistory {
  readonly manager: Y.UndoManager;
  private readonly doc: Y.Doc;
  private readonly localUserId?: string;
  private readonly listeners = new Set<() => void>();
  private state: CommentsHistoryState = IDLE;
  private readonly onStack = () => {
    const next = { canUndo: this.canUndo(), canRedo: this.canRedo() };
    if (next.canUndo === this.state.canUndo && next.canRedo === this.state.canRedo) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  };

  constructor(doc: Y.Doc, options: { localUserId?: string } = {}) {
    this.doc = doc;
    this.localUserId = options.localUserId;
    // `captureTransaction` closes over `manager`, but only runs after
    // construction returns, so the reference is safe. The whole doc is the
    // scope for the reason `NmlHistory` gives: store writes land on nested
    // types whose parents, not the root, are the changed ones.
    const manager: Y.UndoManager = new Y.UndoManager(doc, {
      captureTimeout: 0,
      trackedOrigins: new Set<unknown>([Object]),
      captureTransaction: (transaction) =>
        transaction.origin === manager || this.isLocalHuman(transaction.origin),
    });
    this.manager = manager;
    for (const event of ["stack-item-added", "stack-item-popped", "stack-cleared"] as const) {
      manager.on(event, this.onStack);
    }
  }

  private isLocalHuman(origin: unknown): boolean {
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

  /** Undo this person's newest comment action; false when there is none. */
  undo(): boolean {
    return this.manager.undo() !== null;
  }

  redo(): boolean {
    return this.manager.redo() !== null;
  }

  clear(): void {
    this.manager.clear();
  }

  /** `{canUndo, canRedo}`, the same object until either changes — for `useSyncExternalStore`. */
  getState(): CommentsHistoryState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  destroy(): void {
    for (const event of ["stack-item-added", "stack-item-popped", "stack-cleared"] as const) {
      this.manager.off(event, this.onStack);
    }
    this.listeners.clear();
    this.manager.destroy();
    const held = histories.get(this.doc);
    if (held?.get(this.localUserId ?? "") === this) held.delete(this.localUserId ?? "");
  }
}

/**
 * One history per comments Y.Doc and person, so undo outlives a composer's
 * remount the way the doc outlives it in the provider's warm cache — and a
 * different person signing in on the same warm doc starts a timeline of
 * their own rather than inheriting someone else's.
 */
const histories = new WeakMap<Y.Doc, Map<string, CommentsHistory>>();

export function commentsHistoryFor(doc: Y.Doc, options: { localUserId?: string } = {}): CommentsHistory {
  let held = histories.get(doc);
  if (!held) {
    held = new Map();
    histories.set(doc, held);
  }
  const key = options.localUserId ?? "";
  let history = held.get(key);
  if (!history) {
    history = new CommentsHistory(doc, options);
    held.set(key, history);
  }
  return history;
}
