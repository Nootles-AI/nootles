"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Rubber-band selection over the sidebar rows, the way Finder draws one.
 *
 * Starts only from empty space — pressing a row is that row's own gesture
 * (select, or pick up and drag) — so the caller passes the press through
 * exactly when the target is the scroller or the list itself.
 *
 * Rows are hit by vertical overlap alone. A list row spans the full width, so
 * horizontal position carries no information, and requiring it would mean a
 * band drawn down the left margin selected nothing.
 */

const SLOP = 4;

export type Band = { top: number; left: number; width: number; height: number };

export function useMarquee(
  /** The `<ul>`; its `[data-row]` children are the candidates, and the band is
   *  drawn inside it, so it must be a positioned box. */
  listRef: RefObject<HTMLUListElement | null>,
  /** Ids the band currently covers, and whether to add to the selection. */
  onBand: (ids: string[], additive: boolean) => void,
  /** A press on empty space that never became a drag. */
  onEmptyClick: () => void,
): { band: Band | null; start: (event: React.PointerEvent) => void } {
  const [band, setBand] = useState<Band | null>(null);
  const onBandRef = useRef(onBand);
  const onEmptyRef = useRef(onEmptyClick);
  useEffect(() => {
    onBandRef.current = onBand;
    onEmptyRef.current = onEmptyClick;
  });

  const start = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const x0 = event.clientX;
    const y0 = event.clientY;
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    let started = false;

    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < SLOP) return;
        started = true;
        document.body.style.userSelect = "none";
      }
      const list = listRef.current;
      if (!list) return;
      const top = Math.min(y0, ev.clientY);
      const bottom = Math.max(y0, ev.clientY);
      const rect = list.getBoundingClientRect();
      setBand({
        top: top - rect.top,
        left: Math.min(x0, ev.clientX) - rect.left,
        width: Math.abs(ev.clientX - x0),
        height: bottom - top,
      });

      const hit: string[] = [];
      for (const el of list.querySelectorAll<HTMLElement>("[data-row]")) {
        const r = el.getBoundingClientRect();
        if (r.bottom > top && r.top < bottom && el.dataset.row) {
          hit.push(el.dataset.row);
        }
      }
      onBandRef.current(hit, additive);
    };

    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
      document.body.style.userSelect = "";
      // A press on nothing, that stayed a press, means "never mind" — the same
      // as clicking the desktop.
      if (!started && !additive) onEmptyRef.current();
      setBand(null);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
  };

  return { band, start };
}
