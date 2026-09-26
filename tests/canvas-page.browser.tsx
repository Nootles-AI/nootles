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
import { blockSelection, blockSelectionExtension } from "../app/components/editor/blockSelection";
import { blockKeysExtension } from "../app/components/editor/blockKeys";
import { pasteHandler } from "../app/components/editor/paste";
import { CurrentPageProvider } from "../app/components/OpenPageContext";
import {
  undoScope,
  useWorkspaceHistory,
  WorkspaceHistoryProvider,
} from "../app/lib/history/useWorkspaceHistory";
import type { WorkspaceHistory } from "../app/lib/history/spine";
import { useTextUndoDomain, type UndoHostEditor } from "../app/lib/history/textDomain";
import { textStepsExtension } from "../app/lib/history/textSteps";
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
let ydoc: ReturnType<typeof createNmlYDoc>;
let mirror: NmlLegacyMirror;
let page: PageCanvas | null = null;
let spine: WorkspaceHistory | null = null;

function Page() {
  const history = useWorkspaceHistory();
  useTextUndoDomain(history, editor as unknown as UndoHostEditor, "canvas-page", PAGE);
  useEffect(() => {
    spine = history;
  }, [history]);
  // The page on screen, as the workspace tells the spine: a step whose domain
  // is not mounted waits for it here, where without a navigator it would be
  // given up on at once.
  useEffect(() => {
    if (!history) return;
    history.setNavigator({ currentPage: () => PAGE, openPage: () => {} });
    return () => history.setNavigator(null);
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
  // What a draw on the page makes its diagrams in, as the app's editor says.
  useEffect(() => canvas.setEditor(editor as never), [canvas]);
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
  ydoc = createNmlYDoc(source());
  editor = BlockNoteEditor.create(
    withCollaboration({
      schema,
      // The document's own block keys and its paste, as the app's editor has them.
      extensions: [blockSelectionExtension, blockKeysExtension, textStepsExtension],
      pasteHandler,
      collaboration: {
        fragment: ydoc.getXmlFragment("prosemirror"),
        user: { name: "Local", color: "#3366cc" },
        provider: { awareness: new Awareness(ydoc) },
      },
    } as never),
  ) as unknown as Editor;
  // The canonical document is the NML maps; the mirror is what renders them
  // into the editor's fragment, as it does in the app.
  mirror = new NmlLegacyMirror(ydoc, blockNoteNmlMirrorHost(editor, ydoc), {
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
  /** The diagram the panels speak for, shapes held or not. */
  active: () => page?.selection.getSnapshot().active ?? null,
  /** Whether a band shows its edge and grid. */
  holding: (blockId: string) => bandOf(blockId)?.hasAttribute("data-holding") ?? false,
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
  /** The page's tool, and whether it is locked. */
  tool: () => page?.tools?.snapshot() ?? null,
  /** Shapes in a diagram. */
  count: (blockId: string) => entry(blockId)?.api.store.getScene().nodes.length ?? null,
  canUndo: (blockId: string) => entry(blockId)?.api.store.canUndo() ?? null,
  /** The blocks on the page, by id and type. */
  blocks: () => editor.document.map((block) => `${block.id}:${block.type}`),
  /** The blocks the shared doc holds, in order — what the view must agree with. */
  docBlocks: () =>
    [...ydoc.getXmlFragment("prosemirror").toString().matchAll(/<blockcontainer[^>]*?\bid="([^"]+)"/gi)].map(
      (match) => match[1],
    ),
  /** The blocks the view shows. */
  viewBlocks: () => editor.document.map((block) => block.id),
  /** The blocks selected as blocks. */
  blockSelection: () => [...blockSelection(editor).getSnapshot().ids],
  /** Where the keyboard is: a band, the page's text, or somewhere else. */
  keyboard: () => {
    const active = document.activeElement;
    if (!active) return null;
    for (const diagram of page?.entries() ?? []) {
      if (diagram.api.band.current?.contains(active)) return `band:${diagram.blockId}`;
    }
    return active.classList.contains("ProseMirror") ? "text" : active.tagName.toLowerCase();
  },
  /** A paragraph's words. */
  text: (blockId: string) => {
    const block = editor.getBlock(blockId);
    const content = (block?.content ?? []) as { text?: string }[];
    return content.map((part) => part.text ?? "").join("");
  },
  /** The caret at the end of a paragraph, the editor focused. */
  caretAtEnd: (blockId: string) => {
    editor.focus();
    editor.setTextCursorPosition(blockId, "end");
  },
  /** What the page's marquee draws, if anything. */
  marqueeShown: () => {
    return [...document.querySelectorAll<SVGElement>(".nt-ov-band")].some(
      (rect) => rect.style.display !== "none" && rect.getBoundingClientRect().width > 0,
    );
  },
  /** A copy as the browser raises one; what it put on the clipboard. */
  copy: () => {
    const data = new DataTransfer();
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
    return data.getData("text/plain");
  },
  /** A paste as the browser raises one, with this text on the clipboard. */
  paste: (text: string) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  },
  /** The diagram blocks on the page, in order. */
  diagrams: () => (page?.entries() ?? []).map((diagram) => diagram.blockId),
  undo: () => spine?.undo(),
  /** Entries on the page's text history. */
  textSteps: () =>
    (window as unknown as { __ntTextUndo?: { undoStack: unknown[] } }).__ntTextUndo?.undoStack.length ?? null,
  redo: () => spine?.redo(),
  /**
   * The page as a document not served from NML — the app's default — whose
   * text steps undo. While the mirror runs, every change it takes in is
   * written back over the editor's fragment, and the text's undo has nothing
   * of its own left to restore.
   */
  unserve: () => mirror.stop(),
  clear: () => page?.selection.clearAll(),
  /** Adds shapes of a diagram to the page's selection, as a Shift-click would. */
  add: (blockId: string, ids: string[]) => page?.selection.selectIn(blockId, ids, { keep: true }),
  /** Picks the page's tool, as the bar does. */
  pick: (tool: string) => page?.tools?.set(tool as never),
  /** Nests a block under the one before it, as Tab would; whether it could. */
  nest: (blockId: string) => {
    editor.setTextCursorPosition(blockId);
    if (!editor.canNestBlock()) return "false";
    editor.nestBlock();
    return "true";
  },
  /** A block's box on screen, whatever it holds. */
  block: (blockId: string) => box(document.querySelector(`.bn-block-outer[data-id="${CSS.escape(blockId)}"]`)),
  /** A new empty line after a block; its id. */
  addLine: (after: string) => editor.insertBlocks([{ type: "paragraph" }], after, "after")[0].id,
  /** Takes a block out, as a person deleting it would. */
  removeBlock: (blockId: string) => editor.removeBlocks([blockId]),
  /** The seam's Merge offer under a diagram, and its ×, while it shows. */
  seam: (blockId: string) => {
    const seam = bandOf(blockId)?.parentElement?.querySelector(".nt-canvas-merge");
    if (!seam || getComputedStyle(seam).display === "none") return null;
    return {
      merge: box(seam.querySelector(".nt-canvas-merge-go")),
      dismiss: box(seam.querySelector(".nt-canvas-merge-no")),
    };
  },
  /** Every shape's id and place in a diagram. */
  nodes: (blockId: string) =>
    (entry(blockId)?.api.store.getScene().nodes ?? []).map((node) => ({ id: node.id, x: node.x, y: node.y })),
  /** Where a new diagram would go, as the page shows it while a tool is armed. */
  insertLine: () => box(document.querySelector(".nt-page-insert")),
  /** Which band is outlined as a draw's target. */
  target: () => (page?.entries() ?? []).find((diagram) => diagram.api.band.current?.hasAttribute("data-target"))?.blockId ?? null,
};

declare global {
  interface Window {
    canvasPage: typeof harness;
  }
}

window.canvasPage = harness;
mount();
