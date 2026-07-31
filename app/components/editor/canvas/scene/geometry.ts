/**
 * Scene geometry — the maths the canvas's feel rests on.
 *
 * Pure functions over the {@link SceneNode} model: no React, no DOM, no state,
 * no imports beyond the model itself. Everything here runs inside a pointer
 * gesture, so it allocates as little as it can and never walks the tree more
 * than once per call.
 *
 * ## Spaces
 *
 * Three coordinate spaces, and every function says which it is in:
 *
 *  - **local** — relative to a node's own unrotated box, origin at its
 *    top-left. A path's `d` and a group's children live here.
 *  - **parent** — the space a node's `x`/`y` are expressed in: its group's
 *    local space, or the scene for a top-level node.
 *  - **scene** — the canvas document's space, i.e. `<ab-diagram>`'s box.
 *
 * A node's transform is *rigid*: rotate by `rot` about the box centre, then
 * translate. There is no scaling, so a box always maps to a congruent rotated
 * box — which is why {@link absoluteRect} can return a plain `Rect` plus
 * {@link absoluteRotation} and lose nothing.
 *
 * Angles are **degrees, clockwise**, matching `rot` and CSS `rotate()` in a
 * y-down coordinate system.
 */

import {
  type NodeId,
  type Point,
  type Rect,
  type Scene,
  type SceneLike,
  type SceneNode,
  isContainer,
  nodePath,
} from "./types";

const RAD = Math.PI / 180;

/** Anything with a box and a rotation — every `SceneNode` satisfies it. */
export type RotatedRect = Rect & { rot: number };

const EMPTY_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };

function rootNodes(scene: SceneLike): readonly SceneNode[] {
  return Array.isArray(scene) ? scene : (scene as Scene).nodes;
}

// ---------------------------------------------------------------------------
// Rect primitives
// ---------------------------------------------------------------------------

export function rectCentre(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/** Inclusive of the edges. */
export function rectContainsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  );
}

/** Touching counts as intersecting, which is what a marquee should do. */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.w &&
    b.x <= a.x + a.w &&
    a.y <= b.y + b.h &&
    b.y <= a.y + a.h
  );
}

/** The box spanned by two points, in either order — a marquee drag. */
export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

// ---------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------

/** Folds any angle into `[0, 360)`. */
export function normalizeAngle(deg: number): number {
  const a = deg % 360;
  return a < 0 ? a + 360 : a;
}

/** Rotates `point` clockwise about `centre`. */
export function rotateAround(point: Point, centre: Point, deg: number): Point {
  if (deg === 0) return { x: point.x, y: point.y };
  const r = deg * RAD;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  return {
    x: centre.x + dx * cos - dy * sin,
    y: centre.y + dx * sin + dy * cos,
  };
}

/**
 * The clockwise angle of the vector `centre → point`, in `[0, 360)`, with 0
 * pointing right (+x) and 90 pointing down (+y) — the same convention as `rot`.
 */
export function angleOf(centre: Point, point: Point): number {
  return normalizeAngle(
    Math.atan2(point.y - centre.y, point.x - centre.x) / RAD,
  );
}

/** Rounds to the nearest multiple of `step` (default 15°, Figma's shift-rotate). */
export function snapAngle(deg: number, step = 15): number {
  if (step <= 0) return deg;
  return Math.round(deg / step) * step;
}

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

/** Screen/viewport px → scene px. */
export function viewportToScene(
  point: Point,
  viewport: { x: number; y: number; zoom: number },
): Point {
  return {
    x: (point.x - viewport.x) / viewport.zoom,
    y: (point.y - viewport.y) / viewport.zoom,
  };
}

/** Scene px → screen/viewport px. */
export function sceneToViewport(
  point: Point,
  viewport: { x: number; y: number; zoom: number },
): Point {
  return {
    x: point.x * viewport.zoom + viewport.x,
    y: point.y * viewport.zoom + viewport.y,
  };
}

// ---------------------------------------------------------------------------
// A node's own box
// ---------------------------------------------------------------------------

/**
 * The four corners of a node's box in its **parent** space, after rotation,
 * ordered `[nw, ne, se, sw]` of the unrotated box — so index 0 stays the
 * "top-left" corner however far the node is spun.
 */
export function nodeCorners(
  node: RotatedRect,
): [Point, Point, Point, Point] {
  const { x, y, w, h, rot } = node;
  if (rot === 0) {
    return [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ];
  }
  const r = rot * RAD;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const hw = w / 2;
  const hh = h / 2;
  const corner = (ox: number, oy: number): Point => ({
    x: cx + ox * cos - oy * sin,
    y: cy + ox * sin + oy * cos,
  });
  return [
    corner(-hw, -hh),
    corner(hw, -hh),
    corner(hw, hh),
    corner(-hw, hh),
  ];
}

/**
 * The axis-aligned bounding box of a (possibly rotated) node, in its **parent**
 * space. Closed form rather than a corner scan — this is called per frame for
 * every selected node.
 */
export function nodeBounds(node: RotatedRect): Rect {
  const { x, y, w, h, rot } = node;
  if (rot === 0) return { x, y, w, h };
  const r = rot * RAD;
  const cos = Math.abs(Math.cos(r));
  const sin = Math.abs(Math.sin(r));
  const bw = w * cos + h * sin;
  const bh = w * sin + h * cos;
  return {
    x: x + w / 2 - bw / 2,
    y: y + h / 2 - bh / 2,
    w: bw,
    h: bh,
  };
}

/**
 * The union of {@link nodeBounds} over nodes **sharing one coordinate space**
 * (siblings). Use {@link absoluteSelectionBounds} for nodes drawn from
 * different groups. An empty list gives a zero rect at the origin.
 */
export function unionBounds(nodes: readonly RotatedRect[]): Rect {
  if (nodes.length === 0) return { ...EMPTY_RECT };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const node of nodes) {
    const b = nodeBounds(node);
    if (b.x < x0) x0 = b.x;
    if (b.y < y0) y0 = b.y;
    if (b.x + b.w > x1) x1 = b.x + b.w;
    if (b.y + b.h > y1) y1 = b.y + b.h;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The box the selection overlay draws, in the nodes' shared space.
 *
 * A single node returns its own **unrotated** box: the overlay carries the
 * node's `rot`, so it hugs a rotated shape instead of ballooning to its
 * bounding box — which is both what Figma does and what makes the rotate and
 * resize handles land on the shape's real corners. Two or more nodes return the
 * axis-aligned union, because the selection as a whole has no rotation.
 */
export function selectionBounds(nodes: readonly RotatedRect[]): Rect {
  if (nodes.length === 1) {
    const n = nodes[0];
    return { x: n.x, y: n.y, w: n.w, h: n.h };
  }
  return unionBounds(nodes);
}

// ---------------------------------------------------------------------------
// Local ⇄ parent
// ---------------------------------------------------------------------------

/**
 * A point in a node's **parent** space → the node's **local** space (origin at
 * the box's top-left, axes unrotated). This is the transform that makes a
 * rotated shape hit-test, and a group's children resolve, correctly.
 */
export function toLocal(point: Point, node: RotatedRect): Point {
  const cx = node.x + node.w / 2;
  const cy = node.y + node.h / 2;
  let dx = point.x - cx;
  let dy = point.y - cy;
  if (node.rot !== 0) {
    const r = -node.rot * RAD;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const rx = dx * cos - dy * sin;
    dy = dx * sin + dy * cos;
    dx = rx;
  }
  return { x: dx + node.w / 2, y: dy + node.h / 2 };
}

/** The inverse of {@link toLocal}: a node's **local** space → its **parent** space. */
export function toWorld(point: Point, node: RotatedRect): Point {
  let dx = point.x - node.w / 2;
  let dy = point.y - node.h / 2;
  if (node.rot !== 0) {
    const r = node.rot * RAD;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const rx = dx * cos - dy * sin;
    dy = dx * sin + dy * cos;
    dx = rx;
  }
  return { x: node.x + node.w / 2 + dx, y: node.y + node.h / 2 + dy };
}

// ---------------------------------------------------------------------------
// Local ⇄ scene, through group ancestry
// ---------------------------------------------------------------------------

/**
 * A rigid transform `p → R(rot)·p + (tx, ty)`, mapping a node's local space to
 * some ancestor's. `cos`/`sin` are carried so composing a chain costs no trig.
 */
interface Xform {
  cos: number;
  sin: number;
  rot: number;
  tx: number;
  ty: number;
}

const IDENTITY: Xform = { cos: 1, sin: 0, rot: 0, tx: 0, ty: 0 };

/** The node's local space → its parent's local space. */
function localXform(node: RotatedRect): Xform {
  const r = node.rot * RAD;
  const cos = node.rot === 0 ? 1 : Math.cos(r);
  const sin = node.rot === 0 ? 0 : Math.sin(r);
  const hw = node.w / 2;
  const hh = node.h / 2;
  return {
    cos,
    sin,
    rot: node.rot,
    tx: node.x + hw - cos * hw + sin * hh,
    ty: node.y + hh - sin * hw - cos * hh,
  };
}

function compose(outer: Xform, inner: Xform): Xform {
  return {
    cos: outer.cos * inner.cos - outer.sin * inner.sin,
    sin: outer.sin * inner.cos + outer.cos * inner.sin,
    rot: outer.rot + inner.rot,
    tx: outer.cos * inner.tx - outer.sin * inner.ty + outer.tx,
    ty: outer.sin * inner.tx + outer.cos * inner.ty + outer.ty,
  };
}

function applyX(x: Xform, px: number, py: number): Point {
  return {
    x: x.cos * px - x.sin * py + x.tx,
    y: x.sin * px + x.cos * py + x.ty,
  };
}

function chainTo(scene: SceneLike, id: NodeId): { x: Xform; node: SceneNode } | null {
  const path = nodePath(scene, id);
  if (path.length === 0) return null;
  let x = IDENTITY;
  for (const n of path) x = compose(x, localXform(n));
  return { x, node: path[path.length - 1] };
}

/**
 * A node's box in **scene** space: same `w`/`h`, positioned so that rotating it
 * by {@link absoluteRotation} about its centre reproduces the node exactly.
 * Group offsets *and* group rotations are composed on the way down.
 *
 * A zero rect for an id that is not in the scene — a stale selection outliving
 * a delete or an undo is routine, and this is read during a gesture.
 */
export function absoluteRect(scene: SceneLike, id: NodeId): Rect {
  const chain = chainTo(scene, id);
  if (!chain) return { ...EMPTY_RECT };
  const { node } = chain;
  const c = applyX(chain.x, node.w / 2, node.h / 2);
  return { x: c.x - node.w / 2, y: c.y - node.h / 2, w: node.w, h: node.h };
}

/** A node's rotation in **scene** space: its own plus every ancestor group's. */
export function absoluteRotation(scene: SceneLike, id: NodeId): number {
  let rot = 0;
  for (const n of nodePath(scene, id)) rot += n.rot;
  return rot;
}

/** The axis-aligned bounding box of a node in **scene** space. */
export function absoluteBounds(scene: SceneLike, id: NodeId): Rect {
  const chain = chainTo(scene, id);
  if (!chain) return { ...EMPTY_RECT };
  const { node } = chain;
  const c = applyX(chain.x, node.w / 2, node.h / 2);
  return nodeBounds({
    x: c.x - node.w / 2,
    y: c.y - node.h / 2,
    w: node.w,
    h: node.h,
    rot: chain.x.rot,
  });
}

/**
 * The axis-aligned box enclosing a selection in **scene** space, whatever
 * groups its members live in. Ids absent from the scene are skipped; an empty
 * result is a zero rect.
 */
export function absoluteSelectionBounds(
  scene: SceneLike,
  ids: readonly NodeId[],
): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let any = false;
  for (const id of ids) {
    const chain = chainTo(scene, id);
    if (!chain) continue;
    any = true;
    const { node } = chain;
    const c = applyX(chain.x, node.w / 2, node.h / 2);
    const b = nodeBounds({
      x: c.x - node.w / 2,
      y: c.y - node.h / 2,
      w: node.w,
      h: node.h,
      rot: chain.x.rot,
    });
    if (b.x < x0) x0 = b.x;
    if (b.y < y0) y0 = b.y;
    if (b.x + b.w > x1) x1 = b.x + b.w;
    if (b.y + b.h > y1) y1 = b.y + b.h;
  }
  return any ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { ...EMPTY_RECT };
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

export interface HitTestOptions {
  /** Return the deepest node rather than the outermost group — double-click. */
  deep?: boolean;
  /** Scene-px slop around a shape, for thin paths and hairline strokes. */
  tolerance?: number;
  /** Locked nodes are click-through by default, as in Figma. */
  includeLocked?: boolean;
}

const PAINT_PROPS = ["background", "background-color", "background-image"];

/**
 * A regular N-gon's vertices, normalised to 0…1 on each axis so that it fills
 * its box. The single definition of an `<ab-polygon>`'s form: `render/svgShape`
 * paints from it and {@link hitsShape} tests against it, so what you see and
 * what you can grab cannot drift apart.
 *
 * Inscribing the N-gon in the box would leave a triangle floating above its own
 * bounding box's floor; normalising per axis is what makes a four-sided one land
 * on exactly the box's edge mid-points — the classic diamond. That
 * normalisation is affine, so one set of unit points is right at every size.
 *
 * Memoised, because a hit test runs on every pointer move and a document holds
 * only ever a handful of side counts.
 */
const POLYGONS = new Map<number, readonly Point[]>();

export function unitPolygon(sides: number): readonly Point[] {
  const n = Math.max(3, Math.round(sides));
  const cached = POLYGONS.get(n);
  if (cached) return cached;

  const raw: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI - Math.PI / 2;
    raw.push({ x: Math.cos(a), y: Math.sin(a) });
  }
  const span = (of: (p: Point) => number) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of raw) {
      const v = of(p);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return { lo, size: hi - lo || 1 };
  };
  const x = span((p) => p.x);
  const y = span((p) => p.y);
  const unit = raw.map((p) => ({
    x: (p.x - x.lo) / x.size,
    y: (p.y - y.lo) / y.size,
  }));
  POLYGONS.set(n, unit);
  return unit;
}

/** Distance from `p` to the segment `a → b`. */
function segmentDistance(
  p: Point,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t =
    len === 0
      ? 0
      : Math.min(1, Math.max(0, ((p.x - ax) * dx + (p.y - ay) * dy) / len));
  return Math.hypot(ax + t * dx - p.x, ay + t * dy - p.y);
}

/** Ray casting, widened by `tol` so a hairline edge is still grabbable. */
function hitsPolygon(
  unit: readonly Point[],
  w: number,
  h: number,
  point: Point,
  tol: number,
): boolean {
  let inside = false;
  let near = Infinity;
  for (let i = 0, j = unit.length - 1; i < unit.length; j = i++) {
    const ax = unit[i].x * w;
    const ay = unit[i].y * h;
    const bx = unit[j].x * w;
    const by = unit[j].y * h;
    if (
      ay > point.y !== by > point.y &&
      point.x < ((bx - ax) * (point.y - ay)) / (by - ay) + ax
    ) {
      inside = !inside;
    }
    if (tol > 0) near = Math.min(near, segmentDistance(point, ax, ay, bx, by));
  }
  return inside || near <= tol;
}

/**
 * Whether a group's own box should catch a click. A plain group is a bag of
 * children and its empty space is click-through; an auto-layout container with
 * a fill behaves like a frame, and clicking its padding must select it.
 */
function isFilled(node: SceneNode): boolean {
  for (const prop of PAINT_PROPS) {
    const v = node.style[prop];
    if (v !== undefined && v !== "" && v !== "none" && v !== "transparent") {
      return true;
    }
  }
  return false;
}

/**
 * `point` is already in `node`'s local space.
 *
 * A kind whose form is not its box is tested against that form, not against the
 * box: half of a triangle's box is empty canvas, and a press there catching the
 * shape is what makes grabbing the selection frame's edge drag the triangle
 * instead of resizing it.
 */
function hitsShape(node: SceneNode, point: Point, tol: number): boolean {
  if (node.kind === "polygon") {
    return hitsPolygon(unitPolygon(node.sides), node.w, node.h, point, tol);
  }
  if (node.kind === "ellipse") {
    const rx = node.w / 2 + tol;
    const ry = node.h / 2 + tol;
    if (rx <= 0 || ry <= 0) return false;
    const dx = (point.x - node.w / 2) / rx;
    const dy = (point.y - node.h / 2) / ry;
    return dx * dx + dy * dy <= 1;
  }
  return (
    point.x >= -tol &&
    point.x <= node.w + tol &&
    point.y >= -tol &&
    point.y <= node.h + tol
  );
}

function hitChain(
  list: readonly SceneNode[],
  point: Point,
  opts: HitTestOptions,
  tol: number,
  out: SceneNode[],
): boolean {
  for (let i = list.length - 1; i >= 0; i--) {
    const node = list[i];
    if (node.hidden) continue;
    if (node.locked && !opts.includeLocked) continue;
    const local = toLocal(point, node);
    if (isContainer(node)) {
      out.push(node);
      if (hitChain(node.children, local, opts, tol, out)) return true;
      if (hitsShape(node, local, tol) && isFilled(node)) return true;
      out.pop();
      continue;
    }
    if (hitsShape(node, local, tol)) {
      out.push(node);
      return true;
    }
  }
  return false;
}

/**
 * The ancestor chain of the topmost node under a scene-space point, outermost
 * first and including the leaf. Empty when nothing is hit.
 *
 * This is the full answer; {@link hitTest} picks an end off it. The gesture
 * layer wants the chain when a group has been entered, so it can select the
 * chain's child of that group rather than the outermost or the deepest.
 */
export function hitTestPath(
  scene: SceneLike,
  point: Point,
  opts: HitTestOptions = {},
): SceneNode[] {
  const out: SceneNode[] = [];
  const tol = opts.tolerance ?? 0;
  return hitChain(rootNodes(scene), point, opts, tol, out) ? out : [];
}

/**
 * The node a click at `point` (scene space) selects: the outermost group by
 * default, the leaf under `opts.deep` — double-click-to-enter. Hidden nodes are
 * never hit; locked nodes are click-through unless `opts.includeLocked`.
 */
export function hitTest(
  scene: SceneLike,
  point: Point,
  opts: HitTestOptions = {},
): SceneNode | null {
  const path = hitTestPath(scene, point, opts);
  if (path.length === 0) return null;
  return opts.deep ? path[path.length - 1] : path[0];
}

/** Separating-axis test between a convex quad and an axis-aligned rect. */
function quadIntersectsRect(quad: readonly Point[], rect: Rect): boolean {
  const rx1 = rect.x;
  const rx2 = rect.x + rect.w;
  const ry1 = rect.y;
  const ry2 = rect.y + rect.h;

  let min = Infinity;
  let max = -Infinity;
  for (const p of quad) {
    if (p.x < min) min = p.x;
    if (p.x > max) max = p.x;
  }
  if (max < rx1 || min > rx2) return false;

  min = Infinity;
  max = -Infinity;
  for (const p of quad) {
    if (p.y < min) min = p.y;
    if (p.y > max) max = p.y;
  }
  if (max < ry1 || min > ry2) return false;

  const corners: Point[] = [
    { x: rx1, y: ry1 },
    { x: rx2, y: ry1 },
    { x: rx2, y: ry2 },
    { x: rx1, y: ry2 },
  ];
  const axes: Point[] = [
    { x: quad[1].x - quad[0].x, y: quad[1].y - quad[0].y },
    { x: quad[3].x - quad[0].x, y: quad[3].y - quad[0].y },
  ];
  for (const a of axes) {
    let qmin = Infinity;
    let qmax = -Infinity;
    for (const p of quad) {
      const d = p.x * a.x + p.y * a.y;
      if (d < qmin) qmin = d;
      if (d > qmax) qmax = d;
    }
    let cmin = Infinity;
    let cmax = -Infinity;
    for (const p of corners) {
      const d = p.x * a.x + p.y * a.y;
      if (d < cmin) cmin = d;
      if (d > cmax) cmax = d;
    }
    if (qmax < cmin || qmin > cmax) return false;
  }
  return true;
}

function quadOf(node: SceneNode, x: Xform): Point[] {
  return [
    applyX(x, 0, 0),
    applyX(x, node.w, 0),
    applyX(x, node.w, node.h),
    applyX(x, 0, node.h),
  ];
}

function marqueeHits(node: SceneNode, parent: Xform, rect: Rect): boolean {
  const x = compose(parent, localXform(node));
  if (isContainer(node)) {
    for (const child of node.children) {
      if (child.hidden) continue;
      if (marqueeHits(child, x, rect)) return true;
    }
    return isFilled(node) && quadIntersectsRect(quadOf(node, x), rect);
  }
  return quadIntersectsRect(quadOf(node, x), rect);
}

/**
 * Marquee selection: every top-level node whose geometry **intersects** the
 * rect, not only those it fully contains — Figma's rule, and the one that lets
 * you rubber-band a row of shapes without enclosing all of them.
 *
 * Rotation-aware (each node is tested as its rotated quad) and group-aware (a
 * group is caught when any of its descendants is). Returns document order, so
 * the result can go straight into a {@link Selection}.
 */
export function hitTestRect(scene: SceneLike, rect: Rect): SceneNode[] {
  const out: SceneNode[] = [];
  for (const node of rootNodes(scene)) {
    if (node.hidden || node.locked) continue;
    if (marqueeHits(node, IDENTITY, rect)) out.push(node);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** Clockwise from the top-left, which is the order the overlay renders them. */
export const HANDLES = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
] as const satisfies readonly Handle[];

/** Which edges a handle drives: -1 = left/top, +1 = right/bottom, 0 = neither. */
const HANDLE_EDGES: Record<Handle, { hx: number; hy: number }> = {
  nw: { hx: -1, hy: -1 },
  n: { hx: 0, hy: -1 },
  ne: { hx: 1, hy: -1 },
  e: { hx: 1, hy: 0 },
  se: { hx: 1, hy: 1 },
  s: { hx: 0, hy: 1 },
  sw: { hx: -1, hy: 1 },
  w: { hx: -1, hy: 0 },
};

export interface ResizeOptions {
  /** The node's rotation in the space `start` and `delta` are expressed in. */
  rot?: number;
  /** Lock the start aspect ratio — shift-drag. */
  aspect?: boolean;
  /** Grow about the centre instead of the opposite corner — alt-drag. */
  fromCentre?: boolean;
}

/**
 * The new box for a handle drag, given the pointer's total `delta` from the
 * gesture start. `start`, `delta` and the result are all in the node's parent
 * space; `opts.rot` is the node's rotation there.
 *
 * The whole point of this function is the rotated case. A rotated node resizes
 * along **its own** axes, not the screen's: dragging `se` on a node spun 30°
 * moves the pointer's displacement projected onto the node's local axes, and
 * the `nw` corner must stay exactly where it was. Because changing `w`/`h`
 * moves the box centre — which is what `rot` spins about — the returned `x`/`y`
 * are solved backwards from the pinned anchor rather than edited in place.
 *
 * Dragging a handle past the opposite edge mirrors the box across the anchor
 * (`w`/`h` stay non-negative). No minimum size is imposed; clamping is the
 * gesture layer's policy, not geometry's.
 */
export function resizeRect(
  start: Rect,
  handle: Handle,
  delta: Point,
  opts: ResizeOptions = {},
): Rect {
  const rot = opts.rot ?? 0;
  const { hx, hy } = HANDLE_EDGES[handle];

  // The drag, expressed along the node's own axes.
  let dx = delta.x;
  let dy = delta.y;
  if (rot !== 0) {
    const r = -rot * RAD;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    const rx = dx * cos - dy * sin;
    dy = dx * sin + dy * cos;
    dx = rx;
  }

  const sw = start.w;
  const sh = start.h;
  const scale = opts.fromCentre ? 2 : 1;

  let nw = hx === 0 ? sw : sw + hx * dx * scale;
  let nh = hy === 0 ? sh : sh + hy * dy * scale;

  if (opts.aspect && sw !== 0 && sh !== 0) {
    const ratio = sw / sh;
    if (hx !== 0 && hy !== 0) {
      // Corner: whichever axis moved further, relatively, drives the other.
      if (Math.abs(nw) / sw >= Math.abs(nh) / sh) nh = nw / ratio;
      else nw = nh * ratio;
    } else if (hx !== 0) {
      nh = nw / ratio;
    } else {
      nw = nh * ratio;
    }
  }

  // The pinned point, as a fraction of the start box. `fromCentre` pins the
  // centre; otherwise it is the corner or edge opposite the handle.
  const ax = opts.fromCentre ? 0.5 : hx === 0 ? 0.5 : hx > 0 ? 0 : 1;
  const ay = opts.fromCentre ? 0.5 : hy === 0 ? 0.5 : hy > 0 ? 0 : 1;
  const anchorX = ax * sw;
  const anchorY = ay * sh;

  // The new box in the start box's local frame, laid out around the anchor —
  // which keeps the anchor's local coordinate invariant even when it mirrors.
  const x0 = anchorX - ax * nw;
  const y0 = anchorY - ay * nh;
  const lx = Math.min(x0, x0 + nw);
  const ly = Math.min(y0, y0 + nh);
  const lw = Math.abs(nw);
  const lh = Math.abs(nh);

  // Solve the new centre from the anchor, which must not move.
  const cos = rot === 0 ? 1 : Math.cos(rot * RAD);
  const sin = rot === 0 ? 0 : Math.sin(rot * RAD);
  const rotate = (px: number, py: number): Point => ({
    x: px * cos - py * sin,
    y: px * sin + py * cos,
  });

  const startCentre = { x: start.x + sw / 2, y: start.y + sh / 2 };
  const fromStart = rotate(anchorX - sw / 2, anchorY - sh / 2);
  const anchorScene = {
    x: startCentre.x + fromStart.x,
    y: startCentre.y + fromStart.y,
  };

  const fromNew = rotate(anchorX - (lx + lw / 2), anchorY - (ly + lh / 2));
  return {
    x: anchorScene.x - fromNew.x - lw / 2,
    y: anchorScene.y - fromNew.y - lh / 2,
    w: lw,
    h: lh,
  };
}
