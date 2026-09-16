import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PagesProvider } from "../app/components/PagesContext";
import { CanvasSurface, type CanvasApi } from "../app/components/editor/canvas/render/CanvasSurface";
import { laidOutScene } from "../app/components/editor/canvas/scene/autoLayout";
import { absoluteBounds } from "../app/components/editor/canvas/scene/geometry";
import type { EdgeId, NodeId, Point, Rect } from "../app/components/editor/canvas/scene/types";
import { FIXTURES, type FixtureName } from "./canvas-fixtures";
import "./canvas-harness.browser.css";

/**
 * The one bundled page every canvas browser test mounts: `CanvasSurface`
 * wired up exactly as `CanvasBlock` wires it — `source` + `onChange` +
 * `onApi`, inside `<StrictMode>` and a `PagesProvider pages={null}` — minus
 * Yjs and Convex, neither of which `CanvasSurface` itself needs. No
 * `ConvexProvider` is required: `usePages`/`useCurrentPage`/
 * `useOpenPageOptional` all tolerate an absent provider (confirmed by
 * reading them), which is the whole reason `ShapeLabel`'s mention machinery
 * doesn't need one here.
 *
 * Every counter below is wired up AFTER `mount()`'s settle window, not
 * inside the `onApi` callback itself — `<StrictMode>` double-invokes mount
 * effects in dev, so `onApi(api)` fires, `onApi(null)` fires, `onApi(api)`
 * fires again before the first paint settles. Racing that replay would
 * double-count a subscription; waiting it out costs nothing a real gesture
 * would notice.
 */

// ---------------------------------------------------------------------------
// Module state — one harness, one mounted surface at a time
// ---------------------------------------------------------------------------

let root: Root | null = null;
let api: CanvasApi | null = null;
let lastSource = "";
let sceneTokenValue = 0;
let lastScene: unknown = null;
let unsubscribe: Array<() => void> = [];
let mutationObserver: MutationObserver | null = null;

interface Counters {
  notifications: number;
  writes: number;
  historyPushes: number;
  selectionOnlyPushes: number;
  shapeMutations: number;
  sceneIdentityChanges: number;
  /** First 20 `{targetId, attributeName}` records behind `shapeMutations`,
   *  for a failure message — never reset separately from the count. */
  shapeMutationSamples: Array<{ targetId: string | null; attributeName: string | null }>;
}

function zeroCounters(): Counters {
  return {
    notifications: 0,
    writes: 0,
    historyPushes: 0,
    selectionOnlyPushes: 0,
    shapeMutations: 0,
    sceneIdentityChanges: 0,
    shapeMutationSamples: [],
  };
}

let counters: Counters = zeroCounters();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function appEl(): HTMLElement {
  return document.getElementById("app")!;
}

function sceneLayerEl(): HTMLElement | null {
  return appEl().querySelector<HTMLElement>(".nt-canvas-scene");
}

// ---------------------------------------------------------------------------
// mount / unmount
// ---------------------------------------------------------------------------

function teardownSurface(): void {
  for (const off of unsubscribe) off();
  unsubscribe = [];
  mutationObserver?.disconnect();
  mutationObserver = null;
  root?.unmount();
  root = null;
  api = null;
}

async function mount(
  fixture: FixtureName | { html: string },
  opts: { readOnly?: boolean; width?: number; height?: number } = {},
): Promise<void> {
  teardownSurface();

  const html = typeof fixture === "string" ? FIXTURES[fixture].html : fixture.html;
  const width = opts.width ?? 1200;
  const height = opts.height ?? 800;
  const app = appEl();
  app.classList.add("nt-harness-sized");
  app.style.setProperty("--nt-harness-w", `${width}px`);
  app.style.setProperty("--nt-harness-h", `${height}px`);
  app.innerHTML = "";

  lastSource = html;
  counters = zeroCounters();

  const blocked = (window as unknown as { __blocked?: string[] }).__blocked;
  if (blocked) blocked.length = 0;

  root = createRoot(app);
  await new Promise<void>((resolve) => {
    root!.render(
      <StrictMode>
        <PagesProvider pages={null}>
          <CanvasSurface
            source={html}
            onChange={(source) => {
              counters.writes++;
              lastSource = source;
            }}
            readOnly={opts.readOnly ?? false}
            onApi={(next) => {
              api = next;
              if (next) resolve();
            }}
          />
        </PagesProvider>
      </StrictMode>,
    );
  });

  // Instant placement, before anything is measured — a fixture's own
  // first-paint `zoomToFit` must never leak into what a runner sees.
  api!.viewport.set({ x: 0, y: 0, zoom: 1 });
  await nextFrame();
  await nextFrame();
  await sleep(200);

  // Wired only now: StrictMode's replay is long since over, so every
  // subscription below is exactly one, on the settled store.
  const current = api!;
  lastScene = current.store.getScene();
  sceneTokenValue = 0;
  unsubscribe.push(
    current.store.subscribe(() => {
      counters.notifications++;
      const scene = current.store.getScene();
      if (scene !== lastScene) {
        lastScene = scene;
        counters.sceneIdentityChanges++;
        sceneTokenValue++;
      }
    }),
  );
  unsubscribe.push(
    current.store.onHistory((event) => {
      if (event.type !== "push") return;
      if (event.selectionOnly) counters.selectionOnlyPushes++;
      else counters.historyPushes++;
    }),
  );

  const layer = sceneLayerEl();
  if (layer) {
    mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target;
        if (target === layer) continue;
        if (target instanceof Element && target.closest("svg.nt-ov, svg.nt-edges")) continue;
        counters.shapeMutations++;
        if (counters.shapeMutationSamples.length < 20) {
          const el = target instanceof Element ? target : target.parentElement;
          counters.shapeMutationSamples.push({
            targetId: el?.closest("[data-id]")?.getAttribute("data-id") ?? null,
            attributeName: record.attributeName,
          });
        }
      }
    });
    mutationObserver.observe(layer, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeOldValue: true,
    });
  }

  resetCounters();
}

function unmount(): void {
  teardownSurface();
  appEl().innerHTML = "";
}

function resetCounters(): void {
  counters = zeroCounters();
  const blocked = (window as unknown as { __blocked?: string[] }).__blocked;
  if (blocked) blocked.length = 0;
}

// ---------------------------------------------------------------------------
// Geometry and DOM reads
// ---------------------------------------------------------------------------

function look(centre: Point, zoom: number): void {
  const container = api!.viewport.containerRef.current!;
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  api!.viewport.set({ x: cw / 2 - centre.x * zoom, y: ch / 2 - centre.y * zoom, zoom });
}

function toClient(point: Point): Point {
  return api!.viewport.sceneToClient(point);
}

function laidRect(id: NodeId): Rect {
  return absoluteBounds(laidOutScene(api!.store.getScene()), id);
}

function domRect(id: NodeId): Rect {
  const el = appEl().querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!el) return { x: 0, y: 0, w: 0, h: 0 };
  const r = el.getBoundingClientRect();
  const a = api!.viewport.clientToScene({ x: r.left, y: r.top });
  const b = api!.viewport.clientToScene({ x: r.right, y: r.bottom });
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}

function centreOf(id: NodeId): Point {
  const r = laidRect(id);
  return toClient({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
}

function selection() {
  const snap = api!.selection.getSnapshot();
  return {
    ids: [...snap.ids],
    hoverId: snap.hoverId,
    enteredPath: [...snap.enteredPath],
    edgeIds: [...snap.edgeIds] as EdgeId[],
  };
}

function sceneStyle(): { transform: string; willChange: string } {
  const el = sceneLayerEl();
  return { transform: el?.style.transform ?? "", willChange: el?.style.willChange ?? "" };
}

function shapeDom(): string {
  const el = sceneLayerEl();
  if (!el) return "";
  return [...el.querySelectorAll(":scope > .nt-node")].map((node) => node.outerHTML).join("\n");
}

function source(): string {
  return lastSource;
}

function contextMenu(): { open: boolean; rows: { label: string; disabled: boolean; layerId: string | null }[] } {
  const menu = appEl().querySelector<HTMLElement>('[role="menu"]');
  if (!menu) return { open: false, rows: [] };
  const rows = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((button) => {
    const label = [...button.childNodes].find((n) => n.nodeType === Node.TEXT_NODE)?.textContent?.trim() ?? "";
    return { label, disabled: button.disabled, layerId: button.getAttribute("data-layer-id") };
  });
  return { open: true, rows };
}

function editingLabel(): { id: NodeId | null; text: string; focused: boolean } {
  const node = appEl().querySelector<HTMLElement>(".nt-node.is-editing[data-id]");
  const edit = appEl().querySelector<HTMLElement>(".nt-edit");
  if (!node) return { id: null, text: "", focused: false };
  return {
    id: node.getAttribute("data-id"),
    text: edit?.textContent ?? "",
    focused: !!edit && (document.activeElement === edit || edit.contains(document.activeElement)),
  };
}

function aiReach(): string[] {
  return (window as unknown as { __aiReach?: string[] }).__aiReach ?? [];
}

// ---------------------------------------------------------------------------
// Frame and handler sampling (§3.1.4)
// ---------------------------------------------------------------------------

interface LoafEntry {
  start: number;
  duration: number;
  blocking: number;
}

interface FrameSampler {
  raf: number;
  intervals: number[];
  last: number;
  loaf: LoafEntry[];
  observer: PerformanceObserver | null;
  wheelHandlerMs: number[];
  wheelStart: number;
  onCapture: (event: Event) => void;
  onBubble: (event: Event) => void;
}

let sampler: FrameSampler | null = null;

function startFrames(): void {
  sampler?.observer?.disconnect();
  if (sampler) cancelAnimationFrame(sampler.raf);

  const s: FrameSampler = {
    raf: 0,
    intervals: [],
    last: 0,
    loaf: [],
    observer: null,
    wheelHandlerMs: [],
    wheelStart: 0,
    onCapture: () => {
      s.wheelStart = performance.now();
    },
    onBubble: () => {
      s.wheelHandlerMs.push(performance.now() - s.wheelStart);
    },
  };

  const tick = (now: number) => {
    if (s.last !== 0) s.intervals.push(now - s.last);
    s.last = now;
    s.raf = requestAnimationFrame(tick);
  };
  s.raf = requestAnimationFrame(tick);

  // Chromium >= 123 only; the runner's pinned 151 has it. Absent elsewhere,
  // `loaf` is simply always empty, which the caller treats as "nothing long."
  const PerfObserverCtor = (window as unknown as { PerformanceObserver?: typeof PerformanceObserver })
    .PerformanceObserver;
  if (PerfObserverCtor && PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")) {
    s.observer = new PerfObserverCtor((list) => {
      for (const entry of list.getEntries() as unknown as Array<{
        startTime: number;
        duration: number;
        blockingDuration?: number;
      }>) {
        s.loaf.push({ start: entry.startTime, duration: entry.duration, blocking: entry.blockingDuration ?? 0 });
      }
    });
    s.observer.observe({ type: "long-animation-frame", buffered: false } as PerformanceObserverInit);
  }

  window.addEventListener("wheel", s.onCapture, { capture: true, passive: true });
  window.addEventListener("wheel", s.onBubble, { capture: false, passive: true });
  sampler = s;
}

function stopFrames(): { intervals: number[]; wheelHandlerMs: number[]; loaf: LoafEntry[] } {
  if (!sampler) return { intervals: [], wheelHandlerMs: [], loaf: [] };
  const s = sampler;
  sampler = null;
  cancelAnimationFrame(s.raf);
  s.observer?.disconnect();
  window.removeEventListener("wheel", s.onCapture, true);
  window.removeEventListener("wheel", s.onBubble, false);
  return { intervals: s.intervals, wheelHandlerMs: s.wheelHandlerMs, loaf: s.loaf };
}

// ---------------------------------------------------------------------------
// window.canvasHarness
// ---------------------------------------------------------------------------

const harness = {
  mount,
  unmount,
  api: () => api!,
  focus: () => api!.viewport.containerRef.current?.focus({ preventScroll: true }),
  look,
  toClient,
  laidRect,
  domRect,
  centreOf,
  selection,
  counters: () => ({
    notifications: counters.notifications,
    writes: counters.writes,
    historyPushes: counters.historyPushes,
    selectionOnlyPushes: counters.selectionOnlyPushes,
    shapeMutations: counters.shapeMutations,
    sceneIdentityChanges: counters.sceneIdentityChanges,
    blockedCalls: [...((window as unknown as { __blocked?: string[] }).__blocked ?? [])],
    shapeMutationSamples: counters.shapeMutationSamples,
  }),
  resetCounters,
  sceneToken: () => sceneTokenValue,
  shapeDom,
  sceneStyle,
  source,
  startFrames,
  stopFrames,
  nextFrame,
  contextMenu,
  editingLabel,
  aiReach,
};

export type CanvasHarness = typeof harness;

declare global {
  interface Window {
    canvasHarness: CanvasHarness;
  }
}

window.canvasHarness = harness;
