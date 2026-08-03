/**
 * What a shape tool makes.
 *
 * The look is literal CSS because the grammar has no classes. A drawn shape is
 * bare — one flat fill, no stroke, no shadow — and from there Figma's rule
 * takes over: the last look you applied is the look the next shape is drawn
 * with. The sizes are the old canvas's, so a shape drawn today and a shape
 * `scene/migrate.ts` brought forward still sit on the same grid.
 */

import type { NodeId, Rect, SceneNode, StyleMap, StylePatch } from "../scene/types";

/**
 * The kinds a pointer tool draws. Paths come from the pen, groups from ⌘G.
 *
 * `diamond` is a tool rather than a kind: it draws an `<nt-polygon sides="4">`,
 * so the side count stays editable and a diamond can become a pentagon without
 * the shape being rebuilt.
 */
export type DrawKind = "rect" | "ellipse" | "text" | "polygon" | "diamond";

const CENTRED: StyleMap = {
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  "text-align": "center",
  color: "oklch(0.25 0.005 90)",
  "font-size": "13px",
};

// A shape with no stroke has to carry its own contrast, so the fill is a light
// neutral rather than the canvas's white.
const BOX: StyleMap = { background: "oklch(0.93 0.003 90)", ...CENTRED };

const STYLE: Record<DrawKind, StyleMap> = {
  rect: BOX,
  ellipse: BOX,
  polygon: BOX,
  diamond: BOX,
  text: { ...CENTRED, "font-size": "14px", "font-weight": "450" },
};

const SIZE: Record<DrawKind, { w: number; h: number }> = {
  rect: { w: 148, h: 64 },
  ellipse: { w: 140, h: 96 },
  // Near-equilateral, so a clicked triangle looks drawn rather than squashed.
  polygon: { w: 120, h: 104 },
  // The flowchart decision box, wider than it is tall like the old one.
  diamond: { w: 140, h: 96 },
  text: { w: 120, h: 40 },
};

/** Appearance a new shape can wear: stroke and colour, nothing else. Geometry,
 *  layout and typography belong to the drawing rather than to the style, and a
 *  shadow or a blend mode is a decision about one shape, not a running default. */
const STICKY = ["background", "border", "outline", "color", "fill", "stroke"];

/** Corner radius rides in on the `border-` prefix, and inheriting it means one
 *  stray radius drag rounds every shape drawn afterwards. */
const NEVER_STICKY = (prop: string) => prop.includes("radius");

/** Paint that only means anything on a box. */
const BOX_PAINT = ["background", "border", "outline", "box-shadow", "fill", "stroke"];

const matches = (props: readonly string[], prop: string) =>
  props.some((p) => prop === p || prop.startsWith(`${p}-`));

/** What a kind refuses to inherit: a text tool draws a label rather than a box,
 *  and an ellipse's roundness is its shape rather than a remembered corner. */
const noRadius = (prop: string) => prop.includes("radius");

const REJECT: Record<DrawKind, (prop: string) => boolean> = {
  rect: () => false,
  ellipse: noRadius,
  polygon: noRadius,
  diamond: noRadius,
  text: (prop) => prop.includes("radius") || matches(BOX_PAINT, prop),
};

/** Session-scoped, like Figma's — deliberately not persisted. */
const sticky: StylePatch = {};

/**
 * Every style declaration the user applies to a selection passes through here,
 * and the ones a new shape can wear are kept. `undefined` is a removal in a
 * {@link StylePatch} and is remembered as one: dropping a stroke means the next
 * shape has none either.
 */
export function rememberStyle(decls: StylePatch): void {
  for (const prop in decls) {
    if (!NEVER_STICKY(prop) && matches(STICKY, prop)) sticky[prop] = decls[prop];
  }
}

function styleFor(kind: DrawKind): StyleMap {
  const style = { ...STYLE[kind] };
  for (const prop in sticky) {
    if (REJECT[kind](prop)) continue;
    const value = sticky[prop];
    if (value === undefined) delete style[prop];
    else style[prop] = value;
  }
  return style;
}

/** The box a *clicked* shape gets, centred on the pointer. */
export function defaultBox(kind: DrawKind, at: { x: number; y: number }): Rect {
  const { w, h } = SIZE[kind];
  return { x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), w, h };
}

export function newNode(kind: DrawKind, id: NodeId, box: Rect): SceneNode {
  const base = {
    id,
    ...box,
    rot: 0,
    style: styleFor(kind),
    label: "",
    locked: false,
    hidden: false,
    attrs: {},
  };
  // Spread-with-a-union `kind` is not assignable to a discriminated union;
  // literal returns are, and cost nothing.
  switch (kind) {
    case "rect":
      return { ...base, kind: "rect" };
    // No `start`/`sweep`/`inner`: a drawn ellipse is a plain one, and the arc
    // controls add those fields only once the user asks for them.
    case "ellipse":
      return { ...base, kind: "ellipse" };
    case "polygon":
      return { ...base, kind: "polygon", sides: 3 };
    case "diamond":
      return { ...base, kind: "polygon", sides: 4 };
    case "text":
      return { ...base, kind: "text" };
  }
}
