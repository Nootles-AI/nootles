import { createRoot, type Root } from "react-dom/client";
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { schema } from "../app/components/editor/schema";
import { completionExtension } from "../app/components/editor/ai/completionExtension";
import { hintExtension } from "../app/components/editor/ai/hintText";
import { reviewExtension } from "../app/components/editor/ai/reviewExtension";
import { arrivalFlashExtension } from "../app/components/editor/arrivalFlash";
import { blockSelectionExtension } from "../app/components/editor/blockSelection";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

// The production list, from `Editor.tsx`. The input rules under test are
// collected once at editor construction, so the fixture must build the editor
// the way the app does or it is testing a different rule set.
const EXTENSIONS = [
  completionExtension,
  reviewExtension,
  hintExtension,
  arrivalFlashExtension,
  blockSelectionExtension,
];

type Editor = typeof schema.BlockNoteEditor;
type InitialContent = (typeof schema.PartialBlock)[];

let root: Root | undefined;
let editor: Editor;

function mount(initialContent: InitialContent) {
  root?.unmount();
  editor = BlockNoteEditor.create({
    schema,
    extensions: EXTENSIONS,
    initialContent,
  }) as unknown as Editor;
  root = createRoot(document.getElementById("app")!);
  root.render(<BlockNoteView editor={editor} />);
}

type Summary = {
  id: string;
  type: string;
  level?: number;
  text: string | null;
  children?: Summary[];
};

/** Type, heading level, text and nesting — what a caller of this file asserts on. */
function summarize(blocks: readonly unknown[]): Summary[] {
  return (
    blocks as {
      id: string;
      type: string;
      props: Record<string, unknown>;
      content?: unknown;
      children: unknown[];
    }[]
  ).map((block) => ({
    id: block.id,
    type: block.type,
    ...(block.props.level === undefined ? {} : { level: block.props.level as number }),
    text: Array.isArray(block.content)
      ? (block.content as { type: string; text?: string }[])
          .map((inline) => inline.text ?? `<${inline.type}>`)
          .join("")
      : null,
    ...(block.children.length ? { children: summarize(block.children) } : {}),
  }));
}

const harness = {
  mount,
  document: () => summarize(editor.document),
  /** The ordinal the reader actually sees — the renumbering a split causes is invisible in the model. */
  ordinals: () =>
    [...document.querySelectorAll<HTMLElement>(".bn-block-content")].map((node) => ({
      type: node.getAttribute("data-content-type"),
      marker: getComputedStyle(node, "::before").content,
      text: node.textContent,
    })),
  caretBlockType: () => editor.getTextCursorPosition().block.type as string,
  /** Which block the editor thinks the caret is in. */
  caretIndex: () => {
    const { block } = editor.getTextCursorPosition();
    return editor.document.findIndex((candidate) => candidate.id === block.id);
  },
  /**
   * A point inside the rendered text of block `index`, in viewport coordinates.
   * Clicking the block element's centre is not the same thing: on a list item
   * the centre can fall on the marker gutter, which does not move the caret.
   */
  textPoint: (index: number) => {
    const id = editor.document[index]?.id;
    const content = document.querySelector(`[data-id="${id}"] .bn-block-content`);
    const text = content && document.createTreeWalker(content, NodeFilter.SHOW_TEXT).nextNode();
    if (!text) return null;
    const range = document.createRange();
    range.selectNodeContents(text);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + Math.min(4, rect.width / 2), y: rect.top + rect.height / 2 };
  },
  /** What the slash menu and the block-type dropdown both do. */
  convertToHeading: (level: number) => {
    const { block } = editor.getTextCursorPosition();
    editor.updateBlock(block, { type: "heading", props: { level } } as never);
    return editor.document.map((b) => b.type);
  },
  undo: () => editor.undo(),
};

declare global {
  interface Window {
    h: typeof harness;
  }
}
window.h = harness;

mount([{ type: "paragraph", content: "Ready" }]);
