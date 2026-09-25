import { insertOrUpdateBlockForSlashMenu, type BlockNoteEditor } from "@blocknote/core";
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
