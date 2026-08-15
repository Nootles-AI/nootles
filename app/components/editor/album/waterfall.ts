import { MAX_COLS, TARGET_COL_W, type AlbumItem } from "./types";

/**
 * The waterfall, computed from aspect ratios alone.
 *
 * No element is measured and no image is waited for: a tile's height is its
 * width over its aspect ratio, so the packing is known before anything loads
 * and the browser is left to turn the ratio into pixels (`aspect-ratio` on the
 * tile). Measuring instead would mean laying out twice — once wrong, once after
 * `onload` — which is the reflow every masonry grid on the web is famous for.
 *
 * Shortest column first, in document order. Order matters more than perfectly
 * level feet here: a photo album read left to right is the thing people expect,
 * and letting a wide picture jump the queue to level the columns would shuffle
 * the pictures out of the order they were taken in.
 */

/** How many columns fit, from the block's own width. */
export function columnsFor(width: number, count: number): number {
  const fits = Math.max(1, Math.round(width / TARGET_COL_W));
  // Never more columns than there are pictures — four photos in six columns
  // reads as a row with two holes in it rather than as a waterfall.
  return Math.max(1, Math.min(MAX_COLS, fits, count || 1));
}

/** Item indices, per column, in document order. */
export function packColumns(
  items: readonly AlbumItem[],
  columns: number,
): number[][] {
  const out: number[][] = Array.from({ length: columns }, () => []);
  // In units of column width, so no pixel width is needed to compare columns.
  const heights = new Array<number>(columns).fill(0);

  items.forEach((item, index) => {
    let shortest = 0;
    for (let c = 1; c < columns; c++) {
      if (heights[c] < heights[shortest]) shortest = c;
    }
    out[shortest].push(index);
    heights[shortest] += item.h / item.w;
  });

  return out;
}
