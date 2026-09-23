import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { EditorView } from "prosemirror-view";
import type { Id } from "../convex/_generated/dataModel";
import type { Operation } from "../convex/ai/operations";
import { schema } from "../app/components/editor/schema";
import { completionExtension } from "../app/components/editor/ai/completionExtension";
import { hintExtension } from "../app/components/editor/ai/hintText";
import { reviewExtension } from "../app/components/editor/ai/reviewExtension";
import { ReviewOverlay } from "../app/components/editor/ai/ReviewOverlay";
import { arrivalFlashExtension } from "../app/components/editor/arrivalFlash";
import { blockSelectionExtension } from "../app/components/editor/blockSelection";
import { commentExtension } from "../app/components/editor/comments/commentExtension";
import { CommentHighlights } from "../app/components/editor/comments/CommentHighlights";
import {
  activeThread,
  commentRanges,
  commentResolveCount,
} from "../app/components/editor/comments/commentDecorations";
import type { LiveEditor } from "../app/components/editor/EditorRegistry";
import { CurrentPageProvider } from "../app/components/OpenPageContext";
import { project, type AnyBlock } from "../app/lib/ai/projection";
import { isForked } from "../app/lib/ai/review/fork";
import { ReviewSession } from "../app/lib/ai/review/session";
import { resolveBatch } from "../app/lib/ai/validate";
import { anchorAt } from "../app/lib/comments/anchor";
import { anchorForSelection, pmBlockTexts } from "../app/lib/comments/pmText";
import { CommentsStore, observeThreads, readThreads, threadsSnapshot } from "../app/lib/comments/store";
import { emptyCommentsDocument, type CommentAnchor } from "../app/lib/comments/types";
import { useTextUndoDomain, type UndoHostEditor } from "../app/lib/history/textDomain";
import { undoScope, useWorkspaceHistory, WorkspaceHistoryProvider } from "../app/lib/history/useWorkspaceHistory";
import { createNmlYDoc } from "../app/lib/nml/yjs";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

/**
 * One replica of a commented page, for `comments-anchor.browser.mjs`.
 *
 * The production editor, composed as `Editor.tsx` composes a Yjs page — its
 * extension list, the document's undo domain on the workspace spine, the
 * review overlay — over a page Y.Doc, with the page's comments Y.Doc beside
 * it and the real `CommentHighlights` feeding the highlight plugin from a
 * real `CommentsStore`. Both documents talk to a stand-in server in the
 * runner (`ntFetch` on load, `ntRelay` for every local update), which relays
 * each update to the other replicas — so a reload is a real reload.
 *
 * `?who=` names the replica: ada and bram may comment, vera may only read
 * (read-only editor, no store: she resolves and draws but can never write).
 */

declare global {
  interface Window {
    ntRelay: (name: DocName, update: string) => Promise<void>;
    ntFetch: () => Promise<Record<DocName, string>>;
    ntAnchor: typeof harness;
  }
}

type DocName = "page" | "comments";

const who = new URLSearchParams(location.search).get("who") ?? "ada";
const canComment = who !== "vera";
const SERVER = { server: true };
const PAGE = "page" as Id<"pages">;
const DOC_ID = "page-doc";

const toBase64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const docs: Record<DocName, Y.Doc> = { page: new Y.Doc(), comments: new Y.Doc() };
for (const name of Object.keys(docs) as DocName[]) {
  docs[name].on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== SERVER) void window.ntRelay(name, toBase64(update));
  });
}

const store = canComment
  ? new CommentsStore(docs.comments, { actor: { userId: `user_${who}`, kind: "human" }, authorize: () => true })
  : null;

// The production list, from `Editor.tsx`.
const EXTENSIONS = [
  completionExtension,
  reviewExtension,
  hintExtension,
  arrivalFlashExtension,
  blockSelectionExtension,
  commentExtension,
];

type Editor = typeof schema.BlockNoteEditor;

// Heard before the load is asked for, so nothing relayed meanwhile is lost.
const receive = (name: DocName, update: string) => Y.applyUpdate(docs[name], fromBase64(update), SERVER);
window.ntAnchor = { receive } as unknown as typeof harness;
const states = await window.ntFetch();
for (const name of Object.keys(docs) as DocName[]) {
  if (states[name]) Y.applyUpdate(docs[name], fromBase64(states[name]), SERVER);
}

const awareness = new Awareness(docs.page);
const editor = BlockNoteEditor.create(
  withCollaboration({
    schema,
    extensions: EXTENSIONS,
    collaboration: {
      fragment: docs.page.getXmlFragment("prosemirror"),
      user: { name: who, color: "#777777" },
      provider: { awareness },
    },
  } as never),
) as unknown as Editor;

const view = () => (editor as unknown as { prosemirrorView: EditorView }).prosemirrorView;

/** Checkpoints and turn rows in memory, answered by function name, as `editor-review-undo` keeps them. */
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

const session = new ReviewSession({
  convex: memoryConvex() as never,
  openPage: () => {},
  editorFor: async () => editor as unknown as LiveEditor,
});
(globalThis as Record<string, unknown>).reviewHarnessSession = session;

// What a canvas block's hooks would read; the socket is inert.
const convexReact = new ConvexReactClient("https://comments-anchor-test.invalid", { skipConvexDeploymentUrlCheck: true });

const subscribeThreads = (listener: () => void) => observeThreads(docs.comments, listener);
const snapshotThreads = () => threadsSnapshot(docs.comments);

function Page() {
  const spine = useWorkspaceHistory();
  useTextUndoDomain(spine, editor as unknown as UndoHostEditor, DOC_ID, PAGE);
  const threads = useSyncExternalStore(subscribeThreads, snapshotThreads);
  return (
    <main style={{ height: "100vh", overflow: "auto" }}>
      <div {...undoScope} style={{ maxWidth: 760, padding: "32px 56px", boxSizing: "border-box" }}>
        <BlockNoteView editor={editor} editable={canComment} theme="light" className="nt-editor" sideMenu={false} slashMenu={false} formattingToolbar={false} />
        {canComment && <ReviewOverlay editor={editor as unknown as LiveEditor} pageId={PAGE} />}
      </div>
      <CommentHighlights editor={editor as unknown as LiveEditor} threads={threads} store={store} />
    </main>
  );
}

let turns = 0;

/** One agent turn staged as `edit_page` stages it — resolved, forked, applied — with no model. */
async function stageTurn(ops: Operation[]) {
  const chatPromptId = `turn-${++turns}`;
  session.beginTurn({ threadId: "thread" as Id<"chatThreads">, projectId: "project" as Id<"projects">, chatPromptId });
  const index = project(editor.document as unknown as AnyBlock[]).index;
  const resolved = resolveBatch({ pageId: PAGE, chatPromptId, ops }, index);
  if (!resolved.ok) throw new Error(resolved.errors.join("\n"));
  await session.stage({ pageId: PAGE, editor: editor as unknown as LiveEditor, batch: resolved.batch, replacing: [] });
  await session.endTurn(chatPromptId);
  return chatPromptId;
}

const blockText = (block: { content?: unknown }) =>
  Array.isArray(block.content) ? (block.content as { text?: string }[]).map((part) => part.text ?? "").join("") : "";

/** Every thread's live range, as the words it covers. */
function ranges() {
  const state = view().state;
  return Object.fromEntries(
    [...commentRanges(state)].map(([id, range]) => [id, range ? state.doc.textBetween(range.from, range.to) : null]),
  );
}

/** What is drawn: each highlighted thread's words (a highlight crossing marks is several spans). */
function highlights() {
  const out: Record<string, { text: string; active: boolean }> = {};
  for (const el of document.querySelectorAll<HTMLElement>(".nt-editor .nt-comment-hl")) {
    const id = el.dataset.thread!;
    out[id] ??= { text: "", active: false };
    out[id].text += el.textContent ?? "";
    out[id].active ||= el.classList.contains("nt-comment-hl-active");
  }
  return out;
}

/** Viewport point of character `offset` in a block's words. */
function textPoint(blockId: string, offset: number) {
  const content = document.querySelector(`[data-id="${blockId}"] .bn-inline-content`);
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
  if (offset > 0) return null;
  // An empty block: its start is its left edge.
  const rect = content.getBoundingClientRect();
  return { x: rect.left, y: rect.top + rect.height / 2 };
}

let timings: number[] | null = null;

const harness = {
  who,
  receive,
  vectors: () => ({ page: toBase64(Y.encodeStateVector(docs.page)), comments: toBase64(Y.encodeStateVector(docs.comments)) }),
  /** The page as the server first had it — nothing on anyone's undo stack. */
  seed(blocks: unknown[]) {
    editor.transact((tr) => {
      tr.setMeta("addToHistory", false);
      editor.replaceBlocks(editor.document, blocks as never);
    });
    Y.applyUpdate(docs.comments, Y.encodeStateAsUpdate(createNmlYDoc(emptyCommentsDocument("comments-doc"))));
  },
  texts: () => editor.document.map((block) => blockText(block)),
  blockIds: () => editor.document.map((block) => block.id),
  ranges,
  highlights,
  resolves: () => commentResolveCount(view().state),
  active: () => activeThread(view().state),
  threads: () =>
    readThreads(docs.comments).map((t) => ({
      id: t.id,
      status: t.status,
      anchor: t.anchor,
      orphanedAt: t.orphanedAt ?? null,
      ambiguous: t.ambiguous,
    })),
  textPoint,
  selection: () => {
    const { from, to } = view().state.selection;
    return view().state.doc.textBetween(from, to);
  },
  /** Where the caret is: its block and the offset in that block's words. */
  caret: () => {
    const { $head } = view().state.selection;
    const block = pmBlockTexts(view().state.doc).find((b) => b.start <= $head.pos && $head.pos <= b.end);
    return block ? { blockId: block.blockId, offset: $head.pos - block.start } : null;
  },
  /** Every thread's live range as a block and offsets into its words. */
  rangeOffsets: () => {
    const state = view().state;
    const blocks = pmBlockTexts(state.doc);
    return Object.fromEntries(
      [...commentRanges(state)].map(([id, range]) => {
        const block = range && blocks.find((b) => b.start <= range.from && range.to <= b.end);
        return [id, block ? { blockId: block.blockId, from: range.from - block.start, to: range.to - block.start } : null];
      }),
    );
  },
  /** A thread on `phrase` in every block that has it — the load a busy page carries. */
  async threadEvery(phrase: string) {
    const ids: string[] = [];
    for (const block of pmBlockTexts(view().state.doc)) {
      const at = block.text.indexOf(phrase);
      if (at < 0) continue;
      ids.push(await store!.createThread({ anchor: anchorAt(block, at, at + phrase.length), body: "?", authorId: `user_${who}` }));
    }
    return ids;
  },
  async reopenThread(id: string) {
    await store!.reopen({ threadId: id });
  },
  /** What the comment affordance will do: mint from the selection, write the thread. */
  async commentOnSelection(body: string) {
    const { from, to } = view().state.selection;
    const anchor = anchorForSelection(view().state.doc, from, to);
    if (!anchor || !store) throw new Error("nothing to comment on");
    return store.createThread({ anchor, body, authorId: `user_${who}` });
  },
  async createThread(anchor: CommentAnchor, body: string) {
    return store!.createThread({ anchor, body, authorId: `user_${who}` });
  },
  async resolveThread(id: string) {
    await store!.resolve({ threadId: id, by: `user_${who}` });
  },
  /** An anchor for words of a block, minted as the assistant mints one. */
  blockText: (blockId: string) => pmBlockTexts(view().state.doc).find((b) => b.blockId === blockId)?.text ?? null,
  stageRewrite: (blockId: string, text: string) =>
    stageTurn([{ kind: "setBlockContent", blockId, content: [{ type: "text", text }] }]),
  forked: () => isForked(editor as unknown as LiveEditor),
  idle: async () => {
    const queued = () => (session as unknown as { queue: Promise<unknown> }).queue;
    for (let last = queued(); ; last = queued()) {
      await last;
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (last === queued()) return;
    }
  },
  /** Every editor transaction's duration from here on — apply, plugins, DOM and the Yjs write. */
  startTiming() {
    const v = view();
    const original = v.dispatch.bind(v);
    timings = [];
    v.dispatch = (tr) => {
      const t0 = performance.now();
      original(tr);
      if (tr.docChanged) timings?.push(performance.now() - t0);
    };
  },
  stopTiming: () => {
    const out = timings ?? [];
    timings = null;
    return out;
  },
};
window.ntAnchor = harness;


createRoot(document.getElementById("app")!).render(
  <ConvexProvider client={convexReact}>
    <WorkspaceHistoryProvider projectId="project">
      <CurrentPageProvider pageId={PAGE}>
        <Page />
      </CurrentPageProvider>
    </WorkspaceHistoryProvider>
  </ConvexProvider>,
);
document.body.dataset.ready = "true";
