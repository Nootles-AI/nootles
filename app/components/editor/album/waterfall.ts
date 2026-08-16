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

/** How many columns, from the block's width — or from the album's own say-so. */
export function columnsFor(
  width: number,
  items: readonly Tiled[],
  pinned?: number,
): number {
  const fits = pinned ?? Math.max(1, Math.round(width / TARGET_COL_W));
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

/** How far past a tile's midline the pointer must go to change its answer. */
const HYSTERESIS = 8;

/**
 * Where a carried picture would land, from the pointer alone.
 *
 * Measured against `boxes` — the layout that is ON SCREEN, carried picture
 * included, sitting at `carried`. The pointer must be answered in the
 * arrangement the user is looking at: judged against anything else — the
 * pre-drag layout, the layout without the picture — the tiles it has already
 * displaced put every later target somewhere other than where it appears, and
 * a long drag stops landing where it points.
 *
 * These are the layout's SETTLED coordinates, never the animated document —
 * measuring mid-glide is the feedback loop that made every earlier version of
 * this drag chatter. What steadies the answer instead: the carried picture's
 * own box is a fixed point (the pointer resting in the space it would take is
 * the answer it already has), and the midline is sticky toward the answer
 * standing, so a hand resting on one cannot flicker between two.
 *
 * Returns the carried picture's new index in that same list.
 */
export function dropIndex(
  point: { x: number; y: number },
  boxes: readonly Box[],
  columns: number,
  carried: number,
): number {
  let best = -1;
  let nearest = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (
      point.x >= box.x &&
      point.x <= box.x + box.w &&
      point.y >= box.y &&
      point.y <= box.y + box.h
    ) {
      best = i;
      break;
    }
    const dx = point.x - (box.x + box.w / 2);
    const dy = point.y - (box.y + box.h / 2);
    const distance = dx * dx + dy * dy;
    if (distance < nearest) {
      nearest = distance;
      best = i;
    }
  }
  if (best < 0 || best === carried) return carried;

  // Stacked in one column, the half that means "after" is the lower one; in
  // more than one it is the right-hand one.
  const box = boxes[best];
  const along = columns === 1 ? point.y : point.x;
  const middle = columns === 1 ? box.y + box.h / 2 : box.x + box.w / 2;
  const bias = carried > best ? -HYSTERESIS : HYSTERESIS;
  // The place among the others, then the carried picture's own vacancy closed.
  const place = along > middle + bias ? best + 1 : best;
  return place > carried ? place - 1 : place;
}
