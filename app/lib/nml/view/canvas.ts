import type {
  Scene,
  SceneEdge,
  SceneNode,
} from "@/app/components/editor/canvas/scene/types";
import { walk } from "@/app/components/editor/canvas/scene/types";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import type { NmlAnchor, NmlCommand } from "../commands";

export type CanvasSceneCommands = {
  commands: NmlCommand[];
  changedNodeIds: string[];
};

type FlatShape = {
  node: SceneNode;
  parentId: string | null;
};

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

function flatten(scene: Scene): Map<string, FlatShape> {
  const result = new Map<string, FlatShape>();
  walk(scene.nodes, (node, parent) => {
    result.set(node.id, { node, parentId: parent?.id ?? null });
  });
  return result;
}

function childLists(scene: Scene): Map<string | null, string[]> {
  const result = new Map<string | null, string[]>([[null, []]]);
  walk(scene.nodes, (node, parent) => {
    const parentId = parent?.id ?? null;
    const siblings = result.get(parentId) ?? [];
    siblings.push(node.id);
    result.set(parentId, siblings);
    if (node.kind === "group" && !result.has(node.id)) result.set(node.id, []);
  });
  return result;
}

/**
 * Shapes whose structural placement this particular scene edit changed.
 * Insertions do not make untouched siblings look reordered, which is what
 * prevents a local gesture from overwriting a collaborator's order keys.
 */
function movedShapeIds(
  before: Scene,
  after: Scene,
  previous: Map<string, FlatShape>,
  desired: Map<string, FlatShape>,
): Set<string> {
  const moved = new Set<string>();
  for (const [id, entry] of desired) {
    const old = previous.get(id);
    if (!old || old.parentId !== entry.parentId) moved.add(id);
  }

  const beforeLists = childLists(before);
  for (const [parentId, ids] of childLists(after)) {
    const shared = new Set(
      ids.filter(
        (id) =>
          previous.has(id) && previous.get(id)?.parentId === parentId,
      ),
    );
    const oldOrder = (beforeLists.get(parentId) ?? []).filter((id) =>
      shared.has(id),
    );
    const newOrder = ids.filter((id) => shared.has(id));
    if (!same(oldOrder, newOrder)) newOrder.forEach((id) => moved.add(id));
  }
  return moved;
}

function placementAnchor(
  ids: readonly string[],
  index: number,
  available: ReadonlySet<string>,
): NmlAnchor | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (available.has(ids[cursor])) return { afterId: ids[cursor] };
  }
  for (let cursor = index + 1; cursor < ids.length; cursor++) {
    if (available.has(ids[cursor])) return { beforeId: ids[cursor] };
  }
  return undefined;
}

function shapeFields(node: SceneNode): Record<string, unknown> {
  const {
    id: _id,
    kind: _kind,
    label: _label,
    children: _children,
    ...fields
  } = node as SceneNode & { children?: SceneNode[] };
  return fields;
}

function graphemes(value: string): Array<{ value: string; offset: number }> {
  const Segmenter = Intl.Segmenter;
  if (!Segmenter) return [...value].map((part, index, all) => ({
    value: part,
    offset: all.slice(0, index).join("").length,
  }));
  return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(value)]
    .map((part) => ({ value: part.segment, offset: part.index }));
}

/** A minimal, grapheme-safe UTF-16 replacement for a collaborative Y.Text. */
export function canvasTextDiff(
  before: string,
  after: string,
): { range: { from: number; to: number }; text: string } | null {
  if (before === after) return null;
  const oldParts = graphemes(before);
  const newParts = graphemes(after);
  let prefix = 0;
  while (
    prefix < oldParts.length &&
    prefix < newParts.length &&
    oldParts[prefix].value === newParts[prefix].value
  ) prefix++;
  let suffix = 0;
  while (
    suffix < oldParts.length - prefix &&
    suffix < newParts.length - prefix &&
    oldParts[oldParts.length - 1 - suffix].value ===
      newParts[newParts.length - 1 - suffix].value
  ) suffix++;
  const from = oldParts[prefix]?.offset ?? before.length;
  const to = oldParts[oldParts.length - suffix]?.offset ?? before.length;
  const insertFrom = newParts[prefix]?.offset ?? after.length;
  const insertTo = newParts[newParts.length - suffix]?.offset ?? after.length;
  return { range: { from, to }, text: after.slice(insertFrom, insertTo) };
}

function newShapeForest(
  scene: Scene,
  previous: ReadonlyMap<string, FlatShape>,
): Array<{ parentId: string | null; nodes: SceneNode[] }> {
  const byParent = new Map<string | null, SceneNode[]>();
  walk(scene.nodes, (node, parent) => {
    if (previous.has(node.id)) return;
    const parentId = parent?.id ?? null;
    // A contiguous new subtree is inserted with its root. New descendants of
    // a moved existing group are separate roots and are found by this walk.
    if (parentId !== null && !previous.has(parentId)) return;
    const clone = node.kind === "group"
      ? { ...node, children: cloneNewChildren(node.children, previous) }
      : structuredClone(node);
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(clone);
    byParent.set(parentId, siblings);
  });
  return [...byParent].map(([parentId, nodes]) => ({ parentId, nodes }));
}

function cloneNewChildren(
  nodes: readonly SceneNode[],
  previous: ReadonlyMap<string, FlatShape>,
): SceneNode[] {
  return nodes.flatMap((node): SceneNode[] => {
    if (previous.has(node.id)) return [];
    return [node.kind === "group"
      ? { ...node, children: cloneNewChildren(node.children, previous) }
      : structuredClone(node)];
  });
}

function shapePatches(
  before: SceneNode,
  after: SceneNode,
): Record<string, unknown | undefined> {
  const oldFields = shapeFields(before);
  const newFields = shapeFields(after);
  const patch: Record<string, unknown | undefined> = {};
  for (const key of new Set([
    ...Object.keys(oldFields),
    ...Object.keys(newFields),
  ])) {
    if (!same(oldFields[key], newFields[key])) patch[key] = newFields[key];
  }
  return patch;
}

function edgePatch(
  before: SceneEdge,
  after: SceneEdge,
): Partial<Omit<SceneEdge, "id" | "label">> {
  const patch: Partial<Omit<SceneEdge, "id" | "label">> = {};
  for (const key of ["from", "to", "style", "attrs"] as const) {
    if (!same(before[key], after[key])) {
      Object.assign(patch, { [key]: after[key] });
    }
  }
  return patch;
}

function edgeOrderChanged(before: readonly SceneEdge[], after: readonly SceneEdge[]): boolean {
  const beforeIds = new Set(before.map((edge) => edge.id));
  const afterIds = new Set(after.map((edge) => edge.id));
  return !same(
    before.filter((edge) => afterIds.has(edge.id)).map((edge) => edge.id),
    after.filter((edge) => beforeIds.has(edge.id)).map((edge) => edge.id),
  );
}

/**
 * Compile one committed canvas scene into canonical, stable-ID domain
 * commands. Nothing here reads live Yjs state: the diff is against the local
 * scene the gesture began from, so untouched concurrent fields stay untouched.
 */
export function compileCanvasSceneChange(
  canvasId: string,
  before: Scene,
  after: Scene,
): CanvasSceneCommands {
  if (same(before, after)) return { commands: [], changedNodeIds: [] };

  const commands: NmlCommand[] = [];
  const changed = new Set<string>([canvasId]);
  const canvasPatch: Extract<NmlCommand, { type: "updateCanvas" }>["patch"] = {};
  if (before.w !== after.w) canvasPatch.w = after.w;
  if (before.h !== after.h) canvasPatch.h = after.h;
  if (!same(before.style, after.style)) canvasPatch.style = after.style;
  if (!same(before.attrs, after.attrs)) canvasPatch.attrs = after.attrs;
  if (after.id !== canvasId) {
    throw new Error(`Canvas diagram ID must remain ${canvasId}.`);
  }
  if (Object.keys(canvasPatch).length) {
    commands.push({ type: "updateCanvas", canvasId, patch: canvasPatch });
  }

  const previous = flatten(before);
  const desired = flatten(after);
  for (const { parentId, nodes } of newShapeForest(after, previous)) {
    commands.push({ type: "insertShapes", canvasId, shapes: nodes, parentId });
    walk(nodes, (node) => {
      changed.add(node.id);
    });
  }

  const patches: Array<{ id: string; patch: Record<string, unknown | undefined> }> = [];
  for (const [id, entry] of desired) {
    const old = previous.get(id);
    if (!old) continue;
    if (old.node.kind !== entry.node.kind) {
      throw new Error(`Canvas shape ${id} cannot change kind in place.`);
    }
    const patch = shapePatches(old.node, entry.node);
    if (Object.keys(patch).length) {
      patches.push({ id, patch });
      changed.add(id);
    }
    const label = canvasTextDiff(old.node.label, entry.node.label);
    if (label) {
      commands.push({
        type: "replaceShapeLabel",
        canvasId,
        shapeId: id,
        range: label.range,
        text: label.text,
      });
      changed.add(id);
    }
  }
  if (patches.length) commands.push({ type: "updateShapes", canvasId, patches });

  const moved = movedShapeIds(before, after, previous, desired);
  const lists = childLists(after);
  const placements: Extract<NmlCommand, { type: "moveShapes" }>["placements"] = [];
  for (const [parentId, ids] of lists) {
    const atParent = new Set(ids.filter((id) => {
      const old = previous.get(id);
      return !old || old.parentId === parentId;
    }));
    ids.forEach((id, index) => {
      if (!moved.has(id)) return;
      const anchor = placementAnchor(ids, index, atParent);
      placements.push({
        id,
        parentId,
        ...(anchor ? { anchor } : {}),
      });
      atParent.add(id);
      changed.add(id);
    });
  }
  if (placements.length) commands.push({ type: "moveShapes", canvasId, placements });

  const oldEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
  const newEdges = new Map(after.edges.map((edge) => [edge.id, edge]));
  const removedEdges = before.edges
    .filter((edge) => !newEdges.has(edge.id))
    .map((edge) => edge.id);
  if (removedEdges.length) {
    commands.push({ type: "removeEdges", canvasId, edgeIds: removedEdges });
    removedEdges.forEach((id) => changed.add(id));
  }

  const edgePatches: Extract<NmlCommand, { type: "updateEdges" }>["patches"] = [];
  for (const edge of after.edges) {
    const old = oldEdges.get(edge.id);
    if (!old) continue;
    const patch = edgePatch(old, edge);
    if (Object.keys(patch).length) {
      edgePatches.push({ id: edge.id, patch });
      changed.add(edge.id);
    }
    const label = canvasTextDiff(old.label, edge.label);
    if (label) {
      commands.push({
        type: "replaceEdgeLabel",
        canvasId,
        edgeId: edge.id,
        range: label.range,
        text: label.text,
      });
      changed.add(edge.id);
    }
  }
  if (edgePatches.length) commands.push({ type: "updateEdges", canvasId, patches: edgePatches });

  const insertedEdges = after.edges.filter((edge) => !oldEdges.has(edge.id));
  if (insertedEdges.length) {
    commands.push({ type: "insertEdges", canvasId, edges: insertedEdges });
    insertedEdges.forEach((edge) => changed.add(edge.id));
  }
  if (insertedEdges.length || edgeOrderChanged(before.edges, after.edges)) {
    const edgeIds = after.edges.map((edge) => edge.id);
    const edgeAvailable = new Set(edgeIds);
    const reorderShared = edgeOrderChanged(before.edges, after.edges);
    const movedEdges = new Set(after.edges
      .filter((edge) => !oldEdges.has(edge.id) || reorderShared)
      .map((edge) => edge.id));
    commands.push({
      type: "moveEdges",
      canvasId,
      placements: edgeIds.flatMap((id, index) => {
        if (!movedEdges.has(id)) return [];
        const anchor = placementAnchor(edgeIds, index, edgeAvailable);
        return [{ id, ...(anchor ? { anchor } : {}) }];
      }),
    });
  }

  const removed = [...previous.keys()].filter((id) => !desired.has(id));
  if (removed.length) {
    commands.push({
      type: "removeShapes",
      canvasId,
      shapeIds: removed,
      preserveUnlistedDescendants: true,
    });
    removed.forEach((id) => changed.add(id));
  }

  return { commands, changedNodeIds: [...changed] };
}

/** The compatibility HTML mirror is always derived, never authoritative. */
export function deriveCanvasMirror(scene: Scene): string {
  return serializeScene(scene);
}
