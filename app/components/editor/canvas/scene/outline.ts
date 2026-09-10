/**
 * A closed kind's outline as path data, in the node's own local space.
 *
 * The renderer draws a rect and a plain ellipse from the box with CSS and only
 * the parametric kinds as SVG, so it does not need every outline — a boolean
 * operation does, since it has to clip one shape against another whatever
 * kind either of them is. The arc and polygon writers live here so the two
 * agree to the digit: what the renderer draws is what the boolean cuts.
 */

import { unitPolygon } from "./geometry";
import { arcOf, isArc, type Point, type SceneNode } from "./types";

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The outline of a rect, ellipse, polygon or path; `null` for a text, an
 * image, or a group, which have no geometry of their own.
 */
export function outlineOf(node: SceneNode): string | null {
  switch (node.kind) {
    case "rect":
      return roundedRect(node.w, node.h, cornerRadius(node.style["border-radius"], node.w, node.h));
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
 * The one radius a boolean reads off a rect's `border-radius`: the shorthand's
 * first value, a percentage against the shorter side, capped where the two
 * arcs on a side would meet. Per-corner values are the box's affair.
 */
function cornerRadius(value: string | undefined, w: number, h: number): number {
  return Math.min(vertexRadius(value, w, h), w / 2, h / 2);
}

function roundedRect(w: number, h: number, r: number): string {
  if (!(r > 0)) return straight([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]);
  const rr = round(r);
  const arc = (x: number, y: number) => `A ${rr} ${rr} 0 0 1 ${round(x)} ${round(y)}`;
  return `M ${rr} 0 L ${round(w - r)} 0 ${arc(w, r)} L ${round(w)} ${round(h - r)} ${arc(w - r, h)} L ${rr} ${round(h)} ${arc(0, h - r)} L 0 ${rr} ${arc(r, 0)} Z`;
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
