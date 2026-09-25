import type { EditorState } from "@codemirror/state";

/**
 * Where a key pressed inside a code block sends the caret, when it sends it out.
 *
 * - `previous` / `next`: the block before or after, as the arrow keys would
 *   between any two lines of the page.
 * - `select`: the code block itself, as a whole-block selection.
 * - `unwrap`: the block, emptied of code, becomes a paragraph in place.
 */
export type CodeExit = "previous" | "next" | "select" | "unwrap";

export const EXIT_KEYS = [
  "ArrowUp",
  "ArrowLeft",
  "ArrowDown",
  "ArrowRight",
  "Escape",
  "Backspace",
] as const;

export type ExitKey = (typeof EXIT_KEYS)[number];

/**
 * Which exit `key` takes from `state`, or `null` when the key belongs to
 * CodeMirror. Notion's edges: the arrows leave from the first or last line (or
 * the very start or end), Escape always leaves, and Backspace in an empty block
 * gives it back as text. A selection that spans characters, or several carets,
 * is never an edge — the key collapses or edits it first.
 *
 * Lines here are document lines, which is only right because the code block
 * never wraps: a long line scrolls sideways, so each is one row on screen.
 */
export function codeExit(key: ExitKey, state: EditorState): CodeExit | null {
  if (key === "Escape") return "select";
  const { ranges, main } = state.selection;
  if (ranges.length > 1 || !main.empty) return null;
  const doc = state.doc;
  switch (key) {
    case "ArrowUp":
      return doc.lineAt(main.head).number === 1 ? "previous" : null;
    case "ArrowLeft":
      return main.head === 0 ? "previous" : null;
    case "ArrowDown":
      return doc.lineAt(main.head).number === doc.lines ? "next" : null;
    case "ArrowRight":
      return main.head === doc.length ? "next" : null;
    case "Backspace":
      return doc.length === 0 ? "unwrap" : null;
  }
}
