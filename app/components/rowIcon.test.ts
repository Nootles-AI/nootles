import { describe, expect, test } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { drawsItself, iconKey } from "./rowIcon";

const picture = { kind: "image" as const, storageId: "kg2abc" as Id<"_storage">, url: "https://x/y.png" };

describe("an icon that draws as itself", () => {
  test("an emoji with a character, a picture with its address, a glyph that can be drawn", () => {
    expect(drawsItself({ kind: "emoji", value: "🌲" })).toBe(true);
    expect(drawsItself(picture)).toBe(true);
    expect(drawsItself({ kind: "icon", name: "anything", d: "M0 0h1v1z" })).toBe(true);
    expect(drawsItself({ kind: "icon", name: "rocket" })).toBe(true);
  });

  test("nothing, an empty emoji, a picture without its address or a glyph this build lost do not", () => {
    expect(drawsItself(null)).toBe(false);
    expect(drawsItself(undefined)).toBe(false);
    expect(drawsItself({ kind: "emoji", value: "" })).toBe(false);
    expect(drawsItself({ ...picture, url: "" })).toBe(false);
    expect(drawsItself({ kind: "icon", name: "gone-glyph" })).toBe(false);
  });
});

describe("telling one icon from another", () => {
  test("each choice has its own key, and none has the empty one", () => {
    const keys = [
      iconKey({ kind: "emoji", value: "🌲" }),
      iconKey({ kind: "emoji", value: "🚀" }),
      iconKey({ kind: "icon", name: "tree", d: "M0" }),
      iconKey(picture),
    ];
    expect(new Set(keys).size).toBe(4);
    expect(keys).not.toContain("");
    expect(iconKey(null)).toBe("");
  });

  test("a glyph is itself by its name, whatever path it carries", () => {
    expect(iconKey({ kind: "icon", name: "tree", d: "M0" })).toBe(
      iconKey({ kind: "icon", name: "tree", d: "M1", box: 24 }),
    );
  });
});
