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
 * The store is a `subscribe`/`getSnapshot` pair that notifies only when the
 * snapshot actually moves — a hover landing on the node it was already on, or a
 * click re-selecting what was already selected, is silent. So a pointer crossing
 * a shape costs at most one render of the canvas surface.
 *
 * That render maps over every node, but it does not redraw them: `ShapeView` is
 * memo'd on its node, `scene/ops` keeps the identity of every subtree an edit
 * did not touch, and nothing else the surface hands a shape moves when the
 * selection does. What re-renders is the overlay, which is what changed.
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

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { laidOutScene } from "../scene/autoLayout";
import {
  absoluteRect,
  absoluteRotation,
  absoluteSelectionBounds,
  toLocal,
  type RotatedRect,
} from "../scene/geometry";
import { containsPoint, hitTestAll, hitTestRect, type Candidate } from "../scene/picking";
import {
  findNode,
  findParent,
  isBoolean,
  isContainer,
  nodePath,
  selectedEdges as selectedEdgesOf,
  selectedNodes,
  topSelection,
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
  /** Address the deepest painted node instead of the outermost group — ⌘ on Apple, Ctrl elsewhere. */
  deep?: boolean;
  /**
   * Scene px, widening stroke bands only (`scene/picking.ts` §4.6). Every
   * pointer-anchored caller passes `slopFor(viewport.get().zoom)` so a click,
   * a hover and the context menu agree on what counts as "on" a thin stroke
   * at the same pixel (PICK §0/§9) — added here rather than re-derived by
   * each command below.
   */
  tolerance?: number;
}

/**
 * What a point resolved against — the full candidate walk behind `probe`,
 * `click` and `hover`, exposed so a caller deciding a gesture (Mod-drag
 * through a frame) can read it once rather than paying for a second
 * `hitTestAll` pass at the same pixel.
 */
export interface Resolved {
  /** Every painted candidate, front to back. Empty on bare canvas. */
  candidates: readonly Candidate[];
  /** The frontmost candidate's chain, outermost first. Empty when none. */
  chain: readonly SceneNode[];
  /**
   * The node a click takes: `chain[depth]` normally; the leaf under `deep`.
   * `null` when the chain ran out inside the entered path (the entered
   * container's own paint, which a click there deselects).
   */
  target: SceneNode | null;
  /** The entered path a click at this point leaves us at. */
  level: readonly NodeId[];
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
  /**
   * The private resolution behind `probe`/`click`, exposed for a caller that
   * needs the candidate list a press resolved against — today only the
   * surface's Mod-drag-through-frame check. Prefer `probe`/`click`/`hover`/
   * `candidates` elsewhere. `resolveAt(p, m).target?.id === probe(p, m)`.
   */
  resolveAt(point: Point, mods?: ClickMods): Resolved;
  /** Double-click: enter the group under the point and select the child. */
  enter(point: Point, opts?: { tolerance?: number }): void;
  /** Escape: step out one level and select the group left behind, else clear. */
  escape(): void;
  /**
   * Marquee, by **intersection** — Figma's rule, and the one that lets you
   * rubber-band a row without enclosing it. Selects within the entered
   * group, unless `within` names a container — the ⌘-drag-through-a-frame
   * marquee — in which case it scopes to that container's children and sets
   * the level to it.
   */
  marquee(rect: Rect, mods?: { shift?: boolean; within?: NodeId }): void;
  /** Report what is under the pointer; `null` clears it. */
  hover(point: Point | null, mods?: { deep?: boolean; tolerance?: number }): NodeId | null;
  /**
   * Every painted node under the point, front to back, independent of the
   * entered level — for the layer menu (SELECT-MENU, §9 of PICK). No
   * selection change, no notify: `hitTestAll(scene, point, opts)` directly.
   */
  candidates(point: Point, opts?: { tolerance?: number; includeLocked?: boolean }): readonly Candidate[];
  /** Ring this node, no hit test — a menu row is pointing at it. `null` clears. Never recorded. */
  hoverNode(id: NodeId | null): void;
  /**
   * Enter (exactly one top-level container selected): step into it and select
   * its first (frontmost, unlocked, visible) child. Returns `false` when it
   * did nothing — not exactly one top-level node selected, not a container,
   * or no eligible child. Boolean groups count as containers here.
   */
  enterSelected(): boolean;
  /**
   * Shift+Enter: select the parent of the selection (all selected must share
   * it), leaving the level at the parent's ancestors. With nothing selected
   * but a level entered, behaves as `escape()`. Returns `false` when it did
   * nothing (top-level selection, mixed parents, nothing at all).
   */
  selectParent(): boolean;
  /**
   * Tab / Shift+Tab at the entered level. `"next"` walks toward the BACK
   * (down the layers panel), `"previous"` toward the front, both wrapping.
   * Level unchanged. Returns `false` when there is no eligible node
   * **already selected** at this level to anchor the direction from — an
   * empty level, or nothing/only ineligible siblings selected — so Tab with
   * nothing selected is never consumed (no keyboard trap).
   */
  selectSibling(direction: "next" | "previous"): boolean;

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
 * {@link Resolved.chain} — taken against `laidOutScene(scene)`, which is what
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

/**
 * Whether a Mod-drag press at this resolved point should marquee through a
 * container instead of selecting or moving it — Figma's "hold the modifier
 * and drag the marquee across the objects" rule. Requires `deep` (Shift is
 * reserved for additive marquee/toggle, never a through-drag). Returns the
 * container's id when the *frontmost* candidate is a non-boolean container's
 * own paint (nothing else is painted over it at this pixel); `null`
 * otherwise — including when the frontmost candidate is a boolean group.
 *
 * A boolean group is excluded on purpose: it paints as one compound shape and
 * its operands never appear as their own hit candidates (PICK's contract), so
 * there is nothing distinct under the pointer to marquee "through". A
 * Mod-drag on its fill moves the compound exactly as a plain drag would;
 * `enterSelected()` can still step inside it for point editing (a deliberate
 * mode switch on Enter, not a guess about what a drag meant).
 */
export function marqueeThroughTarget(
  resolved: Resolved,
  mods: { deep: boolean; shift: boolean },
): NodeId | null {
  if (!mods.deep || mods.shift) return null;
  const top = resolved.candidates[0];
  return top && isContainer(top.node) && !isBoolean(top.node) ? top.node.id : null;
}

/** The frontmost (last), unlocked, visible child of a container — the child
 *  Enter steps into. `null` when there is none. */
function firstChild(node: SceneNode): SceneNode | null {
  if (!isContainer(node)) return null;
  for (let i = node.children.length - 1; i >= 0; i--) {
    const child = node.children[i];
    if (!child.hidden && !child.locked) return child;
  }
  return null;
}

/**
 * The operand a double-click on a boolean group actually lands on — `point`
 * already in the group's own local frame — frontmost first, so an operand
 * that covers another wins the same way it would if PICK offered operands as
 * candidates at all. Geometry only (`containsPoint`, not `paintedAt`): an
 * operand is routinely left unstyled, so testing its own paint would answer
 * for a hairline stroke band at best. A double-click has a point to test
 * against, unlike `enterSelected()`'s Enter key, which has none and so has
 * nothing better than `firstChild` to fall back on — which is also this
 * function's own fallback, for a subtract/intersect/exclude corner where the
 * derived shape and no single operand's own outline agree at this exact
 * point.
 */
function operandAt(group: SceneNode, point: Point): SceneNode | null {
  if (!isContainer(group)) return null;
  for (let i = group.children.length - 1; i >= 0; i--) {
    const child = group.children[i];
    if (child.hidden || child.locked) continue;
    if (containsPoint(child, toLocal(point, child))) return child;
  }
  return firstChild(group);
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
    const sameNodes = sameIds(ids, previous.ids);
    const samePath = sameIds(enteredPath, previous.enteredPath);
    const sameEdges = sameIds(edgeIds, previous.edgeIds);
    if (hoverId === previous.hoverId && sameNodes && samePath && sameEdges) return;
    // Whatever did not change keeps its identity, so a hover re-renders only
    // the readers of `hoverId`.
    snapshot = {
      ids: sameNodes ? previous.ids : ids,
      selected: sameNodes ? previous.selected : new Set(ids),
      enteredPath: samePath ? previous.enteredPath : enteredPath,
      hoverId,
      edgeIds: sameEdges ? previous.edgeIds : edgeIds,
      edgeSelected: sameEdges ? previous.edgeSelected : new Set(edgeIds),
    };
    for (const listener of listeners) listener();
    if (!record || !history) return;
    // Hovering is not selecting, and must not become an undo step.
    if (sameNodes && samePath && sameEdges) return;
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

  /**
   * The one candidate walk behind `probe`, `click` and `hover` — see
   * {@link Resolved}. `deep` addresses the frontmost candidate's leaf, its
   * ancestry becoming the level a click there leaves us at (Figma: once
   * inside a nested layer, subsequent clicks pick among its siblings). Not
   * deep resolves against the currently entered level, exactly as before.
   */
  const resolve = (point: Point, mods: ClickMods): Resolved => {
    const candidates = hitTestAll(scene, point, { tolerance: mods.tolerance ?? 0 });
    const chain = candidates[0]?.chain ?? [];
    if (mods.deep) {
      const target = chain.length ? chain[chain.length - 1] : null;
      return { candidates, chain, target, level: idsOf(chain.slice(0, -1)) };
    }
    const entered = idsOf(resolveLevel(scene, snapshot.enteredPath).path);
    const depth = agreeDepth(entered, chain);
    let target: SceneNode | null = chain[depth] ?? null;
    if (target === null && depth > 0 && depth === chain.length && isBoolean(chain[depth - 1])) {
      // The chain ran out exactly at a boolean group we are entered into.
      // PICK never offers its operands as their own candidates, but a point
      // that reached this far is on the group's own painted (derived) area,
      // which every boolean op guarantees is also some operand's own real
      // geometry — so there is a genuine answer here, not "click on
      // nothing, deselect". Without this, a press on the very shape a
      // double-click just selected read as a press on empty canvas, and
      // fell through to a marquee instead of moving it.
      const group = chain[depth - 1];
      let local: Point = point;
      for (const ancestor of chain) local = toLocal(local, ancestor);
      target = operandAt(group, local);
    }
    return { candidates, chain, target, level: entered.slice(0, depth) };
  };

  const probe: SelectionStore["probe"] = (point, mods = {}) =>
    resolve(point, mods).target?.id ?? null;

  const click: SelectionStore["click"] = (point, mods = {}) => {
    const resolved = resolve(point, mods);

    if (resolved.chain.length === 0) {
      // Clicking empty canvas leaves the group as well as the selection.
      if (!mods.shift) commit(NO_IDS, NO_IDS, snapshot.hoverId);
      return null;
    }

    if (resolved.target === null) {
      // The chain ran out inside the path: this is an entered container's own
      // fill, which deselects without leaving it.
      commit(mods.shift ? snapshot.ids : NO_IDS, resolved.level, snapshot.hoverId);
      return null;
    }

    const target = resolved.target;
    commit(
      mods.shift ? toggled(target.id) : [target.id],
      // Shift keeps the current level — a toggle across groups has no single
      // ancestry. Non-shift takes the resolved level, which for `deep` is
      // the leaf's own ancestry: once inside, subsequent clicks pick among
      // its siblings.
      mods.shift ? snapshot.enteredPath : resolved.level,
      snapshot.hoverId,
    );
    return target.id;
  };

  /** Escape's own logic, shared with `selectParent()`'s zero-selection branch. */
  const escapeOnce = (): void => {
    const { path } = resolveLevel(scene, snapshot.enteredPath);
    if (path.length === 0) {
      commit(NO_IDS, NO_IDS, snapshot.hoverId);
      return;
    }
    const leaving = path[path.length - 1];
    commit([leaving.id], idsOf(path.slice(0, -1)), snapshot.hoverId);
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

    enter(point, opts = {}) {
      const chain = resolve(point, { tolerance: opts.tolerance }).chain;
      if (chain.length === 0) return;
      const entered = idsOf(resolveLevel(scene, snapshot.enteredPath).path);
      if (!descends(entered, chain)) {
        // A boolean group's own operands never appear in the chain — PICK's
        // walk never descends into them, since they paint nothing of their
        // own — so `descends` reads a double-click on one exactly like a
        // click on a leaf, and steps into it, `enterSelected()` already
        // does. Mirror that here: the chain's own leaf, one step in — but
        // unlike Enter, a double-click has a point, and `firstChild` alone
        // would always land on the frontmost operand even when the pointer
        // is squarely over a different one's own exposed area. Unless we
        // are already inside this exact leaf (agreeDepth having consumed
        // the whole chain means the last double-click already entered it
        // and there is nothing deeper).
        const leaf = chain[chain.length - 1];
        const alreadyIn = agreeDepth(entered, chain) === chain.length;
        if (!alreadyIn && isBoolean(leaf) && !leaf.hidden) {
          let local: Point = point;
          for (const ancestor of chain) local = toLocal(local, ancestor);
          const child = operandAt(leaf, local);
          if (child) {
            commit([child.id], idsOf(nodePath(scene, leaf.id)), snapshot.hoverId);
            return;
          }
        }
        // Nothing left to enter — a double-click on a leaf is just a click.
        click(point, { tolerance: opts.tolerance });
        return;
      }
      // Exactly one level, however deep the chain goes: the child of the group
      // we are now inside, not the leaf under the pointer.
      const depth = agreeDepth(entered, chain) + 1;
      commit([chain[depth].id], idsOf(chain.slice(0, depth)), snapshot.hoverId);
    },

    escape() {
      escapeOnce();
    },

    marquee(rect, mods = {}) {
      const withinNode = mods.within ? findNode(scene, mods.within) : null;
      let path: SceneNode[];
      let nodes: readonly SceneNode[];
      let container: SceneNode | undefined;
      if (withinNode && isContainer(withinNode) && !withinNode.hidden) {
        path = nodePath(scene, withinNode.id);
        nodes = withinNode.children;
        container = withinNode;
      } else {
        const level = resolveLevel(scene, snapshot.enteredPath);
        path = level.path;
        nodes = level.nodes;
        container = path[path.length - 1];
      }
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
      const target = resolve(point, mods).target;
      commitHover(target?.id ?? null);
      return target?.id ?? null;
    },

    resolveAt(point, mods = {}) {
      return resolve(point, mods);
    },

    candidates(point, opts = {}) {
      return hitTestAll(scene, point, opts);
    },

    hoverNode(id) {
      commitHover(id);
    },

    enterSelected() {
      const nodes = topSelection(scene, snapshot.ids);
      if (nodes.length !== 1) return false;
      const node = nodes[0];
      if (!isContainer(node) || node.hidden) return false;
      const child = firstChild(node);
      if (!child) return false;
      commit([child.id], idsOf(nodePath(scene, node.id)), snapshot.hoverId);
      return true;
    },

    selectParent() {
      const nodes = topSelection(scene, snapshot.ids);
      if (nodes.length === 0) {
        const { path } = resolveLevel(scene, snapshot.enteredPath);
        if (path.length === 0) return false;
        escapeOnce();
        return true;
      }
      const parents = new Set(nodes.map((n) => findParent(scene, n.id)?.id ?? null));
      if (parents.size !== 1) return false;
      const [parentId] = parents;
      if (parentId === null) return false;
      commit([parentId], idsOf(nodePath(scene, parentId).slice(0, -1)), snapshot.hoverId);
      return true;
    },

    selectSibling(direction) {
      const { path, nodes: level } = resolveLevel(scene, snapshot.enteredPath);
      const eligible = level.filter((n) => !n.hidden && !n.locked);
      if (eligible.length === 0) return false;
      let leadId: NodeId | null = null;
      for (let i = snapshot.ids.length - 1; i >= 0; i--) {
        if (eligible.some((n) => n.id === snapshot.ids[i])) {
          leadId = snapshot.ids[i];
          break;
        }
      }
      if (leadId === null) return false;
      const i = eligible.findIndex((n) => n.id === leadId);
      const n = eligible.length;
      const pick = direction === "next" ? eligible[(i - 1 + n) % n] : eligible[(i + 1) % n];
      commit([pick.id], idsOf(path), snapshot.hoverId);
      return true;
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
  /** Each selected node's own frame, for the faint per-member outlines. Empty
   *  below two, where {@link selectionBounds} is already that one node's frame. */
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
  const { ids: rawIds, enteredPath: rawPath, edgeIds, edgeSelected, hoverId, selected } =
    snapshot;

  // Resolved apart from the hover, so a pointer crossing the canvas hands the
  // panels the same `nodes` and `edges` and they can skip the render.
  const resolved = useMemo(() => {
    const nodes = selectedNodes(scene, rawIds);
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
    const enteredPath = idsOf(resolveLevel(laid, rawPath).path);
    return {
      ids,
      nodes,
      selectionBounds: bounds,
      memberBounds: ids.length > 1 ? ids.map((id) => frameOf(laid, id)) : NO_BOUNDS,
      enteredPath,
      enteredId: enteredPath.length ? enteredPath[enteredPath.length - 1] : null,
      /** Resolved connectors, stale ids dropped — `nodes` for edges. */
      edges: selectedEdgesOf(scene, edgeIds),
    };
  }, [scene, rawIds, rawPath, edgeIds]);

  const hoverBounds = useMemo(
    () =>
      hoverId && !selected.has(hoverId) ? frameOf(laidOutScene(scene), hoverId) : null,
    [scene, hoverId, selected],
  );

  return useMemo(
    () => ({ ...resolved, hoverBounds, hoverId, edgeIds, edgeSelected }),
    [resolved, hoverBounds, hoverId, edgeIds, edgeSelected],
  );
}
