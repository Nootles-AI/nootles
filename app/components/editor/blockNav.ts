import type { Node as PMNode } from "prosemirror-model";

/**
 * Reading order over a document's blocks — the geometry the block keys walk.
 *
 * Pure: positions and ids in, positions and ids out. Whether a block is on
 * screen is the caller's to say, because a folded toggle hides its children
 * in the DOM and nowhere in the document.
 */

/** One block, where it sits. `end` is the position just past it. */
export interface BlockSpot {
  readonly id: string;
  readonly pos: number;
  readonly end: number;
}

function isBlock(node: PMNode): boolean {
  return node.type.name === "blockContainer" && typeof node.attrs.id === "string";
}

/**
 * Every block a reader sees, parents before their children — the order ↑ and
 * ↓ step through. A block `shown` refuses takes its children with it.
 */
export function blocksInReadingOrder(
  doc: PMNode,
  shown: (pos: number) => boolean = () => true,
): BlockSpot[] {
  const out: BlockSpot[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) return false;
    if (!isBlock(node)) return true;
    if (!shown(pos)) return false;
    out.push({ id: node.attrs.id as string, pos, end: pos + node.nodeSize });
    return true;
  });
  return out;
}

/**
 * The block a plain ↑ or ↓ moves a selection spanning `from`–`to` onto: the
 * last block that starts above it, or the first that starts past its end — so
 * ↓ from a block with children steps over them, since the plate already
 * covers them. Null at either end of the page.
 */
export function blockBeside(
  order: readonly BlockSpot[],
  from: number,
  to: number,
  dir: -1 | 1,
): BlockSpot | null {
  if (dir > 0) return order.find((spot) => spot.pos >= to) ?? null;
  for (let i = order.length - 1; i >= 0; i--) {
    if (order[i].pos < from) return order[i];
  }
  return null;
}

/** The innermost block holding `pos`, or null outside every block. */
export function blockAt(doc: PMNode, pos: number): BlockSpot | null {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (isBlock(node)) {
      const at = $pos.before(depth);
      return { id: node.attrs.id as string, pos: at, end: at + node.nodeSize };
    }
  }
  // A position between blocks — where a node selection of one starts.
  const after = $pos.nodeAfter;
  if (after && isBlock(after)) {
    return { id: after.attrs.id as string, pos, end: pos + after.nodeSize };
  }
  return null;
}

/**
 * The blocks a selection from `from` to `to` touches, as the pair that
 * bounds them — a block range normalizes the pair to whole siblings, so the
 * two ends are all it needs.
 */
export function blocksTouched(doc: PMNode, from: number, to: number): string[] {
  const first = blockAt(doc, from);
  if (!first) return [];
  const last = to > from ? blockAt(doc, to) : first;
  return last && last.id !== first.id ? [first.id, last.id] : [first.id];
}

/**
 * The block's own text, as offsets into the document: its first child is the
 * content node, and only an inline one holds a caret. Null for the content-less
 * blocks — a diagram, a code block — and for a position that is not a block.
 */
export function ownTextRange(
  doc: PMNode,
  blockPos: number,
): { start: number; end: number } | null {
  const block = doc.nodeAt(blockPos);
  const content = block?.firstChild;
  if (!block || !isBlock(block) || !content?.inlineContent) return null;
  const start = blockPos + 2;
  return { start, end: start + content.content.size };
}

/** Where the node with this id starts, or -1. */
export function blockPosById(doc: PMNode, id: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0 || node.isTextblock) return false;
    if (isBlock(node) && node.attrs.id === id) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Where a plain arrow from a plate on one void block — a diagram, an image, a
 * picture of any kind — puts a caret: into the text of the block beside it,
 * at its near end, since there is nothing in the void block to write in and a
 * plate stepping on down the page would never let the writing resume. Null
 * when the plate is not one void block (a code block keeps its own keys), or
 * the block beside has no text.
 */
export function caretBesidePlate(
  doc: PMNode,
  order: readonly BlockSpot[],
  positions: readonly number[],
  dir: -1 | 1,
): number | null {
  if (positions.length !== 1) return null;
  const pos = positions[0];
  const block = doc.nodeAt(pos);
  const content = block?.firstChild;
  if (!block || !content || content.type.name === "codeBlock" || ownTextRange(doc, pos)) return null;
  const target = blockBeside(order, pos, pos + block.nodeSize, dir);
  const text = target && ownTextRange(doc, target.pos);
  if (!text) return null;
  return dir > 0 ? text.start : text.end;
}
