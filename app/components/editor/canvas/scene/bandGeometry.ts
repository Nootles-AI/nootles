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

const BOTTOMS = new WeakMap<Scene, number>();

/**
 * The lowest visible top-level box (rotation included) or connector route;
 * -Infinity with nothing drawn. Connectors count because a loop-back routed
 * under the shapes would otherwise paint over the block below.
 */
function drawnBottom(scene: Scene): number {
  const cached = BOTTOMS.get(scene);
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
  BOTTOMS.set(scene, bottom);
  return bottom;
}

/**
 * Where the drawing ends, with no room under it: as far up as a grip may pull
 * the band. An empty band's is {@link EMPTY_BAND_H}.
 */
export function contentBottom(scene: Scene): number {
  const bottom = drawnBottom(scene);
  return bottom === -Infinity ? EMPTY_BAND_H : Math.ceil(bottom - EPS);
}

/** The height that holds the whole drawing with {@link BAND} under it: what Auto height sets. */
export function bandFloor(scene: Scene): number {
  const bottom = drawnBottom(scene);
  return bottom === -Infinity ? EMPTY_BAND_H : Math.ceil(bottom + BAND - EPS);
}

/**
 * The band's height while one operation is under way — a drag, a draw, a
 * pen's point or its handle, a run of nudges: as tall as it was when the
 * operation began, or as tall as what the operation has drawn needs right
 * now, whichever is taller. So it grows under what is taken down and follows
 * it back up again, but never above where it began; where the operation ends
 * is the height it lands at, and the next one begins from there. `need` is
 * `-Infinity` for nothing needed.
 */
export function operationHeight(startH: number, need: number): number {
  return Number.isFinite(need) ? Math.max(startH, Math.ceil(need - EPS)) : startH;
}

/**
 * What a scene needs of its band, for {@link operationHeight}: room under its
 * drawing, for a band that had it when the operation began; for one sized
 * tight to its shapes, only once something passes its edge.
 */
export function sceneNeed(scene: Scene, startH: number, roomy: boolean): number {
  return roomy || contentBottom(scene) > startH ? bandFloor(scene) : -Infinity;
}

/**
 * The height a band is drawn at: what it stores, raised to where its drawing
 * ends — so content that arrived from elsewhere taller than the stored height
 * is shown whole without anything being written, and a band pulled up tight
 * to its shapes stays tight. One with no height stated fits its content.
 */
export function bandHeight(scene: Scene): number {
  return scene.h > 0 ? Math.max(scene.h, contentBottom(scene)) : bandFloor(scene);
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
