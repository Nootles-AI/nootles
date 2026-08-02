import {
  elbowPoints,
  obstaclesFor,
  pointsToPath,
  polylineMidpoint,
  sceneObstacles,
} from "../scene/edgePath";
import { absoluteBounds } from "../scene/geometry";
import { findNode, type NodeId, type Rect, type Scene } from "../scene/types";

/**
 * Re-route the connectors mid-gesture, without going through the store.
 *
 * A drag writes transforms straight to the shape elements and dispatches one op
 * at the end — that is what keeps a drag one undo entry and off the render
 * path. The scene therefore does not move until the gesture commits, so a
 * connector rendered from the scene would sit still while the shape it points
 * at slides away.
 *
 * So the gesture calls this once a frame and it does the same thing the
 * renderer does, imperatively: read where the shapes actually are now, run the
 * same router, and write the `d` back. React overwrites all of it on the commit
 * that follows, from the scene — this only has to be right until then.
 *
 * Reads are batched ahead of writes on purpose: measuring a box after writing a
 * path would force a second layout per connector.
 */

/** A node's live box in scene units, or `null` to fall back to the scene. */
export type LiveBox = (id: NodeId) => Rect | null;

/** A top-level obstacle's live box: the node itself, which is the first id in
 *  its own subtree. */
function liveBoxOf(
  covers: ReadonlySet<NodeId>,
  boxOf: (id: NodeId) => Rect,
): Rect | null {
  for (const id of covers) return boxOf(id);
  return null;
}

export function reflowEdges(
  root: HTMLElement | null,
  scene: Scene,
  live: LiveBox,
): void {
  if (!root || scene.edges.length === 0) return;

  // One box per node, however many connectors land on it.
  const boxes = new Map<NodeId, Rect>();
  const boxOf = (id: NodeId): Rect => {
    const known = boxes.get(id);
    if (known) return known;
    const box = live(id) ?? absoluteBounds(scene, id);
    boxes.set(id, box);
    return box;
  };

  // The obstacles move with the shapes, so they are rebuilt from the live
  // boxes too — a connector must route around where a shape IS, not where the
  // scene still thinks it is.
  const shapes = sceneObstacles(scene).map((o) => ({
    ...o,
    box: liveBoxOf(o.covers, boxOf) ?? o.box,
  }));

  const writes: { id: string; d: string; at: { x: number; y: number } }[] = [];
  for (const edge of scene.edges) {
    // Both ends have to still exist; the boxes themselves come from `boxOf`.
    if (!findNode(scene, edge.from) || !findNode(scene, edge.to)) continue;
    const points = elbowPoints(
      boxOf(edge.from),
      boxOf(edge.to),
      undefined,
      obstaclesFor(shapes, edge),
    );
    writes.push({
      id: edge.id,
      d: pointsToPath(points),
      at: polylineMidpoint(points),
    });
  }

  for (const write of writes) {
    for (const path of root.querySelectorAll(
      `[data-edge="${CSS.escape(write.id)}"]`,
    )) {
      path.setAttribute("d", write.d);
    }
    const label = root.querySelector<HTMLElement>(
      `[data-edge-label="${CSS.escape(write.id)}"]`,
    );
    if (label) {
      label.style.left = `${write.at.x}px`;
      label.style.top = `${write.at.y}px`;
    }
  }
}
