// A diagram made, taken away and another made where it was, as the slash menu
// makes them: the page's own Y.Doc, the canvas block's CRDT binding, the warm
// scene stores and the history spine. The runner (`canvas-rebirth.browser.mjs`)
// checks the new diagram starts empty and the old one comes back whole, and
// that a new one offers its presets until it is started.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { Id } from "../convex/_generated/dataModel";
import { schema } from "../app/components/editor/schema";
import { blockSelectionExtension } from "../app/components/editor/blockSelection";
import { CurrentPageProvider } from "../app/components/OpenPageContext";
import { undoScope, useWorkspaceHistory, WorkspaceHistoryProvider } from "../app/lib/history/useWorkspaceHistory";
import type { WorkspaceHistory } from "../app/lib/history/spine";
import { useTextUndoDomain, type UndoHostEditor } from "../app/lib/history/textDomain";
import { textStepsExtension } from "../app/lib/history/textSteps";
import {
  createPageCanvasHub,
  PageCanvasContext,
  PageCanvasHubContext,
  usePaneCanvas,
  type PageCanvas,
} from "../app/components/editor/canvas/page/PageCanvas";
import { bearFromSlash, type BirthEditor } from "../app/components/editor/canvas/page/birth";
import { presetsOffered } from "../app/components/editor/canvas/page/presetOffer";
import { deleteDiagramBlock, type LifecycleEditor } from "../app/components/editor/canvas/page/lifecycle";
import { WIDE_DIAGRAM_SOURCE } from "../app/components/editor/canvas/scene/bandSpan";
import { walk, type SceneNode } from "../app/components/editor/canvas/scene/types";
import { PagePane } from "../app/components/PagePane";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";
import "../app/components/editor/canvas/canvas.css";

type Editor = typeof schema.BlockNoteEditor;
const PAGE = "page" as Id<"pages">;
const convex = new ConvexReactClient("https://canvas-rebirth-test.invalid", { skipConvexDeploymentUrlCheck: true });

let editor: Editor;
let page: PageCanvas | null = null;
let spine: WorkspaceHistory | null = null;

function Page() {
  const history = useWorkspaceHistory();
  useTextUndoDomain(history, editor as unknown as UndoHostEditor, "canvas-rebirth", PAGE);
  useEffect(() => {
    spine = history;
  }, [history]);
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

function Pane() {
  const canvas = usePaneCanvas("main", PAGE);
  useEffect(() => {
    page = canvas;
  }, [canvas]);
  useEffect(() => canvas.setEditor(editor as never), [canvas]);
  return (
    <PageCanvasContext value={canvas}>
      <div id="stage" style={{ height: "100vh", display: "flex" }}>
        <PagePane pane="main" pageId={PAGE}>
          <div {...undoScope}>
            <BlockNoteView editor={editor} theme="light" className="nt-editor" sideMenu={false} slashMenu={false} formattingToolbar={false} />
          </div>
        </PagePane>
      </div>
    </PageCanvasContext>
  );
}

function mount() {
  const ydoc = new Y.Doc();
  editor = BlockNoteEditor.create(
    withCollaboration({
      schema,
      extensions: [blockSelectionExtension, textStepsExtension],
      collaboration: {
        fragment: ydoc.getXmlFragment("prosemirror"),
        user: { name: "Local", color: "#3366cc" },
        provider: { awareness: new Awareness(ydoc) },
      },
    } as never),
  ) as unknown as Editor;
  createRoot(document.getElementById("app")!).render(
    <ConvexProvider client={convex}>
      <WorkspaceHistoryProvider projectId="canvas-rebirth">
        <CurrentPageProvider pageId={PAGE}>
          <Page />
        </CurrentPageProvider>
      </WorkspaceHistoryProvider>
    </ConvexProvider>,
  );
}

const entry = (blockId: string) => page?.get(blockId) ?? null;

const harness = {
  ready: () => !!page && !!spine && editor.document.length > 0,
  /** Sets the page to an intro line and an empty line; their ids. */
  seed: () => {
    const { insertedBlocks: [intro, line] } = editor.replaceBlocks(editor.document, [
      { type: "paragraph", content: "A diagram goes below." },
      { type: "paragraph" },
    ]);
    return [intro.id, line.id];
  },
  /** A diagram of this kind at the caret's line, as the slash menu makes one; its id. */
  slash: (kind: "diagram" | "wide", lineId: string) =>
    bearFromSlash(editor as unknown as BirthEditor, lineId, kind === "wide" ? WIDE_DIAGRAM_SOURCE : ""),
  /** A new empty line after a block; its id. */
  addLine: (after: string) => editor.insertBlocks([{ type: "paragraph" }], after, "after")[0].id,
  /** A diagram taken out as its last shape going takes it. */
  remove: (blockId: string) => deleteDiagramBlock(editor as unknown as LifecycleEditor, blockId),
  mounted: (blockId: string) => !!entry(blockId),
  put: (blockId: string, id: string) =>
    entry(blockId)?.api.store.dispatch({
      type: "insert",
      nodes: [
        {
          id,
          kind: "rect",
          x: 40,
          y: 30,
          w: 120,
          h: 70,
          rot: 0,
          style: {},
          label: "",
          locked: false,
          hidden: false,
          attrs: {},
        } as SceneNode,
      ],
    }),
  /** What a diagram's store holds: wide or not, and its shapes' ids. */
  scene: (blockId: string) => {
    const scene = entry(blockId)?.api.store.getScene();
    return scene ? { wide: scene.wide ?? false, nodes: scene.nodes.map((node) => node.id) } : null;
  },
  /** Each shape's kind and label, in order. */
  shapes: (blockId: string) =>
    entry(blockId)?.api.store.getScene().nodes.map((node) => ({ kind: node.kind, label: node.label })) ?? null,
  selected: (blockId: string) => entry(blockId)?.api.ownSelection.getSnapshot().ids.length ?? 0,
  /** What is selected, by name, and the names of the groups entered to reach it. */
  selection: (blockId: string) => {
    const api = entry(blockId)?.api;
    if (!api) return null;
    const { ids, enteredPath } = api.ownSelection.getSnapshot();
    const name = (id: string) => {
      let found: string | undefined;
      walk(api.store.getScene().nodes, (node) => void (node.id === id && (found = node.name ?? node.kind)));
      return found;
    };
    return { ids: ids.map(name), entered: enteredPath.map(name) };
  },
  clear: (blockId: string) => entry(blockId)?.api.ownSelection.clear(),
  /** The id a named shape landed under, at any depth. */
  named: (blockId: string, name: string) => {
    let found: string | null = null;
    const scene = entry(blockId)?.api.store.getScene();
    if (scene) walk(scene.nodes, (node) => void (node.name === name && !found && (found = node.id)));
    return found;
  },
  /** Whether the block still offers presets, drawn or not. */
  offered: (blockId: string) => presetsOffered(blockId),
  setTool: (tool: "move" | "rect") => page?.tools?.set(tool),
  blocks: () => editor.document.map((block) => block.type),
  ids: () => editor.document.map((block) => block.id),
  undo: () => spine?.undo(),
  redo: () => spine?.redo(),
};

declare global {
  interface Window {
    canvasRebirth: typeof harness;
  }
}

window.canvasRebirth = harness;
mount();
