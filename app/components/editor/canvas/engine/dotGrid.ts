/**
 * Whether the diagram being edited shows its dot ground.
 *
 * Unlike snapping — a mood you are in for a session — this is how you like the
 * surface to look, so it is kept per browser. It is said once, as an attribute
 * on the root (`.nt-canvas-grid` answers it in canvas.css), so turning it off
 * re-renders nothing.
 */

const KEY = "nt:canvasGrid";

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    // Storage refused, or no window at all: the default, which is on.
    return true;
  }
}

let shown = stored();
const listeners = new Set<() => void>();

function reflect(): void {
  if (typeof document === "undefined") return;
  if (shown) delete document.documentElement.dataset.ntGrid;
  else document.documentElement.dataset.ntGrid = "off";
}
reflect();

export function isGridShown(): boolean {
  return shown;
}

export function setGridShown(on: boolean): void {
  if (on === shown) return;
  shown = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Storage refused: it holds for this visit only.
  }
  reflect();
  for (const listener of listeners) listener();
}

/** Subscribe to {@link isGridShown}, for `useSyncExternalStore`. */
export function subscribeGrid(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
