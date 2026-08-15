"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Dragging a sidebar row — to reorder the pages, or out to the surface to open
 * one beside the page already there.
 *
 * Built on pointer events rather than the HTML drag API: the rows keep their
 * click (select), double-click (rename) and right-click (menu), and a drag only
 * begins once the pointer has actually travelled — so a press is still a press.
 * While one is live the hook says which row is being carried and where the drop
 * line sits; on release it names the page the drop lands after (null for the
 * front), and the caller writes the order.
 */

const SLOP = 4;

/* Marks the drop zone while the pointer is over it. Written straight to the
   element, the way this drag already writes the grabbing cursor to the body:
   the zone belongs to the workspace, and a highlight is not worth a render of
   the two documents inside it. */
const OVER = "nt-drop-aside";

type Spot = { gap: number; top: number };

type Aside = {
  /** A drop on the right half of this element opens the page beside the current one. */
  zone: RefObject<HTMLElement | null>;
  /** Already in a pane: the same document in both is not a split. */
  isOpen: (pageId: Id<"pages">) => boolean;
  onDrop: (pageId: Id<"pages">) => void;
};

export function usePageDrag(
  /** The `<ul>`; rows are its `[data-page]` descendants. The caller mounts it. */
  listRef: RefObject<HTMLUListElement | null>,
  order: readonly Id<"pages">[],
  onMove: (pageId: Id<"pages">, after: Id<"pages"> | null) => void,
  aside: Aside,
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
  const [drag, setDrag] = useState<{
    id: Id<"pages">;
    /** Null while the drop would leave the list, so no line is drawn in it. */
    top: number | null;
  } | null>(null);
  const suppress = useRef(false);

  const orderRef = useRef(order);
  const onMoveRef = useRef(onMove);
  const asideRef = useRef(aside);
  useEffect(() => {
    orderRef.current = order;
    onMoveRef.current = onMove;
    asideRef.current = aside;
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

  /** The zone, when a drop here would open the page beside the current one. */
  const asideAt = (id: Id<"pages">, x: number, y: number): HTMLElement | null => {
    const side = asideRef.current;
    const zone = side.zone.current;
    if (!zone || side.isOpen(id)) return null;
    const r = zone.getBoundingClientRect();
    const over =
      x >= r.left + r.width / 2 && x <= r.right && y >= r.top && y <= r.bottom;
    return over ? zone : null;
  };

  const press = (id: Id<"pages">, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let started = false;
    let spot: Spot | null = null;
    let marked: HTMLElement | null = null;

    const mark = (zone: HTMLElement | null) => {
      if (marked === zone) return;
      marked?.classList.remove(OVER);
      zone?.classList.add(OVER);
      marked = zone;
    };

    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < SLOP) return;
        started = true;
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      mark(asideAt(id, ev.clientX, ev.clientY));
      // Out over the surface the row is going somewhere else entirely, so the
      // list stops offering it a place in the order.
      spot = marked ? null : spotAt(ev.clientY);
      setDrag({ id, top: spot?.top ?? null });
    };

    const done = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", abort);
      mark(null);
      if (!started) return;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // A release over a row is followed by a click on it, which would select
      // the page a drag never meant to open. A release anywhere else is not —
      // and a guard left standing there would eat the next real click instead.
      const target = ev.target;
      suppress.current =
        target instanceof Element && !!target.closest("[data-page]");
      setDrag(null);
    };

    const drop = (ev: PointerEvent) => {
      const was = started;
      const zone = was ? asideAt(id, ev.clientX, ev.clientY) : null;
      done(ev);
      if (!was) return;
      if (zone) {
        asideRef.current.onDrop(id);
        return;
      }
      if (!spot) return;
      const ids = orderRef.current;
      const { gap } = spot;
      // Its own slot — either side of the carried row — is where it already is.
      if (ids[gap - 1] === id || ids[gap] === id) return;
      onMoveRef.current(id, gap === 0 ? null : ids[gap - 1]);
    };

    const abort = (ev: PointerEvent) => done(ev);

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
