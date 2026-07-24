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
