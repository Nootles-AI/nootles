import { createExtension, type ExtensionOptions } from "@blocknote/core";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { ReplaceAroundStep, ReplaceStep } from "prosemirror-transform";
import { ySyncPluginKey } from "y-prosemirror";
import { NML_LIMITS } from "@/app/lib/nml/schema";
import { NML_LIST_TYPES } from "@/app/lib/nml/view/projection";

/**
 * Canonical NML holds four levels of blocks, and only list and toggle items
 * hold children there: a block nested under anything else is hoisted to that
 * block's own level. So a block's level is one more than the list and toggle
 * items above it, and no edit may take one past the limit — on a served page
 * the mirror would refuse it, and a legacy page holding one could never
 * migrate (NT-127).
 */
const MAX_DEPTH = NML_LIMITS.maxBlockDepth;

const KEY = "nt-depth-limit";

function holdsChildren(container: PMNode): boolean {
  return NML_LIST_TYPES.has(container.firstChild?.type.name ?? "");
}

function childGroup(container: PMNode): PMNode | null {
  return container.childCount > 1 && container.lastChild?.type.name === "blockGroup"
    ? container.lastChild
    : null;
}

/** The level of the block container that starts at `pos`. */
export function depthAt(doc: PMNode, pos: number): number {
  const $pos = doc.resolve(pos);
  let depth = 1;
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node.type.name === "blockContainer" && holdsChildren(node)) depth++;
  }
  return depth;
}

/** Whether `container` and everything under it fit when it sits at `depth`. */
export function fitsAt(container: PMNode, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  const group = childGroup(container);
  if (!group) return true;
  const below = holdsChildren(container) ? depth + 1 : depth;
  let fits = true;
  group.forEach((child) => {
    fits &&= fitsAt(child, below);
  });
  return fits;
}

/** The level a container nested under `parent` takes, `parent` sitting at `depth`. */
export function depthUnder(parent: PMNode, depth: number): number {
  return holdsChildren(parent) ? depth + 1 : depth;
}

/** List and toggle items at the last level that still hold children. */
function overflowing(doc: PMNode): { pos: number; node: PMNode }[] {
  const found: { pos: number; node: PMNode }[] = [];
  const visit = (group: PMNode, start: number, depth: number) => {
    group.forEach((container, offset) => {
      const children = childGroup(container);
      if (!children) return;
      const pos = start + offset;
      if (holdsChildren(container) && depth >= MAX_DEPTH) {
        found.push({ pos, node: container });
        return;
      }
      visit(children, pos + 2 + container.firstChild!.nodeSize, depthUnder(container, depth));
    });
  };
  const root = doc.firstChild;
  if (root?.type.name === "blockGroup") visit(root, 1, 1);
  return found;
}

/**
 * `container` and every block under it, in document order, as siblings with no
 * children — and where each block's content moved to, so a caret inside one
 * stays where it was.
 */
function flatten(container: PMNode, pos: number) {
  const nodes: PMNode[] = [];
  const moves: { from: number; to: number; size: number }[] = [];
  let at = pos;
  let out = pos;
  const take = (block: PMNode, start: number) => {
    const content = block.firstChild!;
    const flat = block.type.create(block.attrs, content, block.marks);
    moves.push({ from: start + 1, to: out + 1, size: content.nodeSize });
    nodes.push(flat);
    out += flat.nodeSize;
    const group = childGroup(block);
    let child = start + 2 + content.nodeSize;
    group?.forEach((inner) => {
      take(inner, child);
      child += inner.nodeSize;
    });
  };
  take(container, at);
  at += container.nodeSize;
  const place = (x: number): number | null => {
    const move = moves.find(({ from, size }) => x >= from && x <= from + size);
    return move ? move.to + (x - move.from) : null;
  };
  return { nodes, end: at, place };
}

/**
 * Whether a step can change what nests under what. Typing inside one line
 * cannot, and is skipped, so the check never costs a keystroke.
 */
function reshapes(tr: Transaction): boolean {
  return tr.steps.some((step, index) => {
    if (step instanceof ReplaceAroundStep) return true;
    if (!(step instanceof ReplaceStep)) return false;
    const doc = tr.docs[index];
    if (!doc.resolve(step.from).sameParent(doc.resolve(step.to))) return true;
    let blocks = false;
    step.slice.content.descendants((node) => {
      blocks ||= node.type.name === "blockContainer" || node.type.name === "blockGroup";
      return !blocks;
    });
    return blocks;
  });
}

/**
 * A remote edit — a collaborator's, the canonical mirror's projection, or an
 * undo replayed through Yjs — was made within the limit wherever it began.
 * Repairing it here too would have every client repair it at once, and the
 * copies would merge.
 */
function remote(tr: Transaction): boolean {
  const sync = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  // prosemirror-collab marks the steps it receives with `rebased`.
  return !!sync?.isChangeOrigin || tr.getMeta("rebased") !== undefined;
}

/**
 * Where the local edits landed in the final document. Only what they touched is
 * repaired: a legacy page may already hold deeper nesting from before the
 * limit, and an edit elsewhere on it must not rearrange that.
 */
function touched(transactions: readonly Transaction[], local: Set<Transaction>): [number, number][] {
  const maps = transactions.flatMap((tr) => tr.mapping.maps.map((map) => ({ map, local: local.has(tr) })));
  const ranges: [number, number][] = [];
  maps.forEach(({ map, local }, index) => {
    if (!local) return;
    map.forEach((_oldStart, _oldEnd, from, to) => {
      for (const later of maps.slice(index + 1)) {
        from = later.map.map(from, -1);
        to = later.map.map(to, 1);
      }
      ranges.push([from, to]);
    });
  });
  return ranges;
}

function repair(state: EditorState, ranges: [number, number][]): Transaction | null {
  const found = overflowing(state.doc).filter(({ pos, node }) =>
    ranges.some(([from, to]) => from < pos + node.nodeSize && to > pos));
  if (!found.length) return null;
  const tr = state.tr;
  const selection = state.selection instanceof TextSelection ? state.selection : null;
  let anchor = selection?.anchor ?? 0;
  let head = selection?.head ?? 0;
  // Last first, so an earlier block's position still holds when it is reached.
  for (const { pos, node } of found.reverse()) {
    const { nodes, end, place } = flatten(node, pos);
    tr.replaceWith(pos, end, nodes);
    const map = tr.mapping.maps[tr.mapping.maps.length - 1];
    const relocate = (x: number) => (x > pos && x < end ? place(x) ?? map.map(x) : map.map(x));
    anchor = relocate(anchor);
    head = relocate(head);
  }
  if (selection) tr.setSelection(TextSelection.create(tr.doc, anchor, head));
  return tr.setMeta(KEY, true);
}

/**
 * Brings anything an edit nested past the limit — a paste, a drop, a list
 * item made of a line holding children — back to the last level, in order,
 * inside the same dispatch, so the edit and its repair are one undo step.
 * Tab never gets this far: it declines a run that would not fit (`indent.ts`).
 */
export function depthLimitPlugin(enabled: () => boolean): Plugin {
  return new Plugin({
    appendTransaction: (transactions, _oldState, newState) => {
      if (!enabled()) return null;
      const local = new Set(transactions.filter((tr) => tr.docChanged && !remote(tr) && reshapes(tr)));
      return local.size ? repair(newState, touched(transactions, local)) : null;
    },
  });
}

type Options = {
  /** Viewers must never repair a document they are not allowed to write. */
  enabled: () => boolean;
};

export const depthLimitExtension = createExtension(
  ({ options }: ExtensionOptions<Options>) => ({
    key: KEY,
    prosemirrorPlugins: [depthLimitPlugin(() => options.enabled())],
  }),
);
