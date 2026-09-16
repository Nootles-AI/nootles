/**
 * A closed kind's outline as path data, in the node's own local space.
 *
 * The renderer draws a rect and a plain ellipse from the box with CSS and only
 * the parametric kinds as SVG, so it does not need every outline — a boolean
 * operation does, since it has to clip one shape against another whatever
 * kind either of them is. The arc and polygon writers live here so the two
 * agree to the digit: what the renderer draws is what the boolean cuts.
 *
 * `flattenPath` (below) answers a different question over the same `d`
 * strings — not "what is the outline" but "as straight segments, within a
 * pixel of the curve" — needed by both `scene/boolean.ts` (a clipper only
 * knows polygons) and `scene/picking.ts` (a hit test measures distance to a
 * segment, not to a Bézier). It lives here rather than in either caller so
 * the flattening the boolean's rings use and the flattening picking measures
 * against are the same function, not two that could quietly drift.
 */

import { unitPolygon } from "./geometry";
import { parseSubpaths, type Path } from "./path";
import { arcOf, isArc, type Point, type SceneNode, type StyleMap } from "./types";

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The outline of a rect, ellipse, polygon or path; `null` for a text, an
 * image, or a group, which have no geometry of their own.
 */
export function outlineOf(node: SceneNode): string | null {
  switch (node.kind) {
    case "rect":
      return boxOutline(node.w, node.h, node.style);
    case "ellipse": {
      const { w, h } = node;
      return isArc(node) ? arcPath(w, h, arcOf(node)) : whole([w / 2, h / 2], [w / 2, h / 2]);
    }
    case "polygon": {
      const points = scaled(unitPolygon(node.sides), node.w, node.h);
      return roundedPolygon(points, vertexRadius(node.style["border-radius"], node.w, node.h)) || straight(points);
    }
    case "path":
      return node.d || null;
    default:
      return null;
  }
}

export const scaled = (unit: readonly Point[], w: number, h: number): Point[] =>
  unit.map((p) => ({ x: p.x * w, y: p.y * h }));

/** The plain outline, for a box too degenerate to round. */
export const straight = (points: readonly Point[]): string =>
  `M ${points.map((p) => `${round(p.x)} ${round(p.y)}`).join(" L ")} Z`;

// ---------------------------------------------------------------------------
// Rect
// ---------------------------------------------------------------------------

/**
 * The one radius a box reads off its `border-radius`: the shorthand's first
 * value, a percentage against the shorter side, capped where the two arcs on
 * a side would meet. Per-corner values are the box's affair — `outlineOf` and
 * `scene/picking.ts`'s rounded-box containment test (§4.1) both read only
 * this one number, so a click and the boolean cutter agree on where a corner
 * actually is (R5: a per-corner `border-radius` is approximated by its first
 * value everywhere in this file).
 */
export function cornerRadius(value: string | undefined, w: number, h: number): number {
  return Math.min(vertexRadius(value, w, h), w / 2, h / 2);
}

function roundedRect(w: number, h: number, r: number): string {
  if (!(r > 0)) return straight([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]);
  const rr = round(r);
  const arc = (x: number, y: number) => `A ${rr} ${rr} 0 0 1 ${round(x)} ${round(y)}`;
  return `M ${rr} 0 L ${round(w - r)} 0 ${arc(w, r)} L ${round(w)} ${round(h - r)} ${arc(w - r, h)} L ${rr} ${round(h)} ${arc(0, h - r)} L 0 ${rr} ${arc(r, 0)} Z`;
}

/**
 * A box's outline **and** what `scene/picking.ts` clips a `overflow:hidden`
 * group's children to — the rect a rect or a painted/clipping group draws,
 * `cornerRadius` and all, in one place so the two never compute the radius
 * two different ways.
 */
export function boxOutline(w: number, h: number, style: StyleMap): string {
  return roundedRect(w, h, cornerRadius(style["border-radius"], w, h));
}

// ---------------------------------------------------------------------------
// Polygon corner radius
// ---------------------------------------------------------------------------

/**
 * `border-radius` as the one radius a polygon can have.
 *
 * The shorthand's other three values are dropped: a polygon has vertices, not a
 * top-left and a bottom-right, so there is nothing for them to name. The
 * declaration is still the same one the style panel writes and the grammar
 * already round-trips — only its meaning is the shape's rather than the box's.
 */
export function vertexRadius(
  value: string | undefined,
  w: number,
  h: number,
): number {
  const first = value?.trim().split(/[\s/]+/)[0] ?? "";
  const n = Number.parseFloat(first);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // A percentage resolves against the shorter side: a vertex radius is
  // isotropic, so there is no horizontal half and vertical half to split it
  // between the two axes the way a box corner does.
  return first.endsWith("%") ? (n / 100) * Math.min(w, h) : n;
}

/**
 * Figma's polygon corner radius: every vertex replaced by a circular arc
 * tangent to both of its edges.
 *
 * One radius serves every vertex, clamped to the most the tightest one can
 * take — a per-vertex clamp would round a stretched polygon unevenly, and
 * letting a tangent point run past an edge's midpoint is what makes two
 * neighbouring arcs cross and the path fold over itself.
 *
 * Returns `""` for geometry too degenerate to round, which the caller reads as
 * "draw the plain polygon".
 */
export function roundedPolygon(points: readonly Point[], radius: number): string {
  const n = points.length;
  const corners: { v: Point; from: Point; to: Point; tan: number }[] = [];
  let limit = radius;
  let turn = 0;

  for (let i = 0; i < n; i++) {
    const v = points[i];
    const a = delta(points[(i + n - 1) % n], v);
    const b = delta(points[(i + 1) % n], v);
    const la = Math.hypot(a.x, a.y);
    const lb = Math.hypot(b.x, b.y);
    if (la === 0 || lb === 0) return "";
    const from = { x: a.x / la, y: a.y / la };
    const to = { x: b.x / lb, y: b.y / lb };
    // tan(θ/2) for the interior angle θ: the tangent length is radius / tan.
    const tan = Math.tan(
      Math.acos(clamp(from.x * to.x + from.y * to.y, -1, 1)) / 2,
    );
    if (!(tan > 0)) return "";
    corners.push({ v, from, to, tan });
    limit = Math.min(limit, (Math.min(la, lb) / 2) * tan);
    turn += from.y * to.x - from.x * to.y;
  }
  if (!(limit > 0)) return "";

  // Which way the outline turns decides the arcs' sweep; a corner arc is always
  // the minor one, so the large-arc flag is 0.
  const sweep = turn > 0 ? 1 : 0;
  const r = round(limit);
  let d = "";
  for (const { v, from, to, tan } of corners) {
    const t = limit / tan;
    d += `${d ? " L" : "M"} ${point(v, from, t)} A ${r} ${r} 0 0 ${sweep} ${point(v, to, t)}`;
  }
  return `${d} Z`;
}

const delta = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });

const clamp = (n: number, lo: number, hi: number) =>
  n < lo ? lo : n > hi ? hi : n;

const point = (v: Point, dir: Point, t: number) =>
  `${round(v.x + dir.x * t)} ${round(v.y + dir.y * t)}`;

// ---------------------------------------------------------------------------
// Ellipse and arc
// ---------------------------------------------------------------------------

type Point2 = [number, number];

/** Degrees clockwise from twelve o'clock, as Figma's arc controls state them. */
function polar(c: Point2, r: Point2, deg: number): string {
  const t = ((deg - 90) * Math.PI) / 180;
  return `${round(c[0] + r[0] * Math.cos(t))} ${round(c[1] + r[1] * Math.sin(t))}`;
}

/** A whole ellipse as two half arcs — one arc of 360° would put its endpoints on
 *  top of each other and draw nothing at all. */
function whole(c: Point2, r: Point2): string {
  const [rx, ry] = [round(r[0]), round(r[1])];
  const [left, right] = [round(c[0] - r[0]), round(c[0] + r[0])];
  const cy = round(c[1]);
  return `M ${left} ${cy} A ${rx} ${ry} 0 1 0 ${right} ${cy} A ${rx} ${ry} 0 1 0 ${left} ${cy} Z`;
}

/**
 * The ellipse as Figma's arc controls describe it: a pie wedge when there is no
 * hole, an annular sector when there is, and a ring when the sweep is whole.
 */
export function arcPath(
  w: number,
  h: number,
  { start, sweep, inner }: { start: number; sweep: number; inner: number },
): string {
  const c: Point2 = [w / 2, h / 2];
  const r: Point2 = [w / 2, h / 2];
  const hole: Point2 = [r[0] * inner, r[1] * inner];

  if (Math.abs(sweep) >= 360) {
    return inner > 0 ? `${whole(c, r)} ${whole(c, hole)}` : whole(c, r);
  }
  if (sweep === 0) return "";

  const large = Math.abs(sweep) > 180 ? 1 : 0;
  const cw = sweep > 0 ? 1 : 0;
  const end = start + sweep;
  const outer = `A ${round(r[0])} ${round(r[1])} 0 ${large} ${cw} ${polar(c, r, end)}`;
  if (inner <= 0) {
    return `M ${round(c[0])} ${round(c[1])} L ${polar(c, r, start)} ${outer} Z`;
  }
  return `M ${polar(c, r, start)} ${outer} L ${polar(c, hole, end)} A ${round(hole[0])} ${round(hole[1])} 0 ${large} ${1 - cw} ${polar(c, hole, start)} Z`;
}

// ---------------------------------------------------------------------------
// Flattening — straight segments within a pixel of the curve
// ---------------------------------------------------------------------------

/** One subpath, flattened. `closed` is `parseSubpaths`'s own flag, carried
 *  through rather than re-derived — a stroke on an open path has no closing
 *  segment, and only the subpath itself knows whether it has one. */
export type Polyline = { points: Point[]; closed: boolean };

/** How far a chord may sit from its curve, in scene px — a boolean's clip and
 *  a stroke hit test both read "the curve" through this, so one tolerance. */
const FLATTEN_TOLERANCE = 0.1;
const FLATTEN_MAX_DEPTH = 14;

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Whether the cubic's control points already sit within tolerance of the
 *  chord `p0 → p3` — the stopping rule for the subdivision below. */
function isFlatEnough(p0: Point, p1: Point, p2: Point, p3: Point): boolean {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const len = Math.hypot(dx, dy);
  const off = (p: Point) =>
    len < 1e-9
      ? Math.hypot(p.x - p0.x, p.y - p0.y)
      : Math.abs((p.x - p0.x) * dy - (p.y - p0.y) * dx) / len;
  return off(p1) <= FLATTEN_TOLERANCE && off(p2) <= FLATTEN_TOLERANCE;
}

/** Adaptive de Casteljau subdivision: split until both control points sit on
 *  the chord, or the depth budget runs out on a genuinely tight curve. */
function subdivideCubic(p0: Point, p1: Point, p2: Point, p3: Point, out: Point[], depth: number): void {
  if (depth >= FLATTEN_MAX_DEPTH || isFlatEnough(p0, p1, p2, p3)) {
    out.push(p3);
    return;
  }
  const p01 = midpoint(p0, p1);
  const p12 = midpoint(p1, p2);
  const p23 = midpoint(p2, p3);
  const p012 = midpoint(p01, p12);
  const p123 = midpoint(p12, p23);
  const m = midpoint(p012, p123);
  subdivideCubic(p0, p01, p012, m, out, depth + 1);
  subdivideCubic(m, p123, p23, p3, out, depth + 1);
}

/** One subpath's anchors, flattened to points. A closed subpath's last
 *  segment wraps from the final anchor back to the first; an open one stops
 *  at the last anchor, with no segment back to the start. */
function polylineOf(path: Path): Polyline {
  const n = path.anchors.length;
  if (n === 0) return { points: [], closed: path.closed };
  const first = path.anchors[0].point;
  const points: Point[] = [{ x: first.x, y: first.y }];
  const segments = path.closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const a = path.anchors[i];
    const b = path.anchors[(i + 1) % n];
    subdivideCubic(
      a.point,
      { x: a.point.x + a.handleOut.x, y: a.point.y + a.handleOut.y },
      { x: b.point.x + b.handleIn.x, y: b.point.y + b.handleIn.y },
      b.point,
      points,
      0,
    );
  }
  // A closed subpath's flattening lands back on the first point; the segment
  // list implies the closure, so the duplicate is dropped.
  const last = points[points.length - 1];
  if (points.length > 1 && last.x === points[0].x && last.y === points[0].y) points.pop();
  return { points, closed: path.closed };
}

/**
 * Every subpath of `d`, flattened to straight segments within
 * {@link FLATTEN_TOLERANCE} scene px of the curve they replace. Identical
 * point output to `scene/boolean.ts`'s rings for a closed subpath — that
 * module derives its `Ring`s from this — and, for an open one, the same
 * points without the closing segment back to the start, so a stroke hit test
 * never measures a segment the renderer never draws.
 *
 * A degenerate (0-anchor) subpath is dropped; a 1-anchor one yields a single
 * point (`{points: [p], closed}`) — plausible input from a pen stroke of one
 * click, and a caller measuring distance-to-a-point handles it for free.
 */
export function flattenPath(d: string): Polyline[] {
  return parseSubpaths(d)
    .map(polylineOf)
    .filter((polyline) => polyline.points.length > 0);
}
