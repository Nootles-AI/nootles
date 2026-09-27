/**
 * Flip — Figma's ⇧H and ⇧V, as a pure scene transform.
 *
 * A mirror is `M·Rot(r) = Rot(−r)·M`: every node keeps its box size, its
 * rotation is negated, its centre is reflected across the axis, and whatever
 * geometry the box holds is mirrored inside it — a path's `d`, an arc's
 * angles, a group's children (recursively, in the group's own frame). A box
 * cannot hold a mirrored glyph, and nobody wants one, so a label moves with
 * its box and still reads left to right.
 *
 * Two kinds need more than the mirror:
 *
 *  - **A regular polygon with an odd side count** is symmetric left to right
 *    but not top to bottom, and has no parameter for pointing down. Top to
 *    bottom it takes the half turn instead: `M_y = Rot(180°)·M_x`, so its
 *    rotation becomes `180° − r`, which is the same drawing.
 *  - **Children of an auto-layout group** are placed by the layout, so their
 *    places are left to it; their own geometry still mirrors.
 *
 * Connectors carry no geometry and follow their shapes.
 */

import { isAutoLayout } from "./autoLayout";
import { nodeBounds, unionBounds } from "./geometry";
import { mirrorPath } from "./path";
import {
  arcOf,
  findParent,
  isGroup,
  nodePath,
  topSelection,
  type FlipAxis,
  type NodeId,
  type Point,
  type Scene,
  type SceneNode,
} from "./types";

/** `ids` mirrored about the centre of their bounds on `axis`. */
export function flipNodes(scene: Scene, ids: readonly NodeId[], axis: FlipAxis): Scene {
  const targets = topSelection(scene, ids);
  if (targets.length === 0) return scene;

  // Members of different groups meet in scene space by their parents' offsets,
  // as `group` brings them together (see ./ops on ancestor rotation).
  const origins = new Map<NodeId, Point>();
  const boxes = targets.map((node) => {
    const origin = originOf(scene, node.id);
    origins.set(node.id, origin);
    const b = nodeBounds(node);
    return { x: b.x + origin.x, y: b.y + origin.y, w: b.w, h: b.h, rot: 0 };
  });
  const frame = unionBounds(boxes);
  const centre = axis === "x" ? frame.x + frame.w / 2 : frame.y + frame.h / 2;

  const flipped = new Map<NodeId, SceneNode>();
  for (const node of targets) {
    const parent = findParent(scene, node.id);
    const placed = parent !== null && isAutoLayout(parent);
    const origin = origins.get(node.id)!;
    const local = centre - (axis === "x" ? origin.x : origin.y);
    flipped.set(node.id, flipAbout(node, axis, placed ? null : local));
  }
  const nodes = replace(scene.nodes, flipped);
  return nodes === scene.nodes ? scene : { ...scene, nodes };
}

/** One node mirrored about `about` in its parent's space, or in place when `null`. */
function flipAbout(node: SceneNode, axis: FlipAxis, about: number | null): SceneNode {
  const own = mirrored(node, axis);
  if (about === null) return own;
  return axis === "x"
    ? { ...own, x: 2 * about - node.x - node.w }
    : { ...own, y: 2 * about - node.y - node.h };
}

/** The node's own drawing mirrored inside its box, which stays where it is. */
function mirrored(node: SceneNode, axis: FlipAxis): SceneNode {
  const halfTurn = axis === "y" && node.kind === "polygon" && Math.round(node.sides) % 2 === 1;
  const rot = halfTurn ? 180 - node.rot : node.rot === 0 ? 0 : -node.rot;
  switch (node.kind) {
    case "path":
      return { ...node, rot, d: mirrorPath(node.d, axis, axis === "x" ? node.w : node.h) };
    case "ellipse": {
      if (node.start === undefined && node.sweep === undefined) return { ...node, rot };
      // Clockwise from twelve: a left-right mirror is θ → −θ, top-bottom θ → 180° − θ.
      const { start, sweep } = arcOf(node);
      const turned = (axis === "x" ? 0 : 180) - start - sweep;
      return { ...node, rot, start: ((turned % 360) + 360) % 360 };
    }
    case "group": {
      const free = !isAutoLayout(node);
      const extent = axis === "x" ? node.w : node.h;
      return {
        ...node,
        rot,
        children: node.children.map((child) => flipAbout(child, axis, free ? extent / 2 : null)),
      };
    }
    default:
      return { ...node, rot };
  }
}

function originOf(scene: Scene, id: NodeId): Point {
  let x = 0;
  let y = 0;
  for (const ancestor of nodePath(scene, id).slice(0, -1)) {
    x += ancestor.x;
    y += ancestor.y;
  }
  return { x, y };
}

/** `nodes` with the flipped ones swapped in, untouched subtrees kept by identity. */
function replace(nodes: SceneNode[], flipped: ReadonlyMap<NodeId, SceneNode>): SceneNode[] {
  let changed = false;
  const out = nodes.map((node) => {
    const swap = flipped.get(node.id);
    if (swap) {
      changed = true;
      return swap;
    }
    if (!isGroup(node)) return node;
    const children = replace(node.children, flipped);
    if (children === node.children) return node;
    changed = true;
    return { ...node, children };
  });
  return changed ? out : nodes;
}
