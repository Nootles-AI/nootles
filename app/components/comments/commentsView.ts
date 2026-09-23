"use client";

import { useContext, useMemo, useSyncExternalStore } from "react";
import type { EditorView } from "prosemirror-view";
import {
  activeThread,
  commentRanges,
  subscribeComments,
} from "@/app/components/editor/comments/commentDecorations";
import { CommentsEditorContext } from "./editorSlot";

/**
 * The page's editor as the comment UI reads it: its ProseMirror view, the
 * focused thread, and which threads are anchored right now. Each is a
 * `useSyncExternalStore` source whose snapshot changes only when the answer
 * does — so a keystroke that moves every range re-renders nothing here; the
 * margin repositions its cards itself, outside React.
 */

const noSlot = () => () => {};
const none = () => null;

export function useCommentsEditorView(): EditorView | null {
  const slot = useContext(CommentsEditorContext);
  const editor = useSyncExternalStore(slot?.subscribe ?? noSlot, slot?.get ?? none, none);
  return editor && !editor.headless ? (editor.prosemirrorView ?? null) : null;
}

function subscriber(view: EditorView | null) {
  return (listener: () => void) => (view ? subscribeComments(view, () => listener()) : () => {});
}

/** The thread the highlights call focused — the caret's, or the one last chosen. */
export function useActiveThread(view: EditorView | null): string | null {
  const subscribe = useMemo(() => subscriber(view), [view]);
  return useSyncExternalStore(subscribe, () => (view ? activeThread(view.state) : null), none);
}

const NOTHING: ReadonlySet<string> = new Set();

/**
 * The threads whose words are in the page right now. A thread whose range is
 * gone — orphaned, or hidden under a review's proposal — leaves the margin for
 * the panel's "no longer in the document", and comes back when its words do.
 */
export function useAnchoredThreads(view: EditorView | null): ReadonlySet<string> {
  const source = useMemo(() => anchoredReader(view), [view]);
  return useSyncExternalStore(source.subscribe, source.read, () => NOTHING);
}

/** The same set object until a thread gains or loses its range. */
function anchoredReader(view: EditorView | null) {
  let key = "";
  let set = NOTHING;
  const read = () => {
    if (!view) return NOTHING;
    const ids = [...commentRanges(view.state)].flatMap(([id, range]) => (range ? [id] : []));
    const next = ids.sort().join("\n");
    if (next !== key) {
      key = next;
      set = ids.length ? new Set(ids) : NOTHING;
    }
    return set;
  };
  return { subscribe: subscriber(view), read };
}
