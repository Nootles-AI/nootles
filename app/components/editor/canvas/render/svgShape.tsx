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
 *
 * The pure decisions themselves — which declarations a shape drops, what its
 * paint and geometry are, what a `box-shadow` casts as — live in
 * `scene/shapePaint.ts` (COMPILE, build-plan §1.1), so
 * `app/lib/ai/html/toHtml.ts` reads the exact same functions this file wraps
 * in React's own camelCase `CSSProperties`. `svgShape.test.ts`'s existing
 * `toEqual` expectations are unchanged and are the proof the wrappers below
 * still say what the old, undivided functions said.
 */

import type { CSSProperties, ReactElement } from "react";

import { toCss } from "../scene/boxModel";
import { unitPolygon } from "../scene/geometry";
import { DRAWN_INK, DRAWN_STROKE_WIDTH, paintOf } from "../scene/paint";
import { clipsToShape, pathPaintDecls, shadowFilterOf, shapeGeometry } from "../scene/shapePaint";
import { roundedPolygon, scaled, straight, vertexRadius } from "../scene/outline";
import type { SceneNode, StyleMap } from "../scene/types";

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

/**
 * What an unpainted path wears: the same ink and weight the pen draws with, so
 * a stroke a model forgot to specify and a stroke drawn by hand are one line.
 * Re-exported from `scene/paint.ts` — moved there (PICK, build-plan Conflict
 * 2 / OQ-2) because `scene/paint.ts`'s own `drawnStrokeWidth` needs the width
 * to answer with the renderer's default; `render/PenTool.tsx` and this
 * module's own test keep importing them from here.
 */
export { DRAWN_INK, DRAWN_STROKE_WIDTH };

/**
 * Whether a style paints the element's rectangle at all. Moved to
 * `scene/shapePaint.ts` (COMPILE, build-plan §1.1) so the compiler reads the
 * same test `render/ShapeView.tsx`'s shadow-cast branch already relies on.
 */
export { paintsBox } from "../scene/shapePaint";

/**
 * A path node's paint, and the box declarations it takes over.
 *
 * The camel-casing wrapper over `scene/shapePaint.ts`'s `pathPaintDecls`,
 * which does the actual reading of `style` in kebab-case (shared with the
 * compiler). Returned as style rather than as attributes on the `<path>` so
 * the cascade still decides: these land on the `<svg>`, where SVG paint
 * properties inherit down, and a `fill-rule` or a `stroke-linejoin` the
 * author wrote by hand is carried by the same route without this file having
 * to name it.
 */
export function pathPaint(
  style: StyleMap,
  d: string,
): {
  paint: CSSProperties;
  drop: (prop: string) => boolean;
} {
  const { decls, drop } = pathPaintDecls(style, d);
  return { paint: toCss(decls), drop };
}

/**
 * `box-shadow` realised as `filter: drop-shadow()` — the camelCase wrapper
 * over `scene/shapePaint.ts`'s `shadowFilterOf`.
 */
export function shadowFilter(style: StyleMap): CSSProperties | null {
  const filter = shadowFilterOf(style);
  return filter === null ? null : { boxShadow: "none", ...(filter ? { filter } : null) };
}

/**
 * The SVG a kind needs, or `null` for the kinds the browser can draw from the
 * box — which is every other kind, and a plain ellipse, whose `border-radius`
 * is the whole of it.
 */
export function shapeOf(node: SceneNode): Shape | null {
  const geometry = shapeGeometry(node);
  if (!geometry) return null;
  const paint = paintOf(node.style);
  const css = paint.fill === null;
  return {
    clip: clipsToShape(node.style, css) ? geometry.clip : null,
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

/** Paint the browser would apply to the element's rectangle. */
const BOX_PAINT = /^(background|border|outline|fill|stroke)(-|$)/;
const dropPaint = (prop: string) => BOX_PAINT.test(prop);
const dropStroke = (prop: string) =>
  BOX_PAINT.test(prop) && !prop.startsWith("background");

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
