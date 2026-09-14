/**
 * Painted-geometry picking — what paint is under a scene point.
 *
 * The old `hitChain` (deleted from `scene/geometry.ts`) answered a box
 * question: is the point inside this node's rectangle (or, for a polygon and
 * an ellipse, its parametric form)? That is not what a click means on this
 * canvas. A rectangle with only a border draws nothing in its interior, and a
 * click there should fall through to whatever is behind it — the reported bug
 * this service exists to fix (F1 in `scene/picking.test.ts`). So every test
 * below asks the harder question `paintedAt` (§2.1) answers once: front to
 * back, in document order, is there a stroke, a fill, or hit-by-box content
 * (text, an image, a labelled shape) actually painted at this point? Hover,
 * click, the context menu, the layer menu and the eyedropper all resolve
 * against the same {@link Candidate} list produced here, so a stroke thin
 * enough to need `tolerance` to grab is exactly as grabbable from every one of
 * them (§9 — every pointer-anchored caller shares {@link slopFor}, not five
 * independently hand-rolled `HIT_SLOP_PX / zoom`s that can drift apart).
 *
 * Pure TypeScript: no DOM, no Canvas2D, no `Path2D`. Every kind's geometry is
 * expressed in scene px and tested with closed-form maths (rect, plain
 * ellipse, a group's own box) or against a flattened polyline (polygon, an
 * ellipse cut to an arc, a pen path, a boolean group's derived or stand-in
 * drawing) — see §4. `scene` is whatever the caller already hit-tests today:
 * the **laid** scene (`laidOutScene(model)`), never laid out here.
 *
 * The paint policy itself — is a fill visible, where do the box's rings sit,
 * how wide does an SVG kind's stroke paint — is `scene/paint.ts`'s job
 * (`fillVisible`, `edgeBands`, `drawnStrokeWidth`); this module owns only the
 * geometry those answers get tested against.
 */

import {
  IDENTITY,
  applyX,
  compose,
  localXform,
  quadIntersectsRect,
  segmentDistance,
  toLocal,
  type Xform,
} from "./geometry";
import { cornerRadius, flattenPath, outlineOf, type Polyline } from "./outline";
import { clipperReady, derivedPath, operandsPath } from "./boolean";
import { drawnStrokeWidth, edgeBands, fillVisible } from "./paint";
import { labelText } from "./label";
import {
  isBoolean,
  isArc,
  type Point,
  type Rect,
  type Scene,
  type SceneLike,
  type SceneNode,
  type StyleMap,
} from "./types";

function rootNodes(scene: SceneLike): readonly SceneNode[] {
  return Array.isArray(scene) ? scene : (scene as Scene).nodes;
}

// ---------------------------------------------------------------------------
// Tolerance — one shared computation (§2.1, review issue #4)
// ---------------------------------------------------------------------------

/** Screen-pixel grab slop for strokes. Callers divide by zoom — via {@link slopFor}. */
export const HIT_SLOP_PX = 4;

/**
 * Scene-px tolerance for a pointer-anchored hit test at this zoom. Every
 * caller that resolves a screen point — click, hover, context menu, and
 * later the layer menu and eyedropper — MUST use this, not its own
 * `HIT_SLOP_PX / zoom`, so a thin stroke that a left-click selects is never
 * missed by a right-click or a menu built from {@link hitTestAll} at the same
 * pixel. One computation, not several hand-written call sites that can drift.
 */
export const slopFor = (zoom: number): number => HIT_SLOP_PX / zoom;

// ---------------------------------------------------------------------------
// Public contract (§2.1)
// ---------------------------------------------------------------------------

export type HitPart =
  | "fill" // interior paint: a visible background layer, an SVG fill, a boolean's derived fill
  | "stroke" // a border/outline ring (box kinds) or a stroke band (drawn kinds)
  | "content"; // painted content that hits by its box: text kind, image kind, a non-empty label on a shape

export interface Candidate {
  /** The node under the point — an element of the laid scene the caller passed. */
  node: SceneNode;
  /** Ancestors outermost-first, ending with `node`. Same shape as `nodePath()`. */
  chain: SceneNode[];
  /** What was hit: the first match in the order stroke, fill, content. */
  part: HitPart;
  /** The point in `node`'s local (unrotated, top-left origin) space. For the eyedropper's gradient sampling. */
  local: Point;
}

export interface HitTestOptions {
  /** `hitTest` only: return the leaf rather than the outermost of the top candidate's chain. */
  deep?: boolean;
  /** Scene px. Widens stroke bands only (§4.6). Default 0. */
  tolerance?: number;
  /** Locked nodes (and their subtrees) are skipped unless set. Default false. */
  includeLocked?: boolean;
  /** Stop after this many candidates. `hitTestPath` passes 1. Default ∞. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// §4.1 — rounded box containment
// ---------------------------------------------------------------------------

/**
 * Whether `p` (in the box's local space) is inside the box `[0,w]×[0,h]`
 * expanded by `grow` on every side (negative = inset), with corner radius
 * `max(0, r + grow)`. Closed form: a false floor for a degenerate expanded
 * box, then a fast reject on the plain rect, then the two non-corner bands,
 * then a distance check against the nearest corner's circle.
 */
function insideRounded(p: Point, w: number, h: number, r: number, grow: number): boolean {
  const ew = w + 2 * grow;
  const eh = h + 2 * grow;
  if (ew <= 0 || eh <= 0) return false;
  const px = p.x + grow;
  const py = p.y + grow;
  if (px < 0 || px > ew || py < 0 || py > eh) return false;
  const er = Math.min(Math.max(0, r + grow), ew / 2, eh / 2);
  if (er <= 0) return true;
  if (px >= er && px <= ew - er) return true;
  if (py >= er && py <= eh - er) return true;
  const cx = px < er ? er : ew - er;
  const cy = py < er ? er : eh - er;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= er * er;
}

/** Exact box containment, `p` in the box's local space, widened by `tol`. */
function insideBox(p: Point, w: number, h: number, tol: number): boolean {
  return p.x >= -tol && p.x <= w + tol && p.y >= -tol && p.y <= h + tol;
}

/** `((p.x-cx)/(rx+grow))² + ((p.y-cy)/(ry+grow))² ≤ 1`, false for a degenerate radius. */
function insideEllipse(p: Point, w: number, h: number, grow: number): boolean {
  const rx = w / 2 + grow;
  const ry = h / 2 + grow;
  if (rx <= 0 || ry <= 0) return false;
  const dx = (p.x - w / 2) / rx;
  const dy = (p.y - h / 2) / ry;
  return dx * dx + dy * dy <= 1;
}

// ---------------------------------------------------------------------------
// Visibility keywords (§3.4)
// ---------------------------------------------------------------------------

/** `visibility:hidden` / `display:none` authored in `style` — the browser
 *  paints nothing and delivers no pointer events for either, so hit-testing
 *  what cannot be seen contradicts the whole point of this module. Checked on
 *  the node itself; a hidden ancestor already skips its subtree via the walk. */
function isVisuallyHidden(style: StyleMap): boolean {
  const visibility = style.visibility?.trim().toLowerCase();
  const display = style.display?.trim().toLowerCase();
  return visibility === "hidden" || display === "none";
}

// ---------------------------------------------------------------------------
// Content — a label makes a box hittable (R9: fast-reject the common empty case)
// ---------------------------------------------------------------------------

function contentHit(node: SceneNode, local: Point, w: number, h: number): boolean {
  if (node.label.trim() === "") return false;
  if (labelText(node.label).trim() === "") return false;
  return insideBox(local, w, h, 0);
}

// ---------------------------------------------------------------------------
// §4.2 / §4.5 — box kinds (rect, plain ellipse's box test lives separately
// below; a plain or painted group uses this exact rule too)
// ---------------------------------------------------------------------------

function boxPaintedAt(node: SceneNode, local: Point, tol: number): HitPart | null {
  const { w, h, style } = node;
  const r = cornerRadius(style["border-radius"], w, h);
  for (const band of edgeBands(style)) {
    if (insideRounded(local, w, h, r, band.outer + tol) && !insideRounded(local, w, h, r, band.inner - tol)) {
      return "stroke";
    }
  }
  if (fillVisible(style, false) && insideRounded(local, w, h, r, 0)) return "fill";
  if (contentHit(node, local, w, h)) return "content";
  return null;
}

// ---------------------------------------------------------------------------
// §4.3 — plain ellipse (no start/sweep/inner)
// ---------------------------------------------------------------------------

function ellipsePaintedAt(node: SceneNode, local: Point, tol: number): HitPart | null {
  const { w, h, style } = node;
  for (const band of edgeBands(style)) {
    if (insideEllipse(local, w, h, band.outer + tol) && !insideEllipse(local, w, h, band.inner - tol)) {
      return "stroke";
    }
  }
  if (fillVisible(style, false) && insideEllipse(local, w, h, 0)) return "fill";
  if (contentHit(node, local, w, h)) return "content";
  return null;
}

// ---------------------------------------------------------------------------
// §4.4 / §4.7 — polygon, arc, path, boolean: flattened, cached
// ---------------------------------------------------------------------------

type FillRule = "nonzero" | "evenodd";

interface Flat {
  polylines: Polyline[];
  rule: FillRule;
  /** Local-space AABB of the flattened geometry — the pre-check that makes a
   *  miss cost one rect test rather than a walk of every segment (§4.7). */
  bounds: Rect;
}

/**
 * Keyed on the node object, which is immutable under `scene/ops` structural
 * sharing: `laidOutScene` re-creates only moved nodes, and a live gesture's
 * `withFrames` makes fresh objects only for the nodes it holds. `ready` is
 * `clipperReady()` at compute time — a boolean group's cached entry is
 * recomputed once the clipper lands (R8); every other kind's outline never
 * depends on it, so its cache entry is reused regardless.
 */
const FLAT = new WeakMap<SceneNode, { ready: boolean; flat: Flat | null }>();

function boundsOfPolylines(polylines: Polyline[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const { points } of polylines) {
    for (const p of points) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  }
  if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** `d` and fill rule per §4.4's table, or `null` for geometry that draws nothing. */
function flatSourceOf(node: SceneNode): { d: string | null; rule: FillRule } {
  switch (node.kind) {
    case "polygon":
      return { d: outlineOf(node), rule: "evenodd" };
    case "ellipse":
      // Only reached for an arc (the plain-ellipse branch never calls here).
      return { d: outlineOf(node), rule: "evenodd" };
    case "path":
      return { d: node.d || null, rule: node.style["fill-rule"]?.trim() === "evenodd" ? "evenodd" : "nonzero" };
    case "group":
      // Boolean only (the plain/painted/clipping branch never calls here):
      // the derived region once the clipper is in, else the operands' own
      // outlines under even-odd — exactly what `BooleanView` draws in its
      // place (§0: "picking follows the picture").
      return { d: clipperReady() ? derivedPath(node) : operandsPath(node), rule: "evenodd" };
    default:
      return { d: null, rule: "evenodd" };
  }
}

function flatOf(node: SceneNode): Flat | null {
  const ready = clipperReady();
  const cached = FLAT.get(node);
  if (cached && (node.kind !== "group" || cached.ready === ready)) return cached.flat;

  const { d, rule } = flatSourceOf(node);
  let flat: Flat | null = null;
  if (d) {
    const polylines = flattenPath(d);
    flat = { polylines, rule, bounds: boundsOfPolylines(polylines) };
  }
  FLAT.set(node, { ready, flat });
  return flat;
}

/** Distance from `p` to the nearest segment of a flattened subpath — the
 *  closing segment only when it is actually closed (§4.4: "plus last→first
 *  only when closed"). A 1-point polyline is a point. */
function nearPolyline(line: Polyline, p: Point, tol: number): boolean {
  const { points, closed } = line;
  const n = points.length;
  if (n === 0) return false;
  if (n === 1) return Math.hypot(points[0].x - p.x, points[0].y - p.y) <= tol;
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    if (segmentDistance(p, a.x, a.y, b.x, b.y) <= tol) return true;
  }
  return false;
}

/** Ray cast +x, half-open convention (`ay > p.y !== by > p.y`, as `hitsPolygon`
 *  used) over every polyline **treated as closed for the fill** — SVG fills an
 *  open subpath as if closed, which is what the old `ringOf` did too. */
function inRegion(p: Point, polylines: Polyline[], rule: FillRule): boolean {
  let winding = 0;
  let crossings = 0;
  for (const { points } of polylines) {
    const n = points.length;
    if (n < 2) continue;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = points[j];
      const b = points[i];
      if (a.y > p.y !== b.y > p.y) {
        const xAt = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
        if (p.x < xAt) {
          crossings++;
          winding += b.y > a.y ? 1 : -1;
        }
      }
    }
  }
  return rule === "evenodd" ? crossings % 2 === 1 : winding !== 0;
}

/**
 * Polygon, ellipse-arc, path or boolean group: stroke against the flattened
 * polylines, fill by winding/even-odd, content — polygon/arc only — by box
 * (§4.4: "Path/boolean — none [no label rendered]").
 */
function drawnPaintedAt(
  node: SceneNode,
  local: Point,
  tol: number,
  kind: "polygon" | "ellipse" | "path" | "group",
): HitPart | null {
  const flat = flatOf(node);
  if (flat) {
    const sw = drawnStrokeWidth(node.style, kind);
    const half = sw !== null ? sw / 2 + tol : 0;
    const grow = Math.max(half, tol);
    const { bounds } = flat;
    const withinBudget =
      local.x >= bounds.x - grow &&
      local.x <= bounds.x + bounds.w + grow &&
      local.y >= bounds.y - grow &&
      local.y <= bounds.y + bounds.h + grow;
    if (withinBudget) {
      if (sw !== null) {
        for (const line of flat.polylines) {
          if (nearPolyline(line, local, half)) return "stroke";
        }
      }
      if (fillVisible(node.style, true) && inRegion(local, flat.polylines, flat.rule)) return "fill";
    }
  }
  if ((kind === "polygon" || kind === "ellipse") && contentHit(node, local, node.w, node.h)) return "content";
  return null;
}

// ---------------------------------------------------------------------------
// paintedAt (§2.1) — dispatch, one reader per kind
// ---------------------------------------------------------------------------

/**
 * The paint policy, one function. `local` is in `node`'s local space. Returns
 * the part hit or `null`. Never looks at children (a group's own paint only —
 * see the walk below for the ancestor/descendant question), never at
 * `hidden`/`locked` (the walk's job).
 */
export function paintedAt(node: SceneNode, local: Point, tolerance: number): HitPart | null {
  const tol = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 0;
  switch (node.kind) {
    case "text":
    case "image":
      return insideBox(local, node.w, node.h, 0) ? "content" : null;
    case "rect":
      return boxPaintedAt(node, local, tol);
    case "group":
      return isBoolean(node) ? drawnPaintedAt(node, local, tol, "group") : boxPaintedAt(node, local, tol);
    case "ellipse":
      return isArc(node) ? drawnPaintedAt(node, local, tol, "ellipse") : ellipsePaintedAt(node, local, tol);
    case "polygon":
      return drawnPaintedAt(node, local, tol, "polygon");
    case "path":
      return drawnPaintedAt(node, local, tol, "path");
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The walk (§2.1's ordering rule) — hitTestAll / hitTestPath / hitTest
// ---------------------------------------------------------------------------

interface WalkOptions {
  tolerance: number;
  includeLocked: boolean;
  limit: number;
}

/**
 * Reverse document order, depth-first, children before their container — the
 * order `hitChain` walked, minus the early return: every painted node is a
 * candidate, not only the first. A boolean group contributes at most one
 * candidate (itself); its operands are never walked (§2.1).
 */
function walk(list: readonly SceneNode[], point: Point, opts: WalkOptions, chain: SceneNode[], out: Candidate[]): void {
  for (let i = list.length - 1; i >= 0; i--) {
    if (out.length >= opts.limit) return;
    const node = list[i];
    if (node.hidden) continue;
    if (isVisuallyHidden(node.style)) continue;
    if (node.locked && !opts.includeLocked) continue;

    const local = toLocal(point, node);
    chain.push(node);

    if (node.kind === "group" && !isBoolean(node)) {
      const clips = node.style.overflow === "hidden" || node.style.overflow === "clip";
      const r = cornerRadius(node.style["border-radius"], node.w, node.h);
      const insideOwnBox = insideRounded(local, node.w, node.h, r, 0);
      if (!clips || insideOwnBox) {
        walk(node.children, local, opts, chain, out);
        if (out.length >= opts.limit) {
          chain.pop();
          return;
        }
      }
    }

    const part = paintedAt(node, local, opts.tolerance);
    if (part !== null) out.push({ node, chain: [...chain], part, local });

    chain.pop();
  }
}

/** Every painted node under `point` (scene space), front to back. Empty when nothing is painted there. */
export function hitTestAll(scene: SceneLike, point: Point, opts: HitTestOptions = {}): Candidate[] {
  const tolerance = opts.tolerance !== undefined && Number.isFinite(opts.tolerance) && opts.tolerance > 0 ? opts.tolerance : 0;
  const out: Candidate[] = [];
  walk(rootNodes(scene), point, { tolerance, includeLocked: opts.includeLocked ?? false, limit: opts.limit ?? Infinity }, [], out);
  return out;
}

/** `hitTestAll(...)[0]?.chain ?? []` — unchanged signature and meaning from geometry.ts. */
export function hitTestPath(scene: SceneLike, point: Point, opts: HitTestOptions = {}): SceneNode[] {
  return hitTestAll(scene, point, { ...opts, limit: 1 })[0]?.chain ?? [];
}

/** Unchanged: outermost of the chain, or the leaf under `opts.deep`; `null` for nothing. */
export function hitTest(scene: SceneLike, point: Point, opts: HitTestOptions = {}): SceneNode | null {
  const path = hitTestPath(scene, point, opts);
  if (path.length === 0) return null;
  return opts.deep ? path[path.length - 1] : path[0];
}

// ---------------------------------------------------------------------------
// §6 — Marquee: hitTestRect, not paint-aware for leaves
// ---------------------------------------------------------------------------

function quadOf(node: SceneNode, x: Xform): Point[] {
  return [applyX(x, 0, 0), applyX(x, node.w, 0), applyX(x, node.w, node.h), applyX(x, 0, node.h)];
}

/**
 * §6's one rule that moves: a group's own box counts when it either paints an
 * interior or wears a ring — `fillVisible(style,false) || edgeBands(style)`
 * — not only `isFilled`'s background-only reading, so a bordered-but-unfilled
 * frame is still caught by its bounds. A boolean group is treated like a
 * leaf (its own box; the operands are not drawn, so they are not the thing a
 * marquee should catch). Everything else — leaf box quads, rotation, and
 * `overflow:hidden` being ignored (Figma's marquee also catches clipped-out
 * children — R6, unverified) — is unchanged.
 */
function marqueeHits(node: SceneNode, parent: Xform, rect: Rect): boolean {
  const x = compose(parent, localXform(node));
  if (node.kind === "group" && !isBoolean(node)) {
    for (const child of node.children) {
      if (child.hidden) continue;
      if (marqueeHits(child, x, rect)) return true;
    }
    const ownBoxPaints = fillVisible(node.style, false) || edgeBands(node.style).length > 0;
    return ownBoxPaints && quadIntersectsRect(quadOf(node, x), rect);
  }
  return quadIntersectsRect(quadOf(node, x), rect);
}

/**
 * Marquee selection: every top-level node whose geometry **intersects** the
 * rect, not only those it fully contains — Figma's rule. Rotation-aware and
 * group-aware; returns document order.
 */
export function hitTestRect(scene: SceneLike, rect: Rect): SceneNode[] {
  const out: SceneNode[] = [];
  for (const node of rootNodes(scene)) {
    if (node.hidden || node.locked) continue;
    if (marqueeHits(node, IDENTITY, rect)) out.push(node);
  }
  return out;
}
