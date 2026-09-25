"use client";

/**
 * Box selection: press anywhere in the document that is not a block of text and
 * band across whole blocks, the way Finder takes files and the sidebar takes
 * pages.
 *
 * ## Where the press is heard
 *
 * On the document's PANE — the element the page is shown in. It reaches the
 * gutter and the room below the last block, so "can a band start here" is not a
 * question about any box's extent; and it stops there, so the application's
 * chrome is not this gesture's business. Within the pane the question is a rule
 * asked of the point itself: is it inside a block of text, on a control, inside
 * a block that owns its own interior, or on a layer floating over the page.
 *
 * ## What it takes from the press, and how narrowly
 *
 * Cancelling a `pointerdown` takes the browser's whole compatibility mouse
 * stream with it — `mousedown` first among them — and this application dismisses
 * every menu and starts every pane resize on `mousedown`. Doing that from a
 * listener the width of the window is how a gesture in the document came to
 * freeze the toolbar's menus and kill the resize handles.
 *
 * So nothing is taken from the `pointerdown` at all. What ProseMirror listens
 * for is the `mousedown`, and off the blocks exactly that one event is swallowed
 * — on the PANE, once, for this press. Inside a block even that is left alone
 * until the gesture proves itself a drag, or a click would stop selecting what
 * it landed on.
 *
 * A block of text is not banded from at all, anywhere across its width: the
 * browser starts its own text selection there, and a band beside it only fights
 * that selection — `inTextBlock` is that rule, and what text selection is owed.
 *
 * ## What it inherits, and what it adds
 *
 * From `sidebarMarquee`, because it is the same gesture: a distance gate before
 * a press becomes a drag, so a click stays a click, and VERTICAL OVERLAP as the
 * test for which rows a band covers, because a row that spans the column
 * carries no horizontal information.
 *
 * What a document adds: the surface is `contenteditable`, so native text
 * selection has to be held off for the whole gesture — cleared and then
 * suppressed once the drag starts, never by cancelling the press — a page is
 * taller than the window, so the band scrolls when it reaches an edge, and the
 * band has to REACH THE PAGE before vertical overlap means anything.
 *
 * That last one is where the sidebar's rule stops carrying. Its band and its
 * rows live in the same narrow column, so a band is always beside a row and
 * "which rows" is the only question there is. The document's pane is not its
 * column: the page is one column in a window that can be twice that, centred
 * with room either side, so most of what this gesture hears is room the document
 * does not occupy at all. Vertical overlap alone answered a band drawn out
 * there by plating whatever block happened to be level with it — a page's worth
 * of dead space in which no drag could stay empty (NT-63). So a block is under
 * the band when the band overlaps it vertically AND reaches the page
 * horizontally, the page being this surface's own box: the column and the
 * gutters it reaches back over, widened by any block drawn wider than them.
 * Pressing in that dead space and dragging into the page still selects, which
 * is the reach-in gesture Finder has; standing out there and dragging no longer
 * does.
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
import { raiseVeil } from "@/app/lib/veil";
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
  "button, a, input, textarea, select, [role='button'], [role='menuitem']," +
  // BlockNote's fallback writing row owns its click. Normally the real
  // trailing paragraph invariant makes this decoration unnecessary, but it
  // can exist for one mount microtask while an old document is repaired.
  ".bn-trailing-block," +
  // The width/height grips, which live inside their block but are dragged.
  ".nt-canvas-grip, .nt-canvas-grip-x, .nt-sb-grip, .nt-album-grip";

/**
 * Blocks whose INTERIOR is their own gesture surface.
 *
 * A diagram is dragged and its shapes resized; a storyboard shot is drawn in; a
 * table's columns are pulled; an album's tiles are carried. None of that is
 * text and none of it is a control, so without this the band starts underneath
 * the gesture the person is actually making and selects blocks while they move
 * a shape.
 *
 * Keyed on BlockNote's own `data-content-type`, which it stamps on every
 * block's content element with the block's name — so a block type added later
 * is opted in by naming it here, and the margin beside these blocks still bands
 * normally because the attribute only covers their content.
 */
const OWNS_ITS_INTERIOR = new Set([
  "canvas",
  "storyboard",
  "album",
  "table",
  "audio",
  "video",
  "image",
  "file",
  "location",
  "codeBlock",
  "mathBlock",
]);

/**
 * Whether the press landed in a block that holds text — anywhere in it, the
 * room to the right of a short line included.
 *
 * That room only looks empty. The block's editable content runs the full width
 * of the column, so the browser answers a press there with a caret at the end
 * of the line and a drag from it with a text selection, whatever this hook
 * does. A band started there did not replace that selection; it ran beside it,
 * each overwriting the other as the pointer moved, and the gesture ended as
 * whichever wrote last (NT-18). So text owns the whole block, and a band starts
 * where the document has nothing to select: the gutter, the page below the last
 * block, and beside a block with no text of its own.
 *
 * Asked of the block element rather than the target, because a press in a
 * block's padding lands on the block itself. A nested block answers for itself.
 */
function inTextBlock(target: Element): boolean {
  const outer = target.closest(".bn-block-outer");
  const content = outer?.querySelector(":scope > .bn-block > .bn-block-content");
  return !!content?.querySelector(".bn-inline-content");
}

type Viewport = { top: number; bottom: number; left: number; right: number };

/**
 * The pane the document is shown in: the nearest ancestor that is a scroll
 * container BY ROLE, whether or not it happens to be overflowing right now.
 *
 * "Does it scroll at this instant" is the wrong question, and asking it was how
 * this gesture came to hear every press in the application: on a page shorter
 * than the window nothing overflows, so the walk fell through to
 * `document.documentElement` and the "document area" became the whole window —
 * sidebar, panels, toolbar and every menu scrim included. A pane is the
 * document's pane when it is empty, too.
 *
 * Falls back to the surface itself, never to the document. A surface with no
 * scrolling ancestor is its own extent; the auto-scroll then has nothing to
 * move, which is the truth rather than a reason to widen the gesture.
 */
function paneOf(el: HTMLElement): HTMLElement {
  let node = el.parentElement;
  while (node && node !== document.body) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll" || overflow === "overlay") {
      return node;
    }
    node = node.parentElement;
  }
  return el;
}

/**
 * Whether the press landed on something floating over the document rather than
 * on the document.
 *
 * Menus, popovers and their full-screen dismissal scrims are rendered inline,
 * so they are DOM descendants of whatever component opened them — several of
 * them of the editor itself. They are all taken out of flow to float, and that
 * is the property to ask about: a rule, so a popover added later is covered
 * without being named anywhere.
 */
function onFloatingLayer(target: Element, pane: HTMLElement): boolean {
  let node: Element | null = target;
  while (node && node !== pane) {
    const position = getComputedStyle(node).position;
    if (position === "fixed" || position === "sticky") return true;
    node = node.parentElement;
  }
  return false;
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

/**
 * Take this event out of the DOM's hands: ProseMirror must neither act on it
 * nor see it. Registered on the pane for one press at a time — never on the
 * window, where it would reach the whole application.
 */
function swallow(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
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

      // A rich block's interior belongs to that block — see OWNS_ITS_INTERIOR.
      const content = target.closest("[data-content-type]");
      const type = content?.getAttribute("data-content-type");
      if (type && OWNS_ITS_INTERIOR.has(type)) return;

      // A block of text owns every press inside it — see `inTextBlock`.
      const inBlock = !!target.closest(".bn-block-outer");
      if (inBlock && inTextBlock(target)) return;

      const scroller = paneOf(surface);

      // A menu, a popover, or the full-screen scrim one puts up to catch the
      // press that dismisses it — floating over the document, not part of it.
      if (onFloatingLayer(target, scroller)) return;

      // Off the blocks there is no caret to place, and ProseMirror would
      // otherwise start its own text selection and draw it under the band the
      // whole way down. So the `mousedown` behind this press — the event
      // ProseMirror actually listens for — is taken out before it can reach it.
      //
      // On the PANE, and only for this one press. Cancelling the `pointerdown`
      // instead is what this used to do, and it took the browser's whole
      // compatibility mouse stream with it, for every press in the window: the
      // application dismisses its menus and starts its pane resizes on
      // `mousedown`, and all of them silently stopped working. Scoped here, the
      // suppression reaches ProseMirror and nothing else.
      //
      // Inside a block the press is left alone regardless, or a plain click
      // would stop selecting what it landed on; the drag takes the default
      // when it proves itself one, in `begin`.
      if (!inBlock) {
        scroller.addEventListener("mousedown", swallow, {
          capture: true,
          once: true,
        });
      }
      teardown.current?.();

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
      let lower: (() => void) | null = null;
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
      type Row = {
        el: HTMLElement;
        id: string;
        top: number;
        bottom: number;
        left: number;
        right: number;
      };
      let rows: Row[] = [];
      const measure = () => {
        const down = scroller.scrollTop;
        const across = scroller.scrollLeft;
        // The page: this surface reaches back over the gutters the drag handle
        // floats in, so its box is the whole width a band may be drawn down,
        // and every block claims it however narrow its own line is.
        const page = surface.getBoundingClientRect();
        const pageLeft = page.left + across;
        const pageRight = page.right + across;
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
            top: rect.top + down,
            bottom: rect.bottom + down,
            left: Math.min(rect.left + across, pageLeft),
            // ...and past the page for a block that draws past it. A diagram
            // widened by its side grip keeps its left edge on the column and
            // grows into the right margin, on its own inline width — the box
            // measured here stays the column's and the diagram OVERFLOWS it,
            // which is why `scrollWidth` is asked as well as the rect. For a
            // block that fits, the two agree to the pixel.
            right: Math.max(
              rect.right + across,
              rect.left + across + el.scrollWidth,
              pageRight,
            ),
          });
        }
      };

      /**
       * The blocks a band covers. Vertical overlap says WHICH — a block spans
       * the column, so how far across the band sits says nothing about which
       * ones it means — and touching the block's width says WHETHER, which off
       * the side of the page is the whole question (NT-63). Touching counts:
       * a band drawn straight down has no width, and the one drawn down the
       * page's own edge is as much on the page as any other.
       *
       * A block inside one already covered is left out: taking a parent takes
       * its children with it. A parent is at least as wide as its children, so
       * rejecting one on width rejects them too, and the walk stays in order.
       */
      const idsInBand = (
        top: number,
        bottom: number,
        left: number,
        right: number,
      ): string[] => {
        const down = scroller.scrollTop;
        const across = scroller.scrollLeft;
        const docTop = top + down;
        const docBottom = bottom + down;
        const docLeft = left + across;
        const docRight = right + across;
        const ids: string[] = [];
        let covered: HTMLElement | null = null;
        for (const row of rows) {
          if (covered?.contains(row.el)) continue;
          if (row.bottom <= docTop || row.top >= docBottom) continue;
          if (row.right < docLeft || row.left > docRight) continue;
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
        const left = Math.min(x0, pointerX);
        const right = Math.max(x0, pointerX);

        if (band) {
          // Clamped to what the scroller shows, so a band dragged sideways
          // never draws itself across the sidebar.
          const view = viewportOf(scroller);
          const t = Math.max(top, view.top);
          const b = Math.min(bottom, view.bottom);
          const l = Math.max(left, view.left);
          const r = Math.min(right, view.right);
          band.style.top = `${t}px`;
          band.style.left = `${l}px`;
          band.style.width = `${Math.max(0, r - l)}px`;
          band.style.height = `${Math.max(0, b - t)}px`;
        }

        // The band decides by its FULL extent, not its clamped one: a block
        // scrolled just past the edge is still under the band.
        const covered = idsInBand(top, bottom, left, right);
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
        // A press that landed in a block has been dragging text since it went
        // down; drop that before the band draws over the top of it.
        //
        // Only when it did. `removeAllRanges` is not free: ProseMirror watches
        // `selectionchange`, and emptying the selection out from under it makes
        // it resync and drop the very block selection the band is putting there
        // — the band draws and nothing stays selected. Off the blocks there is
        // nothing to drop anyway, and the veil below is what holds the line
        // for the rest of the gesture.
        if (inBlock) window.getSelection()?.removeAllRanges();
        // The document is contenteditable: without the veil the browser draws
        // its own text selection under the band and fights it the whole way
        // down, and the pointer turns into an I-beam every time the band
        // crosses a word. A rubber band is one thing the whole way down, so the
        // cursor says one thing.
        lower = raiseVeil();
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
        scroller.removeEventListener("mousedown", swallow, true);
        if (frame) cancelAnimationFrame(frame);
        if (painting) cancelAnimationFrame(painting);
        frame = 0;
        painting = 0;
        rows = [];
        band?.remove();
        band = null;
        lower?.();
        lower = null;
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
   * Listen on the document's PANE — see {@link paneOf}.
   *
   * The pane is the document area by definition, so a band can start out in the
   * gutter and below the last block without that being a question about any
   * box's extent. What it is emphatically not is the window: the application's
   * chrome — sidebar, panels, toolbar, every menu and its dismissal scrim —
   * lives outside this element and must never hear from this gesture.
   */
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const pane = paneOf(surface);
    pane.addEventListener("pointerdown", start);
    return () => pane.removeEventListener("pointerdown", start);
  }, [surfaceRef, start, enabled]);
}
