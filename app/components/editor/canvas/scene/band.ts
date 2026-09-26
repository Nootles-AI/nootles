import { COLUMN_WIDTH } from "@/app/lib/column";
import { bandFloor, bandHeight, bandLeft, bandWidth, EPS, WIDE_W } from "./bandGeometry";
import { unionBounds } from "./geometry";
import { applyOps, reflowHugs } from "./ops";
import type { Rect, Scene, SceneOp } from "./types";

export {
  BAND,
  bandFloor,
  bandHeight,
  bandLeft,
  bandWidth,
  EMPTY_BAND_H,
  WIDE_MARGIN,
  WIDE_W,
} from "./bandGeometry";

/**
 * A diagram on the page is a band: the text column's width (or `WIDE_W` when
 * it is wide), with its origin at the text's left edge, and as tall as its
 * content plus a margin. The width is never stored — it follows from `wide` —
 * and the height is stored only as a floor the content can raise.
 *
 * Storyboard frames are not bands. They keep their authored `w`/`h`, and
 * nothing here is ever asked about one.
 */

/** The attributes an old root carried to pin a size by hand. */
const LEGACY_ATTRS = ["data-width", "data-height"] as const;

/**
 * A root written before bands: it states a width, or pins a size by hand.
 * Read-form echoes look the same (they carry the derived `w`), which is why
 * every AI write goes through {@link fitToBand} before it can be stored.
 */
export function isLegacyRoot(scene: Pick<Scene, "w" | "attrs">): boolean {
  return scene.w > 0 || LEGACY_ATTRS.some((name) => name in scene.attrs);
}

/** An old root the person widened past the column by hand. */
function widenedByHand(scene: Pick<Scene, "w" | "attrs">): boolean {
  return scene.attrs["data-width"] === "fixed" && scene.w > COLUMN_WIDTH;
}

/**
 * The height rule from before bands, frozen: an old diagram keeps at least the
 * height it was drawn at, so no page gets shorter on the way over. A copy
 * rather than a call, because the live rule is the band's now.
 */
const OLD_MIN_H = 260;
const OLD_MAX_H = 560;
const OLD_PAD = 24;

function oldRenderedHeight(scene: Scene): number {
  if (scene.attrs["data-height"] === "fixed") return Math.max(OLD_MIN_H, scene.h);
  if (!scene.nodes.length) return OLD_MIN_H;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of scene.nodes) {
    minY = Math.min(minY, node.y);
    maxY = Math.max(maxY, node.y + node.h);
  }
  return Math.round(Math.min(OLD_MAX_H, Math.max(OLD_MIN_H, maxY - minY + OLD_PAD)));
}

/** The visible top-level content's rotation-aware box, or `null` when there is none. */
function contentBox(scene: Scene): Rect | null {
  const visible = scene.nodes.filter((node) => !node.hidden);
  return visible.length ? unionBounds(visible) : null;
}

/**
 * The scale (only past `maxW`, about the content's top-left) and then the
 * least translation that land the content inside the band's range and below
 * its top. Every top-level node moves, hidden ones included, so the drawing
 * keeps its own arrangement.
 */
function placement(scene: Scene, wide: boolean, maxW: number): { ops: SceneOp[]; k: number } {
  const box = contentBox(scene);
  if (!box) return { ops: [], k: 1 };
  const ids = scene.nodes.map((node) => node.id);
  const ops: SceneOp[] = [];
  let k = 1;
  let w = box.w;
  if (w > maxW + EPS) {
    k = maxW / w;
    w = maxW;
    ops.push({ type: "scale", ids, k, anchor: { x: box.x, y: box.y } });
  }
  const left = bandLeft({ wide });
  const right = left + bandWidth({ wide });
  const dx =
    box.x < left - EPS ? left - box.x : box.x + w > right + EPS ? right - (box.x + w) : 0;
  const dy = box.y < -EPS ? -box.y : 0;
  if (dx || dy) ops.push({ type: "move", ids, dx, dy });
  return { ops, k };
}

/** The scene on a band root: no width, no hand-pinned size, `wide` as given. */
function bandRoot(scene: Scene, h: number, wide: boolean): Scene {
  const { wide: _wide, ...rest } = scene;
  const attrs = { ...scene.attrs };
  for (const name of LEGACY_ATTRS) delete attrs[name];
  return { ...rest, w: 0, h, attrs, ...(wide ? { wide: true as const } : {}) };
}

/**
 * A stored diagram as a band — the diagram-block reader's one step, so every
 * prop reader sees the same thing whichever generation wrote it.
 *
 * An old root keeps its positions. It turns wide if it was widened by hand or
 * its content leaves the column; content past even the wide range, or above
 * the top, is moved in by the least amount (scaled first only when wider than
 * `WIDE_W`); and its height is the larger of what it was drawn at and what it
 * now holds. A band root only has its height raised to the floor.
 *
 * Pure, idempotent, and the same object back when nothing changes — the
 * collab binding and the stores compare scenes by identity. Frames never come
 * through here: a shot's root looks exactly like an old one.
 */
export function normalizeDiagram(scene: Scene): Scene {
  if (!isLegacyRoot(scene)) {
    const floor = bandFloor(scene);
    return floor > scene.h ? { ...scene, h: floor } : scene;
  }
  const box = contentBox(scene);
  const wide =
    scene.wide === true ||
    widenedByHand(scene) ||
    (box !== null && (box.x < -EPS || box.x + box.w > COLUMN_WIDTH + EPS));
  const { ops } = placement(scene, wide, WIDE_W);
  const placed = ops.length ? applyOps(scene, ops) : scene;
  return bandRoot(placed, Math.max(oldRenderedHeight(scene), bandFloor(placed)), wide);
}

/**
 * The ops that land a model-written diagram in its band: the stated width
 * dropped (a read-form echo of `w` must never reach storage), content wider
 * than the band scaled down about its top-left, then moved in by the least
 * amount, and the height raised to hold it. `wide` is kept, and an old root's
 * hand-widened frame reads as wide.
 *
 * Ops rather than a scene so `write_nodes` lands the fit through the same
 * vocabulary as the rest of its write. Never asked of a frame.
 */
export function fitOps(scene: Scene): SceneOp[] {
  const wide = scene.wide === true || widenedByHand(scene);
  const { ops, k } = placement(scene, wide, bandWidth({ wide }));
  const placed = ops.length ? applyOps(scene, ops) : reflowHugs(scene);
  const h = Math.max(k === 1 ? scene.h : Math.round(scene.h * k), bandFloor(placed));
  const root: Extract<SceneOp, { type: "setDiagram" }> = { type: "setDiagram" };
  if (scene.w !== 0) root.w = 0;
  if (h !== scene.h) root.h = h;
  if ((scene.wide === true) !== wide) root.wide = wide;
  const pinned = LEGACY_ATTRS.filter((name) => name in scene.attrs);
  if (pinned.length) root.attrs = Object.fromEntries(pinned.map((name) => [name, undefined]));
  return Object.keys(root).length > 1 ? [...ops, root] : ops;
}

/** {@link fitOps}, applied. The same object when there is nothing to fit. */
export function fitToBand(scene: Scene): Scene {
  return applyOps(scene, fitOps(scene));
}

/**
 * A band's height drawn in a box `boxW` wide: shrunk with its width when the
 * box is narrower, as a preview draws a wide band in the column. The column
 * is the default box, since that is where a suggestion sits.
 */
export function bandHeightIn(scene: Scene, boxW: number = COLUMN_WIDTH): number {
  return Math.ceil(bandHeight(scene) * Math.min(1, boxW / bandWidth(scene)));
}
