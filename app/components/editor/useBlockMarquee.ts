"use client";

/**
 * Box selection: press anywhere in the document that is not text and band
 * across whole blocks, the way Finder takes files and the sidebar takes pages.
 *
 * ## Where the press is heard
 *
 * On the SCROLLER, not on a wrapper around the editor. A wrapper only hears
 * presses inside its own box, which made "can a band start here" a question
 * about layout — whether that box reached out into the gutter, whether it grew
 * past the last block — and the answer was no in most of the places a hand
 * actually reaches. The scroller is the document area by definition, so the
 * question becomes one rule asked of the point itself: is there text under it,
 * or a control.
 *
 * `pressIsOnText` is that rule, and it asks the browser rather than guessing
 * from element boxes: a block runs the full width of the column, so its element
 * says nothing about whether there is anything at the point. The caret the
 * browser would place is the honest answer — vertically first, because asked
 * about a point below the last line it answers with the nearest caret it has,
 * up on that line.
 *
 * ## What it inherits, and what it adds
 *
 * From `sidebarMarquee`, because it is the same gesture: a distance gate before
 * a press becomes a drag, so a click stays a click, and hit-testing by VERTICAL
 * OVERLAP alone, because a full-width row carries no horizontal information.
 * What a document adds: the surface is `contenteditable`, so native text
 * selection has to be held off for the whole gesture (and preventing a
 * pointerdown does not prevent the mousedown ProseMirror listens for), and a
 * page is taller than the window, so the band scrolls when it reaches an edge.
 *
 * Blocks are measured ONCE when the gesture starts and held in the scroller's
 * own coordinates: they do not move while a band is drawn over them, and
 * measuring per frame meant a layout flush for every block on every pointer
 * move. The band itself is one fixed `div` positioned imperatively — routing a
 * rubber band through React state would re-render the editor to move a
 * rectangle.
 */


import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import { type BlockSelectionStore } from "./blockSelection";
import "./blockSelection.css";

/** How far the pointer travels before a press is a drag. */
const SLOP = 4;
/** How close to the scroller's edge the pointer gets before the page moves. */
const EDGE = 56;
/** Fastest the page scrolls itself, per frame. */
const MAX_STEP = 20;

/** Controls own their press outright — a band never starts on one. */
const CONTROLS =
  "button, a, input, textarea, select, [role='button'], [role='menuitem']";

/** How far past the last character before the press counts as empty space. */
const PAST_TEXT = 8;

/** The caret the browser would put at this point, however it spells it. */
function caretRectAt(x: number, y: number): DOMRect | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  let range: Range | null = null;
  if (typeof doc.caretRangeFromPoint === "function") {
    range = doc.caretRangeFromPoint(x, y);
  } else if (typeof doc.caretPositionFromPoint === "function") {
    const position = doc.caretPositionFromPoint(x, y);
    if (position) {
      range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
    }
  }
  if (!range) return null;
  const rect = range.getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? null : rect;
}

/**
 * Whether a press inside a block landed on its TEXT rather than the empty
 * space beside it.
 *
 * A block runs the full width of the column, so "inside a block" says nothing
 * about whether there is anything there: the room to the right of a short line
 * is as empty as the margin, and it is where a hand reaches to start a box.
 * The browser's own caret is the honest answer — placed at the end of the line
 * when the point is past it, so a press well right of that caret is a press on
 * nothing.
 */
function pressIsOnText(x: number, y: number): boolean {
  const caret = caretRectAt(x, y);
  if (!caret) return false;
  // Vertically first. Asked about a point below the last line, the browser
  // answers with the nearest caret it has — up on that line — so comparing x
  // alone reads the empty page under a document as text and refuses the band
  // the whole way down.
  if (y < caret.top || y > caret.bottom) return false;
  return x <= caret.right + PAST_TEXT;
}

type Viewport = { top: number; bottom: number; left: number; right: number };

/** The nearest ancestor that actually scrolls, else the page itself. */
function scrollerOf(el: HTMLElement): HTMLElement {
  let node = el.parentElement;
  while (node && node !== document.body) {
    const overflow = getComputedStyle(node).overflowY;
    if (
      (overflow === "auto" || overflow === "scroll" || overflow === "overlay") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return document.scrollingElement instanceof HTMLElement
    ? document.scrollingElement
    : document.documentElement;
}

/** What that scroller can show right now, in viewport coordinates. */
function viewportOf(scroller: HTMLElement): Viewport {
  if (scroller === document.documentElement || scroller === document.body) {
    return {
      top: 0,
      left: 0,
      bottom: window.innerHeight,
      right: window.innerWidth,
    };
  }
  const rect = scroller.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
}

/** Eased so the page creeps at the threshold and runs at the very edge. */
function stepFor(intrusion: number): number {
  const ratio = Math.min(1, Math.max(0, intrusion / EDGE));
  return Math.ceil(ratio * ratio * MAX_STEP);
}

/** Take an event out of the DOM's hands entirely. */
function swallow(event: Event): void {
  event.preventDefault();
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface BlockMarqueeOptions {
  /**
   * The box the press starts in — a wrapper around the editor that reaches
   * into the page's gutter. Give it `.nt-marquee-surface`.
   */
  surfaceRef: RefObject<HTMLElement | null>;
  /** Where the band reports what it covers. Null while the editor loads. */
  selection: BlockSelectionStore | null;
  /** False for a viewer: there is nothing to do with a block selection. */
  enabled?: boolean;
}

export function useBlockMarquee({
  surfaceRef,
  selection,
  enabled = true,
}: BlockMarqueeOptions): void {
  const latest = useRef({ selection, enabled });
  const teardown = useRef<(() => void) | null>(null);

  // Written in an effect, never during render (`react-hooks/refs`).
  useEffect(() => {
    latest.current = { selection, enabled };
  });

  // A gesture must not outlive the surface it is banding across.
  useEffect(() => () => teardown.current?.(), []);

  const start = useCallback(
    (event: PointerEvent) => {
      const store = latest.current.selection;
      const surface = surfaceRef.current;
      if (!latest.current.enabled || !store || !surface) return;
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest(CONTROLS)) return;

      // Everything from the top of the document down is fair game; above it is
      // the title and the mode toggle, which are not the document.
      if (event.clientY < surface.getBoundingClientRect().top - 4) return;

      // Inside a block, only its text owns the press; the room to the right of
      // a short line is as good a place to start a box as the margin is.
      const inBlock = !!target.closest(".bn-block-outer");
      if (inBlock && pressIsOnText(event.clientX, event.clientY)) return;

      // Outside the editor there is no caret to place, so the default goes now
      // — that is also what stops the browser drawing its own text selection
      // under the band. Inside a block the default has to stand until the
      // gesture proves itself a drag, or a plain click would stop placing the
      // caret at the end of the line, which is what a click there is for.
      if (!inBlock) {
        event.preventDefault();
        // ...and again on the mousedown behind it. Preventing a pointerdown
        // does NOT prevent the mouse event that follows, and ProseMirror
        // listens for that one — without this it starts its own text selection
        // and draws it under the band the whole way down.
        window.addEventListener("mousedown", swallow, {
          capture: true,
          once: true,
        });
      }
      teardown.current?.();

      const scroller = scrollerOf(surface);
      const origin = surface.getBoundingClientRect();
      // The anchor is kept in the SURFACE's coordinates, not the viewport's:
      // the page scrolls under the band, and a viewport anchor would slide up
      // the document as it did.
      const anchorX = event.clientX - origin.left;
      const anchorY = event.clientY - origin.top;
      const additive = event.shiftKey || event.metaKey || event.ctrlKey;
      const base = additive ? store.getSnapshot().ids : [];
      const before = store.getSnapshot().ids;

      // Where the press landed on screen. Only the slop gate uses this — by
      // the time anything scrolls, the gesture is already a drag.
      const pressX = event.clientX;
      const pressY = event.clientY;
      let pointerX = event.clientX;
      let pointerY = event.clientY;
      let dragging = false;
      let band: HTMLDivElement | null = null;
      let frame = 0;
      let painting = 0;
      let applied: readonly string[] = before;

      /**
       * Every block's extent, measured ONCE when the gesture starts and held in
       * the scroller's own coordinates so scrolling does not invalidate it.
       *
       * Measuring per frame meant a `getBoundingClientRect` for every block in
       * the document on every pointer move — the layout flush that made the
       * band feel heavy on a long page. Blocks do not move while a band is
       * drawn over them, so one pass is all it takes.
       */
      type Row = { el: HTMLElement; id: string; top: number; bottom: number };
      let rows: Row[] = [];
      const measure = () => {
        const offset = scroller.scrollTop;
        rows = [];
        for (const el of surface.querySelectorAll<HTMLElement>(
          ".bn-block-outer[data-id]",
        )) {
          const rect = el.getBoundingClientRect();
          const id = el.dataset.id;
          if (!id || rect.height === 0) continue;
          rows.push({
            el,
            id,
            top: rect.top + offset,
            bottom: rect.bottom + offset,
          });
        }
      };

      /**
       * The blocks a band covers, by vertical overlap alone — a block spans the
       * column, so where the band is horizontally says nothing about what it
       * means. A block inside one already covered is left out: taking a parent
       * takes its children with it.
       */
      const idsInBand = (top: number, bottom: number): string[] => {
        const offset = scroller.scrollTop;
        const docTop = top + offset;
        const docBottom = bottom + offset;
        const ids: string[] = [];
        let covered: HTMLElement | null = null;
        for (const row of rows) {
          if (covered?.contains(row.el)) continue;
          if (row.bottom <= docTop || row.top >= docBottom) continue;
          covered = row.el;
          ids.push(row.id);
        }
        return ids;
      };

      const scrollStep = (): number => {
        const view = viewportOf(scroller);
        if (pointerY < view.top + EDGE) {
          return -stepFor(view.top + EDGE - pointerY);
        }
        if (pointerY > view.bottom - EDGE) {
          return stepFor(pointerY - (view.bottom - EDGE));
        }
        return 0;
      };

      const paint = () => {
        const rect = surface.getBoundingClientRect();
        const x0 = anchorX + rect.left;
        const y0 = anchorY + rect.top;
        const top = Math.min(y0, pointerY);
        const bottom = Math.max(y0, pointerY);

        if (band) {
          // Clamped to what the scroller shows, so a band dragged sideways
          // never draws itself across the sidebar.
          const view = viewportOf(scroller);
          const t = Math.max(top, view.top);
          const b = Math.min(bottom, view.bottom);
          const l = Math.max(Math.min(x0, pointerX), view.left);
          const r = Math.min(Math.max(x0, pointerX), view.right);
          band.style.top = `${t}px`;
          band.style.left = `${l}px`;
          band.style.width = `${Math.max(0, r - l)}px`;
          band.style.height = `${Math.max(0, b - t)}px`;
        }

        // The band decides by its FULL extent, not its clamped one: a block
        // scrolled just past the edge is still under the band.
        const covered = idsInBand(top, bottom);
        const next = additive ? [...base, ...covered] : covered;
        if (sameIds(next, applied)) return;
        applied = next;
        latest.current.selection?.select(next);
      };

      const tick = () => {
        frame = 0;
        const step = scrollStep();
        if (!step) return;
        scroller.scrollTop += step;
        paint();
        frame = requestAnimationFrame(tick);
      };

      /** One paint per frame, however fast the pointer reports. */
      const schedule = () => {
        if (painting) return;
        painting = requestAnimationFrame(() => {
          painting = 0;
          paint();
        });
      };

      const begin = () => {
        dragging = true;
        measure();
        // The press inside a block did not take the default, so the browser may
        // have started its own text selection on the way here. Drop it before
        // the band draws over the top of it.
        if (inBlock) window.getSelection()?.removeAllRanges();
        // The document is contenteditable: without this the browser draws its
        // own text selection under the band and fights it the whole way down.
        document.body.style.userSelect = "none";
        // ...and without this the pointer keeps turning into an I-beam every
        // time the band crosses a word, which is most of the gesture. A rubber
        // band is one thing the whole way down, so the cursor says one thing.
        document.body.classList.add("nt-banding");
        band = document.createElement("div");
        band.className = "nt-block-marquee";
        band.setAttribute("aria-hidden", "true");
        document.body.appendChild(band);
      };

      const move = (ev: PointerEvent) => {
        pointerX = ev.clientX;
        pointerY = ev.clientY;
        if (!dragging) {
          if (Math.hypot(ev.clientX - pressX, ev.clientY - pressY) < SLOP) return;
          // Only now is this a drag rather than a click, so only now does the
          // caret lose its claim on the press.
          ev.preventDefault();
          begin();
        }
        schedule();
        if (scrollStep()) {
          if (!frame) frame = requestAnimationFrame(tick);
        } else if (frame) {
          cancelAnimationFrame(frame);
          frame = 0;
        }
      };

      const stop = () => {
        teardown.current = null;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("mousedown", swallow, true);
        if (frame) cancelAnimationFrame(frame);
        if (painting) cancelAnimationFrame(painting);
        frame = 0;
        painting = 0;
        rows = [];
        band?.remove();
        band = null;
        document.body.style.userSelect = "";
        document.body.classList.remove("nt-banding");
      };

      const finish = () => {
        const wasDragging = dragging;
        stop();
        // A press on nothing that stayed a press means "never mind", the same
        // as clicking the desktop.
        if (!wasDragging && !additive) latest.current.selection?.clear();
      };

      const cancel = () => {
        stop();
        latest.current.selection?.select(before);
      };

      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        ev.stopPropagation();
        cancel();
      };

      teardown.current = stop;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", onKey, true);
    },
    [surfaceRef],
  );

  /**
   * Listen on the SCROLLER, not on a wrapper around the editor.
   *
   * A wrapper only hears presses inside its own box, so the gesture kept
   * depending on that box reaching the right places — out into the gutter, and
   * down past the last block — which made "can I start a band here" a question
   * about layout rather than about what is under the pointer. The scroller is
   * the whole document area by definition. Where a band may start is then one
   * rule, asked of the point itself: is there text there, or a control.
   */
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const scroller = scrollerOf(surface);
    scroller.addEventListener("pointerdown", start);
    return () => scroller.removeEventListener("pointerdown", start);
  }, [surfaceRef, start, enabled]);
}
