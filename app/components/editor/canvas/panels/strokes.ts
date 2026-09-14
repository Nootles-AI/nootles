/**
 * The box `border`/`outline` (and drawn-kind `stroke`) model, extracted.
 *
 * Same reasoning as `panels/fills.ts`'s header: this used to be private to
 * `sections/StrokeSection.tsx`, and `scene/paintAt.ts` (COLOR's eyedropper
 * reader) needs the identical classification of "what does this node's ring
 * actually look like" — colour, width, alignment — so a pick on a border and
 * the panel's own swatch never disagree about what colour it is.
 */

import type { SceneNode, StyleMap } from "../scene/types";
import { isBoolean } from "../scene/types";
import { parseComposite, serializeComposite } from "./cssCatalog";

export type Dash = "solid" | "dashed" | "dotted";
export type Position = "inside" | "center" | "outside";
export type Stroke = { color: string; width: number; dash: Dash; position: Position };

export const DEFAULT_STROKE: Stroke = {
  color: "#111111",
  width: 1,
  dash: "solid",
  position: "inside",
};

export const DASHARRAY: Record<Dash, string> = {
  solid: "none",
  dashed: "8 6",
  dotted: "2 4",
};

export const EDGES = ["width", "style", "color"] as const;

// Every spelling of a box stroke, so writing one never leaves half of another
// behind for the cascade to resolve in the panel's favour or against it.
export const BOX_PROPS = [
  "border",
  "outline",
  "outline-offset",
  ...EDGES.flatMap((part) => [`border-${part}`, `outline-${part}`]),
];
export const PATH_PROPS = ["stroke", "stroke-width", "stroke-dasharray", "stroke-linecap"];

export const dashOf = (value: string | undefined): Dash =>
  value === DASHARRAY.dashed ? "dashed" : value === DASHARRAY.dotted ? "dotted" : "solid";

export const styleOf = (value: string | undefined): Dash =>
  value === "dashed" ? "dashed" : value === "dotted" ? "dotted" : "solid";

/** The shorthand as authored, or the same stroke spelled as longhands — which
 *  is what a model reaching for `border-width` writes. */
export function shorthandOf(style: StyleMap, prop: "border" | "outline"): string | undefined {
  const parts = EDGES.map((part) => style[`${prop}-${part}`]).filter(Boolean);
  return style[prop] ?? (parts.length ? parts.join(" ") : undefined);
}

/** Drawn as a path, so painted as one: a pen path or a boolean group. */
export const drawn = (node: SceneNode): boolean => node.kind === "path" || isBoolean(node);

export function readStroke(node: SceneNode): Stroke | null {
  if (drawn(node)) {
    const color = node.style.stroke;
    if (!color || color === "none") return null;
    const width = Number.parseFloat(node.style["stroke-width"] ?? "");
    return {
      color,
      width: Number.isFinite(width) ? width : 1,
      dash: dashOf(node.style["stroke-dasharray"]),
      position: "center",
    };
  }
  const outline = shorthandOf(node.style, "outline");
  const source = outline ?? shorthandOf(node.style, "border");
  if (!source) return null;
  // `border` and `outline` are the same shorthand grammar, so the catalogue's
  // border parser reads either one.
  const parts = parseComposite("border", source).values;
  const width = Number.parseFloat(parts["border-width"] ?? "");
  // A zero-weight stroke is still a stroke: it keeps its colour, and the field
  // it was scrubbed down to zero in is the one that scrubs it back up. Only
  // the remove button takes it away.
  if (!Number.isFinite(width)) return null;
  return {
    color: parts["border-color"] ?? "#000000",
    width,
    dash: styleOf(parts["border-style"]),
    position: outline
      ? Number.parseFloat(node.style["outline-offset"] ?? "0") < 0
        ? "center"
        : "outside"
      : "inside",
  };
}

export function writeStroke(node: SceneNode, stroke: Stroke | null): StyleMap {
  const style = { ...node.style };
  const path = drawn(node);
  for (const prop of path ? PATH_PROPS : BOX_PROPS) delete style[prop];
  if (!stroke) return style;

  if (path) {
    // An SVG stroke is always centred on the path, so alignment says nothing here.
    style.stroke = stroke.color;
    style["stroke-width"] = String(stroke.width);
    if (stroke.dash !== "solid") style["stroke-dasharray"] = DASHARRAY[stroke.dash];
    return style;
  }

  const value = serializeComposite("border", {
    values: {
      "border-width": `${stroke.width}px`,
      "border-style": stroke.dash,
      "border-color": stroke.color,
    },
  });

  // CSS has no stroke position, so the three are mapped onto the two things
  // CSS does have. A `border` is drawn inside the box, and an `outline` is
  // drawn outside it, taking no space at all. Centre is that outline pulled
  // back by half its weight, which leaves it straddling the edge.
  if (stroke.position === "inside") {
    style.border = value;
  } else {
    style.outline = value;
    if (stroke.position === "center") style["outline-offset"] = `${-stroke.width / 2}px`;
  }
  return style;
}
