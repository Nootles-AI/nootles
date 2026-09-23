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
import { commentsFixture } from "./comments-assistant.fixture";
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
};

function useRole() {
  return useSyncExternalStore(
    (listener) => {
      roleListeners.add(listener);
      return () => void roleListeners.delete(listener);
    },
    () => role,
  );
}

function Rail() {
  const chat = useProjectChat({ threadId: "thread" as Id<"chatThreads">, projectId: "project" as Id<"projects">, pageId: PAGE });
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
        pageId={PAGE}
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
  return (
    <PageCommentsRegistryProvider>
      <CommentAccessContext value={commentAccessFor(current)}>
        <main style={{ display: "flex", gap: 24 }}>
          <div style={{ width: 640, padding: 24 }}>
            <PageCommentsProvider pageId={PAGE}>
              <BlockNoteView editor={editor} theme="light" className="nt-editor" sideMenu={false} slashMenu={false} formattingToolbar={false} />
            </PageCommentsProvider>
          </div>
          <Rail />
        </main>
      </CommentAccessContext>
    </PageCommentsRegistryProvider>
  );
}

// Rendered last, so the globals the stubs read exist when the chat builds.
createRoot(document.getElementById("app")!).render(<App />);
