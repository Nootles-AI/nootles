import { createRoot, type Root } from "react-dom/client";
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { SuggestionMenuController } from "@blocknote/react";
import { schema } from "../app/components/editor/schema";
import { blockSelection, blockSelectionExtension } from "../app/components/editor/blockSelection";
import { trailingParagraphExtension } from "../app/components/editor/trailingParagraph";
import { enterCodeBlock, insertCodeBlock } from "../app/components/editor/blocks/codeBlockKeys";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

type Editor = typeof schema.BlockNoteEditor;
type PartialBlock = typeof schema.PartialBlock;

let root: Root | undefined;
let editor: Editor;

function mount(initialContent: PartialBlock[], trailing = true) {
  editor = BlockNoteEditor.create({
    schema,
    initialContent,
    extensions: [
      blockSelectionExtension,
      ...(trailing ? [trailingParagraphExtension({ enabled: () => true })] : []),
    ],
  }) as Editor;
  root ??= createRoot(document.getElementById("app")!);
  root.render(
    <BlockNoteView editor={editor} theme="light" className="nt-editor" sideMenu={false} slashMenu={false} formattingToolbar={false}>
      {/* The app's item for a code block, alone: the rest of the menu is Editor.tsx's. */}
      <SuggestionMenuController
        triggerCharacter="/"
        getItems={async () => [{ title: "Code block", onItemClick: () => insertCodeBlock(editor) }]}
      />
    </BlockNoteView>,
  );
}

type Summary = { id: string; type: string; text: string | null; code?: string; language?: string };

const harness = {
  mount,
  document: (): Summary[] =>
    editor.document.map((block) => ({
      id: block.id,
      type: block.type,
      text: Array.isArray(block.content)
        ? (block.content as { text?: string }[]).map((c) => c.text ?? "").join("")
        : null,
      ...(block.type === "codeBlock"
        ? { code: block.props.code as string, language: block.props.language as string }
        : {}),
    })),
  /** Where the keyboard is: a code block's editor (by block), the document (by caret block), or elsewhere. */
  focus: () => {
    const active = document.activeElement;
    const code = active?.closest(".cm-editor");
    if (code) {
      return { in: "code", block: code.closest("[data-id]")?.getAttribute("data-id") ?? null, text: code.querySelector(".cm-content")?.textContent ?? "" };
    }
    if (active?.classList.contains("ProseMirror")) {
      const selected = blockSelection(editor).getSnapshot().ids;
      if (selected.length) return { in: "blocks", ids: [...selected] };
      const { block } = editor.getTextCursorPosition();
      const { $from } = editor.prosemirrorState.selection;
      return { in: "doc", block: block.id, offset: $from.parentOffset };
    }
    return { in: active?.tagName ?? null };
  },
  /** Put the caret into a code block by the app's own way in. */
  enter: (id: string, at: "start" | "end") => enterCodeBlock(editor, id, at),
  caretTo: (id: string, at: "start" | "end") => {
    editor.setTextCursorPosition(id, at);
    editor.focus();
  },
  undo: () => editor.undo(),
};

declare global {
  interface Window {
    codeHarness: typeof harness;
  }
}
window.codeHarness = harness;

mount([{ type: "paragraph", content: "Ready" }]);
