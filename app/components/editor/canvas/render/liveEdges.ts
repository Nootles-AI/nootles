import {
  elbowPoints,
  obstaclesFor,
  pointsToPath,
  polylineMidpoint,
  sceneObstacles,
} from "../scene/edgePath";
import { absoluteBounds } from "../scene/geometry";
import {
  findNode,
  type EdgeId,
  type NodeId,
  type Rect,
  type Scene,
} from "../scene/types";

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

/**
 * A connector's elements, found once and written to every frame after.
 *
 * Nothing re-renders while a finger is down, so the elements the first frame
 * finds are the ones the last one writes to — and a `querySelectorAll` per
 * connector per frame is a DOM scan the drag can feel.
 */
export type EdgeElements = Map<
  EdgeId,
  { paths: Element[]; label: HTMLElement | null }
>;

function elementsFor(
  root: HTMLElement,
  id: EdgeId,
  cache: EdgeElements | null | undefined,
): { paths: Element[]; label: HTMLElement | null } {
  const known = cache?.get(id);
  if (known) return known;
  const selector = CSS.escape(id);
  const found = {
    paths: [...root.querySelectorAll(`[data-edge="${selector}"]`)],
    label: root.querySelector<HTMLElement>(`[data-edge-label="${selector}"]`),
  };
  cache?.set(id, found);
  return found;
}

export function reflowEdges(
  root: HTMLElement | null,
  scene: Scene,
  live: LiveBox,
  cache?: EdgeElements | null,
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

  // The obstacles move with the shapes, so the ones that are moving are rebuilt
  // from their live boxes — a connector must route around where a shape IS, not
  // where the scene still thinks it is. The rest keep the box the scene gave
  // them, which is the one the commit will draw them at anyway.
  const shapes = sceneObstacles(scene).map((o) => {
    // The first id in `covers` is the top-level node itself.
    for (const id of o.covers) {
      const box = live(id);
      boxes.set(id, box ?? o.box);
      return box ? { covers: o.covers, box } : o;
    }
    return o;
  });

  const writes: { id: EdgeId; d: string; at: { x: number; y: number } }[] = [];
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
    const els = elementsFor(root, write.id, cache);
    for (const path of els.paths) path.setAttribute("d", write.d);
    if (els.label) {
      els.label.style.left = `${write.at.x}px`;
      els.label.style.top = `${write.at.y}px`;
    }
  }
}
