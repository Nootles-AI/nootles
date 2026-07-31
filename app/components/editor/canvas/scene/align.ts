/**
 * Align and distribute — Figma's semantics, as pure maths.
 *
 * Every function here returns a `Map<NodeId, Point>` of each node's **new
 * `x`/`y`**, in the coordinate space those fields already live in (relative to
 * the parent group, or to the scene at the top level). Returning positions
 * rather than mutating keeps this callable from the ops applier, from a preview
 * during a drag, and from the AI layer, all without any of them owning a scene.
 * The map is total: every node handed in comes back out, moved or not, so a
 * caller never has to distinguish "unchanged" from "missing".
 *
 * Two rules the geometry forces:
 *
 *  - **Alignment is over rotated bounds.** A node rotated 30° is aligned by the
 *    edges you can see, not by its unrotated box — so everything works from
 *    `nodeBounds`, and the delta is applied to `x`/`y` rather than assigning
 *    them, since the bounds' origin is not the node's origin.
 *  - **One coordinate space.** All the nodes passed to one call must share a
 *    parent. A cross-parent selection is the caller's problem to flatten (see
 *    `absoluteRect` in ./geometry); silently mixing spaces would move nodes to
 *    places that look random.
 */

import { nodeBounds, unionBounds } from "./geometry";
import { findParent, selectedNodes } from "./types";
import type {
  AlignTarget,
  Alignment,
  DistributeAxis,
  NodeId,
  Point,
  Rect,
  Scene,
  SceneNode,
} from "./types";

/**
 * Align each node's visible bounds to an edge of `within`, which defaults to
 * the selection's own bounds.
 *
 * With the default, aligning a single node is a no-op — which is why
 * {@link alignTarget} exists: it is what turns "align left" on one node into
 * Figma's "align left inside its parent".
 */
export function alignNodes(
  nodes: readonly SceneNode[],
  edge: Alignment,
  within?: Rect,
): Map<NodeId, Point> {
  const moves = new Map<NodeId, Point>();
  if (nodes.length === 0) return moves;

  const frame = within ?? unionBounds(nodes);
  for (const node of nodes) {
    const bounds = nodeBounds(node);
    let dx = 0;
    let dy = 0;
    switch (edge) {
      case "left":
        dx = frame.x - bounds.x;
        break;
      case "hcenter":
        dx = frame.x + (frame.w - bounds.w) / 2 - bounds.x;
        break;
      case "right":
        dx = frame.x + frame.w - (bounds.x + bounds.w);
        break;
      case "top":
        dy = frame.y - bounds.y;
        break;
      case "vcenter":
        dy = frame.y + (frame.h - bounds.h) / 2 - bounds.y;
        break;
      case "bottom":
        dy = frame.y + frame.h - (bounds.y + bounds.h);
        break;
    }
    moves.set(node.id, { x: node.x + dx, y: node.y + dy });
  }
  return moves;
}

/**
 * What an align acts inside: the selection's bounds for a multi-selection, and
 * the containing box for a single node.
 *
 * The single-node case is Figma's, and it is the one users actually rely on —
 * aligning one node to its own bounds does nothing, which is not what pressing
 * the button appears to promise. A node's container in its own coordinate space
 * is its parent group's box with the origin at zero, or the canvas surface at
 * the top level.
 */
export function alignTarget(
  scene: Scene,
  ids: readonly NodeId[],
  relativeTo?: AlignTarget,
): Rect {
  const surface: Rect = { x: 0, y: 0, w: scene.w, h: scene.h };
  if (ids.length === 0) return surface;

  const target = relativeTo ?? (ids.length > 1 ? "selection" : "parent");
  if (target === "selection") {
    const nodes = selectedNodes(scene, ids);
    return nodes.length ? unionBounds(nodes) : surface;
  }
  const parent = findParent(scene, ids[0]);
  return parent ? { x: 0, y: 0, w: parent.w, h: parent.h } : surface;
}

type Span = {
  node: SceneNode;
  /** Leading edge and extent along the distribution axis. */
  start: number;
  size: number;
};

/**
 * Space nodes evenly along an axis, measuring the gaps between their visible
 * bounds — not between their centres, so a wide node does not crowd its
 * neighbours.
 *
 * With `spacing` omitted the outermost two nodes stay exactly where they are
 * and the rest are redistributed between them. With a `spacing` given, the
 * first node stays and the rest are laid out at that fixed gap.
 */
export function distributeNodes(
  nodes: readonly SceneNode[],
  axis: DistributeAxis,
  spacing?: number,
): Map<NodeId, Point> {
  const horizontal = axis === "horizontal";
  const moves = new Map<NodeId, Point>();
  for (const node of nodes) moves.set(node.id, { x: node.x, y: node.y });

  const spans: Span[] = nodes.map((node) => {
    const bounds = nodeBounds(node);
    return {
      node,
      start: horizontal ? bounds.x : bounds.y,
      size: horizontal ? bounds.w : bounds.h,
    };
  });
  spans.sort((a, b) => a.start - b.start || a.node.id.localeCompare(b.node.id));

  // Two nodes already have exactly one gap; without a spacing to impose there
  // is nothing to even out.
  if (spans.length < 2 || (spacing === undefined && spans.length < 3)) return moves;

  let gap = spacing;
  if (gap === undefined) {
    const last = spans[spans.length - 1];
    const span = last.start + last.size - spans[0].start;
    const filled = spans.reduce((total, s) => total + s.size, 0);
    gap = (span - filled) / (spans.length - 1);
  }

  let cursor = spans[0].start;
  for (const span of spans) {
    const delta = cursor - span.start;
    moves.set(span.node.id, {
      x: span.node.x + (horizontal ? delta : 0),
      y: span.node.y + (horizontal ? 0 : delta),
    });
    cursor += span.size + gap;
  }
  return moves;
}
