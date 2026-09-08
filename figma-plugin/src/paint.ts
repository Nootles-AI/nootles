/**
 * Figma's paint onto the canvas's CSS.
 *
 * Everything here is a spelling decision, and the rule is the parity plan's:
 * native inline CSS wherever CSS has a word for it. A fill stack is a
 * `background` stack, a stroke is a `border` inside the box or an `outline`
 * astride or outside it (the same spelling the stroke panel writes), an
 * effect is a `box-shadow` or a `filter`, and a gradient is the CSS gradient
 * that draws the same picture — including the diamond, which is four linear
 * gradients rather than an approximation.
 */

import type { ColorStop, Effect, Paint, RGB, RGBA, Transform, Vec } from "./model";

export type Decls = Record<string, string>;

/** Finer than a screen shows, short enough to read in the document. */
export const round = (n: number, places = 2): number => {
  const k = 10 ** places;
  return Math.round(n * k) / k;
};

const px = (n: number) => `${round(n)}px`;

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, "0");

/** `#rrggbb` when opaque, `rgba()` otherwise: the forms the colour field reads. */
export function cssColor(color: RGB | RGBA, opacity = 1): string {
  const a = ("a" in color ? color.a : 1) * opacity;
  const hex = `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}`;
  if (a >= 0.999) return hex;
  return `rgba(${Math.round(color.r * 255)}, ${Math.round(color.g * 255)}, ${Math.round(color.b * 255)}, ${round(a, 3)})`;
}

const visible = (paint: { visible?: boolean }) => paint.visible !== false;

// ---------------------------------------------------------------------------
// Gradients
// ---------------------------------------------------------------------------

/**
 * Where the gradient's handles sit, in the node's normalised space.
 *
 * `gradientTransform` maps the node's unit square into gradient space, so the
 * handles — the gradient's own (0, ½) start, (1, ½) end and (½, 1) width — are
 * found by inverting it. The identity is a left-to-right gradient; Figma's
 * default top-to-bottom one arrives as a quarter turn.
 */
function handles(t: Transform | undefined): { start: Vec; end: Vec; side: Vec } {
  const [[a, b, tx], [c, d, ty]] = t ?? [[1, 0, 0], [0, 1, 0]];
  const det = a * d - b * c || 1e-9;
  const inv = (p: Vec): Vec => {
    const x = p.x - tx;
    const y = p.y - ty;
    return { x: (d * x - b * y) / det, y: (-c * x + a * y) / det };
  };
  return { start: inv({ x: 0, y: 0.5 }), end: inv({ x: 1, y: 0.5 }), side: inv({ x: 0.5, y: 1 }) };
}

/** CSS's angle: 0 points up, 90 right. From a direction in px, y down. */
function cssAngle(dx: number, dy: number): number {
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return round((deg + 360) % 360, 1);
}

function stops(list: ColorStop[] | undefined, opacity: number): string {
  return (list ?? [])
    .map((stop) => `${cssColor(stop.color, opacity)} ${round(stop.position * 100, 1)}%`)
    .join(", ");
}

const pct = (n: number) => `${round(n * 100, 1)}%`;

/**
 * One gradient paint as the CSS layer that draws it. Rotation is exact; the
 * handles' offset and stretch are the parity plan's next row and are not
 * carried yet.
 */
export function gradientLayer(paint: Paint, w: number, h: number): string | null {
  const opacity = paint.opacity ?? 1;
  const list = stops(paint.gradientStops, opacity);
  if (!list) return null;
  const { start, end, side } = handles(paint.gradientTransform);
  const dx = (end.x - start.x) * w;
  const dy = (end.y - start.y) * h;
  switch (paint.type) {
    case "GRADIENT_LINEAR":
      return `linear-gradient(${cssAngle(dx, dy)}deg, ${list})`;
    case "GRADIENT_RADIAL": {
      const rx = Math.max(1, Math.hypot(dx, dy));
      const ry = Math.max(1, Math.hypot((side.x - start.x) * w, (side.y - start.y) * h));
      return `radial-gradient(${px(rx)} ${px(ry)} at ${pct(start.x)} ${pct(start.y)}, ${list})`;
    }
    case "GRADIENT_ANGULAR":
      return `conic-gradient(from ${cssAngle(dx, dy)}deg at ${pct(start.x)} ${pct(start.y)}, ${list})`;
    case "GRADIENT_DIAMOND":
      // A diamond's iso-lines are 45° lines in each quadrant, so one linear
      // gradient per quadrant, run from the centre out to its corner, is the
      // same picture in native CSS. Written as four layers of one background.
      return [
        `linear-gradient(to top right, ${list}) 100% 0 / 50% 50% no-repeat`,
        `linear-gradient(to top left, ${list}) 0 0 / 50% 50% no-repeat`,
        `linear-gradient(to bottom right, ${list}) 100% 100% / 50% 50% no-repeat`,
        `linear-gradient(to bottom left, ${list}) 0 100% / 50% 50% no-repeat`,
      ].join(", ");
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

export type ImageLayer = { hash: string; mode: NonNullable<Paint["scaleMode"]>; opacity: number };

/**
 * A fill stack as `background` layers, top first — Figma paints index 0 at
 * the bottom, CSS lists the top layer first. Image fills are handed back for
 * the caller to resolve, since bytes are the plugin's to fetch, and their
 * layer is written with a placeholder the caller fills in.
 */
export function backgroundOf(
  fills: Paint[],
  w: number,
  h: number,
  image: (layer: ImageLayer) => string | null,
): string | undefined {
  const layers: string[] = [];
  const shown = fills.filter(visible);
  shown
    .slice()
    .reverse()
    .forEach((paint, index) => {
      const last = index === shown.length - 1;
      const opacity = paint.opacity ?? 1;
      if (paint.type === "SOLID" && paint.color) {
        const color = cssColor(paint.color, opacity);
        // Only the bottom layer may be a bare colour; a solid riding above
        // another layer is spelled as a flat gradient, as the fill panel does.
        layers.push(last ? color : `linear-gradient(${color}, ${color})`);
        return;
      }
      if (paint.type.startsWith("GRADIENT_")) {
        const layer = gradientLayer(paint, w, h);
        if (layer) layers.push(layer);
        return;
      }
      if (paint.type === "IMAGE" && paint.imageHash) {
        const src = image({ hash: paint.imageHash, mode: paint.scaleMode ?? "FILL", opacity });
        if (!src) return;
        const size =
          paint.scaleMode === "FIT" ? "contain" : paint.scaleMode === "TILE" ? "auto" : "cover";
        const repeat = paint.scaleMode === "TILE" ? "repeat" : "no-repeat";
        layers.push(`url("${src}") center / ${size} ${repeat}`);
      }
    });
  return layers.length ? layers.join(", ") : undefined;
}

// ---------------------------------------------------------------------------
// Strokes
// ---------------------------------------------------------------------------

/**
 * The first visible solid stroke, spelled the way the stroke panel spells a
 * position: inside is a `border`, outside an `outline`, centre an outline
 * pulled back by half its weight.
 */
export function strokeDecls(
  strokes: Paint[] | undefined,
  weight: number | undefined,
  align: "INSIDE" | "OUTSIDE" | "CENTER" | undefined,
  dash: number[] | undefined,
): Decls {
  const stroke = (strokes ?? []).find((s) => visible(s) && s.type === "SOLID" && s.color);
  if (!stroke || !stroke.color || !weight || weight <= 0) return {};
  const color = cssColor(stroke.color, stroke.opacity ?? 1);
  const style = dash && dash.length ? "dashed" : "solid";
  const value = `${px(weight)} ${style} ${color}`;
  if (align === "OUTSIDE") return { outline: value };
  if (align === "CENTER") return { outline: value, "outline-offset": px(-weight / 2) };
  return { border: value };
}

/** A path's own paint: SVG's words, on the element that is the path. */
export function pathPaintDecls(
  fills: Paint[],
  strokes: Paint[] | undefined,
  weight: number | undefined,
  dash: number[] | undefined,
  cap: string | undefined,
  join: string | undefined,
): Decls {
  const out: Decls = {};
  const fill = fills.find((f) => visible(f) && f.type === "SOLID" && f.color);
  out.fill = fill && fill.color ? cssColor(fill.color, fill.opacity ?? 1) : "none";
  const stroke = (strokes ?? []).find((s) => visible(s) && s.type === "SOLID" && s.color);
  if (stroke && stroke.color && weight) {
    out.stroke = cssColor(stroke.color, stroke.opacity ?? 1);
    out["stroke-width"] = String(round(weight));
    if (dash && dash.length) out["stroke-dasharray"] = dash.map((n) => round(n)).join(" ");
    const caps: Record<string, string> = { ROUND: "round", SQUARE: "square" };
    if (cap && caps[cap]) out["stroke-linecap"] = caps[cap];
    const joins: Record<string, string> = { ROUND: "round", BEVEL: "bevel" };
    if (join && joins[join]) out["stroke-linejoin"] = joins[join];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Effects, radius, compositing
// ---------------------------------------------------------------------------

export function effectDecls(effects: Effect[] | undefined): Decls {
  const shadows: string[] = [];
  const filters: string[] = [];
  const backdrop: string[] = [];
  for (const effect of effects ?? []) {
    if (!visible(effect)) continue;
    switch (effect.type) {
      case "DROP_SHADOW":
      case "INNER_SHADOW": {
        const color = effect.color ? cssColor(effect.color) : "rgba(0, 0, 0, 0.25)";
        const { x, y } = effect.offset ?? { x: 0, y: 0 };
        const inset = effect.type === "INNER_SHADOW" ? "inset " : "";
        shadows.push(`${inset}${px(x)} ${px(y)} ${px(effect.radius)} ${px(effect.spread ?? 0)} ${color}`);
        break;
      }
      case "LAYER_BLUR":
        filters.push(`blur(${px(effect.radius / 2)})`);
        break;
      case "BACKGROUND_BLUR":
        backdrop.push(`blur(${px(effect.radius / 2)})`);
        break;
    }
  }
  const out: Decls = {};
  // Figma lists the top effect first; CSS draws the first shadow on top too.
  if (shadows.length) out["box-shadow"] = shadows.join(", ");
  if (filters.length) out.filter = filters.join(" ");
  if (backdrop.length) out["backdrop-filter"] = backdrop.join(" ");
  return out;
}

export function radiusDecls(node: {
  cornerRadius?: number | symbol;
  topLeftRadius?: number;
  topRightRadius?: number;
  bottomRightRadius?: number;
  bottomLeftRadius?: number;
}): Decls {
  if (typeof node.cornerRadius === "number") {
    return node.cornerRadius > 0 ? { "border-radius": px(node.cornerRadius) } : {};
  }
  const corners = [
    node.topLeftRadius ?? 0,
    node.topRightRadius ?? 0,
    node.bottomRightRadius ?? 0,
    node.bottomLeftRadius ?? 0,
  ];
  if (corners.every((c) => c === 0)) return {};
  return { "border-radius": corners.map(px).join(" ") };
}

const BLEND: Record<string, string> = {
  MULTIPLY: "multiply",
  SCREEN: "screen",
  OVERLAY: "overlay",
  DARKEN: "darken",
  LIGHTEN: "lighten",
  COLOR_DODGE: "color-dodge",
  COLOR_BURN: "color-burn",
  HARD_LIGHT: "hard-light",
  SOFT_LIGHT: "soft-light",
  DIFFERENCE: "difference",
  EXCLUSION: "exclusion",
  HUE: "hue",
  SATURATION: "saturation",
  COLOR: "color",
  LUMINOSITY: "luminosity",
};

export function compositeDecls(node: { opacity?: number; blendMode?: string }): Decls {
  const out: Decls = {};
  if (node.opacity !== undefined && node.opacity < 1) out.opacity = String(round(node.opacity, 3));
  const blend = node.blendMode ? BLEND[node.blendMode] : undefined;
  if (blend) out["mix-blend-mode"] = blend;
  return out;
}
