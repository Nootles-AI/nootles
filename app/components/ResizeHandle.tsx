"use client";

import { useEffect, useState } from "react";

/**
 * A 1px draggable divider. Reports the pointer's absolute clientX while
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
}: {
  onResize: (clientX: number, done: boolean) => void;
  ariaLabel: string;
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
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [dragging, onResize]);

  return (
    <div
      role="separator"
      aria-label={ariaLabel}
      onMouseDown={() => setDragging(true)}
      className="group relative z-10 w-px shrink-0 cursor-col-resize bg-border"
    >
      {/* Widened invisible hit area for easier grabbing. */}
      <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
      <div
        className={`absolute inset-y-0 left-0 w-px transition-colors ${
          dragging ? "bg-accent" : "group-hover:bg-accent/50"
        }`}
      />
    </div>
  );
}
