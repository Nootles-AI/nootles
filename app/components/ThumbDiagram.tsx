"use client";

import { useMemo } from "react";
import { ScenePreview, sceneFrom } from "./editor/ai/ScenePreview";

/**
 * A diagram inside a thumbnail, drawn by the canvas itself.
 *
 * Its own module so the canvas renderer is loaded only by a page that actually
 * has a diagram on it — most do not, and this is the projects screen, which
 * otherwise has no reason to pull the scene graph in.
 *
 * `ScenePreview` fits the scene to its box, and the box here is measured in
 * document pixels because the scaling happens above it. So the diagram is laid
 * out exactly as the block lays it out, then shrunk with everything else.
 */
export default function ThumbDiagram({ data }: { data: string }) {
  // A full HTML parse of the diagram, pure on the source — so it belongs to
  // the string, not to the render.
  const scene = useMemo(() => sceneFrom(data), [data]);
  if (!scene.nodes.length) return null;
  // Fills the slot rather than sizing itself. The slot exists before this
  // module does — see the canvas case in `PagePreview` — and it is the one
  // that knows how tall this diagram wants to be.
  return (
    <div className="nt-thumb-diagram">
      <ScenePreview scene={scene} />
    </div>
  );
}
