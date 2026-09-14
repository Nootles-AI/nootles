/**
 * The screen-mode store: expanded stage, minimal UI, browser fullscreen.
 *
 * Pure state (`ScreenState`, {@link reduceScreen}, {@link recentre}) plus a
 * small controller (`ScreenControl`) that drives a host — the surface that
 * actually owns the DOM. Nothing here touches `document` except through the
 * host it is handed, which is what keeps {@link reduceScreen}/{@link recentre}
 * testable with a fake and the real one (`render/CanvasSurface.tsx`) the only
 * place that ever calls `requestFullscreen`.
 *
 * View state only: no `SceneOp`, no scene store, no undo entry. Figma keeps
 * screen mode out of history for the same reason — it is not something you
 * drew.
 */

import type { Viewport } from "../scene/types";

export interface ScreenState {
  /** The viewport fills the document column (fixed), the wrapper stays in flow. */
  readonly stage: boolean;
  /** Toolbar and rails hidden. Independent of `stage`. */
  readonly minimal: boolean;
  /** `document.documentElement` is the fullscreen element. Implies `stage`. */
  readonly fullscreen: boolean;
}

export const SCREEN_OFF: ScreenState = Object.freeze({
  stage: false,
  minimal: false,
  fullscreen: false,
});

/**
 * Pure. Applies `patch`, then the two rules: `fullscreen: true` forces
 * `stage: true`; `stage: false` forces `fullscreen: false` (stage rule wins
 * if a patch says both). Returns `prev` by identity when nothing changed.
 */
export function reduceScreen(
  prev: ScreenState,
  patch: Partial<ScreenState>,
): ScreenState {
  const merged: ScreenState = { ...prev, ...patch };
  let stage = merged.stage;
  const minimal = merged.minimal;
  let fullscreen = merged.fullscreen;
  // Rule A: turning fullscreen on brings the stage with it.
  if (fullscreen) stage = true;
  // The patch's own explicit `stage: false` outranks rule A above — a caller
  // that asked for both in one breath meant "not staged", full stop.
  if (patch.stage === false) stage = false;
  // Rule B, applied last so it sees the resolved `stage`: no stage, no
  // fullscreen — there is nothing left for the fullscreen element to be.
  if (!stage) fullscreen = false;

  if (stage === prev.stage && minimal === prev.minimal && fullscreen === prev.fullscreen) {
    return prev;
  }
  return Object.freeze({ stage, minimal, fullscreen });
}

export interface Size {
  w: number;
  h: number;
}

/**
 * Pure. The viewport that shows the same scene point under the container's
 * centre after the container changed from `before` to `after` (px). Zoom is
 * kept. Either size having a zero axis returns `vp` unchanged.
 *   cx = (before.w/2 - vp.x) / vp.zoom ; x' = after.w/2 - cx * vp.zoom  (same for y)
 */
export function recentre(vp: Viewport, before: Size, after: Size): Viewport {
  if (before.w === 0 || before.h === 0 || after.w === 0 || after.h === 0) {
    return vp;
  }
  const cx = (before.w / 2 - vp.x) / vp.zoom;
  const cy = (before.h / 2 - vp.y) / vp.zoom;
  return {
    x: after.w / 2 - cx * vp.zoom,
    y: after.h / 2 - cy * vp.zoom,
    zoom: vp.zoom,
  };
}

/** What the store asks the surface to do. All DOM lives behind this. */
export interface ScreenHost {
  /** False for a read-only or framed surface: every `set` is then a no-op. */
  enabled: boolean;
  applyStage(on: boolean): void;
  canFullscreen(): boolean;
  /** Rejects when unavailable or refused (no user activation). */
  requestFullscreen(): Promise<void>;
  exitFullscreen(): Promise<void>;
}

export interface ScreenControl {
  /** Frozen; a new object per change. */
  get(): ScreenState;
  /** Reduce → apply → notify. */
  set(patch: Partial<ScreenState>): void;
  toggle(key: keyof ScreenState): void;
  reset(): void;
  /**
   * The browser already changed reality (`fullscreenchange`): record it
   * without asking the host to request/exit again. Host use only.
   */
  sync(patch: Partial<ScreenState>): void;
  /** `host.enabled && host.canFullscreen()`. */
  canFullscreen(): boolean;
  /** `useSyncExternalStore`-shaped. */
  subscribe(listener: () => void): () => void;
}

const noop = () => {};

export function createScreenControl(host: ScreenHost): ScreenControl {
  let state: ScreenState = SCREEN_OFF;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  function apply(patch: Partial<ScreenState>, withHost: boolean): void {
    if (!host.enabled) return;
    const next = reduceScreen(state, patch);
    if (next === state) return;
    const prev = state;
    state = next;
    if (next.stage !== prev.stage) host.applyStage(next.stage);
    if (withHost && next.fullscreen !== prev.fullscreen) {
      if (next.fullscreen) {
        void host.requestFullscreen().catch(() => sync({ fullscreen: false }));
      } else {
        void host.exitFullscreen().catch(noop);
      }
    }
    notify();
  }

  function set(patch: Partial<ScreenState>): void {
    apply(patch, true);
  }
  function sync(patch: Partial<ScreenState>): void {
    apply(patch, false);
  }

  return {
    get: () => state,
    set,
    sync,
    toggle: (key) => set({ [key]: !state[key] } as Partial<ScreenState>),
    reset: () => set({ stage: false, minimal: false }),
    canFullscreen: () => host.enabled && host.canFullscreen(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
