import type { ShapeNode, CanvasEdge } from "./types";

/**
 * Auto-layout the graph with elk's layered algorithm (lazy-loaded — elk is
 * heavy and only needed on demand). Returns nodes with updated positions.
 */
export async function layoutCanvas(
  nodes: ShapeNode[],
  edges: CanvasEdge[],
): Promise<ShapeNode[]> {
  if (nodes.length === 0) return nodes;
  const ELK = (await import("elkjs/lib/elk.bundled.js")).default;
  const elk = new ELK();

  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "56",
      "elk.layered.spacing.nodeNodeBetweenLayers": "84",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    },
    children: nodes.map((n) => ({
      id: n.id,
      width: n.width ?? 148,
      height: n.height ?? 64,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    })),
  };

  const res = await elk.layout(graph);
  const positions = new Map(
    (res.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]),
  );
  return nodes.map((n) => ({
    ...n,
    position: positions.get(n.id) ?? n.position,
  }));
}
