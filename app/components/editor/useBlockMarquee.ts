"use client";

/**
 * The gutter gesture: press beside the text and band down it to take whole
 * blocks, the way Finder takes files and the sidebar takes pages.
 *
 * It lives outside the editor on purpose. `.bn-editor` has no inline padding
 * (see `editor.css`), so there is no margin INSIDE the contenteditable to press
 * on — the strip the drag handle floats in belongs to the page, not to
 * ProseMirror. So the caller mounts this on a wrapper that reclaims that strip
 * (`.nt-marquee-surface`), and the press never has to travel through the
 * editor's own event handling.
 *
 * Two things it inherits from `sidebarMarquee`, because they are the same
 * gesture: a distance gate before a press becomes a drag, so a click stays a
 * click, and hit-testing by VERTICAL OVERLAP alone, because a full-width row
 * carries no horizontal information. Two things it adds, because a document is
 * not a sidebar: the surface is `contenteditable`, so native text selection
 * has to be held off for the whole gesture, and a page is taller than the
 * window, so the band scrolls the page when it reaches the edge.
 *
 * The band is drawn imperatively rather than through React state. A rubber band
 * moves with the pointer; routing that through a re-render would re-render the
 * whole editor sixty times a second to move one rectangle. It is one fixed
 * `div` on `document.body`, positioned directly — which also means the caller
 * renders nothing for it.
 */

import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { blockIdsInBand, type BlockSelectionStore } from "./blockSelection";
import "./blockSelection.css";

/** How far the pointer travels before a press is a drag. */
const SLOP = 4;
/** How close to the scroller's edge the pointer gets before the page moves. */
const EDGE = 56;
/** Fastest the page scrolls itself, per frame. */
const MAX_STEP = 20;

/**
 * Targets that own their own press. A block does — a click in it places the
 * caret, and dragging through it is BlockNote's text selection, which already
 * spans blocks. Controls do too. Everything left is margin.
 */
const OWNS_ITS_PRESS =
  ".bn-block-outer, button, a, input, textarea, select, [role='button'], [role='menuitem']";

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

export interface BlockMarquee {
  /** Put this on the surface element. It renders nothing of its own. */
  onPointerDown: (event: ReactPointerEvent) => void;
}

export function useBlockMarquee({
  surfaceRef,
  selection,
  enabled = true,
}: BlockMarqueeOptions): BlockMarquee {
  const latest = useRef({ selection, enabled });
  const teardown = useRef<(() => void) | null>(null);

  // Written in an effect, never during render (`react-hooks/refs`).
  useEffect(() => {
    latest.current = { selection, enabled };
  });

  // A gesture must not outlive the surface it is banding across.
  useEffect(() => () => teardown.current?.(), []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      const store = latest.current.selection;
      const surface = surfaceRef.current;
      if (!latest.current.enabled || !store || !surface) return;
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest(OWNS_ITS_PRESS)) return;

      // The gutter is not a place to put a caret, and a press that reaches the
      // contenteditable starts one. Taking the default now is also what keeps
      // the browser from beginning a native text selection under the band.
      event.preventDefault();
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
      let applied: readonly string[] = before;

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
        const covered = blockIdsInBand(surface, top, bottom);
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

      const begin = () => {
        dragging = true;
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
          begin();
        }
        paint();
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
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
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

  return { onPointerDown };
}
