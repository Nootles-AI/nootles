"use client";

import { useEffect } from "react";
import {
  defaultDeleteFilter,
  defaultProtectedNodes,
  ySyncPluginKey,
} from "y-prosemirror";
import type { Node as PMNode } from "prosemirror-model";
import { Selection, type EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import * as Y from "yjs";
import { KEPT_CHANGE } from "@/app/lib/ai/review/fork";
import { isCanvasMapName } from "@/app/components/editor/canvas/collab/ymap";
import type { DomainStep, WorkspaceHistory } from "./spine";
import { AFTER, BEFORE, captureTextSteps, type StackItem } from "./textCapture";
import {
  relativeSelection,
  restoreSelection,
  textStepOf,
  type RelativeSelection,
} from "./textSteps";

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
    // A kept change can carry diagrams, whose truth is their maps rather than
    // the fragment, and ⌘Z has to take a diagram back whole or its block would
    // say one diagram and its maps another. Scoped as each change lands: no
    // other origin this manager tracks writes to a diagram's maps. A diagram
    // the change itself created has no maps here yet; ⌘Z takes its block away
    // and leaves them with nothing reading them.
    doc.on("beforeTransaction", (transaction: Y.Transaction) => {
      if (transaction.origin !== KEPT_CHANGE) return;
      created.addToScope(
        [...doc.share.keys()].filter(isCanvasMapName).map((name) => doc.getMap(name)),
      );
    });
    managers.set(doc, created);
    manager = created;
  }
  return manager;
}

/** The editor members this bridge needs — the same hop CanvasBlock makes. */
export type UndoHostEditor = {
  prosemirrorState: unknown;
  prosemirrorView?: EditorView;
  getExtension: (key: string) => unknown;
  onChange?: (cb: () => void) => (() => void) | undefined;
};

/**
 * The shared fragment, fork or no fork: a fork swaps the sync plugin, and
 * ProseMirror keeps the state field its key already had. So the domain stays
 * wired to the shared doc throughout, which is where a kept change lands.
 */
function fragmentOf(editor: Pick<UndoHostEditor, "prosemirrorState">): Y.XmlFragment | null {
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

/**
 * Ends the doc's current undo step, so the next write starts one of its own.
 * False when the doc has no history here to end — a legacy doc, whose steps
 * are ProseMirror's.
 */
export function closeTextStep(editor: Pick<UndoHostEditor, "prosemirrorState">): boolean {
  const doc = fragmentOf(editor)?.doc;
  const manager = doc && managers.get(doc);
  if (!manager) return false;
  manager.stopCapturing();
  return true;
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
    const doc = fragment?.doc;
    const manager = fragment && managerFor(fragment);
    if (!manager || !doc) return;

    const capture = captureTextSteps(
      manager,
      doc,
      () => textStepOf(editor.prosemirrorState as EditorState),
      () => relativeSelection(editor.prosemirrorState as EditorState),
      () => spine.record(id, "edit"),
    );
    const onCleared = (event: { undoStackCleared: boolean }) => {
      if (event.undoStackCleared) spine.drop(id);
    };
    manager.on("stack-cleared", onCleared);
    if (process.env.NODE_ENV !== "production") {
      // Verification harnesses read the ledger through this; never shipped.
      (window as unknown as Record<string, unknown>).__ntTextUndo = manager;
    }

    /**
     * Writes what the editor appended while re-rendering the step (see
     * textSteps.ts) at once, so no keystroke can write it as theirs first, and
     * puts the caret back where the change happened — before it for an undo,
     * after it for a redo — instead of wherever the re-render left it, which
     * was usually the end of the page. An entry that remembers no selection (a
     * kept AI change) gets the caret where the page first differs.
     */
    const land = (item: StackItem | null, direction: "undo" | "redo", prior: PMNode | undefined) => {
      const view = editor.prosemirrorView;
      if (!view || view.isDestroyed) return;
      const tr = view.state.tr.setMeta("addToHistory", false);
      const selection = item?.meta.get(direction === "undo" ? BEFORE : AFTER) as
        | RelativeSelection
        | null
        | undefined;
      if (selection && restoreSelection(tr, view.state, selection)) {
        tr.scrollIntoView();
      } else if (item && prior) {
        const at = prior.content.findDiffStart(tr.doc.content);
        if (at !== null) {
          tr.setSelection(Selection.near(tr.doc.resolve(Math.min(at, tr.doc.content.size))));
          tr.scrollIntoView();
        }
      }
      view.dispatch(tr);
      // A press from nowhere in particular brings the keyboard back to the
      // caret it just placed; one from another field leaves that field be.
      if (!view.hasFocus() && document.activeElement === document.body) view.focus();
    };

    const step = (direction: "undo" | "redo"): DomainStep => {
      if (forked()) return "blocked";
      const prior = editor.prosemirrorView?.state.doc;
      const { item, consumed, redoable } = capture.step(direction);
      land(item, direction, prior);
      return { consumed, redoable };
    };

    const unregister = spine.register(
      id,
      { undo: () => step("undo"), redo: () => step("redo"), blocked: forked },
      pageId,
    );

    return () => {
      unregister();
      capture.dispose();
      manager.off("stack-cleared", onCleared);
    };
  }, [spine, editor, docId, pageId]);
}
