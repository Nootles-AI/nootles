import { COLUMN_WIDTH } from "@/app/lib/column";
import { laidOutScene } from "./autoLayout";
import { edgePoints } from "./edgePath";
import { nodeBounds } from "./geometry";
import type { Scene } from "./types";

/**
 * The band's measurements, apart from `./band` because they need no op: the
 * align maths reads them, the ops applier reads that, and `./band` fits
 * scenes through the applier — so drawing them from `./band` would close a
 * loop through module evaluation. Import them from `./band`.
 */

/** Room above the first shape and below the lowest, in px. */
export const BAND = 24;
/** A wide band's width, centred on the column. */
export const WIDE_W = 1200;
/** How far a wide band reaches past the column on each side. */
export const WIDE_MARGIN = (WIDE_W - COLUMN_WIDTH) / 2;
/** An empty band: one line of body text and a band either side of it. */
export const EMPTY_BAND_H = 26 + 2 * BAND;

/** Below this, two coordinates are the same place — fitting must not chase float error. */
export const EPS = 1e-6;

/** The band's left edge in scene px: the column's, or the wide margin past it. */
export function bandLeft(scene: { wide?: boolean }): number {
  return scene.wide ? -WIDE_MARGIN : 0;
}

export function bandWidth(scene: { wide?: boolean }): number {
  return scene.wide ? WIDE_W : COLUMN_WIDTH;
}

const FLOORS = new WeakMap<Scene, number>();

/**
 * The least height that still holds the whole drawing: the lowest visible
 * top-level box (rotation included) or connector route, plus {@link BAND}.
 * Connectors count because a loop-back routed under the shapes would otherwise
 * paint over the block below.
 */
export function bandFloor(scene: Scene): number {
  const cached = FLOORS.get(scene);
  if (cached !== undefined) return cached;
  const laid = laidOutScene(scene);
  let bottom = -Infinity;
  for (const node of laid.nodes) {
    if (node.hidden) continue;
    const box = nodeBounds(node);
    bottom = Math.max(bottom, box.y + box.h);
  }
  for (const edge of laid.edges) {
    for (const point of edgePoints(laid, edge) ?? []) bottom = Math.max(bottom, point.y);
  }
  const floor = bottom === -Infinity ? EMPTY_BAND_H : Math.ceil(bottom + BAND - EPS);
  FLOORS.set(scene, floor);
  return floor;
}

/** The height a band is drawn at: what it stores, raised to what it holds. */
export function bandHeight(scene: Scene): number {
  return Math.max(scene.h, bandFloor(scene));
}
