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
import { prepareBooleans, reflowBooleans, type LiveBooleans } from "./liveBoolean";
import { useTransformGesture,
  type LiveFrame,
} from "../engine/gestures";
import { isModKey, useCanvasShortcuts, type CanvasTool } from "../engine/shortcuts";
import { createScreenControl, recentre, type ScreenControl, type ScreenHost } from "../engine/screen";
import type { SnapGuide } from "../engine/snapping";
import { createSurfaceModes, type SurfaceModeContext, type SurfaceModes } from "../engine/surfaceMode";
import { useScene, useSceneSnapshot, type SceneStore } from "../engine/useScene";
import { ZOOM_DRAG_MIN, zoomToolResult } from "../engine/zoomTool";
import {
  descends,
  marqueeThroughTarget,
  useSelection,
  useSelectionStore,
  type ClickMods,
  type SelectionStore,
} from "../engine/useSelection";
import { MAX_ZOOM, useViewport, type ViewportController } from "../engine/useViewport";
import type { DiagramPatch } from "../panels/StylePanel";
import { undoScope } from "@/app/lib/history/useWorkspaceHistory";
import {
  absoluteBounds,
  absoluteSelectionBounds,
  normalizeRect,
  toLocal,
  type RotatedRect,
} from "../scene/geometry";
import { hitTestPath, slopFor } from "../scene/picking";
import { laidOutScene } from "../scene/autoLayout";
import { revealBounds } from "../scene/reveal";
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
import { useSceneFonts } from "./fonts";
import { ShapeView, toCss } from "./ShapeView";
import "../canvas.css";

/** How long the stage takes to open or close. */
const STAGE_MS = 420;
/**
 * The curve for it — and the glide solves the same one, so the surface and the
 * diagram arrive together. Quick off the mark and settling short, so it reads
 * as a snap into place; not `--ease`, which does so much of its travel in the
 * first frames that over a move this large it looks like a cut.
 */
const STAGE_CURVE = [0.3, 0, 0, 1] as const;
const STAGE_EASE = `cubic-bezier(${STAGE_CURVE.join(", ")})`;
/** The block's own corner (`--radius-lg`), as a length a keyframe can hold. */
const BLOCK_RADIUS = "10px";

/** The clip that shows only `inner` of a box laid out at `outer`. */
function insetFrom(outer: DOMRect, inner: DOMRect, round: string): string {
  const top = inner.top - outer.top;
  const right = outer.right - inner.right;
  const bottom = outer.bottom - inner.bottom;
  const left = inner.left - outer.left;
  return `inset(${top}px ${right}px ${bottom}px ${left}px round ${round})`;
}

/** Kept clear either side, so a widened block cannot reach the window's edge. */
const CANVAS_GUTTER = 32;

/** The screen's canvas chrome. A press in it is not a press outside the canvas.
 *  The mention and inspector menus are portalled to the body but speak for a
 *  label or control being edited here, so a press on either remains inside. */
const CANVAS_CHROME = ".nt-lyr, .nt-style-panel, .nt-toolbar, .nt-ctx, .nt-mention-anchor, .nt-menu";

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

/** Four corner brackets, straight — the un-rounded `FIT_ICON` family, at the
 *  true corners rather than the content's. */
const EXPAND_ICON = (
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
    <path d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6" />
  </svg>
);

/** {@link EXPAND_ICON}'s own corners, drawn inset — the frame pulled back in. */
const COLLAPSE_ICON = (
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
    <path d="M7 11V7h4M13 7h4v4M17 13v4h-4M11 17H7v-4" />
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
      onPointerDown={(event) => {
        event.preventDefault();
        // Now a child of `.nt-canvas-viewport` (so it stays visible over the
        // stage's fixed viewport rather than the in-flow wrapper) — without
        // this the press would also read as a click on the surface behind it.
        event.stopPropagation();
      }}
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
 * A storyboard shot has its own "open full screen" chrome; a plain diagram
 * had only the settings menu's "Stage" checkbox, which nobody finds by
 * looking at the canvas. Same corner, same hover-reveal, same toggle
 * `screen.toggle("stage")` already backs from the menu — this is just a
 * second, visible door to it.
 *
 * Its own component, subscribed to `screen` on its own — not read in
 * `CanvasSurface`'s own render — for the same reason {@link Refit} is: a
 * `useSyncExternalStore` there would re-render the whole surface (and every
 * memoised shape under it) on every stage toggle, not just this button. The
 * canvas-stage gate's own zero-write assertions on leaving the stage are
 * exactly what caught that the first time.
 */
function ExpandButton({
  screen,
  frameContent,
}: {
  screen: ScreenControl;
  frameContent: () => void;
}) {
  const stage = useSyncExternalStore(
    screen.subscribe,
    () => screen.get().stage,
    () => false,
  );
  return (
    <button
      type="button"
      className="nt-canvas-expand"
      aria-label={stage ? "Collapse canvas" : "Expand canvas"}
      aria-pressed={stage}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => {
        const entering = !screen.get().stage;
        screen.toggle("stage");
        // `screen.toggle` itself keeps the settings menu's exact contract
        // (the same scene point stays centred entering, and leaving
        // restores the exact camera) — the fit-to-content this button adds
        // is a separate step, after the toggle has already forced the
        // container's layout to settle at its new size.
        if (entering) frameContent();
      }}
    >
      {stage ? COLLAPSE_ICON : EXPAND_ICON}
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
  /**
   * The exclusive pointer-mode slot (COLOR, shared with SELECT/STAGE) — see
   * `engine/surfaceMode.ts`. A colour pick, a future layer-menu pick, or a
   * zoom-tool drag registers a mode here instead of adding a parallel branch
   * to this component's own pointer handlers.
   */
  modes: SurfaceModes;
  /** Screen modes for this canvas (STAGE). `set` is a no-op on a read-only or
   *  framed surface. */
  screen: ScreenControl;
  tools: ToolControl;
  setTool(tool: CanvasTool): void;
  /** The diagram's own fields — `StylePanel`'s `onDiagramChange`. */
  setDiagram(patch: DiagramPatch): void;
  /**
   * Bring shapes into view — the ones an edit from outside just added, which
   * the user did not place and so cannot be looking at. The view eases only
   * as far as it must (see `revealBounds`) and never zooms IN past where the
   * user had it: a small addition is shown where it is, not blown up.
   */
  reveal(ids: readonly NodeId[]): void;
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
   * Keeps the scene store — and its undo history — warm across unmounts,
   * shared under this key. See {@link useScene}.
   */
  storeKey?: string;
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
  storeKey,
  frame,
}: CanvasSurfaceProps) {
  const store = useScene({ source, onChange, cacheKey: storeKey });
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

  const wrap = useRef<HTMLDivElement>(null);
  const overlay = useRef<OverlayApi>(null);

  // ---------------------------------------------------------------------
  // Screen modes (STAGE): expanded stage, minimal UI, browser fullscreen.
  // Pure view state — no scene op, no React state on the camera path. The
  // host below is the only thing that touches the DOM for it; `wrap` and
  // `containerRef` are refs, so its callbacks always read the live element
  // even though the host object itself is built exactly once.
  // ---------------------------------------------------------------------
  const stageResize = useRef<ResizeObserver | null>(null);
  const stageLastSize = useRef<{ w: number; h: number } | null>(null);
  const stageWheelSwallow = useRef<((e: WheelEvent) => void) | null>(null);
  // The opening or closing in flight, so a toggle mid-way can stop it cleanly.
  const stageMorph = useRef<{ animations: Animation[]; cancel: () => void } | null>(null);

  const [screenHost] = useState<ScreenHost>(() => ({
    // A storyboard shot's viewport is locked to its frame and a read-only
    // surface has no toolbar to reach any of this from — both read here once,
    // like `useViewport`'s own `locked` option, since neither ever flips for
    // a mounted canvas.
    enabled: !readOnly && !frame,
    applyStage(on) {
      const el = containerRef.current;
      const wrapEl = wrap.current;
      if (!el || !wrapEl) return;
      // A toggle while the last one is still moving takes over from wherever
      // that one had got to.
      stageMorph.current?.cancel();
      stageMorph.current = null;

      stageResize.current?.disconnect();
      stageResize.current = null;
      if (stageWheelSwallow.current) {
        wrapEl.removeEventListener("wheel", stageWheelSwallow.current);
        stageWheelSwallow.current = null;
      }

      const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

      if (!on && !still && wrapEl.hasAttribute("data-stage")) {
        // Closing plays the opening backwards while the stage is still the
        // stage: the surface draws back in to the block's own box and the
        // diagram glides to where it will sit in the page, and only then does
        // the stage stand down — so the swap itself moves nothing.
        const from = el.getBoundingClientRect();
        const to = wrapEl.getBoundingClientRect();
        const inView = to.bottom > 0 && to.top < window.innerHeight;
        if (inView) {
          const home = recentre(
            viewport.get(),
            { w: el.clientWidth, h: el.clientHeight },
            { w: to.width, h: to.height },
          );
          viewport.glideTo(
            { x: home.x + (to.left - from.left), y: home.y + (to.top - from.top), zoom: home.zoom },
            STAGE_MS,
            STAGE_CURVE,
          );
          const round = getComputedStyle(el).borderTopLeftRadius;
          const clip = el.animate(
            [
              { clipPath: `inset(0px round ${round})` },
              { clipPath: insetFrom(from, to, BLOCK_RADIUS) },
            ],
            { duration: STAGE_MS, easing: STAGE_EASE, fill: "forwards" },
          );
          let done = false;
          const land = () => {
            if (done) return;
            done = true;
            stageMorph.current = null;
            wrapEl.toggleAttribute("data-stage", false);
            document.body.toggleAttribute("data-nt-staged", false);
            viewport.set(home);
            clip.cancel();
          };
          clip.onfinish = land;
          stageMorph.current = {
            animations: [clip],
            // Taken over by an opening: stop where it stands, still staged.
            cancel: () => {
              done = true;
              clip.cancel();
            },
          };
          return;
        }
      }

      const from = el.getBoundingClientRect();
      const before = { w: el.clientWidth, h: el.clientHeight };
      wrapEl.toggleAttribute("data-stage", on);
      // Said on the body too, for the chrome that is portalled there and so
      // sits outside anything the stage covers — the block handles.
      document.body.toggleAttribute("data-nt-staged", on);
      // The one forced layout per toggle: the attribute above just changed
      // `.nt-canvas-viewport`'s `position`, and the container's own box only
      // reflects that once the browser has recomputed it.
      const after = { w: el.clientWidth, h: el.clientHeight };
      const target = recentre(viewport.get(), before, after);

      if (on && !still) {
        // Opening floods out of the block: the stage's surface starts clipped
        // to the block's own box and opens to the whole column, the dots
        // spread outward from where the block was, and the diagram starts
        // exactly where it sat in the page and glides to its place on the
        // stage — one movement, rather than a cut to a larger box.
        const to = el.getBoundingClientRect();
        const now = viewport.get();
        viewport.set({ x: now.x + (from.left - to.left), y: now.y + (from.top - to.top), zoom: now.zoom });
        viewport.glideTo(target, STAGE_MS, STAGE_CURVE);
        // The stage's own corner: the sheet's, inside the shell, or none when
        // the interface is hidden and the stage is the whole window.
        const round = getComputedStyle(el).borderTopLeftRadius;
        const animations = [
          el.animate(
            [
              { clipPath: insetFrom(to, from, BLOCK_RADIUS) },
              { clipPath: `inset(0px round ${round})` },
            ],
            { duration: STAGE_MS, easing: STAGE_EASE },
          ),
        ];
        const grid = gridRef.current;
        if (grid) {
          const cx = from.left + from.width / 2 - to.left;
          const cy = from.top + from.height / 2 - to.top;
          // Big enough that its solid middle covers the far corner from any
          // starting point: the ring passes out of the stage before it ends.
          const d = 3 * Math.hypot(to.width, to.height);
          const ring = {
            maskImage: "radial-gradient(circle closest-side, #000 72%, transparent)",
            maskRepeat: "no-repeat",
          };
          animations.push(
            grid.animate(
              [
                { ...ring, maskSize: "0px 0px", maskPosition: `${cx}px ${cy}px` },
                { ...ring, maskSize: `${d}px ${d}px`, maskPosition: `${cx - d / 2}px ${cy - d / 2}px` },
              ],
              { duration: STAGE_MS + 120, easing: STAGE_EASE },
            ),
          );
        }
        stageMorph.current = {
          animations,
          cancel: () => animations.forEach((a) => a.cancel()),
        };
      } else {
        viewport.set(target);
      }

      if (!on) {
        // A real, reproducible Chromium quirk on exactly this transition
        // (`position:fixed` → `position:absolute` via an ancestor attribute,
        // confirmed by this canvas's own browser tests): the forced layout
        // read above can still serve a stale containing-block size for `el`
        // — `position` updates immediately but the resolved inset can lag by
        // one rule generation, self-correcting only once something later
        // gives the browser a further opportunity to settle. Entering gets
        // that opportunity for free from the resize observer's own mandatory
        // initial notification (below), which is why only leaving needs this:
        // verify the real settled size shortly after, and issue one
        // corrective `recentre` only if it actually differs. A browser that
        // never hits the quirk pays one comparison and no extra `viewport.set`.
        requestAnimationFrame(() => setTimeout(() => {
          const real = { w: el.clientWidth, h: el.clientHeight };
          if (real.w !== after.w || real.h !== after.h) {
            viewport.set(recentre(viewport.get(), after, real));
          }
        }, 50));
        return;
      }

      stageLastSize.current = after;
      const observer = new ResizeObserver(() => {
        const now = { w: el.clientWidth, h: el.clientHeight };
        const last = stageLastSize.current ?? now;
        // The observer's first notice is the size it already has. Setting the
        // view for it would cancel the opening glide in its first frame.
        if (now.w === last.w && now.h === last.h) return;
        viewport.set(recentre(viewport.get(), last, now));
        stageLastSize.current = now;
      });
      observer.observe(el);
      stageResize.current = observer;

      // Whatever the viewport's own wheel handler declined (nothing left to
      // reveal) must not fall through to the page scrolling under the stage.
      const onWheel = (e: WheelEvent) => {
        if (!e.defaultPrevented) e.preventDefault();
      };
      wrapEl.addEventListener("wheel", onWheel, { passive: false });
      stageWheelSwallow.current = onWheel;

      // A label being edited keeps its caret; otherwise the stage takes focus
      // so the keymap and the clipboard are live the instant it opens.
      if (!wrapEl.contains(document.activeElement)) {
        el.focus({ preventScroll: true });
      }

      if (process.env.NODE_ENV !== "production") {
        // A frame, then a short real delay — not a bare `requestAnimationFrame`.
        // This is a dev-only diagnostic (never runs in production, and nobody
        // times a devtools warning to the millisecond), so it can afford to
        // wait out a compositor that has vsync decoupled from real display
        // refresh — headless Chromium launched with `--disable-frame-rate-limit`,
        // as this canvas's own browser test suite does — where a bare rAF can
        // still fire a frame ahead of the layout this toggle just asked for.
        // A genuine regression stays wrong regardless of how long this waits;
        // only the false positive goes away.
        requestAnimationFrame(() => setTimeout(() => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(document.documentElement);
          const left = parseFloat(style.getPropertyValue("--nt-stage-l")) || 0;
          const right = parseFloat(style.getPropertyValue("--nt-stage-r")) || 0;
          // Top and bottom are the stage's own: the sheet's margin inside the
          // shell, nothing when the interface is hidden.
          const own = getComputedStyle(el);
          const expected = {
            top: parseFloat(own.top) || 0,
            left,
            right: window.innerWidth - right,
            bottom: window.innerHeight - (parseFloat(own.bottom) || 0),
          };
          const within = (a: number, b: number) => Math.abs(a - b) <= 1;
          if (
            !within(rect.top, expected.top) ||
            !within(rect.left, expected.left) ||
            !within(rect.right, expected.right) ||
            !within(rect.bottom, expected.bottom)
          ) {
            // Never throw — a layout regression elsewhere must not take the
            // canvas down with it. This is the automated backstop for the
            // layering proof in canvas.css's "Screen modes" section.
            console.error(
              "[stage] viewport rect does not match the fixed-position contract",
              { rect, expected },
            );
          }
        }, 50));
      }
    },
    canFullscreen() {
      return (
        typeof document !== "undefined" &&
        document.fullscreenEnabled === true &&
        typeof document.documentElement.requestFullscreen === "function"
      );
    },
    requestFullscreen() {
      return document.documentElement.requestFullscreen();
    },
    exitFullscreen() {
      return document.fullscreenElement ? document.exitFullscreen() : Promise.resolve();
    },
  }));
  const [screen] = useState<ScreenControl>(() => createScreenControl(screenHost));

  // The browser already left fullscreen (Esc, F11, a native chrome control):
  // record it without asking the host to exit again — it already has.
  useEffect(() => {
    const onChange = () => {
      if (screen.get().fullscreen && document.fullscreenElement === null) {
        screen.sync({ fullscreen: false });
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    // Captured once per mount, not read fresh in the cleanup below: the
    // wrapper element does not change identity for the life of this canvas.
    const wrapEl = wrap.current;
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      // A canvas unmounting (another page opened) must not leave the whole
      // window stuck in fullscreen for whatever replaces it.
      if (screen.get().fullscreen && document.fullscreenElement) {
        void document.exitFullscreen();
      }
      stageResize.current?.disconnect();
      stageMorph.current?.cancel();
      if (stageWheelSwallow.current) {
        wrapEl?.removeEventListener("wheel", stageWheelSwallow.current);
      }
      // Only if it was this canvas that was staged: the flag hides the page's
      // handles, and another page's would stay hidden for good.
      if (wrapEl?.hasAttribute("data-stage")) {
        document.body.removeAttribute("data-nt-staged");
      }
    };
  }, [screen]);

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
  // would land after it. So `changeTool` is the only way to switch: a bare
  // `setTool` moves the surface and leaves the toolbar and the keymap behind.
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
    booleans: LiveBooleans;
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
          booleans: prepareBooleans(store.getScene(), selection.getSnapshot().ids, getElement),
        };
        return;
      }
      held.current = null;
      requestAnimationFrame(() => reflowLive());
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
      if (inFrame && (next === "hand" || next === "connector" || next === "zoom")) return;
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
    screen,
    enabled: !readOnly,
  });

  // The Alt cursor for the zoom tool — imperative, so holding Alt costs no
  // render. Armed only while the tool is actually selected.
  useEffect(() => {
    if (tool !== "zoom") return;
    const el = viewport.containerRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => el.toggleAttribute("data-zoom-out", e.altKey);
    const onBlur = () => el.removeAttribute("data-zoom-out");
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
      el.removeAttribute("data-zoom-out");
    };
  }, [tool, viewport]);

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

  const reveal = useCallback(
    (ids: readonly NodeId[]) => {
      if (inFrame) return;
      const laid = laidOutScene(store.getScene());
      const present = ids.filter((id) => {
        const node = findNode(laid, id);
        return node && !node.hidden;
      });
      if (!present.length) return;
      const seen = visibleRect(viewport);
      if (!seen) return;
      const to = revealBounds(absoluteSelectionBounds(laid, present), seen);
      if (to) viewport.zoomToFit(to, { maxZoom: viewport.get().zoom });
    },
    [store, viewport, inFrame],
  );

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
      modes,
      screen,
      tools: toolControl,
      setTool: changeTool,
      setDiagram,
      reveal,
      previewSize,
      previewStyle,
    }),
    [
      store,
      selection,
      viewport,
      modes,
      screen,
      toolControl,
      changeTool,
      reveal,
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

  /** Scene-px grab slop at the current zoom, packaged for a store call —
   *  PICK's shared `slopFor` (§2.1/§9), so a click, a hover, a double-click
   *  and the context menu never disagree about what counts as "on" a thin
   *  stroke at the same pixel. Every pointer-anchored call below spreads
   *  this rather than deriving its own tolerance (SELECT §1.4 — this *is*
   *  that one shared helper, not a second tolerance closure). */
  const pickOpts = () => ({ tolerance: slopFor(viewport.get().zoom) });

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

  /** The container-relative (viewport px) point a pointer event landed at —
   *  what `zoomToolResult`'s `down`/`up` want, distinct from the scene point
   *  `scenePoint` gives every other gesture here. */
  const viewportPoint = (event: { clientX: number; clientY: number }): Point => {
    const rect = viewport.containerRef.current?.getBoundingClientRect();
    return rect
      ? { x: event.clientX - rect.left, y: event.clientY - rect.top }
      : { x: event.clientX, y: event.clientY };
  };

  /**
   * The zoom tool (Z): click zooms in about the press, Alt-click zooms out,
   * a drag zooms to the region. `picking` is false for `"zoom"`, so hover,
   * double-click and marquee-select are already off — this is the only
   * pointer behaviour the tool has.
   */
  const startZoom = (event: ReactPointerEvent) => {
    const down = viewportPoint(event);
    const fromScene = scenePoint(event);
    let toScene = fromScene;

    drag(
      (move) => {
        toScene = scenePoint(move);
        const travel = Math.hypot(move.clientX - event.clientX, move.clientY - event.clientY);
        overlay.current?.marquee(
          travel >= ZOOM_DRAG_MIN ? normalizeRect(fromScene, toScene) : null,
        );
      },
      (up) => {
        busy.current = false;
        overlay.current?.marquee(null);
        const result = zoomToolResult({
          down,
          up: viewportPoint(up),
          fromScene,
          toScene,
          alt: up.altKey,
        });
        if (result.kind === "by") viewport.zoomBy(result.factor, result.anchor);
        else if (result.kind === "fit") {
          viewport.zoomToFit(result.rect, { padding: 0, maxZoom: MAX_ZOOM });
        }
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
    changeTool("move");
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

    // A colour-pick session (COLOR) already returned above, before this
    // branch — a mode wins over the zoom tool while it is active, which is
    // this file's one documented case of that ordering (build-plan OQ-6):
    // you cannot sensibly draw a zoom-marquee while the eyedropper is up.
    if (tool === "zoom") {
      event.preventDefault();
      startZoom(event);
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

    const onSelection =
      hit !== null
        ? selection.isSelected(hit)
        : sel.ids.length > 0 && withinSelectionBounds(point, sel.selectionBounds);

    // Figma's rule: a press anywhere on the selection's own box — painted or
    // not, one shape or several — drags all of it. What the click *means*
    // for the selection (collapse to the hit, shift-toggle it out, deselect)
    // waits for release, and only happens if no drag started.
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
      changeTool("move");
      if (id) selection.select([id]);
    },
    [selection, changeTool],
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
      {...undoScope}
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
        {/* The ground's dots, under everything, only while the diagram is the
            one being edited. Kept in step with the scene by `useViewport`. */}
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
              onMeasure={readOnly ? undefined : onMeasure}
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
        {/* Neither overlay is offered while a mode (the eyedropper, today)
            owns the pointer — both cover the whole viewport with their own
            handlers, and a pick click landing on one would add an anchor or
            start an edge instead of resolving the pick. Not rendering them
            at all is simpler and more certain than teaching either overlay
            about `data-mode` itself. */}
        {!activeMode && tool === "connector" && (
          <ConnectorTool store={store} viewport={viewport} selection={selection} />
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

        {/* Inside the viewport (not the wrapper), so it stays visible over
            the stage's fixed viewport rather than the in-flow wrapper that
            stays behind it — its own `stopPropagation` keeps a press on it
            from also reading as a click on the surface underneath. */}
        <Refit viewport={viewport} bounds={contentBounds} onFrame={frameContent} />

        {!readOnly && !frame && <ExpandButton screen={screen} frameContent={frameContent} />}
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

      {menu}
    </div>
  );
}
