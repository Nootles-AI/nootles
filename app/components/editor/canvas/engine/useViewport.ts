"use client";

/**
 * The canvas viewport — pan and zoom, at frame rate, without re-rendering the scene.
 *
 * ## Why the viewport is not React state
 *
 * A pinch-zoom or a two-finger pan produces one event per frame or more. If the
 * viewport lived in `useState`, every one of those would re-render every shape,
 * and the canvas would feel like a web page instead of like Figma. So the
 * viewport lives in a closure, the transform is written directly onto **one**
 * element, and anything that genuinely needs to re-render (a zoom readout)
 * opts in through {@link ViewportController.subscribe}. The scene itself never
 * re-renders while you move around it.
 *
 * ## The DOM this expects
 *
 * ```tsx
 * const vp = useViewport();
 * <div ref={vp.containerRef} style={{ position: "relative", overflow: "hidden" }}>
 *   <div ref={vp.sceneRef} style={{ position: "absolute", inset: 0 }}>
 *     …shapes, absolutely positioned in scene px…
 *   </div>
 * </div>
 * ```
 *
 * The container clips and receives input; the scene layer carries the
 * transform. The hook owns one piece of the container's inline style —
 * `cursor` — and three of the scene layer's — `transform`, `transform-origin`
 * and `will-change`. Don't set those from the host.
 *
 * Note what is deliberately NOT here: `--k`, one screen px in scene units,
 * which anything holding its screen size across a zoom counter-scales through.
 * Publishing it on the scene layer would be convenient — every scene-space
 * element inherits from it — but a custom property changing on that shared
 * ancestor invalidates style for every shape in the diagram on every frame of
 * a zoom, which is the precise cost the promotion below exists to avoid. So
 * each layer that needs it writes its own onto its own root: the overlay, the
 * edge layer, the connector tool, the presence cursors.
 *
 * ## Why the layer is only promoted while it moves
 *
 * A composited layer is rastered once at one scale and then *magnified* by the
 * compositor. That is exactly what makes a pan cost a matrix multiply instead
 * of a repaint — and exactly what makes a zoom soft, because every glyph,
 * hairline and curve stays the bitmap it was drawn at until something happens
 * to invalidate it. So the promotion is a property of the *gesture*, not of the
 * layer: see {@link SETTLE_MS}.
 *
 * ## Why the commands ease and the gestures do not
 *
 * A gesture is already an animation: the hand supplies every frame and the
 * viewport's only job is to keep up, so a wheel, a pinch and a drag are
 * applied the instant they arrive. A command is not — ⌘0, ⇧1, a pick from the
 * zoom menu each land as a single instant, and cutting the view from one place
 * to another costs the reader the only thing a canvas really gives them, which
 * is knowing where they are. So the navigating verbs ease over
 * {@link NAVIGATE_MS}, and any live input takes the view back mid-flight.
 *
 * ## Coordinate spaces
 *
 * `scene` px are the document's own units; `viewport` px are offsets from the
 * container's top-left; `client` px are what a DOM event reports. The
 * scene ⇄ viewport pair is {@link viewportToScene}/{@link sceneToViewport} in
 * `scene/geometry.ts`; client ⇄ scene is {@link ViewportController.clientToScene}
 * here, since only this module knows where the container is.
 */

import {
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { sceneToViewport, viewportToScene } from "../scene/geometry";
import type { Point, Rect, Viewport } from "../scene/types";

/**
 * Figma allows 2%–6400%; that range only earns its keep on artboards the size
 * of a city. A diagram inside a document is legible over two decades.
 */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;

/** Screen px left around the content by {@link ViewportController.zoomToFit}. */
const FIT_PADDING = 32;

/**
 * `zoomToFit` will not zoom *in* past this by default: a single small rect
 * blown up to 8× is not focus, it's disorientation.
 */
const FIT_MAX_ZOOM = 1;

/** `deltaMode: DOM_DELTA_LINE` is reported in lines; assume a 16px line. */
const WHEEL_LINE_HEIGHT = 16;

/**
 * Wheel delta → zoom factor, as `exp(-delta * SENSITIVITY)`. Exponential so
 * that a given gesture zooms by the same *ratio* wherever you start, which is
 * the only way zooming feels linear to the hand.
 */
const ZOOM_SENSITIVITY = 0.005;

/**
 * A trackpad pinch sends many small deltas; a mouse wheel notch sends one delta
 * of 100 or more. Clamping the per-event delta keeps one notch from jumping
 * three octaves without making the pinch feel damped.
 */
const MAX_WHEEL_ZOOM_STEP = 60;

/**
 * How still the viewport has to be before the scene layer is handed back to the
 * renderer to be drawn at the scale it actually came to rest at. Comfortably
 * longer than the gap between two frames of one gesture — a pinch that pauses
 * for this long is a pinch that has stopped — and short enough that letting go
 * and looking is enough to see the sharp version.
 */
const SETTLE_MS = 140;

/**
 * How long a navigation verb takes to arrive. Long enough for the eye to
 * follow the content from where it was to where it went — which is the whole
 * point, since a jump costs the user the place they were standing — and short
 * enough that a held ⌘+ still reads as a control and not as a ride.
 */
const NAVIGATE_MS = 180;

/**
 * Pushes against a hard edge that a wheel pan absorbs before the page is
 * handed the scroll. The tail of a trackpad fling routinely overshoots by an
 * event or two, and a document that jumped on the first of those would feel
 * like a trapdoor.
 */
const WHEEL_EDGE_GRACE = 2;

/**
 * A gap this long ends a wheel gesture: the next event measures the reach
 * again and starts counting edge pushes from zero. Long enough to span the
 * ragged frames of trackpad momentum, short enough that a fresh scroll is
 * asked as a fresh question.
 */
const WHEEL_IDLE_MS = 120;

/**
 * `"ready"` means space is held and a press will pan — the gesture layer must
 * not start a marquee or a drag. `"active"` means a pan is in progress.
 */
export type PanState = "idle" | "ready" | "active";

export interface ZoomToFitOptions {
  /** Screen-px margin around the content. Default 32. */
  padding?: number;
  /** Cap on zooming in to fit. Default 1. */
  maxZoom?: number;
}

export interface ViewportController {
  /** Attach to the clipping element that receives pointer and wheel input. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Attach to the single transformed layer that holds every shape. */
  sceneRef: RefObject<HTMLDivElement | null>;

  /**
   * The live viewport. A new object on every change and never mutated in
   * place, so it is safe to compare by identity and to hand to
   * `useSyncExternalStore` — but treat it as frozen.
   */
  get(): Viewport;

  /**
   * Absolute set, instantly; `zoom` is clamped to {@link MIN_ZOOM}–
   * {@link MAX_ZOOM}. Placement, not navigation — this is a caller saying
   * where the view *is*, and it cancels anything the view was easing towards.
   */
  set(next: Viewport): void;

  /** Translate by a delta in screen px. */
  panBy(dx: number, dy: number): void;

  /**
   * Zoom, holding the scene point under `anchor` still. `anchor` is in
   * viewport px and defaults to the container's centre.
   *
   * This and the three verbs below are navigation: they ease over
   * {@link NAVIGATE_MS} rather than cut, and any live input — a wheel, a
   * pinch, a drag, a further command — takes the view back at once.
   */
  zoomTo(zoom: number, anchor?: Point): void;

  /** Multiply the zoom, holding `anchor` still. */
  zoomBy(factor: number, anchor?: Point): void;

  /** Frame `bounds` (scene px) in the container. */
  zoomToFit(bounds: Rect, opts?: ZoomToFitOptions): void;

  /** Back to 100%, about the container's centre — what you're looking at stays. */
  resetZoom(): void;

  /** Event coordinates → scene px. */
  clientToScene(point: Point): Point;

  /** Scene px → event coordinates. */
  sceneToClient(point: Point): Point;

  panState(): PanState;

  /**
   * Called after the transform has been written for a frame. Returns an
   * unsubscribe function, and is shaped to drop straight into
   * `useSyncExternalStore` — but subscribe to a SCALAR read off {@link get},
   * never to the viewport object itself, which is freshly allocated per frame
   * and would re-render its reader on every pan.
   */
  subscribe(onChange: () => void): () => void;
}

export interface UseViewportOptions {
  /** Read once on the first render, like `useState`'s initial value. */
  initial?: Viewport;
  minZoom?: number;
  maxZoom?: number;
  /**
   * Bind no input, and refuse to navigate. Wheel, pinch and space-drag are
   * left to the page, every pan and zoom verb becomes a no-op, and the
   * transform moves only through `set`.
   *
   * A storyboard shot is a fixed frame that scales with its column, not a
   * window onto an endless surface: there is nothing off-screen to reach, so
   * panning it would only ever lose the picture. Read once, like `initial` —
   * a viewport does not become lockable halfway through its life.
   */
  locked?: boolean;
  /**
   * The content's own box in scene px — everything a pan could still bring
   * into view. The wheel asks at the start of each gesture whether anything is
   * left to reveal before it decides to keep a scroll or hand it to the page,
   * so this must answer from the live scene and not from one render's copy of
   * it. Without it every pan is kept; see {@link onWheel}.
   */
  content?: () => Rect | null;
}

type ViewportEngine = ViewportController & { mount(): () => void };

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wheel deltas in px, whatever unit the browser chose to report them in. */
function wheelDelta(e: WheelEvent, el: HTMLElement): Point {
  let x = e.deltaX;
  let y = e.deltaY;
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    x *= WHEEL_LINE_HEIGHT;
    y *= WHEEL_LINE_HEIGHT;
  } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    x *= el.clientWidth;
    y *= el.clientHeight;
  }
  // A mouse wheel has no horizontal axis, so shift+wheel is how you pan
  // sideways with one. macOS already swaps the axes; Windows does not.
  if (e.shiftKey && x === 0) {
    x = y;
    y = 0;
  }
  return { x, y };
}

/** Somewhere a space keypress means "space", not "grab the canvas". */
function isTextEntry(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function createViewport(options: UseViewportOptions): ViewportEngine {
  const minZoom = options.minZoom ?? MIN_ZOOM;
  const maxZoom = options.maxZoom ?? MAX_ZOOM;

  const containerRef: RefObject<HTMLDivElement | null> = { current: null };
  const sceneRef: RefObject<HTMLDivElement | null> = { current: null };

  const initial = options.initial;
  let vp: Viewport = {
    x: initial?.x ?? 0,
    y: initial?.y ?? 0,
    zoom: clamp(initial?.zoom ?? 1, minZoom, maxZoom),
  };

  const subscribers = new Set<() => void>();
  let frame = 0;

  /**
   * Whether the user has committed to this canvas — see the wheel handler for
   * why that question decides who owns a scroll.
   */
  let engaged = false;
  let spaceDown = false;
  let pan: { pointerId: number; x: number; y: number } | null = null;

  /** Whether the scene layer currently carries the compositing hint. */
  let promoted = false;
  let settle = 0;

  /** The frame of the navigation tween, when the view is easing somewhere. */
  let tween = 0;

  /**
   * Whether the browser has painted this viewport yet. A tween has to ease
   * *from* something the user has seen, and the one-time fit that brings an
   * oversized diagram into the column runs before the first frame: there is no
   * "from" there, only a placement, and a placement is simply where it lands.
   */
  let seen = false;
  let firstFrame = 0;

  /**
   * The content's box in scene px and the container's visible size, as read at
   * the start of a wheel gesture — see {@link onWheel} for what the wheel does
   * with it and why it is not read per event.
   */
  let reach: { box: Rect; cw: number; ch: number } | null = null;
  let wheelAt = 0;
  let edgePushes = 0;

  // -------------------------------------------------------------------------
  // Writing the viewport
  // -------------------------------------------------------------------------

  function paint(): void {
    const el = sceneRef.current;
    if (el) {
      // Deliberately 2D. `translate3d` is the old way of asking for a layer,
      // and asking for one permanently is the bug this file used to have; the
      // composited path a gesture wants is `promote`'s job, and only for as
      // long as the gesture lasts.
      el.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
    }
  }

  /**
   * Raise or drop the compositing hint. Raised, a pan and a pinch cost nothing
   * and the picture is an upscaled bitmap; dropped, the layer is re-rendered
   * from the DOM at the current zoom, which is the only way text, strokes and
   * SVG come out sharp at anything but 100%.
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
  function commit(x: number, y: number, zoom: number): void {
    const z = clamp(zoom, minZoom, maxZoom);
    if (x === vp.x && y === vp.y && z === vp.zoom) return;
    vp = { x, y, zoom: z };
    if (frame === 0) frame = requestAnimationFrame(flush);
  }

  // -------------------------------------------------------------------------
  // Easing the navigation verbs
  // -------------------------------------------------------------------------

  /**
   * Whatever the view was doing on its own, it stops. Every path the user
   * drives the viewport through calls this first: an animation that argues
   * with a live gesture is worse than no animation at all.
   */
  function stopTween(): void {
    if (tween === 0) return;
    cancelAnimationFrame(tween);
    tween = 0;
  }

  /**
   * Ease to a viewport, and land on it exactly.
   *
   * Zoom is interpolated *geometrically* — the eye reads zoom as a ratio, so a
   * linear ramp through the scale visibly accelerates into its last frames,
   * which is the standard tell of a hand-rolled zoom. The translation is not
   * interpolated at all: it is re-solved every frame about the one viewport
   * point the start and the end agree on, so whatever the move is *about* —
   * the pointer, the centre, the middle of the thing being framed — holds
   * still for the whole of it instead of drifting out and back. Two viewports
   * at the same zoom have no such point, and there the translation is a line.
   *
   * Because `commit` drives it, a tween is a moving viewport like any other:
   * the layer stays promoted for the duration and settles once it arrives, and
   * `get()` reports where the view is now, not where it is going.
   */
  function tweenTo(to: Viewport): void {
    stopTween();
    const z = clamp(to.zoom, minZoom, maxZoom);
    if (to.x === vp.x && to.y === vp.y && z === vp.zoom) return;
    if (!seen || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      commit(to.x, to.y, z);
      return;
    }

    const from = vp;
    const ratio = z / from.zoom;
    // `1 - ratio` is the fixed point's divisor; where it vanishes the solve is
    // a 0/0 and the move is a pan with a rounding error attached to it.
    const about = Math.abs(1 - ratio) > 1e-4;
    const fx = about ? (to.x - from.x * ratio) / (1 - ratio) : 0;
    const fy = about ? (to.y - from.y * ratio) / (1 - ratio) : 0;
    const logFrom = Math.log(from.zoom);
    const logSpan = Math.log(z) - logFrom;
    // Timed from the first frame it is actually given, not from now: a call
    // made while the main thread is busy would otherwise spend its ease
    // waiting, and arrive as the jump it was meant to replace.
    let start = 0;

    const step = (now: number): void => {
      if (start === 0) start = now;
      const t = (now - start) / NAVIGATE_MS;
      if (t >= 1) {
        tween = 0;
        commit(to.x, to.y, z);
        return;
      }
      tween = requestAnimationFrame(step);
      const e = 1 - (1 - t) ** 3;
      const zoom = Math.exp(logFrom + logSpan * e);
      if (about) {
        const k = zoom / from.zoom;
        commit(fx - (fx - from.x) * k, fy - (fy - from.y) * k, zoom);
      } else {
        commit(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e, zoom);
      }
    };
    tween = requestAnimationFrame(step);
  }

  // -------------------------------------------------------------------------
  // Geometry against the container
  // -------------------------------------------------------------------------

  /** Client px → viewport px (the container's padding box). */
  function toViewportPoint(clientX: number, clientY: number): Point {
    const el = containerRef.current;
    if (!el) return { x: clientX, y: clientY };
    const r = el.getBoundingClientRect();
    return {
      x: clientX - r.left - el.clientLeft,
      y: clientY - r.top - el.clientTop,
    };
  }

  function centreAnchor(): Point {
    const el = containerRef.current;
    if (!el) return { x: 0, y: 0 };
    return { x: el.clientWidth / 2, y: el.clientHeight / 2 };
  }

  // -------------------------------------------------------------------------
  // Public transforms
  // -------------------------------------------------------------------------

  /** A hand on the surface — the drag tools, the space-drag, the wheel. */
  function panBy(dx: number, dy: number): void {
    stopTween();
    commit(vp.x + dx, vp.y + dy, vp.zoom);
  }

  /**
   * The viewport that reaches `zoom` about a point. The scene coordinate under
   * `anchor` must not move, so the translation is solved from it rather than
   * nudged — and the zoom is clamped *before* the translation is derived, or
   * the content would drift sideways every time you kept pinching at the
   * limit. `null` when there is nowhere to go.
   */
  function zoomAbout(zoom: number, anchor?: Point): Viewport | null {
    const z = clamp(zoom, minZoom, maxZoom);
    if (z === vp.zoom) return null;
    const p = anchor ?? centreAnchor();
    const k = z / vp.zoom;
    return { x: p.x - (p.x - vp.x) * k, y: p.y - (p.y - vp.y) * k, zoom: z };
  }

  function zoomTo(zoom: number, anchor?: Point): void {
    const to = zoomAbout(zoom, anchor);
    if (to) tweenTo(to);
  }

  /**
   * Compounding from where the view is *now*, not from where an unfinished
   * tween was headed: a held ⌘+ then eases on continuously instead of firing
   * one animation per key repeat and landing three octaves later.
   */
  function zoomBy(factor: number, anchor?: Point): void {
    zoomTo(vp.zoom * factor, anchor);
  }

  function zoomToFit(bounds: Rect, opts: ZoomToFitOptions = {}): void {
    const el = containerRef.current;
    if (!el) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (cw <= 0 || ch <= 0) return;

    // Padding never eats more than half of either axis, so fitting into a
    // sliver of a container still frames something rather than nothing.
    const padding = opts.padding ?? FIT_PADDING;
    const availW = cw - Math.min(padding, cw / 4) * 2;
    const availH = ch - Math.min(padding, ch / 4) * 2;

    const cap = Math.min(maxZoom, opts.maxZoom ?? FIT_MAX_ZOOM);
    const z =
      bounds.w > 0 && bounds.h > 0
        ? clamp(Math.min(availW / bounds.w, availH / bounds.h), minZoom, cap)
        : vp.zoom;

    tweenTo({
      x: cw / 2 - (bounds.x + bounds.w / 2) * z,
      y: ch / 2 - (bounds.y + bounds.h / 2) * z,
      zoom: z,
    });
  }

  // -------------------------------------------------------------------------
  // Wheel — the boundary with the page's own scroll
  // -------------------------------------------------------------------------

  /**
   * A canvas block sits inside a scrolling document, so a wheel event over it
   * is ambiguous: the user may mean "pan the diagram" or "keep reading the
   * page". Consuming both would make the page unscrollable past the canvas,
   * which is the classic embedded-canvas trap; consuming neither would mean no
   * trackpad panning at all. So the two gestures are split:
   *
   *  - **Zoom (ctrl/⌘ + wheel, which is also what a trackpad pinch reports) is
   *    always ours.** The alternative is the browser zooming the entire page —
   *    a global, jarring action nobody means to trigger by pinching a diagram.
   *  - **Pan (a plain wheel) is ours only once the canvas is engaged**, i.e.
   *    the user has pressed inside it (or focused into it) and has not since
   *    pressed anywhere else. Until then the event is left completely alone —
   *    no `preventDefault` — and the page scrolls exactly as if the canvas
   *    were an image. This is the "click to interact" contract every embedded
   *    map and canvas uses, and it is the only rule that lets both gestures
   *    exist without one stealing from the other.
   *  - **A pan with nothing left to reveal is handed back.** Engagement is
   *    otherwise permanent until the user presses somewhere else, so a reader
   *    who has the whole diagram in view and keeps scrolling gets nothing at
   *    all, and no hint that the page is what they now want. When the content
   *    is already inside the container on every axis the delta asks for —
   *    nothing can come in, whichever way it pushes — and has been for
   *    {@link WHEEL_EDGE_GRACE} events running, so that the overshoot at the
   *    end of a fling is never read as a request, the event is left alone and
   *    chains to the page. Panning only: a pinch is unambiguous and stays ours
   *    wherever the view is. If the content is not known the event is consumed
   *    exactly as before, because losing the release is a small loss and a page
   *    scrolling out from under a canvas is a large one.
   *
   * The listener is registered non-passive precisely so the consuming branches
   * *can* call `preventDefault`; the non-consuming branches must return before
   * it does, which is the whole reason this function is shaped as it is.
   */
  function onWheel(e: WheelEvent): void {
    const el = containerRef.current;
    if (!el) return;

    const zooming = e.ctrlKey || e.metaKey;
    if (!zooming && !isEngaged()) return;
    const d = wheelDelta(e, el);

    if (zooming) {
      e.preventDefault();
      stopTween();
      const step = clamp(d.y, -MAX_WHEEL_ZOOM_STEP, MAX_WHEEL_ZOOM_STEP);
      const to = zoomAbout(
        vp.zoom * Math.exp(-step * ZOOM_SENSITIVITY),
        toViewportPoint(e.clientX, e.clientY),
      );
      // Applied live rather than eased: the gesture is already the animation.
      if (to) commit(to.x, to.y, to.zoom);
      return;
    }

    if (e.timeStamp - wheelAt > WHEEL_IDLE_MS) {
      measureReach(el);
      edgePushes = 0;
    }
    wheelAt = e.timeStamp;
    if (!hasReach(d)) {
      if (++edgePushes > WHEEL_EDGE_GRACE) return;
    } else {
      edgePushes = 0;
    }

    e.preventDefault();
    panBy(-d.x, -d.y);
  }

  /**
   * The content against the container, in scene px so that projecting it back
   * out survives the rest of the gesture however far it pans. Read once per
   * gesture and never per event: the answer cannot change while the wheel is
   * turning — only the viewport moves, and {@link hasReach} carries the box
   * through that — and the wheel handler is the hottest path in the
   * application.
   *
   * It is the content that is asked for and not the scene layer's own box: the
   * layer is `inset: 0` on the container, so measuring it would only ever hand
   * back the container's own rect, which says nothing about where the shapes
   * are. The host answers with the same union the "show content" fit frames,
   * so the two agree on what being lost means.
   */
  function measureReach(el: HTMLElement): void {
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    const box = options.content?.();
    reach = box && cw > 0 && ch > 0 ? { box, cw, ch } : null;
  }

  /**
   * Is there content left to bring into view along the axes `d` asks for?
   *
   * The test is containment and not the nearer edge: the whole content has to
   * be inside the container on an axis before a push along that axis counts as
   * a push at nothing. Content that still runs off one side has somewhere to
   * go in both directions — the far side is where the user is heading — and
   * the cost of erring that way is only a scroll the canvas kept when it could
   * have passed it on, where the cost of erring the other way is a diagram
   * whose far end cannot be reached. Unknown counts as room for the same
   * reason, and an axis with no delta asks for nothing and answers nothing.
   */
  function hasReach(d: Point): boolean {
    if (!reach) return true;
    if (d.x === 0 && d.y === 0) return true;
    const { box } = reach;
    const left = box.x * vp.zoom + vp.x;
    const top = box.y * vp.zoom + vp.y;
    const x = d.x !== 0 && (left < -1 || left + box.w * vp.zoom > reach.cw + 1);
    const y = d.y !== 0 && (top < -1 || top + box.h * vp.zoom > reach.ch + 1);
    return x || y;
  }

  // -------------------------------------------------------------------------
  // Engagement
  // -------------------------------------------------------------------------

  function isEngaged(): boolean {
    const el = containerRef.current;
    if (!el) return false;
    return engaged || el.contains(document.activeElement);
  }

  function onDocumentPointerDown(e: PointerEvent): void {
    const el = containerRef.current;
    engaged = !!el && e.target instanceof Node && el.contains(e.target);
    if (!engaged && spaceDown) {
      spaceDown = false;
      updateCursor();
    }
  }

  // -------------------------------------------------------------------------
  // Drag panning — space+drag and middle-mouse
  // -------------------------------------------------------------------------

  function updateCursor(): void {
    const el = containerRef.current;
    if (!el) return;
    // "" hands the cursor back to whatever the host's CSS says (the active
    // tool's crosshair, a shape's move cursor).
    el.style.cursor = pan ? "grabbing" : spaceDown && isEngaged() ? "grab" : "";
  }

  function onPointerDown(e: PointerEvent): void {
    // Capture phase on the container, so this runs for every press inside the
    // canvas and not only for the two this handler goes on to claim: a drag or
    // a marquee freezes the scene point it started from, and a view still
    // easing somewhere would slide that point out from under the cursor for
    // the rest of the flight.
    stopTween();
    if (pan) return;
    const middle = e.button === 1;
    const spacePan = e.button === 0 && spaceDown && isEngaged();
    if (!middle && !spacePan) return;
    const el = containerRef.current;
    if (!el) return;

    pan = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
    // Capture phase: a pan is not a selection, so nothing downstream — shapes,
    // the marquee, the gesture layer — ever sees this press.
    e.stopPropagation();
    updateCursor();
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!pan || e.pointerId !== pan.pointerId) return;
    panBy(e.clientX - pan.x, e.clientY - pan.y);
    pan.x = e.clientX;
    pan.y = e.clientY;
  }

  function onPointerUp(e: PointerEvent): void {
    if (!pan || e.pointerId !== pan.pointerId) return;
    endPan();
  }

  function endPan(): void {
    const el = containerRef.current;
    if (pan && el) {
      if (el.hasPointerCapture(pan.pointerId)) {
        el.releasePointerCapture(pan.pointerId);
      }
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
    }
    pan = null;
    updateCursor();
  }

  /**
   * `preventDefault` on `pointerdown` does not cancel the compatibility mouse
   * events, and it is those that start middle-click autoscroll on Windows and
   * a text selection drag everywhere. Suppress them once the pan is underway.
   */
  function onMouseDown(e: MouseEvent): void {
    if (!pan) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.code !== "Space" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!isEngaged() || isTextEntry()) return;
    if (!spaceDown) {
      spaceDown = true;
      updateCursor();
    }
    // Held space would otherwise page-scroll the document underneath.
    e.preventDefault();
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.code !== "Space" || !spaceDown) return;
    spaceDown = false;
    updateCursor();
  }

  /** ⌘-tabbing away with space held must not leave the canvas stuck in grab. */
  function onWindowBlur(): void {
    endPan();
    if (spaceDown) {
      spaceDown = false;
      updateCursor();
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  function mount(): () => void {
    const scene = sceneRef.current;
    if (scene) {
      // Owned here rather than in CSS so the transform can never be composed
      // against an origin the maths did not assume.
      scene.style.transformOrigin = "0 0";
      // No `will-change` here: a canvas that is merely sitting on the page is
      // not moving, and a layer nobody is moving is only ever a stale bitmap.
      paint();
    }
    // Anything placed before the browser has drawn a frame is where the view
    // *starts*; from here on there is a "from" for a tween to ease out of.
    firstFrame = requestAnimationFrame(() => {
      firstFrame = 0;
      seen = true;
    });

    /** Everything this engine can have in flight, dropped. */
    const idle = (): void => {
      stopTween();
      if (firstFrame !== 0) {
        cancelAnimationFrame(firstFrame);
        firstFrame = 0;
      }
      seen = false;
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      if (settle !== 0) {
        clearTimeout(settle);
        settle = 0;
      }
    };

    const el = containerRef.current;
    // Locked: the transform is still painted above, so a caller's `set` shows;
    // only the listeners that would let the user move it are never bound.
    if (!el || options.locked) return idle;

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onPointerDown, true);
    el.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("pointerdown", onDocumentPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);

    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown, true);
      el.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("pointerdown", onDocumentPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
      endPan();
      idle();
    };
  }

  /**
   * Locked means locked, not merely unlistened-to: the NAVIGATING verbs are
   * refused here as well, so a caller that moves the view imperatively — the
   * hand tool runs its own pointer loop and calls {@link panBy} — cannot walk
   * the content out of its own frame.
   *
   * The line is who the move is for. `panBy`/`zoomTo`/`zoomBy`/`resetZoom` are
   * a user going somewhere, and there is nowhere to go. `set` and
   * {@link zoomToFit} are, or can be, a caller PLACING the view — the frame's
   * own scale, and the once-only fit that brings an oversized diagram into the
   * column — and refusing those would not pin the view, it would strand it.
   */
  const still = () => {};

  return {
    containerRef,
    sceneRef,
    mount,
    get: () => vp,
    // Instant, and it wins: a placement is a caller saying where the view *is*,
    // so an animation still on its way somewhere else is simply over.
    set: (next) => {
      stopTween();
      commit(next.x, next.y, next.zoom);
    },
    panBy: options.locked ? still : panBy,
    zoomTo: options.locked ? still : zoomTo,
    zoomBy: options.locked ? still : zoomBy,
    zoomToFit,
    resetZoom: options.locked ? still : () => zoomTo(1),
    clientToScene: (point) =>
      viewportToScene(toViewportPoint(point.x, point.y), vp),
    sceneToClient: (point) => {
      const p = sceneToViewport(point, vp);
      const el = containerRef.current;
      if (!el) return p;
      const r = el.getBoundingClientRect();
      return { x: p.x + r.left + el.clientLeft, y: p.y + r.top + el.clientTop };
    },
    panState: () => (pan ? "active" : spaceDown && isEngaged() ? "ready" : "idle"),
    subscribe: (onChange) => {
      subscribers.add(onChange);
      return () => subscribers.delete(onChange);
    },
  };
}

/**
 * Pan and zoom for one canvas. The returned controller is stable for the life
 * of the component — pass it down freely; it never causes a re-render.
 *
 * Mounted in a layout effect so the initial transform is on screen before the
 * first paint, and so the wheel listener exists before any event can reach the
 * page underneath.
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
 * The zoom, as a render value — the one viewport field anything genuinely
 * renders from (a readout, a minimap's scale). A scalar on purpose: `get()`
 * returns a new object every frame, so subscribing to the viewport itself
 * re-renders the reader on every pan for a number that did not move.
 *
 * Everything that draws in scene coordinates should live inside the transformed
 * layer, counter-scale through `--k`, and read nothing at all.
 */
export function useViewportZoom(viewport: ViewportController): number {
  return useSyncExternalStore(
    viewport.subscribe,
    () => viewport.get().zoom,
    UNZOOMED,
  );
}

/** Stable server snapshot: a canvas always hydrates at 100%. */
const UNZOOMED = () => 1;
