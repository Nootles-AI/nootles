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
import { arcPath, roundedPolygon, scaled, straight, vertexRadius } from "../scene/outline";
import { LENGTH, paintOf, words } from "../scene/paint";
import {
  arcOf,
  isArc,
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

const dropPaint = (prop: string) => BOX_PAINT.test(prop);
const dropStroke = (prop: string) =>
  BOX_PAINT.test(prop) && !prop.startsWith("background");

/**
 * Paint the BOX would draw and a path has no use for.
 *
 * Deliberately not {@link BOX_PAINT}: that one also names `fill` and `stroke`,
 * because on a polygon those are re-emitted as attributes on the `<path>` it
 * builds. A path node has no such element to re-emit onto — it IS the path, and
 * its `style` lands on the element directly — so dropping them there deletes
 * the author's own paint and leaves SVG's default black fill behind.
 */
const BOX_ONLY_PAINT = /^(background|border|outline)(-|$)/;
const dropBoxPaint = (prop: string) => BOX_ONLY_PAINT.test(prop);

/**
 * What an unpainted path wears: the same ink and weight the pen draws with, so
 * a stroke a model forgot to specify and a stroke drawn by hand are one line.
 */
export const DRAWN_INK = "#1a1a1a";
export const DRAWN_STROKE_WIDTH = "2";

/**
 * A path node's paint, and the box declarations it takes over.
 *
 * A path IS its geometry — there is no box behind it to fill — so `background`
 * and `border` cannot mean what they mean on a rect. The pen tool writes SVG
 * paint (`fill`, `stroke`, `stroke-width`) and this maps the box spellings onto
 * it, so a model reaching for the property every other kind uses gets the shape
 * painted rather than a coloured rectangle sitting behind its own drawing.
 *
 * Returned as style rather than as attributes on the `<path>` so the cascade
 * still decides: these land on the `<svg>`, where SVG paint properties inherit
 * down, and `fill-rule` or a `stroke-linejoin` the author wrote by hand is
 * carried by the same route without this file having to name it.
 */
export function pathPaint(
  style: StyleMap,
  d: string,
): {
  paint: CSSProperties;
  drop: (prop: string) => boolean;
} {
  const { fill, attrs, css } = paintOf(style);
  // Everything the author spelled in SVG — `fill`, `stroke`, `stroke-width`,
  // `fill-rule`, anything else — reaches the element through `toCss`, which
  // `dropBoxPaint` leaves alone. This function only fills in what is MISSING,
  // so an authored declaration always wins and nothing here can overwrite it.
  const saidFill = style.fill !== undefined;
  const saidStroke = style.stroke !== undefined;
  const paint: CSSProperties = {};

  // `background` means the shape's fill and `border` its stroke — the one
  // translation, so a model reaching for the property every other kind uses
  // paints the drawing instead of a rectangle behind it.
  if (!saidFill && fill !== null) paint.fill = fill;
  // A fill only CSS can draw — a gradient, a picture — stays on the element
  // as its `background`, clipped to the geometry: the bargain a polygon makes,
  // with the same cost, that the outer half of a stroke is cut away.
  if (css !== null) {
    paint.fill = "none";
    paint.clipPath = `path("${d}")`;
  }
  if (!saidStroke && attrs.stroke) {
    paint.stroke = attrs.stroke;
    if (style["stroke-width"] === undefined && attrs.strokeWidth) {
      paint.strokeWidth = attrs.strokeWidth;
    }
    if (style["stroke-dasharray"] === undefined && attrs.strokeDasharray) {
      paint.strokeDasharray = attrs.strokeDasharray;
    }
  }

  // What the element will actually be filled with, counting the translation.
  const fillNow = saidFill ? style.fill.trim() : (css ?? paint.fill);
  const strokeNow = saidStroke || paint.stroke !== undefined;

  // Nothing named a fill. SVG's default is opaque black, which turns an open
  // line — the commonest thing anyone draws — into a filled silhouette of
  // itself; every stroked path would arrive as a black blob. A shape meant to
  // be black says so.
  if (fillNow === undefined) paint.fill = "none";

  // No fill and no stroke draws nothing at all, which is never what was meant —
  // whether the author said `fill: none` and stopped, or said nothing whatever.
  if (!strokeNow && (fillNow === undefined || fillNow === "none")) {
    paint.stroke = DRAWN_INK;
    if (style["stroke-width"] === undefined) paint.strokeWidth = DRAWN_STROKE_WIDTH;
  }
  return { paint, drop: css !== null ? dropBorder : dropBoxPaint };
}

/** Border and outline only: the background is the shape's own fill. */
const dropBorder = (prop: string) => /^(border|outline)(-|$)/.test(prop);

/** Whether a style paints the element's rectangle at all. */
export function paintsBox(style: StyleMap): boolean {
  for (const prop in style) {
    const value = style[prop].trim();
    if (BOX_ONLY_PAINT.test(prop) && value && value !== "none" && value !== "transparent") return true;
  }
  return false;
}

/**
 * `box-shadow` realised as `filter: drop-shadow()`, for the kinds whose box
 * is not their shape — a path, a polygon, an arc, a group with no paint of its
 * own — so the shadow follows what is drawn rather than the rectangle around
 * it. The document keeps the `box-shadow` spelling; this is how the renderer
 * reads it. One `drop-shadow()` per layer, in order. An inset layer and a
 * spread have no filter form and are left out.
 */
export function shadowFilter(style: StyleMap): CSSProperties | null {
  const shadow = style["box-shadow"];
  if (!shadow || shadow.trim() === "none") return null;
  const cast = layers(shadow)
    .map(dropShadow)
    .filter((f): f is string => f !== null);
  const filter = [style.filter, ...cast].filter((f) => f && f !== "none").join(" ");
  return { boxShadow: "none", ...(filter ? { filter } : null) };
}

function dropShadow(layer: string): string | null {
  const parts = words(layer);
  if (parts.includes("inset")) return null;
  const [x = "0", y = "0", blur = "0"] = parts.filter((w) => LENGTH.test(w));
  const color = parts.filter((w) => !LENGTH.test(w)).join(" ");
  return `drop-shadow(${[x, y, blur, color].filter(Boolean).join(" ")})`;
}

/** Comma-separated layers, with `rgba(0, 0, 0, 0.2)` left whole. */
function layers(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= css.length; i++) {
    const c = css[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if ((c === undefined || c === ",") && depth === 0) {
      const layer = css.slice(start, i).trim();
      if (layer) out.push(layer);
      start = i + 1;
    }
  }
  return out;
}

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

const pct = (n: number) => `${Math.round(n * 100000) / 1000}%`;

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
