/**
 * A sheet over the whole window for the length of a gesture: it holds the
 * cursor wherever the hand goes, keeps the gesture from selecting text, and
 * stops an embedded frame from swallowing the moves. Returns its removal.
 *
 * On a veil rather than the body because `cursor` and `user-select` are both
 * inherited: written on the body, they restyled every element in the document
 * at the press and again at the release.
 *
 * The veil takes the wheel too, so it hands each one to whatever would have
 * scrolled under it — a list or a page stays scrollable mid-drag.
 */
export function raiseVeil(cursor = "default"): () => void {
  const veil = document.createElement("div");
  veil.className = "nt-veil";
  veil.style.cursor = cursor;
  veil.setAttribute("aria-hidden", "true");
  const wheel = (e: WheelEvent) => {
    // A pinch arrives as a wheel with ctrl held; it is a zoom, not a scroll.
    if (e.ctrlKey) return;
    const under = document.elementsFromPoint(e.clientX, e.clientY)[1];
    const scroller = under && scrollerOf(under, e.deltaX, e.deltaY);
    if (!scroller) return;
    const unit =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? scroller.clientHeight
          : 1;
    scroller.scrollBy(e.deltaX * unit, e.deltaY * unit);
  };
  veil.addEventListener("wheel", wheel, { passive: true });
  document.body.append(veil);
  return () => veil.remove();
}

/** The nearest box that can move the way the wheel is turning. */
function scrollerOf(from: Element, dx: number, dy: number): Element | null {
  for (let el: Element | null = from; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    const canY =
      dy !== 0 &&
      /auto|scroll/.test(style.overflowY) &&
      el.scrollHeight > el.clientHeight;
    const canX =
      dx !== 0 &&
      /auto|scroll/.test(style.overflowX) &&
      el.scrollWidth > el.clientWidth;
    if (canY || canX) return el;
  }
  return document.scrollingElement;
}
