import { createExtension } from "@blocknote/core";
import { Selection, TextSelection, type Command } from "prosemirror-state";
import {
  addRowAfter,
  goToNextCell,
  isInTable,
  selectionCell,
} from "prosemirror-tables";

/**
 * Tab from a table's last cell grows the table by a row and starts writing in
 * it. BlockNote's Tab walks cells and swallows the key at the last one, so the
 * way to keep typing down a table was the + handle under it.
 *
 * The row is added by the same prosemirror-tables command that handle runs.
 */
export const appendRowFromLastCell: Command = (state, dispatch) => {
  if (!isInTable(state) || goToNextCell(1)(state)) return false;
  const $cell = selectionCell(state);
  return addRowAfter(
    state,
    dispatch &&
      ((tr) => {
        // The new row is inserted exactly where the old last row ended.
        const rowStart = tr.mapping.map($cell.after(), -1);
        const firstCell = TextSelection.near(tr.doc.resolve(rowStart + 1));
        dispatch(tr.setSelection(firstCell).scrollIntoView());
      }),
  );
};

/**
 * Backspace at the start of a written line directly below a table steps into
 * the table's last cell.
 *
 * BlockNote already does that for an EMPTY line — it removes the line and
 * lands in that cell — and it deletes any other content-less block above a
 * line outright, but it exempts tables from that, so a written line's
 * Backspace fell through every rule and did nothing.
 *
 * Only a top-level paragraph: a heading reverts to a paragraph first and a
 * nested line outdents first, both BlockNote's, and this runs ahead of them.
 */
export const caretIntoTableAbove: Command = (state, dispatch) => {
  const { $cursor } = state.selection as TextSelection;
  if (
    !$cursor ||
    $cursor.depth !== 3 ||
    $cursor.parentOffset !== 0 ||
    $cursor.parent.type.name !== "paragraph" ||
    $cursor.parent.content.size === 0
  ) {
    return false;
  }
  const $block = state.doc.resolve($cursor.before(2));
  const above = $block.nodeBefore;
  if (above?.childCount !== 1 || above.firstChild?.type.name !== "table") {
    return false;
  }
  const lastCell = Selection.findFrom($block, -1, true);
  if (!lastCell) return false;
  dispatch?.(state.tr.setSelection(lastCell).scrollIntoView());
  return true;
};

export const tableKeysExtension = createExtension({
  key: "nt-table-keys",
  keyboardShortcuts: {
    Tab: ({ editor }) => {
      const view = editor.prosemirrorView;
      return !!view && appendRowFromLastCell(view.state, view.dispatch);
    },
    Backspace: ({ editor }) => {
      const view = editor.prosemirrorView;
      return !!view && caretIntoTableAbove(view.state, view.dispatch);
    },
  },
});
