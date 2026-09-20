import { useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { FormattingToolbarController } from "@blocknote/react";
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
import { useBlockMarquee } from "../app/components/editor/useBlockMarquee";
import { remoteScrollExtension } from "../app/lib/sync/remoteScroll";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

// The production list, from `Editor.tsx`.
const EXTENSIONS = [
  completionExtension,
  reviewExtension,
  hintExtension,
  arrivalFlashExtension,
  blockSelectionExtension,
];

type Editor = typeof schema.BlockNoteEditor;
type Block = Editor["document"][number];

let root: Root | undefined;
let editor: Editor;
let copied: string | null = null;

document.addEventListener("copy", (event) => {
  copied = event.clipboardData?.getData("text/plain") ?? null;
});

/** `EditorSurface`'s wrapper, inside `PageSurface`'s pane and column. */
function Surface({ editor }: { editor: Editor }) {
  const surface = useRef<HTMLDivElement>(null);
  const selected = blockSelection(editor);
  useBlockMarquee({ surfaceRef: surface, selection: selected, enabled: true });
  return (
    <main id="pane" className="nt-pane" style={{ height: "100vh", overflow: "auto", display: "flex", flexDirection: "column" }}>
      <div style={{ maxWidth: 760, width: "100%", padding: "80px 56px", flex: 1, display: "flex", flexDirection: "column", boxSizing: "border-box" }}>
        <div style={{ marginTop: 32 }}>
          <div ref={surface} className="nt-marquee-surface">
            <BlockNoteView editor={editor} theme="light" className="nt-editor" sideMenu={false} slashMenu={false} formattingToolbar={false}>
              <FormattingToolbarController />
            </BlockNoteView>
          </div>
        </div>
      </div>
    </main>
  );
}

function mount() {
  root?.unmount();
  const doc = new Y.Doc();
  // The composition from `useYjsEditor.ts`, without a peer: nothing here is
  // about sync, but the transactions under test are the ones y-prosemirror sees.
  editor = BlockNoteEditor.create(
    withCollaboration({
      schema,
      extensions: [...EXTENSIONS, remoteScrollExtension],
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

function seed(blocks: unknown[]) {
  editor.replaceBlocks(editor.document, blocks as never);
}

const view = (): EditorView => (editor as unknown as { prosemirrorView: EditorView }).prosemirrorView;

/** Every block, parents before their children — the order the page reads in. */
function flat(): Block[] {
  const out: Block[] = [];
  const walk = (blocks: readonly Block[]) => {
    for (const block of blocks) {
      out.push(block);
      walk(block.children as Block[]);
    }
  };
  walk(editor.document);
  return out;
}

type Inline = { type: string; text?: string; styles?: { bold?: boolean }; content?: Inline[] };

function inlines(block: Block): Inline[] | null {
  if (!Array.isArray(block.content)) return null;
  return (block.content as Inline[]).flatMap((part) => (part.type === "link" ? part.content ?? [] : [part]));
}

function textOf(block: Block): string | null {
  return inlines(block)?.map((part) => part.text ?? "").join("") ?? null;
}

/** Runs of bold and not-bold text, adjacent runs merged. */
function boldRuns(index: number) {
  const runs: { text: string; bold: boolean }[] = [];
  for (const part of inlines(flat()[index]) ?? []) {
    const bold = !!part.styles?.bold;
    const last = runs[runs.length - 1];
    if (last && last.bold === bold) last.text += part.text ?? "";
    else runs.push({ text: part.text ?? "", bold });
  }
  return runs;
}

function contentOf(index: number): Element | null {
  const id = flat()[index]?.id;
  return document.querySelector(`[data-id="${id}"] .bn-inline-content`);
}

/** Viewport point of character `offset` inside block `index`'s text. */
function textPoint(index: number, offset: number) {
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
      // A pixel into the character, so the browser resolves this boundary
      // rather than the one before it.
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    }
    left -= length;
  }
  return null;
}

function blockRect(index: number) {
  const id = flat()[index]?.id;
  const r = document.querySelector(`[data-id="${id}"]`)!.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}

const harness = {
  mount,
  seed,
  count: () => flat().length,
  ids: () => flat().map((block) => block.id),
  texts: () => flat().map(textOf),
  types: () => flat().map((block) => block.type as string),
  boldRuns,
  textPoint,
  blockRect,
  /** Beside block `index`, out in the page's gutter where the drag handle floats. */
  gutterPoint: (index: number) => {
    const r = blockRect(index);
    return { x: r.left - 28, y: (r.top + r.bottom) / 2 };
  },
  /** The page: the marquee surface's box — the column and both its gutters. */
  pageRect: () => {
    const r = document.querySelector(".nt-marquee-surface")!.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  },
  /** The document's pane. Anchored left, so it is much wider than the page. */
  paneRect: () => {
    const r = document.getElementById("pane")!.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  },
  /** `by` px out past the page's right edge, level with block `index`. */
  besidePage: (index: number, by: number) => {
    const r = blockRect(index);
    const page = document.querySelector(".nt-marquee-surface")!.getBoundingClientRect();
    return { x: page.right + by, y: (r.top + r.bottom) / 2 };
  },
  /** How far right block `index` actually draws, overflow included. */
  blockReach: (index: number) => {
    const id = flat()[index]?.id;
    const el = document.querySelector<HTMLElement>(`[data-id="${id}"]`)!;
    return el.getBoundingClientRect().left + el.scrollWidth;
  },
  /** In the empty room to the right of the last line of block `index`. */
  pastLineEnd: (index: number, by: number) => {
    const content = contentOf(index)!;
    const range = document.createRange();
    range.selectNodeContents(content);
    const rects = range.getClientRects();
    const last = rects[rects.length - 1];
    return { x: last.right + by, y: last.top + last.height / 2 };
  },
  selection: () => {
    const { state, dom } = view();
    const s = state.selection;
    return {
      // By class, not `constructor.name`: the bundle renames colliding classes.
      kind: s instanceof BlockRangeSelection ? "block" : s instanceof TextSelection ? "text" : "other",
      blockRange: s instanceof BlockRangeSelection,
      empty: s.empty,
      anchor: s.anchor,
      head: s.head,
      text: state.doc.textBetween(s.from, s.to, "\n"),
      hidden: dom.classList.contains("ProseMirror-hideselection"),
      focused: view().hasFocus(),
    };
  },
  nativeText: () => window.getSelection()?.toString() ?? "",
  plates: () => document.querySelectorAll(`.${BLOCK_SELECTED_CLASS}`).length,
  selectedIds: () => blockSelection(editor).getSnapshot().ids,
  toolbarShown: () => !!document.querySelector(".bn-formatting-toolbar"),
  bandShown: () => !!document.querySelector(".nt-block-marquee"),
  takeCopied: () => {
    const text = copied;
    copied = null;
    return text;
  },
};

declare global {
  interface Window {
    selectionHarness: typeof harness;
  }
}
window.selectionHarness = harness;
