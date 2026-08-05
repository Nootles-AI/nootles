"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Dragging a sidebar row to reorder pages.
 *
 * Built on pointer events rather than the HTML drag API: the rows keep their
 * click (select), double-click (rename) and right-click (menu), and a drag only
 * begins once the pointer has actually travelled — so a press is still a press.
 * While one is live the hook says which row is being carried and where the drop
 * line sits; on release it names the page the drop lands after (null for the
 * front), and the caller writes the order.
 */

const SLOP = 4;

type Spot = { gap: number; top: number };

export function usePageDrag(
  /** The `<ul>`; rows are its `[data-page]` descendants. The caller mounts it. */
  listRef: RefObject<HTMLUListElement | null>,
  order: readonly Id<"pages">[],
  onMove: (pageId: Id<"pages">, after: Id<"pages"> | null) => void,
): {
  /** The row being carried, while one is. */
  dragId: Id<"pages"> | null;
  /** Drop line position within the list, in px from its top; null when idle. */
  top: number | null;
  /** Call from the row's `onPointerDown`. */
  press: (id: Id<"pages">, event: React.PointerEvent) => void;
  /** Put on the row as `onClickCapture`: the click that ends a drag is not a select. */
  clickGuard: (event: React.MouseEvent) => void;
} {
  const [drag, setDrag] = useState<{ id: Id<"pages">; top: number } | null>(null);
  const suppress = useRef(false);

  const orderRef = useRef(order);
  const onMoveRef = useRef(onMove);
  useEffect(() => {
    orderRef.current = order;
    onMoveRef.current = onMove;
  });

  /** Insertion index and drop-line y for a pointer height, from the live rows. */
  const spotAt = (clientY: number): Spot | null => {
    const list = listRef.current;
    if (!list) return null;
    const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-page]"));
    if (rows.length === 0) return null;
    const rects = rows.map((row) => row.getBoundingClientRect());
    const gap = rects.filter((r) => clientY > r.top + r.height / 2).length;
    const listTop = list.getBoundingClientRect().top;
    const edge = gap === 0 ? rects[0].top : rects[gap - 1].bottom;
    return { gap, top: edge - listTop };
  };

  const press = (id: Id<"pages">, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let started = false;
    let spot: Spot | null = null;

    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < SLOP) return;
        started = true;
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      spot = spotAt(ev.clientY);
      setDrag(spot ? { id, top: spot.top } : null);
    };

    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", abort);
      if (!started) return;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // The release lands back on the row, whose click would select the page a
      // drag never meant to open.
      suppress.current = true;
      setDrag(null);
    };

    const drop = () => {
      const was = started;
      done();
      if (!was || !spot) return;
      const ids = orderRef.current;
      const { gap } = spot;
      // Its own slot — either side of the carried row — is where it already is.
      if (ids[gap - 1] === id || ids[gap] === id) return;
      onMoveRef.current(id, gap === 0 ? null : ids[gap - 1]);
    };

    const abort = () => done();

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", abort);
  };

  const clickGuard = (event: React.MouseEvent) => {
    if (!suppress.current) return;
    suppress.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    dragId: drag?.id ?? null,
    top: drag?.top ?? null,
    press,
    clickGuard,
  };
}
