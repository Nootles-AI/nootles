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
 * The surface stands where a page puts it: in a 720px text column with the
 * band's origin on the column's left edge, inside a scrolling page (`#app`).
 * A diagram has no camera of its own, so nothing here moves one. `look()`
 * scales the column with CSS `zoom` — the way a document is zoomed — and
 * scrolls the page to the point; `toClient`/`domRect` convert through the
 * scene layer's own box and that zoom, never through the surface's
 * conversions, so they check those rather than repeat them.
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
/** The column's CSS zoom — `look()`'s scale. */
let zoom = 1;

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

/** The page's text column — the block wrapper a band sits in. */
function columnEl(): HTMLElement | null {
  return appEl().querySelector<HTMLElement>(".nt-harness-column");
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
  opts: { readOnly?: boolean } = {},
): Promise<void> {
  teardownSurface();

  const html = typeof fixture === "string" ? FIXTURES[fixture].html : fixture.html;
  const app = appEl();
  app.innerHTML = "";
  app.scrollTo(0, 0);
  zoom = 1;
  const column = document.createElement("div");
  column.className = "nt-harness-column nt-canvas-block";
  app.appendChild(column);

  lastSource = html;
  counters = zeroCounters();

  const blocked = (window as unknown as { __blocked?: string[] }).__blocked;
  if (blocked) blocked.length = 0;

  root = createRoot(column);
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

/** Scene (0, 0) in client px: the scene layer's own top-left. */
function origin(): Point {
  const r = sceneLayerEl()!.getBoundingClientRect();
  return { x: r.left, y: r.top };
}

/**
 * The page at `scale`, scrolled so `centre` (scene px) is in the middle of the
 * view — or as near as the page's scroll range allows.
 */
function look(centre: Point, scale: number): void {
  zoom = scale;
  columnEl()!.style.zoom = String(scale);
  const app = appEl();
  const at = toClient(centre);
  const box = app.getBoundingClientRect();
  app.scrollLeft += at.x - (box.left + app.clientWidth / 2);
  app.scrollTop += at.y - (box.top + app.clientHeight / 2);
}

function toClient(point: Point): Point {
  const o = origin();
  return { x: o.x + point.x * zoom, y: o.y + point.y * zoom };
}

function laidRect(id: NodeId): Rect {
  return absoluteBounds(laidOutScene(api!.store.getScene()), id);
}

function domRect(id: NodeId): Rect {
  const el = appEl().querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!el) return { x: 0, y: 0, w: 0, h: 0 };
  const r = el.getBoundingClientRect();
  const o = origin();
  return {
    x: (r.left - o.x) / zoom,
    y: (r.top - o.y) / zoom,
    w: r.width / zoom,
    h: r.height / zoom,
  };
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

/** Where the page stands: its scale, its scroll, and the scene layer's placement in the band. */
function view(): { zoom: number; scrollLeft: number; scrollTop: number; transform: string } {
  const app = appEl();
  return {
    zoom,
    scrollLeft: app.scrollLeft,
    scrollTop: app.scrollTop,
    transform: sceneLayerEl()?.style.transform ?? "",
  };
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
// window.canvasHarness
// ---------------------------------------------------------------------------

const harness = {
  mount,
  unmount,
  api: () => api!,
  focus: () => api!.focus(),
  look,
  toClient,
  laidRect,
  domRect,
  centreOf,
  selection,
  view,
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
  source,
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
