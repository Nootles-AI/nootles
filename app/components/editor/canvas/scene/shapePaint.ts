/**
 * Pure geometry-and-paint decisions moved out of `render/svgShape.tsx`
 * (COMPILE, build-plan §1.1) so `app/lib/ai/html/toHtml.ts` can share exactly
 * the renderer's own reading of "what does this shape paint with" and "what
 * geometry does it draw", without importing a `"use client"` React module.
 * `render/svgShape.tsx` keeps its exported names and signatures — `pathPaint`,
 * `paintsBox`, `shadowFilter`, `shapeOf` — as thin wrappers over the functions
 * here, so `svgShape.test.ts`'s existing expectations are the proof neither
 * side drifted from the other.
 *
 * `DRAWN_INK`, `DRAWN_STROKE_WIDTH` and `layers()` are NOT re-declared here:
 * PICK already moved them to `scene/paint.ts` (build-plan Conflict 2 / OQ-2),
 * because `paint.ts`'s own `drawnStrokeWidth` needs the former and
 * `fillVisible` needs the latter. This module imports both from `./paint`
 * rather than growing a second copy that could quietly disagree with the
 * first.
 */

import { unitPolygon } from "./geometry";
import { arcPath, roundedPolygon, scaled, straight, vertexRadius } from "./outline";
import { DRAWN_INK, DRAWN_STROKE_WIDTH, LENGTH, layers, paintOf, words } from "./paint";
import { arcOf, isArc, type SceneNode, type StyleMap } from "./types";

/** Paint the browser would apply to the element's rectangle. */
export const BOX_PAINT = /^(background|border|outline|fill|stroke)(-|$)/;

/**
 * Paint the BOX would draw and a path has no use for.
 *
 * Deliberately not {@link BOX_PAINT}: that one also names `fill` and `stroke`,
 * because on a polygon those are re-emitted as attributes on the `<path>` it
 * builds. A path node has no such element to re-emit onto — it IS the path, and
 * its `style` lands on the element directly — so dropping them there deletes
 * the author's own paint and leaves SVG's default black fill behind.
 */
export const BOX_ONLY_PAINT = /^(background|border|outline)(-|$)/;

export const dropPaint = (prop: string): boolean => BOX_PAINT.test(prop);
export const dropStroke = (prop: string): boolean =>
  BOX_PAINT.test(prop) && !prop.startsWith("background");
export const dropBoxPaint = (prop: string): boolean => BOX_ONLY_PAINT.test(prop);
/** Border and outline only: the background is the shape's own fill. */
export const dropBorder = (prop: string): boolean => /^(border|outline)(-|$)/.test(prop);

/** Whether a style paints the element's rectangle at all. */
export function paintsBox(style: StyleMap): boolean {
  for (const prop in style) {
    const value = style[prop].trim();
    if (BOX_ONLY_PAINT.test(prop) && value && value !== "none" && value !== "transparent") return true;
  }
  return false;
}

/**
 * The kebab-case rewrite of `svgShape.tsx`'s `pathPaint` body. NOT a move:
 * today `pathPaint` builds a `CSSProperties` object directly with camelCase
 * keys — `paint.fill = fill`, `paint.strokeWidth = attrs.strokeWidth`,
 * `paint.clipPath = …` — there is no separate camel-casing step to relocate.
 * `pathPaintDecls` is that same logic with every assignment renamed to its
 * kebab-case `StyleMap` key (`decls.fill`, `decls["stroke-width"]`,
 * `decls["clip-path"]`), same branches, same order, same values — reviewed
 * line-by-line against `pathPaint`'s current body, guarded by
 * `svgShape.test.ts`'s existing `toEqual` expectations on the `pathPaint`
 * wrapper.
 *
 * A path IS its geometry — there is no box behind it to fill — so `background`
 * and `border` cannot mean what they mean on a rect. The pen tool writes SVG
 * paint (`fill`, `stroke`, `stroke-width`) and this maps the box spellings onto
 * it, so a model reaching for the property every other kind uses gets the
 * shape painted rather than a coloured rectangle sitting behind its own
 * drawing.
 */
export function pathPaintDecls(
  style: StyleMap,
  d: string,
): { decls: StyleMap; drop: (prop: string) => boolean } {
  const { fill, attrs, css } = paintOf(style);
  // Everything the author spelled in SVG — `fill`, `stroke`, `stroke-width`,
  // `fill-rule`, anything else — reaches the element through `toCss`, which
  // `dropBoxPaint` leaves alone. This function only fills in what is MISSING,
  // so an authored declaration always wins and nothing here can overwrite it.
  const saidFill = style.fill !== undefined;
  const saidStroke = style.stroke !== undefined;
  const decls: StyleMap = {};

  // `background` means the shape's fill and `border` its stroke — the one
  // translation, so a model reaching for the property every other kind uses
  // paints the drawing instead of a rectangle behind it.
  if (!saidFill && fill !== null) decls.fill = fill;
  // A fill only CSS can draw — a gradient, a picture — stays on the element
  // as its `background`, clipped to the geometry: the bargain a polygon makes,
  // with the same cost, that the outer half of a stroke is cut away.
  if (css !== null) {
    decls.fill = "none";
    decls["clip-path"] = `path("${d}")`;
  }
  if (!saidStroke && attrs.stroke) {
    decls.stroke = attrs.stroke;
    if (style["stroke-width"] === undefined && attrs.strokeWidth) {
      decls["stroke-width"] = attrs.strokeWidth;
    }
    if (style["stroke-dasharray"] === undefined && attrs.strokeDasharray) {
      decls["stroke-dasharray"] = attrs.strokeDasharray;
    }
  }

  // What the element will actually be filled with, counting the translation.
  const fillNow = saidFill ? style.fill.trim() : (css ?? decls.fill);
  const strokeNow = saidStroke || decls.stroke !== undefined;

  // Nothing named a fill. SVG's default is opaque black, which turns an open
  // line — the commonest thing anyone draws — into a filled silhouette of
  // itself; every stroked path would arrive as a black blob. A shape meant to
  // be black says so.
  if (fillNow === undefined) decls.fill = "none";

  // No fill and no stroke draws nothing at all, which is never what was meant —
  // whether the author said `fill: none` and stopped, or said nothing whatever.
  if (!strokeNow && (fillNow === undefined || fillNow === "none")) {
    decls.stroke = DRAWN_INK;
    if (style["stroke-width"] === undefined) decls["stroke-width"] = DRAWN_STROKE_WIDTH;
  }
  return { decls, drop: css !== null ? dropBorder : dropBoxPaint };
}

/** One `box-shadow` layer, as `svgShape.tsx`'s own splitter reads it, cast as
 *  a `drop-shadow()` — or `null` for an inset layer, which has no filter
 *  form. */
function dropShadow(layer: string): string | null {
  const parts = words(layer);
  if (parts.includes("inset")) return null;
  const [x = "0", y = "0", blur = "0"] = parts.filter((w) => LENGTH.test(w));
  const color = parts.filter((w) => !LENGTH.test(w)).join(" ");
  return `drop-shadow(${[x, y, blur, color].filter(Boolean).join(" ")})`;
}

/**
 * `svgShape.shadowFilter`, before camel-casing: `null` when there is no
 * `box-shadow` to cast, else the `filter` value (`""` when every layer was
 * inset). `box-shadow` realised as `filter: drop-shadow()`, for the kinds
 * whose box is not their shape — a path, a polygon, an arc, a group with no
 * paint of its own — so the shadow follows what is drawn rather than the
 * rectangle around it. The document keeps the `box-shadow` spelling; this is
 * how the renderer (and the compiler) reads it. One `drop-shadow()` per
 * layer, in order. An inset layer and a spread have no filter form and are
 * left out.
 */
export function shadowFilterOf(style: StyleMap): string | null {
  const shadow = style["box-shadow"];
  if (!shadow || shadow.trim() === "none") return null;
  const cast = layers(shadow)
    .map(dropShadow)
    .filter((f): f is string => f !== null);
  return [style.filter, ...cast].filter((f) => f && f !== "none").join(" ");
}

export type ShapeGeometry = { d: string; clip: string };

const pct = (n: number) => `${Math.round(n * 100000) / 1000}%`;

/**
 * `svgShape.geometryOf`, unchanged: polygon (rounded → `path()`, else
 * `polygon()` in %), arc → `path()`; `null` for every other kind, which the
 * browser can draw from the box alone.
 */
export function shapeGeometry(node: SceneNode): ShapeGeometry | null {
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
      // representation: `shapeWriter` rewrites one attribute whatever the
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
