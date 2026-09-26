import { createRoot } from "react-dom/client";
import type { Id } from "../convex/_generated/dataModel";
import { ChatComposer } from "../app/components/chat/ChatComposer";
import { handlesFor } from "../app/components/editor/album/handle";
import { serializeAlbum } from "../app/components/editor/album/serialize";
import { useProjectChat } from "../app/lib/ai/chat/useProjectChat";

/**
 * NT-91 in the browser: the real `ChatComposer` over the real `useProjectChat`,
 * whose real `look_at` fetches an album's pictures from storage and answers the
 * turn with them. Only `/api/chat` is replaced, by a script this harness runs
 * one request at a time, so what each request CARRIES — the thing that grows
 * towards the request limit — is read off the wire the panel really built.
 */

type Chunk = Record<string, unknown>;
type Request = { body: { messages: { role: string; parts: Record<string, unknown>[] }[] }; size: number };

declare global {
  var lookAtHarness: {
    requests: Request[];
    /** Answers to give, in order, one list of stream chunks per request. */
    script: Chunk[][];
    /** What the thread saved, message by message. */
    saved: { uiId: string; parts: Record<string, unknown>[] }[];
    /** Puts an album on the open page, and says what the agent calls its pictures. */
    album: (srcs: string[]) => string[];
  };
}

let editor: { document: unknown[] } = { document: [] };

globalThis.lookAtHarness = {
  requests: [],
  script: [],
  saved: [],
  album: (srcs) => {
    const items = srcs.map((src) => ({ kind: "image" as const, src, w: 2560, h: 1707 }));
    editor = {
      document: [
        {
          id: "al1",
          type: "album",
          props: {
            data: serializeAlbum({ items }),
          },
          content: undefined,
          children: [],
        },
      ],
    };
    return handlesFor(items);
  },
};

// The registry `useProjectChat` asks for the open page's editor: the harness's
// stand-in document, which is all `look_at` reads of it.
(globalThis as unknown as { lookAtEditor: () => unknown }).lookAtEditor = () => editor;

function Rail() {
  const chat = useProjectChat({
    threadId: "thread" as Id<"chatThreads">,
    projectId: "project" as Id<"projects">,
    pageId: "page1" as Id<"pages">,
  });
  return (
    <div id="rail">
      <output id="state">{!chat.ready ? "building" : chat.busy ? "busy" : "idle"}</output>
      <ChatComposer
        disabled={!chat.ready}
        busy={chat.busy}
        queued={chat.queued}
        projectId={"project" as Id<"projects">}
        pageId={"page1" as Id<"pages">}
        onSend={async (draft) => void chat.send(draft)}
        onStop={chat.stop}
        onUnqueue={chat.unqueue}
      />
    </div>
  );
}

const encoder = new TextEncoder();

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!url.includes("/api/chat")) return nativeFetch(input, init);
  const body = String((init as RequestInit).body);
  globalThis.lookAtHarness.requests.push({ body: JSON.parse(body), size: body.length });
  const chunks = globalThis.lookAtHarness.script.shift() ?? [];
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
  });
};

createRoot(document.getElementById("app")!).render(<Rail />);
