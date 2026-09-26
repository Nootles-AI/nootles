"use client";

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { Pane } from "@/app/components/OpenPageContext";
import type { BlockSelectionStore } from "@/app/components/editor/blockSelection";
import type { LiveEditor } from "@/app/components/editor/EditorRegistry";
import { setFitFrozen } from "@/app/lib/columnScale";
import type { SceneStore } from "../engine/useScene";
import { selectionFrame, type SelectionStore } from "../engine/useSelection";
import type { CanvasApi } from "../render/CanvasSurface";
import type { RotatedRect } from "../scene/geometry";
import { createPageGesture, type PageGesture } from "./pageGesture";
import { attachPageDraw } from "./pageDraw";
import { attachPageKeymap } from "./pageKeymap";
import {
  createPageSelection,
  EMPTY_PAGE_SELECTION,
  type PageSelection,
} from "./pageSelection";
import { createPageTools, type PageToolControl } from "./tools";

/**
 * The screen's canvas chrome. A press in it is not a press outside the
 * diagrams: the panels speak for them, the menus are portalled to the body but
 * belong to a control or a label being edited, and the rails' edges and resize
 * handles are adjusting the panels, not leaving. The split between two pages
 * (`.is-gap`) is the document's.
 */
export const CANVAS_CHROME =
  ".nt-lyr, .nt-style-panel, .nt-toolbar, .nt-ctx, .nt-mention-anchor, .nt-menu, " +
  ".nt-rail-slot, .nt-resize:not(.is-gap)";

/** One diagram on the page, as the pane knows it. */
export type DiagramEntry = {
  blockId: string;
  api: CanvasApi;
  readOnly: boolean;
  /** Puts the diagram's latest onto its block prop now, not on the mirror's trail. */
  flushMirror(): void;
  /** Takes the block out of the document in one step. */
  remove(): void;
  /** The page's block selection — where the diagram goes when Escape leaves it. */
  blocks: BlockSelectionStore;
};

/** A diagram holding part of the page's selection, and its own store of it. */
export type DiagramTarget = {
  blockId: string;
  store: SceneStore;
  /** The diagram's own selection, not the page's facade over it. */
  selection: SelectionStore;
  entry: DiagramEntry;
};

/**
 * The diagrams of one pane's page, and what they share: the tool, the
 * selection, one undo step for an edit that spans several of them. One per
 * pane rather than per page, since both panes can show the same page.
 */
export interface PageCanvas {
  readonly pane: Pane | null;
  readonly pageId: string | null;
  /** Null outside a workspace — the share route, a harness — and for a viewer, whose keys it never hears. */
  readonly tools: PageToolControl | null;
  readonly selection: PageSelection;
  /** Moves, resizes, rotations and marquees that reach across diagrams. */
  readonly gesture: PageGesture;
  /** Every diagram holding part of the selection, in document order. */
  targets(): DiagramTarget[];
  /**
   * The frame around a selection spanning several diagrams, in this one's px;
   * `null` while the selection is one diagram's or none. The same object
   * until it moves, so it can be a `useSyncExternalStore` snapshot.
   */
  frameIn(blockId: string): RotatedRect | null;
  subscribeFrame(listener: () => void): () => void;
  register(entry: DiagramEntry): () => void;
  get(blockId: string): DiagramEntry | undefined;
  /** In document order. */
  entries(): DiagramEntry[];
  whenRegistered(blockId: string, ms?: number): Promise<DiagramEntry | null>;
  /** What a focus restore asks for: this diagram, in view. */
  focus(blockId: string): void;
  batch<T>(fn: () => T): T;
  /** Whether a pointer pressed on one of the diagrams is still down. */
  pressing(): boolean;
  /** A storyboard's shot holds the screen: the page's tool keys stand down. */
  framed(): boolean;
  /** The page's editor, which a draw on the page makes its diagrams in. */
  editor(): LiveEditor | null;
  setEditor(editor: LiveEditor | null): () => void;
  /** × on the seam between two diagrams: no Merge offered for that pair until the page reopens. */
  dismissMerge(upper: string, lower: string): void;
  mergeDismissed(upper: string, lower: string): boolean;
  /**
   * The pane is on screen: what listens on its behalf — the keymap, the press
   * outside every diagram — starts here, and stops with the returned call.
   */
  attach(pane: HTMLElement): () => void;
}

export type HubSnapshot = {
  readonly pane: Pane | null;
  readonly focused: { readonly pageId: string; readonly blockId: string } | null;
};

/**
 * The workspace's half: the one tool, the panes, and which diagram the screen
 * is speaking for. Its snapshot is coarse on purpose — it moves when focus
 * moves to another diagram or away, never on a click inside the one focused —
 * because the whole workspace re-renders on it.
 */
export interface PageCanvasHub {
  readonly tools: PageToolControl | null;
  batch<T>(fn: () => T): T;
  quiet(): boolean;
  /** Whether a storyboard's shot holds the screen. */
  framed(): boolean;
  /** Who answers {@link framed}; returns how to stop. */
  setFramed(held: () => boolean): () => void;
  addPane(canvas: PageCanvas): () => void;
  pane(pane: Pane): PageCanvas | null;
  clearAll(): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): HubSnapshot;
}

type Deps = { batch<T>(fn: () => T): T; quiet?: () => boolean };

const identity = <T,>(fn: () => T): T => fn();
const never = () => false;
const noop = () => {};
const nothing = () => null;

function sameFrame(a: RotatedRect | null, b: RotatedRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.rot === b.rot;
}
const NOTHING_HELD: HubSnapshot = { pane: null, focused: null };

const byDocument = (a: DiagramEntry, b: DiagramEntry) => {
  const x = a.api.band.current;
  const y = b.api.band.current;
  if (!x || !y || x === y) return 0;
  return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
};

export function createPageCanvas({
  pane,
  pageId,
  tools,
  batch,
  quiet,
  framed = never,
}: Deps & {
  pane: Pane;
  pageId: string;
  tools: PageToolControl | null;
  framed?: () => boolean;
}): PageCanvas {
  const registry = new Map<string, DiagramEntry>();
  let editor: LiveEditor | null = null;
  const dismissed = new Set<string>();
  const waiting = new Map<string, Set<(entry: DiagramEntry) => void>>();
  const selection = createPageSelection({
    batch,
    quiet,
    geometry: {
      bounds: (blockId, ids) => {
        const entry = registry.get(blockId);
        return entry ? selectionFrame(entry.api.store.getScene(), ids) : null;
      },
      toClient: (blockId, point) => registry.get(blockId)?.api.viewport.sceneToClient(point) ?? point,
      toScene: (blockId, point) => registry.get(blockId)?.api.viewport.clientToScene(point) ?? point,
    },
  });
  const entries = () => [...registry.values()].sort(byDocument);
  const gesture = createPageGesture({ entries, selection, batch });
  let pressed = false;

  // The frame around a selection spanning diagrams moves when any of them
  // changes, and when the text between them reflows — so while there is one,
  // and someone is drawing it, the stores and the editor are watched.
  const frameListeners = new Set<() => void>();
  const frames = new Map<string, { version: number; frame: RotatedRect | null }>();
  let version = 0;
  let watching: (() => void) | null = null;
  const spanning = () => {
    let holding = 0;
    for (const part of selection.getSnapshot().parts.values()) if (part.ids.length) holding++;
    return holding > 1;
  };
  const bump = () => {
    version++;
    for (const listener of frameListeners) listener();
  };
  const rewatch = (force = false) => {
    const wanted = frameListeners.size > 0 && spanning();
    if (!force && wanted === (watching !== null)) return;
    watching?.();
    watching = null;
    if (!wanted) return;
    const offs = [...registry.values()].map((entry) => entry.api.store.subscribe(bump));
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(bump);
    const roots = new Set<Element>();
    for (const entry of registry.values()) {
      const band = entry.api.band.current;
      const root = band?.closest(".bn-editor") ?? band;
      if (root) roots.add(root);
    }
    for (const root of roots) observer?.observe(root);
    watching = () => {
      for (const off of offs) off();
      observer?.disconnect();
    };
  };
  selection.subscribe(() => {
    rewatch();
    bump();
  });

  const canvas: PageCanvas = {
    pane,
    pageId,
    tools,
    selection,
    gesture,
    batch,
    register: (entry) => {
      registry.set(entry.blockId, entry);
      const detach = selection.attach(entry.blockId, entry.api.ownSelection);
      const woken = waiting.get(entry.blockId);
      waiting.delete(entry.blockId);
      for (const wake of woken ?? []) wake(entry);
      if (watching) rewatch(true);
      return () => {
        detach();
        if (registry.get(entry.blockId) === entry) registry.delete(entry.blockId);
        if (watching) rewatch(true);
      };
    },
    get: (blockId) => registry.get(blockId),
    entries,
    targets: () => {
      const parts = selection.getSnapshot().parts;
      return entries()
        .filter((entry) => parts.has(entry.blockId))
        .map((entry) => ({
          blockId: entry.blockId,
          store: entry.api.store,
          selection: entry.api.ownSelection,
          entry,
        }));
    },
    frameIn: (blockId) => {
      if (!spanning()) return null;
      const held = frames.get(blockId);
      if (held?.version === version) return held.frame;
      const next = selection.unionIn(blockId);
      const frame = held && sameFrame(held.frame, next) ? held.frame : next;
      frames.set(blockId, { version, frame });
      return frame;
    },
    subscribeFrame: (listener) => {
      frameListeners.add(listener);
      rewatch();
      return () => {
        frameListeners.delete(listener);
        rewatch();
      };
    },
    whenRegistered: (blockId, ms = 1500) => {
      const held = registry.get(blockId);
      if (held) return Promise.resolve(held);
      return new Promise((resolve) => {
        const wake = (entry: DiagramEntry | null) => {
          clearTimeout(timer);
          waiting.get(blockId)?.delete(wake);
          resolve(entry);
        };
        const timer = setTimeout(() => wake(null), ms);
        const set = waiting.get(blockId) ?? new Set();
        set.add(wake);
        waiting.set(blockId, set);
      });
    },
    focus: (blockId) => {
      selection.focus(blockId);
      registry.get(blockId)?.api.band.current?.scrollIntoView?.({ block: "nearest" });
    },
    pressing: () => pressed,
    framed,
    editor: () => editor,
    setEditor: (next) => {
      editor = next;
      return () => {
        if (editor === next) editor = null;
      };
    },
    dismissMerge: (upper, lower) => void dismissed.add(`${upper}>${lower}`),
    mergeDismissed: (upper, lower) => dismissed.has(`${upper}>${lower}`),
    attach: (paneEl) => {
      // One listener for every diagram in the pane: a press outside all of
      // them lets the page's selection go, batched, where a listener per
      // diagram cleared each on its own. A press on one is the diagram's to
      // read — it may be the start of a drag of shapes in several — and holds
      // the page's fit still until it lets go, so a rail opening on the
      // selection it makes cannot rescale the band under the pointer.
      const onDown = (event: PointerEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if ([...registry.values()].some((e) => e.api.band.current?.contains(target))) {
          pressed = true;
          setFitFrozen(true);
          return;
        }
        if (selection.getSnapshot().parts.size === 0) return;
        if (!target.closest(CANVAS_CHROME)) selection.clearAll();
      };
      const onUp = () => {
        if (!pressed) return;
        pressed = false;
        setFitFrozen(false);
      };
      document.addEventListener("pointerdown", onDown, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onUp, true);
      const detachKeys = attachPageKeymap(canvas, paneEl);
      const detachDraw = attachPageDraw(canvas, paneEl);
      return () => {
        detachKeys();
        detachDraw();
        document.removeEventListener("pointerdown", onDown, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onUp, true);
        onUp();
      };
    },
  };
  return canvas;
}

export function createPageCanvasHub({ batch, quiet = never }: Deps): PageCanvasHub {
  let held: () => boolean = never;
  const tools = createPageTools();
  const panes = new Map<Pane, PageCanvas>();
  const focusedIn = new Map<Pane, string | null>();
  /** The pane whose focus arrived last, which the snapshot names while it lasts. */
  let lead: Pane | null = null;
  let snapshot = NOTHING_HELD;
  const listeners = new Set<() => void>();

  const publish = () => {
    const holding = (p: Pane | null) => (p ? (panes.get(p)?.selection.getSnapshot().focused ?? null) : null);
    const pane = holding(lead) ? lead : ([...panes.keys()].find((p) => holding(p)) ?? null);
    const canvas = pane ? panes.get(pane)! : null;
    const blockId = holding(pane);
    const next: HubSnapshot =
      canvas && blockId && canvas.pageId ? { pane, focused: { pageId: canvas.pageId, blockId } } : NOTHING_HELD;
    if (
      next.pane === snapshot.pane &&
      next.focused?.blockId === snapshot.focused?.blockId &&
      next.focused?.pageId === snapshot.focused?.pageId
    ) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const clearAll = () => batch(() => panes.forEach((canvas) => canvas.selection.clearAll()));

  return {
    tools,
    batch,
    quiet,
    framed: () => held(),
    setFramed: (next) => {
      held = next;
      return () => {
        if (held === next) held = never;
      };
    },
    addPane: (canvas) => {
      const pane = canvas.pane!;
      panes.set(pane, canvas);
      focusedIn.set(pane, null);
      const off = canvas.selection.subscribe(() => {
        const focused = canvas.selection.getSnapshot().focused;
        const was = focusedIn.get(pane) ?? null;
        focusedIn.set(pane, focused);
        if (focused && focused !== was) {
          lead = pane;
          if (!quiet()) {
            // Inside the batch the selection that caused this is closing, so
            // whatever the other pane records joins its step.
            batch(() => {
              panes.forEach((other, p) => p !== pane && other.selection.clearAll());
              publish();
            });
            return;
          }
        }
        publish();
      });
      publish();
      return () => {
        off();
        if (panes.get(pane) !== canvas) return;
        panes.delete(pane);
        focusedIn.delete(pane);
        if (lead === pane) lead = null;
        publish();
      };
    },
    pane: (pane) => panes.get(pane) ?? null,
    clearAll,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  };
}

const NO_SELECTION: PageSelection = {
  subscribe: () => noop,
  getSnapshot: () => EMPTY_PAGE_SELECTION,
  attach: () => noop,
  facade: (_blockId, raw) => raw,
  selectIn: noop,
  marqueeIn: noop,
  clearAll: noop,
  keep: (fn) => fn(),
  focus: noop,
  count: () => 0,
  unionIn: nothing,
};

const NO_GESTURE: PageGesture = {
  spans: never,
  start: never,
  resetRotation: never,
  didDrag: never,
  cancel: noop,
  marquee: noop,
};

/** A diagram outside any workspace — the share route, a harness — stands alone. */
export const NO_PAGE_CANVAS: PageCanvas = {
  pane: null,
  pageId: null,
  tools: null,
  selection: NO_SELECTION,
  gesture: NO_GESTURE,
  targets: () => [],
  frameIn: nothing,
  subscribeFrame: () => noop,
  register: () => noop,
  get: () => undefined,
  entries: () => [],
  whenRegistered: () => Promise.resolve(null),
  focus: noop,
  batch: identity,
  pressing: never,
  framed: never,
  editor: nothing,
  setEditor: () => noop,
  dismissMerge: noop,
  mergeDismissed: never,
  attach: () => noop,
};

const NO_HUB: PageCanvasHub = {
  tools: null,
  batch: identity,
  quiet: never,
  framed: never,
  setFramed: () => noop,
  addPane: () => noop,
  pane: () => null,
  clearAll: noop,
  subscribe: () => noop,
  getSnapshot: () => NOTHING_HELD,
};

export const PageCanvasHubContext = createContext<PageCanvasHub>(NO_HUB);
export const PageCanvasContext = createContext<PageCanvas>(NO_PAGE_CANVAS);

export const usePageCanvas = (): PageCanvas => useContext(PageCanvasContext);
export const usePageCanvasHub = (): PageCanvasHub => useContext(PageCanvasHubContext);

export function useHubSnapshot(hub: PageCanvasHub): HubSnapshot {
  return useSyncExternalStore(hub.subscribe, hub.getSnapshot, hub.getSnapshot);
}

/**
 * The pane's controller, for as long as it shows this page, joined to the hub;
 * outside a workspace it is the stand-alone default. The pane element attaches
 * it (see `PagePane`).
 */
export function usePaneCanvas(pane: Pane, pageId: string, readOnly = false): PageCanvas {
  const hub = usePageCanvasHub();
  const canvas = useMemo(
    () =>
      hub.tools
        ? createPageCanvas({
            pane,
            pageId,
            tools: readOnly ? null : hub.tools,
            batch: hub.batch,
            quiet: hub.quiet,
            framed: hub.framed,
          })
        : NO_PAGE_CANVAS,
    [hub, pane, pageId, readOnly],
  );
  useEffect(() => {
    if (!canvas.pane) return;
    return hub.addPane(canvas);
  }, [hub, canvas]);
  return canvas;
}
