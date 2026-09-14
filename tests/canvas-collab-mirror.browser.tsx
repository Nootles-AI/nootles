import { useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { Id } from "../convex/_generated/dataModel";
import { schema } from "../app/components/editor/schema";
import { completionExtension } from "../app/components/editor/ai/completionExtension";
import { hintExtension } from "../app/components/editor/ai/hintText";
import { reviewExtension } from "../app/components/editor/ai/reviewExtension";
import { arrivalFlashExtension } from "../app/components/editor/arrivalFlash";
import { blockSelectionExtension } from "../app/components/editor/blockSelection";
import { CanvasCollab } from "../app/components/editor/canvas/collab/binding";
import { canvasMapName, hasCanvasState, materializeCanvas } from "../app/components/editor/canvas/collab/ymap";
import { peekSceneStore } from "../app/components/editor/canvas/engine/useScene";
import { migrateLegacyCanvas } from "../app/components/editor/canvas/scene/migrate";
import { walk, type Scene } from "../app/components/editor/canvas/scene/types";
import { CanvasShellContext, type ActiveCanvas } from "../app/components/editor/canvas/shell";
import { CurrentPageProvider } from "../app/components/OpenPageContext";
import { useTextUndoDomain, type UndoHostEditor } from "../app/lib/history/textDomain";
import { undoScope, useWorkspaceHistory, WorkspaceHistoryProvider } from "../app/lib/history/useWorkspaceHistory";
import { createRemoteCarets } from "../app/lib/sync/remoteCarets";
import { remoteScrollExtension } from "../app/lib/sync/remoteScroll";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";
// The workspace loads it with the canvas toolbar, which this page has no room for.
import "../app/components/editor/canvas/canvas.css";

// The production list, from `Editor.tsx`.
const EXTENSIONS = [completionExtension, reviewExtension, hintExtension, arrivalFlashExtension, blockSelectionExtension];

type Editor = typeof schema.BlockNoteEditor;

const PAGE = "page" as Id<"pages">;
const RELAY = { relay: true };
/** YConvexProvider's trailing throttle. */
const FLUSH_MS = 500;

const DIAGRAM = `<nt-diagram w="640" h="360">
  <nt-rect id="a" x="40" y="40" w="160" h="90" style="background: #f4c7c3"></nt-rect>
  <nt-rect id="b" x="360" y="40" w="160" h="90" style="background: #c3d7f4"></nt-rect>
</nt-diagram>`;

const BLOCKS = [
  { type: "heading", props: { level: 1 }, content: "Launch plan" },
  { type: "canvas", props: { data: DIAGRAM } },
  { type: "paragraph", content: "" },
];

let root: Root | undefined;
let editor: Editor;
let doc: Y.Doc | null = null;
const pending: Uint8Array[] = [];

// What a canvas block's own hooks read through (profile hints). The socket is
// inert in the runner, so every query simply stays loading.
const convexReact = new ConvexReactClient("https://collab-mirror-test.invalid", { skipConvexDeploymentUrlCheck: true });

/** Every binding this tab created, so a check can read how much its echo window holds. */
const bindings: CanvasCollab[] = [];
{
  const proto = CanvasCollab.prototype as unknown as { attach: (...args: unknown[]) => void };
  const attach = proto.attach;
  proto.attach = function (this: CanvasCollab, ...args: unknown[]) {
    if (!bindings.includes(this)) bindings.push(this);
    return attach.apply(this, args);
  };
}

const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/**
 * YConvexProvider's outbound half, timing and all: the first edit after quiet
 * leaves when the task ends, a burst after it rides a 500ms trailing throttle,
 * and whatever queued goes as one merged update. The page script adds the
 * network between the two tabs.
 */
function wire(target: Y.Doc) {
  let queue: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt = 0;
  const flush = () => {
    if (!queue.length) return;
    const merged = Y.mergeUpdates(queue);
    queue = [];
    lastFlushAt = Date.now();
    void (window as unknown as { relayOut: (update: string) => Promise<void> }).relayOut(toBase64(merged));
  };
  target.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === RELAY) return;
    queue.push(update);
    if (!timer && Date.now() - lastFlushAt > FLUSH_MS) {
      queueMicrotask(flush);
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, FLUSH_MS);
  });
}

/** The workspace's half of the canvas shell: one claimed diagram, let go by a press anywhere else. */
function Page({ editor }: { editor: Editor }) {
  const spine = useWorkspaceHistory();
  useTextUndoDomain(spine, editor as unknown as UndoHostEditor, "doc", PAGE);
  const [canvas, setCanvas] = useState<ActiveCanvas | null>(null);
  const shell = useMemo(() => ({ active: canvas, set: setCanvas }), [canvas]);
  const editing = canvas !== null;
  useEffect(() => {
    if (!editing) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".nt-canvas-viewport")) setCanvas(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [editing]);
  return (
    <CanvasShellContext value={shell}>
      <main style={{ height: "100vh", overflow: "auto" }}>
        <div {...undoScope} style={{ maxWidth: 760, padding: "48px 56px", boxSizing: "border-box" }}>
          <BlockNoteView editor={editor} theme="light" className="nt-editor" sideMenu={false} slashMenu={false} formattingToolbar={false} />
        </div>
      </main>
    </CanvasShellContext>
  );
}

/** The composition from `useYjsEditor.ts`, over a doc that is already synced. */
function start(initial?: string) {
  doc = new Y.Doc();
  if (initial) Y.applyUpdate(doc, fromBase64(initial), RELAY);
  for (const update of pending.splice(0)) Y.applyUpdate(doc, update, RELAY);
  wire(doc);
  const awareness = new Awareness(doc);
  const carets = createRemoteCarets(awareness);
  editor = BlockNoteEditor.create(
    withCollaboration({
      schema,
      extensions: [...EXTENSIONS, remoteScrollExtension],
      collaboration: {
        fragment: doc.getXmlFragment("prosemirror"),
        user: { name: "Someone", color: "#3366cc" },
        provider: { awareness },
        showCursorLabels: "always",
        renderCursor: carets.render,
      },
    } as never),
  ) as unknown as Editor;
  root = createRoot(document.getElementById("app")!);
  root.render(
    <ConvexProvider client={convexReact}>
      <WorkspaceHistoryProvider projectId="project">
        <CurrentPageProvider pageId={PAGE}>
          <Page editor={editor} />
        </CurrentPageProvider>
      </WorkspaceHistoryProvider>
    </ConvexProvider>,
  );
  carets.attach();
}

const until = async (ready: () => boolean) => {
  const deadline = performance.now() + 10_000;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error("fixture never became ready");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const canvasBlock = () => editor.document.find((block) => block.type === "canvas");

/** Viewport centre of a shape drawn on the diagram's surface. */
function shapePoint(id: string) {
  const el = [...document.querySelectorAll(`.nt-editor [data-id="${CSS.escape(id)}"]`)].find((node) => node.getBoundingClientRect().width > 0);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** A scene's shapes as `id@x,y`, sorted. */
function shapes(scene: Scene | null) {
  const out: string[] = [];
  if (scene) walk(scene.nodes, (node) => void out.push(`${node.id}@${Math.round(node.x)},${Math.round(node.y)}`));
  return out.sort();
}

/**
 * Where each shape is on screen, in the diagram's own units: measured off the
 * element against the scene layer it is placed in, so the viewport's pan and
 * zoom — which differ between two people's windows — drop out.
 */
function drawn() {
  const block = canvasBlock();
  const store = block ? peekSceneStore(`canvas:${block.id}`) : null;
  if (!store) return [];
  const out: string[] = [];
  walk(store.getScene().nodes, (node) => {
    const el = [...document.querySelectorAll(`.nt-editor [data-id="${CSS.escape(node.id)}"]`)].find((n) => n.getBoundingClientRect().width > 0) as HTMLElement | undefined;
    const layer = el?.closest(".nt-canvas-scene");
    if (!el || !layer) return void out.push(`${node.id}@unseen`);
    const box = el.getBoundingClientRect();
    const frame = layer.getBoundingClientRect();
    const scale = box.width / node.w;
    out.push(`${node.id}@${Math.round((box.left - frame.left) / scale)},${Math.round((box.top - frame.top) / scale)}`);
  });
  return out.sort();
}

/**
 * The binding's lifecycle calls, and whether it was still attached for each:
 * which of a block's cleanups ran first when its view went away.
 */
const calls: string[] = [];
{
  const proto = CanvasCollab.prototype as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>;
  for (const name of ["detach", "stampMirror"]) {
    const original = proto[name];
    if (!original) continue;
    proto[name] = function (this: CanvasCollab, ...args: unknown[]) {
      calls.push(this.attached ? name : `${name} (detached)`);
      return original.apply(this, args);
    };
  }
}

const harness = {
  calls: () => calls.splice(0),
  /**
   * The diagram dragged below the paragraph after it: its block leaves the
   * document and comes back, the way a block reorder moves one — so its view
   * unmounts while the editor stays.
   */
  moveDiagram() {
    const block = canvasBlock()!;
    const last = editor.document[editor.document.length - 1];
    editor.transact(() => {
      editor.removeBlocks([block.id]);
      editor.insertBlocks([block as never], last.id, "after");
    });
  },
  /** The first person: a fresh page with the diagram on it, handed over as the doc's whole state. */
  async create() {
    start();
    await until(() => document.querySelector(".bn-editor") !== null);
    editor.transact((tr) => {
      tr.setMeta("addToHistory", false);
      editor.replaceBlocks(editor.document, BLOCKS as never);
    });
    await until(() => {
      const block = canvasBlock();
      return !!block && !!doc && hasCanvasState(doc.getMap<unknown>(canvasMapName(block.id))) && shapePoint("a") !== null;
    });
    return toBase64(Y.encodeStateAsUpdate(doc!));
  },
  /** The second person, opening the page once it has synced — the provider's gate. */
  join(state: string) {
    start(state);
  },
  receive(update: string) {
    const bytes = fromBase64(update);
    if (doc) Y.applyUpdate(doc, bytes, RELAY);
    else pending.push(bytes);
  },
  shapePoint,
  read() {
    const block = canvasBlock()!;
    const data = (block.props as { data: string }).data;
    const rootMap = doc!.getMap<unknown>(canvasMapName(block.id));
    const store = peekSceneStore(`canvas:${block.id}`);
    const binding = bindings[bindings.length - 1] as unknown as { recent?: unknown[] } | undefined;
    // binding.ts's mark for a mirror, recomputed here: its length and FNV-1a.
    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) {
      hash ^= data.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return {
      maps: hasCanvasState(rootMap) ? shapes(materializeCanvas(rootMap)) : [],
      shown: store ? shapes(store.getScene()) : [],
      drawn: drawn(),
      prop: shapes(migrateLegacyCanvas(data)),
      /** Whether the maps carry the stamp of this very prop. */
      stamped: rootMap.get("mirror") === `${data.length}:${(hash >>> 0).toString(36)}`,
      window: binding?.recent?.length ?? null,
    };
  },
  /**
   * A whole diagram written onto the block with no maps behind it — what any
   * writer that does not know about the maps leaves: a third shape.
   */
  outsideWrite() {
    const block = canvasBlock()!;
    const data = (block.props as { data: string }).data;
    const next = data.replace("</nt-diagram>", `  <nt-rect id="c" x="220" y="220" w="120" h="80" style="background: #cfe8c9"></nt-rect>\n</nt-diagram>`);
    const group = doc!.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
    const container = group.toArray().find((el) => (el as Y.XmlElement).getAttribute("id") === block.id) as Y.XmlElement;
    doc!.transact(() => (container.get(0) as Y.XmlElement).setAttribute("data", next), "outside");
  },
};

(window as unknown as { collab: typeof harness }).collab = harness;
