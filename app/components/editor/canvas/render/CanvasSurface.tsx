"use client";

/**
 * The canvas block, assembled.
 *
 * One clipping viewport, one transformed layer inside it holding every shape
 * and the overlay, and the engine hooks wired to both. Everything that changes
 * per frame — pan, zoom, drag, resize, rotate, marquee, drawing — is written
 * straight to the DOM by the module that owns it; this component re-renders
 * only when the scene, the selection or the tool actually changes.
 *
 * Three things live here and nowhere else: the active tool, which every other
 * module reads; which label is open for editing, since a new shape must open
 * its own; and the block's own source — `SceneOp` addresses nodes, so the
 * diagram's width, height and background are not ops but a re-serialized scene
 * written back onto the block, which the store then adopts.
 *
 * The panels and the toolbar are *not* rendered here. They belong to the
 * screen, not to a 600px column of a document, so the canvas publishes
 * {@link CanvasApi} instead and the shell mounts them.
 *
 * ## Two scenes, and which question each one answers
 *
 * `scene` is the model. A node an auto-layout group places does not keep its
 * position there — the flow decides it, and the model's `x`/`y` is whatever it
 * last happened to be. So the model answers exactly one question: what to
 * render. The browser lays the shapes out from it, which is the point.
 *
 * `laid` — `laidOutScene(scene)` — answers every other one. Where is this
 * shape, what is under this point, what does this connector attach to, how big
 * is the content. Asking the model any of those reads a stale number: a child
 * duplicated into a laid-out group renders where the flow puts it and hit-tests
 * where the model left it, so double-click finds nothing there and the group
 * answers instead.
 *
 * The rule, then: **render from `scene`, measure and hit-test `laid`.** It is
 * free to take — `laidOutScene` memoises on the scene object — so there is no
 * reason to reach for the model and no excuse for the two to drift again.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { useContextMenu } from "../ContextMenu";
import { ConnectorTool } from "./ConnectorTool";
import { EdgeLayer } from "./EdgeLayer";
import {
  prepareObstacles,
  reflowEdges,
  type EdgeElements,
  type LiveObstacles,
} from "./liveEdges";
import { useTransformGesture } from "../engine/gestures";
import { useCanvasShortcuts, type CanvasTool } from "../engine/shortcuts";
import type { SnapGuide } from "../engine/snapping";
import { useScene, useSceneSnapshot, type SceneStore } from "../engine/useScene";
import {
  descends,
  useSelection,
  useSelectionStore,
  type ClickMods,
  type SelectionStore,
} from "../engine/useSelection";
import { useViewport, type ViewportController } from "../engine/useViewport";
import type { DiagramPatch } from "../panels/StylePanel";
import {
  absoluteBounds,
  absoluteSelectionBounds,
  hitTestPath,
  normalizeRect,
  type RotatedRect,
} from "../scene/geometry";
import { laidOutScene } from "../scene/autoLayout";
import { mintId } from "../scene/ops";
// A leaf module of pure constants — no cycle, though the surface knows nothing
// else about storyboards.
import type { Ratio } from "../../storyboard/types";
import {
  findNode,
  nodePath,
  walk,
  type NodeId,
  type Point,
  type Rect,
  type EdgeId,
  type Scene,
  type StylePatch,
} from "../scene/types";
import {
  CANVAS_MIN_H,
  CANVAS_MIN_W,
  FIXED,
  HEIGHT_ATTR,
  WIDTH_ATTR,
  sceneBlockHeight,
} from "../types";
import { defaultBox, newNode, type DrawKind } from "./newShape";
import { Overlay, type OverlayApi } from "./Overlay";
import { shapeWriter, type ShapeWriter } from "./svgShape";
import { PenTool } from "./PenTool";
import { ShapeView, toCss } from "./ShapeView";
import "../canvas.css";

/** Kept clear either side, so a widened block cannot reach the window's edge. */
const CANVAS_GUTTER = 32;

/** The screen's canvas chrome. A press in it is not a press outside the canvas.
 *  The mention menu is portalled to the body but speaks for a label being
 *  edited here, so a press on it is part of the edit, not a press outside. */
const CANVAS_CHROME = ".nt-lyr, .nt-style-panel, .nt-toolbar, .nt-ctx, .nt-mention-anchor";

/** Scene px below which a drag was a click, and the shape takes its own size. */
const DRAWN_MIN = 2;

const NO_GUIDES: readonly SnapGuide[] = [];
const NO_MEMBERS: readonly RotatedRect[] = [];

/**
 * A pointer drag, batched to one callback per animation frame however fast the
 * events arrive. Shared by the marquee, the drawing tools, the hand tool and
 * the height grip — the four gestures the engine does not already own.
 */
function drag(
  onMove: (event: PointerEvent) => void,
  onEnd: (event: PointerEvent) => void,
): void {
  let latest: PointerEvent | null = null;
  let frame = 0;

  const flush = () => {
    frame = 0;
    if (latest) onMove(latest);
  };
  const move = (event: PointerEvent) => {
    latest = event;
    if (!frame) frame = requestAnimationFrame(flush);
  };
  const up = (event: PointerEvent) => {
    if (frame) cancelAnimationFrame(frame);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    onEnd(event);
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

/** A style patch straight onto an element — kebab-case and custom properties. */
function writeStyle(style: CSSStyleDeclaration | undefined, decls: StylePatch) {
  if (!style) return;
  for (const prop in decls) {
    const value = decls[prop];
    if (value === undefined) style.removeProperty(prop);
    else style.setProperty(prop, value);
  }
}

/** The widest the block may be drawn without escaping the document's scroller. */
function maxWidth(el: HTMLElement): number {
  const room = el.closest("main")?.clientWidth ?? window.innerWidth;
  return Math.max(CANVAS_MIN_W, room - CANVAS_GUTTER);
}

/** The corner that makes a drag from `origin` square — Shift, while drawing. */
function evenCorner(origin: Point, point: Point): Point {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: origin.x + Math.sign(dx) * side, y: origin.y + Math.sign(dy) * side };
}

// ---------------------------------------------------------------------------
// Finding the content again
// ---------------------------------------------------------------------------

/**
 * How much of the smaller of the content and the viewport has to be on screen
 * before the diagram counts as found. Taking the smaller is what makes one
 * threshold answer both ways of losing it: panned off, the content is what is
 * missing; zoomed deep into a gap, the viewport is.
 */
const IN_VIEW = 0.06;

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Every visible shape, unioned — the box the fit frames, and the same box the
 * wheel asks about before it decides a pan has nothing left to reveal.
 */
function contentRect(model: Scene): Rect {
  const scene = laidOutScene(model);
  return absoluteSelectionBounds(
    scene,
    scene.nodes.filter((node) => !node.hidden).map((node) => node.id),
  );
}

/** The part of the scene the container is showing, in scene px. */
function visibleRect(viewport: ViewportController): Rect | null {
  const el = viewport.containerRef.current;
  if (!el || el.clientWidth <= 0 || el.clientHeight <= 0) return null;
  const { x, y, zoom } = viewport.get();
  return {
    x: -x / zoom,
    y: -y / zoom,
    w: el.clientWidth / zoom,
    h: el.clientHeight / zoom,
  };
}

const FIT_ICON = (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.9"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3" />
  </svg>
);

const NEVER = () => false;

/**
 * The way back when the diagram is off screen — panned past, or zoomed into a
 * gap between shapes.
 *
 * It answers from the model: the shapes' own boxes against the rect the
 * container is showing. The snapshot is a boolean, so panning re-renders
 * nothing at all until the answer actually flips.
 */
function Refit({
  viewport,
  bounds,
  onFrame,
}: {
  viewport: ViewportController;
  bounds: readonly Rect[];
  onFrame: () => void;
}) {
  const lost = useCallback(() => {
    if (bounds.length === 0) return false;
    const view = visibleRect(viewport);
    if (!view) return false;
    let shown = 0;
    let content = 0;
    for (const box of bounds) {
      shown += overlapArea(box, view);
      content += box.w * box.h;
    }
    return shown < IN_VIEW * Math.min(content, view.w * view.h);
  }, [bounds, viewport]);

  const offscreen = useSyncExternalStore(viewport.subscribe, lost, NEVER);
  if (!offscreen) return null;

  return (
    <button
      type="button"
      className="nt-canvas-refit"
      // The canvas keeps its focus, and with it the keymap and the clipboard.
      onPointerDown={(event) => event.preventDefault()}
      onClick={onFrame}
    >
      {FIT_ICON}
      {/* Not "zoom to fit": this only appears when the diagram is off screen,
          and what the user wants back is the content, not a zoom level. */}
      Show content
    </button>
  );
}

/**
 * The active tool, as an external store.
 *
 * A value would have to live on {@link CanvasApi}, and the api is published to
 * the shell — so every R, O or L would be a top-level state change re-rendering
 * the whole workspace to move a pressed state in the toolbar. Whoever draws the
 * tool subscribes to it instead, and the api keeps its identity for the life of
 * the canvas.
 */
export interface ToolControl {
  get(): CanvasTool;
  set(tool: CanvasTool): void;
  subscribe(listener: () => void): () => void;
}

/**
 * How the screen reaches one canvas: the stores for the panels, the viewport
 * and the tool for the toolbar, and the one write that is not an op.
 */
export interface CanvasApi {
  store: SceneStore;
  selection: SelectionStore;
  viewport: ViewportController;
  tools: ToolControl;
  setTool(tool: CanvasTool): void;
  /** The diagram's own fields — `StylePanel`'s `onDiagramChange`. */
  setDiagram(patch: DiagramPatch): void;
  /**
   * Show a width and/or height on the block without committing it, so a scrub
   * of the panel's W/H previews every frame. Written straight to the element,
   * exactly as the grips do; the axes left out are untouched. Land it with
   * {@link setDiagram}, which is what React then renders from.
   */
  previewSize(size: { w?: number; h?: number }): void;
  /**
   * The same, for the diagram's own declarations — its background, its colour
   * variables. Written straight onto the viewport element, so a drag in the
   * panel's picker previews without re-serializing and re-parsing the block;
   * land it with {@link setDiagram}.
   */
  previewStyle(decls: StylePatch): void;
  /**
   * The board this canvas is a shot of, or absent on a canvas that stands on
   * its own.
   *
   * A canvas knows nothing about storyboards and never sets this — the board's
   * container attaches it to whichever shot's api it publishes, so the one
   * toolbar can carry the board's controls beside the shot's tools. Optional
   * rather than nullable so an ordinary canvas is unchanged by its existence.
   */
  board?: BoardApi;
}

/** What the control bar can do to the board a shot belongs to. */
export interface BoardApi {
  ratio: Ratio;
  shots: number;
  setRatio(ratio: Ratio): void;
  addShot(): void;
  /** Columns showing right now — pinned or width-decided. */
  cols: number;
  /** The most columns this board could hold; the pin steps within [1, most]. */
  most: number;
  /** Whether a pin is set, or the width is deciding. */
  pinned: boolean;
  pin(delta: number): void;
  unpin(): void;
}

export interface CanvasSurfaceProps {
  /** The block's persisted string: canvas HTML, or legacy JSON. */
  source: string;
  onChange: (source: string, scene: Scene) => void;
  /**
   * Published on mount and whenever the canvas takes focus; `null` on unmount.
   * The object keeps its identity for the life of the canvas, so claiming the
   * shell is the only thing that moves state above it. The shell holds the
   * latest and mounts the toolbar and the panels against it.
   */
  onApi?: (api: CanvasApi | null) => void;
  /**
   * View-only: the share route, and a viewer's workspace.
   *
   * Reading a diagram means being able to point at a piece of it, so a click
   * still selects — one shape, the one under the pointer, with no group
   * standing in front of it and no marquee taking several. Everything that
   * would MOVE something is gone: no drag, no handles to grab, no keymap, no
   * label edit, no context menu — and the viewport itself is pinned, because a
   * view that can be pushed off its own frame is a view you can lose.
   */
  readOnly?: boolean;
  /**
   * Render as a fixed frame rather than a block-sized, pannable canvas — a
   * storyboard shot.
   *
   * The scene keeps its authored size and is drawn at `scale`, so a board that
   * reflows to fewer columns shows the same drawing larger rather than
   * rewriting a single coordinate. Everything that makes a canvas a canvas —
   * tools, gestures, snapping, the layers and style panels — is untouched;
   * what goes away is the block chrome that has no meaning inside a shot: the
   * resize grips, the empty-canvas hint, and panning to somewhere there is
   * nothing to find.
   */
  frame?: { w: number; h: number; scale: number };
}

export function CanvasSurface({
  source,
  onChange,
  onApi,
  readOnly = false,
  frame,
}: CanvasSurfaceProps) {
  const store = useScene({ source, onChange });
  const scene = useSceneSnapshot(store);
  /**
   * The same scene with every auto-laid-out child placed where it is actually
   * drawn — see the note on coordinates in the module header.
   *
   * Free: `laidOutScene` memoises on the scene object, and `useSelection` has
   * already asked for this one, so this is the identical object rather than a
   * second pass. Rendering still goes through `scene`: the shapes are laid out
   * by CSS, and handing the renderer pre-placed boxes would be telling the
   * browser the answer to the question it is being asked.
   */
  const laid = laidOutScene(scene);
  // Pinned for a shot, which has nowhere to pan to, and for a reader, who has
  // nothing to reach that the first fit did not already bring into view.
  // `content` is read once, so it answers through the store rather than closing
  // over the scene this render happened to see.
  const viewport = useViewport(
    frame || readOnly
      ? { locked: true }
      : { content: () => contentRect(store.getScene()) },
  );

  // A shot is drawn at whatever scale its column asks for. Written through the
  // viewport rather than as a CSS transform on the wrapper so that every
  // coordinate conversion the gestures and the overlay already do — which all
  // run through `clientToScene` — stays correct at any size, for free.
  useEffect(() => {
    if (frame) viewport.set({ x: 0, y: 0, zoom: frame.scale });
  }, [viewport, frame]);
  // The scene store is what puts a selection back on undo; without it a
  // selection change is simply not in the history.
  const selection = useSelectionStore(scene, store);
  const sel = useSelection(selection, scene);
  // The two elements the viewport owns: the one that clips and takes input,
  // and the one that carries the transform.
  const { containerRef, sceneRef } = viewport;

  const wrap = useRef<HTMLDivElement>(null);
  const overlay = useRef<OverlayApi>(null);

  /**
   * The connector under the pointer. Local rather than in the selection store:
   * the store's hover drives the shape overlay, and a line is not a shape — it
   * has no frame for the overlay to draw and nothing else asks about it.
   */
  const [hoverEdge, setHoverEdge] = useState<EdgeId | null>(null);

  /**
   * Picking a connector. Stops the event so the surface underneath does not
   * also read it as a click on empty canvas and clear what was just selected.
   *
   * Suppressing the default is what keeps the focus the line below takes: left
   * to run, the press reaches ProseMirror as a mousedown, which takes a node
   * selection on the block the canvas sits in and focuses the editor to show
   * it. The connector stays selected and looks it, but the keymap is bound to
   * the container and no longer hears anything — so ⌫ is the editor's, and it
   * deletes the whole block.
   */
  const onEdgePick = useCallback(
    (id: EdgeId, event: React.PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) selection.toggleEdge(id);
      else selection.selectEdges([id]);
      containerRef.current?.focus({ preventScroll: true });
    },
    [selection, containerRef],
  );
  /** True while one of this component's own drags owns the pointer. */
  const busy = useRef(false);
  /** Whether the press being handled ever became a drag — see `clickOnRelease`. */
  const moveDidDrag = useRef(false);
  /** The node whose double-click asked to edit its label, this event. */
  const asked = useRef<NodeId | null>(null);

  // One starting tool for everyone. A reader used to start on the hand, back
  // when reading meant panning; now the view is pinned and the only thing left
  // to do with a pointer is point, which is what `move` does once the paths
  // that move things are closed off below.
  const [tool, setTool] = useState<CanvasTool>("move");
  // The same tool, as the external store the shell reads it through. Written
  // before the listeners are told, so a subscriber woken by the notification
  // reads the new value in the render that notification schedules — an effect
  // would land after it.
  const toolRef = useRef<CanvasTool>("move");
  const toolListeners = useRef(new Set<() => void>());
  const [editing, setEditing] = useState<NodeId | null>(null);
  /**
   * Vector edit mode: the path whose points are open, if any.
   *
   * It is surface state rather than a tool because the tool underneath it must
   * stay `"move"` — Escape leaves the points and lands back on the move tool
   * with the path itself selected, which a tool that had been *replaced* could
   * not do. Resolved against the scene on every render so a delete or an undo
   * closes it without an effect chasing the change.
   */
  const [openPath, setOpenPath] = useState<NodeId | null>(null);
  const editPath = openPath && findNode(scene, openPath) ? openPath : null;

  /**
   * The two tools that work on what is already there. They part company at the
   * handles and nowhere else, so selecting, hovering, dragging and the frame
   * itself read the same under both.
   */
  const picking = tool === "move" || tool === "scale";

  const latest = useRef({ onApi });
  // Latest-callback refs: written in an effect, never during render.
  useEffect(() => {
    latest.current = { onApi };
  });

  /**
   * The diagram's own properties, as an op like any other — one undoable
   * entry, and on the shared pipeline one per-key meta write. (These used to
   * bypass the store and write the block prop directly, which the CRDT
   * pipeline's frozen seed turned into an edit no history ever saw.)
   */
  const setDiagram = useCallback(
    (patch: DiagramPatch) => {
      const attrs: Record<string, string | undefined> = {};
      if (patch.h !== undefined) attrs[HEIGHT_ATTR] = FIXED;
      if (patch.w !== undefined) attrs[WIDTH_ATTR] = FIXED;
      store.dispatch({
        type: "setDiagram",
        ...(patch.w !== undefined ? { w: patch.w } : {}),
        ...(patch.h !== undefined ? { h: patch.h } : {}),
        ...(patch.style ? { style: patch.style } : {}),
        ...(Object.keys(attrs).length ? { attrs } : {}),
      });
    },
    [store],
  );

  const previewSize = useCallback((size: { w?: number; h?: number }) => {
    const el = wrap.current;
    if (!el) return;
    if (size.h !== undefined) {
      el.style.height = `${Math.max(CANVAS_MIN_H, size.h)}px`;
    }
    if (size.w !== undefined) {
      el.style.width = `${Math.max(CANVAS_MIN_W, size.w)}px`;
    }
  }, []);

  const previewStyle = useCallback(
    (decls: StylePatch) => writeStyle(containerRef.current?.style, decls),
    [containerRef],
  );

  /** Back to a size the layout derives — double-click on a grip. */
  const fit = useCallback(
    (attr: string) => {
      if (store.getScene().attrs[attr] === undefined) return;
      store.dispatch({ type: "setDiagram", attrs: { [attr]: undefined } });
    },
    [store],
  );

  /**
   * What a gesture is allowed to assume for its whole duration: nothing
   * re-renders while a finger is down, so the elements are the ones it found on
   * the first frame, the only shapes that have left their model positions are
   * the ones under the top-level nodes it is moving, and what every connector
   * has to route around is therefore settled the moment the gesture starts.
   */
  const held = useRef<{
    moving: ReadonlySet<NodeId>;
    elements: Map<NodeId, HTMLElement | null>;
    edges: EdgeElements;
    obstacles: LiveObstacles;
  } | null>(null);

  const getElement = useCallback(
    (id: NodeId) => {
      const cache = held.current;
      const known = cache?.elements.get(id);
      if (known !== undefined) return known;
      const el =
        viewport.sceneRef.current?.querySelector<HTMLElement>(
          `[data-id="${CSS.escape(id)}"]`,
        ) ?? null;
      cache?.elements.set(id, el);
      return el;
    },
    [viewport],
  );

  /**
   * The shapes' live boxes, read from the DOM rather than the scene: mid-drag
   * the elements have moved and the model has not, and the element is the only
   * one of the two telling the truth. Falls back to the scene for anything not
   * rendered — a node inside a collapsed branch has no element to measure — and
   * for everything a running gesture is *not* moving, whose element would only
   * confirm the box the scene already holds at the cost of a forced layout.
   */
  const reflowLive = useCallback(() => {
    // Laid out, like every other geometry read here, and through the same
    // memo, so the identity `reflowEdges` checks its prepared obstacles
    // against still matches what `onActiveChange` prepared them from.
    const scene = laidOutScene(store.getScene());
    if (scene.edges.length === 0) return;
    const cache = held.current;
    reflowEdges(
      sceneRef.current,
      scene,
      (id) => {
        if (cache && !cache.moving.has(id)) return null;
        const el = getElement(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const a = viewport.clientToScene({ x: r.left, y: r.top });
        const b = viewport.clientToScene({ x: r.right, y: r.bottom });
        return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
      },
      cache,
    );
  }, [store, sceneRef, getElement, viewport]);

  /**
   * Everything a gesture can move: the whole subtree of each top-level node the
   * selection reaches into. A hugging ancestor grows and its flow siblings
   * shift, and a reorder slides the shapes the dragged one passes — all of them
   * under the same top-level node, and none of them anywhere else.
   */
  const movingSubtrees = useCallback((): Set<NodeId> => {
    const scene = store.getScene();
    const roots = new Set<NodeId>();
    for (const id of selection.getSnapshot().ids) {
      const top = nodePath(scene, id)[0];
      if (top) roots.add(top.id);
    }
    const out = new Set<NodeId>();
    for (const node of scene.nodes) {
      if (roots.has(node.id)) walk([node], (n) => void out.add(n.id));
    }
    return out;
  }, [store, selection]);

  const gesture = useTransformGesture({
    store,
    getViewport: viewport.get,
    getSelection: () => selection.getSnapshot().ids,
    // The clipping container, not the transformed layer: the gesture measures
    // it once and then subtracts the viewport translation itself.
    getContainer: () => viewport.containerRef.current,
    getElement,
    overlay,
    onSelect: (ids) => selection.select(ids),
    // Connectors are drawn *from* the shapes, so they have to be re-routed by
    // whatever is moving them — the scene does not change until the gesture
    // commits, and a connector rendered from the scene would sit still while
    // its shape slid away.
    onFrame: reflowLive,
    // A cancelled gesture puts the transforms back without touching the scene,
    // so nothing re-renders and the paths written above would stay stale. One
    // frame later the DOM has settled either way.
    onActiveChange: (active) => {
      if (active) {
        moveDidDrag.current = true;
        const moving = movingSubtrees();
        held.current = {
          moving,
          elements: new Map(),
          edges: new Map(),
          obstacles: prepareObstacles(laidOutScene(store.getScene()), moving),
        };
        return;
      }
      held.current = null;
      requestAnimationFrame(reflowLive);
    },
  });

  /**
   * Picking a tool leaves vector edit mode. The pen overlay sits above the
   * whole surface, so a tool chosen underneath it would be a tool you could not
   * reach — and the tool bar showing something the surface is not doing.
   */
  // Existence only, so `changeTool` — and the api memoised on it — keeps its
  // identity when the container re-renders the frame object with equal values.
  const inFrame = frame !== undefined;
  const changeTool = useCallback(
    (next: CanvasTool) => {
      // A shot has no use for either: the hand pans a viewport that is locked
      // to its frame, and a connector joins nodes of a diagram — a storyboard's
      // relations are its shot order, not arrows. Refused here rather than in
      // the bar so the keymap's `h` and `c` cannot reach them either.
      if (inFrame && (next === "hand" || next === "connector")) return;
      setOpenPath(null);
      toolRef.current = next;
      setTool(next);
      for (const listener of toolListeners.current) listener();
    },
    [inFrame],
  );

  const toolControl = useMemo<ToolControl>(
    () => ({
      get: () => toolRef.current,
      set: changeTool,
      subscribe: (listener) => {
        toolListeners.current.add(listener);
        return () => {
          toolListeners.current.delete(listener);
        };
      },
    }),
    [changeTool],
  );

  const pathControl = useMemo(() => ({ set: setOpenPath }), []);

  useCanvasShortcuts({
    scene: store,
    selection,
    viewport,
    tool: toolControl,
    pathEdit: pathControl,
    enabled: !readOnly,
  });

  const { open: openMenu, menu } = useContextMenu(store, selection);

  // A press anywhere that is not this canvas or the panels speaking for it —
  // another block, another diagram, the page background — drops the selection.
  const hasSelection = sel.ids.length > 0;
  useEffect(() => {
    if (!hasSelection) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (wrap.current?.contains(target) || target.closest(CANVAS_CHROME)) return;
      selection.clear();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [hasSelection, selection]);

  /** Frame everything visible — the first paint, and the rescue button. */
  const frameContent = useCallback(() => {
    // A shot is framed by its container at a fixed scale; fitting the content
    // here would zoom a viewport whose whole point is that it never moves.
    if (inFrame) return;
    const scene = store.getScene();
    if (!scene.nodes.some((node) => !node.hidden)) return;
    viewport.zoomToFit(contentRect(scene));
  }, [store, viewport, inFrame]);

  // A diagram authored wider than the column would otherwise open cropped.
  const fitted = useRef(false);
  useLayoutEffect(() => {
    if (fitted.current) return;
    fitted.current = true;
    frameContent();
  }, [frameContent]);

  const api = useMemo<CanvasApi>(
    () => ({
      store,
      selection,
      viewport,
      tools: toolControl,
      setTool: changeTool,
      setDiagram,
      previewSize,
      previewStyle,
    }),
    [
      store,
      selection,
      viewport,
      toolControl,
      changeTool,
      setDiagram,
      previewSize,
      previewStyle,
    ],
  );

  // Also on focus: a page can hold two canvas blocks, and the toolbar speaks
  // for the one being edited, not for the one that mounted last.
  const publish = useCallback(() => latest.current.onApi?.(api), [api]);
  useEffect(() => {
    publish();
  }, [publish]);
  useEffect(() => () => latest.current.onApi?.(null), []);

  const scenePoint = (event: { clientX: number; clientY: number }) =>
    viewport.clientToScene({ x: event.clientX, y: event.clientY });

  const startPan = (from: { x: number; y: number }) => {
    const el = viewport.containerRef.current;
    el?.classList.add("is-grabbing");
    let { x, y } = from;
    drag(
      (event) => {
        viewport.panBy(event.clientX - x, event.clientY - y);
        x = event.clientX;
        y = event.clientY;
      },
      () => {
        busy.current = false;
        el?.classList.remove("is-grabbing");
      },
    );
  };

  const startMarquee = (origin: { x: number; y: number }, shift: boolean) => {
    drag(
      (event) => {
        const rect = normalizeRect(origin, scenePoint(event));
        overlay.current?.marquee(rect);
        selection.marquee(rect, { shift });
      },
      () => {
        busy.current = false;
        overlay.current?.marquee(null);
      },
    );
  };

  /**
   * Draw a shape by dragging on the canvas. The node is inserted at once and
   * its element is written to directly for the rest of the drag, so what you
   * are sizing is the real shape; the whole thing lands as one undo entry.
   *
   * Shift constrains it to a square, and is live: taking it back mid-drag
   * un-constrains the shape without the pointer having to move.
   */
  const startDraw = (kind: DrawKind, origin: Point) => {
    const id = mintId(store.getScene());
    store.begin();
    store.dispatch({
      type: "insert",
      nodes: [newNode(kind, id, { ...origin, w: 0, h: 0 })],
    });

    let box: Rect = { ...origin, w: 0, h: 0 };
    let corner = origin;
    let even = false;
    // A kind the browser cannot draw from the box has to be re-emitted as the
    // box grows — a rect paints itself, an SVG shape does not. Resolved lazily
    // because the element only exists once React has rendered the insert.
    let shape: ShapeWriter | null = null;
    let sought = false;

    const paint = () => {
      box = normalizeRect(origin, even ? evenCorner(origin, corner) : corner);
      const el = getElement(id);
      if (el) {
        el.style.transform = `translate3d(${box.x}px, ${box.y}px, 0)`;
        el.style.width = `${box.w}px`;
        el.style.height = `${box.h}px`;
        if (!sought) {
          sought = true;
          const node = findNode(store.getScene(), id);
          shape = node ? shapeWriter(node, el) : null;
        }
        shape?.write(box.w, box.h);
      }
      overlay.current?.update(box, 0, NO_GUIDES);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.shiftKey === even) return;
      even = event.shiftKey;
      paint();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);

    drag(
      (event) => {
        corner = scenePoint(event);
        even = event.shiftKey;
        paint();
      },
      () => {
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("keyup", onKey);
        busy.current = false;
        const drawn = box.w >= DRAWN_MIN && box.h >= DRAWN_MIN;
        store.dispatch({
          type: "resize",
          frames: [{ id, ...(drawn ? box : defaultBox(kind, origin)) }],
        });
        store.commit();
        overlay.current?.update(null, 0, NO_GUIDES);
        select(id);
      },
    );
  };

  /** A shape you just made: selected, back on the move tool, caret in its label. */
  const select = (id: NodeId) => {
    selection.select([id]);
    setEditing(id);
    setTool("move");
  };

  /**
   * Apply a click's selection change at pointerup, unless the press became a
   * drag in the meantime. `moveDidDrag` rather than `gesture.isActive()`,
   * because the gesture's own pointerup listener runs first and has already
   * torn the session down by the time this one fires.
   */
  const clickOnRelease = (point: Point, mods: ClickMods) => {
    moveDidDrag.current = false;
    const settle = () => {
      window.removeEventListener("pointerup", settle);
      window.removeEventListener("pointercancel", settle);
      if (!moveDidDrag.current) selection.click(point, mods);
    };
    window.addEventListener("pointerup", settle);
    window.addEventListener("pointercancel", settle);
  };

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0 || viewport.panState() !== "idle") return;
    // Every branch below either captures the pointer or suppresses the default
    // drag, both of which would otherwise cost the canvas its focus — and with
    // it the keymap and the clipboard.
    viewport.containerRef.current?.focus({ preventScroll: true });
    dropHover();
    busy.current = true;

    if (tool === "hand") {
      event.preventDefault();
      startPan({ x: event.clientX, y: event.clientY });
      return;
    }

    const point = scenePoint(event);
    if (
      tool === "rect" ||
      tool === "ellipse" ||
      tool === "text" ||
      tool === "polygon" ||
      tool === "diamond"
    ) {
      event.preventDefault();
      startDraw(tool, point);
      return;
    }

    // The pen tool's own overlay covers the canvas and owns every press in it;
    // this handler still sees them, on the way up. Vector edit mode puts that
    // same overlay up while the tool underneath is still `move`, so it has to
    // stand down for that too.
    if (!picking || editPath) {
      busy.current = false;
      return;
    }

    // A reader points at one shape and that is all. `deep` always, so a group
    // never answers for the thing under the pointer — there is no entering a
    // group here, and no double-click to do it with, so an outermost-group
    // rule would put whole clusters permanently out of reach. No shift, so no
    // multi-selection; no drag; and an empty click clears rather than starting
    // a marquee.
    if (readOnly) {
      selection.click(point, { deep: true });
      busy.current = false;
      return;
    }

    const mods: ClickMods = { shift: event.shiftKey, deep: event.altKey };
    const hit = selection.probe(point, mods);
    const bounds = sel.selectionBounds;
    const onSelection =
      hit !== null
        ? selection.isSelected(hit)
        : sel.ids.length > 1 &&
          point.x >= bounds.x &&
          point.x <= bounds.x + bounds.w &&
          point.y >= bounds.y &&
          point.y <= bounds.y + bounds.h;

    // Figma's rule: a press anywhere on the selection — a selected shape, or
    // the empty span of a multi-selection's box — drags all of it. What the
    // click *means* for the selection (collapse to the hit, shift-toggle it
    // out, deselect) waits for release, and only happens if no drag started.
    if (onSelection) {
      busy.current = false;
      clickOnRelease(point, mods);
      gesture.startMove(event);
      return;
    }

    const clicked = selection.click(point, mods);
    if (clicked === null) {
      event.preventDefault();
      startMarquee(point, event.shiftKey);
    } else if (selection.isSelected(clicked)) {
      busy.current = false;
      gesture.startMove(event);
    } else {
      // A shift-click that removed a node from the selection is not the start
      // of a drag of what is left.
      busy.current = false;
    }
  };

  /**
   * The pointer's last position over the canvas, and the frame that will read
   * it. Answering where the ring goes costs a hit test down the tree and a
   * `getBoundingClientRect` to convert the point — per event, at pointer rate,
   * for something that can only be shown once a frame. So the same idiom as
   * {@link drag}: keep the latest, do the work once.
   */
  const hoverAt = useRef<{
    clientX: number;
    clientY: number;
    deep: boolean;
  } | null>(null);
  const hoverFrame = useRef(0);

  /** Give up the queued frame — the pointer has left, gone down, or the canvas
   *  has. A press is the one case that is not simply tidying: `onPointerMove`
   *  stands down for a gesture, but a frame queued just before the press would
   *  still land inside it and re-render the surface out from under a drag that
   *  has been promised nothing will. */
  const dropHover = useCallback(() => {
    if (hoverFrame.current) cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = 0;
    hoverAt.current = null;
  }, []);
  useEffect(() => dropHover, [dropHover]);

  const onPointerMove = (event: ReactPointerEvent) => {
    if (busy.current || !picking || editPath || gesture.isActive()) return;
    hoverAt.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      // Deep read-only for the same reason the click is: the ring has to
      // promise what the click will actually take.
      deep: readOnly || event.altKey,
    };
    if (hoverFrame.current) return;
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = 0;
      const at = hoverAt.current;
      if (at) selection.hover(scenePoint(at), { deep: at.deep });
    });
  };

  /**
   * Double-click means three different things, and only the scene can say
   * which: a group under the pointer is "go inside", a vector is "open its
   * points", and any other shape at the level we are already in is "edit its
   * label" — which the shape itself asked for on the way up. Empty canvas means
   * nothing at all; shapes come from the toolbar.
   */
  const onDoubleClick = (event: ReactMouseEvent) => {
    if (!picking || editPath) return;
    const wanted = asked.current;
    asked.current = null;
    const point = scenePoint(event);
    const chain = hitTestPath(laid, point);
    if (chain.length === 0) return;
    const descending = descends(sel.enteredPath, chain);
    selection.enter(point);
    if (descending) return;
    const ids = selection.getSnapshot().ids;
    if (ids.length !== 1) return;
    const node = findNode(laid, ids[0]);
    if (node?.kind === "path") setOpenPath(node.id);
    else if (wanted && ids[0] === wanted) setEditing(wanted);
  };

  const onContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    viewport.containerRef.current?.focus({ preventScroll: true });
    const point = scenePoint(event);
    const chain = hitTestPath(laid, point);
    // Nothing under the pointer: every entry would be dead, so this is a
    // deselect rather than a menu.
    if (chain.length === 0) {
      selection.clear();
      return;
    }
    if (!chain.some((node) => selection.isSelected(node.id))) {
      selection.click(point);
    }
    openMenu(event);
  };

  /**
   * A label edit that streamed opens a gesture bracket on its first live
   * commit and closes it at the blur — so however many word-pace dispatches
   * went out (each one reaching collaborators as it lands), undo answers with
   * ONE step, and a remote scene arriving mid-edit waits for the bracket the
   * way it does for any gesture.
   */
  const liveLabel = useRef<NodeId | null>(null);

  const onEditLive = useCallback(
    (id: NodeId, label: string) => {
      if (liveLabel.current !== id) {
        liveLabel.current = id;
        store.begin();
      }
      store.dispatch({ type: "setLabel", id, label });
    },
    [store],
  );

  const onEditEnd = useCallback(
    (id: NodeId, label: string) => {
      store.dispatch({ type: "setLabel", id, label });
      if (liveLabel.current === id) {
        liveLabel.current = null;
        store.commit();
      }
      setEditing((current) => (current === id ? null : current));
    },
    [store],
  );

  const onEditStart = useCallback((id: NodeId) => {
    asked.current = id;
  }, []);

  /**
   * Open a label for editing outright — the solo chip's "Edit text". Unlike
   * `onEditStart`, which only annotates the double-click the surface is about
   * to process, there is no second half coming: this is the whole request, so
   * it does what the just-created-shape flow does.
   */
  const onEditOpen = useCallback(
    (id: NodeId) => {
      selection.select([id]);
      setEditing(id);
      setTool("move");
    },
    [selection],
  );

  /** Escape, Enter, or a press on empty canvas: out of the points, onto the path. */
  const onPenFinish = useCallback(
    (id: NodeId | null) => {
      setOpenPath(null);
      setTool("move");
      if (id) selection.select([id]);
    },
    [selection],
  );

  const height = sceneBlockHeight(scene);
  /** Unset until widened, so the block tracks the document column by default. */
  const width =
    scene.attrs[WIDTH_ATTR] === FIXED ? Math.max(CANVAS_MIN_W, scene.w) : null;

  const onGripDown = (event: ReactPointerEvent) => {
    const el = wrap.current;
    if (event.button !== 0 || !el) return;
    event.preventDefault();
    const startY = event.clientY;
    const startH = el.offsetHeight;
    let next = startH;
    drag(
      (move) => {
        next = Math.max(CANVAS_MIN_H, Math.round(startH + move.clientY - startY));
        // Written straight to the element; React learns the number once, from
        // the source this commits.
        el.style.height = `${next}px`;
      },
      () => setDiagram({ h: next }),
    );
  };

  /**
   * The right grip. The left edge stays pinned to the text column, exactly as
   * the top does, so a diagram grows into the right margin and the prose above
   * and below it keeps its own left edge.
   */
  const onSideGripDown = (event: ReactPointerEvent) => {
    const el = wrap.current;
    if (event.button !== 0 || !el) return;
    event.preventDefault();
    const startX = event.clientX;
    const startW = el.offsetWidth;
    const limit = maxWidth(el);
    let next = startW;
    drag(
      (move) => {
        const grown = startW + (move.clientX - startX);
        next = Math.round(Math.min(limit, Math.max(CANVAS_MIN_W, grown)));
        el.style.width = `${next}px`;
      },
      () => setDiagram({ w: next }),
    );
  };

  const surface = useMemo(() => toCss(scene.style), [scene.style]);

  // A box, its handles and a hover ring around a path whose points are open
  // would be three things to grab that all mean "the whole shape". Figma drops
  // them for the same reason: in vector edit mode the anchors are the chrome.
  const framed = picking && !editPath;

  /** Every visible node's box, which is what tells us the content is lost. */
  const contentBounds = useMemo(
    () =>
      laid.nodes
        .filter((node) => !node.hidden)
        .map((node) => absoluteBounds(laid, node.id)),
    [laid],
  );

  /**
   * The path the pen overlay is on: the one whose points were opened, or — on
   * the pen tool proper — a selected path, which it extends and edits.
   * `null` with the pen tool is a new path, drawn from the first click.
   */
  const penTarget =
    editPath ??
    (sel.nodes.length === 1 && sel.nodes[0].kind === "path"
      ? sel.nodes[0].id
      : null);

  return (
    <div
      ref={wrap}
      className={frame ? "nt-canvas nt-canvas-shot" : "nt-canvas"}
      contentEditable={false}
      style={
        frame
          ? { width: frame.w * frame.scale, height: frame.h * frame.scale }
          : width === null
            ? { height }
            : { height, width }
      }
    >
      <div
        ref={containerRef}
        className="nt-canvas-viewport"
        style={surface}
        data-tool={tool}
        tabIndex={0}
        onFocus={publish}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={() => {
          dropHover();
          selection.hover(null);
        }}
        onDoubleClick={readOnly ? undefined : onDoubleClick}
        onContextMenu={readOnly ? undefined : onContextMenu}
      >
        <div ref={sceneRef} className="nt-canvas-scene">
          {/* Under the shapes: a connector reads as running behind the things
              it joins, and its arrowhead lands on the box edge either way. */}
          <EdgeLayer
            scene={laid}
            viewport={viewport}
            selected={sel.edgeSelected}
            hoverId={hoverEdge}
            // Unattached rather than ignored, so a press on a connector falls
            // through to the surface and pans like everywhere else.
            onPick={readOnly ? undefined : onEdgePick}
            onHover={readOnly ? undefined : setHoverEdge}
          />
          {scene.nodes.map((node) => (
            <ShapeView
              key={node.id}
              node={node}
              editingId={editing}
              onEditStart={onEditStart}
              onEditEnd={onEditEnd}
              onEditLive={readOnly ? undefined : onEditLive}
              // Withheld read-only: with no edit to offer, a solo chip's click
              // goes straight to the page, the one thing a viewer can do.
              onEditOpen={readOnly ? undefined : onEditOpen}
            />
          ))}
          <Overlay
            ref={overlay}
            viewport={viewport}
            selection={framed && sel.ids.length ? sel.selectionBounds : null}
            members={framed ? sel.memberBounds : NO_MEMBERS}
            ids={sel.ids}
            hover={framed ? sel.hoverBounds : null}
            onResizeStart={tool === "scale" ? gesture.startScale : gesture.startResize}
            onRotateStart={gesture.startRotate}
            // Withheld read-only, which is also what stops the overlay reading
            // a shape's corner radii off the DOM to place anchors nobody gets.
            onRadiusStart={readOnly ? undefined : gesture.startRadius}
            readOnly={readOnly}
          />
        </div>

        {/* The tool stays up after a connector lands — a diagram's edges come
            in runs, and re-picking the tool for each one would make the run
            the expensive part. The new edge is selected as it lands, and
            Escape is the way back to the move tool. */}
        {tool === "connector" && (
          <ConnectorTool store={store} viewport={viewport} selection={selection} />
        )}

        {(tool === "pen" || editPath) && (
          <PenTool
            // The anchor list is read from the node once, on mount, so a change
            // of subject is a change of component.
            key={penTarget ?? "new"}
            store={store}
            viewport={viewport}
            nodeId={penTarget}
            onFinish={onPenFinish}
          />
        )}

        {scene.nodes.length === 0 && !readOnly && !frame && (
          <p className="nt-canvas-hint">Pick a shape from the toolbar</p>
        )}
      </div>

      {!readOnly && !frame && (
        <>
          <div
            className="nt-canvas-grip"
            role="separator"
            aria-label="Resize canvas height"
            title="Drag to resize · double-click to fit"
            onPointerDown={onGripDown}
            onDoubleClick={() => fit(HEIGHT_ATTR)}
          />
          <div
            className="nt-canvas-grip-x"
            role="separator"
            aria-label="Resize canvas width"
            title="Drag to resize · double-click to fit the column"
            onPointerDown={onSideGripDown}
            onDoubleClick={() => fit(WIDTH_ATTR)}
          />
        </>
      )}

      <Refit viewport={viewport} bounds={contentBounds} onFrame={frameContent} />

      {menu}
    </div>
  );
}
