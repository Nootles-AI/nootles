import { laidOutScene, layoutModeOf } from "@/app/components/editor/canvas/scene/autoLayout";
import { bandHeight, bandLeft, bandWidth } from "@/app/components/editor/canvas/scene/band";
import { edgePoints, polylineMidpoint } from "@/app/components/editor/canvas/scene/edgePath";
import { absoluteBounds, absoluteRect, absoluteRotation } from "@/app/components/editor/canvas/scene/geometry";
import {
  displayName,
  isGroup,
  nodePath,
  walk,
  type GroupNode,
  type Rect,
  type Scene,
  type SceneNode,
  type SceneNodeKind,
} from "@/app/components/editor/canvas/scene/types";
import { AI } from "../aiConfig";

/**
 * `get_geometry`'s report — "where everything on a diagram is" (TOOLS.md
 * §5.1): every shape's absolute box after layout, its parent/depth, and the
 * points each connector runs through. Reads {@link laidOutScene} so an
 * auto-layout child's real, laid-out position is what the model sees, never
 * its (often absent) authored `x`/`y`. Pure — touches neither the live store
 * nor the viewport, and never mutates the `Scene` it is handed:
 * `laidOutScene` returns a new object only where an auto-layout group's
 * children actually needed placing, so an unaffected input keeps its
 * identity.
 */

export type NodeGeometry = {
  id: string;
  kind: SceneNodeKind;
  name: string;
  parent: string | null;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  bounds?: Rect;
  layout?: "flex" | "grid";
  hidden?: true;
  locked?: true;
};

export type EdgeGeometry = {
  id: string;
  from: string;
  to: string;
  label?: string;
  points: [number, number][] | null;
  mid?: [number, number];
};

export type GeometryReport = {
  /** The band the shapes sit in: its left edge (negative when wide), width
   *  and drawn height, all in the same px as the boxes. */
  diagram: { x: number; w: number; h: number };
  nodes: NodeGeometry[];
  edges: EdgeGeometry[];
  omitted?: number;
};

const round = (n: number) => Math.round(n * 100) / 100;

type Candidate = { node: SceneNode; parent: GroupNode | null; depth: number };

export function geometryReport(
  scene: Scene,
  opts: { ids?: readonly string[]; depth?: number; max?: number } = {},
): GeometryReport {
  const laid = laidOutScene(scene);
  const wanted = opts.ids?.length ? new Set(opts.ids) : null;
  const max = opts.max ?? AI.chat.canvas.maxGeometryNodes;

  const all: Candidate[] = [];
  walk(laid.nodes, (node, parent) => {
    all.push({ node, parent, depth: nodePath(laid, node.id).length - 1 });
  });

  const relevant = all.filter(({ node }) => {
    if (wanted && !nodePath(laid, node.id).some((n) => wanted.has(n.id))) return false;
    if (opts.depth !== undefined && nodePath(laid, node.id).length - 1 > opts.depth) return false;
    return true;
  });

  const capped = relevant.slice(0, max);
  const omitted = relevant.length - capped.length;
  const includedIds = new Set(capped.map((c) => c.node.id));

  const nodes: NodeGeometry[] = capped.map(({ node, parent, depth }) => {
    const rect = absoluteRect(laid, node.id);
    const rot = absoluteRotation(laid, node.id);
    const entry: NodeGeometry = {
      id: node.id,
      kind: node.kind,
      name: displayName(node),
      parent: parent?.id ?? null,
      depth,
      x: round(rect.x),
      y: round(rect.y),
      w: round(rect.w),
      h: round(rect.h),
      rot: round(rot),
    };
    if (rot !== 0) {
      const bounds = absoluteBounds(laid, node.id);
      entry.bounds = { x: round(bounds.x), y: round(bounds.y), w: round(bounds.w), h: round(bounds.h) };
    }
    if (isGroup(node)) {
      const mode = layoutModeOf(node);
      if (mode !== "none") entry.layout = mode;
    }
    if (node.hidden) entry.hidden = true;
    if (node.locked) entry.locked = true;
    return entry;
  });

  const edges: EdgeGeometry[] = [];
  for (const edge of laid.edges) {
    if (wanted && (!includedIds.has(edge.from) || !includedIds.has(edge.to))) continue;
    const points = edgePoints(laid, edge);
    const entry: EdgeGeometry = {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      points: points ? points.map((p): [number, number] => [round(p.x), round(p.y)]) : null,
    };
    if (points?.length) {
      const mid = polylineMidpoint(points);
      entry.mid = [round(mid.x), round(mid.y)];
    }
    if (edge.label.trim()) entry.label = edge.label;
    edges.push(entry);
  }

  return {
    diagram: { x: bandLeft(scene), w: bandWidth(scene), h: bandHeight(scene) },
    nodes,
    edges,
    ...(omitted ? { omitted } : {}),
  };
}

/**
 * The report as the model is handed it: one line per shape and per connector.
 *
 * The same facts as {@link GeometryReport}, without a key repeated on every
 * value — keyed JSON spent about twice the characters on an 800-shape board,
 * and the whole of it rides every later step of the turn (NT-98). A header
 * names the columns once, so the rows read without the tool's description.
 */
export function geometryText(report: GeometryReport): string {
  const { diagram, nodes, edges, omitted } = report;
  const lines = [
    `diagram ${diagram.w}×${diagram.h}${diagram.x ? ` from x=${diagram.x}` : ""}. Canvas pixels, x=0 at the text's left edge and y=0 the diagram's top; rot in degrees; parent - is the top level.`,
    ...(nodes.length ? [SHAPE_COLUMNS, ...shapeRows(nodes)] : ["no shapes"]),
  ];
  if (edges.length) {
    lines.push(EDGE_COLUMNS);
    for (const edge of edges) {
      lines.push(
        [
          edge.id,
          `${edge.from}>${edge.to}`,
          ...(edge.mid ? [`mid=${edge.mid.join(",")}`] : []),
          ...(edge.label ? [`label=${JSON.stringify(edge.label)}`] : []),
          edge.points ? `points=${edge.points.map((p) => p.join(",")).join(" ")}` : "unrouted",
        ].join(" "),
      );
    }
  }
  if (omitted) {
    lines.push(`${omitted} more shape${omitted === 1 ? "" : "s"} not listed. Pass ids or depth to see them.`);
  }
  return lines.join("\n");
}

const SHAPE_COLUMNS = 'shapes: id kind "name" parent depth x y w h rot, then layout=, bounds=x,y,w,h (a rotated shape\'s box), hidden, locked where they apply';
const EDGE_COLUMNS = "connectors: id from>to mid=x,y label=, then the points it runs through";

/** A shape per line, in {@link geometryText}'s columns — also a write tool's tail. */
export function shapeRows(nodes: readonly NodeGeometry[]): string[] {
  return nodes.map((node) =>
    [
      node.id,
      node.kind,
      JSON.stringify(node.name),
      node.parent ?? "-",
      node.depth,
      node.x,
      node.y,
      node.w,
      node.h,
      node.rot,
      ...(node.layout ? [`layout=${node.layout}`] : []),
      ...(node.bounds ? [`bounds=${[node.bounds.x, node.bounds.y, node.bounds.w, node.bounds.h].join(",")}`] : []),
      ...(node.hidden ? ["hidden"] : []),
      ...(node.locked ? ["locked"] : []),
    ].join(" "),
  );
}
