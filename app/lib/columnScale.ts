/**
 * How much the CSS `zoom` above `el` magnifies it: client px per the element's
 * own CSS px, 1 where nothing is zoomed. Read off the element's box rather
 * than `currentCSSZoom`, so it agrees with whatever the browser's rects and
 * pointer events report. Untransformed elements only — a transform shows in
 * the rect but not in `offsetWidth`.
 */
export function effectiveScale(el: Element): number {
  const host = el instanceof HTMLElement ? el : (el.closest("svg")?.parentElement ?? null);
  const w = host?.offsetWidth ?? 0;
  if (!host || !w) return 1;
  const s = host.getBoundingClientRect().width / w;
  return Number.isFinite(s) && s > 0 ? s : 1;
}
