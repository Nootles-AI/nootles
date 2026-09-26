"use client";

/**
 * The colour-pick session: one small state machine shared by every entry
 * point (a button in a `ColorField` popover, the `I` key, Shift+I) and every
 * source (sampling the canvas's own authored paint via `SurfaceModes`, or a
 * screen pixel via `window.EyeDropper`).
 *
 * A session never mutates the document itself — the whole point of
 * `PickDestination.apply` is that it is the field's own `onChange` path, so
 * every existing rule about what an edit does (one undo entry, the panel's
 * gesture bracket, a bound field's rebind-vs-redeclare choice) is exactly the
 * one a typed edit already goes through. This module's only job is: figure
 * out the colour under the pointer (or the screen pixel), and hand it to
 * `apply` exactly once per successful pick.
 *
 * The canvas source is a `SurfaceMode` (`engine/surfaceMode.ts`, shared with
 * SELECT/STAGE) rather than a parallel branch in `CanvasSurface`'s own
 * handlers — while this mode is active, the surface's default click/hover/
 * marquee/draw behaviour does not run; this module sees every pointer event
 * for the viewport instead.
 */

import { useSyncExternalStore } from "react";
import type { SurfaceMode, SurfaceModeContext, SurfaceModes } from "../../engine/surfaceMode";
import type { SceneStore } from "../../engine/useScene";
import type { SelectionStore } from "../../engine/useSelection";
import type { ViewportController } from "../../engine/useViewport";
import { slopFor } from "../../scene/picking";
import { paintAt, type PaintRegion, type PaintSample } from "../../scene/paintAt";
import type { NodeId } from "../../scene/types";
import { displayColor, parseColor, writeColor } from "./color";

export type PickSource = "canvas" | "screen";

export interface PickResult {
  css: string;
  /** `sample` is a screen pixel; every other kind comes from `paintAt`. */
  kind: PaintSample["kind"] | "sample";
  source: PickSource;
  nodeId?: NodeId | null;
  region?: PaintRegion;
}

export interface PickDestination {
  /** `"paint"` also accepts a whole gradient (Shift on a gradient fill). */
  accepts: "color" | "paint";
  /** What the field shows now. A plain sample/hex keeps this value's alpha. */
  current: string;
  /**
   * Exactly once per successful pick. Must be the field's own `onChange`
   * path for a plain colour/gradient result — including the bound-field
   * rebind-vs-redeclare branching, which is the field's own business, not
   * this session's (see `ColorField.tsx`'s `Body`).
   */
  apply(value: string, result: PickResult): void;
  /** Optional, per hover frame, never dispatches ops. `null` = pointer left. */
  preview?(value: string | null): void;
}

/** The slice of `CanvasApi` a pick needs — spelled out structurally so this
 *  module never has to import `render/CanvasSurface.tsx` (which itself,
 *  transitively, reaches back into the panels through `StylePanel`'s types)
 *  just for one interface. Any `CanvasApi` already satisfies this shape. */
export interface PickHost {
  modes: SurfaceModes;
  store: SceneStore;
  selection: SelectionStore;
  viewport: ViewportController;
}

export type ColorPickState =
  | { active: false }
  | { active: true; source: PickSource; destination: PickDestination };

export interface ColorPickStore {
  /**
   * Start a session. Any running session is cancelled first (its `apply`
   * never fires). Returns `false` when the source is unavailable (`canvas`
   * with no host, `screen` without the API — nothing is entered either way).
   * `screen` must be called synchronously from a user gesture (transient
   * activation) or the browser rejects `EyeDropper.open()`.
   */
  start(dest: PickDestination, source: PickSource, host: PickHost | null): boolean;
  cancel(): void;
  get(): ColorPickState;
  subscribe(listener: () => void): () => void;
}

export function canSampleScreen(): boolean {
  return typeof window !== "undefined" && "EyeDropper" in window;
}

/** Ambient typing — this TS version's `lib.dom.d.ts` has none. */
declare global {
  interface EyeDropperResult {
    sRGBHex: string;
  }
  interface EyeDropper {
    open(options?: { signal?: AbortSignal }): Promise<EyeDropperResult>;
  }
  interface Window {
    EyeDropper?: new () => EyeDropper;
  }
}

/** The chrome a document click/scroll outside a pick session must not close
 *  — the pill's own host panel, and any nested popover (a gradient stop's
 *  colour field opened from inside another popover). */
const PICK_CHROME = ".nt-ctl-pop, .nt-style-panel";

// ---------------------------------------------------------------------------
// The canvas mode
// ---------------------------------------------------------------------------

/** `sample.css` for a `var()` result shows just the name, matching
 *  `ColorField`'s own `varLabel`; anything else shows the way a swatch does. */
function pillText(sample: PaintSample | null, wholeGradient: boolean): string {
  if (!sample || sample.kind === "none") return "—";
  if (wholeGradient && sample.paint) return "Gradient";
  if (sample.css.startsWith("var(")) return sample.css.slice(4, -1).replace(/^--/, "");
  return displayColor(sample.css);
}

interface CanvasModeCallbacks {
  /** Release the mode after a successful pick — routes through the exact
   *  same `SurfaceModes.enter` release function `cancel()` uses, so both
   *  paths exit through one place. */
  release: () => void;
  /** A `needsScreen` result: release this mode, then start a screen session. */
  toScreen: () => void;
  /**
   * The mode stopped being active, for ANY reason — a successful pick's own
   * `release()`, an external `cancel()`, Escape, being replaced by another
   * slice's mode, or the canvas unmounting. This is the ONE signal the store
   * uses to know it is idle again; without it, an exit that did not go
   * through this mode's own `release()` (an external `SurfaceModes.exit()`,
   * or the registry's own Escape handling) would leave the store's state
   * stuck saying "active" for a mode that no longer exists.
   */
  onExit: () => void;
}

function buildCanvasMode(dest: PickDestination, host: PickHost, callbacks: CanvasModeCallbacks): SurfaceMode {
  const { release, toScreen, onExit: notifyExit } = callbacks;
  let pill: HTMLDivElement | null = null;
  let rafId = 0;
  let pending: { clientX: number; clientY: number; alt: boolean; shift: boolean } | null = null;
  let capturedContainer: HTMLElement | null = null;
  let capturedId: number | null = null;
  let finishListener: ((e: PointerEvent) => void) | null = null;

  const removePill = () => {
    pill?.remove();
    pill = null;
  };

  const stopCapture = () => {
    if (capturedContainer && finishListener) {
      capturedContainer.removeEventListener("pointerup", finishListener);
    }
    if (capturedContainer && capturedId !== null) {
      try {
        capturedContainer.releasePointerCapture(capturedId);
      } catch {
        // Already released (a normal pointerup already did it) — fine.
      }
    }
    finishListener = null;
    capturedContainer = null;
    capturedId = null;
  };

  const sampleAt = (
    ctx: SurfaceModeContext,
    clientX: number,
    clientY: number,
    opts: { text?: boolean; wholePaint?: boolean },
  ): PaintSample | null => {
    const point = ctx.scenePoint({ clientX, clientY });
    const tolerance = slopFor(host.viewport.screenScale());
    return paintAt(ctx.laid(), point, { tolerance, ...opts });
  };

  // `typeof document`/`requestAnimationFrame` rather than a bare reference:
  // this module's own vitest suite runs in a DOM-less, rAF-less environment
  // (the same posture `engine/surfaceMode.ts` takes for `document`) — the
  // pill is purely cosmetic and simply does not draw there, while
  // `host.selection.hover`/`dest.preview` (the parts a test actually asserts
  // on) still run every "frame" the fallback below still calls synchronously.
  const hasDocument = () => typeof document !== "undefined";
  const raf: (cb: FrameRequestCallback) => number =
    typeof requestAnimationFrame !== "undefined"
      ? requestAnimationFrame
      : (cb) => {
          cb(0);
          return 0;
        };
  const caf: (id: number) => void = typeof cancelAnimationFrame !== "undefined" ? cancelAnimationFrame : () => {};

  const paintPill = (el: HTMLDivElement, container: HTMLElement, clientX: number, clientY: number, text: string, chip: string | null) => {
    const rect = container.getBoundingClientRect();
    let left = clientX - rect.left + 16;
    let top = clientY - rect.top + 18;
    const w = el.offsetWidth || 96;
    const h = el.offsetHeight || 26;
    if (left + w > container.clientWidth - 8) left = clientX - rect.left - 16 - w;
    if (top + h > container.clientHeight - 8) top = clientY - rect.top - 18 - h;
    el.style.left = `${Math.max(0, left)}px`;
    el.style.top = `${Math.max(0, top)}px`;
    el.innerHTML = "";
    const chipEl = document.createElement("span");
    chipEl.className = "nt-ctl-chip";
    if (chip) {
      const fill = document.createElement("span");
      fill.className = "nt-ctl-chip-fill";
      fill.style.background = chip;
      chipEl.appendChild(fill);
    }
    const label = document.createElement("span");
    label.className = "nt-pick-pill-text";
    label.textContent = text;
    el.append(chipEl, label);
  };

  return {
    id: "color-pick",

    onPointerDown(e, ctx) {
      if (e.button !== 0) return;
      const container = ctx.container();
      if (!container) return;
      container.setPointerCapture(e.pointerId);
      capturedContainer = container;
      capturedId = e.pointerId;

      const finish = (up: PointerEvent) => {
        if (capturedId !== up.pointerId) return;
        stopCapture();
        const wholePaint = up.shiftKey && dest.accepts === "paint";
        const sample = sampleAt(ctx, up.clientX, up.clientY, { text: up.altKey, wholePaint });
        if (!sample || sample.kind === "none") {
          if (sample?.needsScreen && canSampleScreen()) toScreen();
          // Otherwise: nothing to take — the session stays up.
          return;
        }
        release();
        dest.apply(sample.css, {
          css: sample.css,
          kind: sample.kind,
          source: "canvas",
          nodeId: sample.nodeId,
          region: sample.region,
        });
      };
      finishListener = finish;
      container.addEventListener("pointerup", finish);
    },

    onPointerMove(e, ctx) {
      pending = { clientX: e.clientX, clientY: e.clientY, alt: e.altKey, shift: e.shiftKey };
      if (rafId) return;
      rafId = raf(() => {
        rafId = 0;
        const move = pending;
        if (!move) return;
        const container = ctx.container();
        const wholePaint = move.shift && dest.accepts === "paint";
        const sample = sampleAt(ctx, move.clientX, move.clientY, { text: move.alt, wholePaint });
        if (container && hasDocument()) {
          if (!pill) {
            pill = document.createElement("div");
            pill.className = "nt-pick-pill";
            container.appendChild(pill);
          }
          const text = pillText(sample, wholePaint);
          const chip = sample && sample.kind !== "none" ? (sample.paint ?? sample.css) : null;
          paintPill(pill, container, move.clientX, move.clientY, text, chip);
        }
        const tolerance = slopFor(host.viewport.screenScale());
        host.selection.hover(ctx.scenePoint(move), { deep: true, tolerance });
        dest.preview?.(sample && sample.kind !== "none" ? sample.css : null);
      });
    },

    onPointerLeave() {
      removePill();
      host.selection.hover(null);
      dest.preview?.(null);
    },

    onKeyDown() {
      // Never consumed: Escape always exits a pick, via the registry's own
      // default behaviour for a mode that returns false here.
      return false;
    },

    onExit() {
      if (rafId) caf(rafId);
      rafId = 0;
      pending = null;
      stopCapture();
      removePill();
      host.selection.hover(null);
      dest.preview?.(null);
      notifyExit();
    },
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export function createColorPickStore(): ColorPickStore {
  let state: ColorPickState = { active: false };
  const listeners = new Set<() => void>();
  /** Canvas source only: the release function `SurfaceModes.enter` returned.
   *  `cancel()` calls it; a successful pick calls the very same function
   *  itself (via `buildCanvasMode`'s own `release` callback) — either way,
   *  the mode's `onExit` is what actually drives this store back to idle
   *  (see `goIdle`, called from `onExit` below), so the two paths can never
   *  disagree about whether a session is still open. */
  let releaseMode: (() => void) | null = null;
  /** Screen source only. */
  let abort: AbortController | null = null;
  let outsideListener: ((e: PointerEvent) => void) | null = null;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const disarmOutside = () => {
    if (outsideListener && typeof document !== "undefined") {
      document.removeEventListener("pointerdown", outsideListener, true);
    }
    outsideListener = null;
  };

  /**
   * The one place either source becomes idle. Called from the canvas mode's
   * own `onExit` (itself invoked by `SurfaceModes` for every kind of exit —
   * released, replaced, escape, unmounted — not only the ones this store
   * initiated) and from the screen promise's own settle handlers. Idempotent:
   * a mode that is already gone by the time this runs is a no-op.
   */
  const goIdle = () => {
    if (!state.active) return;
    releaseMode = null;
    disarmOutside();
    state = { active: false };
    notify();
  };

  function cancel(): void {
    if (!state.active) return;
    if (state.source === "canvas") {
      // Triggers `SurfaceModes.exit` synchronously, which calls the mode's
      // own `onExit`, which calls `goIdle()` above — this function does not
      // flip `state` itself.
      releaseMode?.();
    } else {
      abort?.abort();
      abort = null;
      goIdle();
    }
  }

  function start(dest: PickDestination, source: PickSource, host: PickHost | null): boolean {
    if (state.active) cancel();

    if (source === "screen") {
      if (!canSampleScreen()) return false;
      const controller = new AbortController();
      abort = controller;
      state = { active: true, source: "screen", destination: dest };
      notify();
      const EyeDropperCtor = window.EyeDropper!;
      new EyeDropperCtor()
        .open({ signal: controller.signal })
        .then((result) => {
          if (abort !== controller) return; // superseded by a later session
          abort = null;
          const parsed = parseColor(result.sRGBHex);
          const value = parsed
            ? writeColor(dest.current, { ...parsed, a: parseColor(dest.current)?.a ?? 1 })
            : result.sRGBHex;
          goIdle();
          dest.apply(value, { css: value, kind: "sample", source: "screen" });
        })
        .catch(() => {
          if (abort !== controller) return;
          abort = null;
          goIdle();
        });
      return true;
    }

    if (!host) return false;
    // `release` is filled in right after `enter()` returns it, below — the
    // mode needs the function in order to call it on a successful pick, and
    // `enter()` needs the mode object first, so a one-slot box breaks the
    // chicken-and-egg without inventing a second exit path.
    const releaseBox: { current: () => void } = { current: () => {} };
    const mode = buildCanvasMode(dest, host, {
      release: () => releaseBox.current(),
      toScreen: () => {
        releaseBox.current();
        start(dest, "screen", host);
      },
      onExit: goIdle,
    });
    releaseMode = host.modes.enter(mode);
    releaseBox.current = releaseMode;
    outsideListener = (e: PointerEvent) => {
      const target = e.target;
      const container = host.viewport.containerRef.current;
      if (target instanceof Node && container?.contains(target)) return;
      if (target instanceof Element && target.closest(PICK_CHROME)) return;
      cancel();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("pointerdown", outsideListener, true);
    }
    state = { active: true, source: "canvas", destination: dest };
    notify();
    return true;
  }

  return {
    start,
    cancel,
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Module singleton — one pick session for the whole app, like `labelEditing.ts`'s. */
export const colorPick: ColorPickStore = createColorPickStore();

export function useColorPick(): ColorPickState {
  return useSyncExternalStore(colorPick.subscribe, colorPick.get, colorPick.get);
}
