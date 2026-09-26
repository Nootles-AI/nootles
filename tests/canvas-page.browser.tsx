// Two diagrams on one page, as the workspace holds them: one hub, one pane
// controller, the history spine. The runner (`canvas-page.browser.mjs`) drives
// a selection across both with a real pointer and checks it moves, marquees
// and undoes as the page's, not as either diagram's.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Awareness } from "y-protocols/awareness";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { Id } from "../convex/_generated/dataModel";
import { schema } from "../app/components/editor/schema";
import { CurrentPageProvider } from "../app/components/OpenPageContext";
import {
  undoScope,
  useWorkspaceHistory,
  WorkspaceHistoryProvider,
} from "../app/lib/history/useWorkspaceHistory";
import type { WorkspaceHistory } from "../app/lib/history/spine";
import { createNmlYDoc, type NmlDocument } from "../app/lib/nml";
import { NmlLegacyMirror } from "../app/lib/nml/mirror";
import { blockNoteNmlMirrorHost } from "../app/lib/nml/mirrorBlockNote";
import {
  createPageCanvasHub,
  PageCanvasContext,
  PageCanvasHubContext,
  usePaneCanvas,
  type PageCanvas,
} from "../app/components/editor/canvas/page/PageCanvas";
import { findNode, type SceneNode } from "../app/components/editor/canvas/scene/types";
import { ZoomToolbar } from "../app/components/editor/canvas/Toolbar";
import { PagePane } from "../app/components/PagePane";
import { useZoomKeys } from "../app/components/useDocumentZoom";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";
import "../app/components/editor/canvas/canvas.css";

type Editor = typeof schema.BlockNoteEditor;
const PAGE = "page" as Id<"pages">;
const convex = new ConvexReactClient("https://canvas-page-test.invalid", {
  skipConvexDeploymentUrlCheck: true,
});

const rect = (id: string, x: number, y: number, background: string): SceneNode =>
  ({
    id,
    kind: "rect",
    x,
    y,
    w: 120,
    h: 70,
    rot: 0,
    style: { background },
    label: "",
    locked: false,
    hidden: false,
    attrs: {},
  }) as SceneNode;

const text = (id: string, words: string) => ({
  id,
  type: "paragraph",
  props: {},
  content: [{ type: "text", text: words, marks: [] }],
  children: [],
});

const diagram = (id: string, nodes: SceneNode[]) => ({
  id,
  type: "canvas",
  props: {},
  scene: { id, w: 0, h: 180, style: {}, attrs: {}, nodes, edges: [] },
  children: [],
});

const source = (): NmlDocument =>
  ({
    schemaVersion: 1,
    documentId: "canvas-page",
    blocks: [
      text("intro", "Two diagrams, one page."),
      diagram("top", [rect("a1", 80, 40, "#f4c7c3"), rect("a2", 420, 40, "#f4ecc3")]),
      text("between", "A paragraph between them."),
      diagram("bottom", [rect("b1", 300, 40, "#c3d7f4")]),
      text("outro", ""),
    ],
  }) as unknown as NmlDocument;

let editor: Editor;
let page: PageCanvas | null = null;
let spine: WorkspaceHistory | null = null;

function Page() {
  const history = useWorkspaceHistory();
  useEffect(() => {
    spine = history;
  }, [history]);
  const [hub] = useState(() =>
    createPageCanvasHub(history ? { batch: history.batch, quiet: history.walking } : { batch: (fn) => fn() }),
  );
  return (
    <PageCanvasHubContext value={hub}>
      <Pane />
    </PageCanvasHubContext>
  );
}

// The page in the pane the workspace gives it — scroller, zoomed sheet,
// column — with the zoom keys and the reader's zoom bar.
function Pane() {
  const canvas = usePaneCanvas("main", PAGE);
  useEffect(() => {
    page = canvas;
  }, [canvas]);
  useZoomKeys(() => "main");
  return (
    <PageCanvasContext value={canvas}>
      <div id="stage" style={{ height: "100vh", display: "flex" }}>
        <PagePane pane="main" pageId={PAGE}>
          <div {...undoScope}>
            <BlockNoteView editor={editor} theme="light" className="nt-editor" sideMenu={false} slashMenu={false} formattingToolbar={false} />
          </div>
        </PagePane>
      </div>
      <ZoomToolbar pane="main" />
    </PageCanvasContext>
  );
}

function mount() {
  const ydoc = createNmlYDoc(source());
  editor = BlockNoteEditor.create(
    withCollaboration({
      schema,
      collaboration: {
        fragment: ydoc.getXmlFragment("prosemirror"),
        user: { name: "Local", color: "#3366cc" },
        provider: { awareness: new Awareness(ydoc) },
      },
    } as never),
  ) as unknown as Editor;
  // The canonical document is the NML maps; the mirror is what renders them
  // into the editor's fragment, as it does in the app.
  new NmlLegacyMirror(ydoc, blockNoteNmlMirrorHost(editor, ydoc), {
    actor: { kind: "human", userId: "browser-test" },
    onError: (error) => console.error("NML compatibility mirror failed", error),
  }).start();
  createRoot(document.getElementById("app")!).render(
    <ConvexProvider client={convex}>
      <WorkspaceHistoryProvider projectId="canvas-page">
        <CurrentPageProvider pageId={PAGE}>
          <Page />
        </CurrentPageProvider>
      </WorkspaceHistoryProvider>
    </ConvexProvider>,
  );
}

const entry = (blockId: string) => page?.get(blockId) ?? null;
const bandOf = (blockId: string) => entry(blockId)?.api.band.current ?? null;

function box(el: Element | null | undefined) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

const harness = {
  /** Both diagrams are up and on the page. */
  ready: () => (page?.entries().length ?? 0) === 2,
  /** A shape's drawn box on screen — looked up inside its own band, since ids repeat across diagrams. */
  shape: (blockId: string, id: string) =>
    box(bandOf(blockId)?.querySelector(`.nt-canvas-scene [data-id="${CSS.escape(id)}"]`)),
  band: (blockId: string) => box(bandOf(blockId)),
  model: (blockId: string, id: string) => {
    const scene = entry(blockId)?.api.store.getScene();
    const node = scene && findNode(scene, id);
    return node ? { x: node.x, y: node.y } : null;
  },
  height: (blockId: string) => entry(blockId)?.api.store.getScene().h ?? null,
  /** Which diagrams hold part of the selection, and what. */
  selection: () =>
    Object.fromEntries(
      [...(page?.selection.getSnapshot().parts ?? new Map())].map(([blockId, part]) => [blockId, [...part.ids]]),
    ),
  focused: () => page?.selection.getSnapshot().focused ?? null,
  /** Whether this band draws the selection frame. */
  framed: (blockId: string) => {
    const outline = bandOf(blockId)?.querySelector(".nt-ov-outline");
    const group = outline?.closest("g") as SVGGElement | null | undefined;
    return !!outline && group?.style.display !== "none" && outline.getBoundingClientRect().width > 0;
  },
  members: (blockId: string) => bandOf(blockId)?.querySelectorAll(".nt-ov-members > rect").length ?? 0,
  /** What the zoom bar reads. */
  zoomReadout: () => document.querySelector('[aria-label="Document zoom"] .nt-toolbar-zoom')?.textContent ?? null,
  /** Client px per band px: the page's zoom, as the band is drawn. */
  bandScale: (blockId: string) => {
    const band = bandOf(blockId);
    return band ? band.getBoundingClientRect().width / band.offsetWidth : null;
  },
  /** Brings a shape to the middle of the pane, which a zoom may have moved it out of. */
  reveal: (blockId: string, id: string) =>
    bandOf(blockId)
      ?.querySelector(`.nt-canvas-scene [data-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "center", inline: "center" }),
  /** A corner grip's width on screen — chrome holds its size at any zoom. */
  grip: (blockId: string) => {
    const grip = bandOf(blockId)?.querySelector(".nt-ov-corners > *");
    return grip ? Math.round(grip.getBoundingClientRect().width * 10) / 10 : null;
  },
  /** Narrows the pane, as a rail opening beside it would; null gives it the window back. */
  paneWidth: (px: number | null) => {
    document.getElementById("stage")!.style.width = px === null ? "" : `${px}px`;
  },
  apple: () => /mac|iphone|ipad|ipod/i.test(navigator.userAgent),
  undo: () => spine?.undo(),
  clear: () => page?.selection.clearAll(),
};

declare global {
  interface Window {
    canvasPage: typeof harness;
  }
}

window.canvasPage = harness;
mount();
