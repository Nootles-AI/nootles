import {
  getNodeById,
  insertOrUpdateBlockForSlashMenu,
  type BlockNoteEditor,
} from "@blocknote/core";
import { NodeSelection, Selection } from "prosemirror-state";
import { blockSelection } from "../blockSelection";
import type { CodeExit } from "../codemirror/exits";
import { focusCodeBlock, type CodeCaret } from "../codemirror/focusRequests";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;

/** Put the caret into block `id`'s code, now or as soon as its editor mounts. */
export function enterCodeBlock(editor: Editor, id: string, at: CodeCaret): void {
  const view = editor.prosemirrorView;
  if (view) focusCodeBlock(view.dom, id, at);
}

/**
 * The slash menu's code block. BlockNote's own item leaves the caret in the
 * next text block down, because ProseMirror cannot hold one in a block without
 * text — so what was typed next landed below the block it was meant for.
 */
export function insertCodeBlock(editor: Editor): void {
  const block = insertOrUpdateBlockForSlashMenu(editor, { type: "codeBlock" });
  enterCodeBlock(editor, block.id, "start");
}

/**
 * Take the caret out of code block `id` the way `exit` says (see `codeExit`).
 * False when there is nowhere to go, so the key stays CodeMirror's.
 *
 * The arrows go to the neighbour in document order, nesting included, and
 * treat it as a click would: text takes the caret, another code block takes
 * it in its own editor, and a block with no text — a diagram, an image — is
 * selected whole rather than left holding an invisible node selection.
 */
export function leaveCodeBlock(editor: Editor, id: string, exit: CodeExit): boolean {
  const view = editor.prosemirrorView;
  if (!view) return false;

  if (exit === "select") {
    blockSelection(editor).select([id]);
    return true;
  }
  if (exit === "unwrap") {
    editor.transact(() => {
      editor.updateBlock(id, { type: "paragraph" });
      editor.setTextCursorPosition(id, "start");
    });
    editor.focus();
    return true;
  }

  const { doc } = view.state;
  const found = getNodeById(id, doc);
  const content = found?.node.firstChild;
  if (!found || !content) return false;
  const back = exit === "previous";
  const $edge = doc.resolve(
    back ? found.posBeforeNode : found.posBeforeNode + 1 + content.nodeSize,
  );
  const target = Selection.findFrom($edge, back ? -1 : 1);

  if (!target) {
    if (back) return false;
    // Nothing below to take the caret: Notion makes a line to write on.
    editor.transact(() => {
      const [paragraph] = editor.insertBlocks([{ type: "paragraph" }], id, "after");
      editor.setTextCursorPosition(paragraph, "start");
    });
    editor.focus();
    return true;
  }
  if (target instanceof NodeSelection) {
    const neighbour: unknown = target.$from.parent.attrs.id;
    if (typeof neighbour !== "string") return false;
    if (target.node.type.name === "codeBlock") {
      enterCodeBlock(editor, neighbour, back ? "end" : "start");
    } else {
      blockSelection(editor).select([neighbour]);
    }
    return true;
  }
  view.dispatch(
    view.state.tr
      .setSelection(target)
      .scrollIntoView()
      .setMeta("addToHistory", false),
  );
  view.focus();
  return true;
}
