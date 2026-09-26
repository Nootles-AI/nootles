import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { Id } from "../convex/_generated/dataModel";
import { CurrentPageProvider, OpenPageProvider } from "../app/components/OpenPageContext";
import { CanvasSurface, type CanvasApi } from "../app/components/editor/canvas/render/CanvasSurface";
import { PageToolbar } from "../app/components/editor/canvas/Toolbar";
import { createPageTools, type PageToolControl } from "../app/components/editor/canvas/page/tools";
import { walk } from "../app/components/editor/canvas/scene/types";

const PAGE = "page" as Id<"pages">;

// One box whose whole label is a page chip — the label a solo chip's "Edit text" opens.
const DIAGRAM = `<nt-diagram w="640" h="360">
  <nt-rect id="a" x="24" y="24" w="200" h="80" style="background: #eee"><nt-ref page="other">Launch plan</nt-ref></nt-rect>
</nt-diagram>`;

const convex = new ConvexReactClient("https://canvas-toolbar-tool.invalid", {
  skipConvexDeploymentUrlCheck: true,
});

let root: Root | undefined;
let api: CanvasApi | null = null;
let tools: PageToolControl = createPageTools();

/**
 * The workspace's half, as `Workspace` does it: one page tool, handed to the
 * diagram and to the page's bar. The one diagram here stands for the focused
 * one, so the bar offers Text and shows the bare letters.
 */
function Shell() {
  const [source, setSource] = useState(DIAGRAM);
  const [live, setLive] = useState<CanvasApi | null>(null);
  return (
    <>
      <main style={{ width: 720, margin: "80px auto 0" }}>
        <CanvasSurface
          source={source}
          onChange={setSource}
          tools={tools}
          onApi={(next) => {
            api = next;
            setLive(next);
          }}
        />
      </main>
      {live && <PageToolbar tools={tools} focused pane="main" refocus={live.focus} />}
    </>
  );
}

function mount() {
  root?.unmount();
  api = null;
  tools = createPageTools();
  root = createRoot(document.getElementById("app")!);
  root.render(
    <ConvexProvider client={convex}>
      <OpenPageProvider>
        <CurrentPageProvider pageId={PAGE}>
          <Shell />
        </CurrentPageProvider>
      </OpenPageProvider>
    </ConvexProvider>,
  );
}

const centre = (el: Element | null | undefined) => {
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
};

const toolbarButtons = () => [...document.querySelectorAll<HTMLButtonElement>(".nt-toolbar .nt-toolbar-btn")];

const harness = {
  mount,
  ready: () => api !== null && document.querySelector(".nt-toolbar") !== null,
  /** What the toolbar shows as the active tool. */
  pressed: () => toolbarButtons().filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("aria-label")),
  /** Which tool wears the lock's dot, if any. */
  locked: () => toolbarButtons().filter((b) => b.hasAttribute("data-locked")).map((b) => b.getAttribute("aria-label")),
  /** What the surface is actually doing. */
  surfaceTool: () => document.querySelector<HTMLElement>(".nt-canvas-viewport")?.dataset.tool ?? null,
  labels: () => toolbarButtons().map((b) => b.getAttribute("aria-label")),
  button: (label: string) => centre(toolbarButtons().find((b) => b.getAttribute("aria-label") === label)),
  shapes: () => {
    const out: string[] = [];
    if (api) walk(api.store.getScene().nodes, (node) => void out.push(`${node.id}:${node.kind}`));
    return out;
  },
  selected: () => (api ? [...api.selection.getSnapshot().ids] : []),
  /** Vector edit mode: the pen's overlay is up over the viewport. */
  pointsOpen: () => document.querySelector(".nt-canvas-viewport > svg[style*='touch-action']") !== null,
  editingLabel: () => document.querySelector(".nt-canvas-scene [contenteditable='true'], .nt-canvas-scene textarea") !== null,
  canvasFocused: () => document.activeElement === document.querySelector(".nt-canvas-viewport"),
  /** For a failed focus check: what the press landed on, and what holds focus instead. */
  describe: (x: number, y: number) => {
    const name = (el: Element | null) => (el ? `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}` : "none");
    return `pressed ${name(document.elementFromPoint(x, y))}; focus on ${name(document.activeElement)}`;
  },
  /** A viewport point on the canvas, as a fraction of its box. */
  canvasPoint: (fx: number, fy: number) => {
    const rect = document.querySelector(".nt-canvas-viewport")!.getBoundingClientRect();
    return { x: rect.left + rect.width * fx, y: rect.top + rect.height * fy };
  },
  chip: () => centre(document.querySelector(".nt-canvas-scene .nt-ref")),
  menuItem: (text: string) => centre([...document.querySelectorAll("[role='menuitem']")].find((el) => el.textContent?.trim() === text)),
};

declare global {
  interface Window {
    toolbarHarness: typeof harness;
  }
}
window.toolbarHarness = harness;
