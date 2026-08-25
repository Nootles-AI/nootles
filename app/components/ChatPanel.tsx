"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ChevronsUpDown, PanelRight, Plus } from "./Icons";
import { ChatComposer } from "./chat/ChatComposer";
import { ChatReviewBar } from "./chat/ChatReviewBar";
import { ChatTranscript, type RewindScope } from "./chat/ChatTranscript";
import { ThreadPicker } from "./chat/ThreadPicker";
import { useReview } from "./ReviewContext";
import { useProjectChat, type ChatDraft } from "@/app/lib/ai/chat/useProjectChat";
import type { AbMessage } from "@/app/lib/ai/chat/types";
import type { ReturnPoint } from "@/app/lib/ai/review/session";

export function ChatPanel({
  width,
  projectId,
  pageId,
  onCollapse,
}: {
  /** A CSS width — the shell holds the rail's live one in a custom property. */
  width: string;
  projectId: Id<"projects">;
  pageId: Id<"pages"> | null;
  onCollapse: () => void;
}) {
  const threads = useQuery(api.chat.threads.list, { projectId });
  const review = useReview();
  const createThread = useMutation(api.chat.threads.create);

  const [picked, setPicked] = useState<Id<"chatThreads"> | null>(null);
  const [picking, setPicking] = useState(false);
  /**
   * A rewind being decided: which message it winds back to, what it covers, and
   * where each page stood before it was previewed. Nothing here has happened to
   * the conversation yet — only the pages have moved, and `points` is the way
   * back from that.
   */
  const [rewind, setRewind] = useState<{
    uiId: string;
    scope: RewindScope;
    points: ReturnPoint[];
  } | null>(null);

  // Derived during render, like Workspace's effective page: a thread the user
  // picked, unless it has since been deleted, in which case the newest one.
  const threadId =
    picked && threads?.some((t) => t._id === picked)
      ? picked
      : (threads?.[0]?._id ?? null);

  const chat = useProjectChat({ threadId, projectId, pageId });

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

  /**
   * Show the rewind. The pages roll back so they can be read, the exchange
   * below greys out, and the question opens for editing — but the thread is not
   * touched until it is confirmed.
   *
   * "Notes only" keeps the conversation, so there is no message to edit and
   * nothing to confirm in: it just happens.
   */
  const startRewind = async (message: AbMessage, scope: RewindScope) => {
    const promptId = message.metadata?.chatPromptId;
    if (scope === "notes") {
      if (promptId) void review.restoreCheckpoint(promptId);
      return;
    }
    const points =
      scope === "both" && promptId ? await review.previewRestore(promptId) : [];
    setRewind({ uiId: message.id, scope, points });
  };

  const cancelRewind = async () => {
    if (!rewind) return;
    setRewind(null);
    if (rewind.points.length) await review.cancelRestore(rewind.points);
  };

  /**
   * Make it real: record that the turn was undone, drop this message and
   * everything after it, and ask again if anything was left in the box. An
   * empty box is a rewind and nothing more, which is how "put it back and stop"
   * is said.
   */
  const commitRewind = async (text: string) => {
    if (!rewind) return;
    const message = chat.messages.find((m) => m.id === rewind.uiId);
    const promptId = message?.metadata?.chatPromptId;
    setRewind(null);
    if (rewind.scope === "both" && promptId) await review.settleRestore(promptId);
    await chat.rewind(rewind.uiId);
    const asked = text.trim();
    if (asked) void onSend({ text: asked, attachments: [], mentions: [] });
  };

  return (
    <aside style={{ width }} className="nt-panel relative nt-rail-r" aria-label="Chat">
      <div className="nt-panel-head">
        <button
          className="nt-row min-w-0 flex-1"
          onClick={() => setPicking((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={picking}
          title="Switch chat"
        >
          <span className="nt-row-label">{active?.title || "New chat"}</span>
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
          className="nt-icon-btn"
        >
          <Plus />
        </button>
        <button
          onClick={onCollapse}
          aria-label="Collapse chat"
          title="Collapse chat"
          className="nt-icon-btn"
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
        approvals={chat.approvals}
        projectId={projectId}
        threadId={threadId}
        onAnswerApproval={chat.answerApproval}
        onAnswerDraws={chat.answerDraws}
        rewinding={rewind?.uiId ?? null}
        onRewind={(message, what) => void startRewind(message, what)}
        onRewindCancel={() => void cancelRewind()}
        onRewindCommit={(text) => void commitRewind(text)}
        error={chat.error}
      />

      {/* Between the transcript and the box: it answers what you have just read,
          and it is the last thing passed on the way to asking the next thing. */}
      <ChatReviewBar threadId={threadId} />

      <ChatComposer
        disabled={!chat.ready}
        busy={chat.busy}
        projectId={projectId}
        pageId={pageId}
        onSend={onSend}
        onStop={chat.stop}
      />
    </aside>
  );
}

/** A thread is named after what was asked — or, asked nothing, after what came. */
function titleFor(draft: ChatDraft): string {
  return draft.text || draft.attachments[0]?.filename || "";
}
