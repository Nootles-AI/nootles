import { describe, expect, test } from "vitest";
import { inlineShortcut, LEAF } from "./inlineShortcuts";

describe("typography", () => {
  test.each([
    ["a -", ">", "→", 2],
    ["a <", "-", "←", 2],
    ["a -", "-", "—", 2],
    ["a =", ">", "⇒", 2],
    ["wait..", ".", "…", 3],
    ["x <", "=", "≤", 2],
    ["x >", "=", "≥", 2],
    ["x !", "=", "≠", 2],
  ])("%j + %j → %s", (before, typed, text, length) => {
    expect(inlineShortcut(before, typed)).toEqual({ kind: "text", length, text });
  });

  test("dashes alone at the start of a line are left for the divider", () => {
    expect(inlineShortcut("-", "-")).toBeNull();
    expect(inlineShortcut("--", "-")).toBeNull();
    expect(inlineShortcut("a-", "-")).toEqual({ kind: "text", length: 2, text: "—" });
  });

  test("anything else is left alone", () => {
    expect(inlineShortcut("a", ">")).toBeNull();
    expect(inlineShortcut("a.", ".")).toBeNull();
    expect(inlineShortcut("a -", ">>")).toBeNull();
  });
});

describe("~strike~", () => {
  test("a single pair strikes what it wraps", () => {
    expect(inlineShortcut("so ~gone", "~")).toEqual({ kind: "strike", length: 6 });
    expect(inlineShortcut("~two words", "~")).toEqual({ kind: "strike", length: 11 });
  });

  test("never on the way to ~~double~~", () => {
    expect(inlineShortcut("~~gone", "~")).toBeNull();
    expect(inlineShortcut("~~gone~", "~")).toBeNull();
  });

  test("not mid-word, not around space, not across a chip", () => {
    expect(inlineShortcut("a~b", "~")).toBeNull();
    expect(inlineShortcut("~ b", "~")).toBeNull();
    expect(inlineShortcut("~b ", "~")).toBeNull();
    expect(inlineShortcut(`~a${LEAF}b`, "~")).toBeNull();
  });
});

describe("$$equation$$", () => {
  test("becomes an inline equation", () => {
    expect(inlineShortcut("area $$x^2$", "$")).toEqual({ kind: "math", length: 7, latex: "x^2" });
    expect(inlineShortcut("$$ a + b $", "$")).toEqual({ kind: "math", length: 11, latex: "a + b" });
  });

  test("an empty or escaped one stays text", () => {
    expect(inlineShortcut("$$ $", "$")).toBeNull();
    expect(inlineShortcut("\\$$x$", "$")).toBeNull();
    expect(inlineShortcut("$x", "$")).toBeNull();
  });
});
