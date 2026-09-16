import { describe, expect, it } from "vitest";
import { DEFAULT_TEXT_COLOR, gradientAt, gradientT, paintAt, resolveTextColor } from "./paintAt";
import { readFill } from "../panels/fills";
import { readStroke } from "../panels/strokes";
import { parseLayers } from "../panels/cssCatalog";
import type { Gradient } from "../panels/controls/gradient";
import type {
  GroupNode,
  ImageNode,
  NodeId,
  PathNode,
  PolygonNode,
  RectNode,
  Scene,
  SceneNode,
  StyleMap,
  TextNode,
} from "./types";

/**
 * Named-fixture ids (F-prefixed) below trace back to COLOR's own spec §4.4 —
 * this file implements a representative subset of that table (not all 26:
 * see the slice's reported deviations) plus `gradientAt`/`gradientT`'s own
 * numeric contract, which the spec table doesn't separately enumerate.
 * Builders copied from `scene/picking.test.ts` so both suites build the same
 * kind of scene the same way.
 */

interface Extra {
  rot?: number;
  label?: string;
  locked?: boolean;
  hidden?: boolean;
}

function base(id: NodeId, x: number, y: number, w: number, h: number, style: StyleMap, extra: Extra) {
  return {
    id,
    x,
    y,
    w,
    h,
    rot: extra.rot ?? 0,
    style,
    label: extra.label ?? "",
    locked: extra.locked ?? false,
    hidden: extra.hidden ?? false,
    attrs: {},
  };
}

const rect = (id: NodeId, x: number, y: number, w: number, h: number, style: StyleMap = {}, extra: Extra = {}): RectNode =>
  ({ ...base(id, x, y, w, h, style, extra), kind: "rect" });

const polygon = (id: NodeId, x: number, y: number, w: number, h: number, sides: number, style: StyleMap = {}, extra: Extra = {}): PolygonNode =>
  ({ ...base(id, x, y, w, h, style, extra), kind: "polygon", sides });

const text = (id: NodeId, x: number, y: number, w: number, h: number, style: StyleMap = {}, extra: Extra = {}): TextNode =>
  ({ ...base(id, x, y, w, h, style, extra), kind: "text" });

const image = (id: NodeId, x: number, y: number, w: number, h: number, extra: Extra = {}): ImageNode =>
  ({ ...base(id, x, y, w, h, {}, extra), kind: "image", src: "data:image/png;base64," });

const pathNode = (id: NodeId, x: number, y: number, w: number, h: number, d: string, style: StyleMap = {}, extra: Extra = {}): PathNode =>
  ({ ...base(id, x, y, w, h, style, extra), kind: "path", d });

const group = (
  id: NodeId,
  x: number,
  y: number,
  w: number,
  h: number,
  children: SceneNode[],
  style: StyleMap = {},
  extra: Extra = {},
): GroupNode => ({ ...base(id, x, y, w, h, style, extra), kind: "group", children });

const scene = (w: number, h: number, nodes: SceneNode[], style: StyleMap = {}): Scene => ({
  w,
  h,
  style,
  nodes,
  edges: [],
  attrs: {},
});

const at = (x: number, y: number) => ({ x, y });

describe("paintAt — fills", () => {
  it("F1: a var() fill stays a reference", () => {
    const s = scene(100, 100, [rect("a", 0, 0, 100, 100, { background: "var(--brand)" })], {
      "--brand": "#6366f1",
    });
    expect(paintAt(s, at(50, 50), { tolerance: 0 })).toEqual({
      css: "var(--brand)",
      kind: "authored",
      region: "fill",
      nodeId: "a",
    });
  });

  it("F2/F3: a linear gradient interpolates mid-way and reads the exact stop verbatim", () => {
    const bg = "linear-gradient(90deg, #000 0%, #fff 100%)";
    const s = scene(200, 100, [rect("a", 0, 0, 200, 100, { background: bg })]);
    const mid = paintAt(s, at(50, 50), { tolerance: 0 })!;
    expect(mid.kind).toBe("interpolated");
    expect(mid.css).toBe("#404040");
    const edge = paintAt(s, at(0, 50), { tolerance: 0 })!;
    expect(edge).toMatchObject({ css: "#000", kind: "authored", region: "fill" });
  });

  it("F5/F6: a border reads as the stroke's colour, the hollow interior as the box's fill", () => {
    const s = scene(100, 100, [rect("a", 0, 0, 100, 100, { border: "4px solid #ff0000", background: "#fff" })]);
    expect(paintAt(s, at(2, 50), { tolerance: 0 })).toMatchObject({ css: "#ff0000", region: "stroke" });
    expect(paintAt(s, at(50, 50), { tolerance: 0 })).toMatchObject({ css: "#fff", region: "fill" });
  });

  it("F7/F8: an unfilled outlined box falls through to the rect beneath it", () => {
    const s = scene(150, 100, [
      rect("under", 0, 0, 100, 100, { background: "#123456" }),
      rect("a", 0, 0, 100, 100, { outline: "4px solid #00ff00" }),
    ]);
    expect(paintAt(s, at(102, 50), { tolerance: 6 })).toMatchObject({ css: "#00ff00", region: "stroke" });
    expect(paintAt(s, at(50, 50), { tolerance: 0 })).toMatchObject({ css: "#123456", region: "fill", nodeId: "under" });
  });

  it("F9: a hidden front layer of a two-layer stack falls through to the opaque one behind it", () => {
    // Exactly `toLayer`'s non-last-solid spelling — a flat two-stop gradient
    // of the hidden colour riding above the real, opaque backmost solid.
    const s = scene(100, 100, [
      rect("a", 0, 0, 100, 100, { background: "linear-gradient(rgba(1,2,3,0), rgba(1,2,3,0)), #333" }),
    ]);
    expect(paintAt(s, at(50, 50), { tolerance: 0 })).toMatchObject({ css: "#333", kind: "authored", region: "fill" });
  });

  it("F9b: a single hidden solid, nothing beneath and no diagram background, is null", () => {
    // Alpha-0 is invisible to `fillVisible` itself, so `hitTestAll` reports no
    // candidate here at all (nothing paints, nothing is hit-testable) — the
    // same "hollow means click-through" rule PICK's F1 exists to prove.
    const s = scene(100, 100, [rect("a", 0, 0, 100, 100, { "background-color": "rgba(1,2,3,0)" })]);
    expect(paintAt(s, at(50, 50), { tolerance: 0 })).toBeNull();
  });

  it("F17: a painted flex group's padding reads the group's own fill", () => {
    const s = scene(200, 200, [
      group("g", 0, 0, 100, 100, [rect("child", 0, 0, 20, 20, { background: "#000" })], {
        background: "#fafafa",
      }),
    ]);
    // A point on the group's own box that no child covers.
    expect(paintAt(s, at(80, 80), { tolerance: 0 })).toMatchObject({ css: "#fafafa", region: "fill", nodeId: "g" });
  });

  it("F18: a locked shape's fill is still readable", () => {
    const s = scene(100, 100, [rect("a", 0, 0, 100, 100, { background: "#f00" }, { locked: true })]);
    expect(paintAt(s, at(50, 50), { tolerance: 0 })).toMatchObject({ css: "#f00", region: "fill" });
  });

  it("F19: a hidden shape is skipped entirely, in favour of what's under it", () => {
    const s = scene(100, 100, [
      rect("under", 0, 0, 100, 100, { background: "#0f0" }),
      rect("top", 0, 0, 100, 100, { background: "#f00" }, { hidden: true }),
    ]);
    expect(paintAt(s, at(50, 50), { tolerance: 0 })).toMatchObject({ css: "#0f0", nodeId: "under" });
  });

  it("F20: nothing hit, the diagram's own background answers", () => {
    const s = scene(100, 100, [], { background: "oklch(0.97 0.01 90)" });
    expect(paintAt(s, at(50, 50), { tolerance: 0 })).toEqual({
      css: "oklch(0.97 0.01 90)",
      kind: "authored",
      region: "background",
      nodeId: null,
    });
  });

  it("nothing hit and no diagram background is null", () => {
    const s = scene(100, 100, []);
    expect(paintAt(s, at(50, 50), { tolerance: 0 })).toBeNull();
  });

  it("F21: a rotated node's gradient is read in its own local space", () => {
    // 45° square, gradient horizontal in local space; local (w/4, h/2) sits a
    // quarter of the way across regardless of the node's world rotation.
    const bg = "linear-gradient(90deg, #000 0%, #fff 100%)";
    const s = scene(200, 200, [rect("a", 50, 50, 100, 100, { background: bg }, { rot: 45 })]);
    // World point under the node's local (25, 50): rotate that offset from
    // the node's centre (50,50 local == world centre) by 45° and add it back.
    const cx = 100;
    const cy = 100;
    const lx = 25 - 50;
    const ly = 50 - 50;
    const rad = (45 * Math.PI) / 180;
    const wx = cx + lx * Math.cos(rad) - ly * Math.sin(rad);
    const wy = cy + lx * Math.sin(rad) + ly * Math.cos(rad);
    const sample = paintAt(s, at(wx, wy), { tolerance: 0.5 })!;
    expect(sample.css).toBe("#404040");
  });

  it("F23: outside a triangle but inside its box falls through", () => {
    const s = scene(150, 100, [
      rect("under", 0, 0, 100, 100, { background: "#0f0" }),
      polygon("tri", 0, 0, 100, 100, 3, { background: "#0ff" }),
    ]);
    // The corner of the bounding box a 3-gon (point-up triangle) never covers.
    expect(paintAt(s, at(2, 2), { tolerance: 0 })).toMatchObject({ nodeId: "under" });
  });

  it("F25: wholePaint takes the whole gradient string, not the interpolated colour", () => {
    const bg = "linear-gradient(90deg, #000 0%, #fff 100%)";
    const s = scene(200, 100, [rect("a", 0, 0, 200, 100, { background: bg })]);
    const sample = paintAt(s, at(50, 50), { tolerance: 0, wholePaint: true })!;
    expect(sample.paint).toBe(bg);
  });
});

describe("paintAt — text", () => {
  it("F12/F13: a text node's own colour, or its ancestor's when it has none", () => {
    const s = scene(100, 100, [
      group("g", 0, 0, 100, 100, [text("t", 0, 0, 100, 20, {})], { color: "#444" }),
      text("solo", 0, 40, 100, 20, { color: "#222" }),
    ]);
    expect(paintAt(s, at(50, 50), { tolerance: 0 })).toMatchObject({ css: "#222", kind: "authored", region: "text" });
    expect(paintAt(s, at(50, 10), { tolerance: 0 })).toMatchObject({ css: "#444", kind: "inherited", region: "text" });
  });

  it("F14/F15: a text-bearing box reads its fill by default, its text colour with opts.text", () => {
    const s = scene(100, 100, [rect("a", 0, 0, 100, 100, { background: "#eee", color: "#111" }, { label: "hi" })]);
    expect(paintAt(s, at(50, 50), { tolerance: 0 })).toMatchObject({ css: "#eee", region: "fill" });
    expect(paintAt(s, at(50, 50), { tolerance: 0, text: true })).toMatchObject({
      css: "#111",
      region: "text",
      kind: "authored",
    });
  });

  it("F26: nothing authored anywhere falls back to the pure default, never a DOM read", () => {
    const s = scene(100, 100, [text("t", 0, 0, 100, 20, {})]);
    expect(paintAt(s, at(50, 10), { tolerance: 0 })).toEqual({
      css: DEFAULT_TEXT_COLOR,
      kind: "inherited",
      region: "text",
      nodeId: "t",
    });
    expect(resolveTextColor(s, "t")).toEqual({ css: DEFAULT_TEXT_COLOR, own: false });
  });
});

describe("paintAt — image and path", () => {
  it("F10/F11: an image falls through to what's behind it, or reports needsScreen with nothing there", () => {
    const behind = scene(100, 100, [
      rect("under", 0, 0, 100, 100, { background: "#abc" }),
      image("img", 0, 0, 100, 100),
    ]);
    expect(paintAt(behind, at(50, 50), { tolerance: 0 })).toMatchObject({ css: "#abc", nodeId: "under" });

    const alone = scene(100, 100, [image("img", 0, 0, 100, 100)]);
    expect(paintAt(alone, at(50, 50), { tolerance: 0 })).toMatchObject({
      kind: "none",
      region: "image",
      needsScreen: true,
    });
  });

  it("F22: a path's stroke reads its own `stroke` colour", () => {
    const s = scene(100, 100, [
      pathNode("p", 0, 0, 100, 20, "M 0 10 L 100 10", { stroke: "#00f", "stroke-width": "6", fill: "none" }),
    ]);
    expect(paintAt(s, at(50, 11), { tolerance: 1 })).toMatchObject({ css: "#00f", region: "stroke" });
  });

  it("a path's own `fill` reads as authored", () => {
    const s = scene(100, 100, [pathNode("p", 0, 0, 100, 100, "M 0 0 L 100 0 L 100 100 L 0 100 Z", { fill: "#c0ffee" })]);
    expect(paintAt(s, at(50, 50), { tolerance: 0 })).toMatchObject({ css: "#c0ffee", region: "fill" });
  });
});

describe("gradientT / gradientAt", () => {
  const linear: Gradient = { kind: "linear", angle: 90, stops: [{ color: "#000", pos: 0 }, { color: "#fff", pos: 1 }] };

  it("linear 90deg is x/w", () => {
    expect(gradientT(linear, at(50, 999), 200, 100)).toBeCloseTo(0.25, 5);
  });

  it("linear 0deg is 1 - y/h", () => {
    const g: Gradient = { ...linear, angle: 0 };
    expect(gradientT(g, at(999, 25), 200, 100)).toBeCloseTo(0.75, 5);
  });

  it("radial is distance / hypot(w/2,h/2), circle farthest-corner", () => {
    const g: Gradient = { kind: "radial", angle: 0, stops: linear.stops };
    expect(gradientT(g, at(50, 50), 100, 100)).toBeCloseTo(0, 5);
    expect(gradientT(g, at(100, 100), 100, 100)).toBeCloseTo(1, 5);
  });

  it("clamps outside [0, 1]", () => {
    expect(gradientT(linear, at(-500, 0), 200, 100)).toBe(0);
    expect(gradientT(linear, at(5000, 0), 200, 100)).toBe(1);
  });

  it("monotone stops: 30% then 10% is treated as 30%", () => {
    const g: Gradient = { kind: "linear", angle: 90, stops: [{ color: "#f00", pos: 0.3 }, { color: "#00f", pos: 0.1 }] };
    // Both stops now sit at 0.3 — a point at t=0.5 clamps to the last (blue).
    const r = gradientAt(g, at(100, 0), 200, 1);
    expect(r.css).toBe("#00f");
  });

  it("premultiplied alpha: transparent to white at the midpoint is 50% white", () => {
    const g: Gradient = { kind: "linear", angle: 90, stops: [{ color: "transparent", pos: 0 }, { color: "#fff", pos: 1 }] };
    const r = gradientAt(g, at(100, 0), 200, 1);
    expect(r.css).toBe("rgba(255, 255, 255, 0.5)");
  });

  it("onStop returns the authored token verbatim within snap distance", () => {
    const g: Gradient = { kind: "linear", angle: 90, stops: [{ color: "var(--a)", pos: 0 }, { color: "#fff", pos: 1 }] };
    const r = gradientAt(g, at(0, 0), 200, 1);
    expect(r).toEqual({ css: "var(--a)", onStop: "var(--a)", t: 0 });
  });
});

// ---------------------------------------------------------------------------
// Cross-check (build-plan Conflict 5 / spec §8.1): paintAt's own fill/stroke
// classification must agree with panels/fills.ts / panels/strokes.ts on the
// exact same declarations — the whole reason paintAt imports them instead of
// re-deriving its own reader.
// ---------------------------------------------------------------------------

describe("cross-check against panels/fills.ts and panels/strokes.ts", () => {
  it("a fill paintAt reads for a solid/gradient matches readFill's own classification", () => {
    for (const bg of ["#123456", "var(--brand)", "linear-gradient(90deg, #000 0%, #fff 100%)"]) {
      const s = scene(100, 100, [rect("a", 0, 0, 100, 100, { background: bg })]);
      const sample = paintAt(s, at(50, 50), { tolerance: 0 })!;
      const [layer] = parseLayers("background", bg);
      const fill = readFill(layer);
      if (fill.type === "solid") {
        expect(sample.css).toBe(fill.paint);
      } else {
        // A gradient's midpoint sample must be a literal colour paintAt derived
        // from the exact same paint string readFill reports.
        expect(sample.paint).toBe(fill.paint);
      }
    }
  });

  it("a stroke paintAt reads matches readStroke's own colour on inside/outside/center/path fixtures", () => {
    const cases: [SceneNode, { x: number; y: number }][] = [
      [rect("a", 0, 0, 100, 100, { border: "4px solid #111111" }), at(1, 50)],
      [rect("b", 0, 0, 100, 100, { outline: "4px solid #222222" }), at(101, 50)],
      [rect("c", 0, 0, 100, 100, { outline: "4px solid #333333", "outline-offset": "-2px" }), at(99, 50)],
      [pathNode("p", 0, 0, 100, 20, "M 0 10 L 100 10", { stroke: "#444444", "stroke-width": "4" }), at(50, 10)],
    ];
    for (const [node, point] of cases) {
      const s = scene(150, 100, [node]);
      const sample = paintAt(s, point, { tolerance: 3 });
      const stroke = readStroke(node)!;
      expect(sample).toMatchObject({ css: stroke.color, region: "stroke" });
    }
  });
});
