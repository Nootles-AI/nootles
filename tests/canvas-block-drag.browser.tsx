import { useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { Id } from "../convex/_generated/dataModel";
import { schema } from "../app/components/editor/schema";
import {
  BlockSideMenu,
  editorPortalElements,
} from "../app/components/editor/BlockSideMenu";
import {
  CanvasShellContext,
  type ActiveCanvas,
} from "../app/components/editor/canvas/shell";
import { CurrentPageProvider } from "../app/components/OpenPageContext";
import { WorkspaceHistoryProvider } from "../app/lib/history/useWorkspaceHistory";
import {
  createNmlYDoc,
  decodeNmlDocument,
  type NmlDocument,
} from "../app/lib/nml";
import { NmlLegacyMirror } from "../app/lib/nml/mirror";
import { blockNoteNmlMirrorHost } from "../app/lib/nml/mirrorBlockNote";
import {
  peekSceneStore,
  sceneStoreKey,
} from "../app/components/editor/canvas/engine/useScene";
import { hasCanvasState } from "../app/components/editor/canvas/collab/ymap";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";
import "../app/components/editor/canvas/canvas.css";

type Editor = typeof schema.BlockNoteEditor;
const PAGE = "page" as Id<"pages">;
const convex = new ConvexReactClient("https://canvas-drag-test.invalid", {
  skipConvexDeploymentUrlCheck: true,
});

let root: Root | undefined;
let editor: Editor;
let mirror: NmlLegacyMirror | undefined;
let ydoc: Y.Doc;

const source = (): NmlDocument => ({
  schemaVersion: 1,
  documentId: "canvas-block-drag",
  blocks: [
    {
      id: "heading",
      type: "heading",
      props: { level: 1 },
      content: [
        { type: "text", text: "Canvas drag regression", marks: [] },
      ],
      children: [],
    },
    {
      id: "canvas",
      type: "canvas",
      props: {},
      scene: {
        id: "canvas",
        w: 640,
        h: 360,
        style: {},
        attrs: {},
        nodes: [
          {
            id: "shape-a",
            kind: "rect",
            x: 40,
            y: 40,
            w: 160,
            h: 90,
            rot: 0,
            style: { background: "#f4c7c3" },
            label: "",
            locked: false,
            hidden: false,
            attrs: {},
          },
        ],
        edges: [],
      },
      children: [],
    },
    {
      id: "paragraph",
      type: "paragraph",
      props: {},
      content: [
        { type: "text", text: "Drop the canvas below this paragraph.", marks: [] },
      ],
      children: [],
    },
  ],
});

function Page() {
  const [active, setActive] = useState<ActiveCanvas | null>(null);
  const shell = useMemo(() => ({ active, set: setActive }), [active]);
  return (
    <CanvasShellContext value={shell}>
      <main style={{ height: "100vh", overflow: "auto" }}>
        {/* Matches Workspace's isolated document column. A test-created
            z-index 10 sibling can therefore prove that the escaped menu still
            paints above it, as NT-52 requires. */}
        <div
          id="document-column"
          style={{
            isolation: "isolate",
            position: "relative",
            zIndex: 1,
            width: 760,
            marginLeft: 220,
            padding: "48px 56px",
            boxSizing: "border-box",
          }}
        >
          <BlockNoteView
            editor={editor}
            theme="light"
            className="nt-editor"
            sideMenu={false}
            slashMenu={false}
            formattingToolbar={false}
            portalElements={editorPortalElements}
          >
            <BlockSideMenu />
          </BlockNoteView>
        </div>
      </main>
    </CanvasShellContext>
  );
}

function mount() {
  root?.unmount();
  mirror?.stop();
  ydoc = createNmlYDoc(source());
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
  mirror = new NmlLegacyMirror(
    ydoc,
    blockNoteNmlMirrorHost(editor, ydoc),
    {
      actor: { kind: "human", userId: "browser-test" },
      onError: (error) =>
        console.error("NML compatibility mirror failed", error),
    },
  ).start();
  root = createRoot(document.getElementById("app")!);
  root.render(
    <ConvexProvider client={convex}>
      <WorkspaceHistoryProvider projectId="canvas-block-drag">
        <CurrentPageProvider pageId={PAGE}>
          <Page />
        </CurrentPageProvider>
      </WorkspaceHistoryProvider>
    </ConvexProvider>,
  );
}

const block = (type: string) =>
  editor.document.find((item) => item.type === type);

function rectOf(type: string) {
  const item = block(type);
  const element =
    item &&
    document.querySelector<HTMLElement>(
      `.bn-editor [data-id="${CSS.escape(item.id)}"]`,
    );
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function handleRect() {
  const element = document.querySelector<HTMLElement>(
    'button[aria-label="Block actions"]',
  );
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function snapshot() {
  const canvasId = block("canvas")?.id;
  const store = canvasId ? peekSceneStore(sceneStoreKey(canvasId)) : null;
  return {
    ids: editor.document.map((item) => `${item.type}:${item.id}`),
    canonicalIds: decodeNmlDocument(ydoc).blocks.map(
      (item) => `${item.type}:${item.id}`,
    ),
    canvasMaps: [...ydoc.share.keys()]
      .filter((name) => name.startsWith("canvas:"))
      .map((name) => ({
        name,
        populated: hasCanvasState(ydoc.getMap(name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    sceneNodes: store
      ? store
          .getScene()
          .nodes.map((node) => `${node.id}@${node.x},${node.y}`)
      : null,
    alive: Boolean(document.querySelector(".nt-canvas-viewport")),
  };
}

const harness = {
  mount,
  async settle() {
    await mirror?.settle();
  },
  snapshot,
  rectOf,
  handleRect,
  portalState() {
    const handle = document.querySelector<HTMLElement>(
      'button[aria-label="Block actions"]',
    );
    const portal = editor.portalElement;
    return {
      portalParent: portal.parentElement?.tagName ?? null,
      portalClasses: [...portal.classList],
      colorScheme: portal.getAttribute("data-color-scheme"),
      mantineColorScheme: portal.getAttribute("data-mantine-color-scheme"),
      handleInEditorPortal: Boolean(handle && portal.contains(handle)),
      handleWithinEditor: Boolean(handle && editor.isWithinEditor(handle)),
    };
  },
  installStackingObstacle() {
    const rect = handleRect();
    if (!rect) return null;
    const obstacle = document.createElement("div");
    obstacle.id = "stacking-obstacle";
    Object.assign(obstacle.style, {
      position: "fixed",
      zIndex: "10",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      background: "rgb(255, 0, 0)",
    });
    document.body.appendChild(obstacle);
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return hit?.closest("button")?.getAttribute("aria-label") ?? hit?.id ?? null;
  },
  removeStackingObstacle() {
    document.getElementById("stacking-obstacle")?.remove();
  },
  /**
   * The dropdown's surface beside the one the app asks for. The expected side
   * is resolved by the browser from the menu's own inherited custom
   * properties rather than written out here, so the comparison survives
   * whatever notation the engine serializes a colour in — and a token the app
   * stops declaring fails as transparent on both sides, which is why the
   * runner checks that too.
   */
  menuTheme() {
    const menu = document.querySelector<HTMLElement>(".bn-drag-handle-menu");
    if (!menu) return null;
    const probe = document.createElement("div");
    probe.style.cssText =
      "background-color:var(--elevated);color:var(--foreground);border-color:var(--border)";
    menu.append(probe);
    const style = getComputedStyle(menu);
    const app = getComputedStyle(probe);
    const theme = {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      color: style.color,
      app: {
        backgroundColor: app.backgroundColor,
        borderColor: app.borderColor,
        color: app.color,
      },
    };
    probe.remove();
    return theme;
  },
};

declare global {
  interface Window {
    canvasBlockDrag: typeof harness;
  }
}

window.canvasBlockDrag = harness;
mount();
