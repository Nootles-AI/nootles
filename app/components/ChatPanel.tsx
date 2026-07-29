"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ChevronsUpDown, PanelRight, Plus } from "./Icons";
import { ChatComposer } from "./chat/ChatComposer";
import { ChatTranscript } from "./chat/ChatTranscript";
import { ThreadPicker } from "./chat/ThreadPicker";
import { useProjectChat } from "@/app/lib/ai/chat/useProjectChat";

export function ChatPanel({
  width,
  projectId,
  pageId,
  onCollapse,
}: {
  width: number;
  projectId: Id<"projects">;
  pageId: Id<"pages"> | null;
  onCollapse: () => void;
}) {
  const threads = useQuery(api.chat.threads.list, { projectId });
  const createThread = useMutation(api.chat.threads.create);

  const [picked, setPicked] = useState<Id<"chatThreads"> | null>(null);
  const [picking, setPicking] = useState(false);

  // Derived during render, like Workspace's effective page: a thread the user
  // picked, unless it has since been deleted, in which case the newest one.
  const threadId =
    picked && threads?.some((t) => t._id === picked)
      ? picked
      : (threads?.[0]?._id ?? null);

  const chat = useProjectChat({ threadId, pageId, mode: "agent" });

  /**
   * A message typed before any thread existed. Creating the thread is async and
   * re-keys the chat, so the text waits here for one render rather than being
   * sent to a chat that is about to be replaced.
   */
  const queued = useRef<string | null>(null);
  const { ready, send, nameThreadFrom } = chat;

  useEffect(() => {
    const text = queued.current;
    if (!text || !threadId || !ready) return;
    queued.current = null;
    nameThreadFrom(text);
    void send(text);
  }, [threadId, ready, send, nameThreadFrom]);

  const active = threads?.find((t) => t._id === threadId);

  const onSend = async (text: string) => {
    if (!threadId) {
      queued.current = text;
      setPicked(await createThread({ projectId }));
      return;
    }
    // Only the first question names the thread; later ones must not rewrite it.
    if (!active?.title) nameThreadFrom(text);
    void send(text);
  };
  const busy = chat.status === "submitted" || chat.status === "streaming";

  return (
    <aside style={{ width }} className="ab-panel relative" aria-label="Chat">
      <div className="ab-panel-head">
        <button
          className="ab-row min-w-0 flex-1"
          onClick={() => setPicking((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={picking}
          title="Switch chat"
        >
          <span className="ab-row-label">{active?.title || "New chat"}</span>
          <ChevronsUpDown width={13} height={13} className="shrink-0 text-muted" />
        </button>
        <button
          onClick={() => {
            setPicked(null);
            queued.current = null;
            void createThread({ projectId }).then(setPicked);
          }}
          aria-label="New chat"
          title="New chat"
          className="ab-icon-btn"
        >
          <Plus />
        </button>
        <button
          onClick={onCollapse}
          aria-label="Collapse chat"
          title="Collapse chat"
          className="ab-icon-btn"
        >
          <PanelRight />
        </button>
      </div>

      {picking && (
        <ThreadPicker
          threads={threads ?? []}
          activeId={threadId}
          onPick={setPicked}
          onClose={() => setPicking(false)}
        />
      )}

      <ChatTranscript messages={chat.messages} busy={busy} error={chat.error} />

      <ChatComposer
        disabled={!chat.ready}
        busy={busy}
        onSend={onSend}
        onStop={chat.stop}
      />
    </aside>
  );
}
