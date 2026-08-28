"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { isApplyingAi, pushHumanOp } from "@/app/lib/debugRing";
import { track } from "@/app/lib/telemetry";
import { migrateLegacyCanvas } from "../scene/migrate";
import { applyOps } from "../scene/ops";
import { serializeScene } from "../scene/serialize";
import {
  walk,
  type NodeId,
  type Scene,
  type SceneNode,
  type SceneOp,
} from "../scene/types";

/**
 * The canvas editor's store — one `Scene`, one way to change it, one place it
 * is persisted from.
 *
 * The store lives outside React on purpose. It is one mutable object that
 * gestures, panels and the keymap all write to between renders, and undo and
 * persistence are its business rather than a component's. React reads it through
 * {@link useSyncExternalStore}, so each consumer subscribes to the projection it
 * actually needs — the surface to the whole scene, the toolbar to whether undo
 * has anything to do.
 *
 * The scene projection re-renders the surface on every edit, and that is
 * affordable because `./scene/ops` guarantees structural sharing: an edit hands
 * back a scene whose untouched subtrees are the *same objects*, and `ShapeView`
 * is memo'd on its node — so dragging one shape reconciles the node list and
 * re-renders one shape. The granularity is a property of the data, not of a
 * diffing pass here.
 *
 * ## History is bracketed, not sampled
 *
 * A drag emits one op at its end (per-frame work mutates the DOM directly), but
 * a resize with a snap, a label edited character by character, or a panel slider
 * dragged across a range all emit many. {@link SceneStore.begin} /
 * {@link SceneStore.commit} bracket a continuous interaction: the "before"
 * snapshot is taken once at `begin`, the entry is written once at `commit`, and
 * an interaction that changed nothing — a press that turned out not to be a
 * drag — writes nothing at all. Outside a bracket every `dispatch` is its own
 * entry, which is what a menu command or a nudge should be.
 *
 * ## Undo rewinds the selection too
 *
 * As in Figma, an entry remembers what was selected before its change and undo
 * puts that back, so undoing a move re-selects the shape and undoing a delete
 * brings it back selected; redo restores the selection the change left behind,
 * which is captured as the entry is stepped over. A selection change with no
 * edit behind it is an entry of its own — but consecutive ones collapse, so a
 * marquee drag, or five clicks in a row, costs one entry rather than one per
 * frame and nobody has to press ⌘Z five times to reach their edit.
 *
 * ## `lastSource` is the loop breaker
 *
 * The block prop is both our output and our input: we write serialized HTML into
 * it, and it comes straight back as a new `source`. `lastSource` records what we
 * wrote, so our own round trip is recognised and ignored, and a `source` that
 * does *not* match it is somebody else's edit — an AI op, or the same document
 * open in another tab — which is adopted, and stays undoable.
 */

/** Entries of undo history. Bounded so a long session cannot grow without end. */
const MAX_HISTORY = 100;

/** How long after the last change the scene is written back to the block. */
const PERSIST_MS = 500;

/** Puts back whatever was selected at the moment it was captured. */
export type RestoreSelection = () => void;

/**
 * The selection's side of undo. History keeps a thunk per entry rather than a
 * selection value: what a selection *is* remains the selection store's
 * business, and history only ever needs to put one back.
 */
export interface SelectionHistory {
  /** A thunk restoring the selection as it stands right now. */
  capture(): RestoreSelection;
}

interface HistoryEntry {
  scene: Scene;
  /** The selection as it stood while this scene was the current one. */
  selection: RestoreSelection | null;
  /** Nothing but the selection changed — consecutive ones collapse into one. */
  selectionOnly: boolean;
}

/**
 * What just happened to this store's history, for anything keeping a parallel
 * record — the workspace history spine holds one token per entry here, and
 * these events are what keep the two ledgers the same length.
 */
export type SceneHistoryEvent =
  /** An entry was pushed onto `past`. */
  | { type: "push"; selectionOnly: boolean }
  /** The oldest entry fell off the bounded end of `past`. */
  | { type: "trim" }
  /** A collaborator's merge reset both stacks. */
  | { type: "clear" };

export class SceneStore {
  private scene: Scene;
  /** Id → node for the current scene, built on demand and dropped on change. */
  private index: Map<NodeId, SceneNode> | null = null;
  private readonly listeners = new Set<() => void>();

  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  /** Nesting depth of `begin`/`commit`; > 0 means a gesture is in progress. */
  private depth = 0;
  private gestureBefore: Scene | null = null;
  /** Ops applied since `begin`, flushed to the debug ring as one entry. */
  private gestureOps: SceneOp[] = [];
  private gestureSelection: RestoreSelection | null = null;

  private selection: SelectionHistory | null = null;
  /** Set for the rest of the task by any edit — see {@link recordSelection}. */
  private justEdited = false;

  private write: (source: string, scene: Scene) => void = () => {};
  private lastSource: string;
  /** An external source that arrived mid-gesture, adopted once it ends. */
  private pendingSource: string | null = null;
  /** Whether the pending source came from {@link adoptRemote}. */
  private pendingRemote = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(source: string) {
    this.scene = migrateLegacyCanvas(source);
    this.lastSource = source;
  }

  /**
   * Where a serialized scene goes. Kept mutable and set from an effect: the
   * block hands down a fresh closure on every render, and capturing the first
   * one would persist into a stale editor.
   *
   * The scene the string came from rides along, so a writer that wants the
   * model — the CRDT binding, which diffs it — does not re-parse the HTML this
   * store serialized a line earlier.
   */
  setWriter = (write: (source: string, scene: Scene) => void): void => {
    this.write = write;
  };

  private live: ((scene: Scene) => void) | null = null;

  /**
   * A second, immediate output for collaboration: called synchronously with
   * every committed scene — each dispatch, gesture end, undo — where the
   * debounced writer waits for quiet that continuous editing never gives it.
   * The CRDT binding ships per-shape diffs through here, so a collaborator
   * sees each gesture land as it ends rather than when the editor pauses.
   */
  setLiveWriter = (live: ((scene: Scene) => void) | null): void => {
    this.live = live;
  };

  /** Whether a gesture bracket is open — the presence sampler's cue. */
  gesturing = (): boolean => this.depth > 0;

  private historyListeners = new Set<(event: SceneHistoryEvent) => void>();
  /** Every change to the history ledger, as it happens. */
  onHistory = (fn: (event: SceneHistoryEvent) => void): (() => void) => {
    this.historyListeners.add(fn);
    return () => this.historyListeners.delete(fn);
  };

  private emitHistory(event: SceneHistoryEvent): void {
    for (const fn of this.historyListeners) fn(event);
  }

  private beforeStep = new Set<() => void>();
  /**
   * Runs at the top of {@link undo} and {@link redo}, before the depth check —
   * the chance for an idle-held bracket (a panel's typing run) to settle so
   * the step is not refused for a gesture that already ended. A live pointer
   * gesture deliberately does not settle: undo mid-drag stays refused.
   */
  onBeforeStep = (fn: () => void): (() => void) => {
    this.beforeStep.add(fn);
    return () => this.beforeStep.delete(fn);
  };

  /**
   * Hook the selection into history, so undo and redo rewind it alongside the
   * scene. `null` unhooks; without it every entry simply has no selection and
   * history behaves exactly as it did before.
   */
  setSelectionHistory = (selection: SelectionHistory | null): void => {
    this.selection = selection;
  };

  // -- Reading --------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The whole scene. Its identity changes on every edit — prefer
   *  {@link getNode} where it will do. */
  getScene = (): Scene => this.scene;

  /** The node with this id at any depth, or `null` once it is gone. */
  getNode = (id: NodeId): SceneNode | null => {
    if (!this.index) {
      const index = new Map<NodeId, SceneNode>();
      walk(this.scene.nodes, (node) => {
        index.set(node.id, node);
      });
      this.index = index;
    }
    return this.index.get(id) ?? null;
  };

  canUndo = (): boolean => this.past.length > 0;

  canRedo = (): boolean => this.future.length > 0;

  // -- Writing --------------------------------------------------------------

  /** Apply one op, or a group of ops that must land together. */
  dispatch = (op: SceneOp | readonly SceneOp[]): void => {
    const ops: readonly SceneOp[] = Array.isArray(op) ? op : [op];
    if (ops.length === 0) return;
    const before = this.scene;
    const next = applyOps(before, ops);
    if (next === before) return;
    if (this.depth === 0) this.record(before, this.captureSelection());
    this.recordOps(ops);
    this.future = [];
    this.setScene(next, true);
    for (const o of ops) {
      if (o.type === "insert") {
        for (const node of o.nodes) {
          track("canvas_shape_added", { kind: node.kind });
        }
      } else if (o.type === "addEdge") {
        track("canvas_edge_connected", {});
      }
    }
  };

  /** Open a gesture: everything until the matching `commit` is one entry. */
  begin = (): void => {
    if (this.depth === 0) {
      this.gestureBefore = this.scene;
      this.gestureSelection = this.captureSelection();
    }
    this.depth += 1;
  };

  /**
   * Log ops for a bug report, at the granularity of one thing the user did.
   *
   * Inside a gesture they are buffered and flushed at `commit`, the same way
   * history brackets an interaction — a slider dragged across a range is one
   * entry, not eighty. Ops the AI applied are already logged by `applyBatch`,
   * so they are skipped here rather than counted twice. (A scene arriving from
   * another tab needs no guard: `adopt` writes through `setScene`, never here.)
   */
  private recordOps(ops: readonly SceneOp[]): void {
    if (isApplyingAi()) return;
    if (this.depth > 0) {
      this.gestureOps.push(...ops);
      return;
    }
    for (const op of ops) pushHumanOp(op);
  }

  commit = (): void => {
    if (this.depth === 0) return;
    this.depth -= 1;
    if (this.depth > 0) return;

    const before = this.gestureBefore;
    const selection = this.gestureSelection;
    this.gestureBefore = null;
    this.gestureSelection = null;
    if (before && before !== this.scene) this.record(before, selection);

    if (this.gestureOps.length) {
      // The gesture's ops describe one action; the first is what names it.
      pushHumanOp(
        this.gestureOps.length === 1
          ? this.gestureOps[0]
          : { gesture: this.gestureOps[0].type, ops: this.gestureOps.length },
      );
      this.gestureOps = [];
    }

    const source = this.pendingSource;
    if (source !== null) {
      const remote = this.pendingRemote;
      this.pendingSource = null;
      this.pendingRemote = false;
      if (remote) this.adoptRemote(source);
      else this.adopt(source);
    }
  };

  /**
   * Make a selection change undoable in its own right, given a thunk restoring
   * what was selected before it. Called by the selection store; a selection
   * that is a *consequence* of an edit never gets here, because:
   *
   * - inside a gesture the gesture's own entry already carries the selection;
   * - in the same task as an edit the selection belongs to that edit — an
   *   insert selects what it inserted, a delete clears what it removed — and
   *   the edit's entry already restores the selection from before it;
   * - consecutive selection steps collapse, so a marquee drag emitting one per
   *   frame, or five clicks in a row, cost a single entry.
   */
  recordSelection = (restore: RestoreSelection): void => {
    if (this.depth > 0 || this.justEdited) return;
    const top = this.past[this.past.length - 1];
    if (top?.selectionOnly && top.scene === this.scene) return;
    this.push({ scene: this.scene, selection: restore, selectionOnly: true });
    // Deliberately keeps `future`: selecting something is not an edit, and
    // clicking around after an undo must not throw away the redo.
    this.notify();
  };

  /** False when refused (mid-gesture) or when there was nothing to step. */
  undo = (): boolean => {
    for (const fn of this.beforeStep) fn();
    if (this.depth > 0) return false;
    return this.step(this.past, this.future);
  };

  redo = (): boolean => {
    for (const fn of this.beforeStep) fn();
    if (this.depth > 0) return false;
    return this.step(this.future, this.past);
  };

  // -- Persistence ----------------------------------------------------------

  /**
   * Reconcile the block's `source`. Our own writes are recognised and ignored;
   * anything else replaces the scene. A change that lands mid-gesture waits for
   * the gesture to end rather than pulling the tree out from under it.
   */
  setSource = (source: string): void => {
    if (source === this.lastSource) return;
    if (this.depth > 0) {
      this.pendingSource = source;
      this.pendingRemote = false;
      return;
    }
    this.adopt(source);
  };

  /**
   * Reconcile a COLLABORATOR's merged edit, from the CRDT binding. Unlike
   * {@link setSource} it is not undoable — undoing someone else's work is not
   * an answer ⌘Z should ever give — and local history that predates it cannot
   * honestly be restored either, because a snapshot restore would revert their
   * merged changes along with ours. It resets instead: the cost of concurrent
   * edits on one diagram is a fresh undo horizon, never a reverted teammate.
   */
  adoptRemote = (source: string): void => {
    if (source === this.lastSource) return;
    if (this.depth > 0) {
      this.pendingSource = source;
      this.pendingRemote = true;
      return;
    }
    this.lastSource = source;
    this.cancelPersist();
    this.dirty = false;
    this.past = [];
    this.future = [];
    this.emitHistory({ type: "clear" });
    this.setScene(migrateLegacyCanvas(source), false);
  };

  /**
   * The source a REVIVED store's surface should be seeded with — what this
   * store last knew the block to say. Seeding a remount with anything else
   * would make `setSource` read the drift as an external edit and record a
   * history entry nobody made.
   */
  seedSource = (): string => this.lastSource;

  /** Write now, if there is anything unwritten. */
  flush = (): void => {
    this.cancelPersist();
    if (!this.dirty) return;
    this.dirty = false;
    const html = serializeScene(this.scene);
    if (html === this.lastSource) return;
    this.lastSource = html;
    this.write(html, this.scene);
  };

  dispose = (): void => {
    try {
      this.flush();
    } catch {
      // Unmount is also how a block is deleted, and writing to a block that is
      // already gone throws. Its content no longer matters; the edits made in
      // the last 500ms before a page switch do.
    }
    this.listeners.clear();
  };

  // -- Internals ------------------------------------------------------------

  /**
   * One move along the history, in either direction: the state we are leaving
   * becomes the other stack's next entry, so redo restores the selection an
   * undone change had left behind.
   */
  private step(from: HistoryEntry[], to: HistoryEntry[]): boolean {
    const entry = from.pop();
    if (!entry) return false;
    to.push({
      scene: this.scene,
      selection: this.captureSelection(),
      selectionOnly: entry.selectionOnly,
    });
    // A selection-only entry leaves the scene alone; it still notifies, since
    // `canUndo` and `canRedo` have moved.
    this.setScene(entry.scene, entry.scene !== this.scene);
    entry.selection?.();
    return true;
  }

  private setScene(scene: Scene, persist: boolean): void {
    this.scene = scene;
    this.index = null;
    if (persist) {
      this.dirty = true;
      this.cancelPersist();
      this.timer = setTimeout(this.flush, PERSIST_MS);
      this.live?.(scene);
    }
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private adopt(source: string): void {
    this.lastSource = source;
    // Their write supersedes ours: a pending debounce would put the scene they
    // replaced straight back.
    this.cancelPersist();
    this.dirty = false;
    this.record(this.scene, this.captureSelection());
    this.future = [];
    this.setScene(migrateLegacyCanvas(source), false);
  }

  private captureSelection(): RestoreSelection | null {
    return this.selection?.capture() ?? null;
  }

  private record(scene: Scene, selection: RestoreSelection | null): void {
    this.push({ scene, selection, selectionOnly: false });
    if (this.justEdited) return;
    this.justEdited = true;
    // A selection made in the same task as an edit is the edit's own doing, and
    // no user gesture shares a task with the one before it.
    queueMicrotask(() => {
      this.justEdited = false;
    });
  }

  private push(entry: HistoryEntry): void {
    this.past.push(entry);
    this.emitHistory({ type: "push", selectionOnly: entry.selectionOnly });
    if (this.past.length > MAX_HISTORY) {
      this.past.shift();
      this.emitHistory({ type: "trim" });
    }
  }

  private cancelPersist(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

export interface UseSceneOptions {
  /** The canvas block's persisted string — canvas HTML, or legacy JSON. */
  source: string;
  /** Persists a new source onto the block, with the scene it came from. */
  onChange: (source: string, scene: Scene) => void;
  /**
   * Keeps the store — and with it the undo history — alive across unmounts,
   * shared under this key. Without one, a page switch was a fresh undo
   * horizon for every diagram on it; with one, coming back resumes where the
   * history left off. The workspace history spine depends on this: its
   * tokens outlive the page, so the entries behind them must too.
   */
  cacheKey?: string;
}

/** Stores kept warm for closed pages, bounded like the doc cache is. */
const WARM_MAX = 16;
const warm = new Map<string, SceneStore>();

/** The warm store under this key, if one is held — how a remount seeds its
 *  surface with what the store already knows. */
export function peekSceneStore(cacheKey: string): SceneStore | null {
  return warm.get(cacheKey) ?? null;
}

/**
 * The store for one canvas block. Parsed once, from whichever format the block
 * was written in; written back on a 500ms debounce.
 */
export function useScene({ source, onChange, cacheKey }: UseSceneOptions): SceneStore {
  const [store] = useState(() => {
    const held = cacheKey ? warm.get(cacheKey) : null;
    if (held) {
      // Move-to-back: the eviction order is least recently mounted.
      warm.delete(cacheKey!);
      warm.set(cacheKey!, held);
      return held;
    }
    const made = new SceneStore(source);
    if (cacheKey) {
      warm.set(cacheKey, made);
      for (const [oldest, old] of warm) {
        if (warm.size <= WARM_MAX) break;
        warm.delete(oldest);
        old.dispose();
      }
    }
    return made;
  });

  useEffect(() => {
    store.setWriter(onChange);
  });

  // Not derived state: `source` is an input the store reconciles against, and
  // it no-ops on the writes we made ourselves.
  useEffect(() => {
    store.setSource(source);
  }, [store, source]);

  // A cached store still flushes and lets its subscribers go on unmount —
  // dispose leaves the store itself intact, so reviving it is just mounting.
  useEffect(() => () => store.dispose(), [store]);

  return store;
}

/** The whole scene. Re-renders on every edit — the surface's own hook. */
export function useSceneSnapshot(store: SceneStore): Scene {
  return useSyncExternalStore(store.subscribe, store.getScene, store.getScene);
}

/** Whether undo and redo have anything to do, as reactive state. */
export function useSceneHistory(store: SceneStore): {
  canUndo: boolean;
  canRedo: boolean;
} {
  const canUndo = useSyncExternalStore(
    store.subscribe,
    store.canUndo,
    store.canUndo,
  );
  const canRedo = useSyncExternalStore(
    store.subscribe,
    store.canRedo,
    store.canRedo,
  );
  return useMemo(() => ({ canUndo, canRedo }), [canUndo, canRedo]);
}
