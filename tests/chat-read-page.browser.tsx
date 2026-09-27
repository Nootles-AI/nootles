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
import { ChatComposer } from "../app/components/chat/ChatComposer";
import { useProjectChat } from "../app/lib/ai/chat/useProjectChat";
import { ReviewSession } from "../app/lib/ai/review/session";
import { serializeScene } from "../app/components/editor/canvas/scene/serialize";
import type { SceneNode } from "../app/components/editor/canvas/scene/types";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

/**
 * NT-94 in the browser: what the chat's `read_page` hands the model when it
 * expands one block of a long page. The real `ChatComposer` over the real
 * `useProjectChat` runs the real `read_page` against the production editor on
 * a Yjs page holding a long run of notes, two diagrams and an album. Only the
 * model is replaced, by the runner's `/api/chat` script, and Convex, by an
 * in-memory stand-in answering the tool's calls by name.
 */

const PAGE = "page1" as Id<"pages">;
const TITLE = "Field notes";

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

/** One meeting note: ~620 characters, so the page is ~75K — three reads' worth. */
const note = (n: number) => `Note ${n}. ${"The team walked the site and wrote it down. ".repeat(14)}`;

/** A board of 150 labelled boxes: a stub of about 2K, about 20K read whole. */
function board(name: string): string {
  const nodes: SceneNode[] = Array.from({ length: 150 }, (_, i) => ({
    id: `${name}${i}`,
    kind: "rect",
    x: (i % 15) * 110,
    y: Math.floor(i / 15) * 50,
    w: 100,
    h: 40,
    rot: 0,
    label: `${name} ${i}`,
    locked: false,
    hidden: false,
    attrs: {},
    style: { background: "#f4f4f4", "border-radius": "8px" },
  }));
  return serializeScene({ w: 1650, h: 500, style: {}, nodes, edges: [], attrs: {} });
}

declare global {
  var readPageHarness: {
    editor: Editor;
    convex: typeof convex;
    session: ReviewSession;
    seed: () => void;
    /** Top-level block ids and types, in order. */
    blocks: () => Array<{ id: string; type: string }>;
  };
}

globalThis.readPageHarness = {
  editor,
  convex,
  session,
  seed: () =>
    void editor.replaceBlocks(editor.document, [
      { id: "h1", type: "heading", props: { level: 2 }, content: TITLE },
      { id: "n0", type: "paragraph", content: note(0) },
      { id: "d1", type: "canvas", props: { data: board("Top") } },
      { id: "a1", type: "album", props: { data: "" } },
      ...Array.from({ length: 90 }, (_, i) => ({ id: `n${i + 1}`, type: "paragraph", content: note(i + 1) })),
      { id: "d9", type: "canvas", props: { data: board("Lower") } },
      ...Array.from({ length: 30 }, (_, i) => ({ id: `n${i + 91}`, type: "paragraph", content: note(i + 91) })),
    ] as never),
  blocks: () => editor.document.map((block) => ({ id: block.id, type: block.type })),
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
      <div style={{ width: 640, padding: 24, height: 860, overflow: "auto" }}>
        <BlockNoteView editor={editor} theme="light" className="nt-editor" sideMenu={false} slashMenu={false} formattingToolbar={false} />
      </div>
      <Rail />
    </main>
  );
}

createRoot(document.getElementById("app")!).render(<App />);
