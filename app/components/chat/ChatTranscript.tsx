"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ConfirmDelete } from "@/app/components/ConfirmDelete";
import { ArrowLeft, Paperclip } from "@/app/components/Icons";
import { Menu, MenuItem } from "@/app/components/Menu";
import type { PendingApproval } from "@/app/lib/ai/chat/BrowserChat";
import type { AbMessage } from "@/app/lib/ai/chat/types";
import type { DrawChoice } from "@/app/lib/ai/drawStyles";
import { retryNotice } from "@/app/lib/ai/chat/retryNotice";
import { DrawStylePicker } from "./DrawStylePicker";
import { Markdown } from "./Markdown";
import { isWorking, planTurn } from "./steps";
import { Trace } from "./Trace";

/**
 * The conversation.
 *
 * Assistant turns are unadorned prose in the document's own voice — no bubble,
 * no avatar — so the panel reads as part of the surface rather than as a chat
 * app bolted to its side. Only the user's turns get a container, which is what
 * makes the alternation legible without decoration.
 */
export function ChatTranscript({
  messages,
  busy,
  approvals,
  projectId,
  threadId,
  onAnswerApproval,
  onAnswerDraws,
  rewinding,
  onRewind,
  onRewindCancel,
  onRewindCommit,
  error,
}: {
  messages: AbMessage[];
  busy: boolean;
  approvals: PendingApproval[];
  projectId: Id<"projects">;
  threadId: Id<"chatThreads"> | null;
  onAnswerApproval: (approved: boolean) => void;
  onAnswerDraws: (choice: DrawChoice | null) => void;
  /** The message being rewound to, held open while it is decided. */
  rewinding: string | null;
  onRewind: (message: AbMessage, what: RewindScope) => void;
  onRewindCancel: () => void;
  onRewindCommit: (text: string) => void;
  error?: Error;
}) {
  const restorable = useQuery(
    api.chat.turns.restorable,
    threadId ? { threadId } : "skip",
  );
  const endRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // The rows below sit out a render only if everything handed to them is
  // unchanged, and a fresh closure per stream chunk is exactly what would stop
  // them — so the callbacks are read late instead of captured.
  const latest = useRef({ onRewind, onRewindCancel, onRewindCommit });
  useEffect(() => {
    latest.current = { onRewind, onRewindCancel, onRewindCommit };
  });
  const rewindTo = useCallback(
    (message: AbMessage, what: RewindScope) =>
      latest.current.onRewind(message, what),
    [],
  );
  const cancelRewind = useCallback(() => latest.current.onRewindCancel(), []);
  const commitRewind = useCallback(
    (text: string) => latest.current.onRewindCommit(text),
    [],
  );

  // Follow the stream, but only when already at the bottom: yanking someone
  // back down while they are reading an earlier answer is worse than not
  // following at all.
  //
  // A message you just sent is the exception, and the distance check was
  // swallowing it — ask a question while scrolled up and you were left looking
  // at old answers with no sign yours had gone anywhere. Sending is a
  // deliberate act, so it always wins; the distance rule is for tokens that
  // arrive on their own.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const mine = messages[messages.length - 1]?.role === "user";
    const distance =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (mine || distance < 120) endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  if (!messages.length) {
    return (
      <div className="nt-transcript-empty flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
        <p className="text-sm font-medium">Ask about this project</p>
        <p className="max-w-[28ch] text-[13px] text-muted">
          Questions are answered from what the pages actually say.
        </p>
      </div>
    );
  }

  // Everything from the rewind point on is on its way out, and says so rather
  // than vanishing early: what is about to be lost is exactly what the decision
  // is about.
  const from = rewinding ? messages.findIndex((m) => m.id === rewinding) : -1;

  // Two questions can be pending, each with its own card: a salvo of drawings
  // waiting on one style, and anything graver waiting to be allowed at all.
  const drawApprovals = approvals.filter((a) => a.toolName === "draw");
  const otherApproval = approvals.find((a) => a.toolName !== "draw") ?? null;

  return (
    <div ref={scrollerRef} className="nt-transcript">
      {messages.map((message, index) => (
        <MessageRow
          key={message.id}
          message={message}
          dropping={from >= 0 && index > from}
          live={busy && index === messages.length - 1}
          drafting={message.id === rewinding}
          rewindable={message.role === "user" && !busy && !rewinding}
          pageCount={
            message.role === "user"
              ? pagesChangedBy(restorable, message.metadata?.chatPromptId)
              : 0
          }
          onRewind={rewindTo}
          onRewindCancel={cancelRewind}
          onRewindCommit={commitRewind}
        />
      ))}

      {drawApprovals.length > 0 && (
        <DrawStylePicker count={drawApprovals.length} onAnswer={onAnswerDraws} />
      )}
      {otherApproval ? (
        <DeleteApproval
          projectId={projectId}
          input={otherApproval.input}
          onAnswer={onAnswerApproval}
        />
      ) : (
        // Only when nothing else is already saying what is happening. A step
        // still running says it better, and both at once read as two things
        // going on when there is one.
        busy &&
        !drawApprovals.length &&
        !messages[messages.length - 1]?.parts.some(isWorking) && (
          <div className="nt-turn-pending" role="status">
            <span className="nt-pending-bead" aria-hidden>
              <span className="nt-thinking-dot" />
            </span>
            Thinking…
          </div>
        )
      )}
      {error && (
        <div className="nt-turn-error">{retryNotice(error.message) ?? error.message}</div>
      )}
      <div ref={endRef} />
    </div>
  );
}

/**
 * One turn.
 *
 * Memoized, and the only reason the panel survives a long thread: a stream
 * writes the assistant message several times a second, and every turn above it
 * would otherwise re-run this markdown parser from scratch each time. The store
 * replaces one message and keeps the rest, so identity is what says a turn has
 * nothing new to say.
 */
const MessageRow = memo(function MessageRow({
  message,
  dropping,
  live,
  drafting,
  rewindable,
  pageCount,
  onRewind,
  onRewindCancel,
  onRewindCommit,
}: {
  message: AbMessage;
  /** On its way out with a rewind that has not been confirmed yet. */
  dropping: boolean;
  /** The turn still being written. */
  live: boolean;
  /** This is the message the rewind winds back to, open for editing. */
  drafting: boolean;
  rewindable: boolean;
  pageCount: number;
  onRewind: (message: AbMessage, what: RewindScope) => void;
  onRewindCancel: () => void;
  onRewindCommit: (text: string) => void;
}) {
  return (
    <div className={`nt-turn is-${message.role}${dropping ? " is-dropping" : ""}`}>
      {drafting ? (
        <RewindDraft
          initial={textOf(message)}
          onCancel={onRewindCancel}
          onCommit={onRewindCommit}
        />
      ) : (
        message.role === "assistant" ? (
          <AssistantTurn parts={message.parts} live={live} />
        ) : (
          message.parts.map((part, i) => {
            if (part.type === "text") {
              // A question is shown as it was typed — someone who wrote an
              // asterisk meant an asterisk, and reformatting their own words
              // back at them is the one place this would be wrong.
              return (
                <p key={i} className="nt-turn-text">
                  {part.text}
                </p>
              );
            }
            // What came with the question. A mention keeps its "@" because
            // that is how it was written; a file gets the clip it was
            // attached with.
            if (part.type === "data-mention") {
              const { data } = part;
              return (
                <span key={i} className="nt-chip">
                  @{data.kind === "page" ? data.title.trim() || "Untitled" : data.filename}
                </span>
              );
            }
            if (part.type === "data-attachment") {
              return <FileChip key={i} filename={part.data.filename} />;
            }
            // An image lives in storage rather than in the message, so the
            // chip is the way back to it.
            if (part.type === "file") {
              return (
                <FileChip key={i} filename={part.filename ?? "Image"} href={part.url} />
              );
            }
            return null;
          })
        )
      )}
      {rewindable && (
        <Rewind pageCount={pageCount} onRewind={(what) => onRewind(message, what)} />
      )}
    </div>
  );
});

/**
 * An answer and the work behind it. The work folds away once there is an
 * answer to read and enough of it to be worth folding — a turn that read one
 * page and replied has nothing to hide.
 */
function AssistantTurn({ parts, live }: { parts: AbMessage["parts"]; live: boolean }) {
  const { trace, answer } = planTurn(parts);
  const foldable = answer.length > 0 && trace.length >= FOLD_AT;
  return (
    <>
      <Trace trace={trace} live={live} foldable={foldable} />
      {answer.length > 0 && (
        <div className="nt-answer">
          {answer.map((part) => (
            <Markdown key={part.key} text={part.text} />
          ))}
        </div>
      )}
    </>
  );
}

/** How much work a turn shows before it folds behind its answer. */
const FOLD_AT = 3;

/**
 * The question, open for editing, with the rewind already showing.
 *
 * Nothing here is committed. The pages have been rolled back so they can be
 * looked at, the exchange below is greyed rather than gone, and both are only
 * made real by the button on the right. Losing focus is not an answer — people
 * click into the document to read what the rewind did, and a state that
 * collapsed when they did would be unusable for the one thing it is for.
 */
function RewindDraft({
  initial,
  onCancel,
  onCommit,
}: {
  initial: string;
  onCancel: () => void;
  onCommit: (text: string) => void;
}) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(initial.length, initial.length);
  }, [initial]);

  // Grown to fit rather than scrolled: the message was readable whole a moment
  // ago and editing it should not be the thing that hides half of it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  return (
    <div className="nt-rewind-draft">
      <textarea
        ref={ref}
        className="nt-rewind-input"
        value={text}
        rows={1}
        aria-label="Edit this message and rewind to it"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onCommit(text);
          }
        }}
      />
      <div className="nt-rewind-actions">
        <button className="nt-rewind-action" onClick={onCancel}>
          Cancel
        </button>
        {/* One button, and it says what it will do. Emptying the box is how you
            say "put it back and ask nothing" — the rewind still happens. */}
        <button className="nt-rewind-action is-primary" onClick={() => onCommit(text)}>
          {text.trim() ? "Send" : "Rewind"}
        </button>
      </div>
    </div>
  );
}

/**
 * "Put things back to just before I asked this."
 *
 * Sits under the question rather than the answer, because that is what it winds
 * back to. Every question has one — a thread can always lose its last exchange
 * — but only a question that changed a page offers to undo the pages, so the
 * choice on offer is the choice that exists.
 */
function Rewind({
  pageCount,
  onRewind,
}: {
  pageCount: number;
  onRewind: (what: RewindScope) => void;
}) {
  const pages = pageCount === 1 ? "the page" : `all ${pageCount} pages`;
  // Undoing pages is offered only where there are pages to undo. A question
  // that changed nothing therefore has exactly one thing it can do, and a menu
  // to choose it from would be a click asking permission to do the obvious.
  if (!pageCount) {
    return (
      <button
        className="nt-rewind"
        onClick={() => onRewind("conversation")}
        title="Take this message back — it changed no notes"
      >
        <ArrowLeft width={11} height={11} />
        Rewind
      </button>
    );
  }

  const options: { scope: RewindScope; label: string; hint: string }[] = [
    { scope: "both", label: "Notes and conversation", hint: `Undo ${pages}, drop this exchange` },
    { scope: "conversation", label: "Conversation only", hint: "Drop this exchange, keep the notes" },
    { scope: "notes", label: "Notes only", hint: `Undo ${pages}, keep the conversation` },
  ];

  return (
    <Menu
      side="bottom"
      label="Rewind to before this message"
      trigger={(props) => (
        <button {...props} className="nt-rewind">
          <ArrowLeft width={11} height={11} />
          Rewind
        </button>
      )}
    >
      {(close) =>
        options.map((option) => (
          <MenuItem
            key={option.scope}
            onClick={() => {
              close();
              onRewind(option.scope);
            }}
          >
            <span className="nt-menu-stack">
              <span>{option.label}</span>
              <span className="nt-menu-hint">{option.hint}</span>
            </span>
          </MenuItem>
        ))
      }
    </Menu>
  );
}

export type RewindScope = "both" | "conversation" | "notes";

/**
 * What was typed, out of a message that also carries what came with it.
 *
 * Only the text is editable: a mention stands for a page as it was when the
 * question was asked, and an attachment lives in storage — neither survives
 * being turned back into characters in a box.
 */
function textOf(message: AbMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

/**
 * How many pages this message changed, and so whether undoing them is on offer.
 * A turn that failed left nothing behind to undo, whatever it touched on the
 * way.
 */
function pagesChangedBy(
  turns: { chatPromptId: string; pageCount: number; status: string }[] | undefined,
  chatPromptId: string | undefined,
): number {
  if (!chatPromptId) return 0;
  const turn = turns?.find((t) => t.chatPromptId === chatPromptId);
  return turn && turn.status !== "failed" ? turn.pageCount : 0;
}

function FileChip({ filename, href }: { filename: string; href?: string }) {
  const inside = (
    <>
      <Paperclip width={11} height={11} className="shrink-0 text-muted" />
      <span className="nt-chip-label">{filename}</span>
    </>
  );
  return href ? (
    <a className="nt-chip" href={href} target="_blank" rel="noreferrer" title={filename}>
      {inside}
    </a>
  ) : (
    <span className="nt-chip" title={filename}>
      {inside}
    </span>
  );
}

/**
 * The agent asking to delete a page.
 *
 * It goes where the request was made rather than in a modal over the document:
 * the reason to allow it is the conversation above it, and the turn is held
 * open behind this — nothing is sent, and nothing runs, until it is answered.
 *
 * Draw calls also pause for approval, but they ask a different question and get
 * their own card (the style picker); this one takes whatever else is pending —
 * today that is only `delete_page`.
 */
function DeleteApproval({
  projectId,
  input,
  onAnswer,
}: {
  projectId: Id<"projects">;
  input: unknown;
  onAnswer: (approved: boolean) => void;
}) {
  const pages = useQuery(api.pages.listByProject, { projectId });
  const pageId = (input as { pageId?: string } | undefined)?.pageId;
  const page = pages?.find((p) => p._id === pageId);

  return (
    // An alert rather than a dialog: it is announced the moment it appears, and
    // it claims none of the modality — focus trap, backdrop — that it does not
    // have. Nothing is focused for you; the destructive button is not one to
    // land on while reading.
    <div role="alert" className="nt-turn-confirm">
      <ConfirmDelete
        // Named where we can name it. A page the project does not have is worth
        // saying plainly, since approving it is then certainly a mistake.
        what={page ? `“${page.title || "Untitled"}”` : "a page that is not in this project"}
        onCancel={() => onAnswer(false)}
        onConfirm={() => onAnswer(true)}
      />
    </div>
  );
}


