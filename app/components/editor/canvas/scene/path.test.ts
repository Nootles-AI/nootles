import { describe, expect, it } from "vitest";
import { adoptScene } from "./adopt";
import { emptyScene } from "./migrate";
import { applyOps } from "./ops";
import { pathBounds, pathDataBounds, parseSubpaths, scalePath, type Path } from "./path";
import type { PathNode, Point, Rect } from "./types";

/** Every point the renderer draws for `d`, sampled densely along each cubic. */
function sample(d: string, steps = 400): Point[] {
  const out: Point[] = [];
  for (const path of parseSubpaths(d)) {
    const { anchors, closed } = path;
    const n = closed ? anchors.length : anchors.length - 1;
    if (anchors.length === 1) out.push(anchors[0].point);
    for (let i = 0; i < n; i++) {
      const a = anchors[i];
      const b = anchors[(i + 1) % anchors.length];
      const p0 = a.point;
      const p1 = { x: a.point.x + a.handleOut.x, y: a.point.y + a.handleOut.y };
      const p2 = { x: b.point.x + b.handleIn.x, y: b.point.y + b.handleIn.y };
      const p3 = b.point;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const u = 1 - t;
        out.push({
          x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
          y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
        });
      }
    }
  }
  return out;
}

function sampledBox(points: readonly Point[]): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** `box` holds every sampled point, and is no looser than the samples by more than `eps`. */
function expectTight(box: Rect, d: string, eps = 0.01) {
  const s = sampledBox(sample(d));
  expect(box.x).toBeLessThanOrEqual(s.x + 1e-9);
  expect(box.y).toBeLessThanOrEqual(s.y + 1e-9);
  expect(box.x + box.w).toBeGreaterThanOrEqual(s.x + s.w - 1e-9);
  expect(box.y + box.h).toBeGreaterThanOrEqual(s.y + s.h - 1e-9);
  expect(s.x - box.x).toBeLessThan(eps);
  expect(s.y - box.y).toBeLessThan(eps);
  expect(box.x + box.w - (s.x + s.w)).toBeLessThan(eps);
  expect(box.y + box.h - (s.y + s.h)).toBeLessThan(eps);
}

/** Curves whose control points reach well past their anchors, every way. */
const OVERSHOOTS = [
  // One arch, far above both anchors.
  "M 0 100 C 0 -100 200 -100 200 100",
  // An S whose two humps pass either side of the chord.
  "M 0 0 C 300 -200 -100 300 200 100",
  // A loop: the curve crosses itself past both endpoints.
  "M 50 50 C 300 300 -200 300 100 50",
  // A pen-drawn smooth anchor mid-path, handles pulled far out.
  "M 0 50 C 0 50 40 -60 100 50 C 160 160 200 50 200 50",
  // Closed, with the closing curve bulging too.
  "M 0 0 C 80 -60 120 -60 200 0 C 260 80 260 120 200 200 C 100 260 0 260 0 200 C -60 120 -60 80 0 0 Z",
  // Quadratics and an arc, normalised to cubics on the way in.
  "M 0 0 Q 100 -150 200 0 T 400 0",
  "M 10 80 A 60 40 30 1 1 150 80",
];

describe("pathBounds — the box is the drawing's, not the anchors'", () => {
  for (const d of OVERSHOOTS) {
    it(`holds every drawn point of ${d.slice(0, 32)}…`, () => {
      const box = pathDataBounds(d);
      expect(box).not.toBeNull();
      expectTight(box!, d);
    });
  }

  it("reaches past the anchor hull where the controls pull the curve", () => {
    const path: Path = parseSubpaths("M 0 100 C 0 -100 200 -100 200 100")[0];
    const box = pathBounds(path);
    // The anchors sit at y 100; the arch peaks at 100 - 0.75·200 = -50.
    expect(box.y).toBeCloseTo(-50, 6);
    expect(box.h).toBeCloseTo(150, 6);
  });

  it("stays tight through a scale", () => {
    for (const d of OVERSHOOTS) {
      const scaled = scalePath(d, 1.7, 0.4);
      expectTight(pathDataBounds(scaled)!, scaled);
    }
  });
});

describe("path boxes in the scene", () => {
  const node = (d: string, box: Rect): PathNode => ({
    kind: "path",
    id: "p",
    ...box,
    rot: 0,
    style: {},
    label: "",
    locked: false,
    hidden: false,
    attrs: {},
    d,
  });

  it("a model-written curve is adopted onto its drawn extent", () => {
    const d = "M 0 100 C 0 -100 200 -100 200 100";
    const adopted = adoptScene({ ...emptyScene(), nodes: [node(d, { x: 40, y: 40, w: 200, h: 100 })] });
    const p = adopted.nodes[0] as PathNode;
    expect(p.y).toBeCloseTo(40 - 50, 2);
    expect(p.h).toBeCloseTo(150, 2);
    expectTight({ x: 0, y: 0, w: p.w, h: p.h }, p.d, 0.02);
  });

  it("a resized curve keeps its box tight", () => {
    const d = "M 0 150 C 0 -50 200 -50 200 150";
    const box = pathDataBounds(d)!;
    const tight = { ...emptyScene(), nodes: [node(d, { x: 10, y: 10, w: box.w, h: box.h })] };
    const shifted = adoptScene(tight);
    const resized = applyOps(shifted, [
      { type: "resize", frames: [{ id: "p", x: 10, y: 10, w: box.w * 2, h: box.h / 2 }] },
    ]);
    const p = resized.nodes[0] as PathNode;
    expectTight({ x: 0, y: 0, w: p.w, h: p.h }, p.d, 0.02);
  });
});
