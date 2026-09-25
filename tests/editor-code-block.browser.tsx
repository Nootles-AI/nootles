import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { SuggestionMenuController } from "@blocknote/react";
import { schema } from "../app/components/editor/schema";
import { blockSelection, blockSelectionExtension } from "../app/components/editor/blockSelection";
import { trailingParagraphExtension } from "../app/components/editor/trailingParagraph";
import { enterCodeBlock, insertCodeBlock } from "../app/components/editor/blocks/codeBlockKeys";
import { useTextUndoDomain, type UndoHostEditor } from "../app/lib/history/textDomain";
import { undoScope, useWorkspaceHistory, WorkspaceHistoryProvider } from "../app/lib/history/useWorkspaceHistory";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

type Editor = typeof schema.BlockNoteEditor;
type PartialBlock = typeof schema.PartialBlock;

let root: Root | undefined;
let editor: Editor;
let mounts = 0;

function View({ editor }: { editor: Editor }) {
  return (
    <BlockNoteView editor={editor} theme="light" className="nt-editor" sideMenu={false} slashMenu={false} formattingToolbar={false}>
      {/* The app's item for a code block, alone: the rest of the menu is Editor.tsx's. */}
      <SuggestionMenuController
        triggerCharacter="/"
        getItems={async () => [{ title: "Code block", onItemClick: () => insertCodeBlock(editor) }]}
      />
    </BlockNoteView>
  );
}

/** The document on the workspace's ⌘Z timeline, as `Editor.tsx` puts a Yjs page there. */
function SharedPage({ editor }: { editor: Editor }) {
  const spine = useWorkspaceHistory();
  useTextUndoDomain(spine, editor as unknown as UndoHostEditor, "doc", "page");
  return (
    <div {...undoScope}>
      <View editor={editor} />
    </div>
  );
}

const extensions = (trailing: boolean) => [
  blockSelectionExtension,
  ...(trailing ? [trailingParagraphExtension({ enabled: () => true })] : []),
];

function mount(initialContent: PartialBlock[], trailing = true) {
  editor = BlockNoteEditor.create({ schema, initialContent, extensions: extensions(trailing) }) as Editor;
  root ??= createRoot(document.getElementById("app")!);
  root.render(<View editor={editor} />);
}

/**
 * The page bound to a Y.Doc, with ⌘Z on the workspace spine: the undo the app
 * runs, rather than BlockNote's own. `seed` then fills it off the timeline, as
 * a page arrives from the server.
 */
function mountShared() {
  root?.unmount();
  root = undefined;
  const doc = new Y.Doc();
  editor = BlockNoteEditor.create(
    withCollaboration({
      schema,
      extensions: extensions(true),
      collaboration: { fragment: doc.getXmlFragment("prosemirror"), user: { name: "Local", color: "#3366cc" } },
    } as never),
  ) as unknown as Editor;
  root = createRoot(document.getElementById("app")!);
  root.render(
    <WorkspaceHistoryProvider projectId={`project-${++mounts}`}>
      <SharedPage editor={editor} />
    </WorkspaceHistoryProvider>,
  );
}

function seed(content: PartialBlock[]) {
  editor.transact((tr) => {
    tr.setMeta("addToHistory", false);
    editor.replaceBlocks(editor.document, content);
  });
}

type Summary = { id: string; type: string; text: string | null; code?: string; language?: string };

const harness = {
  mount,
  mountShared,
  seed,
  document: (): Summary[] =>
    editor.document.map((block) => ({
      id: block.id,
      type: block.type,
      text: Array.isArray(block.content)
        ? (block.content as { text?: string; props?: { title?: string } }[])
            .map((c) => c.text ?? (c.props?.title !== undefined ? `@${c.props.title}` : ""))
            .join("")
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
  /** The caret's left edge on screen, wherever the keyboard is. */
  caretX: () => {
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    return (range.getClientRects()[0] ?? range.getBoundingClientRect()).left;
  },
  selectBlocks: (ids: string[]) => blockSelection(editor).select(ids),
  selectText: (fromId: string, toId: string) => {
    editor.setSelection(fromId, toId);
    editor.focus();
  },
};

declare global {
  interface Window {
    codeHarness: typeof harness;
  }
}
window.codeHarness = harness;

mount([{ type: "paragraph", content: "Ready" }]);
