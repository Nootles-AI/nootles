import { StrictMode, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PagesProvider } from "../app/components/PagesContext";
import { CanvasSurface, type CanvasApi } from "../app/components/editor/canvas/render/CanvasSurface";
import { CanvasShellContext, CanvasStylePanel, type ActiveCanvas } from "../app/components/editor/canvas/shell";
import { colorPick, type PickDestination, type PickResult, type PickSource } from "../app/components/editor/canvas/panels/controls/colorPick";
import { serializeScene } from "../app/components/editor/canvas/scene/serialize";
import type { NodeId, RectNode, Scene, StyleMap } from "../app/components/editor/canvas/scene/types";
import "../app/components/editor/canvas/canvas.css";
import "../app/components/editor/canvas/render/shape.css";
import "../app/components/editor/canvas/render/edges.css";
import "../app/components/editor/canvas/panels/panel.css";
import "../app/components/editor/canvas/panels/layers.css";
import "../app/components/editor/canvas/panels/controls/controls.css";
import "./canvas-harness.browser.css";

/**
 * The COLOR browser harness: `CanvasSurface` and `CanvasStylePanel` mounted
 * together through the real `CanvasShellContext`, exactly as `Workspace.tsx`
 * wires them — so `ColorField`'s `useCanvasShell().active?.api` resolves to
 * a live `CanvasApi` the same way it does in the app, `modes`, `store` and
 * `selection` included.
 *
 * Most cases below drive `colorPick.start(...)` directly with a
 * `PickDestination` built the same way `ColorField.tsx`'s `Body` builds one
 * (including the bound/rebind rule) rather than simulating the popover's own
 * open-on-click timing (`ColorField`'s single-click-waits-220ms-for-a-double
 * guard) — that keeps this harness's own surface area proportionate while
 * still exercising the real production pipeline end to end: `CanvasSurface`'s
 * mode gate, `engine/surfaceMode.ts`'s registry, `scene/paintAt.ts`'s
 * reading, and the store's own undo bracket. Two cases (`ui-dropper-button`,
 * `selection-colours-*`) drive the real rendered DOM instead, to prove the
 * button and the panel section actually exist and work.
 */

let root: Root | null = null;
let api: CanvasApi | null = null;
let lastSource = "";
let historyPushes = 0;
let sceneToken = 0;
let lastScene: unknown = null;
const unsubscribe: Array<() => void> = [];

function appEl(): HTMLElement {
  return document.getElementById("app")!;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Fixture scene
// ---------------------------------------------------------------------------

function rect(id: NodeId, x: number, y: number, w: number, h: number, style: StyleMap, label = ""): RectNode {
  return { id, x, y, w, h, rot: 0, style, label, locked: false, hidden: false, attrs: {}, kind: "rect" };
}

function fixtureScene(): Scene {
  return {
    w: 600,
    h: 400,
    style: { "--brand": "#6366f1", "--accent": "#22c55e" },
    nodes: [
      rect("var-rect", 20, 20, 160, 120, { background: "var(--brand)" }),
      rect("grad-rect", 220, 20, 200, 120, { background: "linear-gradient(90deg, #000000 0%, #ffffff 100%)" }),
      rect("share-a", 20, 180, 100, 80, { background: "#123456" }),
      rect("share-b", 160, 180, 100, 80, { background: "#123456" }),
      rect("accent-rect", 300, 180, 100, 80, { background: "var(--accent)" }),
    ],
    edges: [],
    attrs: {},
  };
}

// ---------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------

function Harness({ readOnly, onReady }: { readOnly: boolean; onReady: (api: CanvasApi) => void }) {
  const [active, setActive] = useState<ActiveCanvas | null>(null);
  const shell = useMemo(() => ({ active, set: setActive }), [active]);
  const [source, setSource] = useState(() => serializeScene(fixtureScene()));

  return (
    <CanvasShellContext value={shell}>
      <div style={{ display: "flex", gap: "16px" }}>
        <CanvasSurface
          source={source}
          onChange={(next) => {
            setSource(next);
            lastSource = next;
          }}
          readOnly={readOnly}
          onApi={(next) => {
            if (next) {
              api = next;
              setActive({ blockId: "fixture", api: next });
              onReady(next);
            } else {
              setActive(null);
            }
          }}
        />
        <div className="nt-lyr" style={{ width: 260 }}>
          {active && <CanvasStylePanel api={active.api} />}
        </div>
      </div>
    </CanvasShellContext>
  );
}

async function mount(opts: { readOnly?: boolean } = {}): Promise<void> {
  for (const off of unsubscribe.splice(0)) off();
  root?.unmount();
  api = null;
  historyPushes = 0;
  sceneToken = 0;
  lastScene = null;

  const app = appEl();
  app.innerHTML = "";
  root = createRoot(app);

  await new Promise<void>((resolve) => {
    root!.render(
      <StrictMode>
        <PagesProvider pages={null}>
          <Harness readOnly={opts.readOnly ?? false} onReady={() => resolve()} />
        </PagesProvider>
      </StrictMode>,
    );
  });

  api!.viewport.set({ x: 0, y: 0, zoom: 1 });
  await nextFrame();
  await nextFrame();
  await sleep(150);

  lastSource = serializeScene(api!.store.getScene());
  lastScene = api!.store.getScene();
  unsubscribe.push(
    api!.store.onHistory((event) => {
      if (event.type === "push" && !event.selectionOnly) historyPushes++;
    }),
  );
  unsubscribe.push(
    api!.store.subscribe(() => {
      const scene = api!.store.getScene();
      if (scene !== lastScene) {
        lastScene = scene;
        sceneToken++;
      }
    }),
  );
  resetCounters();
}

function unmount(): void {
  for (const off of unsubscribe.splice(0)) off();
  root?.unmount();
  root = null;
  api = null;
  appEl().innerHTML = "";
}

function resetCounters(): void {
  historyPushes = 0;
  sceneToken = 0;
}

// ---------------------------------------------------------------------------
// Driving a pick session directly (see the module doc comment above)
// ---------------------------------------------------------------------------

function refNameOf(css: string): string | null {
  const m = /^var\(\s*(--[\w-]+)/i.exec(css.trim());
  return m ? m[1] : null;
}

/** The exact rule `ColorField.tsx`'s `Body` applies — reproduced here so a
 *  case that drives `colorPick.start` directly still proves the bound/rebind
 *  behaviour, not just a bare `onChange`. */
function fieldDestination(nodeId: NodeId, prop: string, boundToVar: string | null): PickDestination {
  const current = () => api!.store.getScene().nodes.find((n) => n.id === nodeId)!.style[prop] ?? "";
  return {
    accepts: "paint",
    current: current(),
    apply(value: string, result: PickResult) {
      api!.store.begin();
      if (result.kind === "authored" && refNameOf(value) !== null) {
        api!.store.dispatch({ type: "setStyle", ids: [nodeId], decls: { [prop]: value } });
      } else if (boundToVar) {
        api!.store.dispatch({ type: "setDiagram", style: { [boundToVar]: value } });
      } else {
        api!.store.dispatch({ type: "setStyle", ids: [nodeId], decls: { [prop]: value } });
      }
      api!.store.commit();
    },
  };
}

function startPick(nodeId: NodeId, prop: string, source: PickSource, boundToVar: string | null = null): boolean {
  return colorPick.start(fieldDestination(nodeId, prop, boundToVar), source, api!);
}

function cancelPick(): void {
  colorPick.cancel();
}

function pickState() {
  return colorPick.get();
}

function pointerAt(clientX: number, clientY: number, type: string, extra: Partial<PointerEvent> = {}): void {
  const el = api!.viewport.containerRef.current!;
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      clientX,
      clientY,
      button: 0,
      ...extra,
    }),
  );
}

/** A full click through the real DOM (down on the viewport, up wherever the
 *  pointer capture takes it) — the same shape a physical click has. */
async function clickAt(x: number, y: number, mods: { shiftKey?: boolean; altKey?: boolean } = {}): Promise<void> {
  const client = api!.viewport.sceneToClient({ x, y });
  pointerAt(client.x, client.y, "pointerdown", mods);
  await nextFrame();
  pointerAt(client.x, client.y, "pointerup", mods);
  await nextFrame();
}

async function moveAt(x: number, y: number): Promise<void> {
  const client = api!.viewport.sceneToClient({ x, y });
  pointerAt(client.x, client.y, "pointermove");
  await nextFrame();
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

function cursorOf(): string {
  return getComputedStyle(api!.viewport.containerRef.current!).cursor;
}
function dataMode(): string | null {
  return api!.viewport.containerRef.current!.getAttribute("data-mode");
}
function styleOf(id: NodeId, prop: string): string | undefined {
  return api!.store.getScene().nodes.find((n) => n.id === id)?.style[prop];
}
function diagramVar(name: string): string | undefined {
  return api!.store.getScene().style[name];
}

// ---------------------------------------------------------------------------
// The real DOM: dropper button + Selection colours
// ---------------------------------------------------------------------------

function findByText(selector: string, text: string): HTMLElement | null {
  return [...appEl().querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.trim() === text) ?? null;
}

/** Opens the Fill row's colour popover the fast way — a double click, which
 *  `ColorField`'s own click handler treats as "go straight to typing" and
 *  which also mounts `Body` (the dropper/sampler live there). Avoids the
 *  220ms single-click-open guard's timing entirely. */
async function openFillHexInput(): Promise<HTMLInputElement | null> {
  const section = findByText(".nt-ctl-title", "Fill")?.closest(".nt-ctl-section");
  const swatch = section?.querySelector<HTMLButtonElement>(".nt-ctl-swatch");
  if (!swatch) return null;
  swatch.click();
  swatch.click();
  await nextFrame();
  return appEl().querySelector<HTMLInputElement>('input[aria-label="Hex colour"]');
}

function dropperButton(): HTMLButtonElement | null {
  return appEl().querySelector<HTMLButtonElement>('button[aria-label="Pick from canvas"]');
}
function samplerButton(): HTMLButtonElement | null {
  return appEl().querySelector<HTMLButtonElement>('button[aria-label="Sample screen"]');
}

/** Same fast-open trick as {@link openFillHexInput}, but on the Selection
 *  colours section's first row — proving the edit goes through
 *  `recolorOps`, not `FillSection`'s own per-selected-node patch. */
async function openSelectionColourHexInput(): Promise<HTMLInputElement | null> {
  const section = findByText(".nt-ctl-title", "Selection colours")?.closest(".nt-ctl-section");
  const swatch = section?.querySelector<HTMLButtonElement>(".nt-ctl-row .nt-ctl-swatch");
  if (!swatch) return null;
  swatch.click();
  swatch.click();
  await nextFrame();
  return appEl().querySelector<HTMLInputElement>('input[aria-label="Hex colour"]');
}

async function openFillPopoverSlow(): Promise<void> {
  const section = findByText(".nt-ctl-title", "Fill")?.closest(".nt-ctl-section");
  const swatch = section?.querySelector<HTMLButtonElement>(".nt-ctl-swatch");
  swatch?.click();
  await sleep(260); // past ColorField's DOUBLE_MS guard
}

function selectionColourRows(): { text: string; uses: string | null }[] {
  const section = findByText(".nt-ctl-title", "Selection colours")?.closest(".nt-ctl-section");
  if (!section) return [];
  return [...section.querySelectorAll<HTMLElement>(".nt-ctl-row")].map((row) => ({
    text: row.querySelector(".nt-ctl-swatch-text")?.textContent ?? "",
    uses: row.querySelector(".nt-ctl-note")?.textContent ?? null,
  }));
}

// ---------------------------------------------------------------------------
// EyeDropper stub
// ---------------------------------------------------------------------------

function setEyeDropper(kind: "resolve" | "reject" | null, hex = "#ff0000"): void {
  if (kind === null) {
    delete (window as unknown as { EyeDropper?: unknown }).EyeDropper;
    return;
  }
  (window as unknown as { EyeDropper?: unknown }).EyeDropper = class {
    open() {
      return kind === "resolve" ? Promise.resolve({ sRGBHex: hex }) : Promise.reject(new Error("AbortError"));
    }
  };
}

// ---------------------------------------------------------------------------
// Read-only / mode-gate probe
// ---------------------------------------------------------------------------

/** Forces the mode active on a `readOnly` mount and proves it is checked
 *  before the `readOnly` branch: the mode's own handler runs (its counter
 *  increments) and `selection.click` (the `readOnly` branch's own effect)
 *  does not fire (the selection stays empty). */
async function modeGateBeforeReadOnly(): Promise<{ modeRan: boolean; selectionChanged: boolean }> {
  let modeRan = false;
  const before = [...api!.selection.getSnapshot().ids];
  const release = api!.modes.enter({
    id: "test-probe",
    onPointerDown: () => {
      modeRan = true;
    },
  });
  // `modes.enter` notifies `useSyncExternalStore` synchronously, but the
  // component's own re-render (the closure `onPointerDown` reads `activeMode`
  // from) is scheduled, not synchronous — a real frame has to pass before a
  // dispatched event sees the new mode.
  await nextFrame();
  pointerAt(50, 50, "pointerdown");
  await nextFrame();
  release();
  const after = [...api!.selection.getSnapshot().ids];
  return { modeRan, selectionChanged: JSON.stringify(before) !== JSON.stringify(after) };
}

/** Wave-5 close-out (build-plan Conflict 6 / OQ-6, confirmed): with the zoom
 *  tool (STAGE) selected AND a mode active (COLOR), a press must run the
 *  mode's own handler and never the zoom tool's click-to-zoom — the mode is
 *  checked first in `CanvasSurface.tsx`'s `onPointerDown`, unconditionally,
 *  before the `tool === "zoom"` branch is ever reached. Proven here by the
 *  viewport's zoom staying exactly what it was, not merely by a comment. */
async function modeGateBeforeZoomTool(): Promise<{ modeRan: boolean; zoomChanged: boolean }> {
  let modeRan = false;
  const before = api!.viewport.get().zoom;
  api!.setTool("zoom");
  const release = api!.modes.enter({
    id: "test-probe",
    onPointerDown: () => {
      modeRan = true;
    },
  });
  await nextFrame();
  pointerAt(50, 50, "pointerdown");
  await nextFrame();
  release();
  api!.setTool("move");
  const after = api!.viewport.get().zoom;
  return { modeRan, zoomChanged: after !== before };
}

// ---------------------------------------------------------------------------
// window.pick
// ---------------------------------------------------------------------------

const harness = {
  mount,
  unmount,
  api: () => api!,
  resetCounters,
  history: () => historyPushes,
  sceneToken: () => sceneToken,
  source: () => lastSource,
  select: (ids: NodeId[]) => api!.selection.select(ids),
  focus: () => api!.viewport.containerRef.current?.focus({ preventScroll: true }),
  nextFrame,
  sleep,
  startPick,
  cancelPick,
  pickState,
  clickAt,
  moveAt,
  pressEscape,
  cursorOf,
  dataMode,
  styleOf,
  diagramVar,
  setEyeDropper,
  dropperButton,
  samplerButton,
  openFillHexInput,
  openSelectionColourHexInput,
  openFillPopoverSlow,
  selectionColourRows,
  modeGateBeforeReadOnly,
  modeGateBeforeZoomTool,
  computedNoAccent: () =>
    [...appEl().querySelectorAll<HTMLElement>(".nt-pick-pill, .nt-icon-btn, .nt-ctl-tag")].map(
      (el) => `${getComputedStyle(el).color} ${getComputedStyle(el).borderColor}`,
    ),
};

export type PickHarness = typeof harness;

declare global {
  interface Window {
    pick: PickHarness;
  }
}

window.pick = harness;
