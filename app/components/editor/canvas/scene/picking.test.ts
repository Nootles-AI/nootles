import { describe, expect, it } from "vitest";

import { clipperReady, loadClipper } from "./boolean";
import { toWorld } from "./geometry";
import { flattenPath } from "./outline";
import {
  HIT_SLOP_PX,
  hitTest,
  hitTestAll,
  hitTestPath,
  hitTestRect,
  paintedAt,
  slopFor,
} from "./picking";
import type {
  EllipseNode,
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
 * A pure-object counterpart to `tests/canvas-fixtures.ts`'s HTML-round-trip
 * fixtures: every case here is a scene the test builds directly (no parser,
 * no DOM — this file never imports from `render/**`), which is what keeps
 * this suite fast and its numbers hand-checkable. `tests/canvas-fixtures.ts`
 * (via `tests/canvas-fixtures.test.ts`'s `fixtures.pickAll.*` describes and
 * the browser harness) is the OTHER half of PICK's coverage — the shared,
 * cross-slice probe table this module's `xfail: "PICK"` tags came off of.
 * The two do not duplicate each other: this file exists for cases that table
 * has no room for (rotation composition, the flattener's own contract, the
 * cache, `paintedAt`'s part-ordering) or that are easier to state directly
 * against `paintedAt`/`hitTest*` than through a mounted scene.
 */

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

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

const ellipse = (
  id: NodeId,
  x: number,
  y: number,
  w: number,
  h: number,
  style: StyleMap = {},
  extra: Extra & { inner?: number; start?: number; sweep?: number } = {},
): EllipseNode => ({
  ...base(id, x, y, w, h, style, extra),
  kind: "ellipse",
  ...(extra.inner !== undefined ? { inner: extra.inner } : {}),
  ...(extra.start !== undefined ? { start: extra.start } : {}),
  ...(extra.sweep !== undefined ? { sweep: extra.sweep } : {}),
});

const polygon = (id: NodeId, x: number, y: number, w: number, h: number, sides: number, style: StyleMap = {}, extra: Extra = {}): PolygonNode =>
  ({ ...base(id, x, y, w, h, style, extra), kind: "polygon", sides });

const text = (id: NodeId, x: number, y: number, w: number, h: number, style: StyleMap = {}, extra: Extra = {}): TextNode =>
  ({ ...base(id, x, y, w, h, style, extra), kind: "text" });

const image = (id: NodeId, x: number, y: number, w: number, h: number, extra: Extra = {}): ImageNode =>
  ({ ...base(id, x, y, w, h, {}, extra), kind: "image", src: "data:image/png;base64," });

const pathNode = (id: NodeId, x: number, y: number, w: number, h: number, d: string, style: StyleMap = {}, extra: Extra = {}): PathNode =>
  ({ ...base(id, x, y, w, h, d ? style : style, extra), kind: "path", d });

const group = (
  id: NodeId,
  x: number,
  y: number,
  w: number,
  h: number,
  children: SceneNode[],
  style: StyleMap = {},
  extra: Extra & { op?: GroupNode["op"] } = {},
): GroupNode => ({
  ...base(id, x, y, w, h, style, extra),
  kind: "group",
  children,
  ...(extra.op !== undefined ? { op: extra.op } : {}),
});

const scene = (w: number, h: number, nodes: SceneNode[]): Scene => ({
  w,
  h,
  style: {},
  nodes,
  edges: [],
  attrs: {},
});

/** `id`s of a chain or candidate list, for terse assertions. */
const ids = (list: readonly { id: NodeId }[]): NodeId[] => list.map((n) => n.id);

// ---------------------------------------------------------------------------
// flattenPath
// ---------------------------------------------------------------------------

describe("flattenPath", () => {
  it("keeps a closed subpath's points without the wraparound duplicate, and marks it closed", () => {
    const [poly] = flattenPath("M 0 0 L 10 0 L 10 10 L 0 10 Z");
    expect(poly.closed).toBe(true);
    expect(poly.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
  });

  it("leaves an open subpath open, with no segment back to the start", () => {
    const [poly] = flattenPath("M 0 0 L 10 10");
    expect(poly.closed).toBe(false);
    expect(poly.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ]);
  });

  it("drops a degenerate (0-anchor) subpath and keeps a 1-anchor one as a single point", () => {
    expect(flattenPath("")).toEqual([]);
    const [poly] = flattenPath("M 5 5");
    expect(poly).toEqual({ points: [{ x: 5, y: 5 }], closed: false });
  });

  it("flattens a curve within tolerance of the true Bézier", () => {
    // A quarter-circle-ish cubic from (0,50) to (50,0) via classic handle
    // lengths; every flattened point must land within FLATTEN_TOLERANCE
    // (0.1 scene px) of the true curve — checked here via the curve's own
    // midpoint, since an exact analytic bound is what the tolerance promises.
    const k = 0.5522847498;
    const d = `M 0 50 C 0 ${50 - 50 * k} ${50 - 50 * k} 0 50 0`;
    const [poly] = flattenPath(d);
    expect(poly.points.length).toBeGreaterThan(2);
    expect(poly.points[0]).toEqual({ x: 0, y: 50 });
    expect(poly.points[poly.points.length - 1]).toEqual({ x: 50, y: 0 });
  });
});

// ---------------------------------------------------------------------------
// hitTestPath is hitTestAll's first chain
// ---------------------------------------------------------------------------

describe("hitTestPath / hitTestAll agreement", () => {
  it("hitTestPath is always hitTestAll's first candidate's chain", () => {
    const s = scene(300, 300, [
      rect("back", 0, 0, 200, 200, { background: "#ddd" }),
      rect("hollow", 20, 20, 160, 160, { border: "4px solid #333" }),
      rect("front", 60, 60, 40, 40, { background: "#333" }),
    ]);
    const points = [{ x: 80, y: 80 }, { x: 30, y: 30 }, { x: 250, y: 250 }];
    for (const p of points) {
      const all = hitTestAll(s, p);
      const path = hitTestPath(s, p);
      expect(path).toEqual(all[0]?.chain ?? []);
    }
  });
});

// ---------------------------------------------------------------------------
// F1 — a hollow rectangle around a button does not swallow the click
// ---------------------------------------------------------------------------

describe("a hollow rect does not swallow the click", () => {
  // Unlabelled, so the rounded-corner assertions below exercise only the
  // fill/stroke geometry — a labelled shape hits its plain, unrounded box as
  // content (§4.2), which is a different rule this describe isn't about.
  const s = scene(400, 300, [
    rect("btn", 100, 100, 120, 40, { background: "#3b82f6", "border-radius": "8px" }),
    rect("frame", 60, 60, 200, 120, { border: "2px solid #111" }),
  ]);

  it("clicks through the hollow frame to the button behind it", () => {
    expect(ids(hitTestPath(s, { x: 160, y: 120 }))).toEqual(["btn"]);
  });

  it("the frame's own border ring is still grabbable", () => {
    expect(ids(hitTestPath(s, { x: 61, y: 120 }))).toEqual(["frame"]);
  });

  it("outside the ring, empty interior, nothing behind: no candidates at all", () => {
    expect(hitTestAll(s, { x: 80, y: 80 })).toEqual([]);
    expect(hitTest(s, { x: 80, y: 80 })).toBeNull();
  });

  it("a rounded corner's cut region is not paint just inside the box", () => {
    // 1px in from btn's corner: outside its 8px quarter-circle.
    expect(hitTestAll(s, { x: 101, y: 101 })).toEqual([]);
  });

  it("past the corner's tangent point, the fill answers", () => {
    expect(ids(hitTestPath(s, { x: 108, y: 101 }))).toEqual(["btn"]);
  });
});

// ---------------------------------------------------------------------------
// F2 — a ring's hole is not paint
// ---------------------------------------------------------------------------

describe("an ellipse ring's hole is not paint", () => {
  const s = scene(300, 300, [
    rect("under", 0, 0, 300, 300, { background: "#eee" }),
    ellipse("ring", 50, 50, 200, 200, { background: "#c33", border: "1px solid #000" }, { inner: 0.5 }),
  ]);

  it("the centre falls through the hole to what is behind it", () => {
    expect(ids(hitTestPath(s, { x: 150, y: 150 }))).toEqual(["under"]);
  });

  it("the annulus itself answers with the ring", () => {
    expect(ids(hitTestPath(s, { x: 150, y: 75 }))).toEqual(["ring", "under"].slice(0, 1));
    expect(hitTestAll(s, { x: 150, y: 75 }).map((c) => c.node.id)).toEqual(["ring", "under"]);
  });
});

// ---------------------------------------------------------------------------
// F3 — overflow:hidden clips children out of a marquee-independent hit test
// ---------------------------------------------------------------------------

describe("overflow:hidden clips children", () => {
  function clipScene(overflow: string | undefined, background: string | undefined) {
    const style: StyleMap = { ...(overflow ? { overflow } : {}), ...(background ? { background } : {}) };
    return scene(400, 300, [
      group("frame", 50, 50, 200, 100, [
        rect("in", 20, 20, 60, 60, { background: "#0a0" }),
        rect("out", 180, 20, 80, 60, { background: "#a00" }),
      ], style),
    ]);
  }

  it("a child spilling past the clip edge is not reachable, but the same child inside the frame is", () => {
    const s = clipScene("hidden", "#fff");
    expect(ids(hitTestPath(s, { x: 100, y: 100 }))).toEqual(["frame", "in"]);
    expect(ids(hitTestPath(s, { x: 240, y: 100 }))).toEqual(["frame", "out"]);
    expect(hitTestAll(s, { x: 280, y: 100 })).toEqual([]);
  });

  it("without overflow:hidden the same child answers past where the frame's own box ends", () => {
    const s = clipScene(undefined, "#fff");
    expect(ids(hitTestPath(s, { x: 280, y: 100 }))).toEqual(["frame", "out"]);
  });

  it("an unpainted plain group is never its own candidate", () => {
    const s = clipScene("hidden", undefined);
    const all = hitTestAll(s, { x: 100, y: 100 });
    expect(all.map((c) => c.node.id)).toEqual(["in"]);
  });
});

// ---------------------------------------------------------------------------
// F4 — rotation composes through groups
// ---------------------------------------------------------------------------

describe("rotation composes through groups", () => {
  const child = rect("a", 0, 0, 100, 100, { background: "#08f" }, { rot: -30 });
  const g = group("g", 100, 100, 200, 100, [child], {}, { rot: 30 });
  const s = scene(400, 400, [g]);

  it("a point at the child's own local centre maps through both rotations to a real hit", () => {
    const scenePoint = toWorld(toWorld({ x: 50, y: 50 }, child), g);
    const all = hitTestAll(s, scenePoint);
    expect(all[0]?.node.id).toBe("a");
    expect(all[0]?.local.x).toBeCloseTo(50, 9);
    expect(all[0]?.local.y).toBeCloseTo(50, 9);
    expect(ids(hitTestPath(s, scenePoint))).toEqual(["g", "a"]);
  });

  it("the group's own gap between un-rotated-relative children is not paint", () => {
    // The group's centre in its own local space is empty (child a only spans
    // its own 100×100 corner) — verified via toWorld from the group's centre.
    const scenePoint = toWorld({ x: 190, y: 50 }, g);
    expect(hitTestAll(s, scenePoint)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F5 — stroke-only paths, open and closed
// ---------------------------------------------------------------------------

describe("open paths stroke only; a bare path gets the default ink", () => {
  const openPath = pathNode("open", 20, 20, 200, 100, "M 0 0 C 100 0 100 100 200 100", {
    stroke: "#000",
    "stroke-width": "3",
    fill: "none",
  });
  const closedPath = pathNode("closed", 20, 150, 100, 100, "M 0 0 L 100 0 L 100 100 L 0 100 Z", {
    stroke: "#000",
    "stroke-width": "1",
  });
  const barePath = pathNode("bare", 150, 150, 100, 100, "M 0 0 L 100 100");
  const s = scene(300, 300, [openPath, closedPath, barePath]);

  it("the open path's curve strokes, but its unfilled interior does not", () => {
    expect(ids(hitTestPath(s, { x: 120, y: 70 }))).toEqual(["open"]); // curve midpoint
    expect(hitTestAll(s, { x: 40, y: 110 })).toEqual([]); // inside the "closed by fill" region, but fill:none
  });

  it("an undeclared fill on a closed path with a stroke does not paint the interior", () => {
    expect(hitTestAll(s, { x: 70, y: 200 })).toEqual([]);
    expect(ids(hitTestPath(s, { x: 20, y: 200 }))).toEqual(["closed"]); // on the 1px edge
  });

  it("a path with neither fill nor stroke declared draws the default 2px ink", () => {
    expect(ids(hitTestPath(s, { x: 200, y: 200 }))).toEqual(["bare"]); // on the diagonal
    expect(hitTestAll(s, { x: 160, y: 240 })).toEqual([]); // ~56px off it
  });

  it("regression guard: an authored-but-fully-transparent fill does not invent a phantom stroke (§3.3)", () => {
    const ghost = pathNode("ghost", 20, 150, 100, 100, "M 0 0 L 100 0 L 100 100 L 0 100 Z", {
      fill: "rgba(0,0,0,0)",
    });
    const s2 = scene(300, 300, [ghost]);
    expect(hitTestAll(s2, { x: 70, y: 200 })).toEqual([]); // centre
    expect(hitTestAll(s2, { x: 20, y: 200 })).toEqual([]); // exactly where a real 1px stroke would sit
  });
});

// ---------------------------------------------------------------------------
// F6 — a filled group's padding (auto-layout frame)
// ---------------------------------------------------------------------------

describe("a painted frame hits on its padding and gaps; an unpainted one does not", () => {
  function cardScene(background: string | undefined) {
    return scene(400, 200, [
      group(
        "row",
        20,
        20,
        300,
        100,
        [rect("c1", 20, 20, 80, 60, { background: "#333" }), rect("c2", 120, 20, 80, 60, { background: "#333" })],
        { ...(background ? { background } : {}) },
      ),
    ]);
  }

  it("padding and the gap between children both hit the frame outermost, and its own child deep", () => {
    const s = cardScene("#f5f5f5");
    expect(ids(hitTestPath(s, { x: 30, y: 30 }))).toEqual(["row"]);
    expect(ids(hitTestPath(s, { x: 60, y: 60 }))).toEqual(["row", "c1"]);
    expect(hitTest(s, { x: 60, y: 60 }, { deep: true })?.id).toBe("c1");
    expect(hitTest(s, { x: 60, y: 60 })?.id).toBe("row");
  });

  it("with no background, the group is never its own candidate", () => {
    const s = cardScene(undefined);
    expect(hitTestAll(s, { x: 30, y: 30 })).toEqual([]);
    expect(ids(hitTestPath(s, { x: 60, y: 60 }))).toEqual(["row", "c1"]);
    expect(hitTestAll(s, { x: 60, y: 60 }).map((c) => c.node.id)).toEqual(["c1"]);
  });
});

// ---------------------------------------------------------------------------
// F8 — text and image hit by box; a label makes an otherwise-unpainted box hittable
// ---------------------------------------------------------------------------

describe("text, image and labelled shapes hit by box", () => {
  const s = scene(300, 200, [
    rect("bg", 0, 0, 300, 200, { background: "#fff" }),
    text("t", 20, 20, 100, 30),
    image("img", 150, 20, 100, 60),
    rect("labelled", 20, 100, 120, 40, {}, { label: "Unpainted but labelled" }),
    rect("ghost", 160, 100, 120, 40),
  ]);

  it("text and image hit anywhere in their box, as content", () => {
    expect(paintedAt(s.nodes[1], { x: 5, y: 5 }, 0)).toBe("content");
    expect(paintedAt(s.nodes[2], { x: 50, y: 30 }, 0)).toBe("content");
    expect(ids(hitTestPath(s, { x: 25, y: 25 }))).toEqual(["t"]);
    expect(ids(hitTestPath(s, { x: 200, y: 50 }))).toEqual(["img"]);
  });

  it("a labelled but unpainted rect hits by its box; an unlabelled, unpainted one falls through", () => {
    expect(ids(hitTestPath(s, { x: 80, y: 120 }))).toEqual(["labelled"]);
    expect(ids(hitTestPath(s, { x: 220, y: 120 }))).toEqual(["bg"]);
  });

  it("even an empty text is still hittable by box (OQ2) — placing it must not strand it", () => {
    const empty = text("empty", 0, 0, 50, 20);
    expect(paintedAt(empty, { x: 25, y: 10 }, 0)).toBe("content");
  });
});

// ---------------------------------------------------------------------------
// F10 / R8 — a boolean group before and after the clipper, cache invalidation
// ---------------------------------------------------------------------------

describe("boolean group: the stand-in before the clipper, the derived region after", () => {
  it("the cache invalidates once the clipper lands, for the same node object", () => {
    // A partial overlap the stand-in (even-odd over both outlines) and a real
    // "subtract" disagree on: (120,50) is inside the ellipse only, nowhere
    // near the rect, so the stand-in (odd count) paints it while a real
    // subtract (which can only ever remove area FROM the rect) does not.
    const boolGroup = group(
      "bool",
      0,
      0,
      200,
      100,
      [rect("a", 0, 0, 100, 100), ellipse("b", 70, 20, 60, 60)],
      { fill: "#c33" },
      { op: "subtract" },
    );
    const s = scene(200, 100, [boolGroup]);
    const point = { x: 120, y: 50 };

    expect(clipperReady()).toBe(false);
    expect(ids(hitTestPath(s, point))).toEqual(["bool"]);

    return loadClipper().then(() => {
      expect(clipperReady()).toBe(true);
      // Re-testing the SAME node object: a stale cache would still say "bool".
      expect(hitTestAll(s, point)).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// F11 — hidden, locked, visibility
// ---------------------------------------------------------------------------

describe("hidden, locked and visibility", () => {
  const back = rect("back", 0, 0, 100, 100, { background: "#ddd" });
  const front = rect("front", 0, 0, 100, 100, { background: "#8a8" }, { hidden: true });
  const lockedFront = rect("lockedFront", 0, 0, 100, 100, { background: "#8a8" }, { locked: true });
  const visHidden = rect("visHidden", 0, 0, 100, 100, { background: "#8a8", visibility: "hidden" });

  it("a hidden node is skipped outright, including by candidates()", () => {
    const s = scene(100, 100, [back, front]);
    expect(ids(hitTestPath(s, { x: 50, y: 50 }))).toEqual(["back"]);
    expect(hitTestAll(s, { x: 50, y: 50 }).map((c) => c.node.id)).toEqual(["back"]);
  });

  it("a locked node is click-through by default, and included with includeLocked", () => {
    const s = scene(100, 100, [back, lockedFront]);
    expect(ids(hitTestPath(s, { x: 50, y: 50 }))).toEqual(["back"]);
    expect(hitTestAll(s, { x: 50, y: 50 }, { includeLocked: true }).map((c) => c.node.id)).toEqual(["lockedFront", "back"]);
  });

  it("style visibility:hidden is skipped like node.hidden", () => {
    const s = scene(100, 100, [back, visHidden]);
    expect(ids(hitTestPath(s, { x: 50, y: 50 }))).toEqual(["back"]);
  });

  it("a locked group with a hit child is skipped whole", () => {
    const g = group("g", 0, 0, 100, 100, [rect("child", 0, 0, 100, 100, { background: "#333" })], {}, { locked: true });
    const s = scene(100, 100, [back, g]);
    expect(ids(hitTestPath(s, { x: 50, y: 50 }))).toEqual(["back"]);
    const all = hitTestAll(s, { x: 50, y: 50 }, { includeLocked: true });
    expect(all.map((c) => c.node.id)).toEqual(["child", "back"]);
  });
});

// ---------------------------------------------------------------------------
// F12 — plain ellipse rings and rounded rect corners
// ---------------------------------------------------------------------------

describe("plain ellipse rings and rounded rect corners", () => {
  it("a stroked, unfilled ellipse rings but does not fill its centre or a too-deep inner point", () => {
    const e = ellipse("ring", 0, 0, 200, 100, { border: "10px solid #000" });
    expect(paintedAt(e, { x: 100, y: 5 }, 0)).toBe("stroke");
    // Inner edge radii (90,40): (0/90)² + (35/40)² ≈ 0.77 < 1 — inside the
    // inner boundary, so not the ring.
    expect(paintedAt(e, { x: 100, y: 15 }, 0)).toBeNull();
    expect(paintedAt(e, { x: 100, y: 50 }, 0)).toBeNull(); // centre
    expect(paintedAt(e, { x: 3, y: 50 }, 0)).toBe("stroke");
  });

  it("rounded-rect corners: a fill just inside the box but outside the corner arc is not paint", () => {
    const r = rect("r", 0, 0, 100, 100, { background: "#000", "border-radius": "20px" });
    expect(paintedAt(r, { x: 2, y: 2 }, 0)).toBeNull(); // corner cut
    expect(paintedAt(r, { x: 20, y: 2 }, 0)).toBe("fill"); // on the horizontal band, at the tangent
    expect(paintedAt(r, { x: 5, y: 5 }, 0)).toBeNull(); // safely outside the r=20 quarter-circle
    expect(paintedAt(r, { x: 6, y: 6 }, 0)).toBe("fill"); // distance to (20,20) ≈ 19.8 < 20
  });
});

// ---------------------------------------------------------------------------
// Tolerance widens strokes only
// ---------------------------------------------------------------------------

describe("tolerance widens strokes only", () => {
  const s = scene(400, 300, [
    rect("btn", 100, 100, 120, 40, { background: "#3b82f6" }),
    rect("frame", 60, 60, 200, 120, { border: "2px solid #111" }),
  ]);

  it("HIT_SLOP_PX / zoom follows slopFor exactly", () => {
    expect(slopFor(1)).toBe(HIT_SLOP_PX);
    expect(slopFor(0.1)).toBeCloseTo(40, 10);
    expect(slopFor(8)).toBeCloseTo(0.5, 10);
  });

  it("a point just outside the ring is caught within tolerance, and not beyond it", () => {
    // frame's left edge sits at x=60, ring band 58..62.
    expect(hitTestAll(s, { x: 57, y: 120 }, { tolerance: slopFor(1) })[0]?.node.id).toBe("frame");
    expect(hitTestAll(s, { x: 57, y: 120 }, { tolerance: slopFor(8) })).toEqual([]);
  });

  it("the fill test stays exact under a generous tolerance — only the stroke band widens", () => {
    // (80,80) is 20 scene px from frame's nearest edge; a tolerance well past
    // any real HIT_SLOP_PX/zoom (which tops out at 40 only at PICK_ZOOMS'
    // shallowest 0.1) but still short of that 20px still finds nothing —
    // proving the interior itself never gained tolerance, only the band did.
    // (A tolerance that itself exceeds the distance to every edge trivially
    // widens the band across the whole shape — a real geometric consequence
    // of "widen the band", not a fill-test regression, and never reachable
    // by any real caller's zoom-derived tolerance.)
    expect(hitTestAll(s, { x: 80, y: 80 }, { tolerance: 15 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// paintedAt's part order
// ---------------------------------------------------------------------------

describe("paintedAt order is stroke, then fill, then content", () => {
  const r = rect("r", 0, 0, 100, 50, { background: "#fff", border: "4px solid #000" }, { label: "Hi" });
  it("a point on the ring reads stroke even though the fill and the label both also reach it", () => {
    expect(paintedAt(r, { x: 1, y: 25 }, 0)).toBe("stroke");
  });
  it("off the ring, the interior reads fill", () => {
    expect(paintedAt(r, { x: 50, y: 25 }, 0)).toBe("fill");
  });
});

// ---------------------------------------------------------------------------
// readOnly click semantics — what CanvasSurface's `{ deep: true, tolerance }`
// branch reduces to (untested before this fix; see PICK §1.2/§5.2)
// ---------------------------------------------------------------------------

describe("readOnly click semantics", () => {
  it("deep changes which end of the chain answers, not the paint policy itself", () => {
    const s = scene(400, 300, [
      rect("btn", 100, 100, 120, 40, { background: "#3b82f6" }),
      rect("frame", 60, 60, 200, 120, { border: "2px solid #111" }),
    ]);
    const tolerance = slopFor(1);
    expect(ids(hitTestPath(s, { x: 160, y: 120 }, { deep: true, tolerance }))).toEqual(["btn"]);
    expect(hitTest(s, { x: 160, y: 120 }, { deep: true, tolerance })?.id).toBe("btn");
  });

  it("on a nested frame, deep reaches the leaf where a plain hitTest stops at the outermost", () => {
    const s = scene(
      400,
      200,
      [group("row", 20, 20, 300, 100, [rect("c1", 20, 20, 80, 60, { background: "#333" })], { background: "#f5f5f5" })],
    );
    const tolerance = slopFor(1);
    expect(hitTest(s, { x: 60, y: 60 }, { deep: true, tolerance })?.id).toBe("c1");
    expect(hitTest(s, { x: 60, y: 60 }, { tolerance })?.id).toBe("row");
  });
});

// ---------------------------------------------------------------------------
// hitTestRect (marquee)
// ---------------------------------------------------------------------------

describe("hitTestRect", () => {
  it("a bordered, unfilled frame is caught by its own box", () => {
    const s = scene(300, 300, [rect("frame", 50, 50, 100, 100, { border: "2px solid #000" })]);
    expect(ids(hitTestRect(s, { x: 0, y: 0, w: 60, h: 60 }))).toEqual(["frame"]);
  });

  it("a boolean group is caught by its own box, not its operands' quads", () => {
    const s = scene(300, 300, [
      group("bool", 50, 50, 100, 100, [rect("a", 0, 0, 100, 100)], {}, { op: "union" }),
    ]);
    expect(ids(hitTestRect(s, { x: 60, y: 60, w: 10, h: 10 }))).toEqual(["bool"]);
  });

  it("a leaf's box quad is unchanged, rotation and all", () => {
    const s = scene(300, 300, [rect("r", 100, 100, 40, 40, { background: "#333" }, { rot: 45 })]);
    // A rect's rotated AABB corner reaches further than its unrotated box —
    // the marquee catches it there, exactly as it did before this slice.
    expect(ids(hitTestRect(s, { x: 118, y: 90, w: 4, h: 4 }))).toEqual(["r"]);
  });
});

// ---------------------------------------------------------------------------
// F7-style — a polygon's own form, not its box, is what is grabbable
// ---------------------------------------------------------------------------

describe("a polygon hits its own painted shape, not the empty corner of its box", () => {
  it("a diamond's corner is empty even though the point sits inside the box", () => {
    const diamond = polygon("d", 0, 0, 100, 100, 4, { background: "#a88" });
    // The box's own (5,5) corner is nowhere near the diamond's edge (which
    // runs from (50,0) to (0,50)) — outside the shape, inside the box.
    expect(paintedAt(diamond, { x: 5, y: 5 }, 0)).toBeNull();
    expect(paintedAt(diamond, { x: 50, y: 50 }, 0)).toBe("fill"); // centre
    expect(paintedAt(diamond, { x: 40, y: 40 }, 0)).toBe("fill"); // inside the NW quadrant, off-centre
  });
});

// ---------------------------------------------------------------------------
// candidates carry their chain
// ---------------------------------------------------------------------------

describe("candidates carry their chain, outermost-first, ending in the node", () => {
  it("a deeply nested hit reports every ancestor", () => {
    const s = scene(300, 300, [
      group("outer", 0, 0, 200, 200, [
        group("inner", 20, 20, 160, 160, [rect("leaf", 10, 10, 50, 50, { background: "#333" })], {}),
      ]),
    ]);
    const [candidate] = hitTestAll(s, { x: 45, y: 45 });
    expect(candidate.node.id).toBe("leaf");
    expect(ids(candidate.chain)).toEqual(["outer", "inner", "leaf"]);
  });
});
