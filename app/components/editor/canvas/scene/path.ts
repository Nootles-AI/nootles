/**
 * The pen tool's path model: an SVG `d` string read as an ordered list of
 * anchors, and written back again.
 *
 * Handles are stored **relative to their anchor**, the way Illustrator and
 * Figma store them. Moving an anchor is then one assignment rather than a
 * rewrite of two control points, and "smooth" is a statement about two vectors
 * rather than about three absolute positions.
 *
 * Everything is normalised to cubics on the way in — an `L` and a `Q` are both
 * a `C` with particular handles — so there is one segment type to drag, split
 * and measure, and `d` is written back in exactly one shape.
 *
 * One subpath only: a second `M` ends the parse. The pen tool cannot author
 * more, and a `PathNode` that held several would have no single anchor list to
 * edit.
 */

import type { Point, Rect } from "./types";

export type AnchorKind = "corner" | "smooth";

export interface Anchor {
  point: Point;
  /** Offset from `point`. Zero means the segment on that side is straight. */
  handleIn: Point;
  handleOut: Point;
  /**
   * `smooth` is a constraint, not a description: the handles are kept collinear
   * and opposite, though their lengths may differ. `corner` frees them.
   */
  kind: AnchorKind;
}

export interface Path {
  anchors: Anchor[];
  closed: boolean;
}

/** A point on a path: the segment from anchor `index` to the next, at `t`. */
export interface PathHit {
  index: number;
  t: number;
  point: Point;
  distance: number;
}

const EPS = 1e-9;

/**
 * Collinearity is tested as `|sin θ|`, and loosely: `d` is written with three
 * decimals, so handles that were exactly opposite come back a rounding apart
 * and must still read as smooth.
 */
const COLLINEAR = 1e-3;

const ZERO: Point = { x: 0, y: 0 };

function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(a: Point, k: number): Point {
  return { x: a.x * k, y: a.y * k };
}

function length(a: Point): number {
  return Math.hypot(a.x, a.y);
}

function isZero(a: Point): boolean {
  return a.x === 0 && a.y === 0;
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function corner(point: Point): Anchor {
  return {
    point,
    handleIn: { x: 0, y: 0 },
    handleOut: { x: 0, y: 0 },
    kind: "corner",
  };
}

/** Whether an anchor's handles already satisfy the `smooth` constraint. */
export function isSmooth(a: Anchor): boolean {
  const li = length(a.handleIn);
  const lo = length(a.handleOut);
  if (li < EPS || lo < EPS) return false;
  const cross = a.handleIn.x * a.handleOut.y - a.handleIn.y * a.handleOut.x;
  const dot = a.handleIn.x * a.handleOut.x + a.handleIn.y * a.handleOut.y;
  return dot < 0 && Math.abs(cross) <= COLLINEAR * li * lo;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

const TOKENS = /[MmLlCcQqZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

export function parsePath(d: string): Path {
  const tokens = d.match(TOKENS);
  if (!tokens) return { anchors: [], closed: false };

  const anchors: Anchor[] = [];
  let closed = false;
  let cmd = "";
  let cur: Point = ZERO;
  let i = 0;

  /** The pair at `n`, resolved against the current point when relative. */
  const at = (n: number, rel: boolean): Point => {
    const x = Number(tokens[n]);
    const y = Number(tokens[n + 1]);
    return rel ? { x: cur.x + x, y: cur.y + y } : { x, y };
  };

  while (i < tokens.length) {
    if (/[a-z]/i.test(tokens[i])) {
      cmd = tokens[i];
      i++;
    } else if (cmd === "M") {
      cmd = "L"; // Extra pairs after a moveto are linetos.
    } else if (cmd === "m") {
      cmd = "l";
    }

    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;
    if (upper === "Z") {
      closed = true;
      break;
    }
    const need = upper === "C" ? 6 : upper === "Q" ? 4 : 2;
    if (upper === "" || i + need > tokens.length) break;
    if (upper === "M" ? anchors.length > 0 : anchors.length === 0) break;

    const prev = anchors[anchors.length - 1];
    if (upper === "M" || upper === "L") {
      cur = at(i, rel);
      anchors.push(corner(cur));
    } else if (upper === "C") {
      const c1 = at(i, rel);
      const c2 = at(i + 2, rel);
      const p = at(i + 4, rel);
      prev.handleOut = sub(c1, prev.point);
      anchors.push({ ...corner(p), handleIn: sub(c2, p) });
      cur = p;
    } else {
      const c = at(i, rel);
      const p = at(i + 2, rel);
      // A quadratic is the cubic whose handles reach two thirds of the way to
      // the shared control point.
      prev.handleOut = scale(sub(c, prev.point), 2 / 3);
      anchors.push({ ...corner(p), handleIn: scale(sub(c, p), 2 / 3) });
      cur = p;
    }
    i += need;
  }

  if (closed && anchors.length > 1) {
    const first = anchors[0];
    const last = anchors[anchors.length - 1];
    // A closing curve lands back on the start; that is the start's handleIn,
    // not a second anchor in the same place.
    if (
      Math.abs(last.point.x - first.point.x) < COLLINEAR &&
      Math.abs(last.point.y - first.point.y) < COLLINEAR
    ) {
      first.handleIn = last.handleIn;
      anchors.pop();
    }
  }
  for (const a of anchors) if (isSmooth(a)) a.kind = "smooth";
  return { anchors, closed: closed && anchors.length > 1 };
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

function num(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return String(r === 0 ? 0 : r);
}

export function serializePath(
  anchors: readonly Anchor[],
  closed: boolean,
): string {
  if (anchors.length === 0) return "";
  const first = anchors[0];
  const out = [`M ${num(first.point.x)} ${num(first.point.y)}`];

  const segment = (a: Anchor, b: Anchor): string => {
    if (isZero(a.handleOut) && isZero(b.handleIn)) {
      return `L ${num(b.point.x)} ${num(b.point.y)}`;
    }
    const c1 = add(a.point, a.handleOut);
    const c2 = add(b.point, b.handleIn);
    return `C ${num(c1.x)} ${num(c1.y)} ${num(c2.x)} ${num(c2.y)} ${num(b.point.x)} ${num(b.point.y)}`;
  };

  for (let i = 1; i < anchors.length; i++) {
    out.push(segment(anchors[i - 1], anchors[i]));
  }
  if (closed && anchors.length > 1) {
    const last = anchors[anchors.length - 1];
    // A straight closing segment is what `Z` already means.
    if (!isZero(last.handleOut) || !isZero(first.handleIn)) {
      out.push(segment(last, first));
    }
    out.push("Z");
  }
  return out.join(" ");
}

/**
 * Scale a `d` about its own origin.
 *
 * `d` is local to the node's box, so a box that changed size must carry its
 * geometry with it — a path left in the coordinates of a box it no longer has
 * is drawn against the wrong frame. Handles are offsets, so the same linear
 * map applies to them untranslated, and a smooth anchor stays smooth: a linear
 * map keeps two opposite vectors opposite.
 *
 * An axis with no extent has no scale — there is nothing to stretch, and the
 * ratio would be infinite.
 */
export function scalePath(d: string, sx: number, sy: number): string {
  if (!d || (sx === 1 && sy === 1)) return d;
  const { anchors, closed } = parsePath(d);
  const map = (p: Point): Point => ({ x: p.x * sx, y: p.y * sy });
  return serializePath(
    anchors.map((a) => ({
      ...a,
      point: map(a.point),
      handleIn: map(a.handleIn),
      handleOut: map(a.handleOut),
    })),
    closed,
  );
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

type Cubic = [Point, Point, Point, Point];

/** Segments joining the anchors — one more than the gaps when closed. */
export function segmentCount(path: Path): number {
  const n = path.anchors.length;
  if (n < 2) return 0;
  return path.closed ? n : n - 1;
}

/** The four control points of segment `index`, wrapping when closed. */
function controls(path: Path, index: number): Cubic {
  const a = path.anchors[index];
  const b = path.anchors[(index + 1) % path.anchors.length];
  return [a.point, add(a.point, a.handleOut), add(b.point, b.handleIn), b.point];
}

function cubicAt(c: Cubic, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return {
    x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x,
    y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y,
  };
}

/** Interior turning points of one axis of a cubic. */
function extrema(v0: number, v1: number, v2: number, v3: number): number[] {
  const a = -v0 + 3 * v1 - 3 * v2 + v3;
  const b = 2 * (v0 - 2 * v1 + v2);
  const c = v1 - v0;
  const out: number[] = [];
  const keep = (t: number) => {
    if (t > 0 && t < 1) out.push(t);
  };
  if (Math.abs(a) < EPS) {
    if (Math.abs(b) > EPS) keep(-c / b);
    return out;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return out;
  const root = Math.sqrt(disc);
  keep((-b + root) / (2 * a));
  keep((-b - root) / (2 * a));
  return out;
}

/**
 * The tight box around the curve — not around the control points. The pen
 * writes this back as the node's frame, so a loose box would grow the shape's
 * bounds every time a handle was pulled.
 */
export function pathBounds(path: Path): Rect {
  const { anchors } = path;
  if (anchors.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const include = (p: Point) => {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  };
  for (const a of anchors) include(a.point);
  const count = segmentCount(path);
  for (let i = 0; i < count; i++) {
    const c = controls(path, i);
    for (const t of extrema(c[0].x, c[1].x, c[2].x, c[3].x)) {
      include(cubicAt(c, t));
    }
    for (const t of extrema(c[0].y, c[1].y, c[2].y, c[3].y)) {
      include(cubicAt(c, t));
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The nearest point on the path within `tolerance`, or `null`.
 *
 * Sampled rather than solved: the answer feeds a click, and a coarse sweep
 * refined around its winner is accurate to well under a screen pixel for a
 * fraction of the cost of a quintic root find.
 */
export function hitTestPath(
  path: Path,
  point: Point,
  tolerance: number,
): PathHit | null {
  let best: PathHit | null = null;
  const count = segmentCount(path);
  for (let i = 0; i < count; i++) {
    const c = controls(path, i);
    let bt = 0;
    let bd = Infinity;
    let bp = c[0];
    const scan = (from: number, to: number, steps: number) => {
      for (let s = 0; s <= steps; s++) {
        const t = from + ((to - from) * s) / steps;
        const p = cubicAt(c, t);
        const d = Math.hypot(p.x - point.x, p.y - point.y);
        if (d < bd) {
          bd = d;
          bt = t;
          bp = p;
        }
      }
    };
    scan(0, 1, 24);
    for (let span = 1 / 24; span > 1e-4; span /= 12) {
      scan(Math.max(0, bt - span), Math.min(1, bt + span), 12);
    }
    if (!best || bd < best.distance) {
      best = { index: i, t: bt, point: bp, distance: bd };
    }
  }
  return best && best.distance <= tolerance ? best : null;
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/**
 * Split segment `index` at `t`, leaving the curve exactly where it was — de
 * Casteljau, so the two halves reproduce the original.
 */
export function insertAnchor(path: Path, index: number, t: number): Anchor[] {
  const out = path.anchors.slice();
  if (index < 0 || index >= segmentCount(path)) return out;
  const next = (index + 1) % out.length;
  const [p0, p1, p2, p3] = controls(path, index);

  const q0 = lerp(p0, p1, t);
  const q1 = lerp(p1, p2, t);
  const q2 = lerp(p2, p3, t);
  const r0 = lerp(q0, q1, t);
  const r1 = lerp(q1, q2, t);
  const point = lerp(r0, r1, t);

  out[index] = { ...out[index], handleOut: sub(q0, p0) };
  out[next] = { ...out[next], handleIn: sub(q2, p3) };
  const inserted: Anchor = {
    point,
    handleIn: sub(r0, point),
    handleOut: sub(r1, point),
    kind: "corner",
  };
  if (isSmooth(inserted)) inserted.kind = "smooth";
  out.splice(index + 1, 0, inserted);
  return out;
}

export function removeAnchor(
  anchors: readonly Anchor[],
  index: number,
): Anchor[] {
  const out = anchors.slice();
  if (index >= 0 && index < out.length) out.splice(index, 1);
  return out;
}

/** `v` reversed and given `keep`'s length, so smoothing preserves what it can. */
function opposite(v: Point, keep: Point): Point {
  const l = length(v);
  if (l < EPS) return ZERO;
  const want = length(keep);
  return scale(v, -(want < EPS ? l : want) / l);
}

/** The tangent to smooth a handle-less anchor along: the chord past it. */
function chord(anchors: readonly Anchor[], index: number): Point {
  const prev = anchors[index - 1];
  const next = anchors[index + 1];
  const here = anchors[index].point;
  const from = prev ? prev.point : here;
  const to = next ? next.point : here;
  const dir = sub(to, from);
  const l = length(dir);
  if (l < EPS) return ZERO;
  const reach =
    Math.min(
      prev ? length(sub(here, prev.point)) : Infinity,
      next ? length(sub(next.point, here)) : Infinity,
    ) / 3;
  return scale(dir, reach / l);
}

/**
 * `corner` only breaks the constraint — the handles keep their vectors, so
 * smooth → corner → smooth returns the anchor it started from.
 */
export function setAnchorKind(
  anchors: readonly Anchor[],
  index: number,
  kind: AnchorKind,
): Anchor[] {
  const out = anchors.slice();
  const a = out[index];
  if (!a) return out;
  if (kind === "corner") {
    out[index] = { ...a, kind };
    return out;
  }
  if (!isZero(a.handleOut)) {
    out[index] = { ...a, handleIn: opposite(a.handleOut, a.handleIn), kind };
  } else if (!isZero(a.handleIn)) {
    out[index] = { ...a, handleOut: opposite(a.handleIn, a.handleOut), kind };
  } else {
    const t = chord(anchors, index);
    out[index] = { ...a, handleOut: t, handleIn: scale(t, -1), kind };
  }
  return out;
}

/** Move an anchor, carrying its handles with it. */
export function moveAnchor(
  anchors: readonly Anchor[],
  index: number,
  point: Point,
): Anchor[] {
  const out = anchors.slice();
  if (out[index]) out[index] = { ...out[index], point };
  return out;
}

/**
 * Strip an anchor's curves — Figma's ⌘-click. Both handles go, so the two
 * segments meeting here become straight and the anchor is a hard corner.
 */
export function clearHandles(
  anchors: readonly Anchor[],
  index: number,
): Anchor[] {
  const out = anchors.slice();
  const a = out[index];
  if (a) out[index] = { ...a, handleIn: ZERO, handleOut: ZERO, kind: "corner" };
  return out;
}

/**
 * Bend segment `index` so the curve passes through `point` at parameter `t` —
 * the bend tool, which curves a segment without adding an anchor to it.
 *
 * The two endpoints are fixed, so only the control points may move, and
 * `B(t) = … + b1·P1 + b2·P2 + …` is one equation in two unknowns. The
 * least-norm solution splits the correction between them in proportion to their
 * influence at `t`: `ΔP1 = d·b1/(b1²+b2²)`, `ΔP2 = d·b2/(b1²+b2²)`. It is exact
 * — `b1·ΔP1 + b2·ΔP2 = d` — so the curve lands on the pointer every frame
 * rather than creeping towards it, and near an endpoint, where one control
 * point can barely move the curve at all, the other does the work.
 */
export function bendSegment(
  path: Path,
  index: number,
  t: number,
  point: Point,
): Anchor[] {
  if (index < 0 || index >= segmentCount(path)) return path.anchors.slice();
  const u = 1 - t;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const w = b1 * b1 + b2 * b2;
  // At an endpoint the control points have no leverage; there is nothing to
  // solve, and dividing by that leverage would fling the curve off the canvas.
  if (w < EPS) return path.anchors.slice();

  const d = sub(point, cubicAt(controls(path, index), t));
  const next = (index + 1) % path.anchors.length;
  const a = path.anchors[index];
  const b = path.anchors[next];
  const moved = setHandle(
    path.anchors,
    index,
    "out",
    add(a.handleOut, scale(d, b1 / w)),
  );
  return setHandle(moved, next, "in", add(b.handleIn, scale(d, b2 / w)));
}

/** Drag one handle. A smooth anchor's other handle swings to stay opposite. */
export function setHandle(
  anchors: readonly Anchor[],
  index: number,
  side: "in" | "out",
  vector: Point,
): Anchor[] {
  const out = anchors.slice();
  const a = out[index];
  if (!a) return out;
  const smooth = a.kind === "smooth";
  out[index] =
    side === "in"
      ? {
          ...a,
          handleIn: vector,
          handleOut: smooth ? opposite(vector, a.handleOut) : a.handleOut,
        }
      : {
          ...a,
          handleOut: vector,
          handleIn: smooth ? opposite(vector, a.handleIn) : a.handleIn,
        };
  return out;
}
