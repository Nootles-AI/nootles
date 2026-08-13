import { createExtension } from "@blocknote/core";
import type { BlockNoteEditor } from "@blocknote/core";

/**
 * Backspace on an empty list item closes the list up.
 *
 * BlockNote's Backspace chain strips a block's type before it merges anything:
 * at the start of a checkbox line the first press turns it into a paragraph,
 * and only the second pulls the line below up. On a line you still have text on
 * that step is the point — you keep the words and drop the checkbox. On a line
 * you have just emptied there is nothing left to keep, so it is a keystroke
 * spent watching a marker disappear from a line that stays exactly where it
 * was: the list looks like it refused to close.
 *
 * So an empty list item skips straight to the merge. Nothing else about
 * Backspace moves — a list item with text still un-lists first, and an indented
 * one still outdents first, because there the press has something to do.
 */

/** Kinds whose only content on an empty line is the marker itself. */
const LIST_TYPES = new Set([
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "toggleListItem",
]);

// The editor is loosely typed everywhere it crosses a schema boundary; see
// EditorRegistry's LiveEditor, which this matches deliberately.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function mergeEmptyListItem(editor: BlockNoteEditor<Any, Any, Any>): boolean {
  if (!editor.prosemirrorState.selection.empty) return false;

  const { block, prevBlock } = editor.getTextCursorPosition();
  if (!LIST_TYPES.has(block.type)) return false;
  // An empty toggle still holds whatever is folded under it.
  if (!Array.isArray(block.content) || block.content.length > 0) return false;
  if (block.children.length > 0) return false;

  // Outdenting is the press's job while there is a level to come out of, and
  // the first block in the document has nothing above it to merge into.
  if (editor.canUnnestBlock() || !prevBlock) return false;
  // The block above has to be able to hold a caret, and its own children would
  // sit between the two — in both cases BlockNote's chain knows better.
  if (!Array.isArray(prevBlock.content) || prevBlock.children.length > 0) {
    return false;
  }

  // One transaction, so the removal and the caret are one undo step.
  editor.transact(() => {
    editor.removeBlocks([block]);
    editor.setTextCursorPosition(prevBlock, "end");
  });
  return true;
}

export const listBackspaceExtension = createExtension({
  key: "nt-list-backspace",
  keyboardShortcuts: {
    Backspace: ({ editor }) => mergeEmptyListItem(editor),
  },
});
