"use client";

import {
  SideMenu,
  SideMenuController,
  AddBlockButton,
  DragHandleButton,
  DragHandleMenu,
  BlockColorsItem,
  useBlockNoteEditor,
  useComponentsContext,
} from "@blocknote/react";

/* BlockNote's side menu is context-driven — it passes no block/editor via
   props. Clicking the drag handle moves the text cursor to that block, so the
   built-in items (and ours) read the target via getTextCursorPosition(). The
   side-menu prop types are also incomplete, hence the `Any` casts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function copyBlock(editor: Any, block: Any) {
  const [html, md] = await Promise.all([
    editor.blocksToHTMLLossy([block]),
    editor.blocksToMarkdownLossy([block]),
  ]);
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([md], { type: "text/plain" }),
    }),
  ]);
}

function duplicateBlock(editor: Any, block: Any) {
  // Strip the id so BlockNote assigns a fresh one to the copy.
  const { id: _id, ...copy } = block;
  editor.insertBlocks([copy], block.id, "after");
}

function CustomDragHandleMenu() {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext()!;
  const currentBlock = () => (editor as Any).getTextCursorPosition().block;

  return (
    <DragHandleMenu>
      <Components.Generic.Menu.Item onClick={() => duplicateBlock(editor, currentBlock())}>
        Duplicate
      </Components.Generic.Menu.Item>
      <Components.Generic.Menu.Item onClick={() => void copyBlock(editor, currentBlock())}>
        Copy
      </Components.Generic.Menu.Item>
      <BlockColorsItem>Colors</BlockColorsItem>
      <Components.Generic.Menu.Item onClick={() => editor.removeBlocks([currentBlock().id])}>
        Delete
      </Components.Generic.Menu.Item>
    </DragHandleMenu>
  );
}

export function BlockSideMenu() {
  return (
    <SideMenuController
      sideMenu={(props: Any) => (
        <SideMenu {...props}>
          <AddBlockButton {...props} />
          <DragHandleButton {...props} dragHandleMenu={() => <CustomDragHandleMenu />} />
        </SideMenu>
      )}
    />
  );
}
