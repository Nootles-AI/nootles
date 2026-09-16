import { describe, expect, it } from "vitest";
import { findColorTokens, replaceColorTokens } from "./colorTokens";

describe("findColorTokens", () => {
  it("finds hex, rgb, oklch and var tokens with correct spans", () => {
    const css = "linear-gradient(90deg, #fff 0%, rgb(0, 0, 0) 50%, var(--brand) 100%)";
    const tokens = findColorTokens(css);
    expect(tokens.map((t) => t.text)).toEqual(["#fff", "rgb(0, 0, 0)", "var(--brand)"]);
    for (const t of tokens) expect(css.slice(t.start, t.end)).toBe(t.text);
  });

  it("ignores named colours and bare keywords", () => {
    expect(findColorTokens("background: left center red")).toEqual([]);
  });

  it("still finds transparent and currentcolor as tokens", () => {
    const tokens = findColorTokens("linear-gradient(transparent, currentcolor)");
    expect(tokens.map((t) => t.text)).toEqual(["transparent", "currentcolor"]);
  });

  it("ignores a hex-looking string inside url()", () => {
    expect(findColorTokens('background: url("#fff-icon.png") #f00')).toEqual([
      { start: 33, end: 37, text: "#f00" },
    ]);
  });

  it("a var() with a fallback is one whole token, nested parens included", () => {
    const css = "color: var(--x, rgb(1, 2, 3))";
    const tokens = findColorTokens(css);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].text).toBe("var(--x, rgb(1, 2, 3))");
  });

  it("finds a colour nested inside a gradient function", () => {
    const tokens = findColorTokens("linear-gradient(oklch(0.7 0.1 250), #fff)");
    expect(tokens.map((t) => t.text)).toEqual(["oklch(0.7 0.1 250)", "#fff"]);
  });
});

describe("replaceColorTokens", () => {
  it("replaces the tokens at spans and preserves every other byte", () => {
    const css = "linear-gradient(90deg, #000 0%, #fff 100%)";
    const spans = findColorTokens(css);
    const out = replaceColorTokens(css, spans, (t) => (t.text === "#000" ? "#111" : t.text));
    expect(out).toBe("linear-gradient(90deg, #111 0%, #fff 100%)");
  });

  it("returns the string unchanged when there is nothing to replace", () => {
    const css = "background: left center";
    expect(replaceColorTokens(css, findColorTokens(css), () => "x")).toBe(css);
  });
});
