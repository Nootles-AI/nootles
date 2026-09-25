import { TextSelection, type Selection } from "prosemirror-state";

/**
 * Whether a selection reaches any text the formatting toolbar could act on.
 *
 * BlockNote opens its toolbar for any selection that is not empty, then lets
 * each button hide itself when no selected block has inline content. A node
 * selection on a divider (or a diagram, or a run of them) therefore opens a
 * toolbar with nothing in it but the buttons that never learned to hide — the
 * inline-code button alone, floating over the line above and swallowing its
 * clicks. Asking once, here, keeps the toolbar shut for all of them.
 *
 * Empty is answered too, though BlockNote would close for it anyway: its store
 * catches up a render after the selection does, and without this a caret
 * leaving a selected divider flashed the toolbar on the way out. A text
 * selection is otherwise BlockNote's to judge.
 */
export function hasFormattableText(selection: Selection): boolean {
  if (selection.empty) return false;
  if (selection instanceof TextSelection) return true;
  let found = false;
  selection.content().content.descendants((node) => {
    if (node.inlineContent) found = true;
    return !found;
  });
  return found;
}
