"use client";

import { useEffect, useState } from "react";
import { yUndoPluginKey } from "y-prosemirror";
import type * as Y from "yjs";
import type { DomainStep, WorkspaceHistory } from "./spine";

/**
 * The document's side of the spine: a bridge onto the Yjs UndoManager that
 * y-prosemirror installs for each editor.
 *
 * Two jobs beyond plain forwarding:
 *
 * **The stacks outlive the editor.** The Y.Doc is provider-cached across page
 * switches, but the editor — and with it the UndoManager — is rebuilt on
 * every mount, which used to start a fresh undo horizon per visit. On
 * unmount the manager's stack ARRAYS are stashed per docId; on the next
 * mount they are assigned onto the fresh manager (the same move BlockNote's
 * fork extension makes). Stack items reference the doc's own structs, so
 * they stay valid exactly as long as the doc does — a stash whose doc was
 * evicted is discarded, and the spine drops the tokens with it.
 *
 * **One call may consume several entries.** `UndoManager.undo()` pops stack
 * items until one performs a visible change — items fully overwritten by
 * collaborators go silently. The executor measures the stack around the call
 * and reports the true count, so the spine's ledger never drifts.
 *
 * While a review fork is open the editor runs on a private doc with a
 * throwaway manager; nothing is recorded and the domain reports itself
 * blocked — the review bar is the undo affordance for that stretch, and
 * undoing shared history UNDER a private fork would revert things the user
 * cannot currently see.
 */

type UM = Y.UndoManager;
type Stack = UM["undoStack"];

const carried = new Map<
  string,
  { doc: Y.Doc; undoStack: Stack; redoStack: Stack }
>();

/** The two editor members this bridge needs — the same hop CanvasBlock makes. */
export type UndoHostEditor = {
  prosemirrorState: unknown;
  getExtension: (key: string) => unknown;
};

function managerOf(editor: UndoHostEditor): UM | null {
  try {
    const state = yUndoPluginKey.getState(
      editor.prosemirrorState as Parameters<typeof yUndoPluginKey.getState>[0],
    ) as { undoManager?: UM } | undefined;
    return state?.undoManager ?? null;
  } catch {
    return null;
  }
}

export function textDomainId(docId: string): string {
  return `text:${docId}`;
}

export function useTextUndoDomain(
  spine: WorkspaceHistory | null,
  editor: UndoHostEditor,
  docId: string,
  pageId: string | undefined,
): void {
  // A fork swap replaces the plugins under the same editor object; the nonce
  // re-runs the wiring against whichever manager is now installed.
  const [forkNonce, setForkNonce] = useState(0);
  useEffect(() => {
    const fork = editor.getExtension("yForkDoc") as
      | {
          store?: {
            subscribe: (cb: () => void) => () => void;
            getState?: () => { isForked: boolean };
          };
        }
      | undefined;
    if (!fork?.store?.subscribe) return;
    return fork.store.subscribe(() => setForkNonce((n) => n + 1));
  }, [editor]);

  useEffect(() => {
    if (!spine || !pageId) return;
    const manager = managerOf(editor);
    if (!manager) return;
    const id = textDomainId(docId);

    const forked = () => {
      const fork = editor.getExtension("yForkDoc") as
        | { store?: { getState: () => { isForked: boolean } } }
        | undefined;
      return fork?.store?.getState().isForked ?? false;
    };
    // The fork's own manager is throwaway; only the shared doc's is bridged.
    // While forked the domain stands registered but blocked — vanishing would
    // read as death and the spine would start tombstoning live tokens.
    if (forked()) {
      return spine.register(
        id,
        { undo: () => "blocked", redo: () => "blocked" },
        pageId,
      );
    }

    // Revive the stacks a previous mount left for this doc. A count that no
    // longer matches the ledger (the fork discarded a redo stack, the doc
    // was evicted and reborn) resolves toward the manager: stale spine
    // tokens die on first touch, which is the spine's normal answer.
    const stash = carried.get(docId);
    carried.delete(docId);
    if (stash && stash.doc === manager.doc) {
      manager.undoStack = stash.undoStack;
      manager.redoStack = stash.redoStack;
    } else if (stash) {
      spine.drop(id);
    }

    let muted = false;
    const step = (direction: "undo" | "redo"): DomainStep => {
      if (forked()) return "blocked";
      const from = direction === "undo" ? manager.undoStack : manager.redoStack;
      const to = direction === "undo" ? manager.redoStack : manager.undoStack;
      const before = from.length;
      const toBefore = to.length;
      muted = true;
      try {
        if (direction === "undo") manager.undo();
        else manager.redo();
      } finally {
        muted = false;
      }
      return {
        consumed: before - from.length,
        redoable: to.length > toBefore,
      };
    };

    const onAdded = (event: { type: "undo" | "redo" }) => {
      if (muted) return;
      // Only fresh edits reach here: 'redo'-type additions exist only inside
      // manager.undo(), which is always muted.
      if (event.type === "undo") spine.record(id, "edit");
    };
    const onCleared = (event: { undoStackCleared: boolean }) => {
      if (event.undoStackCleared) spine.drop(id);
    };
    manager.on("stack-item-added", onAdded);
    manager.on("stack-cleared", onCleared);

    const unregister = spine.register(
      id,
      { undo: () => step("undo"), redo: () => step("redo") },
      pageId,
    );

    return () => {
      unregister();
      manager.off("stack-item-added", onAdded);
      manager.off("stack-cleared", onCleared);
      carried.set(docId, {
        doc: manager.doc,
        undoStack: manager.undoStack,
        redoStack: manager.redoStack,
      });
    };
    // forkNonce is a real dependency: it re-runs this against the manager the
    // fork swap just installed.
  }, [spine, editor, docId, pageId, forkNonce]);
}
