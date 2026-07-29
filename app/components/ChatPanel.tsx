"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ChevronsUpDown, PanelRight, Plus } from "./Icons";
import { ChatComposer } from "./chat/ChatComposer";
import { ChatTranscript } from "./chat/ChatTranscript";
import { ThreadPicker } from "./chat/ThreadPicker";
import { useReview } from "./ReviewContext";
import { useProjectChat, type ChatDraft } from "@/app/lib/ai/chat/useProjectChat";
import type { AbMessage, ChatMode } from "@/app/lib/ai/chat/types";

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
  const review = useReview();
  const createThread = useMutation(api.chat.threads.create);

  const [picked, setPicked] = useState<Id<"chatThreads"> | null>(null);
  const [picking, setPicking] = useState(false);
  const [mode, setMode] = useState<ChatMode>("agent");
  /** The last message a rewind handed back, and how many have been handed back. */
  const [restored, setRestored] = useState({ text: "", n: 0 });

  // Derived during render, like Workspace's effective page: a thread the user
  // picked, unless it has since been deleted, in which case the newest one.
  const threadId =
    picked && threads?.some((t) => t._id === picked)
      ? picked
      : (threads?.[0]?._id ?? null);

  const chat = useProjectChat({ threadId, projectId, pageId, mode });

  /**
   * A message written before any thread existed. Creating the thread is async
   * and re-keys the chat, so the draft waits here for one render rather than
   * being sent to a chat that is about to be replaced.
   */
  const queued = useRef<ChatDraft | null>(null);
  const { ready, send, nameThreadFrom } = chat;

  useEffect(() => {
    const draft = queued.current;
    if (!draft || !threadId || !ready) return;
    queued.current = null;
    nameThreadFrom(titleFor(draft));
    void send(draft);
  }, [threadId, ready, send, nameThreadFrom]);

  const active = threads?.find((t) => t._id === threadId);

  const onSend = async (draft: ChatDraft) => {
    if (!threadId) {
      queued.current = draft;
      setPicked(await createThread({ projectId }));
      return;
    }
    // Only the first question names the thread; later ones must not rewrite it.
    if (!active?.title) nameThreadFrom(titleFor(draft));
    void send(draft);
  };

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

      <ChatTranscript
        messages={chat.messages}
        busy={chat.busy}
        approval={chat.approval}
        projectId={projectId}
        threadId={threadId}
        onAnswerApproval={chat.answerApproval}
        onRewind={(message, what) => {
          // Pages first: rewinding them needs the turn this message started, and
          // dropping the message is what takes that record away.
          const promptId = message.metadata?.chatPromptId;
          const notes =
            what !== "conversation" && promptId
              ? review.restoreCheckpoint(promptId)
              : Promise.resolve();
          void notes.then(async () => {
            if (what === "notes") return;
            await chat.rewind(message.id);
            // Handed back rather than thrown away: a rewind is almost always
            // the first half of asking again, differently.
            setRestored((prior) => ({ text: textOf(message), n: prior.n + 1 }));
          });
        }}
        error={chat.error}
      />

      {/* Re-keyed so a rewound message becomes the draft: the composer owns the
          text from the moment it mounts, and this is how it is handed a new one
          without a second source of truth for what is written. */}
      <ChatComposer
        key={restored.n}
        initialText={restored.text}
        disabled={!chat.ready}
        busy={chat.busy}
        mode={mode}
        projectId={projectId}
        pageId={pageId}
        onModeChange={setMode}
        onSend={onSend}
        onStop={chat.stop}
      />
    </aside>
  );
}

/**
 * What was typed, out of a message that also carries what came with it.
 *
 * Only the text: a mention is a chip standing for a page as it was when the
 * question was asked, and an attachment lives in storage — neither survives
 * being pasted back into a box as characters.
 */
function textOf(message: AbMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/** A thread is named after what was asked — or, asked nothing, after what came. */
function titleFor(draft: ChatDraft): string {
  return draft.text || draft.attachments[0]?.filename || "";
}
