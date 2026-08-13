/**
 * What a node's paint looks like k times bigger — the half of a uniform scale
 * that is not geometry.
 *
 * Dragging a handle changes a box and leaves everything drawn on it alone; that
 * is a resize, and it is why a shape blown up to twice the size keeps a hairline
 * border and 13px text. A scale is the *same picture* at another size, so the
 * lengths in the style have to travel with the box: the stroke it is drawn with,
 * the radius of its corners, the size of its label, the padding a group lays its
 * children out with.
 *
 * **Only `px` scales.** A `%` or an `em` is already relative to something that
 * scaled, a `deg` is not a length at all, and a unitless `line-height` is a
 * multiple rather than a size. Matching the unit rather than the number is also
 * what keeps the `583` inside `border: 3px solid #583a32` from being mistaken
 * for one. SVG's presentation attributes are the exception the rule needs:
 * `stroke-width: 20` really is twenty user units, so those scale bare numbers
 * too.
 */

import { DEFAULT_FONT_SIZE, hasText, type SceneNode, type StyleMap } from "./types";

const SIDES = ["top", "right", "bottom", "left"];
const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"];

/** Declarations whose lengths are part of the drawing rather than of the box. */
const SCALED = new Set([
  "border",
  "border-width",
  "outline",
  "outline-width",
  "outline-offset",
  "border-radius",
  "font-size",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "padding",
  "gap",
  "row-gap",
  "column-gap",
  "box-shadow",
  "text-shadow",
  "filter",
  "backdrop-filter",
  ...SIDES.flatMap((side) => [
    `border-${side}`,
    `border-${side}-width`,
    `padding-${side}`,
  ]),
  ...CORNERS.map((corner) => `border-${corner}-radius`),
]);

/** SVG paint, where a number with no unit is still a length. */
const UNITLESS = new Set([
  "stroke-width",
  "stroke-dasharray",
  "stroke-dashoffset",
]);

const PX = /(-?(?:\d+\.?\d*|\.\d+))px/g;
const LENGTH = /-?(?:\d+\.?\d*|\.\d+)(px)?/g;

/** Finer than a screen can show, short enough to read in the serialized document. */
const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * A node's `style`, scaled by `k`.
 *
 * The node itself is here for its label: text with no `font-size` of its own is
 * drawn at the size it inherits, so scaling only what was authored would leave
 * it behind at its old size inside a shape that grew around it. Writing the size
 * it was already being drawn at is what keeps the picture whole — and it is the
 * number the style panel has always shown for that field.
 */
export function scaledStyle(node: SceneNode, k: number): StyleMap {
  const style = node.style;
  let out: StyleMap | null = null;

  for (const prop of Object.keys(style)) {
    const bare = UNITLESS.has(prop);
    if (!bare && !SCALED.has(prop)) continue;
    const value = style[prop];
    const next = bare
      ? value.replace(
          LENGTH,
          (match, unit: string | undefined) =>
            `${round(Number.parseFloat(match) * k)}${unit ?? ""}`,
        )
      : value.replace(PX, (_, length: string) => `${round(Number(length) * k)}px`);
    if (next === value) continue;
    out ??= { ...style };
    out[prop] = next;
  }

  if (style["font-size"] === undefined && rendersText(node)) {
    out ??= { ...style };
    out["font-size"] = `${round(DEFAULT_FONT_SIZE * k)}px`;
  }

  return out ?? style;
}

/** Has text on screen right now — a text node is one even while it is empty. */
function rendersText(node: SceneNode): boolean {
  return hasText(node) && (node.kind === "text" || node.label.trim() !== "");
}
