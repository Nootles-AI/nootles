"use client";

/**
 * The connector tool: reveal the plugs, drag one onto another node.
 *
 * The layer covers the viewport container, because a press anywhere on the
 * canvas may mean "start a connector here". What it *draws*, though, hangs off
 * an inner group that carries the scene transform, written straight onto the
 * element from a viewport subscription — so every coordinate below is scene px,
 * the plugs stay glued to their shapes for free, and a pan or a zoom re-renders
 * nothing at all. Anything that must be a fixed size on screen — a plug, the
 * target ring, the preview's stroke — is drawn at `--k` scene px, one screen px
 * in scene units, which is how the selection overlay does the same thing.
 *
 * Plugs are shown for the nodes at the **current level**: the scene's own
 * children, or the children of whatever group has been entered. That is exactly
 * the set a click would select, so the tool and the pointer agree about what
 * "a thing on the canvas" means, and a group is one thing until you go into it.
 *
 * The plug you grab picks the *node*, not the side. Which side the finished
 * connector leaves and enters is derived from the two boxes every time it is
 * drawn (see `scene/edgePath`), so the grabbed plug only steers the preview.
 *
 * A drag paints rather than renders: the pointer is batched to one animation
 * frame, and that frame writes the preview and the target ring into the DOM
 * itself. React hears about the gesture twice — as it starts, and as it lands.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useSceneSnapshot, type SceneStore } from "../engine/useScene";
import type { SelectionStore } from "../engine/useSelection";
import type { ViewportController } from "../engine/useViewport";
import {
  elbowPoints,
  plugPoints,
  pointsToPath,
  sideNearest,
} from "../scene/edgePath";
import { absoluteBounds, hitTest } from "../scene/geometry";
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

/** How close the pointer must come to a plug to take that exact one, in screen
 *  px — as is the halo below. Both are taken through `k` where they are used,
 *  because the drawing they belong to is in scene units. */
const GRAB = 11;
/** How far outside a shape still counts as being on it. */
const HALO = 14;
/** The cursor as a box — scene px, this one — so the preview can use the same
 *  router as the real thing rather than a second, disagreeing one. */
const CURSOR_BOX = 2;

/** A plug, as an answer rather than as a place: which node, which side. */
type Plug = { id: NodeId; side: EdgeSide };

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
}

/** The nodes a connector may start from or land on at this level. */
function candidates(scene: Scene, enteredId: NodeId | null): SceneNode[] {
  const parent = enteredId ? findNode(scene, enteredId) : null;
  const list = parent && isContainer(parent) ? parent.children : scene.nodes;
  return list.filter((node) => !node.hidden && !node.locked);
}

export function ConnectorTool({ store, viewport, selection }: ConnectorToolProps) {
  const scene = useSceneSnapshot(store);
  /** The grabbed plug, for as long as a drag lasts. Where the pointer is and
   *  what it is over live in `dragRef`: they are painted, not rendered. */
  const [grabbed, setGrabbed] = useState<Plug | null>(null);
  /** The plug a press would take right now — the tool's own aim. */
  const [hover, setHover] = useState<Plug | null>(null);
  const [entered, setEntered] = useState<NodeId | null>(
    () => selection.getSnapshot().enteredPath.at(-1) ?? null,
  );

  const dragRef = useRef<Drag | null>(null);
  const clientRef = useRef<Point>({ x: 0, y: 0 });
  const rafRef = useRef(0);
  const layer = useRef<SVGGElement>(null);
  const preview = useRef<SVGPathElement>(null);
  const ring = useRef<SVGRectElement>(null);

  useEffect(
    () =>
      selection.subscribe(() =>
        setEntered(selection.getSnapshot().enteredPath.at(-1) ?? null),
      ),
    [selection],
  );

  /**
   * The scene transform, straight onto the group once per viewport frame. This
   * one write is the whole reason moving around costs the tool nothing.
   */
  useLayoutEffect(() => {
    const g = layer.current;
    if (!g) return;
    let painted = 0;
    const place = () => {
      const { x, y, zoom } = viewport.get();
      g.setAttribute("transform", `translate(${x} ${y}) scale(${zoom})`);
      // The transform moves on every frame; `--k` only on a zoom, and a
      // discarded custom-property parse per pan frame is not free.
      if (zoom === painted) return;
      painted = zoom;
      g.style.setProperty("--k", String(1 / zoom));
    };
    place();
    return viewport.subscribe(place);
  }, [viewport]);

  const nodes = candidates(scene, entered);
  const boxes = new Map<NodeId, Rect>(
    nodes.map((node) => [node.id, absoluteBounds(scene, node.id)]),
  );

  /**
   * Which node and plug a point means, with `k` screen px in scene units.
   *
   * A plug within reach wins outright — that is the precise gesture. Failing
   * that, anywhere on a shape, or in a halo just outside it, starts a connector
   * from the side of that shape the point is nearest. Dragging only from the
   * four dots would make the dots the tool; the shape is the tool.
   */
  const resolve = (at: Point, k: number): Plug | null => {
    const grab = GRAB * k;
    let best: { id: NodeId; side: EdgeSide; d: number } | null = null;
    for (const node of nodes) {
      const box = boxes.get(node.id);
      if (!box) continue;
      for (const { side, at: plug } of plugPoints(box)) {
        const d = Math.hypot(plug.x - at.x, plug.y - at.y);
        if (d <= grab && (!best || d < best.d)) best = { id: node.id, side, d };
      }
    }
    if (best) return { id: best.id, side: best.side };

    const hit = hitTest(scene, at);
    const onShape = hit && boxes.has(hit.id) ? hit.id : null;
    if (onShape) {
      return { id: onShape, side: sideNearest(boxes.get(onShape)!, at) };
    }

    const reach = HALO * k;
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

  /** Land or abandon. The pending frame goes with it, or a stale one could
   *  paint a preview back over a connector that has already landed. */
  const end = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    dragRef.current = null;
    if (preview.current) preview.current.style.display = "none";
    if (ring.current) ring.current.style.display = "none";
    setGrabbed(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dragRef.current) {
        e.stopPropagation();
        end();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      // A frame that outlived the component would write to detached elements.
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [end]);

  /**
   * The live line and the box it would land on, written once per frame. With
   * nothing under the pointer the cursor stands in as a small box, so that the
   * preview and the finished connector come out of the same router.
   */
  const paint = (d: Drag) => {
    const line = preview.current;
    const target = ring.current;
    if (!line || !target) return;

    const from = boxes.get(d.from) ?? absoluteBounds(scene, d.from);
    const to = d.over
      ? absoluteBounds(scene, d.over)
      : {
          x: d.at.x - CURSOR_BOX / 2,
          y: d.at.y - CURSOR_BOX / 2,
          w: CURSOR_BOX,
          h: CURSOR_BOX,
        };
    // Over a real target, both sides are derived, exactly as the finished
    // connector will be. Loose, the grabbed plug holds one end still so the
    // line does not flip sides as the pointer crosses the box's midline.
    const sides: [EdgeSide, EdgeSide] | undefined = d.over
      ? undefined
      : [d.side, "left"];
    // Rounded like the finished connector, and at the same radius: the preview
    // is a promise about what you are about to get.
    line.setAttribute("d", pointsToPath(elbowPoints(from, to, sides)));
    line.style.display = "";

    // The ring belongs to the level's own nodes, the only ones wearing plugs;
    // a release still lands on whatever the hit test found underneath.
    const box = d.over ? boxes.get(d.over) : undefined;
    if (!box) {
      target.style.display = "none";
      return;
    }
    target.setAttribute("x", String(box.x));
    target.setAttribute("y", String(box.y));
    target.setAttribute("width", String(box.w));
    target.setAttribute("height", String(box.h));
    target.style.display = "";
  };

  /** One visual update per animation frame, however fast the pointer reports.
   *  Dragging paints; hovering resolves, and renders only when the answer to
   *  "which plug" has actually changed. */
  const frame = () => {
    const at = viewport.clientToScene(clientRef.current);
    const current = dragRef.current;
    if (!current) {
      const found = resolve(at, 1 / viewport.get().zoom);
      setHover((prev) =>
        prev?.id === found?.id && prev?.side === found?.side ? prev : found,
      );
      return;
    }
    const hit = hitTest(scene, at);
    // Any node is a legal end except the one we started from — a connector from
    // a thing to itself has no route and nothing to say.
    current.at = at;
    current.over = hit && hit.id !== current.from ? hit.id : null;
    paint(current);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const at = viewport.clientToScene({ x: e.clientX, y: e.clientY });
    const start = resolve(at, 1 / viewport.get().zoom);
    if (!start) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    clientRef.current = { x: e.clientX, y: e.clientY };
    const next: Drag = { from: start.id, side: start.side, at, over: null };
    dragRef.current = next;
    paint(next);
    setGrabbed(start);
    setHover(null);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    clientRef.current = { x: e.clientX, y: e.clientY };
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      frame();
    });
  };

  const onPointerUp = () => {
    const current = dragRef.current;
    end();
    if (!current?.over) return;
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
  };

  /** Leaving with nothing in flight drops the aim — and the frame that would
   *  otherwise put it straight back. */
  const onPointerLeave = () => {
    if (dragRef.current) return;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    setHover(null);
  };

  return (
    <div
      className="nt-connector"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={end}
      onPointerLeave={onPointerLeave}
    >
      <svg className="nt-connector-svg" aria-hidden>
        <g ref={layer}>
          {/* Mounted for the life of the tool and merely hidden: a drag writes
              into these two, and an element a gesture paints has to exist
              before the gesture starts. */}
          <path
            ref={preview}
            className="nt-connector-preview"
            style={{ display: "none" }}
          />
          <rect
            ref={ring}
            className="nt-connector-target"
            style={{ display: "none" }}
          />
          {nodes.flatMap((node) => {
            const box = boxes.get(node.id);
            if (!box) return [];
            return plugPoints(box).map(({ side, at }) => {
              const live = grabbed
                ? grabbed.id === node.id && grabbed.side === side
                : hover?.id === node.id && hover.side === side;
              return (
                <circle
                  key={`${node.id}:${side}`}
                  className={`nt-connector-plug${live ? " is-live" : ""}`}
                  cx={at.x}
                  cy={at.y}
                />
              );
            });
          })}
        </g>
      </svg>
    </div>
  );
}
