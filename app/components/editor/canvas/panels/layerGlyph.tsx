"use client";

/**
 * Per-kind layer glyphs — shared by the layers panel and the "Select layer ▸"
 * context-menu submenu (SELECT), so a node reads the same badge wherever it is
 * named. Moved verbatim out of `LayersPanel.tsx`.
 */

import { unitPolygon } from "../scene/geometry";
import type { SceneNode, SceneNodeKind } from "../scene/types";

/** 12px on the app's 24-unit icon grid. One path per glyph, so they are data. */
export function Glyph({ d, className }: { d: string; className?: string }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d={d} />
    </svg>
  );
}

const ROUNDED_BOX =
  "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z";
export const PADLOCK =
  "M6 10h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z";

const KIND_GLYPH: Record<SceneNodeKind, string> = {
  rect: ROUNDED_BOX,
  ellipse: "M3 12a9 7 0 1 0 18 0 9 7 0 1 0-18 0",
  text: "M5 6h14M12 6v12M9 18h6",
  image: `${ROUNDED_BOX}M4 17l5-4 4 3 3-2 4 3`,
  path: "M4 18C8 6 16 18 20 6",
  // A polygon's own outline is drawn by `glyphFor`; this is only the fallback
  // shape the union demands, and nothing reaches it.
  polygon: "M12 4l8 15H4Z",
  group:
    "M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2",
};

/**
 * A polygon's badge is the polygon: drawn from the same unit outline the canvas
 * paints, inset into the 24-box the other glyphs use. One triangle path would
 * have every side count wearing a triangle's badge — a diamond most visibly.
 */
export function glyphFor(node: SceneNode): string {
  if (node.kind !== "polygon") return KIND_GLYPH[node.kind];
  const at = (n: number) => Math.round((4 + n * 16) * 10) / 10;
  return `${unitPolygon(node.sides)
    .map((p, i) => `${i ? "L" : "M"}${at(p.x)} ${at(p.y)}`)
    .join("")}Z`;
}
