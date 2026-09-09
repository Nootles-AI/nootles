/**
 * Box paint, read as the paint of a drawing.
 *
 * The grammar spells appearance in CSS for every kind, so a shape that is
 * really an SVG path — a polygon, an arc, a pen path, a boolean — has to read
 * `background` as its fill and `border` as its stroke. This is the one
 * translation, shared by the renderer and by the ops that turn a box into a
 * drawing, so both read a declaration the same way.
 */

import type { StyleMap } from "./types";

/** A gradient or an image: a paint an SVG `fill` cannot take. */
const CSS_PAINT =
  /^(?:repeating-)?(?:linear|radial|conic)-gradient\(|^(?:url|image-set|element)\(/i;

const BOX_ONLY = /^(background|border|outline)(-|$)/;

/**
 * A style respelled for a node drawn as a path: `background` becomes `fill`,
 * `border` becomes a stroke, and the rest carries over. A paint SVG cannot
 * take — a gradient, a picture — stays as `background`, which the renderer
 * clips to the drawing. What the author already said in SVG terms wins.
 */
export function pathStyleOf(style: StyleMap): StyleMap {
  const { fill, css, attrs } = paintOf(style);
  const out: StyleMap = {};
  for (const [prop, value] of Object.entries(style)) if (!BOX_ONLY.test(prop)) out[prop] = value;
  if (style.fill === undefined) {
    if (fill !== null) out.fill = fill;
    else if (css !== null) out.background = css;
  }
  if (style.stroke === undefined && attrs.stroke) {
    out.stroke = attrs.stroke;
    if (attrs.strokeWidth) out["stroke-width"] = attrs.strokeWidth.replace(/px$/, "");
    if (attrs.strokeDasharray) out["stroke-dasharray"] = attrs.strokeDasharray;
  }
  return out;
}

// ---------------------------------------------------------------------------

export interface Paint {
  /** `null` when only CSS can draw it, and the box keeps it. */
  fill: string | null;
  /** The fill only CSS can draw, when that is what was asked for. */
  css: string | null;
  attrs: {
    stroke?: string;
    strokeWidth?: string;
    strokeDasharray?: string;
  };
}

/** How the stroke panel spells a dash, mirrored so both sides say one thing. */
const DASHARRAY: Record<string, string> = { dashed: "8 6", dotted: "2 4" };

export const LENGTH = /^-?[\d.]+[a-z%]*$/i;
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
export function paintOf(style: StyleMap): Paint {
  const fill = (
    style.fill ??
    style["background-color"] ??
    style.background ??
    ""
  ).trim();
  const css = !!fill && CSS_PAINT.test(fill);
  return {
    fill: !fill || css ? null : fill,
    css: css ? fill : null,
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
export function words(css: string): string[] {
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
