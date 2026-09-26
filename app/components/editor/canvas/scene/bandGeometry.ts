import { COLUMN_WIDTH } from "@/app/lib/column";
import { laidOutScene } from "./autoLayout";
import { edgePoints } from "./edgePath";
import { nodeBounds } from "./geometry";
import type { Scene } from "./types";

export { bandLeft, bandWidth, WIDE_MARGIN, WIDE_W } from "./bandSpan";

/**
 * The band's measurements, apart from `./band` because they need no op: the
 * align maths reads them, the ops applier reads that, and `./band` fits
 * scenes through the applier — so drawing them from `./band` would close a
 * loop through module evaluation. Import them from `./band`.
 */

/** Room above the first shape and below the lowest, in px. */
export const BAND = 24;
/** An empty band: one line of body text and a band either side of it. */
export const EMPTY_BAND_H = 26 + 2 * BAND;

/** Below this, two coordinates are the same place — fitting must not chase float error. */
export const EPS = 1e-6;

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

/**
 * The height a band is drawn at: its floor, or its pinned height (`h`, `0`
 * when unpinned) where that is taller.
 */
export function bandHeight(scene: Scene): number {
  return Math.max(scene.h, bandFloor(scene));
}

/**
 * Whether anything drawn — a visible top-level box (rotation included) or a
 * connector route — reaches past the column into a wide band's margins. When
 * nothing does, a wide band is only empty room either side of the text.
 */
export function reachesMargins(scene: Scene): boolean {
  const laid = laidOutScene(scene);
  const out = (left: number, right: number) => left < -EPS || right > COLUMN_WIDTH + EPS;
  for (const node of laid.nodes) {
    if (node.hidden) continue;
    const box = nodeBounds(node);
    if (out(box.x, box.x + box.w)) return true;
  }
  for (const edge of laid.edges) {
    for (const point of edgePoints(laid, edge) ?? []) if (out(point.x, point.x)) return true;
  }
  return false;
}
