"use client";

/**
 * The two kinds CSS cannot draw from the box alone.
 *
 * A polygon and an ellipse cut into an arc are drawn by an `<svg>` layered
 * behind the node's own content, not by a `clip-path` on the box: a clip cannot
 * stroke the edge it cuts, and both of these need strokes that follow the shape.
 * Everything else about them is a normal node — the same box, the same `style`,
 * the same label — so this file holds only the geometry and the one translation
 * that geometry forces: box paint into SVG paint.
 */

import type { CSSProperties, ReactElement } from "react";

import { unitPolygon } from "../scene/geometry";
import {
  arcOf,
  isArc,
  type Point,
  type SceneNode,
  type StyleMap,
} from "../scene/types";

/**
 * The shape sits *behind* the node's label. The box's `transform` makes it a
 * stacking context, so a negative `z-index` is still inside the shape and still
 * above whatever is behind it on the canvas.
 */
const SHAPE_LAYER: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: -1,
  // An SVG clips to its viewport by default, which would shave the outer half
  // off every stroke that straddles the edge.
  overflow: "visible",
  pointerEvents: "none",
};

export interface Shape {
  child: ReactElement;
  /** Box declarations the shape has taken over and the box must not paint. */
  drop: (prop: string) => boolean;
  /** The shape as a CSS clip, set only when the fill stayed on the box. */
  clip: string | null;
}

/** Paint the browser would apply to the element's rectangle. */
const BOX_PAINT = /^(background|border|outline|fill|stroke)(-|$)/;

/** A gradient or an image: a paint an SVG `fill` cannot take. */
const CSS_PAINT =
  /^(?:repeating-)?(?:linear|radial|conic)-gradient\(|^(?:url|image-set|element)\(/i;

const dropPaint = (prop: string) => BOX_PAINT.test(prop);
const dropStroke = (prop: string) =>
  BOX_PAINT.test(prop) && !prop.startsWith("background");

/**
 * The SVG a kind needs, or `null` for the kinds the browser can draw from the
 * box — which is every other kind, and a plain ellipse, whose `border-radius`
 * is the whole of it.
 */
export function shapeOf(node: SceneNode): Shape | null {
  const geometry = geometryOf(node);
  if (!geometry) return null;
  const paint = paintOf(node.style);
  const css = paint.fill === null;
  return {
    clip: css ? geometry.clip : null,
    drop: css ? dropStroke : dropPaint,
    child: (
      <svg
        style={SHAPE_LAYER}
        // A zero-sized view box is not rendered AT ALL, and a shape is drawn
        // from a box that starts at nothing — so without the floor a polygon
        // stayed invisible for the whole of the drag that drew it.
        viewBox={`0 0 ${node.w || 1} ${node.h || 1}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        {/* Even-odd is what makes a full ring a ring: the hole is a second
            subpath, and under the default rule it would simply be filled in. */}
        <path
          d={geometry.d}
          fillRule="evenodd"
          {...paint.attrs}
          fill={paint.fill ?? "none"}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    ),
  };
}

type Geometry = { points?: string; d?: string; clip: string };

function geometryOf(node: SceneNode): Geometry | null {
  if (node.kind === "polygon") {
    const unit = unitPolygon(node.sides);
    const radius = vertexRadius(node.style["border-radius"], node.w, node.h);
    if (radius > 0) {
      const d = roundedPolygon(scaled(unit, node.w, node.h), radius);
      // A rounded polygon is no longer a `polygon()`, so its clip is a `path()`
      // in px — as an arc's already is, and with the same cost: it lags a live
      // resize by one commit.
      if (d) return { d, clip: `path("${d}")` };
    }
    return {
      // A `<path>` even when the corners are square, so a polygon has ONE
      // representation: {@link shapeWriter} rewrites one attribute whatever the
      // radius, and a gesture cannot meet a shape it has no way to draw.
      d: straight(scaled(unit, node.w, node.h)),
      // Percentages rather than px: a resize gesture writes the box's width and
      // height without re-rendering, and a clip stated in px would stay cut to
      // the size the shape used to be for the whole drag.
      clip: `polygon(${unit.map((p) => `${pct(p.x)} ${pct(p.y)}`).join(", ")})`,
    };
  }
  if (isArc(node)) {
    const d = arcPath(node.w, node.h, arcOf(node));
    return { d, clip: `path("${d}")` };
  }
  return null;
}

const scaled = (unit: readonly Point[], w: number, h: number): Point[] =>
  unit.map((p) => ({ x: p.x * w, y: p.y * h }));

// ---------------------------------------------------------------------------
// Resizing live
// ---------------------------------------------------------------------------

export interface ShapeWriter {
  /** Re-emit the shape at a size. The DOM, per frame — never React state. */
  write(w: number, h: number): void;
  /** Put back exactly what React drew, for a cancelled gesture. */
  restore(): void;
}

/**
 * A shape whose geometry a resize gesture must redraw rather than stretch, or
 * `null` for one where stretching is exact — which is nearly all of them.
 *
 * A resize writes the box's width and height and nothing else, so what the user
 * sees during the drag is the SVG's own view box stretched to the new viewport.
 * That stretch is a linear map, and every geometry here is linear in the box —
 * a vertex at `unit × box`, an axis-aligned elliptical arc whose radii are the
 * box's halves — so the stretched drawing is the recomputed drawing, exactly.
 *
 * Two things are not. A polygon's *rounded* corner is a circular arc, and a
 * circular arc stretched unevenly is an elliptical one, tangent to neither edge
 * it was solved for. And a box that starts at nothing has nothing to stretch —
 * the shape a drag draws begins 0×0, where the view box is degenerate and every
 * vertex sits on the origin.
 *
 * So a polygon is re-emitted per frame either way. It is the same work the
 * commit does, and it is one attribute write.
 */
export function shapeWriter(
  node: SceneNode,
  el: HTMLElement,
): ShapeWriter | null {
  if (node.kind !== "polygon") return null;
  const authored = node.style["border-radius"];
  const svg = el.querySelector(":scope > svg");
  const path = svg?.querySelector("path");
  if (!svg || !path) return null;

  const unit = unitPolygon(node.sides);
  const was = {
    viewBox: svg.getAttribute("viewBox") ?? "",
    d: path.getAttribute("d") ?? "",
    // Only a fill CSS alone can draw leaves the box clipped to the shape, and
    // that clip is stated in px, so it stretches no better than the path does.
    clip: el.style.clipPath,
  };
  return {
    write(w, h) {
      const points = scaled(unit, w, h);
      const d =
        roundedPolygon(points, vertexRadius(authored, w, h)) || straight(points);
      // Same floor as the rendered view box: zero-sized, nothing draws at all.
      svg.setAttribute("viewBox", `0 0 ${w || 1} ${h || 1}`);
      path.setAttribute("d", d);
      if (was.clip) el.style.clipPath = `path("${d}")`;
    },
    restore() {
      svg.setAttribute("viewBox", was.viewBox);
      path.setAttribute("d", was.d);
      if (was.clip) el.style.clipPath = was.clip;
    },
  };
}

/** The plain outline, for a box too degenerate to round. */
const straight = (points: readonly Point[]): string =>
  `M ${points.map((p) => `${round(p.x)} ${round(p.y)}`).join(" L ")} Z`;

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
function vertexRadius(
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
function roundedPolygon(points: readonly Point[], radius: number): string {
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

const round = (n: number) => Math.round(n * 1000) / 1000;
const pct = (n: number) => `${round(n * 100)}%`;

/** Degrees clockwise from twelve o'clock, as Figma's arc controls state them. */
function polar(c: Point2, r: Point2, deg: number): string {
  const t = ((deg - 90) * Math.PI) / 180;
  return `${round(c[0] + r[0] * Math.cos(t))} ${round(c[1] + r[1] * Math.sin(t))}`;
}

type Point2 = [number, number];

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
function arcPath(
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
// Box paint → SVG paint
// ---------------------------------------------------------------------------

interface Paint {
  /** `null` when only CSS can draw it, and the box keeps it. */
  fill: string | null;
  attrs: {
    stroke?: string;
    strokeWidth?: string;
    strokeDasharray?: string;
  };
}

/** How the stroke panel spells a dash, mirrored so both sides say one thing. */
const DASHARRAY: Record<string, string> = { dashed: "8 6", dotted: "2 4" };

const LENGTH = /^-?[\d.]+[a-z%]*$/i;
const LINE_STYLE = new Set([
  "none",
  "hidden",
  "solid",
  "dashed",
  "dotted",
  "double",
  "groove",
  "ridge",
  "inset",
  "outset",
]);

/**
 * The node's `background` becomes the shape's `fill` and its `border` — or
 * `outline`, or either one's longhands, or a bare SVG `stroke` — becomes the
 * shape's stroke. That is the whole mapping, and it is one-way: the style panel
 * keeps writing box CSS, so a triangle and a rectangle are still styled by the
 * same controls.
 *
 * CSS puts a `border` inside the box while an SVG stroke straddles the edge, so
 * a heavy stroke sits half a weight further out here than on a rect.
 */
function paintOf(style: StyleMap): Paint {
  const fill = (
    style.fill ??
    style["background-color"] ??
    style.background ??
    ""
  ).trim();
  return {
    fill: !fill || CSS_PAINT.test(fill) ? null : fill,
    attrs: strokeOf(style),
  };
}

function strokeOf(style: StyleMap): Paint["attrs"] {
  if (style.stroke && style.stroke !== "none") {
    return {
      stroke: style.stroke,
      strokeWidth: style["stroke-width"] ?? "1",
      strokeDasharray: style["stroke-dasharray"],
    };
  }
  const box =
    style.border !== undefined || style["border-color"] !== undefined
      ? "border"
      : "outline";
  let width = style[`${box}-width`];
  let line = style[`${box}-style`];
  let color = style[`${box}-color`];
  for (const word of words(style[box] ?? "")) {
    if (LENGTH.test(word)) width ??= word;
    else if (LINE_STYLE.has(word)) line ??= word;
    else color ??= word;
  }
  if (!color || line === "none" || line === "hidden") return {};
  return {
    stroke: color,
    strokeWidth: width ?? "1px",
    strokeDasharray: line ? DASHARRAY[line] : undefined,
  };
}

/** Shorthand parts, with `rgb(1 2 3)` left whole. */
function words(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= css.length; i++) {
    const c = css[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if ((c === undefined || c === " ") && depth === 0) {
      const word = css.slice(start, i).trim();
      if (word) out.push(word);
      start = i + 1;
    }
  }
  return out;
}
