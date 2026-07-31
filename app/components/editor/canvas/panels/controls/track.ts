import { clamp01 } from "./color";

/**
 * Drag a value out of a fixed box: a colour square, a hue slider, a gradient bar.
 *
 * The box's rect is measured once, at pointer-down — none of these move while
 * you are dragging one, so re-measuring per move would only cost layout. `onEnd`
 * is where the caller commits, so a whole drag lands as one change.
 *
 * `batch` coalesces moves to one `onAt` per frame and drops a frame that landed
 * on the point the last one did. That is what lets `onAt` write straight through
 * to the scene — a live drag then costs one update per frame however fast the
 * pointer reports. A pending frame is flushed before `onEnd`, so the drag ends
 * where it looks like it ended.
 */
export function track(
  e: React.PointerEvent<HTMLElement>,
  onAt: (x: number, y: number) => void,
  onEnd: () => void,
  { batch = false }: { batch?: boolean } = {},
) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const to = (cx: number, cy: number) => ({
    x: clamp01((cx - r.left) / r.width),
    y: clamp01((cy - r.top) / r.height),
  });

  let sent = to(e.clientX, e.clientY);
  let next = sent;
  let frame = 0;

  const flush = () => {
    frame = 0;
    if (next.x === sent.x && next.y === sent.y) return;
    sent = next;
    onAt(sent.x, sent.y);
  };

  el.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    next = to(ev.clientX, ev.clientY);
    if (!batch) flush();
    else if (frame === 0) frame = requestAnimationFrame(flush);
  };
  const end = () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", end);
    el.removeEventListener("pointercancel", end);
    if (frame !== 0) {
      cancelAnimationFrame(frame);
      flush();
    }
    onEnd();
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  onAt(sent.x, sent.y);
}
