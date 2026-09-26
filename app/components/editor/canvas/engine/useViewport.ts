"use client";

/**
 * The canvas viewport — where the scene layer sits in its container, and the
 * conversions every gesture reads, without re-rendering the scene.
 *
 * ## Nothing here moves on input
 *
 * A diagram on the page is a band of the document, not a window onto an
 * endless surface: its content is laid out in the column's own coordinates,
 * so there is nowhere to pan to and no zoom of its own to choose. The page
 * scrolls; the diagram scrolls with it. What is left is placement, written by
 * the host:
 *
 *  - `{0, 0, 1}` for a band, whose origin is the text column's left edge;
 *  - `{WIDE_MARGIN, 0, 1}` for a wide band, whose container reaches past the
 *    column on both sides while the scene's origin stays on the text edge;
 *  - `{0, 0, scale}` for a storyboard shot, drawn at whatever size its column
 *    asks for.
 *
 * ## Why the viewport is not React state
 *
 * A shot rescales on every frame its column is resized, and a render per frame
 * would reconcile every shape in it. So the viewport lives in a closure, the
 * transform is written directly onto **one** element, and anything that
 * genuinely needs to re-render opts in through
 * {@link ViewportController.subscribe}.
 *
 * ## The DOM this expects
 *
 * ```tsx
 * const vp = useViewport();
 * <div ref={vp.containerRef} style={{ position: "relative" }}>
 *   <div ref={vp.sceneRef} style={{ position: "absolute", inset: 0 }}>
 *     …shapes, absolutely positioned in scene px…
 *   </div>
 * </div>
 * ```
 *
 * The container receives input; the scene layer carries the transform. The
 * hook owns three of the scene layer's inline properties — `transform`,
 * `transform-origin` and `will-change`. Don't set those from the host.
 *
 * Note what is deliberately NOT here: `--k`, one screen px in scene units,
 * which anything holding its screen size counter-scales through. Publishing
 * it on the scene layer would be convenient — every scene-space element
 * inherits from it — but a custom property changing on that shared ancestor
 * invalidates style for every shape in the diagram. So each layer that needs
 * it writes its own onto its own root, from {@link ViewportController.screenScale}:
 * the overlay, the edge layer, the connector tool, the presence cursors.
 *
 * ## Why the layer is only promoted while it moves
 *
 * A composited layer is rastered once at one scale and then *magnified* by the
 * compositor — cheap while a shot is being resized, soft once it stops. So the
 * promotion is a property of the change, not of the layer: see {@link SETTLE_MS}.
 *
 * ## Coordinate spaces
 *
 * `scene` px are the document's own units; `viewport` px are offsets from the
 * container's top-left, in the container's own CSS px; `client` px are what a
 * DOM event reports. The scene ⇄ viewport pair is
 * {@link viewportToScene}/{@link sceneToViewport} in `scene/geometry.ts`;
 * client ⇄ viewport is here, since only this module knows where the container
 * is — and how much a CSS `zoom` above it magnifies it, which is what turns
 * client px into the container's own.
 */

import {
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { effectiveScale, onScaleWithin } from "@/app/lib/columnScale";
import { sceneToViewport, viewportToScene } from "../scene/geometry";
import type { Point, Viewport } from "../scene/types";

/** The dot grid's spacing at 100%, in scene px. */
const GRID = 16;

/**
 * How still the viewport has to be before the scene layer is handed back to the
 * renderer to be drawn at the scale it actually came to rest at. Comfortably
 * longer than the gap between two frames of one resize, and short enough that
 * letting go and looking is enough to see the sharp version.
 */
const SETTLE_MS = 140;

export interface ViewportController {
  /** Attach to the element that receives pointer input — the band's surface. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Attach to the single transformed layer that holds every shape. */
  sceneRef: RefObject<HTMLDivElement | null>;
  /**
   * Attach to the dot grid under the scene, if there is one. It is not inside
   * the transformed layer, so it is kept in step by writing its own background
   * position and spacing alongside the scene.
   */
  gridRef: RefObject<HTMLDivElement | null>;

  /**
   * The live viewport. A new object on every change and never mutated in
   * place, so it is safe to compare by identity — but treat it as frozen.
   */
  get(): Viewport;

  /** Where the scene layer sits, instantly. A placement, written by the host. */
  set(next: Viewport): void;

  /** Event coordinates → scene px. */
  clientToScene(point: Point): Point;

  /** Scene px → event coordinates. */
  sceneToClient(point: Point): Point;

  /**
   * Screen px per scene px, the page's zoom and fit included — what a
   * hairline, a grab slop and a snap distance are measured against, so they
   * hold their size on screen at any scale. Subscribers hear when it changes.
   */
  screenScale(): number;

  /**
   * Called after the transform has been written for a frame. Returns an
   * unsubscribe function, and is shaped to drop straight into
   * `useSyncExternalStore` — but subscribe to a SCALAR read off {@link get},
   * never to the viewport object itself, which is freshly allocated per change.
   */
  subscribe(onChange: () => void): () => void;
}

export interface UseViewportOptions {
  /** Read once on the first render, like `useState`'s initial value. */
  initial?: Viewport;
}

type ViewportEngine = ViewportController & { mount(): () => void };

function createViewport(options: UseViewportOptions): ViewportEngine {
  const containerRef: RefObject<HTMLDivElement | null> = { current: null };
  const sceneRef: RefObject<HTMLDivElement | null> = { current: null };
  const gridRef: RefObject<HTMLDivElement | null> = { current: null };

  const initial = options.initial;
  let vp: Viewport = {
    x: initial?.x ?? 0,
    y: initial?.y ?? 0,
    zoom: initial?.zoom && initial.zoom > 0 ? initial.zoom : 1,
  };

  const subscribers = new Set<() => void>();
  let frame = 0;

  /**
   * What the page's zoom and fit magnify the container by, read off the layout
   * once per change of either rather than per call: hairlines, slop and snap
   * distances ask for it at pointer rate.
   */
  let ambient = 1;
  let ambientStale = true;
  const ambientScale = (): number => {
    if (ambientStale) {
      const el = containerRef.current;
      if (el) {
        ambient = effectiveScale(el);
        ambientStale = false;
      }
    }
    return ambient;
  };

  /** Whether the scene layer currently carries the compositing hint. */
  let promoted = false;
  let settle = 0;

  function paint(): void {
    const el = sceneRef.current;
    if (el) {
      // Deliberately 2D: the composited path a change wants is `promote`'s
      // job, and only for as long as the change lasts.
      el.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
    }
    const grid = gridRef.current;
    if (grid) {
      // Real properties, not custom ones: a custom property here would be
      // inherited by every shape and restyle all of them.
      const step = GRID * vp.zoom;
      grid.style.backgroundSize = `${step}px ${step}px`;
      grid.style.backgroundPosition = `${vp.x}px ${vp.y}px`;
    }
  }

  /**
   * Raise or drop the compositing hint. Raised, a rescale costs nothing and the
   * picture is an upscaled bitmap; dropped, the layer is re-rendered from the
   * DOM at the current scale, which is the only way text, strokes and SVG come
   * out sharp.
   */
  function promote(on: boolean): void {
    if (promoted === on) return;
    promoted = on;
    // "" and not "auto": handing the property back is what releases the layer.
    if (sceneRef.current) sceneRef.current.style.willChange = on ? "transform" : "";
  }

  /** Called once per painted frame — the viewport is moving, and then it isn't. */
  function keepPromoted(): void {
    promote(true);
    if (settle !== 0) clearTimeout(settle);
    settle = window.setTimeout(() => {
      settle = 0;
      promote(false);
    }, SETTLE_MS);
  }

  function flush(): void {
    frame = 0;
    keepPromoted();
    paint();
    for (const fn of subscribers) fn();
  }

  /**
   * The value updates immediately — a gesture reading `get()` mid-frame must
   * see where it just put things — while the DOM write and the notification
   * are batched to one per frame.
   */
  function commit(next: Viewport): void {
    const zoom = next.zoom > 0 ? next.zoom : vp.zoom;
    if (next.x === vp.x && next.y === vp.y && zoom === vp.zoom) return;
    vp = { x: next.x, y: next.y, zoom };
    // A new placement can come with a new fit — a band turning wide.
    ambientStale = true;
    if (frame === 0) frame = requestAnimationFrame(flush);
  }

  /** Client px → viewport px (the container's padding box, in its own px). */
  function toViewportPoint(clientX: number, clientY: number): Point {
    const el = containerRef.current;
    if (!el) return { x: clientX, y: clientY };
    const r = el.getBoundingClientRect();
    const s = effectiveScale(el);
    return {
      x: (clientX - r.left) / s - el.clientLeft,
      y: (clientY - r.top) / s - el.clientTop,
    };
  }

  function mount(): () => void {
    const scene = sceneRef.current;
    if (scene) {
      // Owned here rather than in CSS so the transform can never be composed
      // against an origin the maths did not assume.
      scene.style.transformOrigin = "0 0";
      paint();
    }
    ambientStale = true;
    const offScale = onScaleWithin(
      () => containerRef.current,
      () => {
        ambientStale = true;
        for (const fn of subscribers) fn();
      },
    );
    return () => {
      offScale();
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      if (settle !== 0) {
        clearTimeout(settle);
        settle = 0;
      }
    };
  }

  return {
    containerRef,
    sceneRef,
    gridRef,
    mount,
    get: () => vp,
    set: commit,
    clientToScene: (point) => viewportToScene(toViewportPoint(point.x, point.y), vp),
    sceneToClient: (point) => {
      const p = sceneToViewport(point, vp);
      const el = containerRef.current;
      if (!el) return p;
      const r = el.getBoundingClientRect();
      const s = effectiveScale(el);
      return { x: r.left + (p.x + el.clientLeft) * s, y: r.top + (p.y + el.clientTop) * s };
    },
    screenScale: () => vp.zoom * ambientScale(),
    subscribe: (onChange) => {
      subscribers.add(onChange);
      return () => subscribers.delete(onChange);
    },
  };
}

/**
 * The viewport for one canvas. The returned controller is stable for the life
 * of the component — pass it down freely; it never causes a re-render.
 *
 * Mounted in a layout effect so the initial transform is on screen before the
 * first paint.
 */
export function useViewport(options: UseViewportOptions = {}): ViewportController {
  // `useState`'s lazy initialiser, not `useMemo` or a ref: it is the only one
  // of the three that React guarantees will produce exactly one instance for
  // the life of the component. The setter is deliberately dropped.
  const [viewport] = useState(() => createViewport(options));

  useLayoutEffect(() => viewport.mount(), [viewport]);

  return viewport;
}

/**
 * {@link ViewportController.screenScale}, as a render value — for whatever
 * draws screen-sized chrome in scene space and has to redraw when it changes.
 */
export function useScreenScale(viewport: ViewportController): number {
  return useSyncExternalStore(viewport.subscribe, viewport.screenScale, UNZOOMED);
}

/** Stable server snapshot: a canvas always hydrates at 100%. */
const UNZOOMED = () => 1;
