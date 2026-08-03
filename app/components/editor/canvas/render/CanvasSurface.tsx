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
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { useContextMenu } from "../ContextMenu";
import { ConnectorTool } from "./ConnectorTool";
import { EdgeLayer } from "./EdgeLayer";
import { reflowEdges } from "./liveEdges";
import { useTransformGesture } from "../engine/gestures";
import { useCanvasShortcuts, type CanvasTool } from "../engine/shortcuts";
import type { SnapGuide } from "../engine/snapping";
import { useScene, useSceneSnapshot, type SceneStore } from "../engine/useScene";
import {
  descends,
  useSelection,
  useSelectionStore,
  type SelectionStore,
} from "../engine/useSelection";
import { useViewport, type ViewportController } from "../engine/useViewport";
import type { DiagramPatch } from "../panels/StylePanel";
import {
  absoluteBounds,
  absoluteRect,
  absoluteRotation,
  absoluteSelectionBounds,
  hitTestPath,
  normalizeRect,
  type RotatedRect,
} from "../scene/geometry";
import { mintId } from "../scene/ops";
import { serializeScene } from "../scene/serialize";
import {
  findNode,
  type NodeId,
  type Point,
  type Rect,
  type EdgeId,
  type Scene,
  type StyleMap,
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
import { ShapeView } from "./ShapeView";
import "../canvas.css";

/** Kept clear either side, so a widened block cannot reach the window's edge. */
const CANVAS_GUTTER = 32;

/** The screen's canvas chrome. A press in it is not a press outside the canvas. */
const CANVAS_CHROME = ".nt-lyr, .nt-style-panel, .nt-toolbar, .nt-ctx";

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

/** `border-radius` → `borderRadius`, for the diagram's own declarations. */
function toCss(style: StyleMap): CSSProperties {
  const out: Record<string, string> = {};
  for (const prop in style) {
    const key = prop.startsWith("--")
      ? prop
      : prop.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
    out[key] = style[prop];
  }
  return out as CSSProperties;
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

function frameOf(scene: Scene, id: NodeId): RotatedRect {
  return { ...absoluteRect(scene, id), rot: absoluteRotation(scene, id) };
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
 * How the screen reaches one canvas: the stores for the panels, the viewport
 * and the tool for the toolbar, and the one write that is not an op.
 */
export interface CanvasApi {
  store: SceneStore;
  selection: SelectionStore;
  viewport: ViewportController;
  tool: CanvasTool;
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
}

export interface CanvasSurfaceProps {
  /** The block's persisted string: canvas HTML, or legacy JSON. */
  source: string;
  onChange: (source: string) => void;
  /**
   * Published on mount, whenever the canvas takes focus and on every tool
   * change; `null` on unmount. The shell holds the latest and mounts the
   * toolbar and the panels against it.
   */
  onApi?: (api: CanvasApi | null) => void;
}

export function CanvasSurface({ source, onChange, onApi }: CanvasSurfaceProps) {
  const store = useScene({ source, onChange });
  const scene = useSceneSnapshot(store);
  const viewport = useViewport();
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
   */
  const onEdgePick = useCallback(
    (id: EdgeId, event: React.PointerEvent) => {
      event.stopPropagation();
      if (event.shiftKey) selection.toggleEdge(id);
      else selection.selectEdges([id]);
      containerRef.current?.focus({ preventScroll: true });
    },
    [selection, containerRef],
  );
  /** True while one of this component's own drags owns the pointer. */
  const busy = useRef(false);
  /** The node whose double-click asked to edit its label, this event. */
  const asked = useRef<NodeId | null>(null);

  const [tool, setTool] = useState<CanvasTool>("move");
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

  const latest = useRef({ tool, onChange, onApi });
  // Latest-callback refs: written in an effect, never during render.
  useEffect(() => {
    latest.current = { tool, onChange, onApi };
  });

  /**
   * The diagram's own properties, which are the block's source rather than an
   * op. The store recognises the write coming back and adopts it, so it stays
   * one undoable step and the scene is never rebuilt behind a live gesture.
   */
  const setDiagram = useCallback(
    (patch: DiagramPatch) => {
      const current = store.getScene();
      const style = { ...current.style };
      for (const [prop, value] of Object.entries(patch.style ?? {})) {
        if (value === undefined) delete style[prop];
        else style[prop] = value;
      }
      const attrs = { ...current.attrs };
      if (patch.h !== undefined) attrs[HEIGHT_ATTR] = FIXED;
      if (patch.w !== undefined) attrs[WIDTH_ATTR] = FIXED;
      latest.current.onChange(
        serializeScene({
          ...current,
          w: patch.w ?? current.w,
          h: patch.h ?? current.h,
          style,
          attrs,
        }),
      );
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
      const current = store.getScene();
      if (current.attrs[attr] === undefined) return;
      const attrs = { ...current.attrs };
      delete attrs[attr];
      latest.current.onChange(serializeScene({ ...current, attrs }));
    },
    [store],
  );

  const getElement = useCallback(
    (id: NodeId) =>
      viewport.sceneRef.current?.querySelector<HTMLElement>(
        `[data-id="${CSS.escape(id)}"]`,
      ) ?? null,
    [viewport],
  );

  /**
   * The shapes' live boxes, read from the DOM rather than the scene: mid-drag
   * the elements have moved and the model has not, and the element is the only
   * one of the two telling the truth. Falls back to the scene for anything not
   * rendered — a node inside a collapsed branch has no element to measure.
   */
  const reflowLive = useCallback(() => {
    const scene = store.getScene();
    if (scene.edges.length === 0) return;
    reflowEdges(sceneRef.current, scene, (id) => {
      const el = getElement(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const a = viewport.clientToScene({ x: r.left, y: r.top });
      const b = viewport.clientToScene({ x: r.right, y: r.bottom });
      return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    });
  }, [store, sceneRef, getElement, viewport]);

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
      if (!active) requestAnimationFrame(reflowLive);
    },
  });

  /**
   * Picking a tool leaves vector edit mode. The pen overlay sits above the
   * whole surface, so a tool chosen underneath it would be a tool you could not
   * reach — and the tool bar showing something the surface is not doing.
   */
  const changeTool = useCallback((next: CanvasTool) => {
    setOpenPath(null);
    setTool(next);
  }, []);

  const toolControl = useMemo(
    () => ({ get: () => latest.current.tool, set: changeTool }),
    [changeTool],
  );

  const pathControl = useMemo(() => ({ set: setOpenPath }), []);

  useCanvasShortcuts({
    scene: store,
    selection,
    viewport,
    tool: toolControl,
    pathEdit: pathControl,
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
    const ids = store
      .getScene()
      .nodes.filter((node) => !node.hidden)
      .map((node) => node.id);
    if (!ids.length) return;
    viewport.zoomToFit(absoluteSelectionBounds(store.getScene(), ids));
  }, [store, viewport]);

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
      tool,
      setTool: changeTool,
      setDiagram,
      previewSize,
      previewStyle,
    }),
    [
      store,
      selection,
      viewport,
      tool,
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

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button !== 0 || viewport.panState() !== "idle") return;
    // Every branch below either captures the pointer or suppresses the default
    // drag, both of which would otherwise cost the canvas its focus — and with
    // it the keymap and the clipboard.
    viewport.containerRef.current?.focus({ preventScroll: true });
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
    if (tool !== "move" || editPath) {
      busy.current = false;
      return;
    }

    const hit = selection.click(point, {
      shift: event.shiftKey,
      deep: event.altKey,
    });
    if (hit === null) {
      event.preventDefault();
      startMarquee(point, event.shiftKey);
    } else if (selection.isSelected(hit)) {
      busy.current = false;
      gesture.startMove(event);
    } else {
      // A shift-click that removed a node from the selection is not the start
      // of a drag of what is left.
      busy.current = false;
    }
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    if (busy.current || tool !== "move" || editPath || gesture.isActive()) return;
    selection.hover(scenePoint(event), { deep: event.altKey });
  };

  /**
   * Double-click means three different things, and only the scene can say
   * which: a group under the pointer is "go inside", a vector is "open its
   * points", and any other shape at the level we are already in is "edit its
   * label" — which the shape itself asked for on the way up. Empty canvas means
   * nothing at all; shapes come from the toolbar.
   */
  const onDoubleClick = (event: ReactMouseEvent) => {
    if (tool !== "move" || editPath) return;
    const wanted = asked.current;
    asked.current = null;
    const point = scenePoint(event);
    const chain = hitTestPath(scene, point);
    if (chain.length === 0) return;
    const descending = descends(sel.enteredPath, chain);
    selection.enter(point);
    if (descending) return;
    const ids = selection.getSnapshot().ids;
    if (ids.length !== 1) return;
    const node = findNode(scene, ids[0]);
    if (node?.kind === "path") setOpenPath(node.id);
    else if (wanted && ids[0] === wanted) setEditing(wanted);
  };

  const onContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    viewport.containerRef.current?.focus({ preventScroll: true });
    const point = scenePoint(event);
    const chain = hitTestPath(scene, point);
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

  const onEditEnd = useCallback(
    (id: NodeId, label: string) => {
      store.dispatch({ type: "setLabel", id, label });
      setEditing((current) => (current === id ? null : current));
    },
    [store],
  );

  const onEditStart = useCallback((id: NodeId) => {
    asked.current = id;
  }, []);

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
  const framed = tool === "move" && !editPath;

  const members = useMemo(
    () =>
      framed && sel.ids.length > 1
        ? sel.ids.map((id) => frameOf(scene, id))
        : NO_MEMBERS,
    [scene, sel.ids, framed],
  );

  const hover = useMemo(() => {
    const id = sel.hoverId;
    if (!id || !framed || sel.ids.includes(id)) return null;
    return frameOf(scene, id);
  }, [scene, sel.hoverId, sel.ids, framed]);

  /** Every visible node's box, which is what tells us the content is lost. */
  const contentBounds = useMemo(
    () =>
      scene.nodes
        .filter((node) => !node.hidden)
        .map((node) => absoluteBounds(scene, node.id)),
    [scene],
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
      className="nt-canvas"
      contentEditable={false}
      style={width === null ? { height } : { height, width }}
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
        onPointerLeave={() => selection.hover(null)}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        <div ref={sceneRef} className="nt-canvas-scene">
          {/* Under the shapes: a connector reads as running behind the things
              it joins, and its arrowhead lands on the box edge either way. */}
          <EdgeLayer
            scene={scene}
            selected={sel.edgeSelected}
            hoverId={hoverEdge}
            onPick={onEdgePick}
            onHover={setHoverEdge}
          />
          {scene.nodes.map((node) => (
            <ShapeView
              key={node.id}
              node={node}
              editingId={editing}
              onEditStart={onEditStart}
              onEditEnd={onEditEnd}
            />
          ))}
          <Overlay
            ref={overlay}
            viewport={viewport}
            selection={framed && sel.ids.length ? sel.selectionBounds : null}
            members={members}
            ids={sel.ids}
            hover={hover}
            onResizeStart={gesture.startResize}
            onRotateStart={gesture.startRotate}
            onRadiusStart={gesture.startRadius}
          />
        </div>

        {tool === "connector" && (
          <ConnectorTool
            store={store}
            viewport={viewport}
            selection={selection}
            // Figma drops back to the move tool once a connector lands, so a
            // second drag does not silently start another one; a drag that came
            // to nothing leaves the tool up, because you meant to draw.
            onFinish={(created) => created && changeTool("move")}
          />
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

        {scene.nodes.length === 0 && (
          <p className="nt-canvas-hint">Pick a shape from the toolbar</p>
        )}
      </div>

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

      <Refit viewport={viewport} bounds={contentBounds} onFrame={frameContent} />

      {menu}
    </div>
  );
}
