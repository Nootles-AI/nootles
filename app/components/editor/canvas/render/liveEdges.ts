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
  type SceneEdge,
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
 *
 * Allocation is batched the same way, into {@link prepareObstacles}. Nothing
 * but the moving subtree changes shape for the length of a gesture, so *which*
 * boxes are in a given connector's way is settled once, and each frame only
 * re-reads the moving ones — into the very `Rect` objects the router is already
 * holding. Rebuilt from scratch instead, the obstacle list and its per-edge
 * filtering cost a few hundred objects a frame on a diagram of any size.
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

/**
 * What each connector routes around, and where those boxes are this frame.
 *
 * Prepared against one scene and valid only while that scene is the current
 * one — which is exactly a gesture's life, since a gesture dispatches its op at
 * the end and nothing re-renders underneath it before then.
 */
export interface LiveObstacles {
  /** The scene this was built from; {@link reflowEdges} checks it and falls
   *  back to the plain path rather than routing around a scene that has moved. */
  readonly scene: Scene;
  /**
   * Re-read the moving boxes for this frame, and hand back every top-level
   * node's box — so a connector's own ends are not measured a second time.
   */
  refresh(live: LiveBox): ReadonlyMap<NodeId, Rect>;
  /** The obstacles that are not this connector's own ends. */
  around(edge: EdgeId): readonly Rect[];
}

/** The caches a gesture holds for its whole duration. */
interface LiveGesture {
  edges: EdgeElements;
  obstacles: LiveObstacles;
}

const NO_RECTS: readonly Rect[] = [];

/**
 * Settle the obstacle set for a gesture that is about to move `moving`.
 *
 * Every top-level node gets one `Rect` that lives for the gesture and is
 * mutated in place by {@link LiveObstacles.refresh}; the per-connector lists
 * hold those same objects, so a frame that moves ten shapes rewrites forty
 * numbers and allocates nothing.
 */
export function prepareObstacles(
  scene: Scene,
  moving: ReadonlySet<NodeId>,
): LiveObstacles {
  const all = sceneObstacles(scene);
  const boxes = new Map<NodeId, Rect>();
  /** The only boxes a frame re-reads, each with the scene box to fall back to. */
  const shifting: { id: NodeId; rect: Rect; base: Rect }[] = [];
  const rects = all.map((o) => {
    const rect = { ...o.box };
    // `sceneObstacles` walks each top-level node into `covers` itself first.
    const [top] = o.covers;
    boxes.set(top, rect);
    if (moving.has(top)) shifting.push({ id: top, rect, base: o.box });
    return rect;
  });

  const around = new Map<EdgeId, readonly Rect[]>();
  for (const edge of scene.edges) {
    around.set(
      edge.id,
      rects.filter(
        (_, i) => !all[i].covers.has(edge.from) && !all[i].covers.has(edge.to),
      ),
    );
  }

  return {
    scene,
    refresh(live) {
      for (const node of shifting) {
        const box = live(node.id) ?? node.base;
        node.rect.x = box.x;
        node.rect.y = box.y;
        node.rect.w = box.w;
        node.rect.h = box.h;
      }
      return boxes;
    },
    around: (edge) => around.get(edge) ?? NO_RECTS,
  };
}

/**
 * The obstacle set rebuilt for one frame — the path taken with no gesture to
 * have prepared one. The moving shapes are read from the DOM, since a connector
 * must route around where a shape IS rather than where the scene still thinks
 * it is; the rest keep the box the scene gave them, which is the one the commit
 * will draw them at anyway. It seeds `boxes` on the way past, having just paid
 * for the measurement.
 */
function frameObstacles(
  scene: Scene,
  live: LiveBox,
  boxes: Map<NodeId, Rect>,
): (edge: SceneEdge) => readonly Rect[] {
  const shapes = sceneObstacles(scene).map((o) => {
    const [top] = o.covers;
    const box = live(top);
    boxes.set(top, box ?? o.box);
    return box ? { covers: o.covers, box } : o;
  });
  return (edge) => obstaclesFor(shapes, edge);
}

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
  gesture?: LiveGesture | null,
): void {
  if (!root || scene.edges.length === 0) return;

  const prepared =
    gesture && gesture.obstacles.scene === scene ? gesture.obstacles : null;
  /** Every top-level box as of this frame, when a gesture prepared them. */
  const tops = prepared?.refresh(live) ?? null;

  // One box per node, however many connectors land on it.
  const boxes = new Map<NodeId, Rect>();
  const boxOf = (id: NodeId): Rect => {
    const settled = tops?.get(id) ?? boxes.get(id);
    if (settled) return settled;
    const box = live(id) ?? absoluteBounds(scene, id);
    boxes.set(id, box);
    return box;
  };

  const around = prepared
    ? (edge: SceneEdge) => prepared.around(edge.id)
    : frameObstacles(scene, live, boxes);

  const writes: { id: EdgeId; d: string; at: { x: number; y: number } }[] = [];
  for (const edge of scene.edges) {
    // Both ends have to still exist; the boxes themselves come from `boxOf`.
    if (!findNode(scene, edge.from) || !findNode(scene, edge.to)) continue;
    const points = elbowPoints(
      boxOf(edge.from),
      boxOf(edge.to),
      undefined,
      around(edge),
    );
    writes.push({
      id: edge.id,
      d: pointsToPath(points),
      at: polylineMidpoint(points),
    });
  }

  for (const write of writes) {
    const els = elementsFor(root, write.id, gesture?.edges);
    for (const path of els.paths) path.setAttribute("d", write.d);
    if (els.label) {
      els.label.style.left = `${write.at.x}px`;
      els.label.style.top = `${write.at.y}px`;
    }
  }
}
