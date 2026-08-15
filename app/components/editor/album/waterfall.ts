import { GAP, MAX_COLS, TARGET_COL_W } from "./types";

/**
 * The waterfall: every tile's box, computed from aspect ratios alone.
 *
 * No element is measured and no picture is waited for — a tile's height is its
 * width over its aspect ratio, so the whole arrangement is known before
 * anything loads. Measuring instead would mean laying out twice, once wrong and
 * once after `onload`, which is the reflow every masonry grid on the web is
 * famous for.
 *
 * Boxes rather than columns of children, because two things need positions to
 * be numbers: a picture may span several columns, which no single column can
 * hold; and a tile that MOVES has to move from somewhere to somewhere, which is
 * what lets a reorder glide instead of teleport.
 *
 * Shortest column first, in document order. Order matters more than perfectly
 * level feet: an album read left to right is what people expect, and letting a
 * wide picture jump the queue to level the columns would shuffle the pictures
 * out of the order they were taken in.
 */

export type Box = { x: number; y: number; w: number; h: number };

/** What the packer needs of a picture: its shape, and how wide it was made. */
export type Tiled = { w: number; h: number; span?: number };

/** How many columns fit, from the block's own width. */
export function columnsFor(width: number, items: readonly Tiled[]): number {
  const fits = Math.max(1, Math.round(width / TARGET_COL_W));
  // Never more columns than there is anything to put in them — four photos in
  // six columns reads as a row with two holes rather than as a waterfall. A
  // widened picture is its own claim on that room, so it counts too.
  const widest = items.reduce((most, item) => Math.max(most, item.span ?? 1), 1);
  const wanted = Math.max(items.length, widest, 1);
  return Math.max(1, Math.min(MAX_COLS, fits, wanted));
}

export function layout(
  items: readonly Tiled[],
  width: number,
  columns: number,
): { boxes: Box[]; height: number } {
  const colW = (width - GAP * (columns - 1)) / columns;
  const feet = new Array<number>(columns).fill(0);

  const boxes = items.map((item) => {
    // A picture widened past the columns that are left simply fills them: the
    // album can be narrowed to one column, and nothing may spill out of it.
    const span = Math.min(columns, Math.max(1, Math.round(item.span ?? 1)));

    let start = 0;
    let top = Infinity;
    for (let c = 0; c + span <= columns; c++) {
      let lowest = 0;
      for (let k = c; k < c + span; k++) lowest = Math.max(lowest, feet[k]);
      // Strictly lower, so a tie is settled by the leftmost run — which is what
      // keeps a row of equal pictures reading left to right.
      if (lowest < top - 0.5) {
        top = lowest;
        start = c;
      }
    }

    const w = span * colW + (span - 1) * GAP;
    const h = w * (item.h / item.w);
    for (let k = start; k < start + span; k++) feet[k] = top + h + GAP;
    return { x: start * (colW + GAP), y: top, w, h };
  });

  // The tallest column, less the gap that was added under its last picture.
  return { boxes, height: Math.max(0, Math.max(0, ...feet) - GAP) };
}
