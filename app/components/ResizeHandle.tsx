"use client";

import { useEffect, useState } from "react";
import { raiseVeil } from "@/app/lib/veil";

/**
 * A draggable divider with nothing drawn at rest: the sheet's own edge is the
 * line, and the handle only shows itself to a hand that has found it. Reports the pointer's absolute clientX while
 * dragging; the parent decides how that maps to a panel width (so the same
 * handle works on either the left or right edge).
 *
 * Reported at most once a frame, and marked `done` on release: a rail's width
 * sits at the top of the shell, so a parent that put every event into state
 * would re-render the document and the transcript at pointer frequency. Write
 * the live value to the DOM; keep the state for the release.
 */
export function ResizeHandle({
  onResize,
  ariaLabel,
  gap = false,
}: {
  onResize: (clientX: number, done: boolean) => void;
  ariaLabel: string;
  /** Between two sheets, where the handle is also the room between them. */
  gap?: boolean;
}) {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    let at: number | null = null;
    const move = (e: MouseEvent) => {
      at = e.clientX;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (at !== null) onResize(at, false);
      });
    };
    const up = () => {
      if (frame) cancelAnimationFrame(frame);
      // Nowhere is not a width: a press that never moved leaves the rail alone.
      if (at !== null) onResize(at, true);
      setDragging(false);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    const lower = raiseVeil("col-resize");
    // A rail being dragged follows the hand; it does not ease after it.
    document.body.dataset.resizing = "";
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      lower();
      delete document.body.dataset.resizing;
    };
  }, [dragging, onResize]);

  return (
    <div
      role="separator"
      aria-label={ariaLabel}
      onMouseDown={() => setDragging(true)}
      data-dragging={dragging || undefined}
      className={`nt-resize${gap ? " is-gap" : ""}`}
    />
  );
}
