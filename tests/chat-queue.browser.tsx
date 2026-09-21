import { createRoot } from "react-dom/client";
import type { Id } from "../convex/_generated/dataModel";
import { ChatComposer } from "../app/components/chat/ChatComposer";
import { useProjectChat } from "../app/lib/ai/chat/useProjectChat";

/**
 * NT-21, in the two production pieces the feature lives in: the real
 * `ChatComposer` over a real `useProjectChat`, its real `BrowserChat` and the
 * SDK's real transport. Only `/api/chat` is replaced, by a stream this harness
 * opens and closes by hand — so "the turn is still running" is a real open
 * request, and Chromium's own keystrokes do the asking.
 */

type Turn = {
  body: { messages: { role: string; parts: { type: string; text?: string }[] }[] };
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  aborted: boolean;
  finished: boolean;
};

declare global {
  var chatQueueHarness: {
    turns: Turn[];
    /** Ends turn `index` the way a finished answer does. */
    finish: (index: number) => void;
    /** The last user message each request carried, in order. */
    asked: () => string[];
    aborted: () => number;
  };
}

function Rail() {
  const chat = useProjectChat({
    threadId: "thread" as Id<"chatThreads">,
    projectId: "project" as Id<"projects">,
    pageId: "page1" as Id<"pages">,
  });

  return (
    <div id="rail">
      <output id="state">
        {!chat.ready ? "building" : chat.busy ? "busy" : "idle"}
      </output>
      <ChatComposer
        disabled={!chat.ready}
        busy={chat.busy}
        queued={chat.queued}
        projectId={"project" as Id<"projects">}
        pageId={"page1" as Id<"pages">}
        // As `ChatPanel` hands it over: `send` resolves only when the whole
        // turn does, and the composer clears the box on the promise it is given.
        onSend={async (draft) => void chat.send(draft)}
        onStop={chat.stop}
        onUnqueue={chat.unqueue}
      />
    </div>
  );
}

const encoder = new TextEncoder();
const frame = (chunk: unknown) => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);

const turns: Turn[] = [];

globalThis.chatQueueHarness = {
  turns,
  finish: (index) => {
    const turn = turns[index];
    if (!turn?.controller || turn.finished) return;
    turn.finished = true;
    for (const chunk of [
      { type: "start" },
      { type: "start-step" },
      { type: "text-start", id: "t0" },
      { type: "text-delta", id: "t0", delta: "Done." },
      { type: "text-end", id: "t0" },
      { type: "finish-step" },
      { type: "finish" },
    ]) {
      turn.controller.enqueue(frame(chunk));
    }
    turn.controller.enqueue(encoder.encode("data: [DONE]\n\n"));
    turn.controller.close();
  },
  asked: () =>
    turns.map((turn) => {
      const last = turn.body.messages[turn.body.messages.length - 1];
      return last?.parts.find((part) => part.type === "text")?.text ?? "";
    }),
  aborted: () => turns.filter((turn) => turn.aborted).length,
};

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!url.includes("/api/chat")) return nativeFetch(input, init);

  const request = init as RequestInit;
  const turn: Turn = {
    body: JSON.parse(String(request.body)),
    controller: null,
    aborted: false,
    finished: false,
  };
  turns.push(turn);

  // Opened and left open: the assertions are about a turn that is genuinely
  // still running, not one that happened to end before the next keystroke.
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      turn.controller = controller;
    },
  });
  request.signal?.addEventListener("abort", () => {
    turn.aborted = true;
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "x-vercel-ai-ui-message-stream": "v1",
    },
  });
};

window.addEventListener("beforeunload", () => {
  globalThis.fetch = nativeFetch;
});

// Rendered last, so the harness's globals and its `/api/chat` are already in
// place when the chat builds its transport.
createRoot(document.getElementById("app")!).render(<Rail />);
