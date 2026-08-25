import * as Y from "yjs";
import {
  isContainer,
  walk,
  type NodeId,
  type Scene,
  type SceneEdge,
  type SceneNode,
  type SceneNodeKind,
  type StyleMap,
} from "../scene/types";
import { byOrder, keyBetween, keyForIndex } from "./order";

/**
 * A diagram as CRDT structure: three Y.Maps under one root map in the page's
 * Y.Doc, named `canvas:<blockId>`.
 *
 *   "meta"   — the surface's own fields (size, style, id, attrs)
 *   "shapes" — NodeId → Y.Map of per-shape fields
 *   "edges"  — EdgeId → Y.Map of per-edge fields
 *
 * Granularity is the whole design. `frame` is ONE value ({x,y,w,h}): two
 * concurrent drags converge on a position somebody chose, never on one
 * person's x with the other's y. `style` is one value: the grammar treats
 * declaration order as meaning, and per-declaration maps have none. An edge's
 * `from` and `to` are SEPARATE keys, so reconnecting opposite ends
 * concurrently keeps both. Hierarchy is flat — every shape carries
 * `parent: {id, order}` — so a reorder is one LWW write and a reparent is one
 * intent winning whole (see order.ts for why keys, not arrays).
 *
 * Everything here is pure structure: no store, no React, no transport. The
 * binding owns transactions and origins.
 */

export const canvasMapName = (blockId: string) => `canvas:${blockId}`;

/** Transaction origins, so observers can tell who is talking. */
export const CANVAS_LOCAL = "canvas-local";
export const CANVAS_EXTERNAL = "canvas-external";
export const CANVAS_MIGRATE = "canvas-migrate";

type ShapeFields = {
  kind: SceneNodeKind;
  parent: { id: NodeId | null; order: string };
  frame: { x: number; y: number; w: number; h: number };
  rot: number;
  style: StyleMap;
  label: string;
  name?: string;
  locked?: boolean;
  hidden?: boolean;
  attrs: Record<string, string>;
  src?: string;
  d?: string;
  sides?: number;
  arc?: { start?: number; sweep?: number; inner?: number };
};

/** Present iff the diagram lives in the CRDT — the migration flag. */
export function hasCanvasState(root: Y.Map<unknown>): boolean {
  return root.has("meta");
}

// ---------------------------------------------------------------------------
// Scene → fields
// ---------------------------------------------------------------------------

function fieldsOf(
  node: SceneNode,
  parentId: NodeId | null,
  order: string,
): ShapeFields {
  const fields: ShapeFields = {
    kind: node.kind,
    parent: { id: parentId, order },
    frame: { x: node.x, y: node.y, w: node.w, h: node.h },
    rot: node.rot,
    style: { ...node.style },
    label: node.label,
    attrs: { ...node.attrs },
  };
  if (node.name !== undefined) fields.name = node.name;
  if (node.locked) fields.locked = true;
  if (node.hidden) fields.hidden = true;
  if (node.kind === "image") fields.src = node.src;
  if (node.kind === "path") fields.d = node.d;
  if (node.kind === "polygon") fields.sides = node.sides;
  if (
    node.kind === "ellipse" &&
    (node.start !== undefined ||
      node.sweep !== undefined ||
      node.inner !== undefined)
  ) {
    fields.arc = {
      ...(node.start !== undefined ? { start: node.start } : {}),
      ...(node.sweep !== undefined ? { sweep: node.sweep } : {}),
      ...(node.inner !== undefined ? { inner: node.inner } : {}),
    };
  }
  return fields;
}

function edgeFields(edge: SceneEdge, order: string): Record<string, unknown> {
  return {
    from: edge.from,
    to: edge.to,
    label: edge.label,
    style: { ...edge.style },
    attrs: { ...edge.attrs },
    order,
  };
}

// ---------------------------------------------------------------------------
// Populate (migration) — deterministic, so two racing clients converge
// ---------------------------------------------------------------------------

/**
 * Lays a parsed scene down as CRDT structure. Every value — including order
 * keys, which come from document index alone — is a pure function of the
 * scene, so two clients migrating the same block concurrently write
 * identical entries and per-key LWW converges to the same diagram. The
 * commutativity IS the race guard.
 */
export function populateCanvas(root: Y.Map<unknown>, scene: Scene) {
  const meta = new Y.Map<unknown>();
  meta.set("w", scene.w);
  meta.set("h", scene.h);
  meta.set("style", { ...scene.style });
  meta.set("attrs", { ...scene.attrs });
  if (scene.id !== undefined) meta.set("id", scene.id);

  const shapes = new Y.Map<unknown>();
  walk(scene.nodes, (node, parent, index) => {
    const entry = new Y.Map<unknown>();
    const fields = fieldsOf(node, parent?.id ?? null, keyForIndex(index));
    for (const [k, v] of Object.entries(fields)) entry.set(k, v);
    shapes.set(node.id, entry);
  });

  const edges = new Y.Map<unknown>();
  scene.edges.forEach((edge, index) => {
    const entry = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(edgeFields(edge, keyForIndex(index)))) {
      entry.set(k, v);
    }
    edges.set(edge.id, entry);
  });

  root.set("shapes", shapes);
  root.set("edges", edges);
  root.set("meta", meta);
}

// ---------------------------------------------------------------------------
// Materialize — CRDT → Scene, sanitized and deterministic
// ---------------------------------------------------------------------------

/**
 * The scene as the CRDT currently says it, identical on every replica with
 * converged state. Concurrency leaves shapes the tree cannot hold — a parent
 * pointing at a deleted or non-group node, or a reparent cycle — and those
 * are HOISTED to the root deterministically rather than dropped: every
 * replica renders the same tree and nobody's work vanishes. An edge whose
 * end is gone is excluded from the scene but kept in the map, so undoing the
 * deletion brings the connector back.
 */
export function materializeCanvas(root: Y.Map<unknown>): Scene {
  const meta = root.get("meta") as Y.Map<unknown> | undefined;
  const shapesMap = root.get("shapes") as Y.Map<unknown> | undefined;
  const edgesMap = root.get("edges") as Y.Map<unknown> | undefined;

  type Row = { id: NodeId; fields: ShapeFields };
  const rows: Row[] = [];
  shapesMap?.forEach((value, id) => {
    const entry = value as Y.Map<unknown>;
    rows.push({ id, fields: readShape(entry) });
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  // A shape's effective parent: its pointer when that chain reaches the root
  // through groups; otherwise the root itself (hoisted).
  const parentOf = (row: Row): NodeId | null => {
    const seen = new Set<NodeId>();
    let current: Row | undefined = row;
    while (current) {
      const pid: NodeId | null = current.fields.parent.id;
      if (pid === null) return row.fields.parent.id;
      if (seen.has(pid)) return null; // cycle → hoist
      seen.add(pid);
      const parent = byId.get(pid);
      if (!parent || parent.fields.kind !== "group") return null; // gone → hoist
      current = parent;
    }
    return null;
  };

  const childrenOf = new Map<NodeId | null, { id: string; order: string }[]>();
  for (const row of rows) {
    const effective = parentOf(row);
    const list = childrenOf.get(effective) ?? [];
    list.push({ id: row.id, order: row.fields.parent.order });
    childrenOf.set(effective, list);
  }

  const build = (parent: NodeId | null): SceneNode[] => {
    const list = (childrenOf.get(parent) ?? []).sort(byOrder);
    return list.map(({ id }) => {
      const { fields } = byId.get(id)!;
      const base = {
        id,
        x: fields.frame.x,
        y: fields.frame.y,
        w: fields.frame.w,
        h: fields.frame.h,
        rot: fields.rot ?? 0,
        style: { ...fields.style },
        label: fields.label ?? "",
        locked: fields.locked === true,
        hidden: fields.hidden === true,
        attrs: { ...fields.attrs },
        ...(fields.name !== undefined ? { name: fields.name } : {}),
      };
      switch (fields.kind) {
        case "group":
          return { ...base, kind: "group", children: build(id) };
        case "image":
          return { ...base, kind: "image", src: fields.src ?? "" };
        case "path":
          return { ...base, kind: "path", d: fields.d ?? "" };
        case "polygon":
          return { ...base, kind: "polygon", sides: fields.sides ?? 4 };
        case "ellipse":
          return {
            ...base,
            kind: "ellipse",
            ...(fields.arc?.start !== undefined ? { start: fields.arc.start } : {}),
            ...(fields.arc?.sweep !== undefined ? { sweep: fields.arc.sweep } : {}),
            ...(fields.arc?.inner !== undefined ? { inner: fields.arc.inner } : {}),
          };
        default:
          return { ...base, kind: fields.kind } as SceneNode;
      }
    });
  };

  const ids = new Set(rows.map((r) => r.id));
  type EdgeRow = { edge: SceneEdge; order: string };
  const edgeRows: EdgeRow[] = [];
  edgesMap?.forEach((value, id) => {
    const entry = value as Y.Map<unknown>;
    const from = (entry.get("from") as NodeId) ?? "";
    const to = (entry.get("to") as NodeId) ?? "";
    if (!ids.has(from) || !ids.has(to)) return; // dangling: hidden, not lost
    edgeRows.push({
      order: (entry.get("order") as string) ?? "",
      edge: {
        id,
        from,
        to,
        label: (entry.get("label") as string) ?? "",
        style: { ...((entry.get("style") as StyleMap) ?? {}) },
        attrs: { ...((entry.get("attrs") as Record<string, string>) ?? {}) },
      },
    });
  });
  edgeRows.sort((a, b) => byOrder({ ...a, id: a.edge.id }, { ...b, id: b.edge.id }));

  const metaAttrs = { ...((meta?.get("attrs") as Record<string, string>) ?? {}) };
  const metaId = meta?.get("id") as string | undefined;
  return {
    w: (meta?.get("w") as number) ?? 960,
    h: (meta?.get("h") as number) ?? 540,
    style: { ...((meta?.get("style") as StyleMap) ?? {}) },
    nodes: build(null),
    edges: edgeRows.map((r) => r.edge),
    attrs: metaAttrs,
    ...(metaId !== undefined ? { id: metaId } : {}),
  };
}

function readShape(entry: Y.Map<unknown>): ShapeFields {
  const parent = (entry.get("parent") as ShapeFields["parent"]) ?? {
    id: null,
    order: "",
  };
  const frame = (entry.get("frame") as ShapeFields["frame"]) ?? {
    x: 0,
    y: 0,
    w: 0,
    h: 0,
  };
  return {
    kind: (entry.get("kind") as SceneNodeKind) ?? "rect",
    parent,
    frame,
    rot: (entry.get("rot") as number) ?? 0,
    style: (entry.get("style") as StyleMap) ?? {},
    label: (entry.get("label") as string) ?? "",
    name: entry.get("name") as string | undefined,
    locked: entry.get("locked") as boolean | undefined,
    hidden: entry.get("hidden") as boolean | undefined,
    attrs: (entry.get("attrs") as Record<string, string>) ?? {},
    src: entry.get("src") as string | undefined,
    d: entry.get("d") as string | undefined,
    sides: entry.get("sides") as number | undefined,
    arc: entry.get("arc") as ShapeFields["arc"],
  };
}

// ---------------------------------------------------------------------------
// Diff-apply — Scene → minimal per-shape key writes
// ---------------------------------------------------------------------------

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Writes what changed BETWEEN `prev` AND `next` — this client's own edit —
 * into the maps, and nothing else. Diffing against the client's previous
 * knowledge rather than against the live maps is the whole safety story: a
 * concurrent insert this client has not adopted yet is not "missing" (so it
 * is never deleted), and a concurrent recolor is not "stale" (so it is never
 * written over with old paint). Fields the edit did not touch are not
 * written at all; per-key LWW does the rest.
 *
 * `prev === null` means first contact: the scene populates whole.
 * Call inside `doc.transact(..., origin)` — one gesture, one transaction.
 */
export function applySceneDiff(
  root: Y.Map<unknown>,
  prev: Scene | null,
  next: Scene,
) {
  if (!root.has("meta") || prev === null) {
    if (!root.has("meta")) populateCanvas(root, next);
    return;
  }
  const meta = root.get("meta") as Y.Map<unknown>;
  const shapes = root.get("shapes") as Y.Map<unknown>;
  const edges = root.get("edges") as Y.Map<unknown>;

  if (prev.w !== next.w) meta.set("w", next.w);
  if (prev.h !== next.h) meta.set("h", next.h);
  if (!same(prev.style, next.style)) meta.set("style", { ...next.style });
  if (!same(prev.attrs, next.attrs)) meta.set("attrs", { ...next.attrs });
  if (prev.id !== next.id) {
    if (next.id !== undefined) meta.set("id", next.id);
    else if (meta.has("id")) meta.delete("id");
  }

  type Flat = { node: SceneNode; parentId: NodeId | null };
  const flatten = (scene: Scene) => {
    const out = new Map<NodeId, Flat>();
    walk(scene.nodes, (node, parent) => {
      out.set(node.id, { node, parentId: parent?.id ?? null });
    });
    return out;
  };
  const was = flatten(prev);
  const want = flatten(next);

  // Deletes: only what THIS client removed.
  for (const id of was.keys()) {
    if (!want.has(id) && shapes.has(id)) shapes.delete(id);
  }

  // Which shapes' parent/order this edit actually moved.
  const moved = movedIds(prev, next, was, want);
  // An order key is only ever written for a shape this edit moved, or one the
  // maps do not hold yet. Planning them reads every entry in the map and runs
  // a subsequence per parent, so an edit that reordered nothing — a recolour,
  // a nudge — never asks.
  let orderKeys: Map<string, string> | null = null;
  const orderOf = (id: NodeId): string =>
    (orderKeys ??= planOrders(shapes, next)).get(id) ?? "";

  for (const [id, { node, parentId }] of want) {
    const before = was.get(id);
    // `./ops` shares structure: a node the edit did not touch comes back as the
    // same object, and an unmoved one of those has nothing to write. Skipping
    // it here is what keeps a nudge or a slider tick proportional to the edit
    // rather than to the diagram.
    if (
      before &&
      before.node === node &&
      before.parentId === parentId &&
      !moved.has(id) &&
      shapes.has(id)
    ) {
      continue;
    }
    const fields = fieldsOf(node, parentId, "");
    const existing = shapes.get(id) as Y.Map<unknown> | undefined;
    if (!existing) {
      fields.parent = { id: parentId, order: orderOf(id) };
      const entry = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(fields)) entry.set(k, v);
      shapes.set(id, entry);
      continue;
    }
    if (!before) {
      // Known to the map but new to this client's history — write whole,
      // minimally (setIfChanged skips what already matches).
      fields.parent = { id: parentId, order: orderOf(id) };
      for (const [k, v] of Object.entries(fields)) setIfChanged(existing, k, v);
      continue;
    }
    const prevFields = fieldsOf(before.node, before.parentId, "");
    for (const key of [
      "kind",
      "frame",
      "rot",
      "style",
      "label",
      "attrs",
      "src",
      "d",
      "sides",
      "arc",
      "name",
      "locked",
      "hidden",
    ] as const) {
      const value = fields[key];
      if (same(prevFields[key], value)) continue; // untouched: never written
      if (value === undefined) {
        if (existing.has(key)) existing.delete(key);
      } else {
        setIfChanged(existing, key, value);
      }
    }
    if (moved.has(id)) {
      setIfChanged(existing, "parent", { id: parentId, order: orderOf(id) });
    }
  }

  // Edges: the same prev-gated shape, flat.
  const wasEdges = new Map(prev.edges.map((e) => [e.id, e]));
  const wantEdges = new Map(next.edges.map((e) => [e.id, e]));
  for (const id of wasEdges.keys()) {
    if (!wantEdges.has(id) && edges.has(id)) edges.delete(id);
  }
  const edgeOrder = edgeOrderDirty(prev.edges, next.edges);
  const edgeOrders = planEdgeOrders(edges, next.edges);
  for (const [id, edge] of wantEdges) {
    const fields = edgeFields(edge, edgeOrders.get(id)!);
    const existing = edges.get(id) as Y.Map<unknown> | undefined;
    const before = wasEdges.get(id);
    if (!existing) {
      const entry = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(fields)) entry.set(k, v);
      edges.set(id, entry);
      continue;
    }
    if (!before) {
      for (const [k, v] of Object.entries(fields)) setIfChanged(existing, k, v);
      continue;
    }
    const beforeFields = edgeFields(before, "");
    for (const [k, v] of Object.entries(fields)) {
      if (k === "order") {
        if (edgeOrder) setIfChanged(existing, k, v);
        continue;
      }
      if (!same(beforeFields[k], v)) setIfChanged(existing, k, v);
    }
  }
}

/**
 * Shapes whose place in the tree this edit changed: a different parent, or a
 * different position among the siblings both versions know. A remote insert
 * appearing between two of ours changes neither, so nobody's key is touched
 * for it.
 */
function movedIds(
  prev: Scene,
  next: Scene,
  was: Map<NodeId, { parentId: NodeId | null }>,
  want: Map<NodeId, { parentId: NodeId | null }>,
): Set<NodeId> {
  const moved = new Set<NodeId>();
  for (const [id, entry] of want) {
    const before = was.get(id);
    if (!before) {
      moved.add(id);
      continue;
    }
    if (before.parentId !== entry.parentId) moved.add(id);
  }
  // Every parent's child list from ONE walk of each scene: asking per parent
  // walks the whole scene once per group, which is quadratic on a nested
  // diagram and runs on every committed edit.
  const listsOf = (scene: Scene): Map<NodeId | null, NodeId[]> => {
    const out = new Map<NodeId | null, NodeId[]>([[null, []]]);
    walk(scene.nodes, (node, parent) => {
      const key = parent?.id ?? null;
      const list = out.get(key);
      if (list) list.push(node.id);
      else out.set(key, [node.id]);
      if (isContainer(node) && !out.has(node.id)) out.set(node.id, []);
    });
    return out;
  };
  const prevLists = listsOf(prev);

  for (const [parentId, nextIds] of listsOf(next)) {
    const shared = new Set(
      nextIds.filter((id) => was.has(id) && was.get(id)!.parentId === parentId),
    );
    const prevSeq = (prevLists.get(parentId) ?? []).filter((id) =>
      shared.has(id),
    );
    const nextSeq = nextIds.filter((id) => shared.has(id));
    if (prevSeq.join(" ") !== nextSeq.join(" ")) {
      for (const id of nextSeq) moved.add(id);
    }
  }
  return moved;
}

function edgeOrderDirty(
  prev: readonly SceneEdge[],
  next: readonly SceneEdge[],
): boolean {
  const shared = new Set(prev.map((e) => e.id));
  const want = new Set(next.map((e) => e.id));
  const a = prev.filter((e) => want.has(e.id)).map((e) => e.id);
  const b = next.filter((e) => shared.has(e.id)).map((e) => e.id);
  return a.join(" ") !== b.join(" ");
}

function setIfChanged(map: Y.Map<unknown>, key: string, value: unknown) {
  if (!map.has(key) || !same(map.get(key), value)) map.set(key, value);
}

/** Existing key kept when it can be; a fresh one between neighbours else. */
function assignOrders(
  ordered: { id: string; existing: string | null }[],
): Map<string, string> {
  const out = new Map<string, string>();
  // Longest strictly-increasing subsequence over the existing keys — the
  // shapes whose keys can stand; everything else is re-keyed around them.
  const keep = new Set<number>();
  {
    const withKey: { i: number; key: string }[] = [];
    ordered.forEach((entry, i) => {
      if (entry.existing !== null) withKey.push({ i, key: entry.existing });
    });
    const tails: number[] = [];
    const prev = new Array<number>(withKey.length).fill(-1);
    for (let k = 0; k < withKey.length; k++) {
      const key = withKey[k].key;
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (withKey[tails[m]].key < key) lo = m + 1;
        else hi = m;
      }
      tails[lo] = k;
      prev[k] = lo > 0 ? tails[lo - 1] : -1;
    }
    let cursor = tails.length ? tails[tails.length - 1] : -1;
    while (cursor !== -1) {
      keep.add(withKey[cursor].i);
      cursor = prev[cursor];
    }
  }
  // Walk once, filling gaps between kept keys.
  let prevKey: string | null = null;
  for (let i = 0; i < ordered.length; i++) {
    const entry = ordered[i];
    if (entry.existing !== null && keep.has(i)) {
      out.set(entry.id, entry.existing);
      prevKey = entry.existing;
      continue;
    }
    // Next kept key bounds the gap above.
    let nextKey: string | null = null;
    for (let j = i + 1; j < ordered.length; j++) {
      const later = ordered[j];
      if (later.existing !== null && keep.has(j)) {
        nextKey = later.existing;
        break;
      }
    }
    const fresh: string =
      prevKey === null && nextKey === null
        ? keyForIndex(i)
        : keyBetween(prevKey, nextKey);
    out.set(entry.id, fresh);
    prevKey = fresh;
  }
  return out;
}

function planOrders(shapes: Y.Map<unknown>, next: Scene): Map<string, string> {
  const currentParent = new Map<string, { id: NodeId | null; order: string }>();
  shapes.forEach((value, id) => {
    const parent = (value as Y.Map<unknown>).get("parent") as
      | { id: NodeId | null; order: string }
      | undefined;
    if (parent) currentParent.set(id, parent);
  });

  const out = new Map<string, string>();
  const perParent = (parentId: NodeId | null, children: readonly SceneNode[]) => {
    const ordered = children.map((child) => {
      const held = currentParent.get(child.id);
      return {
        id: child.id,
        existing: held && held.id === parentId ? held.order : null,
      };
    });
    for (const [id, key] of assignOrders(ordered)) out.set(id, key);
  };
  perParent(null, next.nodes);
  walk(next.nodes, (node) => {
    if (isContainer(node)) perParent(node.id, node.children);
  });
  return out;
}

function planEdgeOrders(
  edges: Y.Map<unknown>,
  next: readonly SceneEdge[],
): Map<string, string> {
  const ordered = next.map((edge) => {
    const existing = edges.get(edge.id) as Y.Map<unknown> | undefined;
    return { id: edge.id, existing: (existing?.get("order") as string) ?? null };
  });
  return assignOrders(ordered);
}
