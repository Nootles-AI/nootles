"use client";

import { memo, useLayoutEffect, useMemo, useRef } from "react";
import {
  edgePoints,
  obstaclesFor,
  pointsToPath,
  polylineMidpoint,
  sceneObstacles,
} from "../scene/edgePath";
import type { ViewportController } from "../engine/useViewport";
import type { EdgeId, Scene } from "../scene/types";
import { toCss } from "./ShapeView";
import "./edges.css";

/**
 * Every connector on the canvas, drawn under the shapes.
 *
 * Under, because a connector joins two shapes and reads as running behind
 * them; the arrowhead lands on the box's edge, so nothing is lost by it. That
 * does put a line partly beneath a shape that overlaps it, which is why the
 * hit path below is a fat transparent stroke — you click the part you can see.
 *
 * Nothing here is stateful and nothing measures: the polyline is a pure
 * function of the two boxes (see `scene/edgePath`), so this re-renders from the
 * scene alone and a drag that moves a shape re-routes its connectors for free.
 *
 * The one thing it does own imperatively is `--k` — one screen px in scene
 * units — which the hit strip counter-scales through so a connector stays as
 * easy to click at 25% as at 400%. Written onto this layer's own root rather
 * than inherited from the scene layer: a custom property changing on the shapes'
 * shared ancestor invalidates style for every shape in the diagram on every
 * frame of a zoom, which is exactly the cost the viewport's compositing
 * promotion exists to avoid. The overlay, the connector tool and the presence
 * layer each own theirs for the same reason.
 */

/** Marker ids are document-global, so they carry the block's own id. */
const ARROW = "nt-edge-arrow";

export interface EdgeLayerProps {
  scene: Scene;
  /**
   * Subscribed to imperatively, for `--k`; never read during a render. Absent
   * on a still preview, which has no viewport to zoom — the CSS fallback of 1
   * is then exactly right.
   */
  viewport?: ViewportController;
  selected: ReadonlySet<EdgeId>;
  hoverId: EdgeId | null;
  /** Absent while the connector tool owns the pointer. */
  onPick?: (id: EdgeId, event: React.PointerEvent) => void;
  onHover?: (id: EdgeId | null) => void;
}

export const EdgeLayer = memo(function EdgeLayer({
  scene,
  viewport,
  selected,
  hoverId,
  onPick,
  onHover,
}: EdgeLayerProps) {
  // Routing is a pure function of the scene, and hovering a line is not an
  // edit: without this, gliding the pointer across the connectors re-routes
  // every one of them to toggle a class name.
  const drawn = useMemo(() => {
    if (scene.edges.length === 0) return [];
    // One pass over the nodes for the whole layer, not one per connector.
    const obstacles = sceneObstacles(scene);
    return scene.edges.flatMap((edge) => {
      const points = edgePoints(scene, edge, obstaclesFor(obstacles, edge));
      // A connector naming a node that is not there is kept in the file — the
      // author can still fix it — but there is nothing to draw between.
      return points
        ? [{ edge, d: pointsToPath(points), at: polylineMidpoint(points) }]
        : [];
    });
  }, [scene]);

  const root = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    if (!viewport) return;
    let painted = 0;
    const write = () => {
      const zoom = viewport.get().zoom;
      // Only on an actual zoom: a pan notifies every frame and moves nothing
      // here, and a discarded custom-property parse is not free.
      if (zoom === painted) return;
      painted = zoom;
      root.current?.style.setProperty("--k", String(1 / zoom));
    };
    write();
    return viewport.subscribe(write);
  });

  if (drawn.length === 0) return null;

  return (
    <>
      <svg ref={root} className="nt-edges" aria-hidden>
        <defs>
          <marker
            id={ARROW}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
            markerUnits="userSpaceOnUse"
          >
            <path d="M0 0.5 10 5 0 9.5Z" fill="context-stroke" />
          </marker>
        </defs>

        {drawn.map(({ edge, d }) => {
          const state =
            (selected.has(edge.id) ? " is-selected" : "") +
            (hoverId === edge.id ? " is-hover" : "");
          return (
            <g key={edge.id} className={`nt-edge${state}`}>
              <path
                className="nt-edge-line"
                data-edge={edge.id}
                d={d}
                style={toCss(edge.style)}
                markerEnd={`url(#${ARROW})`}
              />
              {/* The target. Wide, transparent, and on top of its own line, so
                  a 1px connector is as clickable as a shape. */}
              <path
                className="nt-edge-hit"
                data-edge={edge.id}
                d={d}
                onPointerDown={onPick && ((e) => onPick(edge.id, e))}
                onPointerEnter={onHover && (() => onHover(edge.id))}
                onPointerLeave={onHover && (() => onHover(null))}
              />
            </g>
          );
        })}
      </svg>

      {/* Labels are HTML, not SVG text: they inherit the same typography the
          shapes use, and a shape's label and a connector's should not be two
          different rendering paths. */}
      {drawn.map(({ edge, at }) => {
        if (!edge.label) return null;
        return (
          <div
            key={edge.id}
            data-edge-label={edge.id}
            className={`nt-edge-label${selected.has(edge.id) ? " is-selected" : ""}`}
            style={{ left: at.x, top: at.y }}
          >
            {edge.label}
          </div>
        );
      })}
    </>
  );
});
