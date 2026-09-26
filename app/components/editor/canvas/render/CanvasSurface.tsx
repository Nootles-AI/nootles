"use client";

/**
 * The canvas block, assembled.
 *
 * One band of the page — the text column's width, or the wide band's — with
 * one transformed layer inside it holding every shape and the overlay, and the
 * engine hooks wired to both. The band has no camera: the scene sits in it at
 * 100%, its origin on the text's left edge, and the page scrolls it like any
 * other block. Everything that changes per frame — drag, resize, rotate,
 * marquee, drawing, the band growing under them — is written straight to the
 * DOM by the module that owns it; this component re-renders only when the
 * scene, the selection or the tool actually changes.
 *
 * Three things live here and nowhere else: the active tool, which every other
 * module reads; which label is open for editing, since a new shape must open
 * its own; and the block's own source — `SceneOp` addresses nodes, so the
 * diagram's width, height and background are not ops but a re-serialized scene
 * written back onto the block, which the store then adopts.
 *
 * The panels and the toolbar are *not* rendered here. They belong to the
 * screen, not to a document column, so the canvas publishes
 * {@link CanvasApi} instead and the workspace mounts them.
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
  type RefObject,
} from "react";

import { useContextMenu } from "../ContextMenu";
import { CANVAS_CHROME, type PageCanvas } from "../page/PageCanvas";
import type { GestureHost } from "../page/pageGesture";
import type { PageToolControl } from "../page/tools";
import { ConnectorTool } from "./ConnectorTool";
import { EdgeLayer } from "./EdgeLayer";
import {
  prepareObstacles,
  reflowEdges,
  type EdgeElements,
  type LiveObstacles,
} from "./liveEdges";
import { prepareBooleans, reflowBooleans, type LiveBooleans } from "./liveBoolean";
import {
  isDoubleClick,
  useTransformGesture,
  type BandRange,
  type LiveFrame,
  type PointerLike,
  type Press,
  type TransformGestureOptions,
} from "../engine/gestures";
import { isModKey, useCanvasShortcuts, type CanvasTool } from "../engine/shortcuts";
import { columnLines, type SnapExtra, type SnapGuide } from "../engine/snapping";
import { createSurfaceModes, type SurfaceModeContext, type SurfaceModes } from "../engine/surfaceMode";
import { useScene, useSceneSnapshot, type SceneStore } from "../engine/useScene";
import {
  descends,
  marqueeThroughTarget,
  useSelection,
  useSelectionStore,
  type ClickMods,
  type SelectionStore,
} from "../engine/useSelection";
import { useViewport, type ViewportController } from "../engine/useViewport";
import type { DiagramPatch } from "../panels/StylePanel";
import { undoScope } from "@/app/lib/history/useWorkspaceHistory";
import { effectiveScale, followFit } from "@/app/lib/columnScale";
import {
  normalizeRect,
  toLocal,
  unrotateBound,
  type Handle,
  type RotatedRect,
} from "../scene/geometry";
import { hitTestPath, slopFor } from "../scene/picking";
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
  type StyleMap,
  type StylePatch,
} from "../scene/types";
import { BAND, bandFloor, bandLeft, bandWidth, WIDE_MARGIN } from "../scene/band";
import { sceneBlockHeight } from "../types";
import { defaultBox, newNode, type DrawKind } from "./newShape";
import { Overlay, type OverlayApi } from "./Overlay";
import { shapeWriter, type ShapeWriter } from "./svgShape";
import { PenTool } from "./PenTool";
import { useSceneFonts } from "./fonts";
import { ShapeView, toCss } from "./ShapeView";
import "../canvas.css";

/** Scene px below which a drag was a click, and the shape takes its own size. */
const DRAWN_MIN = 2;

const NO_GUIDES: readonly SnapGuide[] = [];
const NO_MEMBERS: readonly RotatedRect[] = [];
const NO_IDS: readonly NodeId[] = [];
const noSubscription = () => () => {};
const nothing = () => null;
const never = () => false;

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
    if (frame) {
      // A pointerup that lands before the scheduled frame paints (a fast
      // flick-release) must not just drop it — every caller reads its own
      // state (the drawn box, the marquee rect, the pan offset) from what
      // `onMove` last wrote, and skipping the flush leaves that state one
      // frame stale, short of wherever the pointer actually ended up.
      cancelAnimationFrame(frame);
      frame = 0;
      if (latest) onMove(latest);
    }
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

/**
 * The corner that makes a drag from `origin` square — Shift, while drawing —
 * no bigger than the room the band leaves it on the sides it grows toward.
 */
function evenCorner(origin: Point, point: Point, band: BandRange | null): Point {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  let side = Math.max(Math.abs(dx), Math.abs(dy));
  if (band) {
    if (dx < 0) side = Math.min(side, origin.x - band.minX);
    if (dx > 0) side = Math.min(side, band.maxX - origin.x);
    if (dy < 0) side = Math.min(side, origin.y);
  }
  return { x: origin.x + Math.sign(dx) * side, y: origin.y + Math.sign(dy) * side };
}

/** `box` moved, never resized, until it sits inside the band. */
function intoBand(box: Rect, band: BandRange | null): Rect {
  if (!band) return box;
  return {
    ...box,
    x: Math.max(band.minX, Math.min(band.maxX - box.w, box.x)),
    y: Math.max(0, box.y),
  };
}

/**
 * Whether `point` (scene space) falls inside `box` — the selection's own
 * frame, rotation included, never just its paint. A single selected node's
 * own geometry (a boolean operand left with nothing painted anywhere, once
 * the operation is done with it, is the case this exists for) still has a
 * real box the overlay draws handles on, and a press there has to mean "move
 * this" the same way a press on a multi-selection's empty span already does.
 */
function withinSelectionBounds(point: Point, box: RotatedRect): boolean {
  const local = toLocal(point, box);
  return local.x >= 0 && local.x <= box.w && local.y >= 0 && local.y <= box.h;
}

/** A diagram that paints its own ground — the band is otherwise the page's paper. */
function hasGround(style: StyleMap): boolean {
  return Object.keys(style).some((prop) => prop.startsWith("background"));
}

/**
 * The nearest ancestor that actually scrolls — the page, for the hand tool.
 * The editor nests a scroller of its own, so the question is asked of the
 * tree rather than assumed.
 */
function scrollParent(el: HTMLElement): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(p);
    const scrolls = (overflow: string) => overflow === "auto" || overflow === "scroll";
    if (
      (scrolls(overflowY) && p.scrollHeight > p.clientHeight) ||
      (scrolls(overflowX) && p.scrollWidth > p.clientWidth)
    ) {
      return p;
    }
  }
  return document.scrollingElement;
}

/**
 * The active tool, as an external store.
 *
 * A value would have to live on {@link CanvasApi}, and the api is published to
 * the workspace — so every R, O or L would be a top-level state change
 * re-rendering all of it to move a pressed state in the toolbar. Whoever draws
 * the tool subscribes to it instead, and the api keeps its identity for the
 * life of the canvas.
 */
export interface ToolControl {
  get(): CanvasTool;
  set(tool: CanvasTool): void;
  subscribe(listener: () => void): () => void;
}

/**
 * How the screen reaches one canvas: the stores for the panels, the tool for
 * the toolbar, the band and its viewport for the host, and the one write that
 * is not an op.
 */
export interface CanvasApi {
  store: SceneStore;
  /**
   * The selection as the page means it: on a page with other diagrams, what
   * replaces it replaces theirs too, and clearing it clears the page. The
   * diagram's own store when it stands alone.
   */
  selection: SelectionStore;
  /** The diagram's own selection store, which the page composes. */
  ownSelection: SelectionStore;
  /** What the page drives when a gesture moves shapes in several diagrams. */
  gesture: GestureHost;
  viewport: ViewportController;
  /** The band itself — `.nt-canvas`, the element the page lays out. */
  band: RefObject<HTMLDivElement | null>;
  /**
   * The exclusive pointer-mode slot (COLOR, shared with SELECT) — see
   * `engine/surfaceMode.ts`. A colour pick or a future layer-menu pick
   * registers a mode here instead of adding a parallel branch to this
   * component's own pointer handlers.
   */
  modes: SurfaceModes;
  tools: ToolControl;
  setTool(tool: CanvasTool): void;
  /**
   * Puts the keyboard on the canvas without scrolling the page to it — after
   * a pick from the toolbar, so the next key is a shortcut.
   */
  focus(): void;
  /** The diagram's own fields — `StylePanel`'s `onDiagramChange`. */
  setDiagram(patch: DiagramPatch): void;
  /**
   * Show a height on the band without committing it, so a scrub of the
   * panel's H previews every frame. Written straight to the element, exactly
   * as the grip does. Land it with {@link setDiagram}, which is what React
   * then renders from. A frame shows none: the board sizes its element.
   */
  previewSize(h: number): void;
  /**
   * The same, for the diagram's own declarations — its background, its colour
   * variables. Written straight onto the viewport element, so a drag in the
   * panel's picker previews without re-serializing and re-parsing the block;
   * land it with {@link setDiagram}.
   */
  previewStyle(decls: StylePatch): void;
  /**
   * What a transform gesture is drawing right now. Mid-drag the elements move
   * and the scene does not until the gesture lands, so anything drawn from a
   * shape's place — a collaborator's selection outline — reads it here.
   */
  live: LiveDrawing;
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

export interface LiveDrawing {
  /** Called after each gesture frame's DOM writes, and as a gesture ends. */
  subscribe(listener: () => void): () => void;
  /**
   * A node's box as drawn this frame, in scene px with its scene rotation;
   * `null` when no running gesture is moving it.
   */
  box(id: NodeId): RotatedRect | null;
}

const NO_LIVE_FRAMES: ReadonlyMap<NodeId, LiveFrame> = new Map();

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
   * The object keeps its identity for the life of the canvas; the host holds
   * the latest and mounts the toolbar and the panels against it.
   */
  onApi?: (api: CanvasApi | null) => void;
  /**
   * View-only: the share route, and a viewer's workspace.
   *
   * Reading a diagram means being able to point at a piece of it, so a click
   * still selects — one shape, the one under the pointer, with no group
   * standing in front of it and no marquee taking several. Everything that
   * would MOVE something is gone: no drag, no handles to grab, no keymap, no
   * label edit, no context menu.
   */
  readOnly?: boolean;
  /**
   * Keeps the scene store — and its undo history — warm across unmounts,
   * shared under this key. See {@link useScene}.
   */
  storeKey?: string;
  /**
   * Render as a fixed frame rather than a band of the page — a storyboard shot.
   *
   * The scene keeps its authored size and is drawn at `scale`, so a board that
   * reflows to fewer columns shows the same drawing larger rather than
   * rewriting a single coordinate. Everything that makes a canvas a canvas —
   * tools, gestures, snapping, the layers and style panels — is untouched;
   * what goes away is everything a band does that has no meaning inside a
   * shot: the height grip, the empty-canvas hint, the clamp to the column,
   * and growing to hold what is drawn.
   */
  frame?: { w: number; h: number; scale: number };
  /**
   * The page's tool, shared with the bar and every other diagram on the page.
   * Its host also owns what a press outside the diagram means. Absent — a
   * shot, the share route, a harness — the surface keeps a tool of its own.
   */
  tools?: PageToolControl;
  /**
   * The page this diagram is one of, and its block: selection, gestures and
   * the marquee then reach across every diagram on it.
   */
  page?: { canvas: PageCanvas; blockId: string };
}

export function CanvasSurface({
  source,
  onChange,
  onApi,
  readOnly = false,
  storeKey,
  frame,
  tools,
  page,
}: CanvasSurfaceProps) {
  const store = useScene({
    source,
    onChange,
    cacheKey: storeKey,
    frame: frame && { w: frame.w, h: frame.h },
    band: !frame,
  });
  const scene = useSceneSnapshot(store);
  // Every family the scene names, asked for once. The declaration is the
  // manifest; nothing else records which faces a diagram is set in.
  useSceneFonts(scene);
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
  // Existence only, so `setDiagram`, `changeTool` — and the api memoised on
  // them — keep their identity when the container re-renders the frame object
  // with equal values.
  const inFrame = frame !== undefined;
  const scale = frame?.scale ?? 1;
  const wide = !inFrame && scene.wide === true;
  // A shot is drawn at whatever scale its column asks for, and a wide band's
  // origin stays on the text's edge while the band reaches past it. Written
  // through the viewport rather than as CSS on the wrapper so that every
  // coordinate conversion the gestures and the overlay already do — which all
  // run through `clientToScene` — stays correct, for free. A layout effect, so
  // a wide toggle never paints a frame with the drawing still at the old origin.
  const viewport = useViewport({ initial: { x: wide ? WIDE_MARGIN : 0, y: 0, zoom: scale } });
  const wrap = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    viewport.set({ x: wide ? WIDE_MARGIN : 0, y: 0, zoom: scale });
  }, [viewport, scale, wide]);
  // A band keeps its logical width and is scaled, text and all, to the column
  // it stands in; a shot is sized by its board.
  useLayoutEffect(() => {
    const el = wrap.current;
    if (inFrame || !el) return;
    return followFit(el, wide ? "wide" : "normal");
  }, [inFrame, wide]);
  // The scene store is what puts a selection back on undo; without it a
  // selection change is simply not in the history.
  const ownSelection = useSelectionStore(scene, store);
  const canvas = page?.canvas ?? null;
  const blockId = page?.blockId ?? null;
  const selection = useMemo(
    () => (canvas && blockId ? canvas.selection.facade(blockId, ownSelection) : ownSelection),
    [canvas, blockId, ownSelection],
  );
  const sel = useSelection(selection, scene);
  // A selection spanning diagrams is drawn as one frame, in the band the page
  // is focused on; every band outlines its own members.
  const spanFrame = useSyncExternalStore(
    canvas?.subscribeFrame ?? noSubscription,
    () => (canvas && blockId ? canvas.frameIn(blockId) : null),
    nothing,
  );
  const leadsFrame = useSyncExternalStore(
    canvas?.selection.subscribe ?? noSubscription,
    () => !!canvas && canvas.selection.getSnapshot().focused === blockId,
    never,
  );
  // The two elements the viewport owns: the one that clips and takes input,
  // and the one that carries the transform.
  const { containerRef, sceneRef, gridRef } = viewport;

  /**
   * The exclusive pointer-mode slot (`CanvasApi.modes`). `modeCtx` is what
   * every mode handler receives — built fresh on each call so a mode always
   * sees the live scene/viewport rather than a stale render's closure — and
   * is also what drives the registry's own Escape/document-keydown routing.
   * `store`/`selection`/`viewport` are each created once per canvas (their
   * own hooks' `useState` initializers), so this stays one registry for the
   * life of the component.
   */
  const modeCtx = useCallback(
    (): SurfaceModeContext => ({
      store,
      selection,
      viewport,
      container: () => containerRef.current,
      scenePoint: (e) => viewport.clientToScene({ x: e.clientX, y: e.clientY }),
      laid: () => laidOutScene(store.getScene()),
    }),
    [store, selection, viewport, containerRef],
  );
  const modes = useMemo(() => createSurfaceModes(modeCtx), [modeCtx]);
  // Whatever a slice's mode is doing owns `data-mode` for its own CSS (the
  // colour-pick cursor, `canvas.css`'s two-attribute selector) — a plain
  // `useSyncExternalStore` snapshot, never a value this component computes.
  const activeMode = useSyncExternalStore(modes.subscribe, modes.get, () => null);
  // A mode left running past its canvas's own lifetime would leak listeners
  // and, worse, keep answering pointer events nothing can see any more.
  useEffect(() => () => modes.exit("unmounted"), [modes]);

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

  // A surface of its own starts everyone on `move`. A reader used to start on
  // the hand, back when reading meant panning; now the view is pinned and the
  // only thing left to do with a pointer is point, which is what `move` does
  // once the paths that move things are closed off below. The ref is written
  // before the listeners are told, so a subscriber woken by the notification
  // reads the new value in the render it schedules.
  const toolRef = useRef<CanvasTool>("move");
  const toolListeners = useRef(new Set<() => void>());
  const ownTools = useMemo<ToolControl>(
    () => ({
      get: () => toolRef.current,
      set: (next) => {
        if (toolRef.current === next) return;
        toolRef.current = next;
        for (const listener of toolListeners.current) listener();
      },
      subscribe: (listener) => {
        toolListeners.current.add(listener);
        return () => void toolListeners.current.delete(listener);
      },
    }),
    [],
  );
  const toolSource = tools ?? ownTools;
  const tool = useSyncExternalStore(toolSource.subscribe, toolSource.get, toolSource.get);
  const [editing, setEditing] = useState<NodeId | null>(null);
  /**
   * Vector edit mode: the path whose points are open, if any, and the tool it
   * was opened under.
   *
   * It is surface state rather than a tool because the tool underneath it must
   * stay `"move"` — Escape leaves the points and lands back on the move tool
   * with the path itself selected, which a tool that had been *replaced* could
   * not do. Resolved on every render — against the scene, so a delete or an
   * undo closes it, and against the tool, so one picked on the page's bar
   * closes it too — without an effect chasing either.
   */
  const [openPath, setOpenPathState] = useState<{ id: NodeId; tool: CanvasTool } | null>(null);
  const setOpenPath = useCallback(
    (id: NodeId | null) => setOpenPathState(id ? { id, tool: toolSource.get() } : null),
    [toolSource],
  );
  const editPath =
    openPath && openPath.tool === tool && findNode(scene, openPath.id) ? openPath.id : null;

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
      store.dispatch({
        type: "setDiagram",
        // A band's width is `wide`, never a number: a stated one would read
        // back as a root from before bands.
        ...(patch.w !== undefined && inFrame ? { w: patch.w } : {}),
        ...(patch.h !== undefined ? { h: patch.h } : {}),
        ...(patch.wide !== undefined ? { wide: patch.wide } : {}),
        ...(patch.style ? { style: patch.style } : {}),
      });
    },
    [store, inFrame],
  );

  const previewSize = useCallback(
    (h: number) => {
      const el = wrap.current;
      if (!el || inFrame) return;
      el.style.height = `${Math.max(bandFloor(store.getScene()), h)}px`;
    },
    [store, inFrame],
  );

  const previewStyle = useCallback(
    (decls: StylePatch) => writeStyle(containerRef.current?.style, decls),
    [containerRef],
  );

  /** Back to the height the content needs — double-click on the grip. */
  const fit = useCallback(() => {
    const scene = store.getScene();
    const floor = bandFloor(scene);
    if (scene.h !== floor) setDiagram({ h: floor });
  }, [store, setDiagram]);

  /** Where a band's content may go: its own width, and nothing above its top. */
  const bandRange = useCallback(() => {
    if (inFrame) return null;
    const minX = bandLeft(store.getScene());
    return { minX, maxX: minX + bandWidth(store.getScene()) };
  }, [store, inFrame]);

  /** A point held inside the band — a shape is never drawn off it. */
  const withinBand = useCallback(
    (point: Point): Point => {
      const range = bandRange();
      if (!range) return point;
      return {
        x: Math.min(range.maxX, Math.max(range.minX, point.x)),
        y: Math.max(0, point.y),
      };
    },
    [bandRange],
  );

  /**
   * The tallest the band has been drawn during the gesture in hand; 0 while it
   * has not grown. A drag or a draw past the bottom grows the band under the
   * pointer rather than at the release, written straight to the element.
   */
  const grown = useRef(0);
  const grow = useCallback(
    (bottom: number) => {
      const el = wrap.current;
      if (inFrame || !el || !Number.isFinite(bottom)) return;
      const next = Math.ceil(bottom + BAND);
      if (next <= Math.max(grown.current, sceneBlockHeight(store.getScene()))) return;
      grown.current = next;
      el.style.height = `${next}px`;
    },
    [store, inFrame],
  );
  /**
   * The height the gesture grew to, kept by the entry it lands as — so a band
   * never springs back under a shape dragged down and then up again, and undo
   * puts the old height back with the move.
   */
  const keepGrowth = useCallback(() => {
    const h = grown.current;
    if (h > store.getScene().h) store.dispatch({ type: "setDiagram", h });
  }, [store]);
  /**
   * The band at the height its scene says, once a gesture is over. A cancel
   * changes no scene, so nothing re-renders to take the growth back.
   */
  const settleHeight = useCallback(() => {
    const el = wrap.current;
    if (!grown.current || !el) return;
    grown.current = 0;
    el.style.height = `${sceneBlockHeight(store.getScene())}px`;
  }, [store]);

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
    booleans: LiveBooleans;
  } | null>(null);

  /** This frame's gesture boxes by id, for {@link CanvasApi.live}. */
  const liveFrames = useRef<ReadonlyMap<NodeId, LiveFrame>>(NO_LIVE_FRAMES);
  const liveListeners = useRef(new Set<() => void>());
  const tellLive = useCallback(() => {
    for (const listener of liveListeners.current) listener();
  }, []);

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

  /** A node's rendered bound in scene px — forces a layout if one is due. */
  const drawnRect = useCallback(
    (id: NodeId): Rect | null => {
      const el = getElement(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const a = viewport.clientToScene({ x: r.left, y: r.top });
      const b = viewport.clientToScene({ x: r.right, y: r.bottom });
      return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    },
    [getElement, viewport],
  );

  /**
   * The shapes' live boxes, read from the DOM rather than the scene: mid-drag
   * the elements have moved and the model has not, and the element is the only
   * one of the two telling the truth. Falls back to the scene for anything not
   * rendered — a node inside a collapsed branch has no element to measure — and
   * for everything a running gesture is *not* moving, whose element would only
   * confirm the box the scene already holds at the cost of a forced layout.
   */
  const reflowLive = useCallback((frames: readonly LiveFrame[] = []) => {
    const cache = held.current;
    // A boolean's cut is a function of its operands' boxes, which the gesture
    // knows and no element shows: the operands are not drawn.
    reflowBooleans(cache?.booleans ?? null, store.getScene(), frames);
    // Laid out, like every other geometry read here, and through the same
    // memo, so the identity `reflowEdges` checks its prepared obstacles
    // against still matches what `onActiveChange` prepared them from.
    const scene = laidOutScene(store.getScene());
    if (scene.edges.length === 0) return;
    reflowEdges(
      sceneRef.current,
      scene,
      (id) => (cache && !cache.moving.has(id) ? null : drawnRect(id)),
      cache,
    );
  }, [store, sceneRef, drawnRect]);

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

  /**
   * What a gesture snaps to beyond this diagram's shapes: a shot's own frame,
   * or the column a band sits on.
   */
  const snapExtra = useCallback((): SnapExtra => {
    const scene = store.getScene();
    if (inFrame) return { surface: { x: 0, y: 0, w: scene.w, h: scene.h } };
    return { column: columnLines(scene.wide === true, sceneBlockHeight(scene)) };
  }, [store, inFrame]);

  const gestureOptions: TransformGestureOptions = {
    store,
    clientToScene: viewport.clientToScene,
    screenScale: viewport.screenScale,
    band: bandRange,
    snapExtra,
    getSelection: () => ownSelection.getSnapshot().ids,
    getElement,
    overlay,
    onSelect: (ids) => selection.select(ids),
    // Connectors are drawn *from* the shapes, so they have to be re-routed by
    // whatever is moving them — the scene does not change until the gesture
    // commits, and a connector rendered from the scene would sit still while
    // its shape slid away.
    onFrame: (frames) => {
      reflowLive(frames);
      liveFrames.current = new Map(frames.map((frame) => [frame.id, frame]));
      tellLive();
    },
    grow,
    onLand: keepGrowth,
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
          booleans: prepareBooleans(store.getScene(), selection.getSnapshot().ids, getElement),
        };
        return;
      }
      held.current = null;
      liveFrames.current = NO_LIVE_FRAMES;
      tellLive();
      settleHeight();
      requestAnimationFrame(() => {
        reflowLive();
        tellLive();
      });
    },
  };
  const gesture = useTransformGesture(gestureOptions);
  // The page runs this diagram's share of a gesture spanning several with the
  // same options its own gesture has, as of the last render.
  const latestGesture = useRef(gestureOptions);
  useEffect(() => {
    latestGesture.current = gestureOptions;
  });
  const gestureHost = useMemo<GestureHost>(
    () => ({ options: () => latestGesture.current, overlay }),
    [],
  );

  const live = useMemo<LiveDrawing>(
    () => ({
      subscribe: (listener) => {
        liveListeners.current.add(listener);
        return () => void liveListeners.current.delete(listener);
      },
      box: (id) => {
        if (!held.current?.moving.has(id) || gesture.duplicating()) return null;
        const bound = drawnRect(id);
        if (!bound) return null;
        const scene = laidOutScene(store.getScene());
        const node = findNode(scene, id);
        if (!node) return null;
        const frames = liveFrames.current;
        let rot = 0;
        for (const n of nodePath(scene, id)) rot += frames.get(n.id)?.rot ?? n.rot;
        const own = frames.get(id);
        return (
          unrotateBound(bound, own?.w ?? node.w, own?.h ?? node.h, rot) ?? {
            ...bound,
            rot: 0,
          }
        );
      },
    }),
    [gesture, drawnRect, store],
  );

  /**
   * Picking a tool leaves vector edit mode. The pen overlay sits above the
   * whole surface, so a tool chosen underneath it would be a tool you could not
   * reach — and the tool bar showing something the surface is not doing.
   */
  const changeTool = useCallback(
    (next: CanvasTool) => {
      // A shot has no use for either: a frame has nothing past its edges for
      // the hand to bring into view, and a connector joins nodes of a diagram —
      // a storyboard's relations are its shot order, not arrows. Refused here
      // rather than in the bar so the keymap's `h` and `c` cannot reach them.
      if (inFrame && (next === "hand" || next === "connector")) return;
      setOpenPath(null);
      toolSource.set(next);
    },
    [inFrame, setOpenPath, toolSource],
  );

  /** One use of the tool is over: back to Move, unless the page's is locked. */
  const settleTool = useCallback(() => {
    setOpenPath(null);
    if (tools) tools.settle();
    else ownTools.set("move");
  }, [setOpenPath, tools, ownTools]);

  const toolControl = useMemo<ToolControl>(
    () => ({ get: toolSource.get, set: changeTool, subscribe: toolSource.subscribe }),
    [toolSource, changeTool],
  );

  const pathControl = useMemo(() => ({ set: setOpenPath }), [setOpenPath]);

  /** Enter on a text-bearing leaf: open its label, same as a double-click
   *  would once inside its group — `setEditing` alone is enough (`ShapeView`
   *  renders `LabelEdit` for `editingId === node.id`) and the keymap has
   *  already confirmed the node is selected. */
  const labelControl = useMemo(() => ({ open: (id: NodeId) => setEditing(id) }), []);

  useCanvasShortcuts({
    scene: store,
    selection,
    viewport,
    tool: toolControl,
    pathEdit: pathControl,
    labelEdit: labelControl,
    enabled: !readOnly,
  });

  const { open: openMenu, menu } = useContextMenu(store, selection, canvas ?? undefined);

  // A press anywhere that is not this canvas or the panels speaking for it —
  // another block, another diagram, the page background — drops the selection.
  // On a page, the page decides that for all of its diagrams at once.
  const hasSelection = sel.ids.length > 0 && !tools && !canvas;
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

  const focus = useCallback(
    () => containerRef.current?.focus({ preventScroll: true }),
    [containerRef],
  );

  const api = useMemo<CanvasApi>(
    () => ({
      store,
      selection,
      ownSelection,
      gesture: gestureHost,
      viewport,
      band: wrap,
      modes,
      tools: toolControl,
      setTool: changeTool,
      focus,
      setDiagram,
      previewSize,
      previewStyle,
      live,
    }),
    [
      store,
      selection,
      ownSelection,
      gestureHost,
      viewport,
      modes,
      toolControl,
      changeTool,
      focus,
      setDiagram,
      previewSize,
      previewStyle,
      live,
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

  /** Scene-px grab slop at the current zoom, packaged for a store call —
   *  PICK's shared `slopFor` (§2.1/§9), so a click, a hover, a double-click
   *  and the context menu never disagree about what counts as "on" a thin
   *  stroke at the same pixel. Every pointer-anchored call below spreads
   *  this rather than deriving its own tolerance (SELECT §1.4 — this *is*
   *  that one shared helper, not a second tolerance closure). */
  const pickOpts = () => ({ tolerance: slopFor(viewport.screenScale()) });

  /**
   * The hand moves the page: a band has no view of its own to move. In client
   * px, undivided — the pane is never zoomed, only the sheet inside it.
   */
  const startPan = (from: { x: number; y: number }) => {
    const el = viewport.containerRef.current;
    const scroller = el ? (el.closest(".nt-pane") ?? scrollParent(el)) : null;
    el?.classList.add("is-grabbing");
    let { x, y } = from;
    drag(
      (event) => {
        scroller?.scrollBy(x - event.clientX, y - event.clientY);
        x = event.clientX;
        y = event.clientY;
      },
      () => {
        busy.current = false;
        el?.classList.remove("is-grabbing");
      },
    );
  };

  const startMarquee = (
    origin: { x: number; y: number },
    shift: boolean,
    within?: NodeId,
  ) => {
    drag(
      (event) => {
        const rect = normalizeRect(origin, scenePoint(event));
        overlay.current?.marquee(rect);
        selection.marquee(rect, { shift, within });
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
   * un-constrains the shape without the pointer having to move. The corner is
   * held inside the band, which grows under it as it goes down.
   */
  const startDraw = (kind: DrawKind, from: Point) => {
    const origin = withinBand(from);
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
      box = normalizeRect(origin, even ? evenCorner(origin, corner, bandRange()) : corner);
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
      grow(box.y + box.h);
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
        corner = withinBand(scenePoint(event));
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
          frames: [{ id, ...(drawn ? box : intoBand(defaultBox(kind, origin), bandRange())) }],
        });
        keepGrowth();
        store.commit();
        settleHeight();
        overlay.current?.update(null, 0, NO_GUIDES);
        select(id, kind);
      },
    );
  };

  /**
   * A shape you just made: selected, back on the move tool. Only a text gets
   * its caret straight away — a text with nothing in it is nothing — while a
   * box waits for a double-click, as Figma's do: most boxes are drawn to be
   * arranged first and named later, and a caret in every new one turned the
   * next keystroke into a label.
   */
  const select = (id: NodeId, kind: DrawKind) => {
    selection.select([id]);
    if (kind === "text") setEditing(id);
    settleTool();
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
      // A press inside a frame spanning several diagrams can land on a band
      // with no share of the drag it starts; the page knows it was one.
      if (!moveDidDrag.current && !canvas?.gesture.didDrag()) selection.click(point, mods);
    };
    window.addEventListener("pointerup", settle);
    window.addEventListener("pointercancel", settle);
  };

  /**
   * The selection is taken hold of: by the page when it spans diagrams, so
   * every diagram's share moves as one, and by this diagram's own gesture
   * otherwise.
   */
  const startMove = (event: ReactPointerEvent) => {
    if (canvas && blockId && canvas.gesture.start(event, "move", null, blockId)) return;
    gesture.startMove(event);
  };
  const startResize = (event: PointerLike, handle: Handle) => {
    const mode = toolSource.get() === "scale" ? "scale" : "resize";
    if (canvas && blockId && canvas.gesture.start(event, mode, handle, blockId)) return;
    if (mode === "scale") gesture.startScale(event, handle);
    else gesture.startResize(event, handle);
  };
  const rotatePress = useRef<Press>({ key: "", time: 0, x: 0, y: 0 });
  const startRotate = (event: PointerLike) => {
    if (canvas && blockId && canvas.gesture.spans()) {
      if (isDoubleClick(rotatePress.current, "rotate", event)) {
        event.preventDefault();
        canvas.gesture.resetRotation();
      } else {
        canvas.gesture.start(event, "rotate", null, blockId);
      }
      return;
    }
    gesture.startRotate(event);
  };

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    // A held mode (the eyedropper, today) sees every pointer event on the
    // viewport before anything else here does — no focus, no selection, no
    // gesture, no marquee, no draw. Checked before `readOnly` too: a mode
    // does not know or care whether the canvas is read-only, by construction
    // (§2.1 of COLOR — a colour is a colour either way; the only mode that
    // exists today, the eyedropper, is never offered on a read-only canvas
    // because its own trigger requires a mutable destination).
    const mode = activeMode;
    if (mode) {
      mode.onPointerDown?.(event.nativeEvent, modeCtx());
      return;
    }
    // Read now, not from the render: a storyboard hands a shot the page's
    // shape in the capture phase of this very press, so that the press draws.
    const using = toolSource.get();
    // Every branch below either captures the pointer or suppresses the default
    // drag, both of which would otherwise cost the canvas its focus — and with
    // it the keymap and the clipboard.
    viewport.containerRef.current?.focus({ preventScroll: true });
    dropHover();
    busy.current = true;

    if (using === "hand") {
      event.preventDefault();
      startPan({ x: event.clientX, y: event.clientY });
      return;
    }

    const point = scenePoint(event);
    if (
      using === "rect" ||
      using === "ellipse" ||
      using === "text" ||
      using === "polygon" ||
      using === "diamond"
    ) {
      event.preventDefault();
      startDraw(using, point);
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
      selection.click(point, { deep: true, ...pickOpts() });
      busy.current = false;
      return;
    }

    // Deep select is the platform's Mod (⌘ on Apple, Ctrl elsewhere) — Alt is
    // fully released to duplicate-on-drag only (`gestures.ts`'s own
    // `mods.alt`, untouched here).
    const deep = isModKey(event);
    const mods: ClickMods = { shift: event.shiftKey, deep, ...pickOpts() };
    const resolved = selection.resolveAt(point, mods);
    const hit = resolved.target?.id ?? null;

    // ⌘-drag through a frame: decided from the same walk `probe` would have
    // done (one `hitTestAll`, not two — `resolveAt` hands back the candidate
    // list `marqueeThroughTarget` reads), and evaluated BEFORE any selection
    // change or move-vs-marquee branching below — independent of whether the
    // frame is already selected. Figma's Cmd/Ctrl-drag unconditionally means
    // "select within, don't move the container".
    const through = marqueeThroughTarget(resolved, { deep, shift: event.shiftKey });
    if (through) {
      event.preventDefault();
      startMarquee(point, false, through);
      return;
    }

    const frameHeld = spanFrame ?? (sel.ids.length > 0 ? sel.selectionBounds : null);
    const onSelection =
      hit !== null
        ? selection.isSelected(hit)
        : frameHeld !== null && withinSelectionBounds(point, frameHeld);

    // Figma's rule: a press anywhere on the selection's own box — painted or
    // not, one shape or several — drags all of it. What the click *means*
    // for the selection (collapse to the hit, shift-toggle it out, deselect)
    // waits for release, and only happens if no drag started.
    if (onSelection) {
      busy.current = false;
      clickOnRelease(point, mods);
      startMove(event);
      return;
    }

    const clicked = selection.click(point, mods);
    if (clicked === null) {
      event.preventDefault();
      if (canvas && blockId) {
        canvas.gesture.marquee({ x: event.clientX, y: event.clientY }, blockId, event.shiftKey, () => {
          busy.current = false;
        });
      } else {
        startMarquee(point, event.shiftKey);
      }
    } else if (selection.isSelected(clicked)) {
      busy.current = false;
      startMove(event);
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
    if (activeMode) {
      activeMode.onPointerMove?.(event.nativeEvent, modeCtx());
      return;
    }
    if (busy.current || !picking || editPath || gesture.isActive()) return;
    hoverAt.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      // Deep read-only for the same reason the click is: the ring has to
      // promise what the click will actually take. Mod, not Alt — Alt is
      // released to duplicate-on-drag only.
      deep: readOnly || isModKey(event),
    };
    if (hoverFrame.current) return;
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = 0;
      const at = hoverAt.current;
      if (at) selection.hover(scenePoint(at), { deep: at.deep, ...pickOpts() });
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
    if (activeMode) return;
    if (!picking || editPath) return;
    const wanted = asked.current;
    asked.current = null;
    const point = scenePoint(event);
    const opts = pickOpts();
    const chain = hitTestPath(laid, point, opts);
    if (chain.length === 0) return;
    const descending = descends(sel.enteredPath, chain);
    selection.enter(point, opts);
    if (descending) return;
    const ids = selection.getSnapshot().ids;
    if (ids.length !== 1) return;
    const node = findNode(laid, ids[0]);
    if (node?.kind === "path") setOpenPath(node.id);
    else if (wanted && ids[0] === wanted) setEditing(wanted);
  };

  const onContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    // The menu (and the right-click pre-select it would otherwise do) is
    // suppressed for the whole session — a colour pick's own pointerdown
    // handler already ignores anything but the left button.
    if (activeMode) return;
    viewport.containerRef.current?.focus({ preventScroll: true });
    const point = scenePoint(event);
    const layers = selection.candidates(point, pickOpts());
    // Nothing under the pointer: every entry would be dead, so this is a
    // deselect rather than a menu.
    if (layers.length === 0) {
      selection.clear();
      return;
    }
    const layersOnly = isModKey(event);
    // Frontmost candidate only: a selected shape occluded behind the one the
    // user visibly clicked must not suppress the pre-select — a left-click
    // at the same point would select the frontmost shape, and right-click
    // must agree.
    if (!layersOnly && !(layers[0]?.chain.some((n) => selection.isSelected(n.id)) ?? false)) {
      selection.click(point, pickOpts());
    }
    openMenu(event, { layers, layersOnly });
  };

  /**
   * A label edit that streamed opens a gesture bracket on its first live
   * commit and closes it at the blur — so however many word-pace dispatches
   * went out (each one reaching collaborators as it lands), undo answers with
   * ONE step, and a remote scene arriving mid-edit waits for the bracket the
   * way it does for any gesture.
   */
  const liveLabel = useRef<NodeId | null>(null);

  /**
   * A text sized by its words has told us its box. Written only when it is
   * news, to the half pixel: the observer reports on every layout, and a
   * write that changed nothing would still travel to every other tab.
   */
  const onMeasure = useCallback(
    (id: NodeId, w: number, h: number) => {
      const node = store.getNode(id);
      if (!node) return;
      if (Math.abs(node.w - w) < 0.5 && Math.abs(node.h - h) < 0.5) return;
      store.measure([{ id, x: node.x, y: node.y, w, h }]);
    },
    [store],
  );

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
      changeTool("move");
    },
    [selection, changeTool],
  );

  /** Escape, Enter, or a press on empty canvas: out of the points, onto the path. */
  const onPenFinish = useCallback(
    (id: NodeId | null) => {
      settleTool();
      if (id) selection.select([id]);
    },
    [selection, settleTool],
  );

  const height = sceneBlockHeight(scene);
  /** What this diagram has selected — the band shows its edge, its grid and its grip. */
  const holding = sel.ids.length > 0 || sel.edges.length > 0;

  const onGripDown = (event: ReactPointerEvent) => {
    const el = wrap.current;
    if (event.button !== 0 || !el) return;
    event.preventDefault();
    const startY = event.clientY;
    const startH = el.offsetHeight;
    const scale = effectiveScale(el);
    const floor = bandFloor(store.getScene());
    let next = startH;
    drag(
      (move) => {
        next = Math.max(floor, Math.round(startH + (move.clientY - startY) / scale));
        // Written straight to the element; React learns the number once, from
        // the source this commits.
        el.style.height = `${next}px`;
      },
      () => setDiagram({ h: next }),
    );
  };

  const surface = useMemo(() => toCss(scene.style), [scene.style]);

  // A box, its handles and a hover ring around a path whose points are open
  // would be three things to grab that all mean "the whole shape". Figma drops
  // them for the same reason: in vector edit mode the anchors are the chrome.
  const framed = picking && !editPath;
  const spanning = spanFrame !== null;
  const own = sel.selectionBounds;
  const members = useMemo(
    () => (spanning && sel.ids.length === 1 ? [own] : sel.memberBounds),
    [spanning, sel.ids.length, own, sel.memberBounds],
  );
  const frameShown = spanning ? (leadsFrame ? spanFrame : null) : sel.ids.length ? own : null;

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
      data-wide={wide || undefined}
      data-holding={holding || undefined}
      data-ground={(!frame && hasGround(scene.style)) || undefined}
      {...undoScope}
      style={
        frame
          ? { width: frame.w * frame.scale, height: frame.h * frame.scale }
          : { width: bandWidth(scene), height }
      }
    >
      <div
        ref={containerRef}
        className="nt-canvas-viewport"
        style={surface}
        data-tool={tool}
        data-mode={activeMode?.id}
        tabIndex={0}
        onFocus={publish}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={() => {
          if (activeMode) {
            activeMode.onPointerLeave?.(modeCtx());
            return;
          }
          dropHover();
          selection.hover(null);
        }}
        onDoubleClick={readOnly ? undefined : onDoubleClick}
        onContextMenu={readOnly ? undefined : onContextMenu}
      >
        {/* The dots, under everything, only while the diagram holds a
            selection. Kept in step with the scene by `useViewport`. */}
        <div ref={gridRef} className="nt-canvas-grid" aria-hidden />
        <div ref={sceneRef} className="nt-canvas-scene">
          {/* Under the shapes: a connector reads as running behind the things
              it joins, and its arrowhead lands on the box edge either way. */}
          <EdgeLayer
            scene={laid}
            viewport={viewport}
            selected={sel.edgeSelected}
            hoverId={hoverEdge}
            // Unattached rather than ignored, so a press on a connector falls
            // through to the surface like everywhere else.
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
              onMeasure={readOnly ? undefined : onMeasure}
            />
          ))}
          <Overlay
            ref={overlay}
            viewport={viewport}
            selection={framed ? frameShown : null}
            members={framed ? members : NO_MEMBERS}
            ids={spanning ? NO_IDS : sel.ids}
            hover={framed ? sel.hoverBounds : null}
            onResizeStart={startResize}
            onRotateStart={startRotate}
            // Withheld read-only, which is also what stops the overlay reading
            // a shape's corner radii off the DOM to place anchors nobody gets.
            onRadiusStart={readOnly ? undefined : gesture.startRadius}
            readOnly={readOnly}
          />
        </div>

        {/* One connector per pick, like every tool, unless the tool is locked
            for a run of them; the new edge is selected as it lands. */}
        {/* Neither overlay is offered while a mode (the eyedropper, today)
            owns the pointer — both cover the whole viewport with their own
            handlers, and a pick click landing on one would add an anchor or
            start an edge instead of resolving the pick. Not rendering them
            at all is simpler and more certain than teaching either overlay
            about `data-mode` itself. */}
        {!activeMode && tool === "connector" && (
          <ConnectorTool
            store={store}
            viewport={viewport}
            selection={selection}
            onLanded={settleTool}
          />
        )}

        {!activeMode && (tool === "pen" || editPath) && (
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
        <div
          className="nt-canvas-grip"
          role="separator"
          aria-label="Resize canvas height"
          title="Drag to resize · double-click to fit"
          onPointerDown={onGripDown}
          onDoubleClick={fit}
        />
      )}

      {menu}
    </div>
  );
}
