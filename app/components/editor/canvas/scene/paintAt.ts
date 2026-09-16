/**
 * The authored paint under a scene point — what the eyedropper (COLOR) picks
 * up, as opposed to `scene/picking.ts`'s `paintedAt`, which only answers
 * "is anything painted here" for hit-testing. Two different questions over
 * the same box/drawn-kind paint model (`scene/picking.ts`'s module header
 * makes the identical argument for why paint reading must not be
 * independently re-derived) — so this module walks `hitTestAll`'s own
 * candidates and classifies each one with the exact same fill/stroke readers
 * the style panel renders with (`panels/fills.ts`, `panels/strokes.ts`),
 * never a second copy of "what colour is this".
 *
 * `hitTestAll`'s real contract (`scene/picking.ts`, PICK) is
 * `Candidate = { node, chain, part: "fill" | "stroke" | "content", local }` —
 * coarser than the region vocabulary this module answers with
 * (`fill | stroke | text | image | background`). The mapping: `part` says
 * *where* on the node was hit; `node.kind` (plus whether the caller asked for
 * text via `opts.text`) says what that paint actually *is*. A "fill" hit on a
 * text-bearing box, with `opts.text`, answers with the box's `color` instead
 * of its `background` — Alt is how you reach the text underneath a filled
 * label, matching Figma's own eyedropper-over-labelled-shape convention (this
 * app's own choice, not Figma's — Figma answers from rendered pixels and has
 * no such modifier).
 *
 * Pure: no DOM, no React. `scene` is always the **laid** scene — the same
 * rule every other geometry reader in this package follows.
 */

import { hitTestAll, type Candidate } from "./picking";
import { paintOf } from "./paint";
import { customProperties, resolveVars } from "./vars";
import {
  hasText,
  nodePath,
  type NodeId,
  type Point,
  type Scene,
  type SceneNode,
} from "./types";
import { labelText } from "./label";
import { readFills, opacityOf, type Fill } from "../panels/fills";
import { readStroke } from "../panels/strokes";
import { clamp01, formatColor, parseColor } from "../panels/controls/color";
import { parseGradient, type Gradient } from "../panels/controls/gradient";

export type PaintRegion = "fill" | "stroke" | "text" | "image" | "background";

/**
 * The non-DOM default a text node without any authored `color` renders as —
 * `body { color: var(--foreground) }` (`app/globals.css`) is the app's one
 * static text-colour default, and Nootles is light-mode only, so this never
 * varies at runtime and needs no DOM read.
 */
export const DEFAULT_TEXT_COLOR = "var(--foreground)";

export interface PaintSample {
  /** The CSS value to write: authored token verbatim, or an interpolated literal. */
  css: string;
  /**
   * `authored`     — copied verbatim from a declaration (`var()` refs stay refs);
   * `interpolated` — computed between two gradient stops (always a literal);
   * `inherited`    — a text colour found on an ancestor, the diagram, or (with
   *                  nothing authored anywhere) `DEFAULT_TEXT_COLOR`;
   * `none`         — nothing authored here (caller decides: screen sample or fall through).
   */
  kind: "authored" | "interpolated" | "inherited" | "none";
  region: PaintRegion;
  nodeId: NodeId | null; // null for the diagram background
  /** For a gradient hit: the whole paint, so Shift can take it. */
  paint?: string;
  /** For an image hit with nothing under it to fall back to. */
  needsScreen?: boolean;
}

export interface PaintAtOptions {
  /** Scene px = screen px / zoom. Same rule as `engine/snapping.ts`. */
  tolerance: number;
  /** Read a text-bearing box's `color` instead of its fill. */
  text?: boolean;
  /** Take the whole gradient rather than the colour at the point. */
  wholePaint?: boolean;
}

const NONE = (region: PaintRegion, nodeId: NodeId | null, needsScreen?: boolean): PaintSample => ({
  css: "",
  kind: "none",
  region,
  nodeId,
  ...(needsScreen ? { needsScreen: true } : {}),
});

/**
 * A node's effective `color`: its own, else the nearest ancestor's, else the
 * diagram's `style.color`, else {@link DEFAULT_TEXT_COLOR}. Pure, total —
 * never `null`, never touches the DOM.
 */
export function resolveTextColor(scene: Scene, id: NodeId): { css: string; own: boolean } {
  const chain = nodePath(scene, id);
  const node = chain[chain.length - 1];
  if (node?.style.color) return { css: node.style.color, own: true };
  for (let i = chain.length - 2; i >= 0; i--) {
    const ancestorColor = chain[i].style.color;
    if (ancestorColor) return { css: ancestorColor, own: false };
  }
  if (scene.style.color) return { css: scene.style.color, own: false };
  return { css: DEFAULT_TEXT_COLOR, own: false };
}

function textSample(scene: Scene, node: SceneNode): PaintSample {
  const { css, own } = resolveTextColor(scene, node.id);
  return { css, kind: own ? "authored" : "inherited", region: "text", nodeId: node.id };
}

/** CSS gradient-line parameter for a point in a `w`×`h` box: linear by angle
 *  (CSS convention, 0 = to top, clockwise), radial by `circle farthest-corner
 *  at center` — the only radial head `panels/controls/gradient.ts` writes. */
export function gradientT(g: Gradient, local: Point, w: number, h: number): number {
  const cx = w / 2;
  const cy = h / 2;
  if (g.kind === "radial") {
    const r = Math.hypot(cx, cy);
    return r <= 0 ? 0 : clamp01(Math.hypot(local.x - cx, local.y - cy) / r);
  }
  const theta = (g.angle * Math.PI) / 180;
  const dx = Math.sin(theta);
  const dy = -Math.cos(theta);
  const length = Math.abs(w * Math.sin(theta)) + Math.abs(h * Math.cos(theta));
  if (length <= 0) return 0;
  const t = ((local.x - cx) * dx + (local.y - cy) * dy) / length + 0.5;
  return clamp01(t);
}

/** A stop within this of `t` reads as authored rather than interpolated. */
const STOP_SNAP = 0.005;

/**
 * The colour of `g` at `local` inside a `w`×`h` box, CSS semantics for the
 * subset `panels/controls/gradient.ts` writes. `onStop` is the authored stop
 * token when `t` lands within {@link STOP_SNAP} of a stop position — that
 * keeps a `var()` a reference instead of resolving it away. `resolve` is
 * consulted only for the two stops actually being interpolated *between* (a
 * `var()` exactly on a stop never needs it, since it is returned verbatim) —
 * this is `paintAt`'s hook for resolving a colour variable before mixing two
 * colours, so this module needs no second stop-matching copy of its own.
 */
export function gradientAt(
  g: Gradient,
  local: Point,
  w: number,
  h: number,
  resolve: (css: string) => string = (css) => css,
): { css: string; onStop: string | null; t: number } {
  const t = gradientT(g, local, w, h);

  // CSS stop-position monotonicity, in AUTHORED order (not sorted by value):
  // a stop lower than the running max is raised to it, e.g. 30% then 10% is
  // read as 30% then 30% — sorting by value first would silently reorder the
  // very stops this rule exists to keep in their authored place.
  let running = -Infinity;
  const stops = g.stops.map((s) => {
    const pos = Math.max(s.pos, running);
    running = pos;
    return { color: s.color, pos };
  });

  for (const s of stops) {
    if (Math.abs(t - s.pos) <= STOP_SNAP) return { css: s.color, onStop: s.color, t };
  }

  const first = stops[0];
  const last = stops[stops.length - 1];
  if (t <= first.pos) return { css: first.color, onStop: null, t };
  if (t >= last.pos) return { css: last.color, onStop: null, t };

  for (let i = 0; i < stops.length - 1; i++) {
    const lo = stops[i];
    const hi = stops[i + 1];
    if (t < lo.pos || t > hi.pos) continue;
    const span = hi.pos - lo.pos;
    const localT = span <= 0 ? 0 : (t - lo.pos) / span;
    const a = parseColor(resolve(lo.color));
    const b = parseColor(resolve(hi.color));
    if (!a || !b) return { css: hi.color, onStop: null, t };
    // Premultiplied alpha in sRGB — what Chromium and WebKit ship for a
    // gradient authored with no `in <space>` (R6: verified against rendered
    // pixels by the browser harness, not assumed here).
    const alpha = a.a + (b.a - a.a) * localT;
    const mix = (x0: number, a0: number, x1: number, a1: number) =>
      alpha <= 0 ? 0 : (x0 * a0 + (x1 * a1 - x0 * a0) * localT) / alpha;
    const rgba = {
      r: mix(a.r, a.a, b.r, b.a),
      g: mix(a.g, a.a, b.g, b.a),
      b: mix(a.b, a.a, b.b, b.a),
      a: alpha,
    };
    return { css: formatColor(rgba), onStop: null, t };
  }
  return { css: last.color, onStop: null, t };
}

/** The variables a document's own diagram declares, for resolving a `var()`
 *  stop before two colours are mixed (the mixed result is always a literal —
 *  `onStop` is the only path that can hand back a reference). */
function resolverFor(scene: Scene): (css: string) => string {
  const vars = customProperties(scene.style);
  return (css) => resolveVars(css, vars);
}

/** Walk a `background` stack front to back, skipping alpha-0 layers and
 *  falling through an image layer to whatever is under it — never returning
 *  early for an image the way a candidate-to-candidate fallthrough would,
 *  since an image is just one layer of *this* node's own stack. */
function fillStackSample(
  scene: Scene,
  node: SceneNode,
  local: Point,
  fills: Fill[],
  wholePaint: boolean | undefined,
): PaintSample | undefined {
  for (const fill of fills) {
    if (fill.type === "image") continue; // fall through to the next layer
    if (opacityOf(fill) === 0) continue;
    if (fill.type === "solid") {
      return { css: fill.paint, kind: "authored", region: "fill", nodeId: node.id };
    }
    const g = parseGradient(fill.paint);
    if (!g) continue;
    if (wholePaint) {
      return { css: fill.paint, kind: "authored", region: "fill", nodeId: node.id, paint: fill.paint };
    }
    const { css, onStop } = gradientAt(g, local, node.w, node.h, resolverFor(scene));
    return {
      css,
      kind: onStop !== null ? "authored" : "interpolated",
      region: "fill",
      nodeId: node.id,
      paint: fill.paint,
    };
  }
  return undefined;
}

/** The node's own `background`, resolved into a box-fill sample (never a
 *  stroke — call sites that already know the hit was a stroke use
 *  {@link strokeSample} instead), or `undefined` when the stack has nothing
 *  visible at all (every layer hidden, or an image with nothing beneath it). */
function boxFillSample(
  scene: Scene,
  candidate: Candidate,
  wholePaint: boolean | undefined,
): PaintSample {
  const { node, chain, local } = candidate;
  const fills = readFills(node.style.background);
  const own = fillStackSample(scene, node, local, fills, wholePaint);
  if (own) return own;

  // Every layer was either hidden or an image with nothing under it on this
  // node — try the immediate parent group's own paint, then the diagram's.
  const parent = chain.length >= 2 ? chain[chain.length - 2] : null;
  if (parent) {
    const parentFills = readFills(parent.style.background);
    const parentSample = fillStackSample(scene, parent, local, parentFills, wholePaint);
    if (parentSample) return { ...parentSample, region: "fill" };
  }
  if (scene.style.background) {
    return { css: scene.style.background, kind: "authored", region: "background", nodeId: null };
  }
  const image = fills.some((f) => f.type === "image");
  return NONE("fill", node.id, image);
}

/** A drawn kind's own paint (`fill`/`background` translated to path terms —
 *  `scene/paint.ts`'s `paintOf`, exactly what `render/svgShape.tsx` renders
 *  with), for a `path` node or a boolean `group`. */
function drawnFillSample(scene: Scene, candidate: Candidate, wholePaint: boolean | undefined): PaintSample {
  const { node, local } = candidate;
  const paint = paintOf(node.style);
  if (paint.css) {
    const g = parseGradient(paint.css);
    if (g) {
      if (wholePaint) {
        return { css: paint.css, kind: "authored", region: "fill", nodeId: node.id, paint: paint.css };
      }
      const { css, onStop } = gradientAt(g, local, node.w, node.h, resolverFor(scene));
      return {
        css,
        kind: onStop !== null ? "authored" : "interpolated",
        region: "fill",
        nodeId: node.id,
        paint: paint.css,
      };
    }
    return { css: paint.css, kind: "authored", region: "fill", nodeId: node.id };
  }
  if (paint.fill) return { css: paint.fill, kind: "authored", region: "fill", nodeId: node.id };
  return NONE("fill", node.id);
}

function strokeSample(node: SceneNode): PaintSample {
  const stroke = readStroke(node);
  if (!stroke) return NONE("stroke", node.id);
  return { css: stroke.color, kind: "authored", region: "stroke", nodeId: node.id };
}

function sampleOf(scene: Scene, candidate: Candidate, opts: PaintAtOptions): PaintSample {
  const { node, part } = candidate;

  if (node.kind === "text") return textSample(scene, node);
  if (node.kind === "image") return NONE("image", node.id, true);

  if (part === "stroke") return strokeSample(node);

  if (part === "fill") {
    if (opts.text && hasText(node) && labelText(node.label).trim() !== "") {
      return textSample(scene, node);
    }
    return node.kind === "path" || node.kind === "group"
      ? drawnFillSample(scene, candidate, opts.wholePaint)
      : boxFillSample(scene, candidate, opts.wholePaint);
  }

  // part === "content": a box/group hit purely by its (unfilled) label box.
  if (opts.text) return textSample(scene, node);
  return NONE("fill", node.id);
}

/**
 * The authored paint under `point` (scene space), or `null` when the point is
 * on nothing at all and the diagram has no `background`. Never touches the
 * DOM. Hidden nodes are skipped (by `hitTestAll`); locked nodes are NOT — a
 * colour is a colour regardless of whether the shape can be moved.
 */
export function paintAt(scene: Scene, point: Point, opts: PaintAtOptions): PaintSample | null {
  const candidates = hitTestAll(scene, point, { tolerance: opts.tolerance, includeLocked: true });
  let fallback: PaintSample | null = null;
  for (const candidate of candidates) {
    const sample = sampleOf(scene, candidate, opts);
    if (sample.kind !== "none") return sample;
    if (!fallback) fallback = sample;
  }
  if (scene.style.background) {
    return { css: scene.style.background, kind: "authored", region: "background", nodeId: null };
  }
  return fallback;
}
