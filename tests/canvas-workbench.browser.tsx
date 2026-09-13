import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasSurface, type CanvasApi } from "../app/components/editor/canvas/render/CanvasSurface";
import { Toolbar } from "../app/components/editor/canvas/Toolbar";
import { ScreenColorPicker } from "../app/components/editor/canvas/panels/controls/ScreenColorPicker";
import { serializeScene } from "../app/components/editor/canvas/scene/serialize";
import { laidOutScene } from "../app/components/editor/canvas/scene/autoLayout";
import type { Scene, SceneNode } from "../app/components/editor/canvas/scene/types";

const rect = (id: string, x: number, y: number, style: Record<string, string> = { background: "#d9d5cf" }): SceneNode => ({
  id, kind: "rect", x, y, w: 100, h: 100, rot: 0, hidden: false, locked: false, label: "", attrs: { name: id }, style,
});

function fixture(count = 0): Scene {
  return { w: 900, h: 600, attrs: {}, style: { background: "#f7f7f5" }, edges: [], nodes: count
    ? Array.from({ length: count }, (_, i) => ({ ...rect(`tile-${i}`, (i % 40) * 120, Math.floor(i / 40) * 120), label: `Layer ${i}` }))
    : [rect("below", 80, 80, { background: "#d8e0d1" }), rect("outline", 80, 80, { border: "2px solid #292929" }),
      { ...rect("curve", 220, 80, { stroke: "#292929", "stroke-width": "3", fill: "none" }), kind: "path", d: "M0 0C0 100 100 0 100 100" },
      { ...rect("ring", 360, 80, { background: "#cdc6dc" }), kind: "ellipse", inner: 0.6 },
      { ...rect("stack", 80, 260, { display: "flex", "flex-wrap": "wrap", gap: "12px 20px", "align-content": "flex-start", background: "white" }), kind: "group", w: 260, h: 160,
        children: [rect("one", 0, 0), rect("two", 0, 0), rect("three", 0, 0)] },
      { ...rect("nested", 440, 260, { background: "white" }), kind: "group", w: 200, h: 140, children: [rect("child", 20, 20, { background: "#e1d7c7" })] },
    ] };
}

let active: CanvasApi | null = null;
let sceneChanges = 0;
let saved = "";
let generation = 0;
const root = createRoot(document.getElementById("app")!);

function App({ scene }: { scene: Scene }) {
  const [api, setApi] = useState<CanvasApi | null>(null);
  const [sample, setSample] = useState("None");
  const publish = useCallback((value: CanvasApi | null) => { active = value; setApi(value); }, []);
  return <>
    <header><h1>Canvas workbench</h1><p>Isolated interaction and navigation fixtures · no network services</p></header>
    <main><CanvasSurface source={serializeScene(scene)} onChange={(source) => { sceneChanges++; saved = source; }} onApi={publish} /></main>
    {api && <Toolbar store={api.store} viewport={api.viewport} tools={api.tools} presentation={api.presentation} />}
    <aside id="sampling"><ScreenColorPicker onChange={setSample} /><output>{sample}</output></aside>
  </>;
}

const harness = {
  mount: (count = 0) => { sceneChanges = 0; saved = ""; root.render(<App key={++generation} scene={fixture(count)} />); },
  api: () => active!,
  inspect: () => ({ ids: active?.selection.getSnapshot().ids, source: active?.store.getScene(), layout: active ? laidOutScene(active.store.getScene()) : null, sceneChanges, saved }),
};
declare global { interface Window { canvasHarness: typeof harness } }
window.canvasHarness = harness;
harness.mount();
