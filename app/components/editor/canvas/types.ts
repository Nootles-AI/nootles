import type { Node, Edge } from "@xyflow/react";

export type ShapeKind = "rectangle" | "ellipse" | "diamond" | "text";

export type ShapeNodeData = {
  label: string;
  shape: ShapeKind;
  [key: string]: unknown;
};

export type ShapeNode = Node<ShapeNodeData, "shape">;
export type CanvasEdge = Edge;

export type CanvasData = {
  nodes: ShapeNode[];
  edges: CanvasEdge[];
};

/** Persist only the durable fields (drop React Flow's transient runtime state). */
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

/** Default shape box, mirrored by the suggestion preview so both agree. */
export const SHAPE_W = 148;
export const SHAPE_H = 64;

export const CANVAS_MIN_H = 260;
export const CANVAS_MAX_H = 560;
const CANVAS_PAD = 72;

/**
 * Height a canvas should occupy for the given shapes. Used by BOTH the real
 * canvas and the faded suggestion preview so that accepting a diagram doesn't
 * snap the page height around.
 */
export function canvasHeightFor(
  nodes: Array<{ position?: { y: number }; y?: number; height?: number | null }>,
): number {
  if (!nodes.length) return CANVAS_MIN_H;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const y = n.position?.y ?? n.y ?? 0;
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y + (n.height ?? SHAPE_H));
  }
  const content = maxY - minY;
  return Math.round(
    Math.min(CANVAS_MAX_H, Math.max(CANVAS_MIN_H, content + CANVAS_PAD)),
  );
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
