import { describe, expect, it } from "vitest";
import { anchorAt, mintAnchor, mintAnchorFromSpans, splitsPair, type BlockText } from "./anchor";
import { CONTEXT_CHARS } from "./types";

const block = (text: string, blockId = "b1"): BlockText => ({ blockId, text });

/** Every string an anchor carries must survive UTF-8 — no lone surrogates. */
function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

describe("mintAnchor", () => {
  const text = "We should ship it by Friday if the tests pass.";

  it("quotes the selection with its surrounding context", () => {
    const from = text.indexOf("by Friday");
    expect(mintAnchor(block(text), from, from + 9)).toEqual({
      blockId: "b1",
      exact: "by Friday",
      prefix: "We should ship it ",
      suffix: " if the tests pass.",
      offsetHint: from,
    });
  });

  it("keeps at most CONTEXT_CHARS either side", () => {
    const long = `${"a".repeat(100)}[quote]${"z".repeat(100)}`;
    const from = long.indexOf("[");
    const anchor = mintAnchor(block(long), from, from + 7)!;
    expect(anchor.exact).toBe("[quote]");
    expect(anchor.prefix).toBe("a".repeat(CONTEXT_CHARS));
    expect(anchor.suffix).toBe("z".repeat(CONTEXT_CHARS));
  });

  it("cuts context at the block's edges", () => {
    expect(mintAnchor(block("Friday"), 0, 6)).toMatchObject({ exact: "Friday", prefix: "", suffix: "" });
  });

  it("accepts the offsets in either order and clamps them to the block", () => {
    const forwards = mintAnchor(block(text), 0, 9);
    expect(mintAnchor(block(text), 9, 0)).toEqual(forwards);
    expect(mintAnchor(block(text), -5, 9)).toEqual(forwards);
    expect(mintAnchor(block(text), 41, 10_000)!.exact).toBe("pass.");
    expect(mintAnchor(block(text), Number.NaN, 2)!.exact).toBe("We");
  });

  it("sheds whitespace at either end", () => {
    const from = text.indexOf(" by Friday ");
    const anchor = mintAnchor(block(text), from, from + 11)!;
    expect(anchor.exact).toBe("by Friday");
    expect(anchor.offsetHint).toBe(from + 1);
    expect(anchor.prefix.endsWith("it ")).toBe(true);
    expect(mintAnchor(block("a\n\tb "), 0, 5)!.exact).toBe("a\n\tb");
  });

  it("refuses empty and whitespace-only selections", () => {
    expect(mintAnchor(block(text), 5, 5)).toBeNull();
    expect(mintAnchor(block("a    b"), 1, 5)).toBeNull();
    expect(mintAnchor(block(" \n \t"), 0, 4)).toBeNull();
    expect(mintAnchor(block(""), 0, 0)).toBeNull();
    expect(mintAnchor(block(""), 0, 10)).toBeNull();
  });

  it("never splits a surrogate pair in the quote or its context", () => {
    const emoji = "😀";
    const t = `ab${emoji}cd`;
    // A selection ending between the halves takes the whole emoji; one
    // starting between them does too.
    expect(mintAnchor(block(t), 0, 3)!.exact).toBe(`ab${emoji}`);
    expect(mintAnchor(block(t), 3, 6)!.exact).toBe(`${emoji}cd`);
    expect(mintAnchor(block(t), 3, 3)).toBeNull();

    // Context whose 32-unit cut lands inside a pair gives up that character.
    const before = `${emoji}${"x".repeat(CONTEXT_CHARS - 1)}`; // 33 units
    const after = `${"y".repeat(CONTEXT_CHARS - 1)}${emoji}`;
    const around = `${before}Q${after}`;
    const at = around.indexOf("Q");
    const anchor = mintAnchor(block(around), at, at + 1)!;
    expect(anchor.prefix).toBe("x".repeat(CONTEXT_CHARS - 1));
    expect(anchor.suffix).toBe("y".repeat(CONTEXT_CHARS - 1));
    for (const value of [anchor.exact, anchor.prefix, anchor.suffix]) expect(wellFormed(value)).toBe(true);
  });

  it("widens to whole graphemes: accents, ZWJ sequences, flags, skin tones", () => {
    const accent = "café au lait"; // e + combining acute
    expect(mintAnchor(block(accent), 0, 4)!.exact).toBe("café");
    const family = "👨‍👩‍👧‍👦";
    const withFamily = `hi ${family} there`;
    expect(mintAnchor(block(withFamily), 3, 5)!.exact).toBe(family);
    const flag = "🇯🇵";
    expect(mintAnchor(block(`go ${flag}!`), 3, 5)!.exact).toBe(flag);
    const wave = "👋🏽";
    expect(mintAnchor(block(`${wave} hey`), 0, 2)!.exact).toBe(wave);
  });

  it("quotes CJK text by code unit, like any other", () => {
    const cjk = "我们周五发布这个版本，如果测试通过的话。";
    const from = cjk.indexOf("周五");
    expect(mintAnchor(block(cjk), from, from + 2)).toMatchObject({
      exact: "周五",
      prefix: "我们",
      offsetHint: 2,
    });
  });
});

describe("anchorAt", () => {
  it("is the exact range with context, untrimmed", () => {
    expect(anchorAt(block(" a b "), 0, 5)).toEqual({
      blockId: "b1",
      exact: " a b ",
      prefix: "",
      suffix: "",
      offsetHint: 0,
    });
  });
});

describe("splitsPair", () => {
  it("is true only between the halves of a pair", () => {
    const t = "a😀b";
    expect([0, 1, 2, 3, 4].map((offset) => splitsPair(t, offset))).toEqual([false, false, true, false, false]);
  });
});

describe("mintAnchorFromSpans", () => {
  const blocks = [block("First paragraph.", "p1"), block("   ", "blank"), block("Second one here.", "p2")];

  it("anchors to the block the selection starts in, clamped to it", () => {
    const anchor = mintAnchorFromSpans(blocks, [
      { blockId: "p1", from: 6, to: 16 },
      { blockId: "blank", from: 0, to: 3 },
      { blockId: "p2", from: 0, to: 6 },
    ]);
    expect(anchor).toMatchObject({ blockId: "p1", exact: "paragraph.", offsetHint: 6 });
  });

  it("skips spans that quote nothing — a selection starting at a block's end or on a blank line", () => {
    const anchor = mintAnchorFromSpans(blocks, [
      { blockId: "p1", from: 16, to: 16 },
      { blockId: "blank", from: 0, to: 3 },
      { blockId: "p2", from: 0, to: 6 },
    ]);
    expect(anchor).toMatchObject({ blockId: "p2", exact: "Second" });
  });

  it("is null when nothing quotable is selected or the block is unknown", () => {
    expect(mintAnchorFromSpans(blocks, [])).toBeNull();
    expect(mintAnchorFromSpans(blocks, [{ blockId: "blank", from: 0, to: 3 }])).toBeNull();
    expect(mintAnchorFromSpans(blocks, [{ blockId: "gone", from: 0, to: 3 }])).toBeNull();
  });
});
