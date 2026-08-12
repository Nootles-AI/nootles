/**
 * The scene mutation layer — every edit the canvas can make, as pure functions.
 *
 * `applyOp` is the single entry point: it switches on {@link SceneOp} and
 * delegates to the named function for that op, so the gesture layer, the panels
 * and the AI bridge all take the same path. Nothing here mutates: every function
 * takes a `Scene` and returns a `Scene`.
 *
 * ## Structural sharing is a requirement, not an optimisation
 *
 * Untouched subtrees keep their object identity, and a list that did not change
 * keeps its array identity. `ShapeView` is memo'd on the node object, so moving
 * one shape must not hand every sibling a new reference — that would re-render
 * the whole canvas on every commit.
 *
 * ## Ids are minted, never random
 *
 * {@link mintIds} derives ids from a counter seeded off the scene's existing
 * ids, so the same input always produces the same output. `Math.random` and
 * `Date.now` would make an AI-produced diff non-reproducible and every scene
 * unequal to itself.
 *
 * ## Coordinates
 *
 * A node's `x`/`y` are relative to its parent group. Grouping a selection that
 * spans two parents converts through accumulated parent *offsets* only —
 * ancestor rotation is not composed here, because the exact case (grouping
 * across a rotated group) is one the sidebar cannot produce, and pretending
 * otherwise would put the approximation somewhere harder to see.
 *
 * Locked and hidden nodes are not special-cased here. Whether a locked node can
 * be reached is the selection layer's decision; by the time an op names an id,
 * it applies.
 *
 * The maths lives elsewhere on purpose: bounds come from `./geometry` and
 * align/distribute from `./align`, which return positions rather than scenes so
 * a drag preview can call them without owning one. This module is the only
 * thing that turns them into a new `Scene`.
 */

import {
  alignNodes as alignMoves,
  alignTarget,
  distributeNodes as distributeMoves,
} from "./align";
import { hugSize, hugsOf } from "./autoLayout";
import { nodeBounds, normalizeAngle, rotateAround, unionBounds } from "./geometry";
import { labelText } from "./label";
import { scalePath } from "./path";
import {
  edgesTouching,
  findNode,
  findParent,
  isContainer,
  isGroup,
  nodePath,
  walk,
  type Alignment,
  type AlignTarget,
  type DistributeAxis,
  type EdgeId,
  type GroupNode,
  type NodeFrame,
  type NodeId,
  type Point,
  type Rect,
  type Scene,
  type SceneEdge,
  type SceneLike,
  type SceneNode,
  type SceneNodeBase,
  type SceneOp,
  type ShapeParams,
  type StyleMap,
  type StylePatch,
  type ZTarget,
} from "./types";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Apply one op. Unknown ids are ignored rather than throwing — a stale
 *  selection outliving an undo is routine. */
export function applyOp(scene: Scene, op: SceneOp): Scene {
  switch (op.type) {
    case "move":
      return moveNodes(scene, op.ids, op.dx, op.dy);
    case "resize":
      return resizeNodes(scene, op.frames);
    case "rotate":
      return rotateNodes(scene, op.ids, op.rot);
    case "setStyle":
      return setStyle(scene, op.ids, op.decls);
    case "setLabel":
      return setLabel(scene, op.id, op.label);
    case "setName":
      return setName(scene, op.id, op.name);
    case "insert":
      return insertNodes(scene, op.nodes, op.parentId ?? null, op.index);
    case "remove":
      return removeNodes(scene, op.ids);
    case "reorder":
      return reorderNodes(scene, op.ids, op.to);
    case "group":
      return groupNodes(scene, op.ids, op.groupId, op.name);
    case "ungroup":
      return ungroupNodes(scene, op.ids);
    case "setLocked":
      return setLocked(scene, op.ids, op.locked);
    case "setHidden":
      return setHidden(scene, op.ids, op.hidden);
    case "setPath":
      return setPath(scene, op.id, op.d, op.frame);
    case "setShape":
      return setShape(scene, op.ids, op.params);
    case "align":
      return align(scene, op.ids, op.to, op.relativeTo);
    case "distribute":
      return distribute(scene, op.ids, op.axis, op.spacing);
    case "addEdge":
      return addEdges(scene, op.edges);
    case "removeEdge":
      return removeEdges(scene, op.ids);
    case "setEdgeLabel":
      return setEdgeLabel(scene, op.id, op.label);
    case "setEdgeStyle":
      return setEdgeStyle(scene, op.ids, op.decls);
    case "reconnect":
      return reconnect(scene, op.id, op.from, op.to);
  }
}

/** One gesture's worth of ops: applied in order, then settled. */
export function applyOps(scene: Scene, ops: readonly SceneOp[]): Scene {
  const next = ops.reduce(applyOp, scene);
  return next === scene ? scene : reflowHugs(next);
}

/**
 * Resolve every hugging group's box against what is now inside it.
 *
 * `width|height: fit-content` says the box *is* the contents, but the renderer
 * and the hit-tester both read `w`/`h`, so the declaration only means anything
 * if the model follows the layout. Doing it here rather than in each op is what
 * keeps a group true after any of them — a child resized, added, removed, or the
 * gap changed. Bottom-up, because an outer group hugs the size the inner one
 * just took.
 */
export function reflowHugs(scene: Scene): Scene {
  return withNodes(scene, reflowList(scene.nodes));
}

function reflowList(nodes: SceneNode[]): SceneNode[] {
  let changed = false;
  const out = nodes.map((node) => {
    if (!isGroup(node)) return node;
    const children = reflowList(node.children);
    let next = children === node.children ? node : { ...node, children };
    const size = hugSize(next);
    if (size.w !== next.w || size.h !== next.h) next = { ...next, ...size };
    if (next !== node) changed = true;
    return next;
  });
  return changed ? out : nodes;
}

// ---------------------------------------------------------------------------
// Id minting
// ---------------------------------------------------------------------------

const ID_PREFIX = "n";
const MINTED_ID = /^n(\d+)$/;
const EDGE_PREFIX = "e";
const MINTED_EDGE_ID = /^e(\d+)$/;

/**
 * `count` ids that collide with nothing in the scene, deterministically: the
 * counter starts after the highest `n<number>` already present, and any
 * candidate that is somehow taken is skipped.
 */
export function mintIds(scene: SceneLike, count: number): NodeId[] {
  return mintInto(collectIds(scene), count);
}

/** One id — {@link mintIds} for the common case (a new group, a new shape). */
export function mintId(scene: SceneLike): NodeId {
  return mintIds(scene, 1)[0];
}

/** Connector ids, counted separately so a document reads e1/e2 alongside
 *  n1/n2 — but minted against every id in the scene, because both are `id`
 *  attributes of one HTML document and may not collide. */
export function mintEdgeIds(scene: SceneLike, count: number): EdgeId[] {
  return mintInto(collectIds(scene), count, EDGE_PREFIX, MINTED_EDGE_ID);
}

export function mintEdgeId(scene: SceneLike): EdgeId {
  return mintEdgeIds(scene, 1)[0];
}

function mintInto(
  taken: Set<string>,
  count: number,
  prefix: string = ID_PREFIX,
  pattern: RegExp = MINTED_ID,
): string[] {
  let counter = 0;
  for (const id of taken) {
    const match = pattern.exec(id);
    if (match) counter = Math.max(counter, Number(match[1]));
  }
  const out: string[] = [];
  while (out.length < count) {
    const id = `${prefix}${++counter}`;
    if (taken.has(id)) continue;
    taken.add(id);
    out.push(id);
  }
  return out;
}

function collectIds(scene: SceneLike): Set<string> {
  const ids = new Set<string>();
  walk(rootNodes(scene), (node) => {
    ids.add(node.id);
  });
  if (!Array.isArray(scene)) {
    for (const edge of (scene as Scene).edges ?? []) ids.add(edge.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Per-node ops
// ---------------------------------------------------------------------------

/** Translate by a delta. Ids nested inside another id are dropped: a group and
 *  its child both moving would move the child twice. */
export function moveNodes(
  scene: Scene,
  ids: readonly NodeId[],
  dx: number,
  dy: number,
): Scene {
  if (!ids.length || (dx === 0 && dy === 0)) return scene;
  const targets = topMost(scene, ids);
  return withNodes(
    scene,
    mapTree(scene.nodes, targets, (node) =>
      patch(node, { x: node.x + dx, y: node.y + dy }),
    ),
  );
}

/** Absolute boxes, per node. Negative sizes are clamped to 0; every other
 *  constraint (minimum size, aspect lock) belongs to the gesture. */
export function resizeNodes(scene: Scene, frames: readonly NodeFrame[]): Scene {
  if (!frames.length) return scene;
  const byId = new Map(frames.map((frame) => [frame.id, frame]));
  return withNodes(
    scene,
    mapTree(scene.nodes, new Set(byId.keys()), (node) => {
      const frame = byId.get(node.id)!;
      const next = {
        x: frame.x,
        y: frame.y,
        w: Math.max(0, frame.w),
        h: Math.max(0, frame.h),
      };
      if (
        node.x === next.x &&
        node.y === next.y &&
        node.w === next.w &&
        node.h === next.h
      ) {
        return node;
      }
      const resized = patch(node, next);
      if (resized.kind === "path") {
        return {
          ...resized,
          d: scalePath(
            resized.d,
            ratio(next.w, node.w),
            ratio(next.h, node.h),
          ),
        };
      }
      return isGroup(resized)
        ? unhug(resized, next.w !== node.w, next.h !== node.h)
        : resized;
    }),
  );
}

/** How far one axis stretched. An axis with no extent has nothing to stretch. */
const ratio = (to: number, from: number) => (from > 0 && to > 0 ? to / from : 1);

/** Sizing an axis by hand makes it fixed, as in Figma — otherwise
 *  {@link reflowHugs} would put the hugged size straight back. */
function unhug(group: GroupNode, w: boolean, h: boolean): GroupNode {
  const hug = hugsOf(group);
  if (!(hug.w && w) && !(hug.h && h)) return group;
  const style = { ...group.style };
  if (hug.w && w) delete style.width;
  if (hug.h && h) delete style.height;
  return { ...group, style };
}

/** Absolute degrees, normalised into `[0, 360)` so a full turn reads as 0 and
 *  the serializer can drop the attribute. */
export function rotateNodes(
  scene: Scene,
  ids: readonly NodeId[],
  rot: number,
): Scene {
  if (!ids.length) return scene;
  const next = normalizeAngle(rot);
  return withNodes(
    scene,
    mapTree(scene.nodes, new Set(ids), (node) =>
      node.rot === next ? node : patch(node, { rot: next }),
    ),
  );
}

/** Merge declarations onto each node's `style`; an `undefined` value removes
 *  one, which is how a control clears a property rather than writing `"none"`. */
/** Declarations merged, `undefined` removing one. Returns the original object
 *  when nothing changed, so callers can compare by identity. */
export function mergeStyle(base: StyleMap, decls: StylePatch): StyleMap {
  const style = { ...base };
  let changed = false;
  for (const prop of Object.keys(decls)) {
    const value = decls[prop];
    if (value === undefined) {
      if (prop in style) {
        delete style[prop];
        changed = true;
      }
    } else if (style[prop] !== value) {
      style[prop] = value;
      changed = true;
    }
  }
  return changed ? style : base;
}

export function setStyle(
  scene: Scene,
  ids: readonly NodeId[],
  decls: StylePatch,
): Scene {
  const props = Object.keys(decls);
  if (!ids.length || !props.length) return scene;
  return withNodes(
    scene,
    mapTree(scene.nodes, new Set(ids), (node) => {
      const style = mergeStyle(node.style, decls);
      return style === node.style ? node : patch(node, { style });
    }),
  );
}

export function setLabel(scene: Scene, id: NodeId, label: string): Scene {
  return withNodes(
    scene,
    mapTree(scene.nodes, new Set([id]), (node) =>
      node.label === label ? node : patch(node, { label }),
    ),
  );
}

/** `undefined` drops the key entirely, restoring the derived display name —
 *  leaving `name: undefined` behind would defeat deep-equality on round trip. */
export function setName(
  scene: Scene,
  id: NodeId,
  name: string | undefined,
): Scene {
  return withNodes(
    scene,
    mapTree(scene.nodes, new Set([id]), (node) => {
      if (name === undefined) {
        if (node.name === undefined) return node;
        const next = { ...node };
        delete next.name;
        return next;
      }
      return node.name === name ? node : patch(node, { name });
    }),
  );
}

export function setLocked(
  scene: Scene,
  ids: readonly NodeId[],
  locked: boolean,
): Scene {
  if (!ids.length) return scene;
  return withNodes(
    scene,
    mapTree(scene.nodes, new Set(ids), (node) =>
      node.locked === locked ? node : patch(node, { locked }),
    ),
  );
}

export function setHidden(
  scene: Scene,
  ids: readonly NodeId[],
  hidden: boolean,
): Scene {
  if (!ids.length) return scene;
  return withNodes(
    scene,
    mapTree(scene.nodes, new Set(ids), (node) =>
      node.hidden === hidden ? node : patch(node, { hidden }),
    ),
  );
}

/**
 * Parametric geometry: a polygon's `sides`, an ellipse's arc.
 *
 * Replaces rather than merges, and that is the point — a full ellipse is one
 * carrying NO arc attributes, so returning to it means deleting the keys, not
 * writing 0/360/0. Kinds that have no parameters are passed over, which is what
 * lets one edit cross a mixed selection.
 */
export function setShape(
  scene: Scene,
  ids: readonly NodeId[],
  params: ShapeParams,
): Scene {
  if (!ids.length) return scene;
  return withNodes(
    scene,
    mapTree(scene.nodes, new Set(ids), (node) => {
      if (node.kind === "polygon") {
        const sides = Math.max(3, Math.min(100, Math.round(params.sides ?? 3)));
        return node.sides === sides ? node : { ...node, sides };
      }
      if (node.kind !== "ellipse") return node;
      const { start, sweep, inner, ...rest } = node;
      const next = {
        ...rest,
        ...(params.start !== undefined ? { start: params.start } : {}),
        ...(params.sweep !== undefined ? { sweep: params.sweep } : {}),
        ...(params.inner !== undefined ? { inner: params.inner } : {}),
      } as typeof node;
      return start === next.start && sweep === next.sweep && inner === next.inner
        ? node
        : next;
    }),
  );
}

/** Pen-tool edit. `d` is local to the box, so a point moved outside the current
 *  bounds arrives with the new `frame`. Ignored for any kind but `path`. */
export function setPath(
  scene: Scene,
  id: NodeId,
  d: string,
  frame?: Rect,
): Scene {
  return withNodes(
    scene,
    mapTree(scene.nodes, new Set([id]), (node) => {
      if (node.kind !== "path") return node;
      const box = frame ?? node;
      if (
        node.d === d &&
        node.x === box.x &&
        node.y === box.y &&
        node.w === box.w &&
        node.h === box.h
      ) {
        return node;
      }
      return {
        ...node,
        d,
        x: box.x,
        y: box.y,
        w: Math.max(0, box.w),
        h: Math.max(0, box.h),
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Structural ops
// ---------------------------------------------------------------------------

/**
 * Insert already-built nodes. `parentId: null` is the scene root; `index`
 * omitted appends (frontmost). Nodes whose id is already in the scene are
 * skipped, and a `parentId` that is missing or is not a group is a no-op —
 * silently duplicating an id would corrupt every later op.
 */
export function insertNodes(
  scene: Scene,
  nodes: readonly SceneNode[],
  parentId: NodeId | null = null,
  index?: number,
): Scene {
  if (!nodes.length) return scene;
  if (parentId !== null) {
    const parent = findNode(scene, parentId);
    if (!parent || !isContainer(parent)) return scene;
  }
  const taken = collectIds(scene);
  const fresh = nodes.filter((node) => !taken.has(node.id));
  if (!fresh.length) return scene;
  return withNodes(
    scene,
    updateList(scene.nodes, parentId, (list) => spliceIn(list, fresh, index)),
  );
}

/** Remove each id and its whole subtree. */
export function removeNodes(scene: Scene, ids: readonly NodeId[]): Scene {
  if (!ids.length) return scene;
  // A connector into a node that is going — or into one of its descendants,
  // since removing a group takes the whole subtree — has lost its anchor. It
  // goes in the same op, so one undo puts both back.
  const orphaned = edgesTouching(scene, ids);
  const next = withNodes(scene, extract(scene.nodes, new Set(ids), []));
  if (!orphaned.length) return next;
  const gone = new Set(orphaned.map((edge) => edge.id));
  return { ...next, edges: next.edges.filter((edge) => !gone.has(edge.id)) };
}

/**
 * Z-order and reparenting.
 *
 * The relative targets (`front`/`back`/`forward`/`backward`) move each node
 * within its own parent, like Figma — "bring to front" inside a group means the
 * front of that group. The `index` target is a layers-panel drag: the nodes are
 * taken out of the tree first, so `index` counts positions in the destination
 * list **as it is after the removal**, and each node keeps its position on
 * screen by having its `x`/`y` rebased into the new parent.
 */
export function reorderNodes(
  scene: Scene,
  ids: readonly NodeId[],
  to: ZTarget,
): Scene {
  const targets = topMost(scene, ids);
  if (!targets.size) return scene;
  if (to.at !== "index") {
    return withNodes(scene, reorderDeep(scene.nodes, targets, to.at));
  }

  const parentId = to.parentId;
  if (parentId !== null) {
    const parent = findNode(scene, parentId);
    if (!parent || !isContainer(parent)) return scene;
    // A group cannot be dropped inside itself or its own descendants.
    for (const id of targets) {
      if (nodePath(scene, parentId).some((node) => node.id === id)) return scene;
    }
  }

  const destination = originOf(scene, parentId);
  const moved: SceneNode[] = [];
  const stripped = extract(scene.nodes, targets, moved);
  if (!moved.length) return scene;
  const rebased = moved.map((node) => {
    const origin = originOf(scene, parentOf(scene, node.id));
    const dx = origin.x - destination.x;
    const dy = origin.y - destination.y;
    return dx === 0 && dy === 0
      ? node
      : patch(node, { x: node.x + dx, y: node.y + dy });
  });
  return withNodes(
    scene,
    updateList(stripped, parentId, (list) => spliceIn(list, rebased, to.index)),
  );
}

/**
 * Wrap the ids in a new group.
 *
 * The group's box is the union of the members' bounds (rotation included), it
 * lands in the parent and z-position of the frontmost member, and each member's
 * `x`/`y` is rewritten to be relative to it. Members from other parents are
 * converted into that space, so grouping never moves anything on screen.
 * {@link ungroupNodes} is its exact inverse — except when a frame is absorbed
 * (see {@link frameOf}), where the absorbed appearance belongs to the group and
 * ungrouping drops it, as it drops any style set on a group.
 */
export function groupNodes(
  scene: Scene,
  ids: readonly NodeId[],
  groupId: NodeId,
  name?: string,
): Scene {
  const targets = topMost(scene, ids);
  if (!targets.size) return scene;
  if (findNode(scene, groupId)) return scene;

  const members = orderedNodes(scene, targets);
  const front = members[members.length - 1];
  const parentId = parentOf(scene, front.id);
  const parentOrigin = originOf(scene, parentId);

  const origins = new Map<NodeId, Point>(
    members.map((node) => [node.id, originOf(scene, parentOf(scene, node.id))]),
  );
  const bounds = new Map<NodeId, Rect>(
    members.map((node) => [
      node.id,
      shift(nodeBounds(node), origins.get(node.id)!),
    ]),
  );

  const frame = frameOf(members, bounds);
  const box = frame
    ? bounds.get(frame.id)!
    : unionBounds(members.map((node) => ({ ...bounds.get(node.id)!, rot: 0 })));

  const siblings = parentId === null ? scene.nodes : childrenOf(scene, parentId);
  const at = siblings.indexOf(front);
  const index =
    at - siblings.slice(0, at).filter((node) => targets.has(node.id)).length;

  const moved: SceneNode[] = [];
  const stripped = extract(scene.nodes, targets, moved);
  const children = moved
    .filter((node) => node.id !== frame?.id)
    .map((node) => {
      const origin = origins.get(node.id)!;
      return patch(node, {
        x: node.x + origin.x - box.x,
        y: node.y + origin.y - box.y,
      });
    });

  const named = name ?? frame?.name;
  const group: GroupNode = {
    kind: "group",
    id: groupId,
    x: box.x - parentOrigin.x,
    y: box.y - parentOrigin.y,
    w: box.w,
    h: box.h,
    rot: 0,
    style: frame ? absorbedStyle(frame.style) : {},
    label: "",
    locked: false,
    hidden: false,
    attrs: frame ? frame.attrs : {},
    children,
    ...(named === undefined ? {} : { name: named }),
  };

  return withNodes(
    scene,
    updateList(stripped, parentId, (list) => spliceIn(list, [group], index)),
  );
}

/** Slack on the containment test, so a child snapped flush to the frame's edge
 *  still reads as inside it. */
const FRAME_EPSILON = 0.01;

/**
 * The selected rect that already encloses every other selected node — a
 * background the user drew around the shapes rather than a member of the group.
 * {@link groupNodes} consumes it: the group takes its box, its appearance and
 * its attributes, and the rect itself does not become a child. `<nt-group>`
 * carries the same CSS an `<nt-rect>` does, so nothing is lost.
 *
 * `null` — plain grouping — unless the case is unmistakable, because magic that
 * fires when it was not wanted costs more than magic that never fires:
 *  - rects only, unrotated (a rotated frame would have to rotate the group,
 *    which would move the children), and visible;
 *  - never a labelled one, since absorbing it would silently delete the text;
 *  - never when two candidates qualify, since which one is the frame is then a
 *    guess.
 */
function frameOf(
  members: readonly SceneNode[],
  bounds: ReadonlyMap<NodeId, Rect>,
): SceneNode | null {
  if (members.length < 2) return null;
  let found: SceneNode | null = null;
  for (const node of members) {
    if (node.kind !== "rect" || node.rot !== 0 || node.hidden) continue;
    if (labelText(node.label).trim() !== "") continue;
    const outer = bounds.get(node.id)!;
    const encloses = members.every(
      (other) => other === node || contains(outer, bounds.get(other.id)!),
    );
    if (!encloses) continue;
    if (found) return null;
    found = node;
  }
  return found;
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - FRAME_EPSILON &&
    inner.y >= outer.y - FRAME_EPSILON &&
    inner.x + inner.w <= outer.x + outer.w + FRAME_EPSILON &&
    inner.y + inner.h <= outer.y + outer.h + FRAME_EPSILON
  );
}

/** On a group these three mean auto-layout and hug, which would re-place and
 *  re-size the children; every other declaration paints the same on both. */
const UNABSORBED_PROPS = ["display", "width", "height"];

function absorbedStyle(style: StyleMap): StyleMap {
  const out = { ...style };
  for (const prop of UNABSORBED_PROPS) delete out[prop];
  return out;
}

/** Dissolve each group, splicing its children into its place in z-order with
 *  their positions (and, for a rotated group, their rotations) preserved. */
export function ungroupNodes(scene: Scene, ids: readonly NodeId[]): Scene {
  let nodes = scene.nodes;
  for (const id of ids) nodes = dissolve(nodes, id);
  return withNodes(scene, nodes);
}

/**
 * Copy the ids, offset by 10px like Figma, in place in the tree. Every node in
 * every copied subtree gets a fresh id; the returned ids are the new top-level
 * copies, ready to become the selection.
 */
export function duplicateNodes(
  scene: Scene,
  ids: readonly NodeId[],
  offset = 10,
): { scene: Scene; ids: NodeId[] } {
  const targets = topMost(scene, ids);
  if (!targets.size) return { scene, ids: [] };
  const taken = collectIds(scene);
  let next = scene;
  const copies: NodeId[] = [];
  // Grouped by parent so each copy lands directly in front of its original.
  for (const node of orderedNodes(scene, targets)) {
    const parentId = parentOf(next, node.id);
    const siblings = parentId === null ? next.nodes : childrenOf(next, parentId);
    const copy = patch(cloneWithNewIds(node, taken), {
      x: node.x + offset,
      y: node.y + offset,
    });
    copies.push(copy.id);
    next = insertNodes(
      next,
      [copy],
      parentId,
      siblings.findIndex((sibling) => sibling.id === node.id) + 1,
    );
  }
  return { scene: next, ids: copies };
}

// ---------------------------------------------------------------------------
// Arrangement ops
// ---------------------------------------------------------------------------

/**
 * Align to the selection's bounds, or — for a single node, or when asked — to
 * its container. `./align` owns the maths and the defaults; this only lands the
 * positions it returns.
 */
function align(
  scene: Scene,
  ids: readonly NodeId[],
  to: Alignment,
  relativeTo?: AlignTarget,
): Scene {
  const members = orderedNodes(scene, topMost(scene, ids));
  if (!members.length) return scene;
  const within = alignTarget(
    scene,
    members.map((node) => node.id),
    relativeTo,
  );
  return applyMoves(scene, alignMoves(members, to, within));
}

/** Even spacing along an axis — see `./align` for the two spacing modes. */
function distribute(
  scene: Scene,
  ids: readonly NodeId[],
  axis: DistributeAxis,
  spacing?: number,
): Scene {
  const members = orderedNodes(scene, topMost(scene, ids));
  if (members.length < 2) return scene;
  return applyMoves(scene, distributeMoves(members, axis, spacing));
}

/** Land absolute `x`/`y` from `./align`, in each node's own parent space. */
function applyMoves(scene: Scene, moves: ReadonlyMap<NodeId, Point>): Scene {
  return withNodes(
    scene,
    mapTree(scene.nodes, new Set(moves.keys()), (node) => {
      const to = moves.get(node.id)!;
      if (node.x === to.x && node.y === to.y) return node;
      return patch(node, { x: to.x, y: to.y });
    }),
  );
}

// ---------------------------------------------------------------------------
// Tree plumbing
// ---------------------------------------------------------------------------

function rootNodes(scene: SceneLike): readonly SceneNode[] {
  return Array.isArray(scene) ? scene : (scene as Scene).nodes;
}

function withNodes(scene: Scene, nodes: SceneNode[]): Scene {
  return nodes === scene.nodes ? scene : { ...scene, nodes };
}

/** Field update that keeps the node's kind. The cast is confined here: spread
 *  widens a discriminated union, and every caller changes base fields only. */
function patch<T extends SceneNode>(node: T, changes: Partial<SceneNodeBase>): T {
  return { ...node, ...changes } as T;
}

/**
 * Rebuild only what `update` touches. A list whose members are all unchanged is
 * returned as-is, so an untouched subtree keeps its identity all the way up.
 */
function mapTree(
  nodes: SceneNode[],
  ids: ReadonlySet<NodeId>,
  update: (node: SceneNode) => SceneNode,
): SceneNode[] {
  let changed = false;
  const out = nodes.map((node) => {
    let next = ids.has(node.id) ? update(node) : node;
    if (isContainer(next)) {
      const children = mapTree(next.children, ids, update);
      if (children !== next.children) next = { ...next, children };
    }
    if (next !== node) changed = true;
    return next;
  });
  return changed ? out : nodes;
}

/** Replace one node list — the root's, or a group's children. */
function updateList(
  nodes: SceneNode[],
  parentId: NodeId | null,
  update: (list: SceneNode[]) => SceneNode[],
): SceneNode[] {
  if (parentId === null) return update(nodes);
  let done = false;
  const step = (list: SceneNode[]): SceneNode[] => {
    let changed = false;
    const out = list.map((node) => {
      if (done || !isContainer(node)) return node;
      if (node.id === parentId) {
        done = true;
        changed = true;
        return { ...node, children: update(node.children) };
      }
      const children = step(node.children);
      if (children === node.children) return node;
      changed = true;
      return { ...node, children };
    });
    return changed ? out : list;
  };
  return step(nodes);
}

/** Pull the ids (with their subtrees) out of the tree, collecting them into
 *  `taken` in document order. */
function extract(
  nodes: SceneNode[],
  ids: ReadonlySet<NodeId>,
  taken: SceneNode[],
): SceneNode[] {
  let changed = false;
  const out: SceneNode[] = [];
  for (const node of nodes) {
    if (ids.has(node.id)) {
      taken.push(node);
      changed = true;
      continue;
    }
    if (isContainer(node)) {
      const children = extract(node.children, ids, taken);
      if (children !== node.children) {
        changed = true;
        out.push({ ...node, children });
        continue;
      }
    }
    out.push(node);
  }
  return changed ? out : nodes;
}

function dissolve(nodes: SceneNode[], id: NodeId): SceneNode[] {
  let changed = false;
  const out: SceneNode[] = [];
  for (const node of nodes) {
    if (node.id === id && isGroup(node)) {
      for (const child of node.children) out.push(liftOut(child, node));
      changed = true;
      continue;
    }
    if (isContainer(node)) {
      const children = dissolve(node.children, id);
      if (children !== node.children) {
        changed = true;
        out.push({ ...node, children });
        continue;
      }
    }
    out.push(node);
  }
  return changed ? out : nodes;
}

/** A group's child, expressed in the group's parent's space. */
function liftOut(child: SceneNode, group: GroupNode): SceneNode {
  if (group.rot === 0) {
    return patch(child, { x: child.x + group.x, y: child.y + group.y });
  }
  const centre = rotateAround(
    { x: child.x + child.w / 2, y: child.y + child.h / 2 },
    { x: group.w / 2, y: group.h / 2 },
    group.rot,
  );
  return patch(child, {
    x: group.x + centre.x - child.w / 2,
    y: group.y + centre.y - child.h / 2,
    rot: normalizeAngle(child.rot + group.rot),
  });
}

function spliceIn(
  list: SceneNode[],
  nodes: readonly SceneNode[],
  index?: number,
): SceneNode[] {
  const at =
    index === undefined ? list.length : Math.min(Math.max(index, 0), list.length);
  return [...list.slice(0, at), ...nodes, ...list.slice(at)];
}

function reorderDeep(
  nodes: SceneNode[],
  moving: ReadonlySet<NodeId>,
  at: "front" | "back" | "forward" | "backward",
): SceneNode[] {
  const ordered = nodes.some((node) => moving.has(node.id))
    ? orderList(nodes, moving, at)
    : nodes;
  let changed = ordered !== nodes;
  const out = ordered.map((node) => {
    if (!isContainer(node)) return node;
    const children = reorderDeep(node.children, moving, at);
    if (children === node.children) return node;
    changed = true;
    return { ...node, children };
  });
  return changed ? out : nodes;
}

function orderList(
  list: SceneNode[],
  moving: ReadonlySet<NodeId>,
  at: "front" | "back" | "forward" | "backward",
): SceneNode[] {
  let out: SceneNode[];
  if (at === "front" || at === "back") {
    const moved = list.filter((node) => moving.has(node.id));
    const rest = list.filter((node) => !moving.has(node.id));
    out = at === "front" ? [...rest, ...moved] : [...moved, ...rest];
  } else {
    out = list.slice();
    if (at === "forward") {
      for (let i = out.length - 2; i >= 0; i--) {
        if (moving.has(out[i].id) && !moving.has(out[i + 1].id)) {
          [out[i], out[i + 1]] = [out[i + 1], out[i]];
        }
      }
    } else {
      for (let i = 1; i < out.length; i++) {
        if (moving.has(out[i].id) && !moving.has(out[i - 1].id)) {
          [out[i], out[i - 1]] = [out[i - 1], out[i]];
        }
      }
    }
  }
  return out.every((node, i) => node === list[i]) ? list : out;
}

/** Fresh ids for a node and everything under it. */
function cloneWithNewIds(node: SceneNode, taken: Set<NodeId>): SceneNode {
  const clone = patch(node, { id: mintInto(taken, 1)[0] });
  if (!isContainer(clone)) return clone;
  return {
    ...clone,
    children: clone.children.map((child) => cloneWithNewIds(child, taken)),
  };
}

/** Ids with no selected ancestor — the ones a transform should actually move. */
function topMost(scene: SceneLike, ids: readonly NodeId[]): Set<NodeId> {
  const wanted = new Set(ids);
  const out = new Set<NodeId>();
  for (const id of wanted) {
    const path = nodePath(scene, id);
    if (!path.length) continue;
    if (path.slice(0, -1).some((node) => wanted.has(node.id))) continue;
    out.add(id);
  }
  return out;
}

/** The named nodes in document order — the order every op treats as canonical. */
function orderedNodes(scene: SceneLike, ids: ReadonlySet<NodeId>): SceneNode[] {
  const out: SceneNode[] = [];
  walk(rootNodes(scene), (node) => {
    if (ids.has(node.id)) out.push(node);
  });
  return out;
}

function parentOf(scene: SceneLike, id: NodeId): NodeId | null {
  return findParent(scene, id)?.id ?? null;
}

function childrenOf(scene: SceneLike, parentId: NodeId): SceneNode[] {
  const parent = findNode(scene, parentId);
  return parent && isContainer(parent) ? parent.children : [];
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Where a parent's child coordinate space sits in scene coordinates, by
 * translation alone. Only `groupNodes` needs it, and only to bring a member
 * from another parent into the new group's space; see the file header on why
 * ancestor rotation is out of scope.
 */
function originOf(scene: SceneLike, parentId: NodeId | null): Point {
  if (parentId === null) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const node of nodePath(scene, parentId)) {
    x += node.x;
    y += node.y;
  }
  return { x, y };
}

function shift(rect: Rect, by: Point): Rect {
  return { x: rect.x + by.x, y: rect.y + by.y, w: rect.w, h: rect.h };
}

// ---------------------------------------------------------------------------
// Edge ops
// ---------------------------------------------------------------------------

/** A connector needs two nodes that exist and are not the same one. Anything
 *  else is dropped rather than stored: there is nothing to draw between. */
function isDrawable(scene: Scene, edge: SceneEdge): boolean {
  return (
    edge.from !== edge.to &&
    findNode(scene, edge.from) !== null &&
    findNode(scene, edge.to) !== null
  );
}

/** Already joined, either way round. A connector has no direction the geometry
 *  can see, so a second one between the same pair would draw on top of the
 *  first and only the top one could be clicked. */
function alreadyJoined(edges: readonly SceneEdge[], edge: SceneEdge): boolean {
  return edges.some(
    (e) =>
      (e.from === edge.from && e.to === edge.to) ||
      (e.from === edge.to && e.to === edge.from),
  );
}

export function addEdges(scene: Scene, edges: readonly SceneEdge[]): Scene {
  const taken = new Set(scene.edges.map((edge) => edge.id));
  const next = [...scene.edges];
  for (const edge of edges) {
    if (taken.has(edge.id)) continue;
    if (!isDrawable(scene, edge) || alreadyJoined(next, edge)) continue;
    taken.add(edge.id);
    next.push(edge);
  }
  return next.length === scene.edges.length ? scene : { ...scene, edges: next };
}

export function removeEdges(scene: Scene, ids: readonly EdgeId[]): Scene {
  if (!ids.length) return scene;
  const gone = new Set(ids);
  const next = scene.edges.filter((edge) => !gone.has(edge.id));
  return next.length === scene.edges.length ? scene : { ...scene, edges: next };
}

/** One edge's fields, if it is there and the change is a change. */
function patchEdge(
  scene: Scene,
  id: EdgeId,
  fn: (edge: SceneEdge) => SceneEdge,
): Scene {
  let changed = false;
  const next = scene.edges.map((edge) => {
    if (edge.id !== id) return edge;
    const updated = fn(edge);
    if (updated !== edge) changed = true;
    return updated;
  });
  return changed ? { ...scene, edges: next } : scene;
}

export function setEdgeLabel(scene: Scene, id: EdgeId, label: string): Scene {
  return patchEdge(scene, id, (edge) =>
    edge.label === label ? edge : { ...edge, label },
  );
}

export function setEdgeStyle(
  scene: Scene,
  ids: readonly EdgeId[],
  decls: StylePatch,
): Scene {
  const wanted = new Set(ids);
  let changed = false;
  const next = scene.edges.map((edge) => {
    if (!wanted.has(edge.id)) return edge;
    const style = mergeStyle(edge.style, decls);
    if (style === edge.style) return edge;
    changed = true;
    return { ...edge, style };
  });
  return changed ? { ...scene, edges: next } : scene;
}

/**
 * Re-aim one end or both — the swap in the inspector, and later a dragged
 * endpoint. An end that would leave the edge undrawable is refused, so a swap
 * cannot quietly produce a connector from a node to itself.
 */
export function reconnect(
  scene: Scene,
  id: EdgeId,
  from?: NodeId,
  to?: NodeId,
): Scene {
  return patchEdge(scene, id, (edge) => {
    const next = { ...edge, from: from ?? edge.from, to: to ?? edge.to };
    if (next.from === edge.from && next.to === edge.to) return edge;
    if (!isDrawable(scene, next)) return edge;
    const others = scene.edges.filter((e) => e.id !== id);
    return alreadyJoined(others, next) ? edge : next;
  });
}
