/**
 * The document column's width, in px — the one number every page, thumbnail and
 * AI layout agrees on. CSS reads it as `--measure`, which the root layout sets
 * from here, so there is no second copy to drift.
 *
 * Its floor is the canvas: a three-wide diagram needs 588px (2 × 220 spacing +
 * 148 shape). Code and diagrams share this width with prose — they do not break
 * out of it.
 */
export const COLUMN_WIDTH = 720;
