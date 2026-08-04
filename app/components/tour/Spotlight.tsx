"use client";

import type { Rect } from "./useRect";

/**
 * The scrim, with a hole in it.
 *
 * One element: the box sits exactly where the target is and casts a shadow big
 * enough to cover the window, so the "hole" is the element itself and the dim
 * is its shadow. Two things follow from that, and both matter — the hole can
 * have a corner radius, which a clip-path polygon cannot; and moving between
 * targets is one box moving, which interpolates smoothly instead of jumping.
 *
 * `pointer-events: none` throughout. The guide gates a step by waiting for the
 * real action, so the lit region has to stay genuinely live: the user is typing
 * into what is underneath this.
 */
export function Spotlight({ rect }: { rect: Rect | null }) {
  if (!rect) return null;
  return (
    <div
      aria-hidden
      className="nt-tour-scrim"
      style={{
        transform: `translate(${rect.x}px, ${rect.y}px)`,
        width: rect.width,
        height: rect.height,
      }}
    />
  );
}
