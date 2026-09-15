import type { CSSProperties } from "react";
import type { GroupLayout, SceneNode, StyleMap } from "./types";

/**
 * The box, as declarations — pure geometry-and-paint decisions moved out of
 * `render/ShapeView.tsx` (COMPILE, build-plan §1.1) so `app/lib/ai/html/toHtml.ts`
 * can share exactly this reading of a node's box without importing a
 * `"use client"` React module. Everything here is the renderer's own logic,
 * unchanged: `render/ShapeView.tsx` re-exports `isAutoSize`, `type Flow` and
 * `toCss` for its existing callers, and reads `flowFor`/`labelInsetOf`/
 * `LABEL_OWNED` from here directly. The compiler reads the same functions so a
 * diamond's label inset and a hugging child's `flex: none` are one decision,
 * not two that could quietly drift.
 */

/**
 * How an enclosing group places this node. Absent means absolute positioning at
 * the node's own `x`/`y`; the `stretch-*` forms leave one axis to CSS, because
 * that is the axis a stretching parent resolves for itself in
 * `scene/autoLayout`.
 *
 * A string rather than the parent's `GroupLayout`, so that a group re-rendering
 * does not hand every child a freshly allocated object and defeat the memo.
 */
export type Flow = "flow" | "stretch-x" | "stretch-y";

/** Declarations the label element paints rather than the box. */
export const LABEL_OWNED: ReadonlySet<string> = new Set(["-webkit-line-clamp"]);

const AUTO_SIZE = new Set(["max-content", "min-content", "fit-content", "auto"]);

/** True for the `width`/`height` keywords that hand sizing to the contents. */
export function isAutoSize(value: string | undefined): boolean {
  return value !== undefined && AUTO_SIZE.has(value.trim().toLowerCase());
}

/**
 * A diamond's edges cross the box's corners, so text laid out to the box runs
 * off the shape and into the clip. The inscribed rectangle of a rhombus whose
 * vertices sit at the box's edge midpoints is exactly the central half of each
 * axis, so a quarter-inset per side keeps every line of the label on the
 * shape. Only when the author has not said otherwise: an explicit padding in
 * the node's style wins. `null` when no inset applies, so a caller can spread
 * `{ padding: … }` in only when this is non-null rather than always writing
 * the property.
 */
export function labelInsetOf(node: SceneNode): string | null {
  if (node.kind !== "polygon" || Math.round(node.sides) !== 4) return null;
  for (const prop in node.style) {
    if (prop.startsWith("padding")) return null;
  }
  return `${node.h / 4}px ${node.w / 4}px`;
}

/**
 * An auto-layout group sets real `display: flex`/`grid` and lets the browser
 * place its children; a plain group positions them absolutely. That split is the
 * whole trick — one layout engine for the paint (CSS) and a model of the same
 * rules in `scene/autoLayout` for hit-testing, kept in step by both reading the
 * one `style`.
 */
export function flowFor(layout: GroupLayout): Flow | undefined {
  if (layout.mode === "none") return undefined;
  if (layout.alignItems !== "stretch") return "flow";
  return layout.mode === "flex" && layout.flexDirection.startsWith("column")
    ? "stretch-x"
    : "stretch-y";
}

const CAMEL = new Map<string, string>();

/** `border-radius` → `borderRadius`; `--brand` and `-webkit-*` are handled too. */
export function cssKey(prop: string): string {
  let key = CAMEL.get(prop);
  if (key === undefined) {
    key = prop.startsWith("--")
      ? prop
      : prop.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
    CAMEL.set(prop, key);
  }
  return key;
}

export function toCss(
  style: StyleMap,
  drop?: (prop: string) => boolean,
): CSSProperties {
  const out: Record<string, string> = {};
  for (const prop in style) {
    if (!drop?.(prop)) out[cssKey(prop)] = style[prop];
  }
  return out as CSSProperties;
}
