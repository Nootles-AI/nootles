import { absoluteBounds } from "./geometry";
import {
  EDGE_SIDES,
  findNode,
  type EdgeSide,
  type Point,
  type Rect,
  type Scene,
  type SceneEdge,
} from "./types";

/**
 * Where a connector runs — the whole of it, derived, every time.
 *
 * An edge stores two node ids and nothing else, so this module answers the two
 * questions that follow from that: which side of each box the line should leave
 * and enter, and what path joins them. Both are pure functions of the current
 * geometry, which is what lets a shape move without leaving a connector behind.
 *
 * Data-only, like the rest of `scene/` — no React, no DOM. The renderer turns
 * the polyline into an SVG `d`; the connector tool uses the same plug points to
 * decide what a pointer is over.
 */

/** How far the line runs straight out of a plug before it is allowed to turn.
 *  Enough that the stub reads as leaving the shape deliberately. */
const STUB = 18;

/** Below this the two boxes are treated as touching on that axis. */
const EPSILON = 0.5;

/** Outward unit normal of each side. */
const NORMAL: Record<EdgeSide, Point> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

const HORIZONTAL: ReadonlySet<EdgeSide> = new Set<EdgeSide>(["left", "right"]);

/** The plug: the middle of one side of the box. */
export function plugPoint(box: Rect, side: EdgeSide): Point {
  switch (side) {
    case "top":
      return { x: box.x + box.w / 2, y: box.y };
    case "right":
      return { x: box.x + box.w, y: box.y + box.h / 2 };
    case "bottom":
      return { x: box.x + box.w / 2, y: box.y + box.h };
    case "left":
      return { x: box.x, y: box.y + box.h / 2 };
  }
}

/** All four, in {@link EDGE_SIDES} order — what the connector tool draws. */
export function plugPoints(box: Rect): { side: EdgeSide; at: Point }[] {
  return EDGE_SIDES.map((side) => ({ side, at: plugPoint(box, side) }));
}

/**
 * Which pair of sides faces.
 *
 * Measured on the *gap between the boxes*, not the distance between their
 * centres: two boxes side by side but at different heights have a large centre
 * dy and should still connect right-to-left, which is what a centre comparison
 * gets wrong. A negative gap means the boxes overlap on that axis, and the axis
 * they overlap least on is the one with something to say.
 */
function chooseSides(a: Rect, b: Rect): [EdgeSide, EdgeSide] {
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));

  if (dx >= dy) {
    return b.x + b.w / 2 >= a.x + a.w / 2 ? ["right", "left"] : ["left", "right"];
  }
  return b.y + b.h / 2 >= a.y + a.h / 2 ? ["bottom", "top"] : ["top", "bottom"];
}

const step = (from: Point, normal: Point, by: number): Point => ({
  x: from.x + normal.x * by,
  y: from.y + normal.y * by,
});

/**
 * Drops points that add nothing: a repeat, or a middle point its neighbours
 * already run straight through. Without this a facing pair whose plugs happen
 * to line up would draw a Z with two zero-length turns, and the renderer would
 * put a visible joint on each.
 */
function simplify(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (
      last &&
      Math.abs(last.x - p.x) < EPSILON &&
      Math.abs(last.y - p.y) < EPSILON
    ) {
      continue;
    }
    out.push(p);
  }
  for (let i = out.length - 2; i > 0; i--) {
    const before = out[i - 1];
    const after = out[i + 1];
    const collinear =
      (Math.abs(before.x - after.x) < EPSILON &&
        Math.abs(before.x - out[i].x) < EPSILON) ||
      (Math.abs(before.y - after.y) < EPSILON &&
        Math.abs(before.y - out[i].y) < EPSILON);
    if (collinear) out.splice(i, 1);
  }
  return out;
}

/**
 * The elbow itself: out along each plug's normal, then right angles between.
 *
 * Two facing plugs on the same axis meet in the middle of the gap — the Z that
 * a flowchart wants. Two plugs on different axes need only one corner, so they
 * get an L. Every segment is axis-aligned by construction; there is no path
 * through here that produces a diagonal.
 */
export function elbowPoints(
  from: Rect,
  to: Rect,
  sides?: [EdgeSide, EdgeSide],
): Point[] {
  const [sideA, sideB] = sides ?? chooseSides(from, to);
  const a = plugPoint(from, sideA);
  const b = plugPoint(to, sideB);
  const a1 = step(a, NORMAL[sideA], STUB);
  const b1 = step(b, NORMAL[sideB], STUB);

  const aHorizontal = HORIZONTAL.has(sideA);
  const bHorizontal = HORIZONTAL.has(sideB);

  if (aHorizontal && bHorizontal) {
    const mid = (a1.x + b1.x) / 2;
    return simplify([a, a1, { x: mid, y: a1.y }, { x: mid, y: b1.y }, b1, b]);
  }
  if (!aHorizontal && !bHorizontal) {
    const mid = (a1.y + b1.y) / 2;
    return simplify([a, a1, { x: a1.x, y: mid }, { x: b1.x, y: mid }, b1, b]);
  }
  // One of each: the corner is where the horizontal run meets the vertical one.
  const corner = aHorizontal ? { x: b1.x, y: a1.y } : { x: a1.x, y: b1.y };
  return simplify([a, a1, corner, b1, b]);
}

/** The two boxes a connector joins, or `null` if either end has gone. */
function edgeBoxes(scene: Scene, edge: SceneEdge): [Rect, Rect] | null {
  if (!findNode(scene, edge.from) || !findNode(scene, edge.to)) return null;
  return [absoluteBounds(scene, edge.from), absoluteBounds(scene, edge.to)];
}

/** A connector's polyline in scene coordinates, or `null` if it cannot be
 *  drawn — a hand-authored edge naming a node that is not there. */
export function edgePoints(scene: Scene, edge: SceneEdge): Point[] | null {
  const boxes = edgeBoxes(scene, edge);
  return boxes ? elbowPoints(boxes[0], boxes[1]) : null;
}

/** How much of each corner is turned into an arc, in scene units. */
export const CORNER = 8;

/**
 * An open polyline as SVG path data, with its corners eased.
 *
 * Each turn is cut back along both of its segments and bridged with a quadratic
 * through the original vertex, which on axis-aligned runs is a quarter round.
 * The cut is capped at half of the shorter neighbour, so a tight elbow rounds
 * as far as it can rather than overshooting into the segment past it.
 *
 * `radius` of 0 gives the bare polyline back, for anything that wants the
 * corners it was handed.
 */
export function pointsToPath(points: readonly Point[], radius = CORNER): string {
  if (points.length === 0) return "";
  if (points.length < 3 || radius <= 0) {
    return points
      .map((p, i) => `${i ? "L" : "M"}${round(p.x)} ${round(p.y)}`)
      .join(" ");
  }

  let d = `M${round(points[0].x)} ${round(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 0.1) {
      d += ` L${round(cur.x)} ${round(cur.y)}`;
      continue;
    }
    const a = along(cur, prev, r);
    const b = along(cur, next, r);
    d += ` L${round(a.x)} ${round(a.y)}`;
    d += ` Q${round(cur.x)} ${round(cur.y)} ${round(b.x)} ${round(b.y)}`;
  }
  const last = points[points.length - 1];
  return `${d} L${round(last.x)} ${round(last.y)}`;
}

/** `distance` from `from`, in the direction of `towards`. */
function along(from: Point, towards: Point, distance: number): Point {
  const len = Math.hypot(towards.x - from.x, towards.y - from.y);
  if (len === 0) return from;
  return {
    x: from.x + ((towards.x - from.x) / len) * distance,
    y: from.y + ((towards.y - from.y) / len) * distance,
  };
}

/**
 * The side of a box a point is nearest, which is how a press anywhere on a
 * shape decides which plug it meant. Signed, so a point outside the box picks
 * the side it is outside of rather than the one it is closest to the middle of.
 */
export function sideNearest(box: Rect, p: Point): EdgeSide {
  const d: [EdgeSide, number][] = [
    ["top", p.y - box.y],
    ["bottom", box.y + box.h - p.y],
    ["left", p.x - box.x],
    ["right", box.x + box.w - p.x],
  ];
  return d.reduce((best, one) => (one[1] < best[1] ? one : best))[0];
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Halfway along the line by arc length, which is where a label belongs — the
 * middle *segment's* midpoint would sit off to one side whenever the two stubs
 * are different lengths, which is most of the time.
 */
export function polylineMidpoint(points: readonly Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(
      points[i].x - points[i - 1].x,
      points[i].y - points[i - 1].y,
    );
  }
  let seen = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (seen + len >= total / 2) {
      const t = len === 0 ? 0 : (total / 2 - seen) / len;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    seen += len;
  }
  return points[points.length - 1];
}
