import { CONTEXT_CHARS, type CommentAnchor } from "./types";

/**
 * Minting a comment anchor: a selection in a block's text becomes the quote
 * selector a thread keeps. One pure function for the selection toolbar and for
 * the assistant, so an anchor means the same thing whoever made it.
 *
 * Offsets are UTF-16 code units into `BlockText.text` — JavaScript string
 * indices, which are also ProseMirror's unit inside a text node.
 */

/**
 * A block's quotable text, in document order. What the resolver searches and
 * the mint reads; `pmText.ts` builds it from an editor or an NML document, and
 * both builders agree character for character.
 */
export type BlockText = { blockId: string; text: string };

/** A selection's share of one block, as `[from, to)` offsets into its text. */
export type SelectionSpan = { blockId: string; from: number; to: number };

const isHigh = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** Whether `offset` falls inside a surrogate pair rather than between characters. */
export function splitsPair(text: string, offset: number): boolean {
  return (
    offset > 0 &&
    offset < text.length &&
    isHigh(text.charCodeAt(offset - 1)) &&
    isLow(text.charCodeAt(offset))
  );
}

/**
 * The anchor for exactly `[from, to)`, context and all. Deterministic and
 * locale-free, because the resolver calls it too and two clients must mint
 * the same bytes: offsets must already sit between code points.
 *
 * The context never starts or ends inside a surrogate pair — a lone half is
 * not a character, and Yjs stores strings as UTF-8, where a lone surrogate
 * becomes U+FFFD and the context would stop matching the text it came from.
 */
export function anchorAt(block: BlockText, from: number, to: number): CommentAnchor {
  const { text } = block;
  let head = Math.max(0, from - CONTEXT_CHARS);
  if (splitsPair(text, head)) head++;
  let tail = Math.min(text.length, to + CONTEXT_CHARS);
  if (splitsPair(text, tail)) tail--;
  return {
    blockId: block.blockId,
    exact: text.slice(from, to),
    prefix: text.slice(head, from),
    suffix: text.slice(to, tail),
    offsetHint: from,
  };
}

const segmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

/**
 * `[from, to)` widened to whole characters as a reader sees them: never half
 * an emoji, never a letter without its accent. Grapheme clusters where the
 * runtime can segment them, code points where it cannot. Only the mint snaps
 * to graphemes — it runs once, on one client — while the resolver keeps to
 * code points, whose boundaries no runtime can disagree about.
 */
function snap(text: string, from: number, to: number): [number, number] {
  if (segmenter) {
    for (const { index, segment } of segmenter.segment(text)) {
      if (index >= to) break;
      const end = index + segment.length;
      if (index < from && from < end) from = index;
      if (index < to && to < end) to = end;
    }
    return [from, to];
  }
  return [splitsPair(text, from) ? from - 1 : from, splitsPair(text, to) ? to + 1 : to];
}

export const WHITESPACE = /\s/;

/**
 * The anchor a selection of `[from, to)` in `block` makes, or `null` when it
 * would quote nothing.
 *
 * - Offsets are clamped to the block and may come in either order.
 * - The range widens to whole graphemes, then sheds leading and trailing
 *   whitespace: a double-click that took the space after a word comments on
 *   the word, and a quote that starts on a letter is one the resolver can
 *   bracket precisely.
 * - Empty and whitespace-only selections are refused.
 */
export function mintAnchor(block: BlockText, from: number, to: number): CommentAnchor | null {
  const { text } = block;
  const clamp = (n: number) => Math.max(0, Math.min(text.length, Number.isFinite(n) ? Math.trunc(n) : 0));
  let start = Math.min(clamp(from), clamp(to));
  let end = Math.max(clamp(from), clamp(to));
  if (start === end) return null;
  [start, end] = snap(text, start, end);
  // Whitespace is never astral, so trimming by code unit cannot split a pair.
  while (start < end && WHITESPACE.test(text[start])) start++;
  while (end > start && WHITESPACE.test(text[end - 1])) end--;
  if (start === end) return null;
  return anchorAt(block, start, end);
}

/**
 * The anchor for a selection that may cross blocks, given as its per-block
 * spans in document order. It anchors to the FIRST span that quotes anything,
 * clamped to that block: a comment hangs off one block, and the one the
 * selection starts in is where a reader's eye went first. A selection that
 * merely begins at the end of one block (or on a blank line) belongs to the
 * next block with words in it rather than to nothing.
 */
export function mintAnchorFromSpans(
  blocks: readonly BlockText[],
  spans: readonly SelectionSpan[],
): CommentAnchor | null {
  for (const span of spans) {
    const block = blocks.find((candidate) => candidate.blockId === span.blockId);
    const anchor = block ? mintAnchor(block, span.from, span.to) : null;
    if (anchor) return anchor;
  }
  return null;
}
