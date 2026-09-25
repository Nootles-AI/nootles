import { ySyncPluginKey } from "y-prosemirror";
import type * as Y from "yjs";
import type { RelativeSelection, TextStep } from "./textSteps";

type UM = Y.UndoManager;
export type StackItem = NonNullable<ReturnType<UM["undo"]>>;

/** Where an entry keeps the selection on either side of it. */
export const BEFORE = "nt:selection-before";
export const AFTER = "nt:selection-after";

/**
 * Cuts a doc's undo stack at the editor's grain rather than Yjs's 500ms one,
 * and hangs each entry's selections on it. The editor side is read through
 * `readStep` / `readSelection`, so this runs against a bare Y.Doc as well.
 */
export function captureTextSteps(
  manager: UM,
  doc: Y.Doc,
  readStep: () => TextStep | undefined,
  readSelection: () => RelativeSelection | null,
  onEdit: () => void,
) {
  // The dispatch the sync plugin is writing: a block's reshaping may not join
  // the entry before it, and nothing typed after may join it. Inside one
  // `asOneStep` group nothing is cut; entering or leaving a group always is.
  let writing: TextStep | undefined;
  let group: number | null = null;
  const onWrite = (transaction: Y.Transaction) => {
    if (transaction.origin !== ySyncPluginKey) return;
    writing = readStep();
    const next = writing?.group ?? null;
    if (next !== group || (next === null && writing?.boundary)) manager.stopCapturing();
    group = next;
  };

  let muted = false;
  type Captured = { stackItem: StackItem; type: "undo" | "redo"; origin: unknown };
  const onCaptured = (event: Captured) => {
    if (muted || event.type !== "undo" || event.origin !== ySyncPluginKey) return;
    const { meta } = event.stackItem;
    if (!meta.has(BEFORE)) meta.set(BEFORE, writing?.before ?? null);
    meta.set(AFTER, readSelection());
    if (writing?.boundary && writing.group === null) manager.stopCapturing();
  };
  const onAdded = (event: Captured) => {
    if (muted) return;
    // Only fresh edits reach here: 'redo'-type additions exist only inside
    // `step`, which is always muted.
    if (event.type === "undo") onEdit();
    onCaptured(event);
  };

  doc.on("beforeTransaction", onWrite);
  manager.on("stack-item-added", onAdded);
  manager.on("stack-item-updated", onCaptured);

  /**
   * One undo or redo. A call may consume several entries — Yjs pops items
   * whose every change a collaborator overwrote, silently, in the same call —
   * so the stacks are measured around it.
   */
  const step = (direction: "undo" | "redo") => {
    const from = direction === "undo" ? manager.undoStack : manager.redoStack;
    const to = direction === "undo" ? manager.redoStack : manager.undoStack;
    const before = from.length;
    const toBefore = to.length;
    let item: StackItem | null = null;
    muted = true;
    try {
      item = direction === "undo" ? manager.undo() : manager.redo();
    } finally {
      muted = false;
    }
    const redoable = to.length > toBefore;
    // The inverse entry is the same change seen from the other side, and
    // keeps the same two selections.
    if (item && redoable) {
      const inverse = to[to.length - 1];
      for (const [key, value] of item.meta) inverse.meta.set(key, value);
    }
    return { item, consumed: before - from.length, redoable };
  };

  const dispose = () => {
    doc.off("beforeTransaction", onWrite);
    manager.off("stack-item-added", onAdded);
    manager.off("stack-item-updated", onCaptured);
  };

  return { step, dispose };
}
