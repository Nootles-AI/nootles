import { describe, expect, test } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { sameShown, type Shown } from "./sidebarDrag";

/**
 * A drag renders the sidebar only when the list would draw something else —
 * the pointer moving within one gap is not that.
 */

const ids: ReadonlySet<string> = new Set(["p1"]);
const shown = (over: Partial<Shown> = {}): Shown => ({
  ids,
  line: { top: 28, depth: 0 },
  intoId: null,
  toRoot: false,
  ...over,
});

describe("sameShown", () => {
  test("the first move of a drag always renders", () => {
    expect(sameShown(null, shown())).toBe(false);
  });

  test("a fresh line at the same place is the same drawing", () => {
    expect(sameShown(shown(), shown({ line: { top: 28, depth: 0 } }))).toBe(true);
    expect(sameShown(shown({ line: null }), shown({ line: null }))).toBe(true);
  });

  test("the line moving, indenting, appearing or going renders", () => {
    expect(sameShown(shown(), shown({ line: { top: 56, depth: 0 } }))).toBe(false);
    expect(sameShown(shown(), shown({ line: { top: 28, depth: 1 } }))).toBe(false);
    expect(sameShown(shown(), shown({ line: null }))).toBe(false);
    expect(sameShown(shown({ line: null }), shown())).toBe(false);
  });

  test("a new folder target or level change renders", () => {
    const f = "f1" as Id<"folders">;
    expect(sameShown(shown(), shown({ line: null, intoId: f }))).toBe(false);
    expect(sameShown(shown({ intoId: f }), shown({ intoId: "f2" as Id<"folders"> }))).toBe(false);
    expect(sameShown(shown(), shown({ toRoot: true }))).toBe(false);
  });
});
