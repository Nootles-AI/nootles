"use client";

import { useContext, useMemo, useSyncExternalStore } from "react";
import type { EditorState } from "prosemirror-state";
import type { LiveEditor } from "@/app/components/editor/EditorRegistry";
import { anchorForSelection } from "@/app/lib/comments/pmText";
import type { CommentAnchor } from "@/app/lib/comments/types";
import { CommentsEditorContext } from "./editorSlot";
import { usePageComments } from "./PageComments";

/** Words selected in the page, as a comment would anchor to them. */
export type SelectedWords = {
  anchor: CommentAnchor;
  /** The selection's ProseMirror range, for placing an affordance beside it. */
  from: number;
  to: number;
};

/**
 * What a comment affordance may offer for the current selection:
 *
 * - `comment` — this person may start a thread on these words;
 * - `signIn` — a signed-out guest on a comment link, whom signing in would let
 *   comment; the affordance reads "Sign in to comment" and calls `signIn`.
 *
 * Null when there is nothing to offer: no words selected (a caret, blank
 * lines, a diagram, a selection that has left the page), or a reader who may
 * not comment — a viewer, an operator standing in, anyone signed out on a
 * link that grants no commenting.
 */
export type CommentableSelection =
  | (SelectedWords & { kind: "comment" })
  | (SelectedWords & { kind: "signIn"; signIn: () => void });

const noSlot = () => () => {};
const noEditor = () => null;

/**
 * The page's selection as something to comment on — in the editable document
 * and the read-only one alike, since a commenter reads the page without the
 * pen and still selects words. A comment surface only renders from this; it
 * never reads the editor itself.
 *
 * The browser's selection has to lie inside the editor, not merely have been
 * there: a read-only view cannot take focus, so ProseMirror keeps its last
 * selection after the reader clicks elsewhere, and only the DOM says the words
 * were let go. So an affordance that takes focus (a composer) must capture the
 * anchor before it does — the selection is gone the moment focus leaves.
 */
export function useCommentableSelection(): CommentableSelection | null {
  const comments = usePageComments();
  const slot = useContext(CommentsEditorContext);
  const editor = useSyncExternalStore(slot?.subscribe ?? noSlot, slot?.get ?? noEditor, noEditor);
  const reader = useMemo(() => selectionReader(editor), [editor]);
  const words = useSyncExternalStore(reader.subscribe, reader.read, noEditor);

  return useMemo(() => {
    if (!words || !comments) return null;
    const { access, userId } = comments;
    if (access.canComment && userId) return { kind: "comment", ...words };
    if (!access.canComment && access.signIn) return { kind: "signIn", signIn: access.signIn, ...words };
    return null;
  }, [words, comments]);
}

/**
 * A `useSyncExternalStore` source over one editor's selection. `read` answers
 * the same object until the selected words change, so a surface re-renders on
 * a new selection and not on every keystroke elsewhere in the page.
 */
function selectionReader(editor: LiveEditor | null) {
  let seen: EditorState | null = null;
  let words: SelectedWords | null = null;

  const subscribe = (listener: () => void) => {
    if (!editor) return () => {};
    const tiptap = editor._tiptapEditor;
    tiptap.on("transaction", listener);
    tiptap.on("mount", listener);
    // A read-only view takes no transaction when the reader lets go of the
    // words by clicking outside it; only the document hears that.
    document.addEventListener("selectionchange", listener);
    return () => {
      tiptap.off("transaction", listener);
      tiptap.off("mount", listener);
      document.removeEventListener("selectionchange", listener);
    };
  };

  const read = (): SelectedWords | null => {
    const view = editor && !editor.headless ? editor.prosemirrorView : undefined;
    if (!editor || !view || !selectionInside(view.dom)) return null;
    const state = editor.prosemirrorState;
    if (state === seen) return words;
    seen = state;
    const { from, to } = state.selection;
    const anchor = from === to ? null : anchorForSelection(state.doc, from, to);
    const next = anchor && { anchor, from, to };
    if (!next || !words || !sameWords(next, words)) words = next;
    return words;
  };

  return { subscribe, read };
}

function selectionInside(root: Element): boolean {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed) return false;
  const { anchorNode, focusNode } = selection;
  return Boolean(anchorNode && focusNode && root.contains(anchorNode) && root.contains(focusNode));
}

function sameWords(a: SelectedWords, b: SelectedWords): boolean {
  return (
    a.from === b.from &&
    a.to === b.to &&
    a.anchor.blockId === b.anchor.blockId &&
    a.anchor.exact === b.anchor.exact &&
    a.anchor.prefix === b.anchor.prefix &&
    a.anchor.suffix === b.anchor.suffix &&
    a.anchor.offsetHint === b.anchor.offsetHint
  );
}
