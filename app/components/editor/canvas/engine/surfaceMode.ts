/**
 * The exclusive pointer-mode slot on a canvas surface.
 *
 * `CanvasSurface`'s own gestures — click-to-select, drag-to-move, marquee,
 * draw — are the surface's default behaviour. A colour pick (COLOR) is a
 * *transient exclusive*: while it is up, none of that
 * default behaviour should run, and the thing that IS running should see
 * every pointer event instead. Rather than each such feature adding its own
 * `if (picking) return` branch to every handler in an already 1400-line file
 * — five slices' worth of parallel branches that all have to agree on
 * ordering — there is exactly one slot. Whoever holds it is asked first, in
 * every handler, before anything else runs; and only one mode can hold it at
 * a time, which is the whole point of calling it exclusive.
 *
 * This module owns none of the surface's own state — no scene, no viewport,
 * no selection. It is a small, dependency-free registry: `enter`/`exit`,
 * `get`, `subscribe`. `render/CanvasSurface.tsx` builds the
 * {@link SurfaceModeContext} each mode receives and is the only thing that
 * calls a mode's handlers; a mode itself never reaches into the DOM to find
 * the surface.
 *
 * Shared by COLOR (the eyedropper — this module's first tenant) and, per the
 * canvas-parity build plan, SELECT (a future layer-menu pick).
 */

import type { Point, Scene } from "../scene/types";
import type { SceneStore } from "./useScene";
import type { SelectionStore } from "./useSelection";
import type { ViewportController } from "./useViewport";

/** What the surface hands a mode on every event. Built fresh per call, so a
 *  mode always sees the current scene/viewport rather than a stale closure. */
export interface SurfaceModeContext {
  store: SceneStore;
  selection: SelectionStore;
  viewport: ViewportController;
  /** The clipping viewport element (`.nt-canvas-viewport`), or `null` before mount. */
  container(): HTMLElement | null;
  /** `viewport.clientToScene` on a pointer/mouse event. */
  scenePoint(e: { clientX: number; clientY: number }): Point;
  /** `laidOutScene(store.getScene())` — the one geometry to hit-test. */
  laid(): Scene;
}

export type ExitReason = "released" | "replaced" | "escape" | "unmounted";

export interface SurfaceMode {
  /** Stable id; becomes `data-mode` on the viewport. Kebab-case. */
  id: "color-pick" | (string & {});
  /**
   * Pointer handlers. The surface has already suppressed its own default
   * behaviour for this event — no focus, no `selection.click`/`probe`, no
   * `gesture.startMove`, no marquee, no draw, no hover frame — before calling
   * these. Left button only for down; the mode sees `button` and may ignore
   * others.
   */
  onPointerDown?(e: PointerEvent, ctx: SurfaceModeContext): void;
  onPointerMove?(e: PointerEvent, ctx: SurfaceModeContext): void;
  onPointerUp?(e: PointerEvent, ctx: SurfaceModeContext): void;
  onPointerLeave?(ctx: SurfaceModeContext): void;
  /**
   * Document-level keydown (capture) while active. Return `true` to consume
   * it. Escape is delivered here first; a mode that does not consume it is
   * exited by the registry itself (default behaviour, so Escape always leaves
   * a mode one way or another).
   */
  onKeyDown?(e: KeyboardEvent, ctx: SurfaceModeContext): boolean;
  /** Called exactly once when the mode stops being active, for any reason. */
  onExit?(reason: ExitReason): void;
}

export interface SurfaceModes {
  get(): SurfaceMode | null;
  /**
   * Make `mode` the active one. Any active mode is exited first, with
   * `"replaced"`. Returns a release function that exits `mode` if — and only
   * if — it is still the active one; calling it twice, or after another mode
   * has taken over, is a no-op.
   */
  enter(mode: SurfaceMode): () => void;
  /** Exit whatever is active (used by the surface on unmount). No-op when nothing is active. */
  exit(reason?: ExitReason): void;
  subscribe(listener: () => void): () => void;
}

/**
 * The pure half of the registry's keydown routing: does this keystroke end
 * the active mode? Exported on its own so it is testable without a real
 * `document` — this package's vitest environment has none, and a decision
 * function needs nothing more than the objects already in hand. The real
 * listener wiring below is a thin, DOM-only shell around this.
 */
export function shouldExitOnKeyDown(
  mode: SurfaceMode,
  e: KeyboardEvent,
  ctx: SurfaceModeContext,
): boolean {
  const consumed = mode.onKeyDown?.(e, ctx) ?? false;
  return !consumed && e.key === "Escape";
}

/**
 * The registry. `ctx` is a factory rather than a fixed object so it always
 * reflects the surface's current store/selection/viewport — one call to
 * `createSurfaceModes` lives for the life of the canvas, but the surface
 * itself is free to re-render around it.
 */
export function createSurfaceModes(ctxFactory: () => SurfaceModeContext): SurfaceModes {
  let active: SurfaceMode | null = null;
  /** Bumped on every `enter`, so a stale `release()` from a superseded mode
   *  can tell it is no longer the one holding the slot. */
  let token = 0;
  const listeners = new Set<() => void>();
  let keyListener: ((e: KeyboardEvent) => void) | null = null;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  // `typeof document` rather than a bare reference: this module's own vitest
  // suite runs in a DOM-less environment (pure logic lives in
  // `shouldExitOnKeyDown` above, which needs no guard), and the canvas itself
  // is always client-rendered — but a registry constructed before mount (or
  // under SSR) should not throw for wanting a document that isn't there yet.
  const hasDocument = () => typeof document !== "undefined";

  const armKeys = () => {
    if (keyListener || !hasDocument()) return;
    keyListener = (e: KeyboardEvent) => {
      const mode = active;
      if (mode && shouldExitOnKeyDown(mode, e, ctxFactory())) exit("escape");
    };
    document.addEventListener("keydown", keyListener, true);
  };

  const disarmKeys = () => {
    if (!keyListener) return;
    document.removeEventListener("keydown", keyListener, true);
    keyListener = null;
  };

  function exit(reason: ExitReason = "released"): void {
    const mode = active;
    if (!mode) return;
    active = null;
    token++;
    disarmKeys();
    mode.onExit?.(reason);
    notify();
  }

  function enter(mode: SurfaceMode): () => void {
    if (active) exit("replaced");
    active = mode;
    const mine = ++token;
    armKeys();
    notify();
    return () => {
      if (active === mode && token === mine) exit("released");
    };
  }

  return {
    get: () => active,
    enter,
    exit,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

