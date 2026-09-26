/**
 * The canvas clipboard: canvas HTML in, canvas HTML out.
 *
 * A copy serializes the selection through the grammar and puts that text on the
 * system clipboard, so what you copied is a valid canvas document: it survives a
 * trip through any text field, and canvas HTML pasted in from anywhere else —
 * a model's reply, another canvas, a file — is parsed by the same code that
 * parses a block. The in-memory copy is only the fallback for browsers that
 * refuse to hand over `clipboardData`.
 *
 * Kept apart from the keymap so the page's own paste can make a diagram out of
 * a clipboard without pulling the keymap in.
 */

import { COLUMN_WIDTH } from "@/app/lib/column";
import { BAND, EPS, fitToBand, normalizeDiagram } from "../scene/band";
import { absoluteRect, absoluteRotation, unionBounds } from "../scene/geometry";
import { emptyScene } from "../scene/migrate";
import { applyOps, mintEdgeIds, mintIds } from "../scene/ops";
import { parseScene, type ParseHtml } from "../scene/parse";
import { serializeScene } from "../scene/serialize";
import {
  isContainer,
  topSelection,
  walk,
  SCENE_TAG,
  TAG_BY_KIND,
  type NodeId,
  type Scene,
  type SceneEdge,
  type SceneNode,
  type SceneOp,
} from "../scene/types";

const CANVAS_TAGS = new RegExp(
  `<(${[SCENE_TAG, ...Object.values(TAG_BY_KIND)].join("|")})[\\s>]`,
  "i",
);

/** Whether some text off the system clipboard is ours to parse. */
export function isCanvasHtml(text: string): boolean {
  return CANVAS_TAGS.test(text);
}

/**
 * The last copy made on this page, and the diagrams it came out of. Read when
 * the browser withholds `clipboardData`, and to tell a paste back over its own
 * originals — which lands beside them — from a paste anywhere else.
 */
let held: { html: string; blockIds: readonly string[] } | null = null;

export function rememberCopy(html: string, blockIds: readonly string[] = []): void {
  held = { html, blockIds };
}

export function lastCopy(): { html: string; blockIds: readonly string[] } | null {
  return held;
}

export function countNodes(nodes: readonly SceneNode[]): number {
  let n = 0;
  walk(nodes, () => {
    n++;
  });
  return n;
}

/**
 * A deep copy with every id replaced, so it can be inserted alongside the
 * original. `map` records old → new for callers that have to follow the copy —
 * connectors name their endpoints by id, and are meaningless without it.
 */
export function reid(
  node: SceneNode,
  next: () => NodeId,
  map?: Map<NodeId, NodeId>,
): SceneNode {
  const id = next();
  map?.set(node.id, id);
  return isContainer(node)
    ? {
        ...node,
        id,
        children: node.children.map((child) => reid(child, next, map)),
      }
    : { ...node, id };
}

/** Fresh copies of `nodes`, translated, with ids that collide with nothing in `scene`. */
export function copiesInto(
  scene: Scene,
  nodes: readonly SceneNode[],
  dx: number,
  dy: number,
  map?: Map<NodeId, NodeId>,
): SceneNode[] {
  const ids = mintIds(scene, countNodes(nodes));
  let i = 0;
  const next = () => ids[i++];
  return nodes.map((node) => {
    const copy = reid(node, next, map);
    return { ...copy, x: copy.x + dx, y: copy.y + dy };
  });
}

/** The connectors among `edges` whose both ends were copied, onto the copies' ids. */
export function remapEdges(
  scene: Scene,
  edges: readonly SceneEdge[],
  map: ReadonlyMap<NodeId, NodeId>,
): SceneEdge[] {
  const wanted = edges.filter((edge) => map.has(edge.from) && map.has(edge.to));
  const ids = mintEdgeIds(scene, wanted.length);
  return wanted.map((edge, i) => ({
    ...edge,
    id: ids[i],
    from: map.get(edge.from)!,
    to: map.get(edge.to)!,
  }));
}

/**
 * The selection as a canvas fragment, flattened into scene space.
 *
 * Flattening is what makes the result meaningful anywhere: a shape copied out of
 * a group carries the position it appeared to have, so pasting it at the top
 * level, into a different group, or into a different canvas puts it where it
 * looked like it was. Its own children stay relative to it and are untouched.
 */
function clipboardFragment(scene: Scene, ids: readonly NodeId[]): Scene | null {
  const nodes = topSelection(scene, ids);
  if (nodes.length === 0) return null;
  const flattened = nodes.map((node) => {
    const box = absoluteRect(scene, node.id);
    return {
      ...node,
      x: box.x,
      y: box.y,
      rot: absoluteRotation(scene, node.id),
    };
  });
  // Connectors whose BOTH ends are inside the copy. An edge with one end left
  // behind has nothing to attach to over there. Descendants count: a group
  // travels with its children, so the edges between them travel too.
  const carried = new Set<NodeId>();
  walk(flattened, (node) => {
    carried.add(node.id);
  });
  const edges = scene.edges.filter(
    (edge) => carried.has(edge.from) && carried.has(edge.to),
  );
  return { w: scene.w, h: scene.h, style: {}, nodes: flattened, edges, attrs: {} };
}

/** {@link clipboardFragment}, serialized — what one diagram's copy writes. */
export function clipboardHtml(scene: Scene, ids: readonly NodeId[]): string | null {
  const fragment = clipboardFragment(scene, ids);
  return fragment ? serializeScene(fragment) : null;
}

/** One diagram's share of a copy spanning several. */
export type ClipboardPart = {
  scene: Scene;
  ids: readonly NodeId[];
  /** How far below the topmost copied band this one's top is, in band px. */
  dy: number;
};

/**
 * A selection spanning diagrams as one canvas document. Every band's origin is
 * the text column's left edge, so the parts line up across without moving and
 * stack down by how far apart their bands are. Ids are minted afresh against
 * the whole copy — `n1` is in every diagram — and the connectors follow them.
 */
export function pageClipboardHtml(parts: readonly ClipboardPart[]): string | null {
  const holding = parts.filter((part) => part.ids.length > 0);
  if (holding.length === 0) return null;
  if (holding.length === 1 && holding[0].dy === 0) return clipboardHtml(holding[0].scene, holding[0].ids);
  const acc: Scene = { w: 0, h: 0, style: {}, nodes: [], edges: [], attrs: {} };
  for (const part of holding) {
    const fragment = clipboardFragment(part.scene, part.ids);
    if (!fragment) continue;
    const map = new Map<NodeId, NodeId>();
    const copies = copiesInto(acc, fragment.nodes, 0, part.dy, map);
    acc.nodes = [...acc.nodes, ...copies];
    acc.edges = [...acc.edges, ...remapEdges(acc, fragment.edges, map)];
    acc.h = Math.max(acc.h, Math.round(part.dy + part.scene.h));
  }
  return acc.nodes.length ? serializeScene(acc) : null;
}

/**
 * Where a pasted fragment lands in a diagram, as the ops that put it there and
 * the ids it lands under.
 *
 * It keeps the coordinates it was copied at — moved by `offset` both ways, so a
 * copy pasted back over its originals shows beside them — and is then held in
 * the band: a fragment wider than the column makes the diagram wide, one wider
 * than even that is scaled down to fit it, and anything off the band's sides
 * or above its top is moved in by the least amount. `parentId` pastes into an
 * entered group, whose children are in its own space.
 */
export function landFragment(
  target: Scene,
  fragment: Pick<Scene, "nodes" | "edges">,
  { offset = 0, parentId = null }: { offset?: number; parentId?: NodeId | null } = {},
): { ops: SceneOp[]; ids: NodeId[] } {
  if (fragment.nodes.length === 0) return { ops: [], ids: [] };
  const nodes = offset
    ? fragment.nodes.map((node) => ({ ...node, x: node.x + offset, y: node.y + offset }))
    : fragment.nodes;
  const visible = nodes.filter((node) => !node.hidden);
  const box = unionBounds(visible.length ? visible : nodes);
  const wide = target.wide === true || box.w > COLUMN_WIDTH + EPS;
  const placed = fitToBand({
    ...emptyScene(),
    nodes,
    edges: fragment.edges,
    ...(wide ? { wide: true as const } : {}),
  });

  const origin = parentId ? absoluteRect(target, parentId) : { x: 0, y: 0 };
  const map = new Map<NodeId, NodeId>();
  const copies = copiesInto(target, placed.nodes, -origin.x, -origin.y, map);
  const edges = remapEdges(target, placed.edges, map);
  const ops: SceneOp[] = [];
  if (wide && target.wide !== true) ops.push({ type: "setDiagram", wide: true });
  ops.push({ type: "insert", nodes: copies, parentId });
  if (edges.length) ops.push({ type: "addEdge", edges });
  return { ops, ids: copies.map((node) => node.id) };
}

/**
 * A diagram block's source made from canvas HTML pasted into the page's text:
 * the fragment's top at the band's margin, landed as it would be in an empty
 * diagram. `null` when there is nothing in it to draw.
 */
export function diagramFromClipboard(html: string, parseHtml?: ParseHtml): string | null {
  const fragment = parseScene(html, parseHtml);
  if (fragment.nodes.length === 0) return null;
  const top = unionBounds(fragment.nodes).y;
  const lifted = fragment.nodes.map((node) => ({ ...node, y: node.y - top + BAND }));
  const base = emptyScene();
  const { ops } = landFragment(base, { nodes: lifted, edges: fragment.edges });
  return serializeScene(normalizeDiagram(applyOps(base, ops)));
}
