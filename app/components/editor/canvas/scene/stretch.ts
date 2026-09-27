/**
 * What a node becomes when its box is set by hand — the `resize` op's answer
 * for every kind, and the one the gesture previews and a boolean re-cuts with,
 * so what a drag shows is what it lands.
 *
 * A resize stretches geometry and nothing drawn on it, as Figma's does: the
 * box, a path's `d`, and everything a plain or boolean group holds, each
 * child's position and size taking the group's factors along each axis — but
 * never a stroke width, a corner radius or a font size, which is the Scale
 * tool's difference (`./scale`). An auto-layout group is the exception that
 * stretches nothing: its box is set and its CSS re-flows the children, the
 * fixed ones keeping their size and the stretched ones filling the new room.
 *
 * Two approximations, both where a box cannot say what a matrix could:
 *
 *  - **A rotated child under an uneven stretch** would come out skewed. A box
 *    has no skew, so the child keeps its angle, its centre lands where the
 *    stretch takes it, and each side grows by how far the stretch lengthens
 *    that side's own direction — `|S·u|` for the unit vector `u` along it. At
 *    0° and 90° that is exact, and under an even stretch it is exact at every
 *    angle.
 *  - **An axis that sizes itself** — text as wide as its words, a group that
 *    hugs — is not stretched by an ancestor: it keeps its size and its
 *    declaration, and only its place moves. What it measures is still what it
 *    shows. Set by hand (the node itself is the target) a hugging axis becomes
 *    fixed, or the hug would put the old size straight back.
 */

import { hugsOf, isAutoLayout } from "./autoLayout";
import { isAutoSize } from "./boxModel";
import { scalePath } from "./path";
import { isGroup, type GroupNode, type Rect, type SceneNode } from "./types";

/** `node` set to `box` (in its parent's space), everything under it following. */
export function resizedNode(node: SceneNode, box: Rect): SceneNode {
  const w = Math.max(0, box.w);
  const h = Math.max(0, box.h);
  if (node.x === box.x && node.y === box.y && node.w === w && node.h === h) {
    return node;
  }
  const next = { ...node, x: box.x, y: box.y, w, h } as SceneNode;
  const sx = ratio(w, node.w);
  const sy = ratio(h, node.h);
  if (next.kind === "path") {
    return sx === 1 && sy === 1 ? next : { ...next, d: scalePath(next.d, sx, sy) };
  }
  if (!isGroup(next)) return next;
  const group = unhug(next, w !== node.w, h !== node.h);
  if ((sx === 1 && sy === 1) || !stretchesChildren(group)) return group;
  return { ...group, children: group.children.map((child) => stretched(child, sx, sy)) };
}

/** A group whose children take its resize — any but an auto-layout one. */
export function stretchesChildren(node: SceneNode): node is GroupNode {
  return isGroup(node) && !isAutoLayout(node);
}

/** How far one axis stretched. An axis with no extent has nothing to stretch. */
const ratio = (to: number, from: number) => (from > 0 && to > 0 ? to / from : 1);

/** A child of a group stretched by `sx`/`sy`, in the group's own axes. */
function stretched(child: SceneNode, sx: number, sy: number): SceneNode {
  const autoW = isAutoSize(child.style.width);
  const autoH = isAutoSize(child.style.height);
  if (child.rot === 0) {
    return resizedNode(child, {
      x: child.x * sx,
      y: child.y * sy,
      w: autoW ? child.w : child.w * sx,
      h: autoH ? child.h : child.h * sy,
    });
  }
  const t = (child.rot * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const w = autoW ? child.w : child.w * Math.hypot(sx * cos, sy * sin);
  const h = autoH ? child.h : child.h * Math.hypot(sx * sin, sy * cos);
  const cx = (child.x + child.w / 2) * sx;
  const cy = (child.y + child.h / 2) * sy;
  return resizedNode(child, { x: cx - w / 2, y: cy - h / 2, w, h });
}

/** Sizing an axis by hand makes it fixed, as in Figma — otherwise
 *  `reflowHugs` would put the hugged size straight back. */
function unhug(group: GroupNode, w: boolean, h: boolean): GroupNode {
  const hug = hugsOf(group);
  if (!(hug.w && w) && !(hug.h && h)) return group;
  const style = { ...group.style };
  if (hug.w && w) delete style.width;
  if (hug.h && h) delete style.height;
  return { ...group, style };
}
