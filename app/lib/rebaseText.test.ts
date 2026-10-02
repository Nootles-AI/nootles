import { describe, expect, test } from "vitest";
import { mapOffset, rebaseText, spliceOf } from "./rebaseText";

describe("rebaseText", () => {
  test("a word added to a title renamed elsewhere lands on the new title (NT-138)", () => {
    expect(rebaseText("pDraft", "pDraft v2", "Launch plan")).toBe("Launch plan v2");
  });

  test("one side unchanged takes the other", () => {
    expect(rebaseText("a", "a", "b")).toBe("b");
    expect(rebaseText("a", "b", "a")).toBe("b");
    expect(rebaseText("a", "b", "b")).toBe("b");
  });

  test("changes in different places both apply, in either order", () => {
    expect(rebaseText("Plan for May", "The Plan for May", "Plan for June")).toBe("The Plan for June");
    expect(rebaseText("Plan for May", "Plan for June", "The Plan for May")).toBe("The Plan for June");
  });

  test("both appending at the end keeps theirs first, then what was typed here", () => {
    expect(rebaseText("Plan", "Plan v2", "Plan (draft)")).toBe("Plan (draft) v2");
  });

  test("an overlap keeps this side's text across it", () => {
    expect(rebaseText("Plan", "Roadmap", "Budget")).toBe("Roadmap");
  });

  test("never cuts a surrogate pair", () => {
    // 😀 and 😁 share their high surrogate.
    const s = spliceOf("a😀", "a😁");
    expect(s).toEqual({ from: 1, to: 3, text: "😁" });
    expect(rebaseText("😀 x", "😁 x", "😀 y")).toBe("😁 y");
  });
});

describe("mapOffset", () => {
  test("a caret before, inside and after the change", () => {
    expect(mapOffset("pDraft v2", "Launch plan v2", 9)).toBe(14);
    expect(mapOffset("ab cd", "ab XYZ cd", 1)).toBe(1);
    expect(mapOffset("abcd", "aXd", 2)).toBe(2);
  });
});
