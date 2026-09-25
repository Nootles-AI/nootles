import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { schema } from "../app/components/editor/schema";
import { completionExtension } from "../app/components/editor/ai/completionExtension";
import { hintExtension } from "../app/components/editor/ai/hintText";
import { reviewExtension } from "../app/components/editor/ai/reviewExtension";
import { arrivalFlashExtension } from "../app/components/editor/arrivalFlash";
import { blockSelectionExtension } from "../app/components/editor/blockSelection";
import { commentExtension } from "../app/components/editor/comments/commentExtension";
import { inlineShortcutsExtension } from "../app/components/editor/inlineShortcutsExtension";
import { pasteHandler, plainPasteExtension } from "../app/components/editor/paste";
import { useTextUndoDomain, type UndoHostEditor } from "../app/lib/history/textDomain";
import {
  undoScope,
  useWorkspaceHistory,
  WorkspaceHistoryProvider,
} from "../app/lib/history/useWorkspaceHistory";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

// The production list, from `Editor.tsx`.
const EXTENSIONS = [
  completionExtension,
  reviewExtension,
  hintExtension,
  arrivalFlashExtension,
  blockSelectionExtension,
  commentExtension,
  inlineShortcutsExtension,
  plainPasteExtension,
];

type Editor = typeof schema.BlockNoteEditor;
type Pipeline = "yjs" | "legacy";

let root: Root | undefined;
let editor: Editor;
let mounts = 0;

function YjsPage({ editor }: { editor: Editor }) {
  const spine = useWorkspaceHistory();
  useTextUndoDomain(spine, editor as unknown as UndoHostEditor, "doc", "page");
  return (
    <div {...undoScope}>
      <BlockNoteView editor={editor} theme="light" className="nt-editor" sideMenu={false} slashMenu={false} formattingToolbar={false} />
    </div>
  );
}

function mount(pipeline: Pipeline) {
  root?.unmount();
  root = createRoot(document.getElementById("app")!);
  if (pipeline === "legacy") {
    editor = BlockNoteEditor.create({ schema, extensions: EXTENSIONS, pasteHandler }) as unknown as Editor;
    root.render(<BlockNoteView editor={editor} theme="light" className="nt-editor" sideMenu={false} slashMenu={false} formattingToolbar={false} />);
    return;
  }
  const doc = new Y.Doc();
  // The composition from `useYjsEditor.ts`.
  editor = BlockNoteEditor.create(
    withCollaboration({
      schema,
      extensions: EXTENSIONS,
      pasteHandler,
      collaboration: {
        fragment: doc.getXmlFragment("prosemirror"),
        user: { name: "Local", color: "#3366cc" },
        provider: { awareness: new Awareness(doc) },
      },
    } as never),
  ) as unknown as Editor;
  root.render(
    <WorkspaceHistoryProvider projectId={`project-${++mounts}`}>
      <YjsPage editor={editor} />
    </WorkspaceHistoryProvider>,
  );
}

type Inline = { type: string; text?: string; styles?: Record<string, unknown>; props?: Record<string, unknown> };

/** Each block's type and its inline content as `text[style,style]` / `<math x^2>` runs. */
function summarize() {
  return editor.document.map((block) => {
    const runs = Array.isArray(block.content)
      ? (block.content as Inline[]).map((inline) =>
          inline.type === "text"
            ? inline.text + (Object.keys(inline.styles ?? {}).length ? `[${Object.keys(inline.styles!).join(",")}]` : "")
            : `<${inline.type}${inline.props?.latex !== undefined ? ` ${inline.props.latex}` : ""}>`,
        )
      : null;
    return { type: block.type, ...(block.type === "numberedListItem" ? { start: (block.props as { start?: number }).start ?? 1 } : {}), runs };
  });
}

/**
 * A paste as the platform delivers one — for Chrome on a Mac that is never
 * for ⌘⇧V, so this is how the chord's other half (Windows, Linux) is driven.
 */
function paste(flavours: Record<string, string>, chord = false) {
  const target = editor.prosemirrorView!.dom;
  if (chord) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "V", code: "KeyV", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  }
  const data = new DataTransfer();
  for (const [type, value] of Object.entries(flavours)) data.setData(type, value);
  target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}

const harness = {
  mount,
  document: summarize,
  paste,
  focusEnd: () => {
    editor.focus();
    const last = editor.document.at(-1)!;
    editor.setTextCursorPosition(last, "end");
  },
};

declare global {
  interface Window {
    typingPaste: typeof harness;
  }
}
window.typingPaste = harness;
