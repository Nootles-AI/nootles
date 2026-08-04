"use client";

import { useLayoutEffect, useRef } from "react";
import { EdgeLayer } from "../canvas/render/EdgeLayer";
import { ShapeView, toCss } from "../canvas/render/ShapeView";
import { unionBounds } from "../canvas/scene/geometry";
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

/** Breathing room between the content and the edge of the preview. */
const FIT_PAD = 16;

export function ScenePreview({ scene }: { scene: Scene }) {
  const viewport = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);

  /**
   * Fits the content to the box, which is the one place the preview departs
   * from the block on purpose.
   *
   * The block opens at the identity transform and lets you pan and zoom from
   * there; a preview has no pointer, so a diagram laid out past the document
   * column would simply be cut off with no way to see the rest. The transform
   * goes on `.nt-canvas-scene`, which is the element the canvas itself pans and
   * zooms — so this is the same mechanism, set once, not a second layout.
   */
  useLayoutEffect(() => {
    const box = viewport.current;
    const el = layer.current;
    if (!box || !el) return;

    const fit = () => {
      const content = unionBounds(scene.nodes);
      const { clientWidth: w, clientHeight: h } = box;
      if (!w || !h || content.w <= 0 || content.h <= 0) return;
      // Only ever shrinks: a four-shape diagram blown up to fill the box would
      // preview at a size it is never going to be.
      const scale = Math.min(
        1,
        (w - FIT_PAD * 2) / content.w,
        (h - FIT_PAD * 2) / content.h,
      );
      const x = (w - content.w * scale) / 2 - content.x * scale;
      const y = (h - content.h * scale) / 2 - content.y * scale;
      // Both numbers above are measured from the top left, so the scale has to
      // be taken from there too. The default origin is the box's centre, which
      // silently adds `(1 - scale) × half the box` to every coordinate — enough
      // to push the right-hand column of a fitted diagram past the crop and
      // shave the border off it.
      el.style.transformOrigin = "0 0";
      el.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
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
