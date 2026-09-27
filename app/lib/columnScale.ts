import { useLayoutEffect, type RefObject } from "react";
import { COLUMN_WIDTH } from "./column";
// The light half of `band`: this loads with every page, ahead of the renderer.
import { WIDE_MARGIN, WIDE_W } from "@/app/components/editor/canvas/scene/bandSpan";
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
  /** What every band is drawn at: the text's own scale, 1 when `wide`. */
  fit: number;
  /** The page px a wide band may span, centred on the column. */
  room: number;
};

/** The page's layout for a pane whose content box is `pane` px wide. */
export function pageFit(pane: number): PageFit {
  const mode: PageMode =
    pane >= PAGE_BREAKPOINT ? "wide" : pane >= NARROW_BREAKPOINT ? "flow" : "narrow";
  const gutter = mode === "narrow" ? PAGE_GUTTER : PAGE_GUTTER_WIDE;
  const fit = Math.min(COLUMN_WIDTH, Math.max(1, pane - 2 * gutter)) / COLUMN_WIDTH;
  return { mode, fit, room: Math.max(1, pane - 2 * WIDE_BAND_GUTTER) };
}

/**
 * How much of a wide band the page shows, in the band's own px: drawn at the
 * text's scale like every band — so a diagram is the same size whichever
 * width it is — it shows as much of `WIDE_W` as the room holds, centred on
 * the column, and never less than the column. `margin` is what it shows past
 * the text on each side; the rest of the margins is clipped.
 */
export function wideSpan(fit: number, room: number): { width: number; margin: number } {
  const width = Math.min(WIDE_W, Math.max(COLUMN_WIDTH, room / fit));
  return { width, margin: (width - COLUMN_WIDTH) / 2 };
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

/** Hears a wide band's shown margin, in its own px, whenever it changes. */
type OnMargin = (margin: number) => void;

type Sheet = {
  fit: number;
  room: number;
  /** Every band on the page, and — for a wide one — who hears its margin. */
  followers: Map<HTMLElement, OnMargin | null>;
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
    known = { fit: 1, room: WIDE_W, followers: new Map() };
    sheets.set(sheet, known);
  }
  return known;
}

/**
 * The band at the page's fit, and a wide one at the width it shows. True when
 * the zoom changed — a new width is heard through the band's own resize.
 */
function write(el: HTMLElement, onMargin: OnMargin | null, fit: number, room: number): boolean {
  if (onMargin) {
    const { width, margin } = wideSpan(fit, room);
    const px = `${width}px`;
    if (el.style.width !== px) el.style.width = px;
    onMargin(margin);
  }
  const zoom = fit === 1 ? "" : String(fit);
  if (el.style.zoom === zoom) return false;
  el.style.zoom = zoom;
  return true;
}

/** Fired, bubbling, on a sheet whose bands were rescaled to a new fit, or on a band that joined one rescaled. */
const FIT_EVENT = "nt-fit";

/** What a band at `el` is drawn at to match its page's text: 1 outside a sheet. */
export function fitOf(el: Element): number {
  const host = el.closest(SHEET);
  return (host && sheets.get(host)?.fit) || 1;
}

/**
 * What a wide band at `el` shows past the text on each side, in the band's own
 * px — `WIDE_MARGIN` outside a sheet. What a column band's margins would show
 * if it went wide, too: the room a push past its side opens.
 */
export function wideMarginOf(el: Element): number {
  const host = el.closest(SHEET);
  const sheet = host ? sheets.get(host) : undefined;
  return sheet ? wideSpan(sheet.fit, sheet.room).margin : WIDE_MARGIN;
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

function follow(el: HTMLElement, onMargin: OnMargin | null): () => void {
  const host = el.closest(SHEET);
  if (!host) {
    el.style.zoom = "";
    write(el, onMargin, 1, WIDE_W);
    return () => {};
  }
  const sheet = sheetOf(host);
  sheet.followers.set(el, onMargin);
  // Whatever inside measured the band before it was scaled hears that it was.
  if (write(el, onMargin, sheet.fit, sheet.room)) el.dispatchEvent(new Event(FIT_EVENT, { bubbles: true }));
  return () => {
    if (sheet.followers.get(el) !== onMargin) return;
    sheet.followers.delete(el);
    // Heard as a rescale too: a band leaving the page for a moment follows
    // again at the zoom it had, and nothing else would tell what measured it.
    if (!el.style.zoom) return;
    el.style.zoom = "";
    el.dispatchEvent(new Event(FIT_EVENT, { bubbles: true }));
  };
}

/**
 * Keeps `el` — a band, drawn at its logical width — at its page's text scale,
 * until the returned function is called. Outside a sheet (a harness, a
 * read-only preview) the scale is 1.
 */
export function followFit(el: HTMLElement): () => void {
  return follow(el, null);
}

/**
 * {@link followFit} for a wide band, which also owns its width: as much of
 * `WIDE_W` as the page shows ({@link wideSpan}). `onMargin` hears the margin
 * shown on each side — where the band's scene origin sits, so the text's edge
 * stays scene 0 — now and on every change of the page. It never rescales: a
 * wide band is drawn at the scale a column one is.
 */
export function followWide(el: HTMLElement, onMargin: OnMargin): () => void {
  return follow(el, onMargin);
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
      if (!fresh && next.fit === sheet.fit && next.room === sheet.room) return;
      const rescaled = fresh || next.fit !== sheet.fit;
      fresh = false;
      sheet.fit = next.fit;
      sheet.room = next.room;
      for (const [el, onMargin] of sheet.followers) write(el, onMargin, sheet.fit, sheet.room);
      if (rescaled) host.dispatchEvent(new Event(FIT_EVENT, { bubbles: true }));
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
