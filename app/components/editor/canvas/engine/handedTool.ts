import type { DrawKind } from "../render/newShape";

/**
 * A shape armed on the page's own bar, handed to whichever canvas the press
 * that carries it lands on.
 *
 * The page bar arms a tool before any diagram is open, and a press on a
 * diagram both opens it and — this is the point — draws in it. The canvas
 * the press lands on is only known to the press, so the tool rides along with
 * it: set in the page's capture phase, taken in the canvas's own handler for
 * that same event, and dropped when the event is done whether or not a canvas
 * took it. It never outlives one dispatch.
 */

let handed: DrawKind | null = null;

export function handTool(kind: DrawKind): void {
  handed = kind;
  // Bubble phase on the window: after every handler the press reaches.
  window.addEventListener("pointerdown", () => (handed = null), { once: true });
}

export function takeHandedTool(): DrawKind | null {
  const kind = handed;
  handed = null;
  return kind;
}
