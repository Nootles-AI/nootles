import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Id } from "../convex/_generated/dataModel";
import { useProjectChat } from "../app/lib/ai/chat/useProjectChat";

type Phase = "shown" | "hidden" | "gone";

declare global {
  var chatVisibilityHarness: {
    phase: Phase;
    requestStarted: boolean;
    requestAborted: boolean;
    setPhase: (phase: Phase) => void;
    send: () => void;
  };
}

/**
 * The small end-to-end seam behind NT-61. A real `useProjectChat` owns a real
 * BrowserChat and its transport; the panel goes `hidden`, rather than leaving
 * the tree, while the response stream deliberately remains open.
 */
function ChatRail({ phase }: { phase: Exclude<Phase, "gone"> }) {
  const { ready, send } = useProjectChat({
    threadId: "thread" as Id<"chatThreads">,
    projectId: "project" as Id<"projects">,
    pageId: null,
  });

  useEffect(() => {
    globalThis.chatVisibilityHarness.send = () => {
      void send({ text: "Keep going while I work", attachments: [], mentions: [] });
    };
  }, [send]);

  return (
    <aside
      id="chat-rail"
      className={`nt-panel ${phase === "hidden" ? "hidden" : ""}`}
      hidden={phase === "hidden"}
    >
      {ready ? "ready" : "building"}
    </aside>
  );
}

function Fixture() {
  const [phase, setPhase] = useState<Phase>("shown");
  useEffect(() => {
    globalThis.chatVisibilityHarness.phase = phase;
    globalThis.chatVisibilityHarness.setPhase = setPhase;
  }, [phase]);
  return phase === "gone" ? null : <ChatRail phase={phase} />;
}

globalThis.chatVisibilityHarness = {
  phase: "shown",
  requestStarted: false,
  requestAborted: false,
  setPhase: () => {},
  send: () => {},
};

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
  const signal = (init as RequestInit | undefined)?.signal;
  globalThis.chatVisibilityHarness.requestStarted = true;
  signal?.addEventListener("abort", () => {
    globalThis.chatVisibilityHarness.requestAborted = true;
  });

  // It intentionally never closes: the assertion is about the live abort
  // signal, not an answer that happened to finish before the rail was hidden.
  return new Response(new ReadableStream<Uint8Array>({ start: () => {} }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};

window.addEventListener("beforeunload", () => {
  globalThis.fetch = nativeFetch;
});

createRoot(document.getElementById("app")!).render(<Fixture />);
