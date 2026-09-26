import { DOMParser } from "linkedom";
import { describe, expect, test } from "vitest";
import {
  BAND,
  bandFloor,
  bandHeight,
  bandLeft,
  bandWidth,
  EMPTY_BAND_H,
  fitOps,
  fitToBand,
  isLegacyRoot,
  normalizeDiagram,
  WIDE_MARGIN,
  WIDE_W,
} from "./band";
import { emptyScene, migrateLegacyCanvas } from "./migrate";
import { reflowHugs } from "./ops";
import type { Scene, SceneNode } from "./types";

// `migrateLegacyCanvas` parses with the global DOMParser.
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const rect = (id: string, x: number, y: number, over: Partial<SceneNode> = {}): SceneNode =>
  ({
    id,
    kind: "rect",
    x,
    y,
    w: 100,
    h: 60,
    rot: 0,
    style: {},
    label: "",
    locked: false,
    hidden: false,
    attrs: {},
    ...over,
  }) as SceneNode;

/** A band root: no width stated. */
const band = (nodes: SceneNode[], over: Partial<Scene> = {}): Scene => ({
  w: 0,
  h: 0,
  style: {},
  nodes,
  edges: [],
  attrs: {},
  ...over,
});

/** A root from before bands: it always stated a width. */
const old = (nodes: SceneNode[], over: Partial<Scene> = {}): Scene => band(nodes, { w: 960, h: 540, ...over });

const at = (scene: Scene) => scene.nodes.map((node) => [node.id, node.x, node.y, node.w, node.h]);

describe("the band's geometry", () => {
  test("a band is the column, a wide one reaches the margin either side", () => {
    expect([bandLeft({}), bandWidth({})]).toEqual([0, 720]);
    expect([bandLeft({ wide: true }), bandWidth({ wide: true })]).toEqual([-240, 1200]);
    expect([WIDE_W, WIDE_MARGIN]).toEqual([1200, 240]);
  });

  test("an empty band is one line of text and a band either side", () => {
    expect(EMPTY_BAND_H).toBe(74);
    expect(bandFloor(band([]))).toBe(74);
    expect(bandFloor(band([rect("a", 0, 500, { hidden: true })]))).toBe(74);
  });

  test("the floor is the lowest visible box plus a band", () => {
    expect(bandFloor(band([rect("a", 0, 24), rect("b", 200, 100)]))).toBe(100 + 60 + BAND);
    expect(bandFloor(band([rect("a", 0, 24), rect("b", 0, 400, { hidden: true })]))).toBe(108);
  });

  test("it reads the box a rotated shape draws, not the one it stores", () => {
    // 100×20 turned a quarter: 100 tall about the same centre, so 40 above y.
    expect(bandFloor(band([rect("a", 0, 0, { w: 100, h: 20, rot: 90 })]))).toBe(60 + BAND);
  });

  test("a connector routed under the shapes holds the band open", () => {
    // `c` stands between `a` and `b`; the connector goes round beneath it.
    const nodes = [rect("a", 0, 100), rect("c", 200, 60, { h: 140 }), rect("b", 400, 100)];
    const shapesOnly = bandFloor(band(nodes));
    const routed = bandFloor(band(nodes, { edges: [{ id: "e", from: "a", to: "b", label: "", style: {}, attrs: {} }] }));
    expect(shapesOnly).toBe(200 + BAND);
    expect(routed).toBeGreaterThan(shapesOnly);
    expect(routed).toBe(218 + BAND);
  });

  test("the height drawn is what is stored, raised to what is held", () => {
    expect(bandHeight(band([rect("a", 0, 24)], { h: 300 }))).toBe(300);
    expect(bandHeight(band([rect("a", 0, 24)], { h: 40 }))).toBe(108);
  });
});

describe("normalizeDiagram", () => {
  test("a band that holds its content comes back as the same object", () => {
    const scene = band([rect("a", 0, 24)], { h: 200 });
    expect(normalizeDiagram(scene)).toBe(scene);
  });

  test("a band shorter than its content is raised to the floor, and nothing else moves", () => {
    const scene = band([rect("a", 900, 24)], { h: 40 });
    const next = normalizeDiagram(scene);
    expect(next.h).toBe(108);
    expect(next.nodes).toBe(scene.nodes);
    expect(next.wide).toBeUndefined();
  });

  test("an empty diagram is 74 tall, not the old 260", () => {
    expect(normalizeDiagram(emptyScene()).h).toBe(74);
    const slashMenu = migrateLegacyCanvas("");
    expect([slashMenu.w, slashMenu.h, bandHeight(slashMenu)]).toEqual([0, 74, 74]);
  });

  test("only an old root is a legacy root", () => {
    expect(isLegacyRoot(band([]))).toBe(false);
    expect(isLegacyRoot(band([], { w: 320 }))).toBe(true);
    expect(isLegacyRoot(band([], { attrs: { "data-height": "fixed" } }))).toBe(true);
    expect(isLegacyRoot(band([], { attrs: { "data-width": "fixed" } }))).toBe(true);
  });

  test("an old root keeps its positions, drops its width and its pins, and keeps other attributes", () => {
    const scene = old([rect("a", 40, 200)], {
      attrs: { "data-height": "320", "data-width": "fixed", "data-legacy-edges": "[]" },
    });
    const next = normalizeDiagram(scene);
    expect(at(next)).toEqual(at(scene));
    expect(next.w).toBe(0);
    expect(next.attrs).toEqual({ "data-legacy-edges": "[]" });
  });

  test("an old diagram is never shorter than the old canvas drew it", () => {
    // The old rule: 260…560 of the content's own extent plus 24.
    expect(normalizeDiagram(old([rect("a", 0, 24)])).h).toBe(260);
    // An offset the old camera hid shows as room above now, and the band holds it.
    expect(normalizeDiagram(old([rect("a", 0, 400)])).h).toBe(484);
    // Past the old 560 cap, the content decides.
    expect(normalizeDiagram(old([rect("a", 0, 0), rect("b", 0, 900)])).h).toBe(984);
  });

  test("a hand-set old height is kept when taller than the content, and outgrown when not", () => {
    const pinned = (h: number, y: number) =>
      normalizeDiagram(old([rect("a", 0, y)], { h, attrs: { "data-height": "fixed" } })).h;
    expect(pinned(400, 24)).toBe(400);
    expect(pinned(200, 24)).toBe(260);
    expect(pinned(300, 440)).toBe(524);
  });

  test("the old empty rule is an old root's alone", () => {
    expect(normalizeDiagram(old([])).h).toBe(260);
    expect(normalizeDiagram(band([])).h).toBe(74);
  });

  test("an old root widened by hand is wide; one that only stated its width is not", () => {
    const widened = old([rect("a", 0, 24)], { w: 1000, attrs: { "data-width": "fixed" } });
    expect(normalizeDiagram(widened).wide).toBe(true);
    const narrowFixed = old([rect("a", 0, 24)], { w: 700, attrs: { "data-width": "fixed" } });
    expect(normalizeDiagram(narrowFixed).wide).toBeUndefined();
    expect(normalizeDiagram(old([rect("a", 0, 24)], { w: 1400 })).wide).toBeUndefined();
  });

  test("content outside the column turns an old root wide, where it stands", () => {
    const right = old([rect("a", 700, 24)]);
    expect([normalizeDiagram(right).wide, at(normalizeDiagram(right))]).toEqual([true, at(right)]);
    const left = old([rect("a", -100, 24)]);
    expect([normalizeDiagram(left).wide, at(normalizeDiagram(left))]).toEqual([true, at(left)]);
  });

  test("content past even the wide range, or above the top, moves in by the least amount", () => {
    const scene = old([rect("a", 900, -50), rect("b", 1000, 40)]);
    const next = normalizeDiagram(scene);
    expect(next.wide).toBe(true);
    // Right edge 1100 → 960, top −50 → 0.
    expect(at(next)).toEqual([
      ["a", 760, 0, 100, 60],
      ["b", 860, 90, 100, 60],
    ]);
  });

  test("content wider than a wide band is scaled to it about its top-left, then moved in", () => {
    const next = normalizeDiagram(old([rect("a", 0, 24), rect("b", 2300, 24)]));
    expect(next.wide).toBe(true);
    expect(at(next)).toEqual([
      ["a", -240, 24, 50, 30],
      ["b", 910, 24, 50, 30],
    ]);
  });

  test("idempotent: a normalized diagram normalizes to itself, as the same object", () => {
    const cases = [
      emptyScene(),
      old([]),
      band([rect("a", 0, 24)], { h: 10 }),
      old([rect("a", 0, 24)], { attrs: { "data-height": "fixed" }, h: 400 }),
      old([rect("a", 700, 24)]),
      old([rect("a", 900, -50), rect("b", 1000, 40)]),
      old([rect("a", 0, 24), rect("b", 2300, 24)]),
      old([rect("a", 0, 24, { rot: 30 })], { w: 1000, attrs: { "data-width": "fixed" } }),
    ];
    for (const scene of cases) {
      const once = normalizeDiagram(scene);
      expect(normalizeDiagram(once)).toBe(once);
    }
  });
});

describe("fitToBand", () => {
  test("a band that fits comes back as the same object, with no ops", () => {
    const scene = band([rect("a", 0, 24)], { h: 200 });
    expect(fitOps(scene)).toEqual([]);
    expect(fitToBand(scene)).toBe(scene);
  });

  test("an echo of the read form's width is dropped, whatever else it says", () => {
    const echo = band([rect("a", 0, 24, { h: 48 })], { w: 720, h: 96 });
    expect(fitOps(echo)).toEqual([{ type: "setDiagram", w: 0 }]);
    const fitted = fitToBand(echo);
    expect([fitted.w, fitted.h, fitted.wide]).toEqual([0, 96, undefined]);
    // The old height rule never applies here: 96 stays 96.
  });

  test("an old root's pins are stripped, and one widened by hand reads as wide", () => {
    const echo = band([rect("a", 0, 24)], { w: 1000, h: 200, attrs: { "data-width": "fixed", "data-height": "fixed" } });
    const fitted = fitToBand(echo);
    expect([fitted.w, fitted.wide, fitted.attrs]).toEqual([0, true, {}]);
  });

  test("content wider than the band is scaled about its top-left, and h with it", () => {
    const wide = band([rect("a", 0, 24), rect("b", 1340, 24)], { h: 200 });
    const fitted = fitToBand(wide);
    expect(at(fitted)).toEqual([
      ["a", 0, 24, 50, 30],
      ["b", 670, 24, 50, 30],
    ]);
    expect(fitted.h).toBe(100);
    expect(fitted.wide).toBeUndefined();
  });

  test("a wide band is fitted to its own width", () => {
    const scene = band([rect("a", -240, 24), rect("b", 1060, 24)], { h: 100, wide: true });
    const fitted = fitToBand(scene);
    const k = 1200 / 1400;
    expect(fitted.wide).toBe(true);
    expect(fitted.nodes[0].x).toBe(-240);
    expect(fitted.nodes[1].x).toBeCloseTo(-240 + 1300 * k);
    expect(fitted.nodes[1].x + fitted.nodes[1].w).toBeCloseTo(960);
  });

  test("content outside the band is moved in by the least amount", () => {
    const fitted = fitToBand(band([rect("a", -50, -30)], { h: 200 }));
    expect(at(fitted)).toEqual([["a", 0, 0, 100, 60]]);
    const right = fitToBand(band([rect("a", 700, 24)], { h: 200 }));
    expect(at(right)).toEqual([["a", 620, 24, 100, 60]]);
  });

  test("the floor wins over a scaled or stated height that would cut the drawing off", () => {
    expect(fitToBand(band([rect("a", 0, 300)], { h: 40 })).h).toBe(384);
    // Scaled by a half: round(40 · 0.5) = 20, but the drawing needs 24 + 30 + 24.
    expect(fitToBand(band([rect("a", 0, 24), rect("b", 1340, 24)], { h: 40 })).h).toBe(78);
  });

  test("a hugging group is measured at the size it hugs to, so the fit is idempotent", () => {
    const group = {
      ...rect("g", 0, 24, { w: 2000, h: 60 }),
      kind: "group",
      style: { width: "fit-content", height: "fit-content" },
      children: [rect("a", 0, 0)],
    } as SceneNode;
    const scene = band([group], { h: 200 });
    expect(fitOps(scene)).toEqual([]);
    const once = fitToBand(reflowHugs(scene));
    expect(at(once)).toEqual([["g", 0, 24, 100, 60]]);
    expect(fitToBand(once)).toBe(once);
    // Nor does an old root turn wide on a stale hug.
    expect(normalizeDiagram({ ...scene, w: 960 }).wide).toBeUndefined();
  });

  test("its ops are a scale and a move, the root last, and a second pass has none", () => {
    const cases = [
      band([rect("a", 0, 24), rect("b", 1340, 24)], { h: 200 }),
      band([rect("a", -50, -30)], { w: 720, h: 10, attrs: { "data-height": "fixed" } }),
      band([rect("a", -240, 24, { rot: 45 }), rect("b", 1060, 24)], { wide: true }),
      band([], { w: 720 }),
    ];
    for (const scene of cases) {
      const ops = fitOps(scene);
      const root = ops.findIndex((op) => op.type === "setDiagram");
      expect(ops.every((op) => ["scale", "move", "setDiagram"].includes(op.type))).toBe(true);
      expect(root === -1 || root === ops.length - 1).toBe(true);
      const fitted = fitToBand(scene);
      expect(fitOps(fitted)).toEqual([]);
      expect(fitToBand(fitted)).toBe(fitted);
    }
  });
});
