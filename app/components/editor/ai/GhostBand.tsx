"use client";

import { useLayoutEffect, useRef } from "react";
import { EdgeLayer } from "../canvas/render/EdgeLayer";
import { ShapeView, toCss } from "../canvas/render/ShapeView";
import type { EdgeId, Scene } from "../canvas/scene/types";
import { EMPTY_BAND_H } from "../canvas/scene/band";
import { COLUMN_WIDTH } from "@/app/lib/column";
import { followFit, followWide } from "@/app/lib/columnScale";
import { ghostBandHeight, PLANNING_LABEL, type DiagramPhase } from "./diagramGhost";
import "../canvas/canvas.css";

const NO_EDGES: ReadonlySet<EdgeId> = new Set();

/**
 * A suggested diagram, drawn as the band it would become: the same width, the
 * same page scale, the same origin on the text's edge and — for a wide one —
 * the same clipped margins, so Tab changes what it is, never where it is.
 *
 * The shapes are the canvas's own `ShapeView`s and `EdgeLayer`, keyed by id in
 * one long-lived root, so a chunk adds the shapes it brought and leaves the
 * ones already drawn alone.
 */
export function GhostBand({ phase, scene }: { phase: DiagramPhase; scene: Scene | null }) {
  const band = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const wide = !!scene?.wide;

  // The block's own mechanism (`CanvasSurface`): a column band follows the
  // page's fit; a wide one also takes the width its page shows, with the
  // scene's origin held on the text's edge by the margin that leaves.
  useLayoutEffect(() => {
    const el = band.current;
    const scene = layer.current;
    if (!el || !scene) return;
    if (!wide) {
      el.style.width = `${COLUMN_WIDTH}px`;
      scene.style.transform = "";
      return followFit(el);
    }
    return followWide(el, (margin) => {
      scene.style.transform = `translateX(${margin}px)`;
    });
  }, [wide]);

  return (
    <div
      ref={band}
      className="nt-diagram-ghost-band"
      data-wide={wide || undefined}
      style={{ height: ghostBandHeight(phase, scene) }}
    >
      <div className="nt-diagram-ghost-grid" aria-hidden />
      {/* Always mounted, so the first shape fades it out rather than cutting
          it; held to the planning band's height so it stays put as the band grows. */}
      <div
        className="nt-diagram-ghost-label"
        aria-hidden={phase !== "thinking"}
        style={{ height: EMPTY_BAND_H }}
      >
        {PLANNING_LABEL}
      </div>
      <div className="nt-canvas-viewport" style={scene ? toCss(scene.style) : undefined}>
        <div ref={layer} className="nt-canvas-scene">
          {scene && <EdgeLayer scene={scene} selected={NO_EDGES} hoverId={null} />}
          {scene?.nodes.map((node) => <ShapeView key={node.id} node={node} />)}
        </div>
      </div>
    </div>
  );
}
