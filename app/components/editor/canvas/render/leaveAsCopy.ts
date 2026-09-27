/**
 * An exit for chrome React has already taken out: a copy of it stays where it
 * was, marked `is-leaving` for its stylesheet to fade, and goes when that has
 * played. The real element is gone at once, so nothing waits on the exit — no
 * pointer, no focus, no measure.
 *
 * Call from a layout effect's cleanup with the element and its parent, read
 * while it was mounted. Checked a microtask later: a strict-mode re-run leaves
 * the element attached, and a host taken out with it has nowhere to show one.
 */
export function leaveAsCopy(el: Element, host: Element, trim?: (copy: Element) => void): void {
  queueMicrotask(() => {
    if (el.isConnected || !host.isConnected) return;
    const copy = el.cloneNode(true) as Element;
    trim?.(copy);
    copy.classList.add("is-leaving");
    copy.setAttribute("aria-hidden", "true");
    copy.setAttribute("inert", "");
    host.append(copy);
    void Promise.all(copy.getAnimations().map((running) => running.finished))
      .catch(() => {})
      .finally(() => copy.remove());
  });
}
