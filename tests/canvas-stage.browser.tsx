import { StrictMode, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PagesProvider } from "../app/components/PagesContext";
import { CanvasSurface, type CanvasApi } from "../app/components/editor/canvas/render/CanvasSurface";
import { CanvasShellContext, CanvasStylePanel, type ActiveCanvas } from "../app/components/editor/canvas/shell";
import { LayersPanel } from "../app/components/editor/canvas/panels/LayersPanel";
import { Toolbar } from "../app/components/editor/canvas/Toolbar";
import { laidOutScene } from "../app/components/editor/canvas/scene/autoLayout";
import { absoluteBounds } from "../app/components/editor/canvas/scene/geometry";
import type { NodeId, Point } from "../app/components/editor/canvas/scene/types";
import { FIXTURES } from "./canvas-fixtures";
import "../app/components/editor/canvas/canvas.css";
import "../app/components/editor/canvas/render/shape.css";
import "../app/components/editor/canvas/render/edges.css";
import "../app/components/editor/canvas/panels/panel.css";
import "../app/components/editor/canvas/panels/layers.css";
import "../app/components/editor/canvas/panels/controls/controls.css";
import "./canvas-harness.browser.css";

/**
 * The STAGE browser fixture: a real `CanvasSurface`, `Toolbar`, `LayersPanel`
 * and `CanvasStylePanel`, wired through `CanvasShellContext` and a column
 * that publishes `--nt-stage-l/r` with the same `ResizeObserver` pattern
 * `Workspace.tsx` uses — so `[data-stage]`'s fixed-position contract lands
 * against real, non-zero rail widths rather than an all-zero fallback.
 *
 * The `small-diagram` fixture (`tests/canvas-fixtures.ts`) is reused
 * verbatim: group `g1` (children `gr1`, `gr2`, `gt1`), free rect `s1`, edge
 * `e1: s1 → g1`.
 *
 * Every gesture below is driven by dispatching real DOM events in-page
 * (`pointerdown`/`pointerup`/`dblclick`/`contextmenu`/`keydown`) at computed
 * client coordinates — the same idiom `canvas-color-pick.browser.tsx` uses —
 * rather than a scripted mouse/keyboard choreography, since the surface's own
 * pointer handling never depends on event trust. No label is ever typed into.
 */

let root: Root | null = null;
let api: CanvasApi | null = null;
const unsubscribe: Array<() => void> = [];

interface Counters {
  notifications: number;
  historyPushes: number;
  shapeMutations: number;
}
let counters: Counters = { notifications: 0, historyPushes: 0, shapeMutations: 0 };
let mutationObserver: MutationObserver | null = null;
let lastScene: unknown = null;

function appEl(): HTMLElement {
  return document.getElementById("app")!;
}
function paneEl(): HTMLElement {
  return document.getElementById("pane")!;
}
function sceneLayerEl(): HTMLElement | null {
  return appEl().querySelector<HTMLElement>(".nt-canvas-scene");
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// The shell: real Toolbar / LayersPanel / CanvasStylePanel, real chrome gate
// ---------------------------------------------------------------------------

const NEVER_CHANGES = () => () => {};

function Harness({ onReady }: { onReady: (api: CanvasApi) => void }) {
  const [active, setActive] = useState<ActiveCanvas | null>(null);
  const shell = useMemo(() => ({ active, set: setActive }), [active]);
  const [source, setSource] = useState(() => FIXTURES["small-diagram"].html);
  const columnRef = useRef<HTMLDivElement>(null);

  // The same `--nt-stage-l/r` publication `Workspace.tsx` does, against this
  // fixture's own column rather than the real app's rails.
  useLayoutEffect(() => {
    const el = columnRef.current;
    if (!el) return;
    const root = document.documentElement.style;
    const measure = () => {
      const box = el.getBoundingClientRect();
      root.setProperty("--nt-stage-l", `${box.left}px`);
      root.setProperty("--nt-stage-r", `${window.innerWidth - box.right}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.removeProperty("--nt-stage-l");
      root.removeProperty("--nt-stage-r");
    };
  }, []);

  const screen = active?.api.screen;
  const minimal = useSyncExternalStore(
    screen?.subscribe ?? NEVER_CHANGES,
    () => screen?.get().minimal ?? false,
    () => false,
  );
  const chrome = !(active && minimal);

  return (
    <CanvasShellContext value={shell}>
      <div className="flex h-screen w-full overflow-hidden">
        {chrome && active && (
          <LayersPanel store={active.api.store} selection={active.api.selection} />
        )}
        <main id="pane" ref={columnRef} className="relative isolate min-w-0 flex-1" style={{ overflow: "auto" }}>
          {/* Real scroll room above and below the block, like a document. */}
          <div style={{ height: 600 }} />
          <CanvasSurface
            source={source}
            onChange={(next) => setSource(next)}
            onApi={(next) => {
              if (next) {
                setActive({ blockId: "fixture", api: next });
                onReady(next);
              } else {
                setActive(null);
              }
            }}
          />
          <div style={{ height: 2000 }} />
        </main>
        {chrome && active && <CanvasStylePanel api={active.api} />}
        {chrome && active && !active.api.board && (
          <Toolbar
            store={active.api.store}
            viewport={active.api.viewport}
            tools={active.api.tools}
            screen={active.api.screen}
          />
        )}
      </div>
    </CanvasShellContext>
  );
}

async function mount(): Promise<void> {
  for (const off of unsubscribe.splice(0)) off();
  mutationObserver?.disconnect();
  mutationObserver = null;
  root?.unmount();
  api = null;

  const app = appEl();
  app.innerHTML = "";
  root = createRoot(app);

  await new Promise<void>((resolve) => {
    root!.render(
      <StrictMode>
        <PagesProvider pages={null}>
          <Harness
            onReady={(next) => {
              api = next;
              resolve();
            }}
          />
        </PagesProvider>
      </StrictMode>,
    );
  });

  api!.viewport.set({ x: 0, y: 0, zoom: 1 });
  await nextFrame();
  await nextFrame();
  await sleep(150);
  paneEl().scrollTop = 300;
  await nextFrame();

  lastScene = api!.store.getScene();
  resetCounters();
  unsubscribe.push(
    api!.store.subscribe(() => {
      counters.notifications++;
      const scene = api!.store.getScene();
      if (scene !== lastScene) lastScene = scene;
    }),
  );
  unsubscribe.push(
    api!.store.onHistory((event) => {
      if (event.type === "push" && !event.selectionOnly) counters.historyPushes++;
    }),
  );
  const layer = sceneLayerEl();
  if (layer) {
    mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target === layer) continue;
        counters.shapeMutations++;
      }
    });
    mutationObserver.observe(layer, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  }
}

function unmount(): void {
  for (const off of unsubscribe.splice(0)) off();
  mutationObserver?.disconnect();
  mutationObserver = null;
  root?.unmount();
  root = null;
  api = null;
  appEl().innerHTML = "";
}

function resetCounters(): void {
  counters = { notifications: 0, historyPushes: 0, shapeMutations: 0 };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function laidRect(id: NodeId) {
  return absoluteBounds(laidOutScene(api!.store.getScene()), id);
}
function centreClient(id: NodeId): Point {
  const r = laidRect(id);
  return api!.viewport.sceneToClient({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
}
function containerCentreClient(): Point {
  const el = api!.viewport.containerRef.current!;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
function containerRect(): { top: number; left: number; right: number; bottom: number } {
  const r = api!.viewport.containerRef.current!.getBoundingClientRect();
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
}
function centreScenePoint(): Point {
  return api!.viewport.clientToScene(containerCentreClient());
}

// ---------------------------------------------------------------------------
// Driving input — synthetic DOM events, none of them trusted, all of them
// exactly what the surface's own handlers listen for.
// ---------------------------------------------------------------------------

function pointerAt(el: Element, clientX: number, clientY: number, type: string, extra: Partial<PointerEvent> = {}): void {
  el.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, clientX, clientY, button: 0, ...extra }),
  );
}

async function clickAt(clientX: number, clientY: number): Promise<void> {
  const el = api!.viewport.containerRef.current!;
  pointerAt(el, clientX, clientY, "pointerdown");
  await nextFrame();
  pointerAt(el, clientX, clientY, "pointerup");
  await nextFrame();
}

/** Dispatched at the shape's own `[data-id]` element — `ShapeView`'s
 *  `onDoubleClick` (which marks `asked.current`) and the viewport's own
 *  (which reads it) are both native "dblclick" listeners on this same
 *  bubble path, so one synthetic event reaches both, in the right order. */
function dblClickShape(id: NodeId): void {
  const el = appEl().querySelector(`[data-id="${CSS.escape(id)}"]`)!;
  const { x, y } = centreClient(id);
  el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
}

function contextMenuAt(id: NodeId): void {
  const el = api!.viewport.containerRef.current!;
  const { x, y } = centreClient(id);
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
}

/** A keydown at whatever the page currently has focused — real key input
 *  always originates there, so this is what a trusted key press would hit. */
function pressKey(init: { key: string; code?: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }): void {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

const pressEscape = () => pressKey({ key: "Escape" });
/** ⌘⇧F — Apple UA is set by the runner, so `Mod` is `metaKey`. */
const pressStageChord = () => pressKey({ key: "f", code: "KeyF", metaKey: true, shiftKey: true });
/** ⌘. */
const pressMinimalChord = () => pressKey({ key: ".", code: "Period", metaKey: true });

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function shapeDom(): string {
  const el = sceneLayerEl();
  if (!el) return "";
  return [...el.querySelectorAll(":scope > .nt-node")].map((n) => n.outerHTML).join("\n");
}
function dataStage(): boolean {
  return appEl().querySelector(".nt-canvas[data-stage]") !== null;
}
function selectionSnapshot() {
  const s = api!.selection.getSnapshot();
  return { ids: [...s.ids], enteredPath: [...s.enteredPath] };
}
function screenState() {
  return api!.screen.get();
}
function menuPresent(): boolean {
  return appEl().querySelector('[role="menu"]') !== null;
}
function editingLabel(): { id: NodeId | null; focused: boolean } {
  const node = appEl().querySelector<HTMLElement>(".nt-node.is-editing[data-id]");
  const edit = appEl().querySelector<HTMLElement>(".nt-edit");
  if (!node) return { id: null, focused: false };
  return {
    id: node.getAttribute("data-id"),
    focused: !!edit && (document.activeElement === edit || edit.contains(document.activeElement)),
  };
}
function chromeMounted() {
  return {
    toolbar: appEl().querySelector(".nt-toolbar") !== null,
    layers: appEl().querySelector(".nt-lyr") !== null,
    stylePanel: appEl().querySelector(".nt-style-panel") !== null,
  };
}
function fullscreenElementIsDocument(): boolean {
  return document.fullscreenElement === document.documentElement;
}

// ---------------------------------------------------------------------------
// window.stageHarness
// ---------------------------------------------------------------------------

const harness = {
  mount,
  unmount,
  api: () => api!,
  focus: () => api!.viewport.containerRef.current?.focus({ preventScroll: true }),
  nextFrame,
  sleep,
  resetCounters,
  counters: () => ({ ...counters }),
  laidRect,
  centreClient,
  containerCentreClient,
  containerRect,
  centreScenePoint,
  clientToScene: (p: Point) => api!.viewport.clientToScene(p),
  viewport: () => api!.viewport.get(),
  panBy: (dx: number, dy: number) => api!.viewport.panBy(dx, dy),
  clickAt,
  dblClickShape,
  contextMenuAt,
  pressKey,
  pressEscape,
  pressStageChord,
  pressMinimalChord,
  select: (ids: NodeId[]) => api!.selection.select(ids),
  shapeDom,
  dataStage,
  selectionSnapshot,
  screenState,
  menuPresent,
  editingLabel,
  chromeMounted,
  scrollTop: () => paneEl().scrollTop,
  setScrollTop: (v: number) => {
    paneEl().scrollTop = v;
  },
  fullscreenElementIsDocument,
  fullscreenEnabled: () => document.fullscreenEnabled === true,
  requestFullscreen: () => document.documentElement.requestFullscreen(),
  exitFullscreenDirect: () => document.exitFullscreen(),
};

export type StageHarness = typeof harness;

declare global {
  interface Window {
    stageHarness: StageHarness;
  }
}

window.stageHarness = harness;
