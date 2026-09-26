/**
 * Document zoom: pure magnification of one pane's page, 100–200%. It lives on
 * the pane's sheet as CSS `zoom` with the sheet's width scaled to match, so the
 * text never reflows and the pane — which is never zoomed itself — scrolls both
 * ways over the result. Not persisted: every page opens at 100%.
 */

export type ZoomPane = "main" | "aside";

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 2;
export const ZOOM_STEPS: readonly number[] = [1, 1.25, 1.5, 1.75, 2];

/** Fired on the pane, bubbling, after every change of its zoom. */
export const ZOOM_EVENT = "nt-zoom";

const EPS = 1e-6;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return ZOOM_MIN;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** The next step strictly past `z` in the direction asked — from 130%, in is 150%, out is 125%. */
export function stepZoom(z: number, dir: 1 | -1): number {
  const next =
    dir > 0
      ? ZOOM_STEPS.find((s) => s > z + EPS)
      : [...ZOOM_STEPS].reverse().find((s) => s < z - EPS);
  return next ?? (dir > 0 ? ZOOM_MAX : ZOOM_MIN);
}

/** `deltaMode` as the DOM numbers it: pixels, lines, pages. */
const DELTA_LINE = 1;
const DELTA_PAGE = 2;
const LINE_PX = 16;
/**
 * Wheel px → zoom, as `exp(-delta * SENSITIVITY)`: a gesture zooms by the same
 * ratio wherever it starts. A trackpad pinch sends many small deltas and a
 * mouse notch one of 100 or more, so each event's delta is clamped — one notch
 * is about one step, and a pinch is not damped.
 */
const SENSITIVITY = 0.01;
const MAX_WHEEL_STEP = 30;

export function wheelPixels(delta: number, deltaMode: number, pageHeight: number): number {
  if (deltaMode === DELTA_LINE) return delta * LINE_PX;
  if (deltaMode === DELTA_PAGE) return delta * pageHeight;
  return delta;
}

export function wheelZoom(z: number, delta: number, deltaMode: number, pageHeight: number): number {
  const px = wheelPixels(delta, deltaMode, pageHeight);
  const step = Math.min(MAX_WHEEL_STEP, Math.max(-MAX_WHEEL_STEP, px));
  return clampZoom(z * Math.exp(-step * SENSITIVITY));
}

/**
 * The scroll offset along one axis that keeps the point under `anchor` still
 * across a zoom from `z0` to `z1`. `origin0`/`origin1` are the sheet's edge as
 * it would sit at scroll 0 (its client edge plus the scroll it was read at),
 * before and after the write; `scroll0` is the offset the old frame was laid
 * out at — the float intended, not the integer the browser kept.
 */
export function anchorScroll(
  origin0: number,
  origin1: number,
  scroll0: number,
  z0: number,
  z1: number,
  anchor: number,
): number {
  const logical = (anchor - (origin0 - scroll0)) / z0;
  return origin1 + logical * z1 - anchor;
}

export type ZoomAnchor = { x: number; y: number };

export type ZoomStore = {
  get(): number;
  /** Zoom to `z`, keeping the point under `anchor` still — the pane's centre when absent. */
  set(z: number, anchor?: ZoomAnchor): void;
  reset(): void;
  subscribe(listener: () => void): () => void;
  attach(pane: HTMLElement, sheet: HTMLElement): () => void;
};

function createStore(): ZoomStore {
  let zoom = 1;
  let pane: HTMLElement | null = null;
  let sheet: HTMLElement | null = null;
  /*
   * The offset last asked for, unrounded. A pinch is dozens of applies, and
   * re-deriving each from the integer the browser kept drifts the anchor.
   */
  let intended: { left: number; top: number } | null = null;
  const listeners = new Set<() => void>();

  const style = (el: HTMLElement, z: number) => {
    el.style.zoom = z === 1 ? "" : String(z);
    el.style.width = z === 1 ? "" : `${z * 100}%`;
  };

  const apply = (z: number, anchor?: ZoomAnchor) => {
    if (!pane || !sheet) return;
    const box = pane.getBoundingClientRect();
    const at = anchor ?? {
      x: box.left + pane.clientLeft + pane.clientWidth / 2,
      y: box.top + pane.clientTop + pane.clientHeight / 2,
    };
    const held =
      intended &&
      Math.abs(intended.left - pane.scrollLeft) < 1 &&
      Math.abs(intended.top - pane.scrollTop) < 1;
    const left0 = held ? intended!.left : pane.scrollLeft;
    const top0 = held ? intended!.top : pane.scrollTop;
    const r0 = sheet.getBoundingClientRect();
    const x0 = r0.left + pane.scrollLeft;
    const y0 = r0.top + pane.scrollTop;

    style(sheet, z);
    const r1 = sheet.getBoundingClientRect();
    const left = anchorScroll(x0, r1.left + pane.scrollLeft, left0, zoom, z, at.x);
    const top = anchorScroll(y0, r1.top + pane.scrollTop, top0, zoom, z, at.y);
    pane.scrollLeft = left;
    pane.scrollTop = top;
    intended = { left, top };

    zoom = z;
    for (const listener of [...listeners]) listener();
    pane.dispatchEvent(new CustomEvent(ZOOM_EVENT, { bubbles: true, detail: { zoom: z } }));
  };

  return {
    get: () => zoom,
    set(z, anchor) {
      const next = clampZoom(z);
      if (!pane || !sheet || Math.abs(next - zoom) < EPS) return;
      apply(next, anchor);
    },
    reset() {
      if (zoom === 1) return;
      if (pane && sheet) return apply(1);
      zoom = 1;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attach(paneEl, sheetEl) {
      pane = paneEl;
      sheet = sheetEl;
      intended = null;
      style(sheetEl, zoom);
      return () => {
        if (pane !== paneEl || sheet !== sheetEl) return;
        style(sheetEl, 1);
        pane = null;
        sheet = null;
        intended = null;
        if (zoom === 1) return;
        zoom = 1;
        for (const listener of [...listeners]) listener();
      };
    },
  };
}

const stores = new Map<ZoomPane, ZoomStore>();

/** The zoom of one pane: module-level, so the toolbar reads it without the page rendering. */
export function zoomFor(pane: ZoomPane): ZoomStore {
  let store = stores.get(pane);
  if (!store) {
    store = createStore();
    stores.set(pane, store);
  }
  return store;
}

/**
 * Runs `fn` whenever a pane holding `el` changes zoom — for anything measured
 * in client px that no resize will tell about it. `el` is read at event time,
 * so an element that mounts late still hears.
 */
export function onZoomWithin(
  el: () => Element | null | undefined,
  fn: () => void,
): () => void {
  const listener = (event: Event) => {
    const target = el();
    if (target && event.target instanceof Node && event.target.contains(target)) fn();
  };
  window.addEventListener(ZOOM_EVENT, listener);
  return () => window.removeEventListener(ZOOM_EVENT, listener);
}
