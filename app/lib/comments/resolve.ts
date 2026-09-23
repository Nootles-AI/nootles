import { anchorAt, mintAnchor, WHITESPACE, type BlockText } from "./anchor";
import type { CommentAnchor, Thread } from "./types";

/**
 * Where a comment's quote selector points in the document now — the three-stage
 * resolve of the commenting design (§3), over plain block text.
 *
 * 1. Exact, in the named block.
 * 2. Fuzzy, in the named block: the words were edited, so `exact` is rewritten
 *    to what the text says now.
 * 3. Exact, anywhere else, accepted only when unique: the block was cut and
 *    pasted or dragged, so the anchor is re-homed.
 *
 * Everything here is a pure function of (anchor, persisted flags, blocks) with
 * a total order at every choice, so every client resolving the same thread
 * against the same text computes byte-identical writes — a duplicate write
 * converges instead of conflicting, and nobody has to lead.
 */

/** What the resolver reads of a thread: its anchor and the two cached flags. */
export type ResolveInput = Pick<Thread, "anchor" | "orphanedAt"> & { ambiguous?: boolean };

/**
 * The persistence a resolution asks for, as a patch on the thread. Every field
 * is absent when the stored value is already right, so applying the writes and
 * resolving again yields `{}`.
 *
 * - `anchor`: the whole anchor to store in its place. Written after a fuzzy hit
 *   (new `exact`) or a re-home (new `blockId`), and then re-read from the text
 *   entirely — prefix, suffix and offset hint too — so the next resolve is a
 *   clean exact hit on the same range. A plain exact hit never rewrites: the
 *   anchor still finds its words, and rewriting context on every load would be
 *   a write per nearby keystroke.
 * - `orphaned`: `true` to stamp `orphanedAt` (the store picks the time, and
 *   keeps an existing stamp), `false` to clear it.
 * - `ambiguous`: the new value of the thread's `ambiguous` flag.
 *
 * A resolve against a review's fork must apply none of it: the fork's text is
 * a proposal, and Discard puts the words back.
 */
export type AnchorWrite = { anchor?: CommentAnchor; orphaned?: boolean; ambiguous?: boolean };

export type Resolution =
  | {
      kind: "anchored";
      /** Which stage found it: 1 exact, 2 fuzzy, 3 re-homed. */
      stage: 1 | 2 | 3;
      blockId: string;
      /** `[from, to)` in the block's text. */
      from: number;
      to: number;
      /** The quote appears more than once and its context could not tell which. */
      ambiguous: boolean;
      writes: AnchorWrite;
    }
  | { kind: "orphaned"; writes: AnchorWrite };

export function hasWrites(writes: AnchorWrite): boolean {
  return writes.anchor !== undefined || writes.orphaned !== undefined || writes.ambiguous !== undefined;
}

/**
 * The shortest quote stage 2 will chase. Below this one edit is over a quarter
 * of the words, and a "fuzzy match" of three letters is just another word.
 */
export const MIN_FUZZY_CHARS = 4;

/**
 * Edits (Levenshtein, per code point) a fuzzy hit may carry: a third of the
 * quote. Enough for a typo fixed, a word swapped or a plural in a short phrase,
 * and still well short of the half at which one sentence can be edited into an
 * unrelated one — past this the text was rewritten, not drifted, and the
 * design says a rewrite orphans (§13).
 */
export const fuzzyBudget = (length: number) => Math.floor(length / 3);

/**
 * The most dynamic-programming cells stage 2 spends on one thread — a few
 * milliseconds. A block too long to scan whole is scanned only near where the
 * quote used to be; a quote too long even for that degrades to a miss (and so
 * to stage 3) rather than stalling a page load.
 */
export const FUZZY_CELL_LIMIT = 2_000_000;

type Candidate = { blockId: string; from: number; to: number; score: number };

/**
 * How much of the stored context still surrounds `[from, to)`: characters of
 * `prefix` matching backwards from `from`, plus characters of `suffix` matching
 * forwards from `to`.
 */
function contextScore(text: string, from: number, to: number, anchor: CommentAnchor): number {
  const { prefix, suffix } = anchor;
  let before = 0;
  while (
    before < prefix.length &&
    before < from &&
    text[from - 1 - before] === prefix[prefix.length - 1 - before]
  ) {
    before++;
  }
  let after = 0;
  while (after < suffix.length && to + after < text.length && text[to + after] === suffix[after]) {
    after++;
  }
  return before + after;
}

function occurrences(block: BlockText, anchor: CommentAnchor): Candidate[] {
  const found: Candidate[] = [];
  const { exact } = anchor;
  for (let at = block.text.indexOf(exact); at !== -1; at = block.text.indexOf(exact, at + 1)) {
    const to = at + exact.length;
    found.push({ blockId: block.blockId, from: at, to, score: contextScore(block.text, at, to, anchor) });
  }
  return found;
}

function bestScore(found: readonly Candidate[]): number {
  let best = -1;
  for (const candidate of found) if (candidate.score > best) best = candidate.score;
  return best;
}

const hintOf = (anchor: CommentAnchor) =>
  Number.isFinite(anchor.offsetHint) ? anchor.offsetHint : 0;

/**
 * Stage 1's total order over one block's occurrences: best context, then
 * nearest the offset hint, then lowest offset. `ambiguous` when the best
 * context is shared, i.e. the choice fell to the hint.
 */
function pick(found: Candidate[], anchor: CommentAnchor): { hit: Candidate; ambiguous: boolean } | null {
  if (!found.length) return null;
  const best = bestScore(found);
  const tied = found.filter((candidate) => candidate.score === best);
  const hint = hintOf(anchor);
  tied.sort((a, b) => Math.abs(a.from - hint) - Math.abs(b.from - hint) || a.from - b.from);
  return { hit: tied[0], ambiguous: tied.length > 1 };
}

function exactInBlock(block: BlockText, anchor: CommentAnchor) {
  return pick(occurrences(block, anchor), anchor);
}

/** Code points of `text`, with the UTF-16 offset each starts at (plus the end). */
function codePoints(text: string): { points: number[]; at: number[] } {
  const points: number[] = [];
  const at: number[] = [];
  for (let i = 0; i < text.length; ) {
    const point = text.codePointAt(i)!;
    points.push(point);
    at.push(i);
    i += point > 0xffff ? 2 : 1;
  }
  at.push(text.length);
  return { points, at };
}

/**
 * Stage 2: the substring of the block closest to `exact` by edit distance,
 * within `fuzzyBudget`.
 *
 * `textDiff.align` is a global alignment — it walks one whole sequence into
 * another, and its LCS objective charges nothing for unmatched characters, so
 * run over a block it would gather the quote's letters from all over the
 * paragraph. Finding where a quote now sits is a LOCAL alignment: Sellers'
 * variant of the Levenshtein table, free to start and end anywhere in the
 * block. It runs over code points, so a hit never begins or ends inside a
 * surrogate pair.
 *
 * Among hits: fewest edits, then best context, then nearest the offset hint,
 * then lowest offset — stage 1's order with distance in front.
 */
function fuzzyInBlock(block: BlockText, anchor: CommentAnchor): Candidate | null {
  const quote = codePoints(anchor.exact).points;
  const n = quote.length;
  if (n < MIN_FUZZY_CHARS) return null;
  const budget = fuzzyBudget(n);
  const { points, at } = codePoints(block.text);

  // The whole block when it is affordable; otherwise a window around where the
  // quote began, wide enough for it to have moved by its own length either way.
  let lo = 0;
  let hi = points.length;
  if (n * points.length > FUZZY_CELL_LIMIT) {
    const hint = hintOf(anchor);
    let start = 0;
    while (start < points.length && at[start] < hint) start++;
    lo = Math.max(0, start - n - budget);
    hi = Math.min(points.length, start + 2 * n + budget);
    if (n * (hi - lo) > FUZZY_CELL_LIMIT) return null;
  }

  // One column of the table per text position: cost[i] is the fewest edits
  // turning quote[0, i) into some text ending here, and origin[i] where that
  // text starts. Ties keep the later origin — the tighter span.
  let cost = new Int32Array(n + 1);
  let origin = new Int32Array(n + 1);
  let nextCost = new Int32Array(n + 1);
  let nextOrigin = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++) {
    cost[i] = i;
    origin[i] = lo;
  }
  const hits: Array<{ from: number; to: number; edits: number }> = [];
  for (let j = lo + 1; j <= hi; j++) {
    const point = points[j - 1];
    nextCost[0] = 0;
    nextOrigin[0] = j;
    for (let i = 1; i <= n; i++) {
      let best = cost[i - 1] + (quote[i - 1] === point ? 0 : 1);
      let from = origin[i - 1];
      const skipQuote = nextCost[i - 1] + 1;
      if (skipQuote < best || (skipQuote === best && nextOrigin[i - 1] > from)) {
        best = skipQuote;
        from = nextOrigin[i - 1];
      }
      const skipText = cost[i] + 1;
      if (skipText < best || (skipText === best && origin[i] > from)) {
        best = skipText;
        from = origin[i];
      }
      nextCost[i] = best;
      nextOrigin[i] = from;
    }
    if (nextCost[n] <= budget) hits.push({ from: nextOrigin[n], to: j, edits: nextCost[n] });
    [cost, nextCost] = [nextCost, cost];
    [origin, nextOrigin] = [nextOrigin, origin];
  }

  const { text } = block;
  const hint = hintOf(anchor);
  let winner: (Candidate & { edits: number }) | null = null;
  for (const hit of hits) {
    let from = at[hit.from];
    let to = at[hit.to];
    // A quote never starts or ends on whitespace (the mint trims it), so
    // shedding it from a hit never costs an edit.
    while (from < to && WHITESPACE.test(text[from])) from++;
    while (to > from && WHITESPACE.test(text[to - 1])) to--;
    if (from === to) continue;
    const score = contextScore(text, from, to, anchor);
    const candidate = { blockId: block.blockId, from, to, edits: hit.edits, score };
    if (better(candidate, winner, hint)) winner = candidate;
  }
  return winner;
}

function better(
  a: Candidate & { edits: number },
  b: (Candidate & { edits: number }) | null,
  hint: number,
): boolean {
  if (!b) return true;
  if (a.edits !== b.edits) return a.edits < b.edits;
  if (a.score !== b.score) return a.score > b.score;
  const distance = Math.abs(a.from - hint) - Math.abs(b.from - hint);
  if (distance) return distance < 0;
  if (a.from !== b.from) return a.from < b.from;
  return a.to < b.to;
}

/**
 * Stage 3: the quote exactly, anywhere but the block it names. A sole
 * occurrence is taken. Among several, the one with the best context is taken
 * only when it leads outright AND still has at least half its stored context
 * around it — the words it was said about moved with it. Anything less would
 * move a thread onto a guess, so it orphans instead.
 */
function exactElsewhere(blocks: readonly BlockText[], anchor: CommentAnchor): Candidate | null {
  const found = blocks.flatMap((block) =>
    block.blockId === anchor.blockId ? [] : occurrences(block, anchor),
  );
  if (found.length <= 1) return found[0] ?? null;
  const best = bestScore(found);
  const top = found.filter((candidate) => candidate.score === best);
  const context = anchor.prefix.length + anchor.suffix.length;
  return top.length === 1 && best > 0 && best * 2 >= context ? top[0] : null;
}

/**
 * Resolve a thread's anchor against the document's blocks (document order,
 * quotable text only — see `pmText.ts`).
 */
export function resolveAnchor(input: ResolveInput, blocks: readonly BlockText[]): Resolution {
  const { anchor } = input;
  const wasOrphaned = input.orphanedAt !== undefined;
  const wasAmbiguous = input.ambiguous === true;

  const anchored = (
    stage: 1 | 2 | 3,
    block: BlockText,
    from: number,
    to: number,
    ambiguous: boolean,
    rewrite: CommentAnchor | null,
  ): Resolution => ({
    kind: "anchored",
    stage,
    blockId: block.blockId,
    from,
    to,
    ambiguous,
    writes: {
      ...(rewrite ? { anchor: rewrite } : {}),
      ...(wasOrphaned ? { orphaned: false } : {}),
      ...(ambiguous !== wasAmbiguous ? { ambiguous } : {}),
    },
  });

  // Rewritten anchors are re-read whole from the text, and their ambiguity is
  // what stage 1 will say of them next time — so the write is final.
  const rewritten = (stage: 2 | 3, block: BlockText, from: number, to: number): Resolution => {
    const next = anchorAt(block, from, to);
    const again = exactInBlock(block, next);
    return anchored(stage, block, from, to, again?.ambiguous ?? false, next);
  };

  // Stored anchors are client-written and never inspected by the server, so a
  // blank quote — which would match everywhere — is read as matching nowhere.
  if (typeof anchor.exact === "string" && anchor.exact.trim() !== "") {
    const home = blocks.find((block) => block.blockId === anchor.blockId);
    if (home) {
      const exact = exactInBlock(home, anchor);
      if (exact) return anchored(1, home, exact.hit.from, exact.hit.to, exact.ambiguous, null);
      const fuzzy = fuzzyInBlock(home, anchor);
      if (fuzzy) return rewritten(2, home, fuzzy.from, fuzzy.to);
    }
    const moved = exactElsewhere(blocks, anchor);
    if (moved) {
      const block = blocks.find((candidate) => candidate.blockId === moved.blockId)!;
      return rewritten(3, block, moved.from, moved.to);
    }
  }

  return {
    kind: "orphaned",
    writes: {
      ...(wasOrphaned ? {} : { orphaned: true }),
      ...(wasAmbiguous ? { ambiguous: false } : {}),
    },
  };
}

export type AnchorCheck =
  | { ok: true; from: number; to: number; ambiguous: boolean }
  | { ok: false; reason: "empty_quote" | "no_such_block" | "quote_not_in_block" };

/**
 * Whether an anchor quotes its block verbatim, right now — stage 1 only.
 *
 * This is the gate for anchors that have not been stored yet, such as one the
 * assistant proposes: the fuzzy and document-wide stages exist to follow text
 * that moved AFTER an anchor was made, and granting them to a new anchor would
 * accept a paraphrase or the wrong block as a quotation. A freshly minted
 * anchor always passes, onto exactly the range it was minted from.
 */
export function validateAnchor(anchor: CommentAnchor, blocks: readonly BlockText[]): AnchorCheck {
  if (typeof anchor.exact !== "string" || anchor.exact.trim() === "") {
    return { ok: false, reason: "empty_quote" };
  }
  const block = blocks.find((candidate) => candidate.blockId === anchor.blockId);
  if (!block) return { ok: false, reason: "no_such_block" };
  const found = exactInBlock(block, anchor);
  if (!found) return { ok: false, reason: "quote_not_in_block" };
  return { ok: true, from: found.hit.from, to: found.hit.to, ambiguous: found.ambiguous };
}

export type Quote = Pick<CommentAnchor, "blockId" | "exact"> &
  Partial<Pick<CommentAnchor, "prefix" | "suffix" | "offsetHint">>;

/**
 * A stored-ready anchor for a quotation of a block — how the assistant, which
 * names a block and quotes words from it, makes an anchor. The quote must pass
 * `validateAnchor`; the anchor is then minted afresh from the range it found,
 * so its context is the document's rather than the model's recollection of it.
 *
 * `guessed` says the quote, with whatever context came with it, matched more
 * than once and the total order picked one — a caller may refuse and ask for
 * more context. `ambiguous` is the minted anchor's own flag, the one to store.
 */
export function anchorForQuote(
  quote: Quote,
  blocks: readonly BlockText[],
):
  | { ok: true; anchor: CommentAnchor; ambiguous: boolean; guessed: boolean }
  | Extract<AnchorCheck, { ok: false }> {
  const check = validateAnchor(
    {
      blockId: quote.blockId,
      exact: quote.exact,
      prefix: quote.prefix ?? "",
      suffix: quote.suffix ?? "",
      offsetHint: quote.offsetHint ?? 0,
    },
    blocks,
  );
  if (!check.ok) return check;
  const block = blocks.find((candidate) => candidate.blockId === quote.blockId)!;
  const anchor = mintAnchor(block, check.from, check.to)!;
  const minted = validateAnchor(anchor, blocks);
  return { ok: true, anchor, ambiguous: minted.ok && minted.ambiguous, guessed: check.ambiguous };
}
