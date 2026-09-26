import { bandHeight } from "./scene/band";
import type { Scene } from "./scene/types";

/**
 * The legacy JSON canvas shape, and the block's height rule.
 *
 * A canvas block now stores canvas HTML and the renderer reads it through
 * `scene/`; nothing here describes what is on screen any more. Two callers keep
 * it alive: the shape ops in `app/lib/ai/apply.ts`, which still speak
 * node/edge JSON and are dormant while diagram review is whole-diagram, and the
 * suggestion preview, which needs the block's height to agree with the real one.
 *
 * The types were React Flow's; they are stated here now, so removing the
 * library did not have to rewrite the applier.
 */

export type ShapeKind = "rectangle" | "ellipse" | "diamond" | "text";

export type ShapeNode = {
  id: string;
  type: "shape";
  position: { x: number; y: number };
  width?: number | null;
  height?: number | null;
  data: { label: string; shape: ShapeKind };
};

export type CanvasEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
};

export type CanvasData = {
  nodes: ShapeNode[];
  edges: CanvasEdge[];
};

export function serializeCanvas(nodes: ShapeNode[], edges: CanvasEdge[]): string {
  return JSON.stringify({
    nodes: nodes.map((n) => ({
      id: n.id,
      type: "shape",
      position: n.position,
      width: n.width,
      height: n.height,
      data: { label: n.data.label ?? "", shape: n.data.shape },
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
      ...(typeof e.label === "string" && e.label ? { label: e.label } : {}),
    })),
  });
}

export function parseCanvas(source: string): CanvasData {
  if (!source) return { nodes: [], edges: [] };
  try {
    const parsed = JSON.parse(source) as CanvasData;
    return { nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] };
  } catch {
    return { nodes: [], edges: [] };
  }
}

/** Default shape box, mirrored by the suggestion preview so both agree. */
export const SHAPE_W = 148;
export const SHAPE_H = 64;

/**
 * The height a canvas block takes, from the scene alone: its band's
 * (`scene/band.ts`).
 *
 * Here rather than in the surface that draws it because the suggestion preview
 * has to reach the same answer: it is drawn where the block will land, so a
 * preview an inch shorter than the block is a page that jumps on Tab.
 */
export function sceneBlockHeight(scene: Scene): number {
  return bandHeight(scene);
}
