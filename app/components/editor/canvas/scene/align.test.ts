import { describe, expect, test } from "vitest";
import { BAND, bandFloor, bandHeight } from "./band";
import { applyOps } from "./ops";
import type { Alignment, Scene, SceneNode } from "./types";

const rect = (id: string, x: number, y: number, w = 100, h = 60): SceneNode =>
  ({
    id,
    kind: "rect",
    x,
    y,
    w,
    h,
    rot: 0,
    style: {},
    label: "",
    locked: false,
    hidden: false,
    attrs: {},
  }) as SceneNode;

const scene = (nodes: SceneNode[], over: Partial<Scene> = {}): Scene => ({
  w: 0,
  h: 0,
  style: {},
  nodes,
  edges: [],
  attrs: {},
  ...over,
});

const align = (s: Scene, to: Alignment, ids = ["a"]) => applyOps(s, [{ type: "align", ids, to }]);
const at = (s: Scene, id = "a") => s.nodes.find((node) => node.id === id)!;

describe("aligning one shape to its diagram", () => {
  test("a band's is the column", () => {
    const s = scene([rect("a", 0, 24, 120)], { h: 200 });
    expect(at(align(s, "hcenter")).x).toBe((720 - 120) / 2);
    expect(at(align(s, "right")).x).toBe(600);
  });

  test("a wide band's reaches the margin either side", () => {
    const s = scene([rect("a", 0, 24, 120)], { h: 200, wide: true });
    expect(at(align(s, "hcenter")).x).toBe(-240 + (1200 - 120) / 2);
    expect(at(align(s, "left")).x).toBe(-240);
  });

  test("a frame's is its own box", () => {
    const s = scene([rect("a", 0, 0, 120)], { w: 320, h: 180 });
    expect(at(align(s, "hcenter")).x).toBe(100);
    expect(at(align(s, "bottom")).y).toBe(120);
  });

  test("down, a band's stops at its margins", () => {
    const s = scene([rect("a", 0, 100), rect("b", 200, 300)], { h: 500 });
    expect(at(align(s, "top")).y).toBe(BAND);
    expect(at(align(s, "bottom")).y).toBe(500 - BAND - 60);
  });

  test("to the bottom twice is to the bottom once, and the band does not grow", () => {
    const cases: [Scene, string][] = [
      // A slash-menu diagram's first shape: the stored height is below what it holds.
      [scene([rect("a", 40, 24, 160, 72)], { h: 74 }), "a"],
      // The lowest of two, in a band taller than both.
      [scene([rect("a", 0, 24), rect("b", 0, 140)], { h: 300 }), "b"],
    ];
    for (const [start, id] of cases) {
      const once = align(start, "bottom", [id]);
      expect(align(once, "bottom", [id])).toEqual(once);
      expect(bandHeight(once)).toBe(bandHeight(start));
    }
  });

  test("still a fixed point once a band's height follows its content", () => {
    // What the band store will do after every local edit: raise h to the floor.
    const grow = (s: Scene) => ({ ...s, h: Math.max(s.h, bandFloor(s)) });
    const once = grow(align(grow(scene([rect("a", 40, 24, 160, 72)], { h: 74 })), "bottom"));
    const twice = grow(align(once, "bottom"));
    expect(at(twice).y).toBe(at(once).y);
    expect(twice.h).toBe(once.h);
  });
});
