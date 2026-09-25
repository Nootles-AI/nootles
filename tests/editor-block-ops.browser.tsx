import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { schema } from "../app/components/editor/schema";
import { completionExtension } from "../app/components/editor/ai/completionExtension";
import { hintExtension } from "../app/components/editor/ai/hintText";
import { reviewExtension } from "../app/components/editor/ai/reviewExtension";
import { arrivalFlashExtension } from "../app/components/editor/arrivalFlash";
import {
  BLOCK_SELECTED_CLASS,
  BlockRangeSelection,
  blockSelection,
  blockSelectionExtension,
} from "../app/components/editor/blockSelection";
import { blockKeysExtension } from "../app/components/editor/blockKeys";
import { BlockSideMenu, editorPortalElements } from "../app/components/editor/BlockSideMenu";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

// The production list, from `Editor.tsx`, less the comment layer.
const EXTENSIONS = [
  completionExtension,
  reviewExtension,
  hintExtension,
  arrivalFlashExtension,
  blockSelectionExtension,
  blockKeysExtension,
];

type Editor = typeof schema.BlockNoteEditor;
type Block = Editor["document"][number];

let root: Root | undefined;
let editor: Editor;
let copied: string | null = null;

document.addEventListener("copy", (event) => {
  copied = event.clipboardData?.getData("text/plain") ?? null;
});
document.addEventListener("cut", (event) => {
  copied = event.clipboardData?.getData("text/plain") ?? null;
});

function Surface({ editor }: { editor: Editor }) {
  return (
    <main id="pane" style={{ height: "100vh", overflow: "auto" }}>
      <div style={{ maxWidth: 760, padding: "80px 56px", boxSizing: "border-box" }}>
        <BlockNoteView
          editor={editor}
          theme="light"
          className="nt-editor"
          sideMenu={false}
          slashMenu={false}
          formattingToolbar={false}
          portalElements={editorPortalElements}
        >
          <BlockSideMenu />
        </BlockNoteView>
      </div>
      <button id="outside">outside</button>
    </main>
  );
}

function mount() {
  root?.unmount();
  const doc = new Y.Doc();
  editor = BlockNoteEditor.create(
    withCollaboration({
      schema,
      extensions: EXTENSIONS,
      collaboration: {
        fragment: doc.getXmlFragment("prosemirror"),
        user: { name: "Local", color: "#3366cc" },
        provider: { awareness: new Awareness(doc) },
      },
    } as never),
  ) as unknown as Editor;
  root = createRoot(document.getElementById("app")!);
  root.render(<Surface editor={editor} />);
}

const view = (): EditorView => (editor as unknown as { prosemirrorView: EditorView }).prosemirrorView;

/** Every block with its nesting depth, parents before their children. */
function nested(): { block: Block; depth: number }[] {
  const out: { block: Block; depth: number }[] = [];
  const walk = (blocks: readonly Block[], depth: number) => {
    for (const block of blocks) {
      out.push({ block, depth });
      walk(block.children as Block[], depth + 1);
    }
  };
  walk(editor.document, 0);
  return out;
}

const flat = (): Block[] => nested().map((entry) => entry.block);

type Inline = { type: string; text?: string; content?: Inline[] };
function textOf(block: Block): string | null {
  if (!Array.isArray(block.content)) {
    const code = (block.props as { code?: string }).code;
    return typeof code === "string" ? code : null;
  }
  return (block.content as Inline[])
    .flatMap((part) => (part.type === "link" ? part.content ?? [] : [part]))
    .map((part) => part.text ?? "")
    .join("");
}

function contentOf(index: number): Element | null {
  const id = flat()[index]?.id;
  return document.querySelector(`[data-id="${id}"] .bn-inline-content`);
}

const harness = {
  mount,
  seed: (blocks: unknown[]) => editor.replaceBlocks(editor.document, blocks as never),
  count: () => flat().length,
  texts: () => flat().map(textOf),
  types: () => flat().map((block) => block.type as string),
  levels: () => flat().map((block) => (block.props as { level?: number }).level ?? null),
  depths: () => nested().map((entry) => entry.depth),
  ids: () => flat().map((block) => block.id),
  /** Viewport point of character `offset` inside block `index`'s text. */
  textPoint: (index: number, offset: number) => {
    const content = contentOf(index);
    if (!content) return null;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let left = offset;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent!.length;
      if (left <= length) {
        const range = document.createRange();
        range.setStart(node, left);
        range.collapse(true);
        const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
        return { x: rect.left + 1, y: rect.top + rect.height / 2 };
      }
      left -= length;
    }
    const r = content.getBoundingClientRect();
    return { x: r.left + 2, y: r.top + r.height / 2 };
  },
  blockRect: (index: number) => {
    const id = flat()[index]?.id;
    const r = document.querySelector(`[data-id="${id}"]`)!.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  },
  /** Put the caret at `offset` in block `index`, as a click would. */
  caret: (index: number, offset: number) => {
    const id = flat()[index].id;
    let start = -1;
    view().state.doc.descendants((node, pos) => {
      if (start >= 0) return false;
      if (node.type.name === "blockContainer" && node.attrs.id === id) start = pos + 2;
      return true;
    });
    view().dispatch(view().state.tr.setSelection(TextSelection.create(view().state.doc, start + offset)));
    view().focus();
  },
  selection: () => {
    const { state } = view();
    const s = state.selection;
    const flatIds = flat().map((block) => block.id);
    return {
      kind: s instanceof BlockRangeSelection ? "block" : s instanceof TextSelection ? "text" : "other",
      empty: s.empty,
      text: state.doc.textBetween(s.from, s.to, "\n"),
      // Which block the caret's text is in, by reading-order index.
      caretBlock: (() => {
        for (let d = s.$head.depth; d > 0; d--) {
          const node = s.$head.node(d);
          if (node.type.name === "blockContainer") return flatIds.indexOf(node.attrs.id);
        }
        return -1;
      })(),
      caretOffset: s.$head.parentOffset,
      selected: (s instanceof BlockRangeSelection ? s.blockIds : []).map((id) => flatIds.indexOf(id)),
      focused: view().hasFocus(),
    };
  },
  plates: () => document.querySelectorAll(`.${BLOCK_SELECTED_CLASS}`).length,
  selectBlocks: (indexes: number[]) => {
    const ids = flat().map((block) => block.id);
    blockSelection(editor).select(indexes.map((i) => ids[i]));
  },
  activeIsEditor: () => document.activeElement === view().dom,
  takeCopied: () => {
    const text = copied;
    copied = null;
    return text;
  },
};

declare global {
  interface Window {
    blockOps: typeof harness;
  }
}
window.blockOps = harness;
