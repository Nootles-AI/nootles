"use client";

/**
 * Whole-block selection for the document — Notion's model, on ProseMirror's
 * terms.
 *
 * ## Where the truth lives
 *
 * There is exactly one: `state.selection`. A block selection IS a ProseMirror
 * selection ({@link BlockRangeSelection}), not a second store kept beside one.
 * That single decision buys nearly everything the feature needs for free:
 *
 * - **Drag.** BlockNote's side menu already drags a multi-block selection
 *   (`extensions/SideMenu/dragging.ts`); it asks the live selection for its
 *   range and whether more than one block is in it. Our selection answers both
 *   correctly, so dragging a handle inside the band moves the whole band with
 *   no cooperation from this file.
 * - **`editor.getSelection()`.** The side menu resolves Duplicate / Copy /
 *   Delete through it, so the store and the menu can never disagree about what
 *   is selected — they are reading the same object.
 * - **Copy and cut.** ProseMirror's clipboard handlers serialize
 *   `selection.content()`, which {@link BlockRangeSelection.content} defines as
 *   the whole block nodes.
 * - **Clearing.** Putting the caret anywhere replaces the selection, because
 *   that is what setting a selection means. No listener, no reconciliation.
 *
 * The alternative — an independent id store mirrored into the editor — has two
 * truths and therefore a bug surface between them. This has one.
 *
 * ## What it must never do
 *
 * Selecting is not editing. Nothing here changes the document, so nothing here
 * reaches a collaborator's document or the undo stack: the visible state is
 * decorations, and the selection transactions carry `addToHistory: false`.
 * Deleting the selection is the one exception, and it goes through BlockNote's
 * own API so it lands as a single undo step.
 *
 * ## The React store
 *
 * {@link blockSelection} returns a `subscribe`/`getSnapshot` pair over that one
 * truth, so a component may read the selection without re-rendering on every
 * keystroke, and {@link useIsBlockSelected}'s snapshot is a boolean — a block
 * re-renders only when its OWN selectedness flips. (The visible plate needs no
 * re-render at all; it is a decoration class. The store is for chrome that has
 * to count or name what is selected.)
 */

import { createExtension } from "@blocknote/core";
import { Fragment, Slice } from "prosemirror-model";
import type { Node as PMNode, ResolvedPos } from "prosemirror-model";
import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
} from "prosemirror-state";
import type { EditorState, Transaction } from "prosemirror-state";
import type { Mappable } from "prosemirror-transform";
import { Decoration, DecorationSet } from "prosemirror-view";
import type { EditorView } from "prosemirror-view";
import { useCallback, useSyncExternalStore } from "react";
import "./blockSelection.css";

/** The class a selected block's `.bn-block-outer` wears. */
export const BLOCK_SELECTED_CLASS = "nt-block-selected";

/**
 * The slice of BlockNote this module needs. Structural rather than
 * `BlockNoteEditor<any, any, any>`: it keeps the schema (and its seven
 * content-less block types) out of this file, and states the contract in four
 * lines instead of a cast.
 */
export interface BlockSelectionEditor {
  readonly prosemirrorView?: EditorView;
  /** Top-level blocks, in document order. */
  readonly document: readonly { readonly id: string }[];
  getSelection(): { blocks: readonly { readonly id: string }[] } | undefined;
  removeBlocks(ids: string[]): unknown;
  replaceBlocks(ids: string[], blocks: { type: "paragraph" }[]): unknown;
}

// ---------------------------------------------------------------------------
// The selection
// ---------------------------------------------------------------------------

/**
 * A run of whole blocks, addressed the way ProseMirror addresses anything else.
 *
 * ### Why not a `TextSelection`
 *
 * BlockNote's own `setSelection` spans blocks with a `TextSelection` anchored
 * inside the first and last block's content — and throws outright on a block
 * whose content is `"none"`. Seven of this editor's block types are exactly
 * that (diagram, storyboard, album, media, location, code, math), so a text
 * selection cannot express a band that starts or ends on a diagram, which is
 * most of the bands anyone will draw here.
 *
 * ### Why the endpoints sit where they do
 *
 * `from` is immediately BEFORE the first block; `to` is immediately INSIDE the
 * last one, at its end. That asymmetry is not an accident — it is the only pair
 * that satisfies both readers of this selection:
 *
 * - `getNearestBlockPos` (what `editor.getSelection()` resolves through) walks
 *   OUTWARD from a position, so a `to` sitting just past the last block would
 *   resolve to the block AFTER it and the menu would delete a block the user
 *   never selected. One position earlier resolves to the last block itself.
 * - `blockPositionsFromSelection` (what the drag reads) takes `from`/`to`
 *   verbatim for a selection that is not text, and `deleteRange` expands an
 *   inside-the-last-block end back out to the whole block, so the drag's cut
 *   still removes whole blocks.
 *
 * And because `$anchor` resolves to the parent group while `$head` resolves
 * inside a block, `$anchor.node() !== $head.node()` — which is the test the
 * side menu uses to decide that a drag should carry the whole selection.
 *
 * `visible` is false, so ProseMirror hides the native highlight and the caret
 * (`.ProseMirror-hideselection`) and the block plates are the only affordance.
 */
export class BlockRangeSelection extends Selection {
  /** The selected block nodes, in document order. */
  readonly nodes: readonly PMNode[];
  /** Their ids, parallel to {@link nodes}. */
  readonly blockIds: readonly string[];
  /** The position before each, parallel to {@link nodes}. */
  readonly positions: readonly number[];

  /**
   * @param $from Immediately before the first block, in its parent group.
   * @param $to Inside the last block of that same group, at its end.
   * Build these with {@link blockRangeFor} rather than by hand.
   */
  constructor($from: ResolvedPos, $to: ResolvedPos) {
    super($from, $to);
    const parent = $from.node();
    const first = $from.index();
    // `$to` lies inside the last block, so its index AT THE PARENT'S DEPTH is
    // that block's. A caller that handed us a boundary instead names the block
    // before it.
    const last =
      $to.depth > $from.depth
        ? $to.index($from.depth)
        : $to.index($from.depth) - 1;

    const nodes: PMNode[] = [];
    const blockIds: string[] = [];
    const positions: number[] = [];
    let pos = $from.pos;
    for (let i = first; i <= last && i < parent.childCount; i++) {
      const node = parent.child(i);
      nodes.push(node);
      positions.push(pos);
      if (typeof node.attrs.id === "string") blockIds.push(node.attrs.id);
      pos += node.nodeSize;
    }
    this.nodes = nodes;
    this.blockIds = blockIds;
    this.positions = positions;
  }

  eq(other: Selection): boolean {
    return (
      other instanceof BlockRangeSelection &&
      other.from === this.from &&
      other.to === this.to
    );
  }

  /**
   * Rebuilt from the IDS, not from mapped positions: ids survive a remote edit
   * that positions do not, and re-running the same normalization keeps the
   * selection a contiguous run even after a collaborator inserts into it.
   */
  map(doc: PMNode, mapping: Mappable): Selection {
    const rebuilt = blockRangeFor(doc, this.blockIds);
    if (rebuilt) return rebuilt;
    // Every selected block is gone — the caret goes where they were.
    const at = Math.max(0, Math.min(mapping.map(this.from), doc.content.size));
    return caretNear(doc, at);
  }

  /** Whole blocks, closed on both sides — what copy, cut and drag carry. */
  content(): Slice {
    return new Slice(Fragment.fromArray(this.nodes.slice()), 0, 0);
  }

  /**
   * Cut, paste-over, and the drag's own delete all land here.
   *
   * The replacement itself is ProseMirror's — `deleteRange` widens an end that
   * sits inside the last block back out to the whole block, so whole blocks
   * leave and no empty husk stays behind.
   *
   * What is corrected is where the caret ends up. PM finishes by calling
   * `selectionToInsertionEnd`, which uses `Selection.near` and will therefore
   * node-select an adjoining content-less block — invisibly, per
   * {@link caretNear}. Cutting three paragraphs above a diagram would leave
   * that diagram selected with nothing on screen saying so, and the next
   * Backspace would take it. Only an EMPTY replacement is corrected: a paste
   * that ends on a diagram should leave the pasted diagram selected.
   */
  replace(tr: Transaction, content: Slice = Slice.empty): void {
    super.replace(tr, content);
    if (content.size === 0 && tr.selection instanceof NodeSelection) {
      tr.setSelection(caretNear(tr.doc, tr.selection.from));
    }
  }

  toJSON(): { type: string; anchor: number; head: number } {
    // Deliberately unregistered with `Selection.jsonID`: nothing in this app
    // round-trips an EditorState through JSON, and registering a duplicate id
    // throws — which a hot reload would do every time this module re-evaluates.
    return { type: "nt-block-range", anchor: this.anchor, head: this.head };
  }

  /** The plate on each selected block. */
  decorations(): Decoration[] {
    const out: Decoration[] = [];
    for (let i = 0; i < this.nodes.length; i++) {
      const pos = this.positions[i];
      out.push(
        Decoration.node(pos, pos + this.nodes[i].nodeSize, {
          class: BLOCK_SELECTED_CLASS,
        }),
      );
    }
    return out;
  }
}

BlockRangeSelection.prototype.visible = false;

/**
 * Where the caret goes when a block selection ends — a real TEXT position,
 * searched backwards first so it lands at the end of what was selected rather
 * than in whatever followed it.
 *
 * Text ONLY, and that is the whole point. `Selection.near` will happily return
 * a `NodeSelection` when the nearest thing is a content-less block — and seven
 * of this editor's block types are exactly that (diagram, storyboard, album,
 * media, location, code, math). `editor.css` deliberately suppresses
 * `ProseMirror-selectednode`, so such a selection is INVISIBLE: Escape would
 * look like it had cleared while leaving a diagram selected, and the next
 * Backspace would delete it with nothing on screen to explain why.
 *
 * A page with no text anywhere can hold no caret; there the block itself is
 * the honest resting place, and the fallback says so.
 */
function caretNear(doc: PMNode, pos: number): Selection {
  const $at = doc.resolve(pos);
  return (
    Selection.findFrom($at, -1, true) ??
    Selection.findFrom($at, 1, true) ??
    Selection.near($at, -1)
  );
}

/**
 * The selection covering `ids`, normalized to one contiguous run of siblings.
 *
 * Ids the document no longer holds are dropped; what is left is taken from the
 * first to the last, at the shallowest depth the two share. So a band that
 * starts inside a nested list and ends on the paragraph after it selects the
 * whole list — the same lift Notion performs, and the only shape a block range
 * can take without inventing a selection that spans nesting levels.
 *
 * Returns `null` when the document holds none of the ids.
 */
export function blockRangeFor(
  doc: PMNode,
  ids: Iterable<string>,
): BlockRangeSelection | null {
  const wanted = new Set(ids);
  if (wanted.size === 0) return null;

  let firstPos = -1;
  let lastPos = -1;
  let lastNode: PMNode | null = null;
  doc.descendants((node, pos) => {
    // Ids live on block nodes; a textblock's children are inline content, which
    // is most of the tree in a written page and none of it has an id.
    if (node.isTextblock) return false;
    const id: unknown = node.attrs?.id;
    if (typeof id === "string" && wanted.has(id) && node.type.isInGroup("bnBlock")) {
      if (firstPos < 0) firstPos = pos;
      lastPos = pos;
      lastNode = node;
    }
    return true;
  });
  if (firstPos < 0 || lastNode === null) return null;

  const $first = doc.resolve(firstPos);
  const $afterLast = doc.resolve(lastPos + (lastNode as PMNode).nodeSize);
  const shared = $first.sharedDepth($afterLast.pos);
  const from = $first.depth > shared ? $first.before(shared + 1) : $first.pos;
  const after = $afterLast.depth > shared ? $afterLast.after(shared + 1) : $afterLast.pos;
  if (after - 1 <= from) return null;

  const selection = new BlockRangeSelection(doc.resolve(from), doc.resolve(after - 1));
  return selection.nodes.length ? selection : null;
}

/** The block ids the state currently selects as whole blocks, document order. */
export function selectedBlockIds(state: EditorState): readonly string[] {
  const selection = state.selection;
  return selection instanceof BlockRangeSelection ? selection.blockIds : NO_IDS;
}

// ---------------------------------------------------------------------------
// The decoration plugin
// ---------------------------------------------------------------------------

type PlateState = {
  /** The selection the set was built from — identity is the cache key. */
  source: BlockRangeSelection | null;
  set: DecorationSet;
};

const EMPTY_PLATES: PlateState = { source: null, set: DecorationSet.empty };

const blockSelectionKey = new PluginKey<PlateState>("nt-block-selection");

/**
 * Stores keyed by the view the plugin can see, so its update hook can hand the
 * store the state without this module knowing how to get from a view back to a
 * BlockNote editor.
 */
const storesByView = new WeakMap<EditorView, BlockSelectionStoreImpl>();

function blockSelectionPlugin() {
  return new Plugin<PlateState>({
    key: blockSelectionKey,
    state: {
      init: () => EMPTY_PLATES,
      apply(tr, prev, _old, next) {
        const selection = next.selection;
        if (!(selection instanceof BlockRangeSelection)) {
          return prev.source ? EMPTY_PLATES : prev;
        }
        // ProseMirror mints a new selection object whenever it maps or sets
        // one, so identity alone says whether the plates are still current —
        // no doc walk on a transaction that changed neither.
        if (selection === prev.source) return prev;
        return {
          source: selection,
          set: DecorationSet.create(tr.doc, selection.decorations()),
        };
      },
    },
    props: {
      decorations(state) {
        return blockSelectionKey.getState(state)?.set ?? null;
      },
    },
    view(editorView) {
      const push = () => storesByView.get(editorView)?.pull(editorView.state);
      push();
      return {
        update: push,
        destroy() {
          storesByView.delete(editorView);
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface BlockSelectionSnapshot {
  /** Selected block ids, in document order. Empty when nothing is selected. */
  readonly ids: readonly string[];
  /** The same ids, for O(1) membership. */
  readonly selected: ReadonlySet<string>;
}

export interface BlockSelectionStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): BlockSelectionSnapshot;
  isSelected(id: string): boolean;

  /**
   * Select exactly these blocks, normalized to one contiguous run (see
   * {@link blockRangeFor}). An empty list clears. Focuses the editor, so the
   * keys below reach the selection that was just made.
   */
  select(ids: readonly string[]): void;
  /** Add to what is already selected — the shift-drag / shift-click verb. */
  add(ids: readonly string[]): void;
  toggle(id: string): void;
  /** Deselect, leaving the caret at the end of what was selected. */
  clear(): void;
  /** Every top-level block — the second press of ⌘A. */
  selectAll(): void;
  /**
   * Take the whole blocks the caret's TEXT selection spans, turning a drag
   * through prose into a block selection. False when nothing is spanned.
   */
  selectSpannedBlocks(): boolean;
  /**
   * Delete the selected blocks as one undo step. Emptying the document leaves
   * an empty paragraph behind rather than an invalid one. False when nothing
   * was selected.
   */
  removeSelected(): boolean;
}

const NO_IDS: readonly string[] = [];
const EMPTY_SNAPSHOT: BlockSelectionSnapshot = { ids: NO_IDS, selected: new Set() };

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

class BlockSelectionStoreImpl implements BlockSelectionStore {
  private snapshot: BlockSelectionSnapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly editor: BlockSelectionEditor) {}

  /**
   * The view, registered so the plugin can find its way back here. Resolved on
   * every use because the editor mounts after this store may have been asked
   * for, and remounts (a pipeline flip, StrictMode) hand it a new one.
   */
  private view(): EditorView | null {
    const view = this.editor.prosemirrorView;
    if (!view || view.isDestroyed) return null;
    if (storesByView.get(view) !== this) storesByView.set(view, this);
    return view;
  }

  /** Read the one truth. Called by the plugin on every editor update. */
  pull(state: EditorState) {
    const ids = selectedBlockIds(state);
    if (sameIds(ids, this.snapshot.ids)) return;
    this.snapshot = ids.length
      ? { ids, selected: new Set(ids) }
      : EMPTY_SNAPSHOT;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    const view = this.view();
    if (view) this.pull(view.state);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  isSelected = (id: string) => this.snapshot.selected.has(id);

  /** The one write. Selection only — never a document change, never history. */
  private put(next: Selection | null, view: EditorView) {
    if (!next) return;
    view.dispatch(view.state.tr.setSelection(next).setMeta("addToHistory", false));
    // A band drawn in the gutter has to leave the keyboard pointing at the
    // document, or Backspace goes nowhere. `focus` prevents scroll.
    if (!view.hasFocus()) view.focus();
  }

  select = (ids: readonly string[]) => {
    const view = this.view();
    if (!view) return;
    if (!ids.length) {
      this.clear();
      return;
    }
    this.put(blockRangeFor(view.state.doc, ids), view);
  };

  add = (ids: readonly string[]) => {
    if (!ids.length) return;
    this.select([...this.snapshot.ids, ...ids]);
  };

  toggle = (id: string) => {
    const ids = this.snapshot.selected.has(id)
      ? this.snapshot.ids.filter((other) => other !== id)
      : [...this.snapshot.ids, id];
    this.select(ids);
  };

  clear = () => {
    const view = this.view();
    if (!view) return;
    const selection = view.state.selection;
    if (!(selection instanceof BlockRangeSelection)) return;
    this.put(caretNear(view.state.doc, selection.to), view);
  };

  selectAll = () => {
    this.select(this.editor.document.map((block) => block.id));
  };

  selectSpannedBlocks = () => {
    const blocks = this.editor.getSelection()?.blocks;
    // More than one, strictly: a drag inside a single block is someone
    // selecting words, and promoting that would take the whole paragraph away
    // from them mid-sentence.
    if (!blocks || blocks.length < 2) return false;
    this.select(blocks.map((block) => block.id));
    return true;
  };

  removeSelected = () => {
    const view = this.view();
    if (!view) return false;
    const selection = view.state.selection;
    if (!(selection instanceof BlockRangeSelection)) return false;
    const ids = [...selection.blockIds];
    if (!ids.length) return false;

    const top = this.editor.document;
    const going = new Set(ids);
    const emptyingThePage =
      top.length > 0 && top.every((block) => going.has(block.id));
    // A document needs at least one block, so clearing the page replaces
    // rather than removes — one step either way.
    if (emptyingThePage) this.editor.replaceBlocks(ids, [{ type: "paragraph" }]);
    else this.editor.removeBlocks(ids);
    // The selection maps itself to a caret where the blocks were: every id it
    // named is gone, so `BlockRangeSelection.map` falls through to `near`.
    if (!view.isDestroyed && !view.hasFocus()) view.focus();
    return true;
  };
}

const stores = new WeakMap<BlockSelectionEditor, BlockSelectionStoreImpl>();

/**
 * The block-selection store for an editor — one per editor, so two panes
 * showing two pages never share a selection.
 */
export function blockSelection(editor: BlockSelectionEditor): BlockSelectionStore {
  const known = stores.get(editor);
  if (known) return known;
  const store = new BlockSelectionStoreImpl(editor);
  stores.set(editor, store);
  return store;
}

// ---------------------------------------------------------------------------
// Hit-testing a band
// ---------------------------------------------------------------------------

/**
 * The blocks a horizontal band covers, by VERTICAL OVERLAP alone.
 *
 * A block spans the full column, so where the band is horizontally says
 * nothing about what it means — and requiring horizontal overlap would mean a
 * band drawn down the gutter, which is where this gesture starts, selected
 * nothing.
 *
 * A block inside a block already covered is left out: selecting a parent takes
 * its children with it, and naming both would decorate the same pixels twice.
 *
 * @param top Viewport coordinates, as `getBoundingClientRect` reports them.
 */
export function blockIdsInBand(
  root: HTMLElement,
  top: number,
  bottom: number,
): string[] {
  const ids: string[] = [];
  let covered: HTMLElement | null = null;
  for (const el of root.querySelectorAll<HTMLElement>(".bn-block-outer[data-id]")) {
    // Document order, so a covered block's descendants follow it immediately.
    if (covered?.contains(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.height === 0 || rect.bottom <= top || rect.top >= bottom) continue;
    covered = el;
    if (el.dataset.id) ids.push(el.dataset.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * ⌘A, the way every editor with blocks does it: the first press takes the
 * block you are writing in, the second takes the page. An empty block, or a
 * caret that is not in text at all, has nothing to take first — so it
 * escalates immediately rather than pressing twice for nothing.
 */
function selectAllEscalating(editor: BlockSelectionEditor): boolean {
  const view = editor.prosemirrorView;
  if (!view) return false;
  const store = blockSelection(editor);
  const { selection, doc } = view.state;

  if (!(selection instanceof BlockRangeSelection)) {
    const $from = selection.$from;
    if ($from.parent.inlineContent && $from.parent.content.size > 0) {
      const start = $from.start();
      const end = $from.end();
      if (selection.from > start || selection.to < end) {
        view.dispatch(
          view.state.tr
            .setSelection(TextSelection.create(doc, start, end))
            .setMeta("addToHistory", false),
        );
        return true;
      }
    }
  }
  store.selectAll();
  return true;
}

/**
 * Multi-block selection: the plates, and the keys that act on them.
 *
 * The gesture that draws a band is separate — see `useBlockMarquee` — because
 * the gutter it starts in lives outside the contenteditable.
 */
export const blockSelectionExtension = createExtension({
  key: "nt-block-selection",
  prosemirrorPlugins: [blockSelectionPlugin()],
  keyboardShortcuts: {
    Escape: ({ editor }) => {
      const store = blockSelection(editor);
      if (!store.getSnapshot().ids.length) return false;
      store.clear();
      return true;
    },
    Backspace: ({ editor }) => blockSelection(editor).removeSelected(),
    Delete: ({ editor }) => blockSelection(editor).removeSelected(),
    "Mod-a": ({ editor }) => selectAllEscalating(editor),
  },
});

// ---------------------------------------------------------------------------
// React
// ---------------------------------------------------------------------------

/** What is selected. Re-renders the caller whenever that changes. */
export function useBlockSelection(
  store: BlockSelectionStore,
): BlockSelectionSnapshot {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}

/**
 * Whether ONE block is selected. The snapshot is a boolean, so a block
 * re-renders only when its own state flips — never because a sibling was
 * selected.
 */
export function useIsBlockSelected(
  store: BlockSelectionStore,
  id: string,
): boolean {
  const isSelected = useCallback(() => store.isSelected(id), [store, id]);
  return useSyncExternalStore(store.subscribe, isSelected, isSelected);
}
