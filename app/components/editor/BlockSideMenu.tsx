"use client";

import {
  SideMenu,
  SideMenuController,
  AddBlockButton,
  DragHandleButton,
  DragHandleMenu,
  BlockColorsItem,
  RemoveBlockItem,
  useBlockNoteEditor,
  useComponentsContext,
  useExtensionState,
} from "@blocknote/react";
import { SideMenuExtension } from "@blocknote/core/extensions";

/* BlockNote's side menu is context-driven — it passes no block via props. The
   target comes from the side-menu extension's own state, which is what the
   built-in items read.

   It must NOT come from getTextCursorPosition(): code, math and diagram blocks
   hold no editable content, so a text cursor can never land in one. Asking for
   the cursor's block while hovering a code block returns a NEIGHBOUR, and the
   menu then deletes or duplicates that instead. The side-menu prop types are
   incomplete, hence the `Any` casts. */
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
  const block = useExtensionState(SideMenuExtension, {
    editor,
    selector: (s) => s?.block,
  }) as Any;

  if (!block) return null;

  return (
    <DragHandleMenu>
      <Components.Generic.Menu.Item onClick={() => duplicateBlock(editor, block)}>
        Duplicate
      </Components.Generic.Menu.Item>
      <Components.Generic.Menu.Item onClick={() => void copyBlock(editor, block)}>
        Copy
      </Components.Generic.Menu.Item>
      <BlockColorsItem>Colors</BlockColorsItem>
      {/* BlockNote's own item — it also removes a whole multi-block selection
          when the hovered block is part of one. */}
      <RemoveBlockItem>Delete</RemoveBlockItem>
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
