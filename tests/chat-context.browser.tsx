import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { getToolName, isToolUIPart } from "ai";
import { getFunctionName, type FunctionReference } from "convex/server";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import type { Id } from "../convex/_generated/dataModel";
import { schema } from "../app/components/editor/schema";
import type { LiveEditor } from "../app/components/editor/EditorRegistry";
import { ReviewOverlay } from "../app/components/editor/ai/ReviewOverlay";
import { ReviewBar } from "../app/components/ReviewBar";
import { ChatComposer } from "../app/components/chat/ChatComposer";
import { useProjectChat } from "../app/lib/ai/chat/useProjectChat";
import { pendingHunks, ReviewSession } from "../app/lib/ai/review/session";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

/**
 * NT-98 in the browser: what a thread sends the model once it has grown. The
 * real `ChatComposer` — its @ menu included — over the real `useProjectChat`,
 * whose request is the one the route reads, runs the real `edit_page` through a
 * real `ReviewSession` onto the production editor on a Yjs page. Only the model
 * is replaced, by the runner's `/api/chat` script, and Convex, by an in-memory
 * stand-in that also holds the pen `find_places` writes its photographs to.
 */

const PAGE = "page1" as Id<"pages">;
const TITLE = "Launch plan";

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

const name = (ref: unknown) => getFunctionName(ref as FunctionReference<"query">);
const checkpoints = new Map<string, Record<string, unknown>>();
/** The holding pen, as the route's `find_places` leaves it (`ai/drawings:put`). */
const pen = new Map<string, string>();
const turnRows = new Map<string, Record<string, unknown>>();
const convex = {
  mutation: async (ref: unknown, args: Record<string, unknown>) => {
    switch (name(ref)) {
      case "ai/checkpoints:create": {
        const id = `checkpoint-${checkpoints.size}`;
        checkpoints.set(id, { _id: id, ...args });
        return id;
      }
      case "chat/turns:save":
        turnRows.set(args.chatPromptId as string, { ...args });
        return null;
      default:
        return null;
    }
  },
  query: async (ref: unknown, args: Record<string, unknown>) => {
    switch (name(ref)) {
      case "pages:get":
        return args.pageId === PAGE ? { _id: PAGE, projectId: "project", title: TITLE } : null;
      case "ai/checkpoints:get":
        return checkpoints.get(args.id as string) ?? null;
      case "chat/turns:byPrompt":
        return turnRows.get(args.chatPromptId as string) ?? null;
      case "ai/drawings:get":
        return Object.fromEntries(
          (args.refs as string[]).flatMap((ref) => (pen.has(ref) ? [[ref, pen.get(ref)!]] : [])),
        );
      default:
        throw new Error(`unexpected query ${name(ref)}`);
    }
  },
  action: async (ref: unknown) => {
    throw new Error(`unexpected action ${name(ref)}`);
  },
};

// As `ReviewProvider` builds it; the one open page is the only page.
const session = new ReviewSession({
  convex: convex as never,
  openPage: () => {},
  editorFor: async () => editor as unknown as LiveEditor,
});

type Row = { id: string; type: string; text: string };

declare global {
  var contextHarness: {
    editor: Editor;
    convex: typeof convex;
    session: ReviewSession;
    seed: () => void;
    /** What the route's `find_places` wrote before it answered. */
    pen: (ref: string, data: string) => void;
    /** A block's stored props, as the page keeps them. */
    props: (id: string) => Record<string, unknown> | undefined;
    /** The page as a person sees it: every block, its type and words. */
    blocks: () => Row[];
    /** Changes waiting on the review bar. */
    pending: () => number;
  };
}

/** Thirty paragraphs of plan: a page whose whole echo was some 18K characters. */
const PLAN = Array.from({ length: 30 }, (_, i) => ({
  id: `p${i}`,
  type: "paragraph" as const,
  content: `Step ${i}: ${"the team works through the launch checklist and writes down what it finds. ".repeat(7)}`,
}));

globalThis.contextHarness = {
  editor,
  convex,
  session,
  seed: () =>
    void editor.replaceBlocks(editor.document, [
      { id: "h1", type: "heading", props: { level: 2 }, content: "Launch plan" },
      ...PLAN,
    ]),
  pen: (ref, data) => void pen.set(ref, data),
  props: (id) => editor.document.find((block) => block.id === id)?.props as Record<string, unknown> | undefined,
  blocks: () =>
    editor.document
      .map((block) => ({
        id: block.id,
        type: block.type,
        text: Array.isArray(block.content)
          ? (block.content as Array<{ text?: string; content?: Array<{ text?: string }> }>)
              .map((run) => run.text ?? run.content?.map((c) => c.text ?? "").join("") ?? "")
              .join("")
          : "",
      }))
      // BlockNote keeps an empty trailing paragraph; it is no one's words.
      .filter((row, i, all) => !(i === all.length - 1 && row.type === "paragraph" && !row.text)),
  pending: () =>
    session
      .getSnapshot()
      .filter((turn) => session.isOpen(turn))
      .reduce((n, turn) => n + turn.pages.reduce((m, page) => m + pendingHunks(page).length, 0), 0),
};

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
          <li key={part.toolCallId} data-call={part.toolCallId} data-tool={getToolName(part)} data-state={part.state}>
            {part.state === "output-available" ? String(part.output).split("\n")[0] : part.state === "output-error" ? part.errorText : ""}
          </li>
        ))}
      </ol>
    </div>
  );
}

function App() {
  return (
    <main style={{ display: "flex", gap: 24 }}>
      <div style={{ width: 640, padding: 24 }}>
        <BlockNoteView editor={editor} theme="light" className="nt-editor" sideMenu={false} slashMenu={false} formattingToolbar={false} />
        <ReviewOverlay editor={editor as unknown as LiveEditor} pageId={PAGE} />
        <div id="bar">
          <ReviewBar />
        </div>
      </div>
      <Rail />
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
