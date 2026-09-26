import { useLayoutEffect, type RefObject } from "react";
import { COLUMN_WIDTH } from "./column";
// The light half of `band`: this loads with every page, ahead of the renderer.
import { WIDE_W } from "@/app/components/editor/canvas/scene/bandSpan";
import { ZOOM_EVENT } from "./docZoom";

/** The page's side padding: wide enough for the block handle's whole cluster, or not. */
const PAGE_GUTTER = 24;
const PAGE_GUTTER_WIDE = 56;
/** From here the text has its full measure beside the wide gutter. */
export const PAGE_BREAKPOINT = COLUMN_WIDTH + 2 * PAGE_GUTTER_WIDE;
/** Below this the wide gutter would cost the text too much, and gives way to the narrow one. */
export const NARROW_BREAKPOINT = 640;
/** What a wide band keeps clear of the pane's edges, so it never meets them. */
const WIDE_BAND_GUTTER = 24;

type PageMode = "wide" | "flow" | "narrow";

type PageFit = {
  mode: PageMode;
  /** What a column-width band is scaled by to match the text: 1 when `wide`. */
  fit: number;
  /** What a wide band is scaled by to fit the pane. */
  wideFit: number;
};

/** The page's layout for a pane whose content box is `pane` px wide. */
export function pageFit(pane: number): PageFit {
  const mode: PageMode =
    pane >= PAGE_BREAKPOINT ? "wide" : pane >= NARROW_BREAKPOINT ? "flow" : "narrow";
  const gutter = mode === "narrow" ? PAGE_GUTTER : PAGE_GUTTER_WIDE;
  const fit = Math.min(COLUMN_WIDTH, Math.max(1, pane - 2 * gutter)) / COLUMN_WIDTH;
  const wideFit = Math.min(1, Math.max(1, pane - 2 * WIDE_BAND_GUTTER) / WIDE_W);
  return { mode, fit, wideFit };
}

/**
 * How much the CSS `zoom` above `el` magnifies it: client px per the element's
 * own CSS px, 1 where nothing is zoomed. Read off the element's box rather
 * than `currentCSSZoom`, so it agrees with whatever the browser's rects and
 * pointer events report. Untransformed elements only — a transform shows in
 * the rect but not in `offsetWidth`.
 */
export function effectiveScale(el: Element): number {
  const host = el instanceof HTMLElement ? el : (el.closest("svg")?.parentElement ?? null);
  const w = host?.offsetWidth ?? 0;
  if (!host || !w) return 1;
  const s = host.getBoundingClientRect().width / w;
  return Number.isFinite(s) && s > 0 ? s : 1;
}

/** The zoom root every page's column sits in; `docZoom` magnifies it. */
export const SHEET = ".nt-sheet";

type FitKind = "normal" | "wide";

type Sheet = {
  fit: number;
  wideFit: number;
  followers: Map<HTMLElement, FitKind>;
};

/*
 * Held per sheet and pushed to each follower, rather than set as a custom
 * property the bands inherit: the pane's observer fires on every frame of a
 * rail animation, and an inherited property restyles the whole document each
 * time (see `columnEdges`).
 */
const sheets = new WeakMap<Element, Sheet>();

function sheetOf(sheet: Element): Sheet {
  let known = sheets.get(sheet);
  if (!known) {
    known = { fit: 1, wideFit: 1, followers: new Map() };
    sheets.set(sheet, known);
  }
  return known;
}

/** True when the element's zoom changed. */
function write(el: HTMLElement, kind: FitKind, sheet: Sheet): boolean {
  const scale = kind === "wide" ? sheet.wideFit : sheet.fit;
  const zoom = scale === 1 ? "" : String(scale);
  if (el.style.zoom === zoom) return false;
  el.style.zoom = zoom;
  return true;
}

/** Fired, bubbling, on a sheet whose bands were rescaled to a new fit, or on a band that joined one rescaled. */
const FIT_EVENT = "nt-fit";

/** What a band of `kind` at `el` is scaled by to fit its page: 1 outside a sheet. */
export function fitOf(el: Element, kind: FitKind): number {
  const host = el.closest(SHEET);
  const sheet = host ? sheets.get(host) : undefined;
  if (!sheet) return 1;
  return kind === "wide" ? sheet.wideFit : sheet.fit;
}

/**
 * Runs `fn` whenever what magnifies `el` may have changed without a resize
 * telling it: the zoom of its pane, or the fit of its page. `el` is read at
 * event time, so an element that mounts late still hears.
 */
export function onScaleWithin(el: () => Element | null | undefined, fn: () => void): () => void {
  const listener = (event: Event) => {
    const target = el();
    if (target && event.target instanceof Node && event.target.contains(target)) fn();
  };
  window.addEventListener(ZOOM_EVENT, listener);
  window.addEventListener(FIT_EVENT, listener);
  return () => {
    window.removeEventListener(ZOOM_EVENT, listener);
    window.removeEventListener(FIT_EVENT, listener);
  };
}

/**
 * Keeps `el` — a band, drawn at its logical width — scaled to the page it is
 * in, until the returned function is called. Outside a sheet (a harness, a
 * read-only preview) the scale is 1.
 */
export function followFit(el: HTMLElement, kind: FitKind): () => void {
  const host = el.closest(SHEET);
  if (!host) {
    el.style.zoom = "";
    return () => {};
  }
  const sheet = sheetOf(host);
  sheet.followers.set(el, kind);
  // Whatever inside measured the band before it was scaled hears that it was.
  if (write(el, kind, sheet)) el.dispatchEvent(new Event(FIT_EVENT, { bubbles: true }));
  return () => {
    if (sheet.followers.get(el) !== kind) return;
    sheet.followers.delete(el);
    // Heard as a rescale too: a band going wide and back follows again at the
    // zoom it had, and nothing else would tell what measured it at the other.
    if (!el.style.zoom) return;
    el.style.zoom = "";
    el.dispatchEvent(new Event(FIT_EVENT, { bubbles: true }));
  };
}

let frozen = false;
const deferred = new Set<() => void>();

/**
 * Holds every page's fit where it is while a pointer is down on a diagram, and
 * applies what changed meanwhile on release — a rail opening on a selection
 * must not rescale the band under the hand that made it.
 */
export function setFitFrozen(on: boolean) {
  if (frozen === on) return;
  frozen = on;
  if (on) return;
  for (const run of [...deferred]) run();
  deferred.clear();
}

/**
 * Lays the page out for its pane: `data-page` on the sheet, and the fit its
 * bands follow. Measured off the pane, which the document zoom never touches,
 * so a zoom changes nothing here.
 */
export function usePageFit(
  paneRef: RefObject<HTMLElement | null>,
  sheetRef: RefObject<HTMLElement | null>,
) {
  useLayoutEffect(() => {
    const pane = paneRef.current;
    const host = sheetRef.current;
    if (!pane || !host) return;
    const sheet = sheetOf(host);
    let fresh = true;

    const apply = (width: number) => {
      const next = pageFit(width);
      if (host.dataset.page !== next.mode) host.dataset.page = next.mode;
      if (!fresh && next.fit === sheet.fit && next.wideFit === sheet.wideFit) return;
      fresh = false;
      sheet.fit = next.fit;
      sheet.wideFit = next.wideFit;
      for (const [el, kind] of sheet.followers) write(el, kind, sheet);
      host.dispatchEvent(new Event(FIT_EVENT, { bubbles: true }));
    };
    const measure = () => {
      const style = getComputedStyle(pane);
      apply(
        pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      );
    };

    measure();
    const observer = new ResizeObserver(([entry]) => {
      if (frozen) deferred.add(measure);
      else apply(entry.contentRect.width);
    });
    observer.observe(pane);
    return () => {
      observer.disconnect();
      deferred.delete(measure);
    };
  }, [paneRef, sheetRef]);
}
