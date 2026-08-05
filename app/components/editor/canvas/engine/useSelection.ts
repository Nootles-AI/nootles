"use client";

/**
 * Selection — Figma's model, exactly.
 *
 * A click selects the **outermost group** containing what it hit, not the leaf.
 * Double-click enters that group and selects the child; Escape steps back out.
 * The state that makes this work is a path, not a flag: `enteredPath` is the
 * chain of containers we are currently inside, outermost first, and the
 * "current level" is that container's children. Every gesture below resolves
 * against it — a click picks the hit chain's node *at* that depth, ⌘A takes the
 * level's children, a marquee runs inside the level's coordinate space. A
 * boolean "inside a group" cannot express two nested groups, and reconstructing
 * the level from the selection fails the moment the selection is empty.
 *
 * The path is also self-healing. {@link resolveLevel} walks it against the live
 * scene each time and stops at the first id that is no longer a container
 * there, so an undo, a delete or an ungroup drops us to a level that still
 * exists without an effect watching for it.
 *
 * ## Subscription discipline
 *
 * Selection changes must not re-render the scene. The store is a
 * `subscribe`/`getSnapshot` pair, and a `ShapeView` subscribes through
 * {@link useIsSelected}, whose snapshot is a boolean — `useSyncExternalStore`
 * compares what it returns, so a shape re-renders only when its own
 * selectedness flips, never because a sibling was selected or the hover moved.
 *
 * ## Where the scene comes from
 *
 * The store holds the scene its commands read and is handed a new one whenever
 * it changes ({@link SelectionStore.setScene}); it never notifies for that,
 * since nothing in the snapshot derives from the scene. {@link useSelection}
 * takes the scene as an argument instead: it resolves nodes and bounds for a
 * frame, and resolving them against anything other than the scene that frame is
 * rendering is how an overlay ends up drawn around where a shape used to be.
 *
 * Both go through {@link laidOutScene}: a child of an auto-layout group is
 * placed by its parent, so its authored `x`/`y` say nothing about where it is,
 * and hit-testing or framing it from those is how the outline ends up beside
 * the shape. The panel is handed the authored nodes — it edits the model — but
 * every rect here comes from the laid-out one.
 *
 * ## Selection is undoable
 *
 * Given a {@link SceneStore} through {@link SelectionStore.setHistory}, every
 * change to what is selected — but never a change to what is merely hovered —
 * hands that store a thunk restoring the selection it replaced, and undo puts
 * it back. The scene store decides which of those become steps of their own;
 * see its `recordSelection`.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { laidOutScene } from "../scene/autoLayout";
import {
  absoluteRect,
  absoluteRotation,
  absoluteSelectionBounds,
  hitTestPath,
  hitTestRect,
  toLocal,
  type RotatedRect,
} from "../scene/geometry";
import {
  isContainer,
  nodePath,
  selectedEdges as selectedEdgesOf,
  selectedNodes,
  walk,
  type EdgeId,
  type NodeId,
  type Point,
  type Rect,
  type Scene,
  type SceneEdge,
  type SceneLike,
  type SceneNode,
} from "../scene/types";
import type { RestoreSelection, SceneStore } from "./useScene";

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * What the store holds. Ids are in document order (back-to-front) and may name
 * a node the scene no longer has — a delete or an undo outrunning a gesture is
 * routine, and {@link useSelection} drops the strays when it resolves them.
 */
export interface SelectionSnapshot {
  ids: readonly NodeId[];
  /** The same ids, for O(1) membership — every shape asks this on every change. */
  selected: ReadonlySet<NodeId>;
  /** Containers we are inside, outermost first. Empty is the top level. */
  enteredPath: readonly NodeId[];
  /** The node under the pointer that a click would take, for the overlay. */
  hoverId: NodeId | null;
  /**
   * Selected connectors. Mutually exclusive with `ids`: an edge has none of the
   * properties a shape has, so a selection holding both would leave the
   * inspector with nothing it could show for all of it. Selecting either kind
   * clears the other.
   */
  edgeIds: readonly EdgeId[];
  edgeSelected: ReadonlySet<EdgeId>;
}

/** Modifiers a click carries. */
export interface ClickMods {
  /** Toggle the hit node in or out of the selection. */
  shift?: boolean;
  /** Address the deepest node instead of the outermost group — alt/option. */
  deep?: boolean;
}

export interface SelectionStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): SelectionSnapshot;
  isSelected(id: NodeId): boolean;

  /**
   * Point the commands at the current scene. Never notifies — the snapshot is
   * ids and a path, so nothing subscribed can be out of date because of this.
   */
  setScene(scene: SceneLike): void;

  /**
   * Put selection changes into a scene store's undo history, Figma-style, so
   * undo restores what was selected as well as what changed. `null` unhooks.
   */
  setHistory(store: SceneStore | null): void;

  /**
   * Select these ids outright. The level follows the first id's ancestry, so
   * picking a nested node in the layers panel puts subsequent clicks in its
   * group, as Figma does. Ids the scene does not have yet are kept, not
   * dropped: selecting what you just inserted runs before the scene state that
   * contains it has reached this store.
   */
  select(ids: readonly NodeId[]): void;
  toggle(id: NodeId): void;
  /** Nothing selected, back at the top level. */
  clear(): void;
  /** Every unlocked, visible node at the current level — ⌘/Ctrl+A. */
  selectAll(): void;

  /**
   * Resolve a click at a scene-space point. Returns the id it selected, or
   * `null` for empty canvas — which is what tells a pointerdown whether it is
   * starting a drag or a marquee.
   */
  click(point: Point, mods?: ClickMods): NodeId | null;
  /**
   * What {@link click} would select, without selecting it. Lets a pointerdown
   * tell "drag the selection" from "change the selection" before committing
   * either — a press on an already-selected node must not collapse the
   * selection it is about to move.
   */
  probe(point: Point, mods?: ClickMods): NodeId | null;
  /** Double-click: enter the group under the point and select the child. */
  enter(point: Point): void;
  /** Escape: step out one level and select the group left behind, else clear. */
  escape(): void;
  /**
   * Marquee, by **intersection** — Figma's rule, and the one that lets you
   * rubber-band a row without enclosing it. Selects within the entered group.
   */
  marquee(rect: Rect, mods?: { shift?: boolean }): void;
  /** Report what is under the pointer; `null` clears it. */
  hover(point: Point | null, mods?: { deep?: boolean }): NodeId | null;

  /** Select these connectors outright, clearing any node selection. */
  selectEdges(ids: readonly EdgeId[]): void;
  toggleEdge(id: EdgeId): void;
  isEdgeSelected(id: EdgeId): boolean;
}

const NO_IDS: readonly NodeId[] = [];
const NO_SET: ReadonlySet<NodeId> = new Set();

const NO_EDGES: readonly EdgeId[] = [];
const NO_EDGE_SET: ReadonlySet<EdgeId> = new Set();

const EMPTY_SNAPSHOT: SelectionSnapshot = {
  ids: NO_IDS,
  selected: NO_SET,
  enteredPath: NO_IDS,
  hoverId: null,
  edgeIds: NO_EDGES,
  edgeSelected: NO_EDGE_SET,
};

// ---------------------------------------------------------------------------
// Level resolution
// ---------------------------------------------------------------------------

function rootNodes(scene: SceneLike): readonly SceneNode[] {
  return Array.isArray(scene) ? scene : (scene as Scene).nodes;
}

interface Level {
  /** The entered containers that still exist, outermost first. */
  path: SceneNode[];
  /** The nodes a click, marquee or ⌘A at this level chooses from. */
  nodes: readonly SceneNode[];
}

function resolveLevel(scene: SceneLike, entered: readonly NodeId[]): Level {
  let nodes = rootNodes(scene);
  const path: SceneNode[] = [];
  for (const id of entered) {
    const node = nodes.find((n) => n.id === id);
    if (!node || !isContainer(node) || node.hidden) break;
    path.push(node);
    nodes = node.children;
  }
  return { path, nodes };
}

/** How much of the entered path the hit chain agrees with. */
function agreeDepth(
  entered: readonly NodeId[],
  chain: readonly SceneNode[],
): number {
  let depth = 0;
  while (
    depth < entered.length &&
    depth < chain.length &&
    entered[depth] === chain[depth].id
  ) {
    depth++;
  }
  return depth;
}

/**
 * Whether a double-click on this hit chain goes one level *in* rather than
 * meaning something to the node itself — Figma's rule, and the reason a shape
 * inside a group takes two double-clicks to edit: the first one enters the
 * group and selects the shape, the second opens its label.
 *
 * `entered` is a resolved {@link ResolvedSelection.enteredPath} and `chain` is
 * {@link hitTestPath}'s — taken against `laidOutScene(scene)`, which is what
 * the store hit-tests, or the two can disagree inside an auto-layout group.
 * This is exactly the depth {@link SelectionStore.enter} resolves the click at,
 * asked one step earlier, so a surface can route the click before the selection
 * has moved under it.
 */
export function descends(
  entered: readonly NodeId[],
  chain: readonly SceneNode[],
): boolean {
  return chain.length > agreeDepth(entered, chain) + 1;
}

function idsOf(nodes: readonly SceneNode[]): NodeId[] {
  return nodes.map((n) => n.id);
}

/**
 * Ids in document order, deduplicated. Ids absent from the scene keep their
 * given order at the end rather than vanishing — see {@link SelectionStore.select}.
 */
function orderIds(scene: SceneLike, ids: readonly NodeId[]): NodeId[] {
  const wanted = new Set(ids);
  if (wanted.size === 0) return [];
  const out: NodeId[] = [];
  walk(rootNodes(scene), (node) => {
    if (wanted.delete(node.id)) out.push(node.id);
  });
  for (const id of wanted) out.push(id);
  return out;
}

function sameIds(a: readonly NodeId[], b: readonly NodeId[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A scene-space rect in a container's local space, where its children live.
 *
 * Exact while the container's chain is unrotated, since the transform is then a
 * translation. A rotated ancestor makes the marquee oblique in local space and
 * this returns its bounds, which over-selects at the corners rather than
 * missing anything — the exact oriented test is private to the geometry module.
 */
function rectInLocalSpace(scene: SceneLike, container: SceneNode, rect: Rect): Rect {
  const frame: RotatedRect = {
    ...absoluteRect(scene, container.id),
    rot: absoluteRotation(scene, container.id),
  };
  const x1 = rect.x + rect.w;
  const y1 = rect.y + rect.h;
  const corners = [
    toLocal({ x: rect.x, y: rect.y }, frame),
    toLocal({ x: x1, y: rect.y }, frame),
    toLocal({ x: x1, y: y1 }, frame),
    toLocal({ x: rect.x, y: y1 }, frame),
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of corners) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export function createSelectionStore(initialScene: SceneLike): SelectionStore {
  let scene = initialScene;
  let snapshot = EMPTY_SNAPSHOT;
  let history: SceneStore | null = null;
  const listeners = new Set<() => void>();

  /** The one write. `record` is false only while history is rewinding us. */
  const apply = (
    ids: readonly NodeId[],
    enteredPath: readonly NodeId[],
    hoverId: NodeId | null,
    edgeIds: readonly EdgeId[],
    record: boolean,
  ) => {
    const previous = snapshot;
    if (
      hoverId === previous.hoverId &&
      sameIds(ids, previous.ids) &&
      sameIds(enteredPath, previous.enteredPath) &&
      sameIds(edgeIds, previous.edgeIds)
    ) {
      return;
    }
    snapshot = {
      ids,
      selected: new Set(ids),
      enteredPath,
      hoverId,
      edgeIds,
      edgeSelected: new Set(edgeIds),
    };
    for (const listener of listeners) listener();
    if (!record || !history) return;
    // Hovering is not selecting, and must not become an undo step.
    if (
      sameIds(ids, previous.ids) &&
      sameIds(enteredPath, previous.enteredPath) &&
      sameIds(edgeIds, previous.edgeIds)
    ) {
      return;
    }
    history.recordSelection(restoreTo(previous));
  };

  /** A thunk putting that selection back, leaving the hover where it is. */
  const restoreTo =
    (state: SelectionSnapshot): RestoreSelection =>
    () =>
      apply(state.ids, state.enteredPath, snapshot.hoverId, state.edgeIds, false);

  /** Selecting nodes. Always clears the edge selection — see the snapshot. */
  const commit = (
    ids: readonly NodeId[],
    enteredPath: readonly NodeId[],
    hoverId: NodeId | null,
  ) => apply(ids, enteredPath, hoverId, NO_EDGES, true);

  /** Pointing at something changes neither selection. */
  const commitHover = (hoverId: NodeId | null) =>
    apply(snapshot.ids, snapshot.enteredPath, hoverId, snapshot.edgeIds, true);

  /** Selecting connectors, which clears the node selection for the same reason. */
  const commitEdges = (edgeIds: readonly EdgeId[]) =>
    apply(NO_IDS, snapshot.enteredPath, snapshot.hoverId, edgeIds, true);

  const toggled = (id: NodeId): NodeId[] =>
    snapshot.selected.has(id)
      ? snapshot.ids.filter((other) => other !== id)
      : orderIds(scene, [...snapshot.ids, id]);

  const probe: SelectionStore["probe"] = (point, mods = {}) => {
    const chain = hitTestPath(scene, point);
    if (chain.length === 0) return null;
    if (mods.deep) return chain[chain.length - 1].id;
    const entered = idsOf(resolveLevel(scene, snapshot.enteredPath).path);
    return chain[agreeDepth(entered, chain)]?.id ?? null;
  };

  const click: SelectionStore["click"] = (point, mods = {}) => {
    const chain = hitTestPath(scene, point);

    if (chain.length === 0) {
      // Clicking empty canvas leaves the group as well as the selection.
      if (!mods.shift) commit(NO_IDS, NO_IDS, snapshot.hoverId);
      return null;
    }

    if (mods.deep) {
      const leaf = chain[chain.length - 1];
      commit(
        mods.shift ? toggled(leaf.id) : [leaf.id],
        snapshot.enteredPath,
        snapshot.hoverId,
      );
      return leaf.id;
    }

    const entered = idsOf(resolveLevel(scene, snapshot.enteredPath).path);
    const depth = agreeDepth(entered, chain);
    // A click outside the entered group drops us to the level it shares with
    // what we hit; a click inside keeps the level it already had.
    const level = entered.slice(0, depth);
    const target = chain[depth];

    // The chain ran out inside the path: this is an entered container's own
    // fill, which deselects without leaving it.
    if (!target) {
      commit(mods.shift ? snapshot.ids : NO_IDS, level, snapshot.hoverId);
      return null;
    }

    commit(
      mods.shift ? toggled(target.id) : [target.id],
      level,
      snapshot.hoverId,
    );
    return target.id;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot: () => snapshot,

    isSelected: (id) => snapshot.selected.has(id),

    setScene(next) {
      scene = next;
    },

    setHistory(store) {
      if (store === history) return;
      history?.setSelectionHistory(null);
      history = store;
      store?.setSelectionHistory({ capture: () => restoreTo(snapshot) });
    },

    select(ids) {
      const ordered = orderIds(scene, ids);
      const ancestors = ordered.length
        ? idsOf(nodePath(scene, ordered[0]).slice(0, -1))
        : NO_IDS;
      commit(ordered, ancestors, snapshot.hoverId);
    },

    toggle(id) {
      commit(toggled(id), snapshot.enteredPath, snapshot.hoverId);
    },

    clear() {
      apply(NO_IDS, NO_IDS, snapshot.hoverId, NO_EDGES, true);
    },

    selectEdges(ids) {
      commitEdges([...ids]);
    },

    toggleEdge(id) {
      commitEdges(
        snapshot.edgeSelected.has(id)
          ? snapshot.edgeIds.filter((e) => e !== id)
          : [...snapshot.edgeIds, id],
      );
    },

    isEdgeSelected(id) {
      return snapshot.edgeSelected.has(id);
    },

    selectAll() {
      const { path, nodes } = resolveLevel(scene, snapshot.enteredPath);
      const ids = nodes.filter((n) => !n.locked && !n.hidden).map((n) => n.id);
      commit(ids, idsOf(path), snapshot.hoverId);
    },

    click,

    probe,

    enter(point) {
      const chain = hitTestPath(scene, point);
      if (chain.length === 0) return;
      const entered = idsOf(resolveLevel(scene, snapshot.enteredPath).path);
      if (!descends(entered, chain)) {
        // Nothing left to enter — a double-click on a leaf is just a click.
        click(point);
        return;
      }
      // Exactly one level, however deep the chain goes: the child of the group
      // we are now inside, not the leaf under the pointer.
      const depth = agreeDepth(entered, chain) + 1;
      commit([chain[depth].id], idsOf(chain.slice(0, depth)), snapshot.hoverId);
    },

    escape() {
      const { path } = resolveLevel(scene, snapshot.enteredPath);
      if (path.length === 0) {
        commit(NO_IDS, NO_IDS, snapshot.hoverId);
        return;
      }
      const leaving = path[path.length - 1];
      commit([leaving.id], idsOf(path.slice(0, -1)), snapshot.hoverId);
    },

    marquee(rect, mods = {}) {
      const { path, nodes } = resolveLevel(scene, snapshot.enteredPath);
      const container = path[path.length - 1];
      const hits = container
        ? hitTestRect(nodes, rectInLocalSpace(scene, container, rect))
        : hitTestRect(scene, rect);
      const ids = idsOf(hits);
      commit(
        mods.shift ? orderIds(scene, [...snapshot.ids, ...ids]) : ids,
        idsOf(path),
        snapshot.hoverId,
      );
    },

    hover(point, mods = {}) {
      if (!point) {
        commitHover(null);
        return null;
      }
      const chain = hitTestPath(scene, point);
      if (chain.length === 0) {
        commitHover(null);
        return null;
      }
      let node: SceneNode;
      if (mods.deep) {
        node = chain[chain.length - 1];
      } else {
        const entered = idsOf(resolveLevel(scene, snapshot.enteredPath).path);
        const depth = agreeDepth(entered, chain);
        node = chain[depth] ?? chain[chain.length - 1];
      }
      commitHover(node.id);
      return node.id;
    },
  };
}

// ---------------------------------------------------------------------------
// React
// ---------------------------------------------------------------------------

/**
 * One store for the life of the canvas, kept pointed at the current scene.
 *
 * The handoff is an effect rather than a render-time write because the store is
 * shared mutable state and render must stay pure; effects flush before the next
 * event, so a command still sees the scene the user was looking at when they
 * acted.
 *
 * Pass the scene store as `history` to put selection changes in its undo tree.
 */
export function useSelectionStore(
  scene: SceneLike,
  history?: SceneStore | null,
): SelectionStore {
  const [store] = useState(() => createSelectionStore(laidOutScene(scene)));
  useEffect(() => {
    store.setScene(laidOutScene(scene));
  }, [store, scene]);
  useEffect(() => {
    store.setHistory(history ?? null);
    return () => store.setHistory(null);
  }, [store, history]);
  return store;
}

/** The selection, resolved against the scene. */
export interface ResolvedSelection {
  /** Live ids only, in document order. */
  ids: readonly NodeId[];
  /** The **authored** nodes — what the style panel reads and edits. */
  nodes: readonly SceneNode[];
  /**
   * The box the overlay draws, in **scene** space. A single node gives its own
   * unrotated box plus its rotation, so the overlay hugs a spun shape and the
   * handles land on its real corners; two or more give the axis-aligned union,
   * which has no rotation of its own.
   */
  selectionBounds: RotatedRect;
  /** Each selected node's own frame, for the faint per-member outlines. */
  memberBounds: readonly RotatedRect[];
  /** The hovered node's frame; `null` when nothing is hovered or it is selected. */
  hoverBounds: RotatedRect | null;
  /** Containers we are inside, outermost first, truncated to what still exists. */
  enteredPath: readonly NodeId[];
  /** The innermost entered container, i.e. the current level. */
  enteredId: NodeId | null;
  hoverId: NodeId | null;
  /** The **authored** connectors — what the edge inspector reads and edits. */
  edges: readonly SceneEdge[];
  edgeIds: readonly EdgeId[];
  edgeSelected: ReadonlySet<EdgeId>;
}

const EMPTY_BOUNDS: RotatedRect = { x: 0, y: 0, w: 0, h: 0, rot: 0 };
const NO_BOUNDS: readonly RotatedRect[] = [];

function frameOf(scene: SceneLike, id: NodeId): RotatedRect {
  return { ...absoluteRect(scene, id), rot: absoluteRotation(scene, id) };
}

export function useSelection(store: SelectionStore, scene: SceneLike): ResolvedSelection {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  return useMemo(() => {
    const nodes = selectedNodes(scene, snapshot.ids);
    const ids = idsOf(nodes);
    // Every rect below comes from here, so a re-layout — a duplicate, a resize,
    // a reorder, a gap change — moves the outline with the shape.
    const laid = laidOutScene(scene);
    const bounds =
      ids.length === 0
        ? EMPTY_BOUNDS
        : ids.length === 1
          ? frameOf(laid, ids[0])
          : { ...absoluteSelectionBounds(laid, ids), rot: 0 };
    const hover = snapshot.hoverId;
    const enteredPath = idsOf(resolveLevel(laid, snapshot.enteredPath).path);
    return {
      ids,
      nodes,
      selectionBounds: bounds,
      memberBounds: ids.length > 1 ? ids.map((id) => frameOf(laid, id)) : NO_BOUNDS,
      hoverBounds:
        hover && !snapshot.selected.has(hover) ? frameOf(laid, hover) : null,
      enteredPath,
      enteredId: enteredPath.length ? enteredPath[enteredPath.length - 1] : null,
      hoverId: hover,
      /** Resolved connectors, stale ids dropped — `nodes` for edges. */
      edges: selectedEdgesOf(scene, snapshot.edgeIds),
      edgeIds: snapshot.edgeIds,
      edgeSelected: snapshot.edgeSelected,
    };
  }, [scene, snapshot]);
}

/**
 * Whether one node is selected. The snapshot is a boolean, so a shape
 * re-renders only when its own state flips — this is what keeps selecting a
 * node from re-rendering the scene.
 */
export function useIsSelected(store: SelectionStore, id: NodeId): boolean {
  const isSelected = useCallback(() => store.isSelected(id), [store, id]);
  return useSyncExternalStore(store.subscribe, isSelected, isSelected);
}
