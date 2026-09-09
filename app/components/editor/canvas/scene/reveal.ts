import type { Rect } from "./types";

/**
 * Where the view should ease to so that `target` shows.
 *
 * `null` when it already does. Otherwise the current view grown to take the
 * target in, so what the user was looking at stays on screen beside what
 * arrived — unless that would shrink the view past legibility, in which case
 * the target alone: a screen added at the far end of a board is worth more
 * than a thumbnail of everything.
 */
export function revealBounds(target: Rect, seen: Rect): Rect | null {
  if (contains(seen, target)) return null;
  const grown = union(seen, target);
  const shrink = Math.min(seen.w / grown.w, seen.h / grown.h);
  return shrink >= LEGIBLE_SHRINK ? grown : target;
}

/** How far the view may zoom out to keep its context; below this it recentres instead. */
const LEGIBLE_SHRINK = 0.4;

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/** The ids of every shape in a serialized scene — never the root's, never an edge's. */
export function shapeIdsIn(html: string): Set<string> {
  return new Set(
    [...html.matchAll(/<nt-(?!diagram\b|edge\b)[a-z]+\b[^>]*\sid="([^"]*)"/g)].map((m) => m[1]),
  );
}
