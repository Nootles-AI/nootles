import { useState, useSyncExternalStore } from "react";
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
import { ySyncPluginKey } from "y-prosemirror";
import { applySceneDiff, CANVAS_LOCAL, canvasMapName, hasCanvasState, materializeCanvas } from "../app/components/editor/canvas/collab/ymap";
import { peekSceneStore } from "../app/components/editor/canvas/engine/useScene";
import { migrateLegacyCanvas } from "../app/components/editor/canvas/scene/migrate";
import { walk, type Scene } from "../app/components/editor/canvas/scene/types";
import { blockSelectionExtension } from "../app/components/editor/blockSelection";
import type { LiveEditor } from "../app/components/editor/EditorRegistry";
import { CurrentPageProvider } from "../app/components/OpenPageContext";
import { ReviewBar } from "../app/components/ReviewBar";
import type { AnyBlock } from "../app/lib/ai/projection";
import { project } from "../app/lib/ai/projection";
import { ChatTranscript, type RewindScope } from "../app/components/chat/ChatTranscript";
import type { AbMessage } from "../app/lib/ai/chat/types";
import { ReviewSession, type ReturnPoint } from "../app/lib/ai/review/session";
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
// The workspace loads it with the canvas toolbar, which this page has no room for.
import "../app/components/editor/canvas/canvas.css";

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
  const gates = new Map<
    string,
    { promise: Promise<void>; release: () => void; entered: boolean }
  >();
  // `chat/turns:restorable`, the subscription the transcript's Rewind reads.
  let restorable: { chatPromptId: string; pageCount: number; status: string }[] = [];
  const listeners = new Set<() => void>();
  return {
    log,
    rows,
    holdMutation: (functionName: string) => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      gates.set(functionName, { promise, release, entered: false });
    },
    releaseMutation: (functionName: string) => gates.get(functionName)?.release(),
    mutationBlocked: (functionName: string) => gates.get(functionName)?.entered ?? false,
    restorable: () => restorable,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mutation: async (ref: unknown, args: Record<string, unknown>) => {
      const functionName = name(ref);
      const gate = gates.get(functionName);
      if (gate) {
        gate.entered = true;
        await gate.promise;
        gates.delete(functionName);
      }
      switch (functionName) {
        case "ai/checkpoints:create": {
          const id = `checkpoint-${checkpoints.size}`;
          checkpoints.set(id, { _id: id, ...args });
          return id;
        }
        case "chat/turns:save":
          rows.set(args.chatPromptId as string, { ...args });
          restorable = [...rows.values()]
            .filter((row) => (row.checkpointIds as string[]).length)
            .map((row) => ({
              chatPromptId: row.chatPromptId as string,
              pageCount: (row.pageIds as string[]).length,
              status: row.status as string,
            }));
          for (const listener of listeners) listener();
          return null;
        case "ai/opLog:appendBatch":
          log.push(args);
          return null;
        case "chat/turns:markRewound":
          return null;
      }
      throw new Error(`unexpected mutation ${functionName}`);
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
      <ChatRail />
      <output id="spine" data-undo={String(canUndo)} data-redo={String(canRedo)} />
    </main>
  );
}

/** The conversation, as the chat store holds it: each staged turn's question and answer. */
let messages: AbMessage[] = [];
const chatListeners = new Set<() => void>();

function setMessages(next: AbMessage[]) {
  messages = next;
  for (const listener of chatListeners) listener();
}

function subscribeChat(listener: () => void) {
  chatListeners.add(listener);
  return () => {
    chatListeners.delete(listener);
  };
}

/**
 * The chat rail: the real transcript, its rewind wired to the session exactly
 * as `ChatPanel` wires it (`startRewind`, `cancelRewind`, `commitRewind`).
 * Truncating the conversation is the store's half of `useProjectChat.rewind`;
 * a question typed into the rewind is never sent.
 */
function ChatRail() {
  const list = useSyncExternalStore(subscribeChat, () => messages);
  const [rewind, setRewind] = useState<{ uiId: string; scope: RewindScope; points: ReturnPoint[] } | null>(null);

  const startRewind = async (message: AbMessage, scope: RewindScope) => {
    const promptId = message.metadata?.chatPromptId;
    if (scope === "notes") {
      if (promptId) void session.restoreCheckpoint(promptId);
      return;
    }
    const points = scope === "both" && promptId ? await session.previewRestore(promptId) : [];
    setRewind({ uiId: message.id, scope, points });
  };

  const cancelRewind = async () => {
    if (!rewind) return;
    setRewind(null);
    if (rewind.points.length) await session.cancelRestore(rewind.points);
  };

  const commitRewind = async () => {
    if (!rewind) return;
    const index = messages.findIndex((m) => m.id === rewind.uiId);
    const promptId = messages[index]?.metadata?.chatPromptId;
    setRewind(null);
    if (rewind.scope === "both" && promptId) await session.settleRestore(promptId);
    if (index >= 0) setMessages(messages.slice(0, index));
  };

  return (
    <aside id="chat" style={{ position: "fixed", right: 24, top: 100, bottom: 90, width: 340, overflow: "auto", display: "flex", flexDirection: "column" }}>
      <ChatTranscript
        messages={list}
        busy={false}
        approvals={[]}
        projectId={"project" as Id<"projects">}
        threadId={"thread" as Id<"chatThreads">}
        onAnswerApproval={() => {}}
        onAnswerDraws={() => {}}
        rewinding={rewind?.uiId ?? null}
        onRewind={(message, what) => void startRewind(message, what)}
        onRewindCancel={() => void cancelRewind()}
        onRewindCommit={() => void commitRewind()}
      />
    </aside>
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
  (globalThis as Record<string, unknown>).reviewHarnessTurns = { subscribe: convex.subscribe, restorable: convex.restorable };
  setMessages([]);
  // As `ReviewProvider` builds it; the one open page is the only page.
  session = new ReviewSession({
    convex: convex as never,
    openPage: () => {},
    editorFor: async () => editor as unknown as LiveEditor,
  });
  (globalThis as Record<string, unknown>).reviewHarnessSession = session;
  root = createRoot(document.getElementById("app")!);
  // A fresh project per mount, so no spine outlives the doc it recorded. The
  // page context is `PageSurface`'s: without it a diagram registers no undo
  // domain, and its ⌘Z never reaches the spine.
  root.render(
    <ConvexProvider client={convexReact}>
      <WorkspaceHistoryProvider projectId={`project-${++mounts}`}>
        <CurrentPageProvider pageId={PAGE}>
          <Page editor={editor} />
        </CurrentPageProvider>
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
  const out: string[] = [];
  const visit = (blocks: { id: string; content?: unknown; children?: unknown[] }[]) => {
    for (const block of blocks) {
      if (blockText(block).startsWith(prefix)) out.push(block.id);
      if (Array.isArray(block.children)) visit(block.children as never);
    }
  };
  visit(editor.document as never);
  return out;
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
  setMessages([
    ...messages,
    { id: `question-${turns}`, role: "user", parts: [{ type: "text", text: "turn my notes into a storyboard" }], metadata: { chatPromptId } },
    { id: `answer-${turns}`, role: "assistant", parts: [{ type: "text", text: "Your notes are a storyboard now." }] },
  ]);
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

/** A change nowhere near the diagram, for a turn answered on a page that has one. */
function agentHeading() {
  return stageTurn(
    [{ kind: "setBlockContent", blockId: idsWith("Storyboard")[0], content: [text("Storyboard — draft 2")] }],
    [],
  );
}

/** A whole-diagram write — the only way an agent edits one: a second shape. */
function agentDiagram() {
  const block = editor.document.find((b) => b.type === "canvas")!;
  return stageTurn([{ kind: "updateBlockProps", blockId: block.id, props: { data: DIAGRAM_WITH_B } }], []);
}

/** The other shape a whole-diagram write can take: the shape already there, moved. */
function agentMovesShape() {
  const block = editor.document.find((b) => b.type === "canvas")!;
  return stageTurn(
    [{ kind: "updateBlockProps", blockId: block.id, props: { data: DIAGRAM.replace('x="0"', 'x="150"') } }],
    [],
  );
}

const canvasBlock = () => editor.document.find((b) => b.type === "canvas");

/** A scene's shapes, sorted — as `id`, or as `id@x` where a check follows a move. */
function shapeList(scene: Scene, at: boolean) {
  const out: string[] = [];
  walk(scene.nodes, (node) => void out.push(at ? `${node.id}@${Math.round(node.x)}` : node.id));
  return out.sort();
}

function mapShapes(doc: Y.Doc, blockId: string, at: boolean) {
  const root = doc.getMap<unknown>(canvasMapName(blockId));
  return hasCanvasState(root) ? shapeList(materializeCanvas(root), at) : [];
}

/** The diagram as each reader sees it: the block prop, both docs' maps, and the surface. */
function diagram(at = false) {
  const block = canvasBlock();
  if (!block) return null;
  const store = peekSceneStore(`canvas:${block.id}`);
  return {
    prop: shapeList(migrateLegacyCanvas((block.props as { data: string }).data), at),
    maps: mapShapes(local, block.id, at),
    peer: mapShapes(peer, block.id, at),
    shown: store ? shapeList(store.getScene(), at) : null,
  };
}

/**
 * What a review keeps to itself: the maps in the doc the editor is bound to
 * (null unless that is a fork), and the block prop as the collaborator's doc
 * holds it — the mirror they would read.
 */
function diagramPrivacy(at = false) {
  const block = canvasBlock();
  if (!block) return null;
  const bound = (ySyncPluginKey.getState(editor.prosemirrorState) as { binding: { doc: Y.Doc } }).binding.doc;
  const group = peer.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
  const container = group.toArray().find((el) => (el as Y.XmlElement).getAttribute("id") === block.id) as Y.XmlElement | undefined;
  const data = (container?.get(0) as Y.XmlElement | undefined)?.getAttribute("data");
  return {
    fork: bound === local ? null : mapShapes(bound, block.id, at),
    peerMirror: typeof data === "string" ? shapeList(migrateLegacyCanvas(data), at) : null,
  };
}

/** A collaborator drawing a shape, written into their maps as their canvas binding writes one. */
function peerDraws(id: string) {
  const block = canvasBlock()!;
  const root = peer.getMap<unknown>(canvasMapName(block.id));
  const before = materializeCanvas(root);
  const [shape] = migrateLegacyCanvas(
    `<nt-diagram w="400" h="300"><nt-rect id="${id}" x="20" y="220" w="60" h="40" style="background: #0a0"></nt-rect></nt-diagram>`,
  ).nodes;
  peer.transact(() => applySceneDiff(root, before, { ...before, nodes: [...before.nodes, shape] }), CANVAS_LOCAL);
}

/** Viewport centre of a shape drawn on the diagram's surface. */
function shapePoint(id: string) {
  const el = [...document.querySelectorAll(`.nt-editor [data-id="${CSS.escape(id)}"]`)].find((node) => node.getBoundingClientRect().width > 0);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
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

/** A collaborator writing a NEW paragraph under the block that starts with `prefix`. */
function peerAdd(prefix: string, value: string) {
  const id = idsWith(prefix)[0];
  const group = peer.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
  const blocks = group.toArray() as Y.XmlElement[];
  const at = blocks.findIndex((el) => el.getAttribute("id") === id);
  const sample = blocks[at];
  peer.transact(() => {
    // Cloned rather than built: a block container carries whatever attributes
    // the schema gives it, and a hand-made one y-prosemirror cannot read is a
    // fixture bug reported as a product one.
    const block = sample.clone();
    group.insert(at + 1, [block]);
    block.setAttribute("id", `peer-${Math.random().toString(36).slice(2, 8)}`);
    for (const node of block.createTreeWalker((n) => n instanceof Y.XmlText)) {
      const words = node as Y.XmlText;
      words.delete(0, words.length);
      words.insert(0, value);
      return;
    }
  }, "peer");
}

/** A cell as a run list: plain text, or runs carrying their marks. */
type Cell = string | { type: "text"; text: string; marks?: Mark[] }[];

const runs = (cell: Cell) => (typeof cell === "string" ? (cell ? [text(cell)] : []) : cell);

/** The same cell in BlockNote's own shape, which is how a page holds one before any agent touched it. */
const styled = (cell: Cell) =>
  runs(cell).map((run) => ({
    type: "text" as const,
    text: run.text,
    styles: Object.fromEntries((run.marks ?? []).map((mark) => [mark, true])),
  }));

/** A day of the reporter's itinerary: a heading, a line, and the table under them. */
function seedTable(rows: Cell[][]) {
  return seed([
    { type: "heading", props: { level: 2 }, content: "Thursday — Vancouver to Lynnwood" },
    { type: "paragraph", content: "Drive: ~2.5 hrs (subject to border wait)" },
    { type: "table", content: { type: "tableContent", headerRows: 1, rows: rows.map((cells) => ({ cells: cells.map(styled) })) } },
    { type: "paragraph", content: "" },
  ]);
}

const tables = () => editor.document.filter((block) => block.type === "table");

/** The table rewritten as `edit_page` rewrites one, whatever it changed: every cell at once. */
function agentTable(rows: Cell[][]) {
  return stageTurn([{ kind: "setTableRows", blockId: tables()[0].id, rows: rows.map((cells) => cells.map(runs)), headerRows: 1 }], []);
}

/** A table the page did not have, written under its last block. */
function agentNewTable(rows: Cell[][]) {
  const last = editor.document[editor.document.length - 1];
  return stageTurn(
    [{ kind: "insertBlocks", at: { at: "after", ref: last.id }, blocks: [{ tempId: "t1", type: "table", rows: rows.map((cells) => cells.map(runs)), headerRows: 1 }] }],
    [],
  );
}

/** The line under the heading, rewritten. */
function agentLine(value: string) {
  return stageTurn([{ kind: "setBlockContent", blockId: idsWith("Drive:")[0], content: [text(value)] }], []);
}


/** A list of each kind, at two levels, so every marker BlockNote draws is on the page. */
function seedList() {
  return seed([
    { type: "heading", props: { level: 2 }, content: "Packing" },
    { type: "bulletListItem", content: "camera body", children: [{ type: "bulletListItem", content: "spare battery" }] },
    { type: "numberedListItem", content: "clear the border", children: [{ type: "numberedListItem", content: "buy a SIM" }] },
    { type: "checkListItem", content: "charge the drone" },
    { type: "paragraph", content: "" },
  ]);
}

/** Every item on that page rewritten where it stands. */
function agentList() {
  const at = (prefix: string) => idsWith(prefix)[0];
  return stageTurn(
    [
      { kind: "setBlockContent", blockId: at("camera body"), content: [text("camera body and lens")] },
      { kind: "setBlockContent", blockId: at("spare battery"), content: [text("two spare batteries")] },
      { kind: "setBlockContent", blockId: at("clear the border"), content: [text("clear the border early")] },
      { kind: "setBlockContent", blockId: at("buy a SIM"), content: [text("buy a local SIM")] },
      { kind: "setBlockContent", blockId: at("charge the drone"), content: [text("charge the drone twice")] },
    ],
    [],
  );
}

/**
 * A block's own content element, never one of its children's. A block whose
 * view is a React node — a diagram, a code block — renders its own wrapper
 * there instead of `.bn-block-content`, which is why NT-47 spared them: they
 * were never under BlockNote's `height: 0`. The children hang off the sibling
 * `.bn-block-group`.
 */
const contentOf = (id: string | undefined) =>
  document.querySelector<HTMLElement>(`[data-node-type="blockContainer"][data-id="${id}"] > :not(.bn-block-group)`);

/**
 * The margin rule as it is painted on a block: the tone it is drawn in, and
 * whether it runs the block's own height — which is the whole of NT-47, since
 * a rule that resolves to 0px is unclipped, coloured, and invisible.
 *
 * `marker` is the pseudo-element next door, where a bulleted or numbered item
 * draws its own. The rule shares the block with it and must leave it in the
 * flex line: taking it out pulls the item's words 24px left.
 */
function marginRule(id: string | undefined) {
  const el = contentOf(id);
  if (!el) return null;
  const rule = getComputedStyle(el, "::after");
  const marker = getComputedStyle(el, "::before");
  const words = el.querySelector(".bn-inline-content");
  return {
    tone: [...el.classList].find((name) => name.startsWith("nt-diff-"))?.slice("nt-diff-".length) ?? null,
    height: Math.round(parseFloat(rule.height)) || 0,
    block: Math.round(el.getBoundingClientRect().height),
    width: rule.width,
    left: rule.left,
    colour: rule.backgroundColor,
    marker: { glyph: marker.content, position: marker.position, width: marker.width },
    wordsAt: words ? Math.round(words.getBoundingClientRect().left) : null,
  };
}

/** Where the caret landed: the block it is in, and its offset in that block's text. */
function caretAt() {
  const { selection } = (editor as unknown as {
    prosemirrorState: { selection: { $from: { parent: { textContent: string }; parentOffset: number }; empty: boolean } };
  }).prosemirrorState;
  return { empty: selection.empty, text: selection.$from.parent.textContent, offset: selection.$from.parentOffset };
}

/** The one marked block with nothing left in it, and what its `::after` is doing. */
function emptiedBlock() {
  const el = [...document.querySelectorAll<HTMLElement>(".nt-diff")].find((node) => node.textContent === "");
  if (!el) return null;
  const after = getComputedStyle(el, "::after");
  return {
    tone: [...el.classList].find((name) => name.startsWith("nt-diff-"))?.slice("nt-diff-".length) ?? null,
    placeholder: after.content,
    position: after.position,
    colour: after.backgroundColor,
  };
}

/** The `index`th table's cells as text, row by row. */
function tableRows(index = 0) {
  const content = tables()[index]?.content as { rows: { cells: { content: { text?: string }[] }[] }[] } | undefined;
  return content?.rows.map((row) => row.cells.map((cell) => cell.content.map((part) => part.text ?? "").join(""))) ?? null;
}

/**
 * What the review draws on a block, as a reader meets it: the mark on the block
 * itself and the wash that paints, the words marked inside it, and — for a
 * table — which cells hold any of them, as `row:column`.
 */
function drawn(id: string | undefined) {
  const el = document.querySelector<HTMLElement>(`[data-id="${id}"] [data-content-type]`);
  if (!el) return null;
  return {
    tone: [...el.classList].find((name) => name.startsWith("nt-diff-"))?.slice("nt-diff-".length) ?? null,
    wash: getComputedStyle(el).backgroundColor,
    ins: [...el.querySelectorAll(".nt-diff-ins")].map((node) => node.textContent),
    del: [...el.querySelectorAll(".nt-diff-del")].map((node) => node.textContent),
    cells: [...el.querySelectorAll("tr")].flatMap((row, r) =>
      [...row.children].flatMap((cell, c) => (cell.querySelector(".nt-diff-ins, .nt-diff-del") ? [`${r}:${c}`] : [])),
    ),
  };
}

/** Viewport point at the end of a table cell's own words, past any struck-out ones drawn in it. */
function cellEnd(row: number, column: number) {
  const table = document.querySelector(`[data-id="${tables()[0]?.id}"] [data-content-type="table"]`);
  const paragraph = table?.querySelectorAll("tr")[row]?.children[column]?.querySelector("p");
  if (!paragraph) return null;
  const words: Node[] = [];
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest(".nt-diff-del")) words.push(node);
  }
  const last = words[words.length - 1];
  if (!last) {
    const rect = paragraph.getBoundingClientRect();
    return { x: rect.left + 2, y: rect.top + rect.height / 2 };
  }
  const range = document.createRange();
  range.setStart(last, last.textContent!.length);
  range.collapse(true);
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  return { x: rect.left, y: rect.top + rect.height / 2 };
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
  agentMovesShape,
  diagram,
  diagramPrivacy,
  peerDraws,
  shapePoint,
  peerType,
  peerAdd,
  agentHeading,
  seedTable,
  agentTable,
  seedList,
  agentList,
  rule: (prefix: string) => marginRule(idsWith(prefix)[0]),
  ruleOnTable: (index = 0) => marginRule(tables()[index]?.id),
  ruleOnDiagram: () => marginRule(canvasBlock()?.id),
  caretAt,
  emptiedBlock,
  agentNewTable,
  agentLine,
  tableRows,
  drawnTable: (index = 0) => drawn(tables()[index]?.id),
  drawnLine: (prefix: string) => drawn(idsWith(prefix)[0]),
  cellEnd,
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
  answering: () =>
    session
      .getSnapshot()
      .flatMap((turn) => turn.pages.flatMap((page) => page.hunks))
      .map((hunk) => ({ id: hunk.id, verdict: session.answeringAs(hunk.id) })),
  holdMutation: (name: string) => convex.holdMutation(name),
  releaseMutation: (name: string) => convex.releaseMutation(name),
  mutationBlocked: (name: string) => convex.mutationBlocked(name),
  messages: () => messages.length,
  /** Resolves once the session's one-at-a-time queue has drained. */
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
    reviewHarness: typeof harness;
  }
}
window.reviewHarness = harness;
