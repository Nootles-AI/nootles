"use client";

import { useEffect, useState } from "react";

/**
 * A 1px draggable divider. Reports the pointer's absolute clientX while
 * dragging; the parent decides how that maps to a panel width (so the same
 * handle works on either the left or right edge).
 */
export function ResizeHandle({
  onResize,
  ariaLabel,
}: {
  onResize: (clientX: number) => void;
  ariaLabel: string;
}) {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => onResize(e.clientX);
    const up = () => setDragging(false);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
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
