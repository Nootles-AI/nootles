"use client";

/**
 * The connector tool: reveal the plugs, drag one onto another node.
 *
 * Mounted as a direct child of the viewport container, not of the transformed
 * scene layer — the same arrangement the pen tool uses, and for the same
 * reason. It draws in **viewport px**, so a plug stays the same size on screen
 * at every zoom, which is the one property that makes small targets usable when
 * you are zoomed out.
 *
 * Plugs are shown for the nodes at the **current level**: the scene's own
 * children, or the children of whatever group has been entered. That is exactly
 * the set a click would select, so the tool and the pointer agree about what
 * "a thing on the canvas" means, and a group is one thing until you go into it.
 *
 * The plug you grab picks the *node*, not the side. Which side the finished
 * connector leaves and enters is derived from the two boxes every time it is
 * drawn (see `scene/edgePath`), so the grabbed plug only steers the preview.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useSceneSnapshot, type SceneStore } from "../engine/useScene";
import type { SelectionStore } from "../engine/useSelection";
import { useViewportValue, type ViewportController } from "../engine/useViewport";
import {
  elbowPoints,
  plugPoints,
  pointsToPath,
  sideNearest,
} from "../scene/edgePath";
import { absoluteBounds, hitTest, sceneToViewport } from "../scene/geometry";
import { mintEdgeId } from "../scene/ops";
import {
  findNode,
  isContainer,
  type EdgeSide,
  type NodeId,
  type Point,
  type Rect,
  type Scene,
  type SceneNode,
} from "../scene/types";
import "./connector.css";

/** Screen px — constant at every zoom, because this layer is not transformed. */
const PLUG = 7;
/** How close the pointer must come to a plug to take that exact one. */
const GRAB = 11;
/** How far outside a shape still counts as being on it, in screen px. */
const HALO = 14;
/** The cursor as a box, so the preview can use the same router as the real
 *  thing rather than a second, disagreeing one. */
const CURSOR_BOX = 2;

type Drag = {
  from: NodeId;
  side: EdgeSide;
  /** Scene point under the pointer. */
  at: Point;
  /** The node the pointer is over, if it is a legal target. */
  over: NodeId | null;
};

export interface ConnectorToolProps {
  store: SceneStore;
  viewport: ViewportController;
  selection: SelectionStore;
  /** Called with the new edge's id, or `null` if the drag came to nothing. */
  onFinish: (created: boolean) => void;
}

/** The nodes a connector may start from or land on at this level. */
function candidates(scene: Scene, enteredId: NodeId | null): SceneNode[] {
  const parent = enteredId ? findNode(scene, enteredId) : null;
  const list = parent && isContainer(parent) ? parent.children : scene.nodes;
  return list.filter((node) => !node.hidden && !node.locked);
}

export function ConnectorTool({
  store,
  viewport,
  selection,
  onFinish,
}: ConnectorToolProps) {
  const scene = useSceneSnapshot(store);
  // Subscribed so the plugs follow a pan or a zoom; the values are read below.
  const view = useViewportValue(viewport);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  /** The plug a press would take right now — the tool's own aim. */
  const [hover, setHover] = useState<{ id: NodeId; side: EdgeSide } | null>(null);
  const [entered, setEntered] = useState<NodeId | null>(
    () => selection.getSnapshot().enteredPath.at(-1) ?? null,
  );

  useEffect(
    () =>
      selection.subscribe(() =>
        setEntered(selection.getSnapshot().enteredPath.at(-1) ?? null),
      ),
    [selection],
  );

  const nodes = candidates(scene, entered);
  const boxes = new Map<NodeId, Rect>(
    nodes.map((node) => [node.id, absoluteBounds(scene, node.id)]),
  );
  const toView = (p: Point) => sceneToViewport(p, view);

  /**
   * Which node and plug a point means.
   *
   * A plug within reach wins outright — that is the precise gesture. Failing
   * that, anywhere on a shape, or in a halo just outside it, starts a connector
   * from the side of that shape the point is nearest. Dragging only from the
   * four dots would make the dots the tool; the shape is the tool.
   */
  const resolve = (
    at: Point,
    screen: Point,
  ): { id: NodeId; side: EdgeSide } | null => {
    let best: { id: NodeId; side: EdgeSide; d: number } | null = null;
    for (const node of nodes) {
      const box = boxes.get(node.id);
      if (!box) continue;
      for (const { side, at: plug } of plugPoints(box)) {
        const v = toView(plug);
        const d = Math.hypot(v.x - screen.x, v.y - screen.y);
        if (d <= GRAB && (!best || d < best.d)) best = { id: node.id, side, d };
      }
    }
    if (best) return { id: best.id, side: best.side };

    const hit = hitTest(scene, at);
    const onShape = hit && boxes.has(hit.id) ? hit.id : null;
    if (onShape) {
      return { id: onShape, side: sideNearest(boxes.get(onShape)!, at) };
    }

    // The halo, in scene units so it is a constant distance on screen.
    const reach = HALO / view.zoom;
    let near: { id: NodeId; d: number } | null = null;
    for (const node of nodes) {
      const box = boxes.get(node.id);
      if (!box) continue;
      const dx = Math.max(box.x - at.x, 0, at.x - (box.x + box.w));
      const dy = Math.max(box.y - at.y, 0, at.y - (box.y + box.h));
      const d = Math.hypot(dx, dy);
      if (d <= reach && (!near || d < near.d)) near = { id: node.id, d };
    }
    return near
      ? { id: near.id, side: sideNearest(boxes.get(near.id)!, at) }
      : null;
  };

  const cancel = useCallback(() => {
    dragRef.current = null;
    setDrag(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dragRef.current) {
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [cancel]);

  /** Client px in the overlay's own coordinates — it fills the container. */
  const screenOf = (e: ReactPointerEvent<HTMLDivElement>): Point => {
    const origin = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - origin.left, y: e.clientY - origin.top };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const at = viewport.clientToScene({ x: e.clientX, y: e.clientY });
    const start = resolve(at, screenOf(e));
    if (!start) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const next: Drag = { from: start.id, side: start.side, at, over: null };
    dragRef.current = next;
    setDrag(next);
    setHover(null);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;
    const at = viewport.clientToScene({ x: e.clientX, y: e.clientY });
    if (!current) {
      // Not dragging: show which plug a press here would come out of.
      const found = resolve(at, screenOf(e));
      setHover((prev) =>
        prev?.id === found?.id && prev?.side === found?.side ? prev : found,
      );
      return;
    }
    const hit = hitTest(scene, at);
    // Any node is a legal end except the one we started from — a connector from
    // a thing to itself has no route and nothing to say.
    const over = hit && hit.id !== current.from ? hit.id : null;
    const next = { ...current, at, over };
    dragRef.current = next;
    setDrag(next);
  };

  const onPointerUp = () => {
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!current?.over) {
      onFinish(false);
      return;
    }
    const id = mintEdgeId(scene);
    store.dispatch({
      type: "addEdge",
      edges: [
        {
          id,
          from: current.from,
          to: current.over,
          label: "",
          style: {},
          attrs: {},
        },
      ],
    });
    // The applier refuses a duplicate or a self-join, so ask the scene whether
    // the edge actually landed before selecting it.
    if (store.getScene().edges.some((edge) => edge.id === id)) {
      selection.selectEdges([id]);
    }
    onFinish(true);
  };

  /** The live line: the cursor stands in as a 2px box, so the preview and the
   *  finished connector come out of the same router. */
  const preview = (() => {
    if (!drag) return null;
    const from = boxes.get(drag.from) ?? absoluteBounds(scene, drag.from);
    const to = drag.over
      ? absoluteBounds(scene, drag.over)
      : {
          x: drag.at.x - CURSOR_BOX / 2,
          y: drag.at.y - CURSOR_BOX / 2,
          w: CURSOR_BOX,
          h: CURSOR_BOX,
        };
    // Over a real target, both sides are derived, exactly as the finished
    // connector will be. Loose, the grabbed plug holds one end still so the
    // line does not flip sides as the pointer crosses the box's midline.
    const sides: [EdgeSide, EdgeSide] | undefined = drag.over
      ? undefined
      : [drag.side, "left"];
    return elbowPoints(from, to, sides).map(toView);
  })();

  return (
    <div
      className="ab-connector"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancel}
      onPointerLeave={() => setHover(null)}
    >
      <svg className="ab-connector-svg" aria-hidden>
        {preview && (
          <path
            className="ab-connector-preview"
            // Rounded like the finished connector, and at the same radius: the
            // preview is a promise about what you are about to get.
            d={pointsToPath(preview)}
          />
        )}

        {nodes.map((node) => {
          const box = boxes.get(node.id);
          if (!box) return null;
          const isTarget = drag?.over === node.id;
          return (
            <g key={node.id}>
              {isTarget && <TargetRing box={box} toView={toView} />}
              {plugPoints(box).map(({ side, at }) => {
                const v = toView(at);
                const live =
                  (drag?.from === node.id && drag.side === side) ||
                  (!drag && hover?.id === node.id && hover.side === side);
                return (
                  <circle
                    key={side}
                    className={`ab-connector-plug${live ? " is-live" : ""}`}
                    cx={v.x}
                    cy={v.y}
                    r={PLUG / 2}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function TargetRing({ box, toView }: { box: Rect; toView: (p: Point) => Point }) {
  const a = toView({ x: box.x, y: box.y });
  const b = toView({ x: box.x + box.w, y: box.y + box.h });
  return (
    <rect
      className="ab-connector-target"
      x={a.x}
      y={a.y}
      width={b.x - a.x}
      height={b.y - a.y}
      rx="3"
    />
  );
}
