import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { Id } from "../convex/_generated/dataModel";
import type { Mark, Operation } from "../convex/ai/operations";
import { schema } from "../app/components/editor/schema";
import { completionExtension } from "../app/components/editor/ai/completionExtension";
import { hintExtension } from "../app/components/editor/ai/hintText";
import { reviewExtension } from "../app/components/editor/ai/reviewExtension";
import { ReviewOverlay } from "../app/components/editor/ai/ReviewOverlay";
import { arrivalFlashExtension } from "../app/components/editor/arrivalFlash";
import { canvasMapName, hasCanvasState, materializeCanvas } from "../app/components/editor/canvas/collab/ymap";
import { peekSceneStore } from "../app/components/editor/canvas/engine/useScene";
import { shapeIdsIn } from "../app/components/editor/canvas/scene/reveal";
import { serializeScene } from "../app/components/editor/canvas/scene/serialize";
import { blockSelectionExtension } from "../app/components/editor/blockSelection";
import type { LiveEditor } from "../app/components/editor/EditorRegistry";
import { ReviewBar } from "../app/components/ReviewBar";
import type { AnyBlock } from "../app/lib/ai/projection";
import { project } from "../app/lib/ai/projection";
import { ReviewSession } from "../app/lib/ai/review/session";
import { resolveBatch } from "../app/lib/ai/validate";
import { useTextUndoDomain, type UndoHostEditor } from "../app/lib/history/textDomain";
import {
  undoScope,
  useSpineState,
  useWorkspaceHistory,
  WorkspaceHistoryProvider,
} from "../app/lib/history/useWorkspaceHistory";
import { createRemoteCarets } from "../app/lib/sync/remoteCarets";
import { remoteScrollExtension } from "../app/lib/sync/remoteScroll";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

// The production list, from `Editor.tsx`.
const EXTENSIONS = [
  completionExtension,
  reviewExtension,
  hintExtension,
  arrivalFlashExtension,
  blockSelectionExtension,
];

type Editor = typeof schema.BlockNoteEditor;

const PROVIDER = { provider: true };
const DOC_ID = "doc";
const PAGE = "page" as Id<"pages">;

let root: Root | undefined;
let editor: Editor;
let local: Y.Doc;
let peer: Y.Doc;
let session: ReviewSession;
let mounts = 0;
let turns = 0;

/**
 * Stands in for Convex: checkpoints and turn rows kept in memory, answered by
 * function name, so the session runs its real read-after-write paths.
 */
function memoryConvex() {
  const checkpoints = new Map<string, Record<string, unknown>>();
  const rows = new Map<string, Record<string, unknown>>();
  const log: unknown[] = [];
  const name = (ref: unknown) => getFunctionName(ref as FunctionReference<"query">);
  return {
    log,
    rows,
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
          log.push(args);
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

// What a canvas block's own hooks read through (profile hints). The socket is
// inert in the runner, so every query simply stays loading.
const convexReact = new ConvexReactClient("https://review-undo-test.invalid", { skipConvexDeploymentUrlCheck: true });

function Page({ editor }: { editor: Editor }) {
  const spine = useWorkspaceHistory();
  useTextUndoDomain(spine, editor as unknown as UndoHostEditor, DOC_ID, PAGE);
  const { canUndo, canRedo } = useSpineState(spine);
  return (
    <main style={{ height: "100vh", overflow: "auto" }}>
      <div {...undoScope} style={{ maxWidth: 760, padding: "48px 56px", boxSizing: "border-box" }}>
        <BlockNoteView editor={editor} theme="light" className="nt-editor" sideMenu={false} slashMenu={false} formattingToolbar={false} />
        <ReviewOverlay editor={editor as unknown as LiveEditor} pageId={PAGE} />
      </div>
      <div id="bar" style={{ position: "fixed", right: 24, bottom: 24, display: "flex", gap: 8, background: "#fff" }}>
        <ReviewBar />
      </div>
      {/* The chat composer: outside the undo scope, as ChatPanel's is. */}
      <textarea id="composer" style={{ position: "fixed", right: 24, top: 24, width: 320, height: 60 }} />
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
  // The composition from `useYjsEditor.ts`.
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
  // As `ReviewProvider` builds it; the one open page is the only page.
  session = new ReviewSession({
    convex: convex as never,
    openPage: () => {},
    editorFor: async () => editor as unknown as LiveEditor,
  });
  (globalThis as Record<string, unknown>).reviewHarnessSession = session;
  root = createRoot(document.getElementById("app")!);
  // A fresh project per mount, so no spine outlives the doc it recorded.
  root.render(
    <ConvexProvider client={convexReact}>
      <WorkspaceHistoryProvider projectId={`project-${++mounts}`}>
        <Page editor={editor} />
      </WorkspaceHistoryProvider>
    </ConvexProvider>,
  );
  carets.attach();
}

/** The page as it arrived from the server: nothing on anyone's undo stack. */
function seed(blocks: unknown[]) {
  editor.transact((tr) => {
    tr.setMeta("addToHistory", false);
    editor.replaceBlocks(editor.document, blocks as never);
  });
  return editor.document.length;
}

const blockText = (block: { content?: unknown }) =>
  Array.isArray(block.content)
    ? (block.content as { text?: string }[]).map((part) => part.text ?? "").join("")
    : "";

/** Top-level blocks as `type:text`, the shape every check compares. */
function texts() {
  return editor.document.map((block) => `${block.type}:${blockText(block)}`);
}

/** What the collaborator's doc holds, read straight off its fragment in the same shape. */
function peerTexts() {
  const group = peer.getXmlFragment("prosemirror").get(0) as Y.XmlElement | undefined;
  if (!group) return [];
  return group.toArray().map((container) => {
    const content = (container as Y.XmlElement).get(0) as Y.XmlElement;
    const words = content
      .toArray()
      .filter((node): node is Y.XmlText => node instanceof Y.XmlText)
      .map((node) => node.toDelta().map((op: { insert: string }) => op.insert).join(""))
      .join("");
    return `${content.nodeName}:${words}`;
  });
}

function idsWith(prefix: string) {
  return editor.document.filter((block) => blockText(block).startsWith(prefix)).map((block) => block.id);
}

/** Viewport point of character `offset` inside top-level block `index`'s text. */
function textPoint(index: number, offset: number) {
  const id = editor.document[index]?.id;
  const content = document.querySelector(`[data-id="${id}"] .bn-inline-content`);
  if (!content) return null;
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let left = offset;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent!.length;
    if (left <= length) {
      const range = document.createRange();
      range.setStart(node, left);
      range.collapse(true);
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
      return { x: rect.left, y: rect.top + rect.height / 2 };
    }
    left -= length;
  }
  const rect = content.getBoundingClientRect();
  return { x: rect.left + 2, y: rect.top + rect.height / 2 };
}

const text = (value: string, marks?: Mark[]) => ({ type: "text" as const, text: value, ...(marks ? { marks } : {}) });

/**
 * One chat turn, as `edit_page` stages it: the batch resolved against the page
 * the model read, then handed to the session with the blocks it declared it
 * was replacing. Returns the turn's prompt id.
 */
async function stageTurn(ops: Operation[], replacing: string[]) {
  const chatPromptId = `turn-${++turns}`;
  session.beginTurn({ threadId: "thread" as Id<"chatThreads">, projectId: "project" as Id<"projects">, chatPromptId });
  const index = project(editor.document as unknown as AnyBlock[]).index;
  const resolved = resolveBatch({ pageId: PAGE, chatPromptId, ops }, index);
  if (!resolved.ok) throw new Error(resolved.errors.join("\n"));
  await session.stage({ pageId: PAGE, editor: editor as unknown as LiveEditor, batch: resolved.batch, replacing });
  await session.endTurn(chatPromptId);
  return chatPromptId;
}

const SCENE_BLOCKS = [
  { tempId: "t1", type: "heading" as const, props: { level: 2 }, content: [text("Scene 1 — The Question")] },
  { tempId: "t2", type: "paragraph" as const, content: [text("Visual:", ["bold"]), text(" A café table. Actor B leans into frame.")] },
  { tempId: "t3", type: "quote" as const, content: [text("\"What was your childhood dream?\"", ["italic"])] },
];

const removing = (ids: string[]) => ids.map((blockId): Operation => ({ kind: "removeBlock", blockId }));

/** The reported turn: the notes struck out, a storyboard written in their place. */
function agentReplace() {
  const replacing = idsWith("idea:");
  return stageTurn(
    [{ kind: "insertBlocks", at: { at: "after", ref: idsWith("Notes")[0] }, blocks: SCENE_BLOCKS }, ...removing(replacing)],
    replacing,
  );
}

/** Two changes a page apart — a logline under the title, and the same replacement — answerable one by one. */
function agentTwoChanges() {
  const replacing = idsWith("idea:");
  return stageTurn(
    [
      { kind: "insertBlocks", at: { at: "after", ref: editor.document[0].id }, blocks: [{ tempId: "l1", type: "paragraph", content: [text("Logline: a letter from childhood, read aloud.")] }] },
      { kind: "insertBlocks", at: { at: "after", ref: idsWith("Notes")[0] }, blocks: SCENE_BLOCKS },
      ...removing(replacing),
    ],
    replacing,
  );
}

const DIAGRAM = `<nt-diagram w="400" h="300">
  <nt-rect id="a" x="0" y="0" w="200" h="200" style="background: #f00; border-radius: 8px"></nt-rect>
</nt-diagram>`;
const DIAGRAM_WITH_B = `<nt-diagram w="400" h="300">
  <nt-rect id="a" x="0" y="0" w="200" h="200" style="background: #f00; border-radius: 8px"></nt-rect>
  <nt-rect id="b" x="220" y="40" w="120" h="80" style="background: #00f"></nt-rect>
</nt-diagram>`;

function seedDiagram() {
  return seed([
    { type: "heading", props: { level: 1 }, content: "Storyboard" },
    { type: "canvas", props: { data: DIAGRAM } },
    { type: "paragraph", content: "" },
  ]);
}

/** A whole-diagram write — the only way an agent edits one: a second shape. */
function agentDiagram() {
  const block = editor.document.find((b) => b.type === "canvas")!;
  return stageTurn([{ kind: "updateBlockProps", blockId: block.id, props: { data: DIAGRAM_WITH_B } }], []);
}

/** The diagram's shape ids as each reader sees them: the block prop, both docs' maps, and the surface. */
function diagram() {
  const block = editor.document.find((b) => b.type === "canvas");
  if (!block) return null;
  const ids = (html: string) => [...shapeIdsIn(html)].sort();
  const maps = (doc: Y.Doc) => {
    const root = doc.getMap<unknown>(canvasMapName(block.id));
    return hasCanvasState(root) ? ids(serializeScene(materializeCanvas(root))) : [];
  };
  const store = peekSceneStore(`canvas:${block.id}`);
  return {
    prop: ids((block.props as { data: string }).data),
    maps: maps(local),
    peer: maps(peer),
    shown: store ? ids(serializeScene(store.getScene())) : null,
  };
}

/** A collaborator appending to the block that starts with `prefix`. */
function peerType(prefix: string, value: string) {
  const id = idsWith(prefix)[0];
  const group = peer.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
  const container = group.toArray().find((el) => (el as Y.XmlElement).getAttribute("id") === id) as Y.XmlElement;
  for (const node of container.createTreeWalker((n) => n instanceof Y.XmlText)) {
    const target = node as Y.XmlText;
    peer.transact(() => target.insert(target.length, value), "peer");
    return;
  }
  throw new Error(`no text in ${prefix}`);
}

const forkState = () =>
  (editor.getExtension("yForkDoc") as unknown as { store: { state: { isForked: boolean } } }).store.state.isForked;

const harness = {
  mount,
  seed,
  texts,
  peerTexts,
  textPoint,
  agentReplace,
  agentTwoChanges,
  seedDiagram,
  agentDiagram,
  diagram,
  peerType,
  forked: forkState,
  open: () => session.getSnapshot().filter((turn) => session.isOpen(turn)).length,
  status: (chatPromptId: string) => session.getSnapshot().find((turn) => turn.chatPromptId === chatPromptId)?.status ?? null,
  failure: () => session.getFailure(),
  stacks: () => {
    const manager = (window as unknown as { __ntTextUndo?: Y.UndoManager }).__ntTextUndo;
    return manager ? { undo: manager.undoStack.length, redo: manager.redoStack.length } : null;
  },
  spine: () => {
    const el = document.getElementById("spine")!;
    return { undo: el.dataset.undo === "true", redo: el.dataset.redo === "true" };
  },
  opLog: () => convex.log.length,
};

declare global {
  interface Window {
    reviewHarness: typeof harness;
  }
}
window.reviewHarness = harness;
