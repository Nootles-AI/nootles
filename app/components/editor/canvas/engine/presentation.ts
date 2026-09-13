import type { ViewportController } from "./useViewport";

export interface CanvasPresentation {
  get(): boolean;
  subscribe(listener: () => void): () => void;
  toggle(): void;
  destroy(): void;
}

let closeActive: (() => void) | null = null;

/** Expand the existing DOM in place: no remount, second scene, or camera reset. */
export function createPresentation(): CanvasPresentation & { attach(element: HTMLDivElement | null, controller: ViewportController): void } {
  let element: HTMLDivElement | null = null;
  let viewport: ViewportController | null = null;
  let columnObserver: ResizeObserver | null = null;
  let expanded = false;
  const listeners = new Set<() => void>();
  const place = () => {
    const el = element;
    if (!el) return;
    const column = el.closest("[data-canvas-column]")?.getBoundingClientRect();
    el.style.setProperty("--nt-focus-left", `${column ? column.left + 8 : 8}px`);
    el.style.setProperty("--nt-focus-right", `${column ? window.innerWidth - column.right + 8 : 8}px`);
  };
  const set = (next: boolean) => {
    const el = element, container = viewport?.containerRef.current;
    if (!el || !container || !viewport || expanded === next) return;
    if (next) closeActive?.();
    const before = { w: container.clientWidth, h: container.clientHeight };
    expanded = next;
    if (next) place();
    el.classList.toggle("is-expanded", next);
    // One layout read on entering/leaving; never part of a pan or zoom.
    viewport.panBy((container.clientWidth - before.w) / 2, (container.clientHeight - before.h) / 2);
    if (next) {
      closeActive = close;
      const column = el.closest("[data-canvas-column]");
      if (column && typeof ResizeObserver !== "undefined") {
        columnObserver = new ResizeObserver(place);
        columnObserver.observe(column);
      }
      window.addEventListener("resize", place);
      document.addEventListener("keydown", escape);
    } else {
      columnObserver?.disconnect(); columnObserver = null;
      if (closeActive === close) closeActive = null;
      window.removeEventListener("resize", place);
      document.removeEventListener("keydown", escape);
    }
    container.focus({ preventScroll: true });
    listeners.forEach((listener) => listener());
  };
  const close = () => set(false);
  const escape = (event: KeyboardEvent) => {
    // Let tools, text fields and menus consume Escape before leaving focus mode.
    if (event.key === "Escape" && !event.defaultPrevented && event.target === viewport?.containerRef.current) {
      event.preventDefault(); close();
    }
  };
  return {
    attach: (el, controller) => { element = el; viewport = controller; },
    get: () => expanded,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    toggle: () => set(!expanded),
    destroy: () => {
      close();
      columnObserver?.disconnect(); columnObserver = null;
      window.removeEventListener("resize", place);
      document.removeEventListener("keydown", escape);
      if (closeActive === close) closeActive = null;
      listeners.clear();
      element = null; viewport = null;
    },
  };
}
