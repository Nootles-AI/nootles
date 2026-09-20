import { createRoot, type Root } from "react-dom/client";
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { schema } from "../app/components/editor/schema";
import { completionExtension } from "../app/components/editor/ai/completionExtension";
import { hintExtension } from "../app/components/editor/ai/hintText";
import { reviewExtension } from "../app/components/editor/ai/reviewExtension";
import { arrivalFlashExtension } from "../app/components/editor/arrivalFlash";
import { blockSelectionExtension } from "../app/components/editor/blockSelection";
import { trailingParagraphExtension } from "../app/components/editor/trailingParagraph";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

// The production list, from `Editor.tsx`. Enter inside a list item is decided
// by a keymap plugin collected at editor construction, so the fixture must
// build the editor the way the app does or it is testing a different keymap.
// `trailingParagraphExtension` is in here for the same reason: every real page
// ends in an empty paragraph, and an empty list item outdenting next to it is
// exactly the arrangement under test.
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

type RawBlock = {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: unknown;
  children: RawBlock[];
};

type Row = { type: string; text: string | null; depth: number; checked?: boolean };

function text(block: RawBlock): string | null {
  return Array.isArray(block.content)
    ? (block.content as { type: string; text?: string }[])
        .map((inline) => inline.text ?? `<${inline.type}>`)
        .join("")
    : null;
}

/**
 * The document as `type @depth: text` rows in reading order — the shape the
 * ticket is written in. Nesting is the whole subject here, so it is spelled
 * out rather than left to a nested object a failure message cannot show.
 */
function flatten(blocks: RawBlock[], depth = 0, into: Row[] = []): Row[] {
  for (const block of blocks) {
    into.push({
      type: block.type,
      text: text(block),
      depth,
      ...(block.props.checked === undefined ? {} : { checked: Boolean(block.props.checked) }),
    });
    flatten(block.children, depth + 1, into);
  }
  return into;
}

function walk(blocks: RawBlock[], depth = 0, into: (RawBlock & { depth: number })[] = []) {
  for (const block of blocks) {
    into.push({ ...block, depth });
    walk(block.children, depth + 1, into);
  }
  return into;
}

const all = () => walk(editor.document as unknown as RawBlock[]);

const harness = {
  mount,
  /** Every block in reading order, with its nesting depth. */
  rows: (): Row[] => flatten(editor.document as unknown as RawBlock[]),
  /** Ids in reading order, so a driver can name a nested block. */
  ids: () => all().map((block) => block.id),
  /** Which block holds the caret, and how deep it sits. */
  caret: () => {
    const { block } = editor.getTextCursorPosition();
    const found = all().find((candidate) => candidate.id === block.id);
    return found ? { type: found.type, text: text(found), depth: found.depth } : null;
  },
  caretId: () => editor.getTextCursorPosition().block.id as string,
  /** How far into its block's text the caret sits — a click's aim, verified. */
  caretOffset: () => editor.prosemirrorState.selection.$from.parentOffset,
  /**
   * How many characters the selection covers, 0 while it is just a caret.
   *
   * An arrow key moves the browser's own selection first; ProseMirror reads it
   * back a beat later, so a driver that presses and asserts in the same breath
   * is asking about the selection one key ago.
   */
  selectionSize: () => {
    const { from, to } = editor.prosemirrorState.selection;
    return to - from;
  },
  /**
   * A point inside block `id`'s own content, in viewport coordinates.
   *
   * `.bn-block-content` is searched under the container and then checked to
   * belong to it: a parent item's descendants include its children's content,
   * and clicking one of those would silently test a different block. Empty
   * blocks have no text node to measure, so their own box is used.
   *
   * `data-id` sits on both `.bn-block-outer` and the `blockContainer` inside
   * it, so the container is named by node type as well — matching the outer
   * element makes every ownership check fail.
   */
  point: (id: string, where: "start" | "end" = "end") => {
    const container = document.querySelector(`[data-node-type="blockContainer"][data-id="${id}"]`);
    const content = container?.querySelector(".bn-block-content");
    if (!container || !content) return null;
    if (content.closest('[data-node-type="blockContainer"]') !== container) return null;
    const node = document.createTreeWalker(content, NodeFilter.SHOW_TEXT).nextNode();
    if (!node) {
      // An empty block has no text to aim at; anywhere on its line is its only
      // offset. Home/End are inert in a contenteditable on macOS, so the click
      // itself has to land where the caret is wanted.
      const box = content.getBoundingClientRect();
      return { x: box.left + 2, y: box.top + box.height / 2 };
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    // Past the last glyph rather than on it: a click inside a character rounds
    // to whichever half it hit, which is one offset short at the end.
    return {
      x: where === "start" ? rect.left + 1 : rect.right + 3,
      y: rect.top + rect.height / 2,
    };
  },
  /**
   * The chevron that reveals block `id`'s children, in viewport coordinates,
   * or null when they are already showing. A toggle list starts collapsed, and
   * a click aimed at a child inside a collapsed one lands on nothing.
   */
  togglePoint: (id: string) => {
    const container = document.querySelector(`[data-node-type="blockContainer"][data-id="${id}"]`);
    const wrapper = container?.querySelector(".bn-toggle-wrapper");
    if (!wrapper || wrapper.closest('[data-node-type="blockContainer"]') !== container) return null;
    if (wrapper.getAttribute("data-show-children") === "true") return null;
    const button = wrapper.querySelector(".bn-toggle-button");
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  },
  /** The marker the reader actually sees, per block, in reading order. */
  markers: () =>
    [...document.querySelectorAll<HTMLElement>(".bn-block-content")].map((node) => ({
      type: node.getAttribute("data-content-type"),
      marker: getComputedStyle(node, "::before").content,
      text: node.textContent,
    })),
  undo: () => editor.undo(),
  redo: () => editor.redo(),
};

declare global {
  interface Window {
    listEnter: typeof harness;
  }
}
window.listEnter = harness;

mount([{ type: "paragraph", content: "Ready" }]);
