"use client";

import { useEffect, useState } from "react";
import {
  defaultDeleteFilter,
  defaultProtectedNodes,
  ySyncPluginKey,
} from "y-prosemirror";
import * as Y from "yjs";
import type { DomainStep, WorkspaceHistory } from "./spine";

/**
 * The document's side of the spine: its own Y.UndoManager over the shared
 * doc's "prosemirror" fragment, configured exactly as y-prosemirror's would
 * be — same tracked origin (the ySync binding), same delete filter, same
 * `addToHistory` gate — but owned HERE, per Y.Doc, for the doc's lifetime.
 *
 * Deliberately not the yUndoPlugin's own manager. That one dies with the
 * ProseMirror view (`destroy()` on unmount), which StrictMode's double-mount
 * triggers immediately in development, and an editor rebuild loses it in any
 * mode — the fresh horizon per page visit the spine exists to end. Keying on
 * the Y.Doc instead means history lives as long as the document does: the
 * provider cache keeps docs warm across page switches, and this manager
 * rides along. The plugin's manager still exists, unused; its only caller
 * was the Mod-z binding the workspace handler now runs ahead of.
 *
 * One executor call may consume several stack entries — Yjs pops items whose
 * every change a collaborator overwrote, silently, in the same `undo()`. The
 * step measures the stacks around the call and reports the true count, so
 * the spine's ledger never drifts.
 *
 * While a review fork is open the editor runs on a private doc; the domain
 * reports itself blocked — the review bar is the undo affordance for that
 * stretch, and undoing shared history UNDER a private fork would revert
 * things the user cannot currently see.
 */

type UM = Y.UndoManager;

/** One manager per Y.Doc, born on first bridge, gone with the doc. */
const managers = new WeakMap<Y.Doc, UM>();

function managerFor(fragment: Y.XmlFragment): UM | null {
  const doc = fragment.doc;
  if (!doc) return null;
  let manager = managers.get(doc);
  if (!manager) {
    manager = new Y.UndoManager(fragment, {
      trackedOrigins: new Set([ySyncPluginKey]),
      deleteFilter: (item) => defaultDeleteFilter(item, defaultProtectedNodes),
      captureTransaction: (tr) => tr.meta.get("addToHistory") !== false,
    });
    managers.set(doc, manager);
  }
  return manager;
}

/** The two editor members this bridge needs — the same hop CanvasBlock makes. */
export type UndoHostEditor = {
  prosemirrorState: unknown;
  getExtension: (key: string) => unknown;
  onChange?: (cb: () => void) => (() => void) | undefined;
};

/** The fragment the live editor is bound to — the fork's while forked. */
function fragmentOf(editor: UndoHostEditor): Y.XmlFragment | null {
  try {
    const state = ySyncPluginKey.getState(
      editor.prosemirrorState as Parameters<typeof ySyncPluginKey.getState>[0],
    ) as { type?: Y.XmlFragment } | undefined;
    return state?.type ?? null;
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
  // re-runs the wiring against whichever doc is now bound.
  const [forkNonce, setForkNonce] = useState(0);
  useEffect(() => {
    const fork = editor.getExtension("yForkDoc") as
      | { store?: { subscribe: (cb: () => void) => () => void } }
      | undefined;
    if (!fork?.store?.subscribe) return;
    return fork.store.subscribe(() => setForkNonce((n) => n + 1));
  }, [editor]);

  useEffect(() => {
    if (!spine || !pageId) return;
    const id = textDomainId(docId);

    const forked = () => {
      // The extension store is a @tanstack/store: state is a property.
      const fork = editor.getExtension("yForkDoc") as
        | { store?: { state?: { isForked?: boolean } } }
        | undefined;
      return fork?.store?.state?.isForked ?? false;
    };
    // While forked the domain stands registered but blocked — vanishing would
    // read as death and the spine would start tombstoning live tokens.
    if (forked()) {
      return spine.register(
        id,
        { undo: () => "blocked", redo: () => "blocked" },
        pageId,
      );
    }

    const fragment = fragmentOf(editor);
    const manager = fragment && managerFor(fragment);
    if (!manager) return;

    let muted = false;
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
    if (process.env.NODE_ENV !== "production") {
      // Verification harnesses read the ledger through this; never shipped.
      (window as unknown as Record<string, unknown>).__ntTextUndo = manager;
    }

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
    // forkNonce is a real dependency: it re-runs this against the doc the
    // fork swap just bound.
  }, [spine, editor, docId, pageId, forkNonce]);
}
