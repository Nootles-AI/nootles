/**
 * The path model: an SVG `d` string read as anchors, and written back again.
 *
 * Handles are stored **relative to their anchor**, the way Illustrator and
 * Figma store them. Moving an anchor is then one assignment rather than a
 * rewrite of two control points, and "smooth" is a statement about two vectors
 * rather than about three absolute positions.
 *
 * Everything is normalised to cubics on the way in — `L`, `H`, `V`, `Q`, `T`,
 * `S` and `A` are all a `C` with particular handles — so there is one segment
 * type to drag, split and measure, and `d` is written back in exactly one
 * shape.
 *
 * ## Total over SVG, because the models write SVG
 *
 * The parser accepts the WHOLE path grammar: every command, absolute and
 * relative, packed arc flags, implicit repeats, and any number of subpaths.
 * That is not generality for its own sake. `scalePath` runs on every resize of
 * a path node, and it round-trips through here — so a command this file cannot
 * read is a shape silently destroyed the first time someone drags its handle.
 * While the pen tool was the only author that was a closed set of five
 * commands; now that a model can draw, it is all of them.
 *
 * ## Two layers, and only one of them is total
 *
 * {@link parseSubpaths} is the total one: it is what bounds, scaling and
 * serialization use, and it keeps every subpath. {@link parsePath} returns the
 * FIRST subpath alone, because that is the pen tool's model — an editable path
 * is one anchor list, and there is no second cursor to drag. Editing a
 * multi-subpath drawing therefore sees only its first stroke, which is a
 * limit of the pen and not of the document: the other subpaths are still
 * carried, still drawn, and still scaled.
 *
 * Arcs are the one thing that does not survive a round trip verbatim: `A`
 * becomes the cubics that reproduce it (to well under a pixel), because a
 * non-uniform scale turns an elliptical arc into something `A` cannot state
 * without also solving for a new x-axis rotation. Converting once, on the way
 * in, keeps the one-segment-type promise the rest of this file is built on.
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

const NUMBER = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/y;
const COMMAND = /[MmLlHhVvCcSsQqTtAaZz]/;

/**
 * A cursor over `d`.
 *
 * Hand-written rather than a `match(/…/g)` over the whole string because two
 * parts of the grammar are not tokenisable in isolation. An arc's two flags are
 * single digits that may be packed against their neighbours — `a1 1 0 011 1` is
 * a valid way to write `large=0 sweep=1 x=1 y=1`, and a number regex reads
 * `011` as one number and shifts every later argument by one. And `.5.5` is two
 * numbers while `1.5` is one, which only the position of the previous match can
 * tell apart. Both are decided by what the command being read expects next, so
 * the reader has to be the thing holding the position.
 */
class Cursor {
  private i = 0;

  constructor(private readonly d: string) {}

  /** Whitespace and the optional comma between two arguments. */
  private sep(): void {
    while (this.i < this.d.length) {
      const c = this.d[this.i];
      if (c === "," || c === " " || c === "\t" || c === "\n" || c === "\r") {
        this.i++;
      } else break;
    }
  }

  done(): boolean {
    this.sep();
    return this.i >= this.d.length;
  }

  /** The command letter at the cursor, or `""` where an argument stands. */
  command(): string {
    this.sep();
    const c = this.d[this.i];
    if (c && COMMAND.test(c)) {
      this.i++;
      return c;
    }
    return "";
  }

  /** `NaN` when what stands here is not a number — which ends the command. */
  number(): number {
    this.sep();
    NUMBER.lastIndex = this.i;
    const m = NUMBER.exec(this.d);
    if (!m || m.index !== this.i) return NaN;
    this.i = NUMBER.lastIndex;
    return Number(m[0]);
  }

  /**
   * An arc's `large-arc` / `sweep`: exactly one character, so that a flag
   * packed against the argument after it still reads as a flag.
   */
  flag(): number {
    this.sep();
    const c = this.d[this.i];
    if (c === "0" || c === "1") {
      this.i++;
      return c === "1" ? 1 : 0;
    }
    return NaN;
  }
}

/**
 * Anchors that describe a whole subpath: the coincident closing anchor folded
 * away, and the smooth constraint recovered from the handles that survived.
 *
 * Both are properties of the finished list rather than of any one command, so
 * they cannot be decided while it is still being read.
 */
function finishSubpath(anchors: Anchor[], closed: boolean): Path {
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

/**
 * Every subpath in `d`, in order.
 *
 * A malformed tail ends the parse rather than throwing: `d` is streamed into
 * the canvas a chunk at a time while a diagram is being drawn, so a path cut
 * mid-number is the ordinary case and must render as everything that arrived
 * before it.
 */
export function parseSubpaths(d: string): Path[] {
  const cur = new Cursor(d);
  const out: Path[] = [];

  let anchors: Anchor[] = [];
  /** Where the subpath in hand began — where `Z` returns to. */
  let start: Point = ZERO;
  let point: Point = ZERO;
  /** The last cubic's second control, for `S`; the last quadratic's, for `T`. */
  let lastCubic: Point | null = null;
  let lastQuad: Point | null = null;
  let cmd = "";

  const flush = (closed: boolean) => {
    if (anchors.length) out.push(finishSubpath(anchors, closed));
    anchors = [];
  };

  /** `C` in terms of absolute control points — every curve arrives as one. */
  const cubic = (c1: Point, c2: Point, p: Point) => {
    const prev = anchors[anchors.length - 1];
    if (!prev) return;
    prev.handleOut = sub(c1, prev.point);
    anchors.push({ ...corner(p), handleIn: sub(c2, p) });
    point = p;
  };

  const lineTo = (p: Point) => {
    if (!anchors.length) return;
    anchors.push(corner(p));
    point = p;
  };

  for (;;) {
    if (cur.done()) break;
    const letter = cur.command();
    if (letter) {
      cmd = letter;
    } else if (cmd === "M") {
      cmd = "L"; // Extra pairs after a moveto are linetos.
    } else if (cmd === "m") {
      cmd = "l";
    } else if (!cmd) {
      break; // Arguments with no command before them: nothing to do with them.
    }

    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;
    /** A pair, resolved against the current point when the command is relative. */
    const pair = (): Point => {
      const x = cur.number();
      const y = cur.number();
      if (Number.isNaN(x) || Number.isNaN(y)) return { x: NaN, y: NaN };
      return rel ? { x: point.x + x, y: point.y + y } : { x, y };
    };
    const bad = (p: Point) => Number.isNaN(p.x) || Number.isNaN(p.y);

    if (upper === "Z") {
      flush(true);
      // A command after `Z` with no `M` of its own opens a new subpath back at
      // the one just closed started.
      point = start;
      lastCubic = lastQuad = null;
      continue;
    }

    if (upper === "M") {
      const p = pair();
      if (bad(p)) break;
      flush(false);
      start = point = p;
      anchors.push(corner(p));
      lastCubic = lastQuad = null;
      continue;
    }

    // A `d` that opens with a drawing command is malformed, and the spec says
    // to render nothing. It is opened at the origin instead: this parser also
    // reads markup that is still arriving, where a leading `M` may simply not
    // have got here yet, and drawing what did arrive beats drawing nothing.
    if (!anchors.length) {
      anchors.push(corner(point));
      start = point;
    }

    if (upper === "L") {
      const p = pair();
      if (bad(p)) break;
      lineTo(p);
      lastCubic = lastQuad = null;
    } else if (upper === "H" || upper === "V") {
      const n = cur.number();
      if (Number.isNaN(n)) break;
      const along = upper === "H";
      lineTo({
        x: along ? (rel ? point.x + n : n) : point.x,
        y: along ? point.y : rel ? point.y + n : n,
      });
      lastCubic = lastQuad = null;
    } else if (upper === "C" || upper === "S") {
      // `S` states only the second control; the first is the reflection of the
      // previous curve's, which is what makes the join smooth. With no previous
      // curve the spec says it coincides with the current point.
      const c1: Point =
        upper === "C"
          ? pair()
          : lastCubic
            ? sub(scale(point, 2), lastCubic)
            : point;
      const c2 = pair();
      const p = pair();
      if (bad(c1) || bad(c2) || bad(p)) break;
      cubic(c1, c2, p);
      lastCubic = c2;
      lastQuad = null;
    } else if (upper === "Q" || upper === "T") {
      const c: Point =
        upper === "Q" ? pair() : lastQuad ? sub(scale(point, 2), lastQuad) : point;
      const p = pair();
      if (bad(c) || bad(p)) break;
      // A quadratic is the cubic whose handles reach two thirds of the way to
      // the shared control point.
      const from = point;
      cubic(
        add(from, scale(sub(c, from), 2 / 3)),
        add(p, scale(sub(c, p), 2 / 3)),
        p,
      );
      lastQuad = c;
      lastCubic = null;
    } else if (upper === "A") {
      const rx = cur.number();
      const ry = cur.number();
      const rot = cur.number();
      const large = cur.flag();
      const sweep = cur.flag();
      const p = pair();
      if (
        Number.isNaN(rx) ||
        Number.isNaN(ry) ||
        Number.isNaN(rot) ||
        Number.isNaN(large) ||
        Number.isNaN(sweep) ||
        bad(p)
      ) {
        break;
      }
      for (const seg of arcToCubics(point, rx, ry, rot, large, sweep, p)) {
        cubic(seg[0], seg[1], seg[2]);
      }
      lastCubic = lastQuad = null;
    } else break;
  }

  flush(false);
  return out;
}

/**
 * The first subpath alone — the pen tool's model, which is one anchor list.
 *
 * Everything that has to survive a drawing whole goes through
 * {@link parseSubpaths} instead.
 */
export function parsePath(d: string): Path {
  return parseSubpaths(d)[0] ?? { anchors: [], closed: false };
}

/**
 * An elliptical arc as the cubics that reproduce it.
 *
 * Endpoint parameterisation into centre parameterisation, per the SVG
 * implementation notes, then a cubic per quarter turn or less: the error of the
 * standard `k = 4/3·tan(Δ/4)` approximation grows sharply with the swept angle,
 * so capping each segment at 90° holds it to about 2.7·10⁻⁴ of the radius
 * (measured: 0.011px on r=40). Sub-pixel out to a radius of several thousand,
 * which no diagram reaches — and halving the cap to buy another two orders of
 * magnitude would double the length of every `d` that curves.
 */
function arcToCubics(
  from: Point,
  rx: number,
  ry: number,
  rotationDeg: number,
  large: number,
  sweep: number,
  to: Point,
): Array<[Point, Point, Point]> {
  // A zero radius is a straight line by definition, and an arc that ends where
  // it began encloses nothing — both say "no curve here" rather than "error".
  if (rx === 0 || ry === 0) return [[from, to, to]];
  if (Math.abs(from.x - to.x) < EPS && Math.abs(from.y - to.y) < EPS) return [];

  let irx = Math.abs(rx);
  let iry = Math.abs(ry);
  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const x1 = cosPhi * dx + sinPhi * dy;
  const y1 = -sinPhi * dx + cosPhi * dy;

  // Radii too small to join the endpoints are scaled up until they just can —
  // the spec's correction, and the reason a hand-written arc never fails to
  // draw.
  const lambda = (x1 * x1) / (irx * irx) + (y1 * y1) / (iry * iry);
  if (lambda > 1) {
    const k = Math.sqrt(lambda);
    irx *= k;
    iry *= k;
  }

  const rxs = irx * irx;
  const rys = iry * iry;
  const num = rxs * rys - rxs * y1 * y1 - rys * x1 * x1;
  const den = rxs * y1 * y1 + rys * x1 * x1;
  const factor =
    (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / (den || EPS)));
  const cx1 = (factor * irx * y1) / iry;
  const cy1 = (-factor * iry * x1) / irx;

  const cx = cosPhi * cx1 - sinPhi * cy1 + (from.x + to.x) / 2;
  const cy = sinPhi * cx1 + cosPhi * cy1 + (from.y + to.y) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const a = Math.acos(clamp(dot / (len || EPS), -1, 1));
    return ux * vy - uy * vx < 0 ? -a : a;
  };

  const ux = (x1 - cx1) / irx;
  const uy = (y1 - cy1) / iry;
  const vx = (-x1 - cx1) / irx;
  const vy = (-y1 - cy1) / iry;
  const theta = angle(1, 0, ux, uy);
  let delta = angle(ux, uy, vx, vy);
  if (sweep === 0 && delta > 0) delta -= 2 * Math.PI;
  if (sweep === 1 && delta < 0) delta += 2 * Math.PI;

  const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / steps;
  const k = (4 / 3) * Math.tan(step / 4);

  /** A point on the ellipse, and the tangent to travel it by, at `t` radians. */
  const on = (t: number): { p: Point; d: Point } => {
    const cosT = Math.cos(t);
    const sinT = Math.sin(t);
    return {
      p: {
        x: cx + irx * cosPhi * cosT - iry * sinPhi * sinT,
        y: cy + irx * sinPhi * cosT + iry * cosPhi * sinT,
      },
      d: {
        x: -irx * cosPhi * sinT - iry * sinPhi * cosT,
        y: -irx * sinPhi * sinT + iry * cosPhi * cosT,
      },
    };
  };

  const out: Array<[Point, Point, Point]> = [];
  for (let i = 0; i < steps; i++) {
    const a = on(theta + step * i);
    const b = on(theta + step * (i + 1));
    out.push([
      add(a.p, scale(a.d, k)),
      sub(b.p, scale(b.d, k)),
      b.p,
    ]);
  }
  return out;
}

const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

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

/** Every subpath, in order. Each opens with its own `M`, so a space joins them. */
export function serializeSubpaths(paths: readonly Path[]): string {
  return paths
    .map((p) => serializePath(p.anchors, p.closed))
    .filter(Boolean)
    .join(" ");
}

/**
 * Rewrite every coordinate in `d` through one affine map of the plane.
 *
 * The whole path goes through {@link parseSubpaths}, not {@link parsePath}: a
 * drawing is many subpaths, and a transform that kept only the first would
 * delete the rest of it on the first resize.
 *
 * `point` is mapped as a position and the handles as vectors — they are offsets
 * from their anchor, so they take the linear part and not the translation. A
 * smooth anchor stays smooth under any linear map, which keeps two opposite
 * vectors opposite.
 */
function mapPath(
  d: string,
  point: (p: Point) => Point,
  vector: (p: Point) => Point,
): string {
  return serializeSubpaths(
    parseSubpaths(d).map((path) => ({
      ...path,
      anchors: path.anchors.map((a) => ({
        ...a,
        point: point(a.point),
        handleIn: vector(a.handleIn),
        handleOut: vector(a.handleOut),
      })),
    })),
  );
}

/**
 * Scale a `d` about its own origin.
 *
 * `d` is local to the node's box, so a box that changed size must carry its
 * geometry with it — a path left in the coordinates of a box it no longer has
 * is drawn against the wrong frame.
 *
 * An axis with no extent has no scale — there is nothing to stretch, and the
 * ratio would be infinite.
 */
export function scalePath(d: string, sx: number, sy: number): string {
  if (!d || (sx === 1 && sy === 1)) return d;
  const map = (p: Point): Point => ({ x: p.x * sx, y: p.y * sy });
  return mapPath(d, map, map);
}

/**
 * Move a `d` within its own coordinate space.
 *
 * What re-origins an authored path onto its box: a translation moves the
 * anchors and leaves the handles alone, since an offset from an anchor is the
 * same offset wherever that anchor has moved to.
 */
export function translatePath(d: string, dx: number, dy: number): string {
  if (!d || (dx === 0 && dy === 0)) return d;
  return mapPath(d, (p) => ({ x: p.x + dx, y: p.y + dy }), (p) => p);
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
 * The tight box around a whole `d`, subpaths included, or `null` when it draws
 * nothing at all.
 *
 * What tightens an authored path onto its box. `null` rather than a zero rect
 * because "this path has no extent" and "this path is a dot at the origin" are
 * different answers, and only one of them is a reason to leave the node's box
 * exactly as the author wrote it.
 */
export function pathDataBounds(d: string): Rect | null {
  return subpathsBounds(parseSubpaths(d));
}

/**
 * The same, over subpaths already in hand — what the pen tool re-frames by, so
 * that a drawing's other strokes are counted in the box even though it is only
 * editing the first.
 */
export function subpathsBounds(paths: readonly Path[]): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const path of paths) {
    if (!path.anchors.length) continue;
    const b = pathBounds(path);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  if (!Number.isFinite(x0)) return null;
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
