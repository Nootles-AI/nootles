"use client";

import { useLayoutEffect, useRef } from "react";
import { EdgeLayer } from "../canvas/render/EdgeLayer";
import { ShapeView, toCss } from "../canvas/render/ShapeView";
import { bandHeight, bandLeft, bandWidth } from "../canvas/scene/band";
import { migrateLegacyCanvas } from "../canvas/scene/migrate";
import { walk, type EdgeId, type Scene } from "../canvas/scene/types";
import "../canvas/canvas.css";

/**
 * A diagram the document does not have yet, drawn by the canvas itself.
 *
 * The same `ShapeView` and `EdgeLayer` the real block renders, given the same
 * `Scene` — so the preview cannot drift from the result, and there is no second
 * renderer to keep true. That matters more here than anywhere else in the
 * preview set: the old sketch flattened every kind to a rectangle, drew all of
 * them at one size, and dropped connectors entirely, so a diagram that was
 * about to be inserted was previewed as something else.
 *
 * Nothing interactive is passed. No `editingId`, no pick or hover handlers —
 * absent, both components render as pure functions of the scene, which is
 * exactly what a preview is.
 */

const NO_EDGES: ReadonlySet<EdgeId> = new Set();

/** The stored source as a scene, whichever generation wrote it. */
export function sceneFrom(source: string): Scene {
  return migrateLegacyCanvas(source);
}

/**
 * What the head line claims the diagram is. Counted off the parsed scene rather
 * than off the markup, so it counts what will actually be drawn — nested shapes
 * included, and connectors, which the head could not mention while the preview
 * was throwing them away.
 */
export function sceneSummary(source: string): string {
  const scene = sceneFrom(source);
  let shapes = 0;
  walk(scene.nodes, () => {
    shapes += 1;
  });
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const edges = scene.edges.length;
  return `diagram (${plural(shapes, "shape")}${
    edges ? `, ${plural(edges, "connector")}` : ""
  })`;
}

export function ScenePreview({ scene }: { scene: Scene }) {
  const viewport = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);

  /**
   * Places the band the way the block does: its left edge on the box's, the
   * shapes where they will land, never centred — so accepting a suggestion
   * moves nothing sideways. A band wider than the box, which is a wide one in
   * the column, shrinks uniformly to fit rather than being cut off; nothing
   * ever grows. The transform goes on `.nt-canvas-scene`, the layer the canvas
   * itself positions, so this is the same mechanism set once.
   */
  useLayoutEffect(() => {
    const box = viewport.current;
    const el = layer.current;
    if (!box || !el) return;

    const fit = () => {
      const { clientWidth: w, clientHeight: h } = box;
      if (!w || !h) return;
      // The height term only bites when a host gives less room than
      // `bandHeightIn` asks for, which is better shrunk than cropped.
      const scale = Math.min(1, w / bandWidth(scene), h / bandHeight(scene));
      // From the top left, where every coordinate is measured; the default
      // centre origin would add `(1 - scale) × half the box` to each of them.
      el.style.transformOrigin = "0 0";
      el.style.transform = `scale(${scale}) translateX(${-bandLeft(scene)}px)`;
    };

    fit();
    // The block tracks the document column, so the box width is not known until
    // it is laid out — and changes when the window does.
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [scene]);

  return (
    // The surface's own background and the transformed layer under it, the way
    // `CanvasSurface` nests them — the shapes are absolutely positioned inside
    // the scene layer and read their coordinates from it.
    <div ref={viewport} className="nt-canvas-viewport" style={toCss(scene.style)}>
      <div ref={layer} className="nt-canvas-scene">
        <EdgeLayer scene={scene} selected={NO_EDGES} hoverId={null} />
        {scene.nodes.map((node) => (
          <ShapeView key={node.id} node={node} />
        ))}
      </div>
    </div>
  );
}
