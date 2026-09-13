"use client";

import { useEffect } from "react";
import {
  defaultDeleteFilter,
  defaultProtectedNodes,
  ySyncPluginKey,
} from "y-prosemirror";
import * as Y from "yjs";
import { KEPT_CHANGE } from "@/app/lib/ai/review/fork";
import type { DomainStep, WorkspaceHistory } from "./spine";

/**
 * The document's side of the spine: its own Y.UndoManager over the shared
 * doc's "prosemirror" fragment, configured as y-prosemirror's would be — the
 * ySync binding's writes, same delete filter, same `addToHistory` gate — but
 * owned HERE, per Y.Doc, for the doc's lifetime.
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
 * things the user cannot currently see. Once the person keeps the change it
 * lands here as one entry of theirs (`KEPT_CHANGE`, see review/fork.ts), and
 * ⌘Z takes it back like anything else they wrote.
 */

type UM = Y.UndoManager;

/** One manager per Y.Doc, born on first bridge, gone with the doc. */
const managers = new WeakMap<Y.Doc, UM>();

function managerFor(fragment: Y.XmlFragment): UM | null {
  const doc = fragment.doc;
  if (!doc) return null;
  let manager = managers.get(doc);
  if (!manager) {
    const created = new Y.UndoManager(fragment, {
      trackedOrigins: new Set([ySyncPluginKey, KEPT_CHANGE]),
      deleteFilter: (item) => defaultDeleteFilter(item, defaultProtectedNodes),
      captureTransaction: (tr) => tr.meta.get("addToHistory") !== false,
    });
    // An answer is a step of its own; typing straight after it must not
    // fold into it.
    created.on("stack-item-added", (event) => {
      if (event.origin === KEPT_CHANGE) created.stopCapturing();
    });
    managers.set(doc, created);
    manager = created;
  }
  return manager;
}

/** The two editor members this bridge needs — the same hop CanvasBlock makes. */
export type UndoHostEditor = {
  prosemirrorState: unknown;
  getExtension: (key: string) => unknown;
  onChange?: (cb: () => void) => (() => void) | undefined;
};

/**
 * The shared fragment, fork or no fork: a fork swaps the sync plugin, and
 * ProseMirror keeps the state field its key already had. So the domain stays
 * wired to the shared doc throughout, which is where a kept change lands.
 */
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

/**
 * Ends a doc's text history, for a write that rewrote the page off the
 * timeline. Every entry still on it names Yjs items that write replaced or
 * reused, and ⌘Z over them resurrects and deletes items into a garbled page:
 * a rewind of a kept change came back with notes lost and duplicated (NT-44).
 * The spine hears the clear and tombstones the doc's tokens.
 */
export function endTextHistory(editor: UndoHostEditor) {
  const doc = fragmentOf(editor)?.doc;
  if (doc) managers.get(doc)?.clear();
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
  }, [spine, editor, docId, pageId]);
}
