"use client";

import { useEffect } from "react";
import type * as Y from "yjs";
import { nmlHistoryFor } from "@/app/lib/nml/view/history";
import type { DomainStep, WorkspaceHistory } from "./spine";

/**
 * The NML document's side of the workspace spine, the peer of `textDomain.ts`
 * for a page served on the canonical NML tree (step 13). Its undo unit is the
 * `NmlHistory` `Y.UndoManager` (step 11) that lives per Y.Doc — origin-scoped to
 * the local human's own edits, so undo already leaves collaborators' and AI
 * work in place. This just hands the spine an executor pair and reports the
 * true count of stack items each call consumed, exactly as the text domain does
 * (Yjs can pop several no-op items in one `undo()`), so the one global timeline
 * stays consistent whether a page is served legacy or NML.
 */

export function nmlDomainId(docId: string): string {
  return `nml:${docId}`;
}

/** The bridge members the domain drives — undo/redo that respect the pending gate. */
export type NmlUndoBridge = {
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): boolean;
  redo(): boolean;
};

export function useNmlUndoDomain(
  spine: WorkspaceHistory | null,
  doc: Y.Doc | null,
  bridge: NmlUndoBridge | null,
  docId: string,
  pageId: string | undefined,
): void {
  useEffect(() => {
    if (!spine || !pageId || !doc || !bridge) return;
    const id = nmlDomainId(docId);
    const history = nmlHistoryFor(doc);
    const manager = history.manager;

    let muted = false;
    const onAdded = (event: { type: "undo" | "redo" }) => {
      // Only fresh edits reach here: 'redo'-type additions exist only inside
      // manager.undo(), which is always muted.
      if (!muted && event.type === "undo") spine.record(id, "edit");
    };
    const onCleared = (event: { undoStackCleared: boolean }) => {
      if (event.undoStackCleared) spine.drop(id);
    };
    manager.on("stack-item-added", onAdded);
    manager.on("stack-cleared", onCleared);

    const step = (direction: "undo" | "redo"): DomainStep => {
      // Routed through the bridge, which refuses while an optimistic edit is
      // unacknowledged — so undo never races an in-flight command.
      if (direction === "undo" ? !bridge.canUndo() : !bridge.canRedo()) return "blocked";
      const from = direction === "undo" ? manager.undoStack : manager.redoStack;
      const to = direction === "undo" ? manager.redoStack : manager.undoStack;
      const before = from.length;
      const toBefore = to.length;
      muted = true;
      try {
        if (!(direction === "undo" ? bridge.undo() : bridge.redo())) return "blocked";
      } finally {
        muted = false;
      }
      return { consumed: before - from.length, redoable: to.length > toBefore };
    };

    const unregister = spine.register(
      id,
      { undo: () => step("undo"), redo: () => step("redo") },
      pageId,
    );

    return () => {
      unregister();
      manager.off("stack-item-added", onAdded);
      manager.off("stack-cleared", onCleared);
    };
  }, [spine, doc, bridge, docId, pageId]);
}
