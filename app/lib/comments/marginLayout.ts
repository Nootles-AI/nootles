/**
 * Where the margin's cards go — the Docs rule, as a pure function of what one
 * layout pass measured.
 *
 * Each card wants to sit level with the top of the block its thread is
 * anchored in. Cards that would overlap stack downward, in anchor order, a
 * `gap` apart. The focused card is the exception: it takes exactly the place
 * it wants, the cards below it are pushed down clear of it, and the cards
 * above it are pushed up clear of it — so choosing a thread brings its card
 * level with its words and moves its neighbours instead.
 */

export type MarginItem = {
  id: string;
  /** Where the card would like its top edge. */
  top: number;
  height: number;
};

/** The space between two stacked cards. */
export const CARD_GAP = 8;

/**
 * Every item's top edge. Ties in `top` keep the order the items came in, which
 * the caller makes the document order of their anchors.
 */
export function stackCards(
  items: readonly MarginItem[],
  focusedId: string | null,
  gap: number = CARD_GAP,
): Map<string, number> {
  const sorted = items
    .map((item, index) => ({ ...item, height: Math.max(0, item.height), index }))
    .sort((a, b) => a.top - b.top || a.index - b.index);
  const tops = new Map<string, number>();
  const focused = focusedId === null ? -1 : sorted.findIndex((item) => item.id === focusedId);

  // Downward from the top — every card if nothing is focused, else the ones
  // above the focused card, which are then only ever pushed up from here.
  let cursor = -Infinity;
  const above = focused === -1 ? sorted.length : focused;
  for (let i = 0; i < above; i++) {
    const top = Math.max(sorted[i].top, cursor);
    tops.set(sorted[i].id, top);
    cursor = top + sorted[i].height + gap;
  }
  if (focused === -1) return tops;

  const pinned = sorted[focused];
  tops.set(pinned.id, pinned.top);

  let limit = pinned.top - gap;
  for (let i = focused - 1; i >= 0; i--) {
    const top = Math.min(tops.get(sorted[i].id)!, limit - sorted[i].height);
    tops.set(sorted[i].id, top);
    limit = top - gap;
  }

  cursor = pinned.top + pinned.height + gap;
  for (let i = focused + 1; i < sorted.length; i++) {
    const top = Math.max(sorted[i].top, cursor);
    tops.set(sorted[i].id, top);
    cursor = top + sorted[i].height + gap;
  }
  return tops;
}
