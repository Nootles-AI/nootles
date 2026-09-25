import { describe, expect, test } from "vitest";
import { dividersNotHeadings, isPlainPasteKey, plainLines } from "./paste";

const chord = (over: Partial<Parameters<typeof isPlainPasteKey>[0]>) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: true,
  code: "KeyV",
  ...over,
});

describe("isPlainPasteKey", () => {
  test("⌘⇧V and ⌥⇧⌘V on a Mac", () => {
    expect(isPlainPasteKey(chord({ metaKey: true }), true)).toBe(true);
    expect(isPlainPasteKey(chord({ metaKey: true, altKey: true }), true)).toBe(true);
    expect(isPlainPasteKey(chord({ ctrlKey: true }), true)).toBe(false);
  });

  test("Ctrl+Shift+V elsewhere", () => {
    expect(isPlainPasteKey(chord({ ctrlKey: true }), false)).toBe(true);
    expect(isPlainPasteKey(chord({ ctrlKey: true, altKey: true }), false)).toBe(false);
    expect(isPlainPasteKey(chord({ metaKey: true }), false)).toBe(false);
  });

  test("not plain ⌘V, nor another key", () => {
    expect(isPlainPasteKey(chord({ metaKey: true, shiftKey: false }), true)).toBe(false);
    expect(isPlainPasteKey(chord({ metaKey: true, code: "KeyC" }), true)).toBe(false);
  });
});

describe("dividersNotHeadings", () => {
  test("a rule straight under a line becomes a divider", () => {
    expect(dividersNotHeadings("Intro\n---\nBody")).toBe("Intro\n\n---\nBody");
    expect(dividersNotHeadings("a\n- - -")).toBe("a\n\n- - -");
  });

  test("a rule that already stands apart is left alone", () => {
    const md = "---\nIntro\n\n---\n\nBody";
    expect(dividersNotHeadings(md)).toBe(md);
  });

  test("code fences are left exactly as they are", () => {
    const md = "```yaml\nkey: 1\n---\n```\nafter\n---";
    expect(dividersNotHeadings(md)).toBe("```yaml\nkey: 1\n---\n```\nafter\n\n---");
    const tilde = "~~~~\na\n---\n~~~\nb\n---\n~~~~";
    expect(dividersNotHeadings(tilde)).toBe(tilde);
  });

  test("table rules, setext `===` and short dashes are not dividers", () => {
    for (const md of ["a | b\n--- | ---\n1 | 2", "Title\n===", "a\n--"]) {
      expect(dividersNotHeadings(md)).toBe(md);
    }
  });
});

describe("plainLines", () => {
  test("a line apiece, blank lines kept, any line ending", () => {
    expect(plainLines("a\n\nb")).toEqual(["a", "", "b"]);
    expect(plainLines("a\r\nb\rc")).toEqual(["a", "b", "c"]);
    expect(plainLines("one")).toEqual(["one"]);
  });
});
