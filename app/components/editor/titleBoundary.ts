"use client";

import { createExtension, SuggestionMenu } from "@blocknote/core";
import {
  Selection,
  TextSelection,
  type Command,
  type EditorState,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { KeyboardEvent } from "react";
import { isEmptyParagraphBlock } from "@/app/lib/documentTail";
import { blockSelection } from "./blockSelection";
import type { LiveEditor } from "./EditorRegistry";

/**
 * The seam between a page's title and its document, crossed the way Notion
 * crosses it: the title reads as the document's first line even though it is a
 * separate field persisted by a separate mutation.
 *
 * The title's side (Enter, ArrowDown) is {@link leaveTitle}, which edits the
 * document only through the editor's own API; the document's side (ArrowUp,
 * Backspace) is the extension below. The two find each other through
 * the page they share rather than through a registry, because the title is
 * always rendered beside its editor.
 */

/** Worn by the element wrapping the page's editable title. */
export const TITLE_ATTR = "data-nt-page-title";

function titleOf(dom: Element): HTMLElement | null {
  return (
    dom
      .closest("[data-page-id]")
      ?.querySelector<HTMLElement>(`[${TITLE_ATTR}] [contenteditable="true"]`) ?? null
  );
}

/** The caret's box, or null where the browser cannot measure one. */
function caretRect(): DOMRect | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  return selection.getRangeAt(0).getClientRects()[0] ?? null;
}

/** One box per visual line of the title's text. */
function titleLines(title: HTMLElement): DOMRectList {
  const all = document.createRange();
  all.selectNodeContents(title);
  return all.getClientRects();
}

// ---------------------------------------------------------------------------
// The title's side
// ---------------------------------------------------------------------------

/** The selection in the title, as offsets into its text. */
function titleSelection(title: HTMLElement): { start: number; end: number } {
  const length = title.textContent?.length ?? 0;
  const selection = window.getSelection();
  if (!selection?.rangeCount || !title.contains(selection.anchorNode)) {
    return { start: length, end: length };
  }
  const range = selection.getRangeAt(0);
  const offset = (node: Node, at: number) => {
    const before = document.createRange();
    before.selectNodeContents(title);
    before.setEnd(node, at);
    return before.toString().length;
  };
  return {
    start: offset(range.startContainer, range.startOffset),
    end: offset(range.endContainer, range.endOffset),
  };
}

/** Whether ArrowDown would leave the title: the caret is on its last line. */
function caretOnLastLine(title: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection?.isCollapsed) return false;
  const lines = titleLines(title);
  const last = lines[lines.length - 1];
  const caret = caretRect();
  // An empty title has no line boxes, and one line is its last.
  if (!last || !caret) return true;
  return caret.top + caret.height / 2 >= last.top;
}

/** The caret's horizontal position, carried across the seam. */
function caretX(fallback: Element): number {
  return caretRect()?.left ?? fallback.getBoundingClientRect().left;
}

/**
 * Enter in the title: `text` — whatever followed the caret — opens the page as
 * its first block, and the caret goes to the start of it. A page that is only
 * its one empty line is written into rather than stacked on; anywhere else a
 * fresh block opens, as Notion's does.
 */
export function enterBody(editor: LiveEditor, text: string) {
  const [first, ...rest] = editor.document;
  if (first) {
    const target =
      rest.length || !isEmptyParagraphBlock(first)
        ? editor.insertBlocks([{ type: "paragraph", content: text }], first, "before")[0]
        : text
          ? editor.updateBlock(first, { content: text })
          : first;
    editor.setTextCursorPosition(target, "start");
  }
  editor.focus();
}

/**
 * Enter's split, in the order ⌘Z reads it back: the title's write is recorded
 * before the document's, so the first undo takes the new block away rather
 * than handing the title its tail while the block still holds it.
 */
export function splitTitle(
  editor: LiveEditor,
  text: string,
  { start, end }: { start: number; end: number },
  commit: (title: string) => void,
) {
  commit(text.slice(0, start));
  enterBody(editor, text.slice(end));
}

/**
 * ArrowDown from the title: the document's first line, as near `x` as it goes.
 * A first block with no text of its own — a diagram, an image, a code block —
 * is selected whole instead, the way the arrows arrive on one anywhere else.
 */
function caretIntoBody(editor: LiveEditor, x: number) {
  const view = editor.prosemirrorView;
  if (!view) return;
  const first = editor.document[0];
  if (first && first.content === undefined) {
    blockSelection(editor).select([first.id]);
    return;
  }
  const { doc } = view.state;
  const start = Selection.findFrom(doc.resolve(0), 1, true);
  if (start) {
    const line = view.coordsAtPos(start.from);
    const hit = view.posAtCoords({ left: x, top: (line.top + line.bottom) / 2 });
    const $hit = hit && doc.resolve(hit.pos);
    const target =
      $hit && $hit.parent === start.$from.parent ? TextSelection.create(doc, hit.pos) : start;
    view.dispatch(view.state.tr.setSelection(target).scrollIntoView());
  }
  view.focus();
}

/**
 * The title's keydown. Enter and ArrowDown leave the title for the document,
 * the way they do in every editor this one resembles; blurring instead left
 * the caret nowhere at all, so the next thing typed went to the page rather
 * than into the page.
 *
 * Enter splits: what follows the caret opens the document, and is taken off
 * the title — through `commit`, the title's own immediate write — only once
 * the document is there to receive it.
 */
export function leaveTitle(
  event: KeyboardEvent<HTMLElement>,
  editor: () => Promise<LiveEditor>,
  commit: (title: string) => void,
) {
  const title = event.currentTarget;
  const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
  const down = event.key === "ArrowDown" && plain && caretOnLastLine(title);
  if ((event.key !== "Enter" && !down) || event.nativeEvent.isComposing) return;
  event.preventDefault();
  const x = caretX(title);
  const { start, end } = titleSelection(title);
  editor()
    .then((live) => {
      if (down) return caretIntoBody(live, x);
      const text = title.textContent ?? "";
      if (start < text.length) title.textContent = text.slice(0, start);
      splitTitle(live, text, { start, end }, commit);
    })
    // A document that never finished loading has nowhere to put the caret;
    // after Enter, letting go of the title is better than trapping it. An
    // arrow that goes nowhere leaves the caret where it was.
    .catch(() => {
      if (!down) title.blur();
    });
}

/** Into the title: at its end, or on its last line near `x`. */
function focusTitle(title: HTMLElement, x?: number) {
  title.focus();
  const selection = window.getSelection();
  if (!selection) return;
  let range: Range | null = null;
  const lines = titleLines(title);
  const last = lines[lines.length - 1];
  if (x !== undefined && last) {
    const y = (last.top + last.bottom) / 2;
    const hit = document.caretPositionFromPoint?.(x, y);
    if (hit && title.contains(hit.offsetNode)) {
      range = document.createRange();
      range.setStart(hit.offsetNode, hit.offset);
    }
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(title);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

// ---------------------------------------------------------------------------
// The document's side
// ---------------------------------------------------------------------------

/**
 * The caret, when it sits in the page's first block with no text anywhere
 * above it — the only place the title is "the line above".
 */
function caretAtTop(state: EditorState) {
  const { $cursor } = state.selection as TextSelection;
  if (!$cursor || $cursor.depth < 3 || $cursor.index(1) !== 0) return null;
  return Selection.findFrom(state.doc.resolve($cursor.before()), -1, true) ? null : $cursor;
}

/**
 * Backspace in an empty first paragraph: the paragraph goes and the caret rises
 * into the title. On a page with nothing else, the one line stays — the page
 * would only grow it back — and the caret still rises.
 */
export const dropEmptyFirstBlock: Command = (state, dispatch) => {
  const $cursor = caretAtTop(state);
  if (
    !$cursor ||
    $cursor.depth !== 3 ||
    $cursor.node(2).childCount !== 1 ||
    $cursor.parent.type.name !== "paragraph" ||
    $cursor.parent.content.size !== 0
  ) {
    return false;
  }
  if (dispatch && $cursor.node(1).childCount > 1) {
    dispatch(state.tr.delete($cursor.before(2), $cursor.after(2)));
  }
  return true;
};

/** ArrowUp on the page's first line of text. */
function leavesUpward(view: EditorView): boolean {
  return !!caretAtTop(view.state) && view.endOfTextblock("up");
}

export const titleBoundaryExtension = createExtension({
  key: "nt-title-boundary",
  keyboardShortcuts: {
    ArrowUp: ({ editor }) => {
      const view = editor.prosemirrorView;
      // An open menu owns the arrows; it only prevents their default.
      if (!view || editor.getExtension(SuggestionMenu)?.shown()) return false;
      const title = titleOf(view.dom);
      if (!title || !leavesUpward(view)) return false;
      focusTitle(title, view.coordsAtPos(view.state.selection.head).left);
      return true;
    },
    Backspace: ({ editor }) => {
      const view = editor.prosemirrorView;
      const title = view && titleOf(view.dom);
      if (!title || !dropEmptyFirstBlock(view.state, view.dispatch)) return false;
      focusTitle(title);
      return true;
    },
  },
});
