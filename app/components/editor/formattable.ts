import { TextSelection, type Selection } from "prosemirror-state";

/**
 * Whether the formatting toolbar would have any button to show for a selection:
 * it reaches text, or it is a single file block (image, file, audio, video),
 * whose caption, replace, rename and download buttons live there.
 *
 * BlockNote opens its toolbar for any selection that is not empty, then lets
 * each button hide itself when it has nothing to act on. A node selection on a
 * divider (or a diagram, or a run of them) therefore opened a toolbar with
 * nothing in it but the buttons that never learned to hide — the inline-code
 * button alone, floating over the line above and swallowing its clicks. Asking
 * once, here, keeps the toolbar shut for all of them.
 *
 * Empty is answered too, though BlockNote would close for it anyway: its store
 * catches up a render after the selection does, and without this a caret
 * leaving a selected divider flashed the toolbar on the way out. A text
 * selection is otherwise BlockNote's to judge.
 */
export function hasToolbarWork(selection: Selection): boolean {
  if (selection.empty) return false;
  if (selection instanceof TextSelection) return true;
  let text = false;
  let blocks = 0;
  let file = false;
  selection.content().content.descendants((node) => {
    if (node.inlineContent) text = true;
    if (node.type.isInGroup("blockContent")) {
      blocks++;
      // BlockNote's file buttons each ask for a `url` prop on a lone block.
      file = "url" in node.attrs;
    }
    return !text;
  });
  return text || (blocks === 1 && file);
}
