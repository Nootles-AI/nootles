/**
 * The zoom tool (Z) — the pure decision behind a click, an Alt-click and a
 * drag. `render/CanvasSurface.tsx` supplies the points (already converted
 * through `clientToScene`/the container rect) and applies the result through
 * `ViewportController.zoomBy`/`zoomToFit`; nothing here touches the DOM or the
 * viewport, which is what makes it worth testing on its own.
 */

import { normalizeRect } from "../scene/geometry";
import type { Point, Rect } from "../scene/types";

/** Figma's own doubling stops, verified against figma.com (§7.3 of STAGE.md). */
export const ZOOM_TOOL_FACTOR = 2;

/** Screen px of travel below which a press is a click. */
export const ZOOM_DRAG_MIN = 4;

export type ZoomToolResult =
  | { kind: "by"; factor: number; anchor: Point }
  | { kind: "fit"; rect: Rect }
  | { kind: "none" };

/**
 * Pure. `down`/`up` are viewport px; `fromScene`/`toScene` the same two points
 * in scene px; `alt` is read at release. A travel under {@link ZOOM_DRAG_MIN}
 * is a click: zoom by the factor (÷ when alt) about the press. Otherwise the
 * normalised scene rect; a rect under 1×1 scene px is "none".
 */
export function zoomToolResult(g: {
  down: Point;
  up: Point;
  fromScene: Point;
  toScene: Point;
  alt: boolean;
}): ZoomToolResult {
  const travel = Math.hypot(g.up.x - g.down.x, g.up.y - g.down.y);
  if (travel < ZOOM_DRAG_MIN) {
    return {
      kind: "by",
      factor: g.alt ? 1 / ZOOM_TOOL_FACTOR : ZOOM_TOOL_FACTOR,
      anchor: g.down,
    };
  }
  const rect = normalizeRect(g.fromScene, g.toScene);
  if (rect.w < 1 || rect.h < 1) return { kind: "none" };
  return { kind: "fit", rect };
}
