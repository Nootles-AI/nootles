import type { Node } from "prosemirror-model";
import type { NmlBlock, NmlDocument, NmlInlineContent } from "@/app/lib/nml/schema";
import { mintAnchorFromSpans, type BlockText, type SelectionSpan } from "./anchor";
import type { CommentAnchor } from "./types";

/**
 * The resolver's block text, read from the editor's ProseMirror document or
 * from an NML document — and the way back from a text offset to a ProseMirror
 * position. The two readers agree character for character on the same
 * content, so a thread resolves to the same range in the editor and on the
 * server, and an anchor the assistant mints from NML lands where it should on
 * screen.
 *
 * The text of a block is its inline content as the review diff reads it:
 * - text as written, links included;
 * - a line break (`hardBreak`) as `\n`, which is how BlockNote and NML both
 *   spell it;
 * - a tick box as one character, ☐ or ☑ — its state is all it says;
 * - an inline maths node or a page mention as nothing: it holds a position
 *   but no quotable words.
 *
 * Only blocks with inline content have text. Tables, code, maths blocks,
 * media and diagrams are left out: a comment quotes running text, and
 * comments on a table cell or a shape are deliberately out of scope (§13).
 */

/**
 * The two shapes a tick box takes in text. A box is the one atom that
 * contributes a character, because its state is the whole of what it says: an
 * agent that ticks a box changes nothing else in the cell, and the review diff
 * must be able to draw that. One character, so the positions after it do not
 * shift.
 */
const CHECK_CHAR = { on: "☑", off: "☐" } as const;
export const checkChar = (checked: unknown): string =>
  checked === true ? CHECK_CHAR.on : CHECK_CHAR.off;

/** Inline text with the document position of every character, plus the end. */
export type CharMap = { text: string; posAt: number[] };

/**
 * `content`'s text with the position of each character, `content` being an
 * inline-content node whose content starts at `start`. Every atom occupies a
 * position; only a tick box and a line break contribute a character, so an
 * offset into the text becomes a position without sliding past a maths node.
 */
export function charMap(content: Node, start: number): CharMap {
  let text = "";
  const posAt: number[] = [];
  content.forEach((child, offset) => {
    if (child.type.name === "checkbox" || child.type.name === "hardBreak") {
      posAt.push(start + offset);
      text += child.type.name === "checkbox" ? checkChar(child.attrs.checked) : "\n";
      return;
    }
    if (!child.isText) return;
    const value = child.text ?? "";
    for (let i = 0; i < value.length; i++) posAt.push(start + offset + i);
    text += value;
  });
  posAt.push(start + content.content.size);
  return { text, posAt };
}

/**
 * A block of the editor's document: its text, where each character sits, and
 * the positions its inline content opens and closes at.
 */
export type PmBlockText = BlockText & { map: CharMap; start: number; end: number };

/**
 * Every block with inline content, in document order — or only those touching
 * `[from, to]`. Ids sit on BlockNote's block containers; the container's first
 * child is the content node, which opens one position inside the container.
 */
export function pmBlockTexts(doc: Node, from = 0, to = doc.content.size): PmBlockText[] {
  const blocks: PmBlockText[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    const id = (node.attrs as { id?: unknown }).id;
    const content = node.firstChild;
    if (typeof id === "string" && content?.inlineContent) {
      const start = pos + 2;
      const map = charMap(content, start);
      blocks.push({ blockId: id, text: map.text, map, start, end: start + content.content.size });
    }
    // Containers and groups hold blocks; nothing below a content node does.
    return !node.isTextblock && !node.type.spec.group?.split(" ").includes("blockContent");
  });
  return blocks;
}

/** The NML reading of the same text, block for block. */
export function nmlInlineText(content: NmlInlineContent): string {
  return content
    .map((node) => {
      switch (node.type) {
        case "text":
          return node.text;
        case "link":
          return node.content.map((run) => run.text).join("");
        case "checkbox":
          return checkChar(node.checked);
        case "math":
        case "pageRef":
          return "";
      }
    })
    .join("");
}

/** A page document's blocks as the resolver reads them — no editor needed. */
export function nmlBlockTexts(document: NmlDocument): BlockText[] {
  if (document.kind === "comments") throw new Error("A comments document has no page text.");
  const blocks: BlockText[] = [];
  const visit = (list: NmlBlock[]) => {
    for (const block of list) {
      if ("content" in block) blocks.push({ blockId: block.id, text: nmlInlineText(block.content) });
      visit(block.children);
    }
  };
  visit(document.blocks);
  return blocks;
}

/**
 * The document position of a text offset. A range's start sits before its
 * first character and its end after its last, so an atom at either edge — a
 * maths node just past the quote — stays outside the range.
 */
export function positionAt(block: PmBlockText, offset: number, side: "start" | "end"): number {
  const { posAt } = block.map;
  const at = Math.max(0, Math.min(block.text.length, offset));
  if (side === "start" || at === 0) return posAt[at];
  return posAt[at - 1] + 1;
}

/** `[from, to)` of a block's text as document positions, or `null` if the block is gone. */
export function pmRange(
  blocks: readonly PmBlockText[],
  blockId: string,
  from: number,
  to: number,
): { from: number; to: number } | null {
  const block = blocks.find((candidate) => candidate.blockId === blockId);
  if (!block) return null;
  return { from: positionAt(block, from, "start"), to: positionAt(block, to, "end") };
}

/** How many of the block's characters sit before `pos` — its text offset there. */
export function offsetAt(block: PmBlockText, pos: number): number {
  const { posAt } = block.map;
  let lo = 0;
  let hi = block.text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (posAt[mid] < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A selection's share of each text block it touches, in document order, as
 * text offsets.
 */
export function selectionSpans(
  blocks: readonly PmBlockText[],
  from: number,
  to: number,
): SelectionSpan[] {
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return blocks.flatMap((block) => {
    if (hi < block.start || lo > block.end) return [];
    const start = offsetAt(block, lo);
    const end = offsetAt(block, hi);
    return start < end ? [{ blockId: block.blockId, from: start, to: end }] : [];
  });
}

/** The anchor a ProseMirror selection makes (see `mintAnchorFromSpans`). */
export function anchorForSelection(doc: Node, from: number, to: number): CommentAnchor | null {
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const blocks = pmBlockTexts(doc, lo, hi);
  return mintAnchorFromSpans(blocks, selectionSpans(blocks, lo, hi));
}
