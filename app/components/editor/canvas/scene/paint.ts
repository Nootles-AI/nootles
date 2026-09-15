/**
 * Box paint, read as the paint of a drawing.
 *
 * The grammar spells appearance in CSS for every kind, so a shape that is
 * really an SVG path — a polygon, an arc, a pen path, a boolean — has to read
 * `background` as its fill and `border` as its stroke. This is the one
 * translation, shared by the renderer and by the ops that turn a box into a
 * drawing, so both read a declaration the same way.
 *
 * ## The picking readers (§3 of PICK)
 *
 * `fillVisible`, `edgeBands` and `drawnStrokeWidth` below answer a narrower
 * question than "what does this paint with" — they answer "is there paint
 * here at all", which is what decides whether a point on an otherwise-hollow
 * shape is clickable. They read the exact same CSS `paintOf`/`strokeOf`
 * already parse, because a second, independently-written reader of the same
 * declarations is how a click and a render quietly disagree (see the module
 * header of `scene/picking.ts`). `DRAWN_INK`/`DRAWN_STROKE_WIDTH` (the
 * default-ink band an unpainted path/boolean draws) and the CSV-splitter
 * `layers` moved here from `render/svgShape.tsx` for the same reason:
 * `drawnStrokeWidth` needs the former to answer with the renderer's own
 * default, and `fillVisible` needs the latter to walk a `background`
 * shorthand's comma-separated layers exactly as `pathPaint`'s shadow-layer
 * splitter and the style panel's `FillSection` already do — one function, not
 * a second copy that could tokenise a `rgba(0, 0, 0, .2)` differently.
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

/**
 * What an unpainted path wears: the same ink and weight the pen draws with, so
 * a stroke a model forgot to specify and a stroke drawn by hand are one line.
 * Moved from `render/svgShape.tsx` (§1.2 of PICK / build-plan Conflict 2):
 * `drawnStrokeWidth` below needs the width, and the renderer needs both, so
 * this is the one module that does not have to reach into the other.
 */
export const DRAWN_INK = "#1a1a1a";
export const DRAWN_STROKE_WIDTH = "2";

/** Top-level comma split, with a function's own parenthesised commas left
 *  whole — `rgba(0, 0, 0, .2)` is one layer, not four. Moved from
 *  `render/svgShape.tsx`'s `box-shadow` splitter, which is the exact same
 *  problem a `background` shorthand's comma-separated layers pose. */
export function layers(css: string): string[] {
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

// ---------------------------------------------------------------------------
// Alpha
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** One `rgb()`/`hsl()`/… argument that names an alpha: `"20%"` or `"0.2"`. */
function parseAlphaArg(raw: string): number {
  const s = raw.trim();
  if (s.endsWith("%")) {
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? clamp01(n / 100) : 1;
  }
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? clamp01(n) : 1;
}

/** The index of a `/` at paren depth 0, or `-1` — the alpha separator every
 *  modern colour-function syntax uses, never nested inside a component. */
function topLevelSlash(s: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "/" && depth === 0) return i;
  }
  return -1;
}

/**
 * The alpha argument of a colour function's parenthesised body, whichever
 * syntax it used: modern space syntax always separates it with a top-level
 * `/` (`rgb(0 0 0 / 20%)`, `oklch(0.7 0.1 145 / .5)`, `color(display-p3 0 0 0
 * / .5)`); legacy comma syntax puts it fourth (`rgba(0, 0, 0, .2)`). `null`
 * when the body has no alpha argument at all — the colour is fully opaque.
 */
function alphaArgOf(body: string): number | null {
  const slashAt = topLevelSlash(body);
  if (slashAt >= 0) return parseAlphaArg(body.slice(slashAt + 1));
  const parts = layers(body); // top-level comma split, parens respected.
  return parts.length >= 4 ? parseAlphaArg(parts[3]) : null;
}

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const COLOR_FN = /^([a-z-]+)\(([\s\S]*)\)$/i;

/**
 * Alpha of a colour token in `[0, 1]`. `transparent` and the literal `none`
 * are 0 (§3.4: neither paints); a hex short/long form with an alpha channel
 * reads it; every colour function (`rgb`, `rgba`, `hsl`, `hsla`, `oklch`,
 * `oklab`, `lab`, `lch`, `color`, …) reads its alpha argument, comma or slash
 * syntax, defaulting to 1 when none is given. Everything this cannot parse —
 * a bare keyword (`red`), `currentColor`, `var(--x)`, a colour space this
 * repo has never authored — is opaque: an unresolvable token is exactly the
 * case §3.1 says to treat as visible, never the reverse.
 */
export function alphaOf(token: string): number {
  const t = token.trim();
  if (!t) return 1;
  const lower = t.toLowerCase();
  if (lower === "transparent" || lower === "none") return 0;

  const hex = HEX_COLOR.exec(t);
  if (hex) {
    const h = hex[1];
    if (h.length === 4) return Number.parseInt(h[3] + h[3], 16) / 255;
    if (h.length === 8) return Number.parseInt(h.slice(6, 8), 16) / 255;
    return 1; // #rgb / #rrggbb carry no alpha channel.
  }

  const fn = COLOR_FN.exec(t);
  if (fn) {
    const alpha = alphaArgOf(fn[2]);
    return alpha === null ? 1 : alpha;
  }

  return 1;
}

// ---------------------------------------------------------------------------
// Interior — fillVisible (§3.1)
// ---------------------------------------------------------------------------

const IMAGE_TOKEN = /^(?:url|image-set|element)\(/i;
const GRADIENT_TOKEN = /^(?:repeating-)?(?:linear|radial|conic)-gradient\(/i;
/** The leading direction/shape argument a gradient's stop list may start
 *  with — dropped before reading the first stop's colour (§3.1's layer rule). */
const GRADIENT_DIRECTION =
  /^(to\s|from\s|at\s|in\s|circle|ellipse|closest|farthest|-?[\d.]+(deg|turn|rad|grad))/i;

/** `background`'s position/size/repeat/attachment/box keywords — never a
 *  paint, so a layer built only from these (plus, say, a colour) still reads
 *  the colour as the layer's paint rather than tripping over the keyword. */
const BG_KEYWORD = new Set([
  "repeat",
  "no-repeat",
  "repeat-x",
  "repeat-y",
  "space",
  "round",
  "center",
  "left",
  "right",
  "top",
  "bottom",
  "auto",
  "cover",
  "contain",
  "scroll",
  "fixed",
  "local",
  "border-box",
  "padding-box",
  "content-box",
  "text",
]);

/** A gradient token's stops, per §3.1: split its args at top-level commas,
 *  drop a leading direction, and read each stop's first word as its colour.
 *  Visible unless every stop is fully transparent; unreadable → visible. */
function gradientVisible(token: string): boolean {
  const open = token.indexOf("(");
  const close = token.lastIndexOf(")");
  if (open < 0 || close < open) return true;
  const args = layers(token.slice(open + 1, close));
  if (args.length === 0) return true;
  const stops = GRADIENT_DIRECTION.test(args[0].trim()) ? args.slice(1) : args;
  if (stops.length === 0) return true;
  for (const stop of stops) {
    const word = stop.trim().split(/\s+/)[0];
    if (!word || alphaOf(word) > 0) return true;
  }
  return false;
}

/** One `background`/`background-image` layer: visible when it carries an
 *  image (always — an image's alpha is unknowable here), a gradient with at
 *  least one non-transparent stop, or a colour token with `alphaOf > 0`. */
function layerVisible(layer: string): boolean {
  for (const token of words(layer)) {
    if (IMAGE_TOKEN.test(token)) return true;
    if (GRADIENT_TOKEN.test(token)) {
      if (gradientVisible(token)) return true;
      continue;
    }
    if (LENGTH.test(token) || token === "/" || BG_KEYWORD.has(token)) continue;
    const lower = token.toLowerCase();
    if (lower === "none" || lower === "transparent") continue;
    if (alphaOf(token) > 0) return true;
  }
  return false;
}

const anyLayerVisible = (css: string): boolean => layers(css).some(layerVisible);

/**
 * Whether the node's interior paints — the fill half of `paintedAt` (§2.1).
 *
 * `drawn = true` (path, boolean): follows `pathPaint`'s own reading exactly,
 * via `paintOf` — a gradient/picture kept as CSS applies the same stop rule
 * as a box's gradient; a colour fill is visible iff `alphaOf > 0`; nothing
 * authored (`paintOf(style).fill === null`) is not visible.
 *
 * `drawn = false` (rect, plain ellipse, group, text, image): any of
 * `background`, `background-color`, `background-image` being a visible layer
 * makes the interior paint — see the layer rule above. Three properties, not
 * one: `FillSection` writes the combined `background` shorthand, but a
 * hand-authored or agent-written document may use the longhands instead, and
 * both must still be clickable paint.
 */
export function fillVisible(style: StyleMap, drawn: boolean): boolean {
  if (drawn) {
    const paint = paintOf(style);
    if (paint.css !== null) return GRADIENT_TOKEN.test(paint.css) ? gradientVisible(paint.css) : true;
    if (paint.fill === null || paint.fill === "none") return false;
    return alphaOf(paint.fill) > 0;
  }
  if (style.background !== undefined && anyLayerVisible(style.background)) return true;
  const bgColor = style["background-color"];
  if (bgColor !== undefined) {
    const v = bgColor.trim();
    if (v !== "" && v !== "none" && v.toLowerCase() !== "transparent" && alphaOf(v) > 0) return true;
  }
  if (style["background-image"] !== undefined && anyLayerVisible(style["background-image"])) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Box rings — edgeBands (§3.2)
// ---------------------------------------------------------------------------

/** A painted ring around a box, as signed distances from the box edge
 *  (outward positive): the ring is `inner ≤ d ≤ outer`. */
export interface EdgeBand {
  inner: number;
  outer: number;
}

const EDGE_WIDTH_KEYWORDS: Record<string, number> = { thin: 1, medium: 3, thick: 5 };

interface EdgeRead {
  width: number;
  lineStyle: string | undefined;
  color: string | undefined;
}

/** `border` or `outline`, shorthand plus longhands (longhand wins — the
 *  deterministic rule `parsePadding` uses too, since `parseStyleAttr` loses
 *  the inline style's authored order). Width default is CSS's own initial,
 *  `medium` = 3px, applied only once no shorthand or longhand named one. */
function readEdge(style: StyleMap, prop: "border" | "outline"): EdgeRead {
  let width: string | undefined;
  let lineStyle: string | undefined;
  let color: string | undefined;
  for (const word of words(style[prop] ?? "")) {
    if (LENGTH.test(word) || word in EDGE_WIDTH_KEYWORDS) width ??= word;
    else if (LINE_STYLE.has(word)) lineStyle ??= word;
    else color ??= word;
  }
  const widthLonghand = style[`${prop}-width`];
  const styleLonghand = style[`${prop}-style`];
  const colorLonghand = style[`${prop}-color`];
  if (widthLonghand !== undefined) width = widthLonghand;
  if (styleLonghand !== undefined) lineStyle = styleLonghand;
  if (colorLonghand !== undefined) color = colorLonghand;

  const widthPx = width === undefined ? 3 : (EDGE_WIDTH_KEYWORDS[width] ?? Number.parseFloat(width));
  return { width: Number.isFinite(widthPx) ? widthPx : 3, lineStyle, color };
}

/** §3.2 steps 3–5: a line style of `none`/absent, an alpha-0 colour, or a
 *  non-positive width all mean the band paints nothing. An absent colour is
 *  `currentColor` — opaque, and visible. */
function edgeVisible(edge: EdgeRead): boolean {
  if (edge.width <= 0) return false;
  const lineStyle = edge.lineStyle ?? "none";
  if (lineStyle === "none" || lineStyle === "hidden") return false;
  if (edge.color !== undefined && alphaOf(edge.color) === 0) return false;
  return true;
}

/**
 * 0–2 bands — `border` and/or `outline`, only the visible ones — as signed
 * distances from the box edge. `outline-offset` (default 0) shifts the
 * outline band only; `border` always sits `[-width, 0]` (CSS draws it inside
 * the box).
 */
export function edgeBands(style: StyleMap): EdgeBand[] {
  const bands: EdgeBand[] = [];
  const border = readEdge(style, "border");
  if (edgeVisible(border)) bands.push({ inner: -border.width, outer: 0 });

  const outline = readEdge(style, "outline");
  if (edgeVisible(outline)) {
    const raw = style["outline-offset"];
    const parsed = raw !== undefined ? Number.parseFloat(raw) : 0;
    const offset = Number.isFinite(parsed) ? parsed : 0;
    bands.push({ inner: offset, outer: offset + outline.width });
  }
  return bands;
}

// ---------------------------------------------------------------------------
// Drawn strokes — drawnStrokeWidth (§3.3)
// ---------------------------------------------------------------------------

/**
 * The stroke width an SVG-drawn kind paints, in scene px; `null` when nothing
 * strokes. Reads `paintOf(style).attrs` — the renderer's own `strokeOf`
 * reading — so this can never disagree with what `pathPaint` puts on the
 * `<path>` element itself.
 *
 * For `path`/`group` (a boolean's derived drawing) only: when there is no
 * stroke **and** no fill was authored or translated at all — `paintOf(style)`
 * has both `css === null` and `fill` either `null` or the literal token
 * `"none"` — the renderer's own default-ink band applies
 * (`DRAWN_STROKE_WIDTH`). This is a **literal** check, matching `pathPaint`'s
 * `fillNow === undefined || fillNow === "none"` exactly, not `fillVisible`'s
 * alpha-aware one: an authored `fill: rgba(0,0,0,0)` is invisible paint by
 * §3.1's reading, but it is still *authored*, so `pathPaint` never adds its
 * own ink over it and this must not invent a phantom stroke there either
 * (§3.3's regression guard — see F5/F9/F10 in `scene/picking.test.ts`).
 */
export function drawnStrokeWidth(
  style: StyleMap,
  kind: "polygon" | "ellipse" | "path" | "group",
): number | null {
  const paint = paintOf(style);
  const { attrs } = paint;
  if (attrs.stroke && attrs.stroke !== "none" && alphaOf(attrs.stroke) > 0) {
    const w = Number.parseFloat(attrs.strokeWidth ?? "1");
    if (Number.isFinite(w) && w > 0) return w;
  }
  if (kind === "polygon" || kind === "ellipse") return null;
  if (paint.css === null && (paint.fill === null || paint.fill === "none")) {
    return Number.parseFloat(DRAWN_STROKE_WIDTH);
  }
  return null;
}
