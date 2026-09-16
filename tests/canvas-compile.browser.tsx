import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PagesProvider } from "../app/components/PagesContext";
import { compileSceneReady } from "../app/lib/ai/html/toHtml";
import { COMPILE_FIXTURES, type CompileFixtureName } from "../app/lib/ai/html/compileFixtures";
import { EdgeLayer } from "../app/components/editor/canvas/render/EdgeLayer";
import { ShapeView } from "../app/components/editor/canvas/render/ShapeView";
import { laidOutScene } from "../app/components/editor/canvas/scene/autoLayout";
import { parseScene } from "../app/components/editor/canvas/scene/parse";
import type { EdgeId, Scene } from "../app/components/editor/canvas/scene/types";
import "../app/components/editor/canvas/canvas.css";
import "../app/components/editor/canvas/render/shape.css";
import "../app/components/editor/canvas/render/edges.css";
import "./canvas-compile.browser.css";

/**
 * The compile-parity fixture: the LIVE renderer (`ShapeView` + `EdgeLayer`,
 * not `CanvasSurface` — no viewport, no gestures, no selection) on the left,
 * `compileSceneReady`'s markup poured in as raw HTML on the right, side by
 * side. Same fixture, same box, so a mismatch between the renderer and the
 * compiler shows up as a geometry or a pixel diff (COMPILE, build-plan §5.2).
 *
 * `scene` below is what `CanvasSurface` itself calls `scene` — already
 * `laidOutScene(parsed)`, exactly the object every render call in the real
 * surface reads from (`render/CanvasSurface.tsx` line ~213). There is no
 * second, "unlaid" tree this page renders from.
 */

const EMPTY_EDGES: ReadonlySet<EdgeId> = new Set();

function Panes({ scene, compiled }: { scene: Scene; compiled: string }) {
  return (
    <div className="compile-harness-row">
      <div id="left" className="nt-canvas" style={{ width: scene.w, height: scene.h, background: "#fff" }}>
        <div className="nt-canvas-viewport">
          <div className="nt-canvas-scene">
            <EdgeLayer scene={scene} selected={EMPTY_EDGES} hoverId={null} />
            {scene.nodes.map((node) => (
              <ShapeView key={node.id} node={node} />
            ))}
          </div>
        </div>
      </div>
      <div id="right" style={{ width: scene.w, height: scene.h, background: "#fff" }} dangerouslySetInnerHTML={{ __html: compiled }} />
    </div>
  );
}

type Boxes = Record<string, { x: number; y: number; w: number; h: number }>;

function readBoxes(root: HTMLElement, selector: string): Boxes {
  const paneRect = root.getBoundingClientRect();
  const out: Boxes = {};
  for (const el of root.querySelectorAll<HTMLElement>(selector)) {
    const id = el.getAttribute(selector === "[data-id]" ? "data-id" : "data-nt-id");
    if (!id || id in out) continue; // first match wins — a nested duplicate id is not this harness's problem
    const r = el.getBoundingClientRect();
    out[id] = { x: r.left - paneRect.left, y: r.top - paneRect.top, w: r.width, h: r.height };
  }
  return out;
}

let root: Root | null = null;

function appEl(): HTMLElement {
  return document.getElementById("app")!;
}

async function mount(name: CompileFixtureName): Promise<{ boxes: { left: Boxes; right: Boxes } }> {
  root?.unmount();
  const app = appEl();
  app.innerHTML = "";
  const scene = laidOutScene(parseScene(COMPILE_FIXTURES[name]));
  const { code } = await compileSceneReady(scene);

  root = createRoot(app);
  await new Promise<void>((resolve) => {
    root!.render(
      <StrictMode>
        <PagesProvider pages={null}>
          <Panes scene={scene} compiled={code} />
        </PagesProvider>
      </StrictMode>,
    );
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

  const left = app.querySelector<HTMLElement>("#left")!;
  const right = app.querySelector<HTMLElement>("#right")!;
  return {
    boxes: {
      left: readBoxes(left, "[data-id]"),
      right: readBoxes(right, "[data-nt-id]"),
    },
  };
}

const harness = { mount };

export type CompileHarness = typeof harness;

declare global {
  interface Window {
    compileHarness: CompileHarness;
  }
}

window.compileHarness = harness;
