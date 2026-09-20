import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import { BlockNoteView } from "@blocknote/mantine";
import { filterSuggestionItems } from "@blocknote/core";
import { SuggestionMenuController } from "@blocknote/react";
import { schema } from "../app/components/editor/schema";
import { slashItems } from "../app/components/editor/Editor";
import { SlashMenu } from "../app/components/editor/SlashMenu";
import { completionExtension } from "../app/components/editor/ai/completionExtension";
import { hintExtension } from "../app/components/editor/ai/hintText";
import { reviewExtension } from "../app/components/editor/ai/reviewExtension";
import { setReview, type ReviewHunk } from "../app/components/editor/ai/reviewDecorations";
import { arrivalFlashExtension } from "../app/components/editor/arrivalFlash";
import { blockSelectionExtension } from "../app/components/editor/blockSelection";
import { trailingParagraphExtension } from "../app/components/editor/trailingParagraph";
import { ReadOnlyContext } from "../app/components/editor/readOnly";
import type { AnyBlock } from "../app/lib/ai/projection";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

/**
 * NT-41 — a tick box inside a table cell.
 *
 * The production schema, extensions and slash menu, so the box under test is
 * the one a reader gets. `trailingParagraphExtension` is here because every
 * real page ends in an empty paragraph and a table is often the last block.
 */
const EXTENSIONS = [
  completionExtension,
  reviewExtension,
  hintExtension,
  arrivalFlashExtension,
  blockSelectionExtension,
  trailingParagraphExtension({ enabled: () => true }),
];

type Editor = typeof schema.BlockNoteEditor;
type InitialContent = (typeof schema.PartialBlock)[];

let root: Root | undefined;
let editor: Editor;
/** The peer of a collaborative mount — a second replica of the same document. */
let peer: { doc: Y.Doc } | undefined;

function Surface({ readOnly }: { readOnly: boolean }) {
  // The slash menu is BlockNote's controller over OUR item list, exactly as
  // `Editor.tsx` wires it: what is under test is which items that list offers
  // and what their click does, not a re-implementation of either.
  const [items] = useState(() => slashItems(editor as never));
  return (
    <ReadOnlyContext.Provider value={readOnly}>
      <BlockNoteView editor={editor} editable={!readOnly} slashMenu={false}>
        <SuggestionMenuController
          triggerCharacter="/"
          suggestionMenuComponent={SlashMenu}
          getItems={async (query) => filterSuggestionItems(items, query)}
        />
      </BlockNoteView>
    </ReadOnlyContext.Provider>
  );
}

function mount(initialContent: InitialContent, options: { readOnly?: boolean } = {}) {
  root?.unmount();
  peer = undefined;
  editor = BlockNoteEditor.create({
    schema,
    extensions: EXTENSIONS,
    initialContent,
  }) as unknown as Editor;
  root = createRoot(document.getElementById("app")!);
  root.render(<Surface readOnly={options.readOnly ?? false} />);
}

/**
 * The same document open twice over one Y.Doc, the way two people have it.
 *
 * The peer is the Y.Doc itself rather than a second editor: a BlockNote editor
 * with no mounted view never applies what arrives (y-prosemirror dispatches
 * remote updates through the view), so a headless one would read as an empty
 * document however much reached it. The shared tree IS what crosses the wire.
 */
function mountCollaborative(initialContent: InitialContent) {
  root?.unmount();
  const doc = new Y.Doc();
  const other = new Y.Doc();
  // Seeded before either replica opens, the way a stored document arrives.
  const seed = BlockNoteEditor.create({ schema, initialContent }) as unknown as Editor;
  prosemirrorToYXmlFragment(seed.prosemirrorState.doc, doc.getXmlFragment("doc"));
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  doc.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== other) Y.applyUpdate(other, update, doc); });
  other.on("update", (update: Uint8Array, origin: unknown) => { if (origin !== doc) Y.applyUpdate(doc, update, other); });
  // The composition from `useYjsEditor.ts`.
  editor = BlockNoteEditor.create(
    withCollaboration({
      schema,
      extensions: EXTENSIONS,
      collaboration: { fragment: doc.getXmlFragment("doc"), user: { name: "A", color: "#3366cc" } },
    } as never),
  ) as unknown as Editor;
  root = createRoot(document.getElementById("app")!);
  root.render(<Surface readOnly={false} />);
  peer = { doc: other };
}

type RawBlock = {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: unknown;
  children: RawBlock[];
};

type InlineItem = { type: string; text?: string; props?: Record<string, unknown> };

/**
 * A run list as one string: words as themselves, a box as its state.
 * `[ ]`/`[x]` rather than a glyph so a failure message says which box moved.
 */
function runs(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as InlineItem[])
    .map((item) =>
      item.type === "text"
        ? (item.text ?? "")
        : item.type === "checkbox"
          ? (item.props?.checked ? "[x]" : "[ ]")
          : `<${item.type}>`,
    )
    .join("");
}

type TableContent = { rows?: Array<{ cells?: Array<{ content?: unknown } | unknown[]> }> };

/** Every cell of the first table, row by row, read the way `runs` reads a line. */
function grid(from: Editor = editor): string[][] {
  const table = (from.document as unknown as RawBlock[]).find((b) => b.type === "table");
  const content = table?.content as TableContent | undefined;
  return (content?.rows ?? []).map((row) =>
    (row.cells ?? []).map((cell) => runs(Array.isArray(cell) ? cell : (cell as { content?: unknown }).content)),
  );
}

function walk(blocks: RawBlock[], into: RawBlock[] = []): RawBlock[] {
  for (const block of blocks) {
    into.push(block);
    walk(block.children, into);
  }
  return into;
}

const cell = (text: string) => ({
  type: "tableCell" as const,
  content: text ? [{ type: "text" as const, text, styles: {} }] : [],
});

const harness = {
  mount,
  mountCollaborative,
  /**
   * The tracker the reporter asked an agent for. Its cells are empty here,
   * because before NT-41 there was nothing to put in them.
   */
  mountTracker: (options: { readOnly?: boolean } = {}) =>
    mount(
      [
        { type: "heading", props: { level: 1 }, content: "75 Medium Challenge" },
        { type: "paragraph", content: "Daily checklist — start with Day 1 today." },
        {
          type: "table",
          content: {
            type: "tableContent",
            headerRows: 1,
            rows: [
              { cells: [cell("Day"), cell("Water"), cell("Read")] },
              { cells: [cell("1"), cell(""), cell("")] },
              { cells: [cell("2"), cell(""), cell("")] },
            ],
          },
        },
      ] as unknown as InitialContent,
      options,
    ),

  grid: () => grid(),
  /** What the other replica holds, as the shared tree spells it. */
  peerXml: () => peer?.doc.getXmlFragment("doc").toString() ?? null,
  /** Every box in the other replica, ticked or not, in document order. */
  peerBoxes: () =>
    [...(peer?.doc.getXmlFragment("doc").toString() ?? "").matchAll(/<checkbox\b([^>]*)>/g)].map(
      (match) => /checked="true"/.test(match[1]),
    ),
  /** Every block as `type: text`, boxes included — the whole page in one read. */
  rows: (): string[] =>
    walk(editor.document as unknown as RawBlock[]).map(
      (block) => `${block.type}: ${Array.isArray(block.content) ? runs(block.content) : ""}`,
    ),
  ids: () => walk(editor.document as unknown as RawBlock[]).map((b) => b.id),
  blocks: () => JSON.parse(JSON.stringify(editor.document)),

  /** Which block holds the caret. */
  caret: () => {
    const { block } = editor.getTextCursorPosition();
    return { id: block.id as string, type: block.type as string };
  },
  caretOffset: () => editor.prosemirrorState.selection.$from.parentOffset,

  /** A point inside the nth cell of the first table, in viewport coordinates. */
  cellPoint: (n: number, where: "start" | "end" = "end") => {
    const node = [...document.querySelectorAll<HTMLElement>("table td, table th")][n];
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: where === "start" ? box.left + 6 : box.right - 6, y: box.top + box.height / 2 };
  },
  /** A point inside block `id`'s own text, past its last glyph. */
  blockPoint: (id: string) => {
    const container = document.querySelector(`[data-node-type="blockContainer"][data-id="${id}"]`);
    const content = container?.querySelector(".bn-block-content");
    if (!container || !content) return null;
    if (content.closest('[data-node-type="blockContainer"]') !== container) return null;
    const node = document.createTreeWalker(content, NodeFilter.SHOW_TEXT).nextNode();
    if (!node) {
      const box = content.getBoundingClientRect();
      return { x: box.left + 2, y: box.top + box.height / 2 };
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    return { x: rect.right + 3, y: rect.top + rect.height / 2 };
  },

  /** Every box a reader can see, in document order. */
  boxes: () =>
    [...document.querySelectorAll<HTMLInputElement>(".nt-editor input.nt-check-box, .bn-editor input.nt-check-box")].map(
      (node) => ({
        checked: node.checked,
        disabled: node.disabled,
        inTable: Boolean(node.closest("table")),
      }),
    ),
  /**
   * Every box on the page, ours and the to-do list's own gutter marker. The
   * two must coexist: they are the same control doing two different jobs.
   */
  allBoxes: () => document.querySelectorAll('.bn-editor input[type="checkbox"]').length,
  /** The nth box's centre, in viewport coordinates — where a press lands. */
  boxPoint: (n: number) => {
    const node = [...document.querySelectorAll<HTMLInputElement>("input.nt-check-box")][n];
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  },
  focusBox: (n: number) => {
    const node = [...document.querySelectorAll<HTMLInputElement>("input.nt-check-box")][n];
    if (!node) return false;
    node.focus();
    return document.activeElement === node;
  },
  /** How the box sits against the line it is in — the one thing CSS decides. */
  boxAlignment: (n: number) => {
    const node = [...document.querySelectorAll<HTMLInputElement>("input.nt-check-box")][n];
    const line = node?.closest("td, th, p, .bn-inline-content");
    if (!node || !line) return null;
    const a = node.getBoundingClientRect();
    const b = line.getBoundingClientRect();
    return {
      centredWithin: Math.abs((a.top + a.height / 2) - (b.top + b.height / 2)) <= 3,
      insideLine: a.top >= b.top - 1 && a.bottom <= b.bottom + 1,
    };
  },

  /** The slash menu as a reader sees it: the rows, in order, for a query. */
  slashRows: () =>
    [...document.querySelectorAll<HTMLElement>(".nt-slash-item .nt-slash-title")].map((n) => n.textContent),
  slashOpen: () => Boolean(document.querySelector(".nt-slash-item, .nt-slash-empty")),
  /** Press the slash-menu row whose title is `title`. */
  clickSlashRow: (title: string) => {
    const row = [...document.querySelectorAll<HTMLElement>(".nt-slash-item")].find(
      (n) => n.querySelector(".nt-slash-title")?.textContent === title,
    );
    if (!row) return null;
    const box = row.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  },

  undo: () => editor.undo(),
  redo: () => editor.redo(),

  /**
   * An agent's pending change, drawn. `before` is the checkpoint's version of
   * the block; the review diffs the grid on screen against it.
   */
  review: (blockId: string, before: AnyBlock | null) => {
    const view = (editor as unknown as { prosemirrorView: import("prosemirror-view").EditorView }).prosemirrorView;
    if (!before) return void setReview(view, null);
    const hunk: ReviewHunk = {
      id: "h1",
      kind: "update",
      added: [],
      changed: [{ id: blockId, before }],
      moved: [],
      removed: [],
      before: [before],
      kept: false,
      answering: null,
    } as unknown as ReviewHunk;
    setReview(view, { hunks: [hunk], answer: () => {} });
  },
  /** What the review drew: added words washed, removed words struck. */
  marks: () => ({
    added: [...document.querySelectorAll(".nt-diff-ins")].map((n) => n.textContent),
    removed: [...document.querySelectorAll(".nt-diff-del")].map((n) => n.textContent),
    washed: document.querySelectorAll(".nt-diff-block").length,
    /** Whether the box that is now ticked is itself drawn as the addition. */
    boxAdded: [...document.querySelectorAll(".nt-diff-ins")].some(
      (n) => n.matches(".nt-check") || Boolean(n.querySelector("input.nt-check-box")),
    ),
  }),

  /** The table block as a checkpoint would hold it — cells as run lists. */
  tableCheckpoint: (rows: string[][]): AnyBlock => {
    const table = (editor.document as unknown as RawBlock[]).find((b) => b.type === "table")!;
    return {
      id: table.id,
      type: "table",
      props: {},
      content: {
        type: "tableContent",
        headerRows: (table.content as { headerRows?: number }).headerRows,
        // A cell is spelled the way `runs` reads one back: a leading `[ ]`/`[x]`
        // is a box, and whatever follows is the words beside it.
        rows: rows.map((cells) => ({
          cells: cells.map((value) => {
            const box = value.startsWith("[ ]") || value.startsWith("[x]");
            const words = box ? value.slice(3) : value;
            return {
              type: "tableCell",
              content: [
                ...(box ? [{ type: "checkbox", props: { checked: value.startsWith("[x]") } }] : []),
                ...(words ? [{ type: "text", text: words, styles: {} }] : []),
              ],
            };
          }),
        })),
      },
      children: [],
    } as unknown as AnyBlock;
  },
};

declare global {
  interface Window {
    checkbox: typeof harness;
  }
}
window.checkbox = harness;

harness.mountTracker();
