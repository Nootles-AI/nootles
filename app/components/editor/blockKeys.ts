"use client";

/**
 * The keys that act on whole blocks — ⌘D, and the arrows and Enter while a
 * block selection holds the keyboard — plus the triple-click that must never
 * leave the block it landed in.
 *
 * Everything here moves the one selection `blockSelection.ts` defines or edits
 * through BlockNote's own block API, so a duplicate is the same single undo
 * step whether the grip's menu or the keyboard asked for it.
 */

import { createExtension } from "@blocknote/core";
import type { Extension } from "@blocknote/core";
import { SuggestionMenu } from "@blocknote/core/extensions";
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import {
  BlockRangeSelection,
  blockRangeFor,
  blockSelection,
} from "./blockSelection";
import {
  blockBeside,
  blockPosById,
  blocksInReadingOrder,
  blocksTouched,
  caretBesidePlate,
  ownTextRange,
} from "./blockNav";
import { diagramEnter } from "./canvas/page/diagramKeys";

type Editor = Parameters<NonNullable<Extension["keyboardShortcuts"]>[string]>[0]["editor"];

type BlockLike = { id?: string; children?: BlockLike[] };

/** Ids are stripped all the way down, so a duplicated list does not hand its
    children's ids to the copy. */
function withoutIds({ id: _id, children, ...rest }: BlockLike): BlockLike {
  return children ? { ...rest, children: children.map(withoutIds) } : rest;
}

/**
 * Copies of these blocks, straight after the last of them, in one step.
 * Returns the copies' ids, in order.
 */
export function duplicateBlocks(editor: Editor, ids: readonly string[]): string[] {
  const blocks = ids.flatMap((id) => editor.getBlock(id) ?? []);
  if (!blocks.length) return [];
  const copies = editor.insertBlocks(
    blocks.map(withoutIds) as Parameters<Editor["insertBlocks"]>[0],
    blocks[blocks.length - 1],
    "after",
  );
  return copies.map((block) => block.id);
}

/**
 * The copies, selected as whole blocks — where the grip's Duplicate and a ⌘D
 * over a band both leave the keyboard, so the next ⌘D copies the copies.
 */
export function duplicateAndSelect(editor: Editor, ids: readonly string[]) {
  const copies = duplicateBlocks(editor, ids);
  if (copies.length) blockSelection(editor).select(copies);
}

/**
 * The view, when the key was pressed in the document itself. A diagram is a
 * focusable island inside it, and a key the diagram declines still bubbles
 * through this keymap — it is not a key typed at the page.
 */
function keyboardView(editor: Editor): EditorView | null {
  const view = editor.prosemirrorView;
  return view && editor.isEditable && view.hasFocus() ? view : null;
}

function setSelection(view: EditorView, selection: TextSelection | BlockRangeSelection) {
  view.dispatch(
    view.state.tr.setSelection(selection).setMeta("addToHistory", false).scrollIntoView(),
  );
}

/**
 * ⌘D. A band duplicates the band; a caret, or a selection inside one block's
 * text, duplicates that block and carries the caret across to the same place
 * in the copy, so writing carries on in it; a text selection that runs across
 * blocks duplicates every block it touches.
 */
function duplicateAtSelection(editor: Editor): boolean {
  const view = keyboardView(editor);
  if (!view) return false;
  const { selection, doc } = view.state;
  const range =
    selection instanceof BlockRangeSelection
      ? selection
      : blockRangeFor(doc, blocksTouched(doc, selection.from, selection.to));
  if (!range) return false;

  const own =
    !(selection instanceof BlockRangeSelection) && range.nodes.length === 1
      ? ownTextRange(doc, range.positions[0])
      : null;
  if (!own || selection.from < own.start || selection.to > own.end) {
    duplicateAndSelect(editor, range.blockIds);
    return true;
  }

  const anchor = selection.anchor - own.start;
  const head = selection.head - own.start;
  const [copy] = duplicateBlocks(editor, range.blockIds);
  const next = view.state.doc;
  const at = copy ? ownTextRange(next, blockPosById(next, copy)) : null;
  if (at) setSelection(view, TextSelection.create(next, at.start + anchor, at.start + head));
  return true;
}

/** Whether the block at `pos` is drawn — a folded toggle hides its children
    in the DOM, and a key must not select what nobody can see. */
function shownIn(view: EditorView) {
  return (pos: number) => {
    const dom = view.nodeDOM(pos);
    return !(dom instanceof HTMLElement) || dom.getClientRects().length > 0;
  };
}

/** Where a Shift+arrow run started and where it has reached, for the one
    selection it last made. Anything else resets it. */
type Stretch = { anchor: string; head: string; made: BlockRangeSelection };
const stretches = new WeakMap<EditorView, Stretch>();

/**
 * ↑/↓ on a block selection: onto the block above or below, which is the
 * block selection that remains — never a caret dropped somewhere unseen.
 * Shift stretches the selection from where the run began; the far end of the
 * page is a wall, and a key there is still spent.
 */
function stepBlocks(editor: Editor, dir: -1 | 1, stretch: boolean): boolean {
  const view = keyboardView(editor);
  if (!view) return false;
  const { selection, doc } = view.state;
  if (!(selection instanceof BlockRangeSelection) || !selection.nodes.length) return false;
  const order = blocksInReadingOrder(doc, shownIn(view));
  const last = selection.nodes.length - 1;
  const end = selection.positions[last] + selection.nodes[last].nodeSize;

  if (!stretch) {
    stretches.delete(view);
    const caret = caretBesidePlate(doc, order, selection.positions, dir);
    if (caret !== null) {
      setSelection(view, TextSelection.create(doc, caret));
      return true;
    }
    const target = blockBeside(order, selection.from, end, dir);
    const next = target && blockRangeFor(doc, [target.id]);
    if (next) setSelection(view, next);
    return true;
  }

  const ids = selection.blockIds;
  const known = stretches.get(view);
  const run =
    known && known.made.eq(selection)
      ? known
      : dir > 0
        ? { anchor: ids[0], head: ids[ids.length - 1] }
        : { anchor: ids[ids.length - 1], head: ids[0] };
  let i = order.findIndex((spot) => spot.id === run.head);
  if (i < 0) return true;
  // A step into a child of a block already covered changes nothing on screen,
  // so the head keeps going until the plates do.
  for (i += dir; i >= 0 && i < order.length; i += dir) {
    const next = blockRangeFor(doc, [run.anchor, order[i].id]);
    if (next && !next.eq(selection)) {
      setSelection(view, next);
      stretches.set(view, { anchor: run.anchor, head: order[i].id, made: next });
      break;
    }
  }
  return true;
}

/** ←/→ on one void block's plate: into the text beside it, as ↑/↓ do. */
function leavePlate(editor: Editor, dir: -1 | 1): boolean {
  const view = keyboardView(editor);
  if (!view) return false;
  const { selection, doc } = view.state;
  if (!(selection instanceof BlockRangeSelection)) return false;
  const caret = caretBesidePlate(doc, blocksInReadingOrder(doc, shownIn(view)), selection.positions, dir);
  if (caret === null) return false;
  setSelection(view, TextSelection.create(doc, caret));
  return true;
}

const ARROWS = { up: -1, left: -1, down: 1, right: 1 } as const;

/**
 * An arrow at the edge of a text block, onto a block with no text — a diagram,
 * an image: its plate, which is something to see and to act on, where
 * ProseMirror would leave an invisible node selection. A code block's own
 * keys take the caret into its code instead.
 */
function arrowIntoVoid(editor: Editor, dir: keyof typeof ARROWS): boolean {
  const view = keyboardView(editor);
  if (!view || editor.getExtension(SuggestionMenu)?.shown()) return false;
  const { selection, doc } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  if (!view.endOfTextblock(dir)) return false;
  const back = ARROWS[dir] < 0;
  const { $from } = selection;
  if ($from.depth === 0) return false;
  const next = Selection.findFrom(doc.resolve(back ? $from.before() : $from.after()), back ? -1 : 1);
  if (!(next instanceof NodeSelection) || next.node.type.name === "codeBlock") return false;
  const container = next.$from.parent;
  const id: unknown = container.attrs.id;
  if (container.type.name !== "blockContainer" || typeof id !== "string") return false;
  blockSelection(editor).select([id]);
  return true;
}

/** Enter on a block selection goes back to writing, at the end of the last
    block's own text. A diagram is entered, onto its shapes. A block with no
    text keeps its plate. */
function enterBlocks(editor: Editor): boolean {
  const view = keyboardView(editor);
  if (!view) return false;
  const { selection, doc } = view.state;
  if (!(selection instanceof BlockRangeSelection) || !selection.nodes.length) return false;
  if (
    selection.nodes.length === 1 &&
    selection.nodes[0].firstChild?.type.name === "canvas" &&
    diagramEnter(view.dom, selection.blockIds[0])
  ) {
    return true;
  }
  const own = ownTextRange(doc, selection.positions[selection.positions.length - 1]);
  if (own) setSelection(view, TextSelection.create(doc, own.end));
  return true;
}

/**
 * A triple-click takes the block's own text and not a character more.
 *
 * ProseMirror answers a triple-click itself, but only one it counted: three
 * presses, each within its own 500ms of the last. The platform counts by the
 * system's double-click speed, so a triple-click ProseMirror missed still
 * reaches the browser as one, which selects the paragraph natively — running on
 * to the start of the next block. Typing then deleted that boundary: an empty
 * paragraph below went with it and its children were re-parented. `detail` is
 * the platform's own count, so it is heard here instead.
 */
function tripleClickPlugin() {
  return new Plugin({
    key: new PluginKey("nt-triple-click"),
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          if (event.button !== 0 || event.detail < 3) return false;
          const hit = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (!hit || hit.inside < 0) return false;
          const $pos = view.state.doc.resolve(hit.inside);
          for (let depth = $pos.depth + 1; depth > 0; depth--) {
            const node = depth > $pos.depth ? $pos.nodeAfter : $pos.node(depth);
            if (!node?.inlineContent) continue;
            const start = $pos.before(depth) + 1;
            view.dispatch(
              view.state.tr.setSelection(
                TextSelection.create(view.state.doc, start, start + node.content.size),
              ),
            );
            // Cancelling the press also cancels the focus it would have given.
            event.preventDefault();
            if (!view.hasFocus()) view.focus();
            return true;
          }
          return false;
        },
      },
    },
  });
}

export const blockKeysExtension = createExtension({
  key: "nt-block-keys",
  prosemirrorPlugins: [tripleClickPlugin()],
  keyboardShortcuts: {
    "Mod-d": ({ editor }) => duplicateAtSelection(editor),
    ArrowUp: ({ editor }) => stepBlocks(editor, -1, false) || arrowIntoVoid(editor, "up"),
    ArrowDown: ({ editor }) => stepBlocks(editor, 1, false) || arrowIntoVoid(editor, "down"),
    ArrowLeft: ({ editor }) => leavePlate(editor, -1) || arrowIntoVoid(editor, "left"),
    ArrowRight: ({ editor }) => leavePlate(editor, 1) || arrowIntoVoid(editor, "right"),
    "Shift-ArrowUp": ({ editor }) => stepBlocks(editor, -1, true),
    "Shift-ArrowDown": ({ editor }) => stepBlocks(editor, 1, true),
    Enter: ({ editor }) => enterBlocks(editor),
  },
});
