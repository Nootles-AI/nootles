/**
 * The box `background` model, extracted.
 *
 * This used to live entirely inside `sections/FillSection.tsx` as module-
 * private functions — fine while only the fill row itself needed to know what
 * a "fill" is, but `scene/paintAt.ts` (the eyedropper's authored-value reader,
 * COLOR) needs the exact same classification: whether the front layer of a
 * `background` stack is a solid, a gradient or an image, whether it is
 * visible, what colour it actually is. Two independently written readers of
 * the same CSS is how a picked colour and the panel's own swatch quietly
 * disagree (`scene/picking.ts`'s module header makes the identical argument
 * for hit-testing) — so this is the one copy, imported by both.
 *
 * Every function here is pure: no React, no Convex, no DOM. `FillSection.tsx`
 * renders with these; `scene/paintAt.ts` reads with them. A cross-check test
 * in `scene/paintAt.test.ts` fails if either file grows a second copy.
 */

import { parseColor, withAlpha } from "./controls/color";
import { formatGradient, parseGradient, type Gradient } from "./controls/gradient";
import { parseLayers, serializeLayers, type Layer } from "./cssCatalog";
import { refName } from "./colorVariables";

export type FillType = "solid" | "linear" | "radial" | "image";

/**
 * One entry of the `background` stack as the panel edits it. `paint` is a
 * colour, a gradient or a `url()` according to `type`; `layer` carries the
 * rest of that layer's declarations — position, size, repeat, anything
 * unrecognised — so editing the paint never drops them.
 */
export type Fill = { type: FillType; paint: string; layer: Layer };

export const IMAGE = "background-image";
export const COLOR = "background-color";
export const POSITION = "background-position";
export const SIZE = "background-size";
export const REPEAT = "background-repeat";
export const DEFAULT_PAINT = "#d4d4d8";

export const isFlat = (g: Gradient): boolean =>
  g.stops.length === 2 && g.stops[0].color === g.stops[1].color;

/** Bound to a colour variable, so its alpha is the variable's to give. */
export const isBound = (fill: Fill): boolean =>
  fill.type === "solid"
    ? refName(fill.paint) !== null
    : fill.type !== "image" &&
      (parseGradient(fill.paint)?.stops.some((s) => refName(s.color) !== null) ??
        false);

export const srcOf = (paint: string): string =>
  paint.replace(/^url\(\s*["']?|["']?\s*\)$/g, "");
export const toUrl = (src: string): string => `url("${src.replace(/"/g, "%22")}")`;

export function readFill(layer: Layer): Fill {
  const image = layer.values[IMAGE];
  if (image && image !== "none") {
    if (/^(url|image-set)\(/i.test(image)) return { type: "image", paint: image, layer };
    const g = parseGradient(image);
    // A two-stop gradient of one colour is how a solid rides above another
    // layer (see toLayer); read it back as the solid it is.
    if (g && isFlat(g)) return { type: "solid", paint: g.stops[0].color, layer };
    return {
      type: g?.kind === "radial" ? "radial" : "linear",
      paint: image,
      layer,
    };
  }
  return { type: "solid", paint: layer.values[COLOR] ?? "", layer };
}

/**
 * Fills serialize front-first, which is CSS's own layer order. CSS keeps its
 * one `background-color` behind every image though, so only the backmost
 * fill can be a bare colour; a solid above one is written as a two-stop
 * gradient of itself, which {@link readFill} reads back as that same solid.
 */
export function toLayer({ type, paint, layer }: Fill, last: boolean): Layer {
  const values = { ...layer.values };
  delete values[IMAGE];
  if (!last) delete values[COLOR];
  if (type !== "solid") values[IMAGE] = paint;
  else if (last) values[COLOR] = paint;
  else values[IMAGE] = `linear-gradient(${paint}, ${paint})`;
  return { ...layer, values };
}

/** CSS has no per-layer opacity, so a fill's opacity is its paint's alpha —
 *  and hiding a fill is that alpha at zero, which keeps the colour. An image
 *  has no alpha to set, so it has neither control. */
export function opacityOf({ type, paint }: Fill): number {
  if (type === "image") return 1;
  const colour = type === "solid" ? paint : (parseGradient(paint)?.stops[0].color ?? "");
  return parseColor(colour)?.a ?? 1;
}

export function withOpacity(fill: Fill, a: number): Fill {
  if (fill.type === "image") return fill;
  if (fill.type === "solid") return { ...fill, paint: withAlpha(fill.paint, a) };
  const g = parseGradient(fill.paint);
  if (!g) return fill;
  const stops = g.stops.map((s) => ({ ...s, color: withAlpha(s.color, a) }));
  return { ...fill, paint: formatGradient({ ...g, stops }) };
}

export function convert(fill: Fill, type: FillType): Fill {
  const values = fill.layer.values;
  if (type === "image")
    return {
      type,
      paint: 'url("")',
      layer: {
        ...fill.layer,
        values: {
          ...values,
          [POSITION]: values[POSITION] ?? "center",
          [SIZE]: values[SIZE] ?? "cover",
          [REPEAT]: values[REPEAT] ?? "no-repeat",
        },
      },
    };
  const g = fill.type === "linear" || fill.type === "radial" ? parseGradient(fill.paint) : null;
  const colour =
    (g ? g.stops[0].color : fill.type === "solid" ? fill.paint : "") || DEFAULT_PAINT;
  if (type === "solid") return { ...fill, type, paint: colour };
  const stops = g?.stops ?? [
    { color: colour, pos: 0 },
    // A reference has no alpha of its own to fade, so the fade is CSS's.
    { color: refName(colour) ? "transparent" : withAlpha(colour, 0), pos: 1 },
  ];
  return {
    ...fill,
    type,
    paint: formatGradient({ kind: type, angle: g?.angle ?? 135, stops }),
  };
}

export const readFills = (background: string | undefined): Fill[] =>
  parseLayers("background", background).map(readFill);

export const writeFills = (fills: Fill[]): string | undefined =>
  serializeLayers(
    "background",
    fills.map((fill, i) => toLayer(fill, i === fills.length - 1)),
  ) || undefined;
