import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { getToolName, isToolUIPart } from "ai";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import type { Id } from "../convex/_generated/dataModel";
import { schema } from "../app/components/editor/schema";
import { ChatComposer } from "../app/components/chat/ChatComposer";
import { PageCommentsProvider } from "../app/components/comments/PageComments";
import { CommentAccessContext, commentAccessFor } from "../app/components/comments/access";
import { PageCommentsRegistryProvider } from "../app/components/comments/registry";
import { useProjectChat } from "../app/lib/ai/chat/useProjectChat";
import { CommentsStore, readThreads } from "../app/lib/comments/store";
import { commentText } from "../app/lib/comments/types";
import type { ProjectRole } from "../convex/roles";
import { commentsFixture, ROADMAP } from "./comments-assistant.fixture";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

/**
 * The assistant's comment tools, end to end in the production pieces: the real
 * `ChatComposer` over the real `useProjectChat` — its `BrowserChat`, the SDK's
 * transport, the client-tool queue and the turn replay guard — the real
 * `PageCommentsProvider` publishing through the real registry, and the
 * production editor on a Yjs page. Only the model is replaced, by the runner's
 * `/api/chat` stand-in, and Convex, by the stubs the runner bundles in.
 */

const PAGE = "page1" as Id<"pages">;

type Editor = typeof schema.BlockNoteEditor;

const pageDoc = new Y.Doc();
const editor = BlockNoteEditor.create(
  withCollaboration({
    schema,
    collaboration: {
      fragment: pageDoc.getXmlFragment("prosemirror"),
      user: { name: "Ada", color: "#3366cc" },
      provider: { awareness: new Awareness(pageDoc) },
    },
  } as never),
) as unknown as Editor;

let role: ProjectRole | null = "owner";
const roleListeners = new Set<() => void>();

/** The page on screen: the launch plan until the assistant opens another. */
let onScreen: Id<"pages"> = PAGE;
const pageListeners = new Set<() => void>();

// Bram's thread on the roadmap, from before this session.
void new CommentsStore(commentsFixture.roadmap(), {
  actor: { userId: "user_bram", kind: "human" },
  authorize: () => true,
}).createThread({
  anchor: { blockId: "r1", exact: "ship in Q3", prefix: "", suffix: "", offsetHint: 0 },
  body: "Is Q3 still realistic after the review?",
  authorId: "user_bram",
  threadId: "roadmap-t1",
  commentId: "roadmap-t1-c",
});

type ForkApi = { fork: () => void; merge: (opts: { keepChanges: boolean }) => void; store: { state: { isForked: boolean } } };
const forkApi = () => editor.getExtension("yForkDoc") as unknown as ForkApi;

type Mutation = { name: string; args: Record<string, unknown> };

declare global {
  var assistantHarness: {
    editor: Editor;
    seed: () => void;
    mutations: Mutation[];
    setRole: (next: ProjectRole | null) => void;
    fork: () => void;
    discard: () => void;
    isForked: () => boolean;
    setBlock: (id: string, text: string) => void;
    blockText: (id: string) => string;
    /** Bram, on his own replica, starting a thread the way his client would. */
    collaboratorThread: (input: { threadId: string; blockId: string; exact: string; text: string }) => Promise<void>;
    /** The collaborator's replica, read the way a card reads it. */
    peer: () => Array<{
      id: string;
      blockId: string;
      exact: string;
      prefix: string;
      suffix: string;
      status: string;
      ambiguous: boolean;
      resolvedBy?: string;
      comments: Array<{ id: string; author: string; text: string }>;
    }> | null;
    peerState: () => string | null;
    origins: () => Array<{ userId: string; kind: string; command: string }>;
    ensured: () => number;
    /** What the chat's `open` put on screen, in order — the workspace's navigation. */
    opened: string[];
    open: (pageId: string) => void;
    onScreen: () => string;
  };
}

globalThis.assistantHarness = {
  editor,
  seed: () =>
    void editor.replaceBlocks(editor.document, [
      { id: "h1", type: "heading", props: { level: 2 }, content: "Launch plan" },
      { id: "p1", type: "paragraph", content: "We will ship it by Friday if the review lands." },
      { id: "p2", type: "paragraph", content: "The cat sat on the mat and the dog sat on the log." },
    ]),
  mutations: [],
  setRole: (next) => {
    role = next;
    for (const listener of roleListeners) listener();
  },
  fork: () => forkApi().fork(),
  discard: () => forkApi().merge({ keepChanges: false }),
  isForked: () => forkApi().store.state.isForked,
  setBlock: (id, text) => editor.updateBlock(id, { content: text }),
  blockText: (id) => {
    const block = editor.getBlock(id);
    return (block?.content as Array<{ text?: string }> | undefined)?.map((run) => run.text ?? "").join("") ?? "";
  },
  collaboratorThread: async ({ threadId, blockId, exact, text }) => {
    const peer = commentsFixture.peer();
    if (!peer) throw new Error("no comments document yet");
    await new CommentsStore(peer, { actor: { userId: "user_bram", kind: "human" }, authorize: () => true }).createThread({
      anchor: { blockId, exact, prefix: "", suffix: "", offsetHint: 0 },
      body: text,
      authorId: "user_bram",
      threadId,
      commentId: `${threadId}-c`,
    });
  },
  peer: () => {
    const peer = commentsFixture.peer();
    return peer
      ? readThreads(peer).map((thread) => ({
          id: thread.id,
          blockId: thread.anchor.blockId,
          exact: thread.anchor.exact,
          prefix: thread.anchor.prefix,
          suffix: thread.anchor.suffix,
          status: thread.status,
          ambiguous: thread.ambiguous,
          ...(thread.resolvedBy ? { resolvedBy: thread.resolvedBy } : {}),
          comments: thread.comments.map((c) => ({ id: c.id, author: c.authorId, text: commentText(c.content) })),
        }))
      : null;
  },
  peerState: () => {
    const peer = commentsFixture.peer();
    return peer ? Array.from(Y.encodeStateVector(peer)).join(",") : null;
  },
  origins: () => commentsFixture.origins.map((o) => ({ userId: o.actor.userId, kind: o.actor.kind, command: o.command })),
  ensured: () => commentsFixture.ensured,
  opened: [],
  open: (pageId) => {
    globalThis.assistantHarness.opened.push(pageId);
    onScreen = pageId as Id<"pages">;
    for (const listener of pageListeners) listener();
  },
  onScreen: () => onScreen,
};

function useOnScreen() {
  return useSyncExternalStore(
    (listener) => {
      pageListeners.add(listener);
      return () => void pageListeners.delete(listener);
    },
    () => onScreen,
  );
}

function useRole() {
  return useSyncExternalStore(
    (listener) => {
      roleListeners.add(listener);
      return () => void roleListeners.delete(listener);
    },
    () => role,
  );
}

function Rail({ pageId }: { pageId: Id<"pages"> }) {
  const chat = useProjectChat({ threadId: "thread" as Id<"chatThreads">, projectId: "project" as Id<"projects">, pageId });
  const tools = chat.messages.flatMap((message) =>
    message.role === "assistant" ? message.parts.filter(isToolUIPart) : [],
  );
  return (
    <div id="rail">
      <output id="state">{!chat.ready ? "building" : chat.busy ? "busy" : "idle"}</output>
      <ChatComposer
        disabled={!chat.ready}
        busy={chat.busy}
        queued={chat.queued}
        projectId={"project" as Id<"projects">}
        pageId={pageId}
        onSend={async (draft) => void chat.send(draft)}
        onStop={chat.stop}
        onUnqueue={chat.unqueue}
      />
      <ol id="tools">
        {tools.map((part) => (
          <li
            key={part.toolCallId}
            data-call={part.toolCallId}
            data-tool={getToolName(part)}
            data-state={part.state}
          >
            {part.state === "output-available"
              ? String(part.output)
              : part.state === "output-error"
                ? part.errorText
                : ""}
          </li>
        ))}
      </ol>
    </div>
  );
}

function App() {
  const current = useRole();
  const page = useOnScreen();
  return (
    <PageCommentsRegistryProvider>
      <CommentAccessContext value={commentAccessFor(current)}>
        <main style={{ display: "flex", gap: 24 }}>
          <div style={{ width: 640, padding: 24 }}>
            {page === ROADMAP ? (
              <PageCommentsProvider key={page} pageId={page}>
                <p id="roadmap">We will ship in Q3.</p>
              </PageCommentsProvider>
            ) : (
              <PageCommentsProvider key={page} pageId={page}>
                <BlockNoteView editor={editor} theme="light" className="nt-editor" sideMenu={false} slashMenu={false} formattingToolbar={false} />
              </PageCommentsProvider>
            )}
          </div>
          <Rail pageId={page} />
        </main>
      </CommentAccessContext>
    </PageCommentsRegistryProvider>
  );
}

// Rendered last, so the globals the stubs read exist when the chat builds.
createRoot(document.getElementById("app")!).render(<App />);
