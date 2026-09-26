/**
 * How something the page moved for the hand comes to rest: a drawn shape
 * carried into its diagram, or a pen's path the band had to make room for.
 * The `--ease` family, so it moves like the rest of the page.
 */
export const SETTLE = "cubic-bezier(0.25, 0, 0, 1)";
export const SETTLE_MS = 270;

const X1 = 0.25;
const Y1 = 0;
const X2 = 0;
const Y2 = 1;

const bezier = (t: number, a: number, b: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;

/**
 * {@link SETTLE} at `t` of the way through, for a move driven a frame at a
 * time — one that has to keep step with a scroll, which no CSS timing can.
 */
export function settleEase(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  // x(u) rises monotonically on [0, 1], so bisection always finds the u for t.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (bezier(mid, X1, X2) < t) lo = mid;
    else hi = mid;
  }
  return bezier((lo + hi) / 2, Y1, Y2);
}
