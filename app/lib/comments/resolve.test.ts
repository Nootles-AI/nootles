import { describe, expect, it } from "vitest";
import { mintAnchor, type BlockText } from "./anchor";
import {
  anchorForQuote,
  FUZZY_CELL_LIMIT,
  hasWrites,
  resolveAnchor,
  validateAnchor,
  type ResolutionWrite,
  type ResolveInput,
  type Resolution,
} from "./resolve";
import type { CommentAnchor } from "./types";

const b = (blockId: string, text: string): BlockText => ({ blockId, text });

function anchorOf(block: BlockText, quote: string, nth = 0): CommentAnchor {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = block.text.indexOf(quote, at + 1);
  if (at < 0) throw new Error(`"${quote}" not in block`);
  return mintAnchor(block, at, at + quote.length)!;
}

/** What the comments store does with a resolution's writes. */
function apply(input: ResolveInput, writes: ResolutionWrite, now = 1_000): ResolveInput {
  const next: ResolveInput = { ...input, anchor: writes.anchor ?? input.anchor };
  if (writes.orphaned === true) next.orphanedAt = input.orphanedAt ?? now;
  if (writes.orphaned === false) delete next.orphanedAt;
  if (writes.ambiguous !== undefined) next.ambiguous = writes.ambiguous;
  return next;
}

/** Resolving again after applying the writes must ask for nothing more, and land in the same place. */
function settles(input: ResolveInput, blocks: BlockText[]): Resolution {
  const first = resolveAnchor(input, blocks);
  const second = resolveAnchor(apply(input, first.writes), blocks);
  expect(second.writes).toEqual({});
  if (first.kind === "anchored" && second.kind === "anchored") {
    expect([second.blockId, second.from, second.to, second.ambiguous]).toEqual([
      first.blockId,
      first.from,
      first.to,
      first.ambiguous,
    ]);
  } else {
    expect(second.kind).toBe(first.kind);
  }
  return first;
}

const quoted = (blocks: BlockText[], r: Resolution) => {
  if (r.kind !== "anchored") return null;
  return blocks.find((block) => block.blockId === r.blockId)!.text.slice(r.from, r.to);
};

describe("stage 1 — exact, in the named block", () => {
  const p = b("p1", "We should ship it by Friday if the tests pass.");

  it("finds a unique quote and writes nothing", () => {
    const anchor = anchorOf(p, "by Friday");
    const r = resolveAnchor({ anchor }, [p]);
    expect(r).toEqual({
      kind: "anchored",
      stage: 1,
      blockId: "p1",
      from: anchor.offsetHint,
      to: anchor.offsetHint + 9,
      ambiguous: false,
      writes: {},
    });
  });

  it("follows the words when text before them moves them, without rewriting", () => {
    const anchor = anchorOf(p, "by Friday");
    const moved = b("p1", `Update: ${p.text}`);
    const r = resolveAnchor({ anchor }, [moved]);
    expect(r).toMatchObject({ stage: 1, from: anchor.offsetHint + 8, writes: {} });
  });

  it("narrows several occurrences by prefix and suffix", () => {
    const text = b("p1", "Call Anna on Monday. Call Bob on Monday. Call Cy on Monday.");
    const anchor = anchorOf(text, "on Monday", 1);
    // Move the hint far away: context alone must choose.
    const r = resolveAnchor({ anchor: { ...anchor, offsetHint: 0 } }, [text]);
    expect(r).toMatchObject({ stage: 1, from: text.text.indexOf("Bob on Monday") + 4, ambiguous: false });
  });

  it("prefers the occurrence whose context survives best after nearby edits", () => {
    const text = b("p1", "alpha beta gamma — the release — delta epsilon — the release — zeta");
    const anchor = anchorOf(text, "the release", 1);
    const edited = b("p1", "alpha beta gamma — the release — delta EPSILON — the release — zeta");
    // The prefix of the second occurrence now matches only " — "; the suffix still fully.
    const r = resolveAnchor({ anchor }, [edited]);
    expect(r.kind === "anchored" && r.from).toBe(edited.text.lastIndexOf("the release"));
  });

  it("falls to the nearest offset hint when the context is identical, and says so", () => {
    const text = b("p1", "ok ok ok ok ok");
    const second = { ...anchorOf(text, "ok", 2), prefix: "", suffix: "" };
    const r = resolveAnchor({ anchor: second }, [text]);
    expect(r).toMatchObject({ stage: 1, from: 6, ambiguous: true, writes: { ambiguous: true } });
  });

  it("then to the lowest offset when the hint is equidistant", () => {
    const text = b("p1", "xx ab xx ab xx");
    // Occurrences at 3 and 9; a hint of 6 is three from each.
    const anchor: CommentAnchor = { blockId: "p1", exact: "ab", prefix: "", suffix: "", offsetHint: 6 };
    expect(resolveAnchor({ anchor }, [text])).toMatchObject({ from: 3, ambiguous: true });
  });

  it("finds overlapping occurrences", () => {
    const text = b("p1", "aaaa");
    const anchor: CommentAnchor = { blockId: "p1", exact: "aa", prefix: "", suffix: "", offsetHint: 2 };
    expect(resolveAnchor({ anchor }, [text])).toMatchObject({ from: 2, to: 4, ambiguous: true });
  });

  it("clears a stale orphan stamp and a stale ambiguity flag", () => {
    const anchor = anchorOf(p, "by Friday");
    const r = resolveAnchor({ anchor, orphanedAt: 5, ambiguous: true }, [p]);
    expect(r.writes).toEqual({ orphaned: false, ambiguous: false });
    settles({ anchor, orphanedAt: 5, ambiguous: true }, [p]);
  });

  it("identical context in a minted anchor still resolves to its own occurrence", () => {
    const text = b("p1", `${"na ".repeat(40)}batman ${"na ".repeat(40)}`);
    const at = 3 * 20;
    const anchor = mintAnchor(text, at, at + 2)!;
    const r = resolveAnchor({ anchor }, [text]);
    expect(r).toMatchObject({ from: at, to: at + 2, ambiguous: true });
    settles({ anchor }, [text]);
  });
});

describe("stage 2 — fuzzy, in the named block", () => {
  const original = b("p1", "We should ship the new onboarding flow by Friday if the tests pass.");
  const anchor = anchorOf(original, "ship the new onboarding flow");

  it("follows a small edit inside the quote and rewrites exact to what it says now", () => {
    const edited = b("p1", "We should ship the revised onboarding flow by Friday if the tests pass.");
    const r = resolveAnchor({ anchor }, [edited]);
    expect(r).toMatchObject({ kind: "anchored", stage: 2, blockId: "p1" });
    expect(quoted([edited], r)).toBe("ship the revised onboarding flow");
    expect(r.writes.anchor).toEqual(mintAnchor(edited, r.kind === "anchored" ? r.from : 0, r.kind === "anchored" ? r.to : 0));
    settles({ anchor }, [edited]);
  });

  it("follows a typo, a misspelling, and an edit plus a shift", () => {
    for (const [text, expected] of [
      ["We should ship teh new onboarding flow by Friday.", "ship teh new onboarding flow"],
      ["We should ship the new onbording flow by Friday.", "ship the new onbording flow"],
      ["Note: we should ship a new onboarding flow by Friday.", "ship a new onboarding flow"],
    ] as const) {
      const block = b("p1", text);
      const r = settles({ anchor }, [block]);
      expect(r).toMatchObject({ stage: 2 });
      expect(quoted([block], r)).toBe(expected);
    }
  });

  it("follows an edit at the quote's edge", () => {
    const edited = b("p1", "We should ship the new onboarding screens by Friday if the tests pass.");
    const r = settles({ anchor }, [edited]);
    expect(r).toMatchObject({ stage: 2 });
    expect(quoted([edited], r)).toMatch(/^ship the new onboarding/);
  });

  it("misses when the quote was rewritten past a third of its length", () => {
    const rewritten = b("p1", "We should postpone everything until the audit is finished.");
    const r = resolveAnchor({ anchor }, [rewritten]);
    expect(r).toEqual({ kind: "orphaned", writes: { orphaned: true } });
  });

  it("does not chase quotes too short for fuzziness to mean anything", () => {
    const text = b("p1", "the cat sat");
    const short = anchorOf(text, "cat");
    expect(resolveAnchor({ anchor: short }, [b("p1", "the bat sat")]).kind).toBe("orphaned");
  });

  it("never starts or ends a rewritten quote on whitespace or inside a surrogate pair", () => {
    const text = b("p1", "Launch 🚀 rocket party on the roof deck tonight");
    const a = anchorOf(text, "🚀 rocket party");
    const edited = b("p1", "Launch 🚀 rockets party on the roof deck tonight");
    const r = settles({ anchor: a }, [edited]);
    expect(r).toMatchObject({ stage: 2 });
    const exact = r.writes.anchor!.exact;
    expect(exact).toBe("🚀 rockets party");
    expect(exact.trim()).toBe(exact);
  });

  it("chooses deterministically between equally close candidates: context, then hint, then offset", () => {
    const text = b("p1", "A: the quick brown fox. B: the quick brown fox.");
    const a = anchorOf(text, "the quick brown fox", 1);
    const edited = b("p1", "A: the quick brown cat. B: the quick brown cat.");
    const r = settles({ anchor: a }, [edited]);
    expect(r.kind === "anchored" && r.from).toBe(edited.text.lastIndexOf("the quick brown cat"));
  });

  it("rewrites into a quote that may itself be ambiguous, and records it", () => {
    const text = b("p1", "go go gadget, go go gadget");
    const a: CommentAnchor = { blockId: "p1", exact: "go go gadgets", prefix: "", suffix: "", offsetHint: 0 };
    const r = settles({ anchor: a }, [text]);
    expect(r).toMatchObject({ stage: 2, from: 0, ambiguous: false });
  });
});

describe("stage 3 — exact, anywhere else", () => {
  const p1 = b("p1", "Intro paragraph.");
  const p2 = b("p2", "We should ship it by Friday if the tests pass.");
  const anchor = anchorOf(p2, "ship it by Friday");

  it("re-homes a quote whose block was cut and pasted under a new id", () => {
    const pasted = b("p9", p2.text);
    const r = settles({ anchor }, [p1, pasted]);
    expect(r).toMatchObject({ kind: "anchored", stage: 3, blockId: "p9", from: 10 });
    expect(r.writes.anchor).toEqual({ ...anchor, blockId: "p9" });
  });

  it("re-homes when the named block still exists but lost the words", () => {
    const r = settles({ anchor }, [b("p2", "Nothing here now."), b("p3", "Moved: ship it by Friday.")]);
    expect(r).toMatchObject({ stage: 3, blockId: "p3" });
    expect(r.writes.anchor).toMatchObject({ blockId: "p3", prefix: "Moved: ", suffix: "." });
  });

  it("disambiguates several copies by context, accepting only a strict winner", () => {
    const r = resolveAnchor({ anchor }, [
      b("p3", "Elsewhere, ship it by Friday."),
      b("p4", "We should ship it by Friday if the tests pass."),
    ]);
    expect(r).toMatchObject({ stage: 3, blockId: "p4" });
  });

  it("orphans rather than guess between copies with equal context", () => {
    const r = resolveAnchor({ anchor }, [b("p3", "We should ship it by Friday if the tests pass."), b("p4", "We should ship it by Friday if the tests pass.")]);
    expect(r).toEqual({ kind: "orphaned", writes: { orphaned: true } });
  });

  it("orphans rather than move onto copies whose lead in context is too thin to mean anything", () => {
    const todo: CommentAnchor = { blockId: "a", exact: "TODO", prefix: "x ", suffix: " y", offsetHint: 0 };
    const blocks = [b("a", "done now"), b("b", "a TODO b"), b("c", "TODO later")];
    // b keeps the two spaces (2 of 4 context characters) and leads c by one:
    // half the context is the bar, so this one is taken...
    expect(resolveAnchor({ anchor: todo }, blocks)).toMatchObject({ stage: 3, blockId: "b" });
    // ...but not with a longer context of which only the spaces survive.
    const long = { ...todo, prefix: "remember to x ", suffix: " y before Friday" };
    expect(resolveAnchor({ anchor: long }, blocks).kind).toBe("orphaned");
  });

  it("takes a sole occurrence elsewhere whatever became of its context", () => {
    const r = resolveAnchor({ anchor }, [b("p3", "Totally new words around ship it by Friday here")]);
    expect(r).toMatchObject({ stage: 3, blockId: "p3" });
  });

  it("does not re-home a fuzzy lookalike", () => {
    const r = resolveAnchor({ anchor }, [b("p3", "We should ship it by Friday-ish if the tests pass.".replace("Friday", "Fri day"))]);
    expect(r.kind).toBe("orphaned");
  });

  it("two clients resolving the same move converge on identical writes", () => {
    const blocks = [p1, b("pA", p2.text)];
    expect(resolveAnchor({ anchor }, blocks)).toEqual(resolveAnchor({ anchor: { ...anchor } }, [...blocks]));
  });
});

describe("orphaning", () => {
  const p = b("p1", "We should ship it by Friday if the tests pass.");
  const anchor = anchorOf(p, "by Friday");

  it("orphans when every stage misses, once", () => {
    const blocks = [b("p1", "Totally different words.")];
    expect(resolveAnchor({ anchor }, blocks)).toEqual({ kind: "orphaned", writes: { orphaned: true } });
    expect(resolveAnchor({ anchor, orphanedAt: 7 }, blocks)).toEqual({ kind: "orphaned", writes: {} });
    expect(resolveAnchor({ anchor, ambiguous: true }, blocks).writes).toEqual({ orphaned: true, ambiguous: false });
  });

  it("orphans on an empty document and on empty blocks", () => {
    expect(resolveAnchor({ anchor }, []).kind).toBe("orphaned");
    expect(resolveAnchor({ anchor }, [b("p1", ""), b("p2", "")]).kind).toBe("orphaned");
  });

  it("re-anchors when the words come back — derived, not sticky", () => {
    const orphaned = apply({ anchor }, resolveAnchor({ anchor }, [b("p1", "gone")]).writes);
    expect(orphaned.orphanedAt).toBe(1_000);
    const back = resolveAnchor(orphaned, [p]);
    expect(back).toMatchObject({ kind: "anchored", stage: 1, writes: { orphaned: false } });
    expect(apply(orphaned, back.writes).orphanedAt).toBeUndefined();
  });

  it("re-anchors after an undo restores a deleted block", () => {
    const deleted = resolveAnchor({ anchor }, [b("p0", "Other text.")]);
    const state = apply({ anchor }, deleted.writes);
    expect(resolveAnchor(state, [b("p0", "Other text."), p])).toMatchObject({ stage: 1, blockId: "p1" });
  });

  it("reads a malformed stored anchor as matching nowhere rather than everywhere", () => {
    for (const exact of ["", "   ", undefined as unknown as string]) {
      expect(resolveAnchor({ anchor: { ...anchor, exact } }, [p]).kind).toBe("orphaned");
    }
    const odd = { ...anchor, offsetHint: Number.NaN };
    expect(resolveAnchor({ anchor: odd }, [p])).toMatchObject({ kind: "anchored", from: anchor.offsetHint });
  });
});

describe("unicode", () => {
  it("resolves emoji, CJK and combining marks by code unit", () => {
    const blocks = [
      b("e", "Party 🎉🎉 tonight 👨‍👩‍👧 with the family"),
      b("c", "我们周五发布这个版本，如果测试通过的话。周五见！"),
      b("m", "Visit the café́ near the café corner"),
    ];
    for (const [id, quote, nth] of [
      ["e", "🎉 tonight 👨‍👩‍👧", 0],
      ["c", "周五", 1],
      ["m", "café", 0],
    ] as const) {
      const block = blocks.find((candidate) => candidate.blockId === id)!;
      const anchor = anchorOf(block, quote, nth);
      const r = settles({ anchor }, blocks);
      expect(quoted(blocks, r)).toBe(quote);
      expect(r.kind === "anchored" && r.from).toBe(anchor.offsetHint);
    }
  });

  it("fuzzy-matches CJK edits by character", () => {
    const block = b("c", "我们周五发布这个新版本，如果测试通过的话。");
    const anchor = anchorOf(block, "周五发布这个新版本");
    const r = settles({ anchor }, [b("c", "我们周六发布这个新版本，如果测试通过的话。")]);
    expect(r).toMatchObject({ stage: 2 });
    expect(r.writes.anchor!.exact).toBe("周六发布这个新版本");
  });

  it("counts an emoji as one edit, not two", () => {
    const block = b("e", "abcdef ghi 😀");
    // "abc😀ef" is one substitution from "abcdef" — within a third of six.
    const anchor: CommentAnchor = { blockId: "e", exact: "abcdef", prefix: "", suffix: "", offsetHint: 0 };
    const r = resolveAnchor({ anchor }, [b("e", "abc😀ef ghi 😀")]);
    expect(r).toMatchObject({ stage: 2, from: 0, to: 7 });
    void block;
  });
});

// A few milliseconds locally; the bound is loose because CI runners are shared,
// and what it guards against is a hang, not a regression of a millisecond.
const SLOW_MS = 250;

describe("long blocks", () => {
  function words(count: number, seed: number): string {
    const rand = prng(seed);
    const vocab = ["alpha", "beta", "gamma", "delta", "north", "south", "river", "stone", "light", "ember"];
    return Array.from({ length: count }, () => vocab[Math.floor(rand() * vocab.length)]).join(" ");
  }

  it("resolves exact and fuzzy quotes in a 50k-character block quickly", () => {
    const text = words(9_000, 1).slice(0, 50_000);
    const at = 31_000;
    const block = b("big", `${text.slice(0, at)} the committee approved the budget ${text.slice(at)}`);
    const anchor = anchorOf(block, "the committee approved the budget");

    let started = performance.now();
    expect(resolveAnchor({ anchor }, [block])).toMatchObject({ stage: 1 });
    expect(performance.now() - started).toBeLessThan(SLOW_MS);

    const edited = b("big", block.text.replace("committee approved", "committee has approved"));
    started = performance.now();
    const r = resolveAnchor({ anchor }, [edited]);
    const elapsed = performance.now() - started;
    expect(r).toMatchObject({ stage: 2 });
    expect(quoted([edited], r)).toBe("the committee has approved the budget");
    expect(elapsed).toBeLessThan(SLOW_MS);
  });

  it("scans only near the hint when the whole block would cost too much", () => {
    const quote = words(40, 2); // ~220 chars: 220 × 50k cells is past the limit
    const text = words(9_000, 3).slice(0, 50_000);
    const at = 20_000;
    const block = b("big", `${text.slice(0, at)} ${quote} ${text.slice(at)}`);
    const anchor = anchorOf(block, quote);
    expect(quote.length * block.text.length).toBeGreaterThan(FUZZY_CELL_LIMIT);
    const edited = b("big", block.text.replace(quote, `${quote.slice(0, 50)}XYZ${quote.slice(53)}`));
    const started = performance.now();
    const r = settles({ anchor }, [edited]);
    expect(performance.now() - started).toBeLessThan(SLOW_MS);
    expect(r).toMatchObject({ stage: 2 });
  });

  it("degrades to a miss, not a hang, for a quote too long to fuzzy-match", () => {
    const quote = words(2_000, 4); // ~11k chars
    const block = b("big", quote);
    const anchor = anchorOf(block, quote);
    const edited = b("big", `${quote.slice(0, 5_000)}!${quote.slice(5_001)}`);
    const started = performance.now();
    expect(resolveAnchor({ anchor }, [edited]).kind).toBe("orphaned");
    expect(performance.now() - started).toBeLessThan(SLOW_MS);
  });
});

describe("validateAnchor and anchorForQuote", () => {
  const blocks = [b("p1", "We should ship it by Friday if the tests pass."), b("p2", "Friday is a holiday.")];

  it("accepts a freshly minted anchor onto exactly its range", () => {
    const anchor = anchorOf(blocks[0], "by Friday");
    expect(validateAnchor(anchor, blocks)).toEqual({ ok: true, from: anchor.offsetHint, to: anchor.offsetHint + 9, ambiguous: false });
  });

  it("refuses a quote that is not verbatim in the block it names — no fuzzy, no elsewhere", () => {
    const base = anchorOf(blocks[0], "by Friday");
    expect(validateAnchor({ ...base, exact: "by friday" }, blocks)).toEqual({ ok: false, reason: "quote_not_in_block" });
    expect(validateAnchor({ ...base, exact: "is a holiday" }, blocks)).toEqual({ ok: false, reason: "quote_not_in_block" });
    expect(validateAnchor({ ...base, blockId: "p9" }, blocks)).toEqual({ ok: false, reason: "no_such_block" });
    expect(validateAnchor({ ...base, exact: " " }, blocks)).toEqual({ ok: false, reason: "empty_quote" });
  });

  it("mints a stored-ready anchor from a bare quotation", () => {
    const r = anchorForQuote({ blockId: "p1", exact: " by Friday " }, blocks);
    expect(r).toEqual({ ok: true, ambiguous: false, guessed: false, anchor: anchorOf(blocks[0], "by Friday") });
    const loose = { blockId: "p1", exact: "by Friday", prefix: undefined, suffix: undefined, offsetHint: undefined };
    expect(anchorForQuote(loose, blocks)).toEqual(r);
    if (r.ok) expect(validateAnchor(r.anchor, blocks)).toMatchObject({ ok: true, from: r.anchor.offsetHint });
  });

  it("uses the context it is given and reports a quote it could not single out", () => {
    const text = [b("p1", "one fish two fish red fish")];
    // Picked by the total order, but the stored anchor's own context is unique.
    expect(anchorForQuote({ blockId: "p1", exact: "fish" }, text)).toMatchObject({
      ok: true,
      guessed: true,
      ambiguous: false,
      anchor: { offsetHint: 4 },
    });
    expect(anchorForQuote({ blockId: "p1", exact: "fish", prefix: "red " }, text)).toMatchObject({
      ok: true,
      guessed: false,
      ambiguous: false,
      anchor: { offsetHint: 22 },
    });
    const same = [b("p1", "ha ha")];
    expect(anchorForQuote({ blockId: "p1", exact: "ha", offsetHint: 3 }, same)).toMatchObject({
      guessed: true,
      ambiguous: false,
      anchor: { offsetHint: 3, prefix: "ha " },
    });
    expect(anchorForQuote({ blockId: "p1", exact: "cat" }, text)).toEqual({ ok: false, reason: "quote_not_in_block" });
  });
});

// ---------------------------------------------------------------------------
// Properties, over a seeded generator so a failure reproduces.

function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A small alphabet on purpose: repeats, identical contexts and near misses are
// the interesting cases, and they need a cramped vocabulary to happen often.
const ALPHABET = ["a", "b", "ab", " ", " ", "ba", "😀", "周", "é", "\n", "☐", "x"];

function randomText(rand: () => number, max: number): string {
  const length = Math.floor(rand() * max);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return out;
}

function randomBlocks(rand: () => number): BlockText[] {
  const count = 1 + Math.floor(rand() * 4);
  return Array.from({ length: count }, (_, i) => b(`b${i}`, randomText(rand, 40)));
}

function randomEdit(rand: () => number, blocks: BlockText[]): BlockText[] {
  const next = blocks.map((block) => ({ ...block }));
  if (!next.length) return next;
  const kind = Math.floor(rand() * 5);
  const target = next[Math.floor(rand() * next.length)];
  const at = Math.floor(rand() * (target.text.length + 1));
  if (kind === 0) target.text = target.text.slice(0, at) + randomText(rand, 4) + target.text.slice(at);
  if (kind === 1) target.text = target.text.slice(0, at) + target.text.slice(at + 1 + Math.floor(rand() * 3));
  if (kind === 2) next.splice(next.indexOf(target), 1);
  if (kind === 3) next.push({ blockId: `moved-${target.blockId}`, text: next.splice(next.indexOf(target), 1)[0].text });
  if (kind === 4) next.reverse();
  return next;
}

describe("properties", () => {
  it("a freshly minted anchor always resolves to exactly its range, at stage 1", () => {
    const rand = prng(0xc0ffee);
    let minted = 0;
    for (let run = 0; run < 3_000; run++) {
      const blocks = randomBlocks(rand);
      const block = blocks[Math.floor(rand() * blocks.length)];
      const from = Math.floor(rand() * (block.text.length + 1));
      const to = Math.floor(rand() * (block.text.length + 1));
      const anchor = mintAnchor(block, from, to);
      if (!anchor) continue;
      minted++;
      const r = resolveAnchor({ anchor }, blocks);
      expect(r).toMatchObject({
        kind: "anchored",
        stage: 1,
        blockId: block.blockId,
        from: anchor.offsetHint,
        to: anchor.offsetHint + anchor.exact.length,
      });
      expect(r.writes.anchor).toBeUndefined();
      expect(r.writes.orphaned).toBeUndefined();
      expect(validateAnchor(anchor, blocks)).toMatchObject({ ok: true, from: anchor.offsetHint });
      settles({ anchor }, blocks);
    }
    expect(minted).toBeGreaterThan(2_000);
  });

  it("resolution is deterministic and settles after one round of writes, whatever the edit", () => {
    const rand = prng(42);
    const stages = new Map<string, number>();
    for (let run = 0; run < 3_000; run++) {
      const blocks = randomBlocks(rand);
      const block = blocks[Math.floor(rand() * blocks.length)];
      const anchor = mintAnchor(block, Math.floor(rand() * block.text.length), Math.floor(rand() * (block.text.length + 1)));
      if (!anchor) continue;
      let edited = blocks;
      for (let edits = 1 + Math.floor(rand() * 3); edits > 0; edits--) edited = randomEdit(rand, edited);

      const one = resolveAnchor({ anchor }, edited);
      const two = resolveAnchor(structuredClone({ anchor }), structuredClone(edited));
      expect(two).toEqual(one);
      const r = settles({ anchor }, edited);
      const path = r.kind === "anchored" ? `stage${r.stage}` : "orphaned";
      stages.set(path, (stages.get(path) ?? 0) + 1);
      if (r.kind === "anchored") {
        const text = edited.find((candidate) => candidate.blockId === r.blockId)!.text;
        const exact = r.writes.anchor?.exact ?? anchor.exact;
        expect(text.slice(r.from, r.to)).toBe(exact);
        expect(hasWrites(r.writes)).toBe(Object.keys(r.writes).length > 0);
      }
    }
    // Every path is exercised, or the property says little.
    for (const key of ["stage1", "stage2", "stage3", "orphaned"]) expect(stages.get(key) ?? 0).toBeGreaterThan(100);
  });
});
