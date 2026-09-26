import { COLUMN_WIDTH } from "@/app/lib/column";
import { bandFloor, bandHeight, bandLeft, bandWidth, EPS, reachesMargins, WIDE_W } from "./bandGeometry";
import { leastMove } from "./bandRoom";
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
  EPS,
  reachesMargins,
  WIDE_MARGIN,
  WIDE_W,
} from "./bandGeometry";

/**
 * A diagram on the page is a band: the text column's width (or `WIDE_W` when
 * it is wide), with its origin at the text's left edge, and as tall as its
 * content plus a margin. The width is never stored — it follows from `wide`.
 * The height is stored only once someone pins it by dragging the band's
 * bottom edge: `h` is then a floor the content can still raise, and `0` —
 * written by omission — is a band that follows its content both ways.
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

/** The least height an old root pinned by hand was drawn at. */
const OLD_MIN_H = 260;

/**
 * An old root's height as a band's: pinned where the person pinned it by
 * hand, and otherwise not at all — the band follows its content from here on,
 * as every unpinned band does.
 */
function oldPinnedHeight(scene: Scene): number {
  return scene.attrs["data-height"] === "fixed" ? Math.max(OLD_MIN_H, scene.h) : 0;
}

/**
 * The visible top-level content's rotation-aware box, or `null` when there is
 * none — measured with every hugging group at the size it hugs to, which is
 * what any op will leave it at, or a second fit would find a different box.
 */
function contentBox(scene: Scene): Rect | null {
  const visible = reflowHugs(scene).nodes.filter((node) => !node.hidden);
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
  const { dx, dy } = leastMove({ ...box, w }, left, left + bandWidth({ wide }));
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
 * `WIDE_W`); and its height stays pinned only where it was pinned by hand. A
 * band root is already a band and comes back as it is.
 *
 * Pure, idempotent, and the same object back when nothing changes — the
 * collab binding and the stores compare scenes by identity. Frames never come
 * through here: a shot's root looks exactly like an old one.
 */
export function normalizeDiagram(scene: Scene): Scene {
  if (!isLegacyRoot(scene)) return scene;
  const box = contentBox(scene);
  const wide =
    scene.wide === true ||
    widenedByHand(scene) ||
    (box !== null && (box.x < -EPS || box.x + box.w > COLUMN_WIDTH + EPS));
  const { ops } = placement(scene, wide, WIDE_W);
  const placed = ops.length ? applyOps(scene, ops) : scene;
  return bandRoot(placed, oldPinnedHeight(scene), wide);
}

/**
 * The ops that land a model-written diagram in its band: the stated width
 * dropped (a read-form echo of `w` must never reach storage), content wider
 * than the band scaled down about its top-left, then moved in by the least
 * amount. `wide` is kept, and an old root's hand-widened frame reads as wide.
 *
 * A stated height pins the band only where it asks for room the content does
 * not: the read form states the height as drawn, so an echo of an unpinned
 * band's is its floor and leaves it unpinned, and a height at or under the
 * floor would pin nothing anyone could see. A pin the content has since grown
 * into is let go the same way — the band draws the same either side of it.
 *
 * Ops rather than a scene so `write_nodes` lands the fit through the same
 * vocabulary as the rest of its write. Never asked of a frame.
 */
export function fitOps(scene: Scene): SceneOp[] {
  const wide = scene.wide === true || widenedByHand(scene);
  const { ops, k } = placement(scene, wide, bandWidth({ wide }));
  const placed = ops.length ? applyOps(scene, ops) : reflowHugs(scene);
  const stated = k === 1 ? scene.h : Math.round(scene.h * k);
  const h = stated > bandFloor(placed) ? stated : 0;
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
 * The ops that fold a wide band into the column when the person asks for it:
 * `wide` off, and a drawing that reaches into the margins scaled about its
 * top-left until it fits, then moved in — the fit a model's write gets.
 */
export function narrowOps(scene: Scene): SceneOp[] {
  const { wide: _wide, ...column } = scene;
  return [{ type: "setDiagram", wide: false }, ...fitOps(column)];
}

/**
 * The ops that put back, exactly, the band that {@link narrowOps} folded into
 * `folded`: every shape and connector as it stood before, rather than a scale
 * back up that rounding would leave a hair off, and the band wide again.
 */
export function unfoldOps(folded: Scene, before: Scene): SceneOp[] {
  const ops: SceneOp[] = [];
  if (folded.edges.length) ops.push({ type: "removeEdge", ids: folded.edges.map((edge) => edge.id) });
  if (folded.nodes.length) ops.push({ type: "remove", ids: folded.nodes.map((node) => node.id) });
  if (before.nodes.length) ops.push({ type: "insert", nodes: before.nodes });
  if (before.edges.length) ops.push({ type: "addEdge", edges: before.edges });
  ops.push({ type: "setDiagram", wide: true, h: before.h });
  return ops;
}

/** A fold the person may still take back: the band as it was folded, and as it was before. */
export type Fold = { folded: Scene; before: Scene };

/**
 * The ops that make a band wide or not, as the person asks: into the column,
 * a drawing reaching into the margins is folded ({@link narrowOps}); back out,
 * a fold is unfolded exactly when the band is still just as it was folded —
 * any edit since, anyone's, leaves the drawing where it now is.
 */
export function wideOps(scene: Scene, wide: boolean, fold: Fold | null): SceneOp[] {
  if (wide === (scene.wide === true)) return [];
  if (!wide) return reachesMargins(scene) ? narrowOps(scene) : [{ type: "setDiagram", wide: false }];
  return fold?.folded === scene ? unfoldOps(scene, fold.before) : [{ type: "setDiagram", wide: true }];
}

/**
 * A band's height drawn in a box `boxW` wide: shrunk with its width when the
 * box is narrower, as a preview draws a wide band in the column. The column
 * is the default box, since that is where a suggestion sits.
 */
export function bandHeightIn(scene: Scene, boxW: number = COLUMN_WIDTH): number {
  return Math.ceil(bandHeight(scene) * Math.min(1, boxW / bandWidth(scene)));
}
