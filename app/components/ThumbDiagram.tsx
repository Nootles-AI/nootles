"use client";

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
export default function ThumbDiagram({
  data,
  height,
}: {
  data: string;
  height?: number;
}) {
  const scene = sceneFrom(data);
  if (!scene.nodes.length) return null;
  /**
   * An explicit height is the diagram's OWN, and it is set inline for a reason:
   * `ScenePreview` fits to whatever it measures, so a box that arrives at one
   * size and settles at another makes the drawing jump — and a box shorter than
   * the drawing lets it spill over whatever is under it. A stylesheet cannot
   * carry a per-diagram number, and one that loads a beat late is exactly the
   * race that produces both.
   */
  return (
    <div className="nt-thumb-diagram" style={height ? { height } : undefined}>
      <ScenePreview scene={scene} />
    </div>
  );
}
