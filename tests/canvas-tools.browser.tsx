import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { Id } from "../convex/_generated/dataModel";
import { schema } from "../app/components/editor/schema";
import { completionExtension } from "../app/components/editor/ai/completionExtension";
import { hintExtension } from "../app/components/editor/ai/hintText";
import { reviewExtension } from "../app/components/editor/ai/reviewExtension";
import { ReviewOverlay } from "../app/components/editor/ai/ReviewOverlay";
import { arrivalFlashExtension } from "../app/components/editor/arrivalFlash";
import { canvasMapName, hasCanvasState, materializeCanvas } from "../app/components/editor/canvas/collab/ymap";
import { peekSceneStore, sceneStoreKey, type SceneStore } from "../app/components/editor/canvas/engine/useScene";
import { serializeScene } from "../app/components/editor/canvas/scene/serialize";
import { shapeIdsIn } from "./canvas-fixtures";
import { blockSelectionExtension } from "../app/components/editor/blockSelection";
import type { LiveEditor } from "../app/components/editor/EditorRegistry";
import { ReviewBar } from "../app/components/ReviewBar";
import { runClientTool, type ToolContext } from "../app/lib/ai/chat/clientTools";
import { ReviewSession } from "../app/lib/ai/review/session";
import {
  undoScope,
  useSpineState,
  useWorkspaceHistory,
  WorkspaceHistoryProvider,
} from "../app/lib/history/useWorkspaceHistory";
import { useCanvasUndoDomain } from "../app/lib/history/canvasDomain";
import { useTextUndoDomain, type UndoHostEditor } from "../app/lib/history/textDomain";
import { createRemoteCarets } from "../app/lib/sync/remoteCarets";
import { remoteScrollExtension } from "../app/lib/sync/remoteScroll";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

/**
 * `write_nodes`/`update_styles`/the 8 verbs, driven through the REAL
 * `runClientTool` → `runCanvasTool` → `toCanvasHost` path — a real BlockNote
 * editor with a canvas block, real Yjs local/peer docs, a real `ReviewSession`
 * on an in-memory Convex stand-in, `peekSceneStore`, and the workspace history
 * spine. Own scaffold, copied from `editor-review-undo.browser.tsx`'s pattern
 * rather than built on `tests/canvas-harness.mjs` (TOOLS.md §8.2). No app
 * server, no real Convex, no API keys — the network is blocked in the runner.
 */

const EXTENSIONS = [
  completionExtension,
  reviewExtension,
  hintExtension,
  arrivalFlashExtension,
  blockSelectionExtension,
];

type Editor = typeof schema.BlockNoteEditor;

const PROVIDER = { provider: true };
const PAGE = "page" as Id<"pages">;
const DOC_ID = "doc";

let root: Root | undefined;
let editor: Editor;
let local: Y.Doc;
let peer: Y.Doc;
let session: ReviewSession;
let mounts = 0;
let turns = 0;

/**
 * The seeded block's id, as a tiny external store rather than a bare module
 * variable: `Page` renders once, at `mount()`, before `seed()` has anything
 * to give it — `useCanvasUndoDomain`'s effect only fires for real once this
 * value changes AFTER that render, which a bare variable's mutation would
 * never trigger a re-render for.
 */
let blockIdValue = "";
const blockIdListeners = new Set<() => void>();
function setBlockId(id: string) {
  blockIdValue = id;
  for (const listener of blockIdListeners) listener();
}
function subscribeBlockId(listener: () => void) {
  blockIdListeners.add(listener);
  return () => blockIdListeners.delete(listener);
}

/** The same in-memory Convex stand-in `editor-review-undo.browser.tsx` uses —
 *  checkpoints and turn rows kept in memory, answered by function name. */
function memoryConvex() {
  const checkpoints = new Map<string, Record<string, unknown>>();
  const rows = new Map<string, Record<string, unknown>>();
  const name = (ref: unknown) => getFunctionName(ref as FunctionReference<"query">);
  return {
    mutation: async (ref: unknown, args: Record<string, unknown>) => {
      switch (name(ref)) {
        case "ai/checkpoints:create": {
          const id = `checkpoint-${checkpoints.size}`;
          checkpoints.set(id, { _id: id, ...args });
          return id;
        }
        case "chat/turns:save":
          rows.set(args.chatPromptId as string, { ...args });
          return null;
        case "ai/opLog:appendBatch":
          return null;
        case "chat/turns:markRewound":
          return null;
      }
      throw new Error(`unexpected mutation ${name(ref)}`);
    },
    query: async (ref: unknown, args: Record<string, unknown>) => {
      switch (name(ref)) {
        case "ai/checkpoints:get":
          return checkpoints.get(args.id as string) ?? null;
        case "chat/turns:byPrompt":
          return rows.get(args.chatPromptId as string) ?? null;
        case "pages:get":
          return null;
      }
      throw new Error(`unexpected query ${name(ref)}`);
    },
  };
}

let convex: ReturnType<typeof memoryConvex>;
const convexReact = new ConvexReactClient("https://canvas-tools-test.invalid", {
  skipConvexDeploymentUrlCheck: true,
});

function Page({ editor }: { editor: Editor }) {
  const spine = useWorkspaceHistory();
  // The document's own undo domain (as `Editor.tsx` wires it) — a kept
  // review answer, diagram included, lands here as one KEPT_CHANGE step
  // (see history/textDomain.ts); it is not the canvas block's own local
  // domain below, which a review-authored write deliberately bypasses.
  useTextUndoDomain(spine, editor as unknown as UndoHostEditor, DOC_ID, PAGE);
  const blockId = useSyncExternalStore(subscribeBlockId, () => blockIdValue);
  // `peekSceneStore` is a plain Map read, not a subscription: the canvas
  // block's own `useScene()` creates its `SceneStore` a render or two after
  // THIS component first sees a non-empty `blockId` (BlockNote's own
  // document-changed subscription fires on a later tick), so a single
  // render-time read here would forever see `null`. Poll until it exists,
  // then hold it in state so `useCanvasUndoDomain` gets a real store.
  const [store, setStore] = useState<SceneStore | null>(null);
  useEffect(() => {
    if (!blockId) return;
    let cancelled = false;
    // Deliberately never calls `setStore` synchronously within the effect
    // body — only from inside the rAF callback, on a later frame — since
    // this component is also the app's own `Page`, subject to the same "no
    // set-state-in-effect" rule as everywhere else (see CLAUDE.md); polling
    // an external, non-reactive read is not the one sanctioned exception.
    let frame = requestAnimationFrame(function tick() {
      if (cancelled) return;
      const found = peekSceneStore(sceneStoreKey(blockId));
      if (found) setStore(found);
      else frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [blockId]);
  useCanvasUndoDomain(spine, store, blockId, PAGE);
  const { canUndo, canRedo } = useSpineState(spine);
  return (
    <main style={{ height: "100vh", overflow: "auto" }}>
      <div {...undoScope} style={{ maxWidth: 960, padding: "24px", boxSizing: "border-box" }}>
        <BlockNoteView
          editor={editor}
          theme="light"
          className="nt-editor"
          sideMenu={false}
          slashMenu={false}
          formattingToolbar={false}
        />
        <ReviewOverlay editor={editor as unknown as LiveEditor} pageId={PAGE} />
      </div>
      <div id="bar" style={{ position: "fixed", right: 24, bottom: 24, display: "flex", gap: 8, background: "#fff" }}>
        <ReviewBar />
      </div>
      <output id="spine" data-undo={String(canUndo)} data-redo={String(canRedo)} />
    </main>
  );
}

function mount() {
  root?.unmount();
  local = new Y.Doc();
  peer = new Y.Doc();
  local.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== PROVIDER) Y.applyUpdate(peer, update, PROVIDER);
  });
  peer.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== PROVIDER) Y.applyUpdate(local, update, PROVIDER);
  });
  const awareness = new Awareness(local);
  const carets = createRemoteCarets(awareness);
  editor = BlockNoteEditor.create(
    withCollaboration({
      schema,
      extensions: [...EXTENSIONS, remoteScrollExtension],
      collaboration: {
        fragment: local.getXmlFragment("prosemirror"),
        user: { name: "Local", color: "#3366cc" },
        provider: { awareness },
        showCursorLabels: "always",
        renderCursor: carets.render,
      },
    } as never),
  ) as unknown as Editor;
  convex = memoryConvex();
  session = new ReviewSession({
    convex: convex as never,
    openPage: () => {},
    editorFor: async () => editor as unknown as LiveEditor,
  });
  // `ReviewBar`/`ReviewOverlay` read through `./ReviewContext`'s hooks, which
  // the esbuild fixture plugin stubs to read this global — see
  // `editor-review-undo.browser.mjs`'s `REVIEW_CONTEXT`.
  (globalThis as Record<string, unknown>).reviewHarnessSession = session;
  root = createRoot(document.getElementById("app")!);
  root.render(
    <ConvexProvider client={convexReact}>
      <WorkspaceHistoryProvider projectId={`project-${++mounts}`}>
        <Page editor={editor} />
      </WorkspaceHistoryProvider>
    </ConvexProvider>,
  );
  carets.attach();
}

const F1 = `<nt-diagram w="600" h="400" style="--brand: #6366f1">
  <nt-rect id="s1" x="40" y="40" w="200" h="56" style="background: var(--brand); border-radius: 10px">Order</nt-rect>
  <nt-rect id="s2" x="300" y="40" w="200" h="56" style="background: #f2f2f0">Ship</nt-rect>
  <nt-group id="g1" x="40" y="160" w="460" h="80" style="display: flex; gap: 16px; padding: 12px">
    <nt-rect id="c1" w="100" h="40"></nt-rect>
    <nt-rect id="c2" w="100" h="40"></nt-rect>
  </nt-group>
  <nt-path id="p1" x="520" y="40" w="40" h="40" d="M 0 0 L 40 40" style="stroke: #2b2b28; fill: none"></nt-path>
  <nt-edge id="e1" from="s1" to="s2">then</nt-edge>
</nt-diagram>`;

/** A fresh canvas block seeded with F1, nothing on anyone's undo stack. */
function seed() {
  editor.transact((tr) => {
    tr.setMeta("addToHistory", false);
    editor.replaceBlocks(editor.document, [
      { type: "heading", props: { level: 1 }, content: "Board" },
      { type: "canvas", props: { data: F1 } },
    ] as never);
  });
  const headingId = editor.document[0].id;
  // A real ProseMirror TextSelection, exactly as production always has one
  // the moment a person opens the page — without it, the FIRST transaction
  // that touches the (contentless) canvas block's props maps a still-default
  // "nowhere" selection across the change and logs a harmless but noisy
  // "TextSelection endpoint not pointing into a node with inline content"
  // warning. `editor.focus()` alone moves DOM focus but not necessarily a
  // valid PM selection; anchoring explicitly in the heading text every tool
  // call leaves alone keeps every later transaction's mapping well-defined.
  editor.setTextCursorPosition(headingId, "end");
  editor.focus();
  const id = editor.document.find((b) => b.type === "canvas")!.id;
  setBlockId(id);
  return id;
}

/** Built fresh per call: `convex` and `session` are reassigned by `mount()`
 *  after this module first loads, so a `ToolContext` object built once at
 *  module scope would freeze the pre-`mount()` (`undefined`) values. */
function toolContext(): ToolContext {
  return {
    convex: convex as never,
    projectId: "project" as Id<"projects">,
    review: session,
    openPageId: () => PAGE,
    openPage: () => {},
    editorFor: async () => editor as unknown as LiveEditor,
    commentsFor: async () => null,
    people: () => [],
  };
}

/** Runs a canvas tool through the SAME `runClientTool` the chat route calls —
 *  never a shortcut straight to `runCanvasTool`. */
function run(name: string, input: unknown) {
  return runClientTool(name, input, toolContext());
}

/** The diagram's shape ids as each reader sees them — the maps, the peer,
 *  and the live surface — the same shape `editor-review-undo.browser.tsx`'s
 *  `diagram()` reads. */
function diagram() {
  const block = editor.document.find((b) => b.type === "canvas");
  if (!block) return null;
  const ids = (html: string) => [...shapeIdsIn(html)].sort();
  const maps = (doc: Y.Doc) => {
    const root = doc.getMap<unknown>(canvasMapName(block.id));
    return hasCanvasState(root) ? ids(serializeScene(materializeCanvas(root))) : [];
  };
  const store = peekSceneStore(sceneStoreKey(block.id));
  return {
    prop: ids((block.props as { data: string }).data),
    maps: maps(local),
    peer: maps(peer),
    shown: store ? ids(serializeScene(store.getScene())) : null,
  };
}

/** The live store itself — `canUndo()`, a history listener, the live scene. */
function store() {
  return peekSceneStore(sceneStoreKey(blockIdValue));
}

function spine() {
  const el = document.getElementById("spine")!;
  return { undo: el.dataset.undo === "true", redo: el.dataset.redo === "true" };
}

/** The scene layer's own transform — untouched by a tool call that adds
 *  nothing off-screen (no camera easing fired). */
function camera() {
  const el = document.querySelector(".nt-canvas-scene") as HTMLElement | null;
  return el?.style.transform ?? null;
}

/** `data-id` elements, by shape id — before/after identity and count checks
 *  around a write. */
function shapeDom(): Record<string, Element> {
  const out: Record<string, Element> = {};
  for (const el of document.querySelectorAll("[data-id]")) {
    out[el.getAttribute("data-id")!] = el;
  }
  return out;
}

/** A shape's DOM box relative to the scene layer, for the get_geometry ⇄ DOM
 *  agreement check (§8.2 case 11). */
function domRect(id: string) {
  const scene = document.querySelector(".nt-canvas-scene")!.getBoundingClientRect();
  const el = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left - scene.left, y: r.top - scene.top, w: r.width, h: r.height };
}

/** One turn's worth of bracketing — every case runs its tool call inside a
 *  turn, exactly as the chat route does. */
async function withTurn<T>(fn: () => Promise<T>): Promise<T> {
  const chatPromptId = `turn-${++turns}`;
  session.beginTurn({ threadId: "thread" as Id<"chatThreads">, projectId: "project" as Id<"projects">, chatPromptId });
  try {
    return await fn();
  } finally {
    await session.endTurn(chatPromptId);
  }
}

/** A push-event counter on the live store, (re)started fresh — case 2/7/9's
 *  "one entry" checks register this BEFORE the tool call they are counting. */
let pushEvents = 0;
let unwatch: (() => void) | null = null;
function watchHistory(): boolean {
  unwatch?.();
  pushEvents = 0;
  const s = store();
  if (!s) return false;
  unwatch = s.onHistory((event) => {
    if (event.type === "push") pushEvents += 1;
  });
  return true;
}

const harness = {
  mount,
  seed,
  run: (name: string, input: unknown) => withTurn(() => run(name, input)),
  diagram,
  store,
  spine,
  camera,
  shapeDom,
  domRect,
  blockId: () => blockIdValue,
  snapshot: () => session.getSnapshot(),
  canUndo: () => store()?.canUndo() ?? false,
  watchHistory,
  pushCount: () => pushEvents,
  acceptAll: () => session.acceptAll(),
  rejectAll: () => session.rejectAll(),
  idle: async () => {
    const queued = () => (session as unknown as { queue: Promise<unknown> }).queue;
    for (let last = queued(); ; last = queued()) {
      await last;
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (last === queued()) return;
    }
  },
};

declare global {
  interface Window {
    canvasTools: typeof harness;
  }
}
window.canvasTools = harness;
