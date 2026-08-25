"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  getToolName,
  isToolUIPart,
  type DynamicToolUIPart,
  type ToolUIPart,
} from "ai";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ConfirmDelete } from "@/app/components/ConfirmDelete";
import { ArrowLeft, Paperclip } from "@/app/components/Icons";
import { Menu, MenuItem } from "@/app/components/Menu";
import type { PendingApproval } from "@/app/lib/ai/chat/BrowserChat";
import type { AbMessage } from "@/app/lib/ai/chat/types";
import type { DrawChoice } from "@/app/lib/ai/drawStyles";
import { DrawStylePicker } from "./DrawStylePicker";
import { Markdown } from "./Markdown";

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
      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
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
        !messages[messages.length - 1]?.parts.some(isRunning) && (
          <div className="nt-turn-pending" role="status">
            <span className="nt-thinking-dot" aria-hidden />
            Thinking…
          </div>
        )
      )}
      {error && <div className="nt-turn-error">{error.message}</div>}
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
        groupParts(message.parts).map((item) => {
          const i = item.key;
          if ("draws" in item) {
            // A board's shots arrive as one salvo of parallel calls; nine
            // near-identical lines read as a stutter, one count reads as
            // work. A lone call keeps its quoted brief — detail is only
            // noise in a crowd. A salvo still waiting on its style says
            // nothing here: the picker below is the statement.
            if (item.draws.every((p) => p.state === "approval-requested")) {
              return null;
            }
            const running = item.draws.some(isRunning);
            return (
              <p
                key={i}
                className={`nt-turn-step${running ? " is-running" : ""}`}
              >
                {running && <span className="nt-thinking-dot" aria-hidden />}
                {item.draws.length === 1
                  ? stepLine(item.draws[0])
                  : drawsLine(item.draws)}
              </p>
            );
          }
          const part = item.part;
          if (part.type === "text") {
            // Only what the agent wrote is read as markdown. A question is
            // shown as it was typed — someone who wrote an asterisk meant an
            // asterisk, and reformatting their own words back at them is the
            // one place this would be wrong.
            return message.role === "assistant" ? (
              <Markdown key={i} text={part.text} />
            ) : (
              <p key={i} className="nt-turn-text">
                {part.text}
              </p>
            );
          }
          // What came with the question. A mention keeps its "@" because that
          // is how it was written; a file gets the clip it was attached with.
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
          // An image lives in storage rather than in the message, so the chip
          // is the way back to it.
          if (part.type === "file") {
            return (
              <FileChip key={i} filename={part.filename ?? "Image"} href={part.url} />
            );
          }
          if (isToolUIPart(part)) {
            // A call waiting to be allowed is shown as the question below,
            // not as a line claiming it is under way.
            if (part.state === "approval-requested") return null;
            const failed = part.state === "output-error";
            // The step that is still running carries the pulse, because it is
            // the one that knows what is happening: "Writing…" beside a live
            // dot says more than "Thinking…" ever did, and there is only ever
            // one of them on screen.
            const running = isRunning(part);
            return (
              <p
                key={i}
                className={`nt-turn-step${failed ? " is-failed" : ""}${
                  running ? " is-running" : ""
                }`}
              >
                {running && <span className="nt-thinking-dot" aria-hidden />}
                {stepLine(part)}
              </p>
            );
          }
          return null;
        })
      )}
      {rewindable && (
        <Rewind pageCount={pageCount} onRewind={(what) => onRewind(message, what)} />
      )}
    </div>
  );
});

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

type DrawPart = ToolUIPart | DynamicToolUIPart;
type PartItem =
  | { key: number; draws: DrawPart[] }
  | { key: number; part: AbMessage["parts"][number] };

/**
 * The parts as render items, with runs of draw calls gathered into one.
 *
 * "Consecutive" reaches across step-start markers: a retry after a miss is a
 * new step, and splitting the group there would bring the stutter back as two
 * smaller stutters.
 */
function groupParts(parts: AbMessage["parts"]): PartItem[] {
  const out: PartItem[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (isToolUIPart(part) && getToolName(part) === "draw") {
      const draws: DrawPart[] = [part];
      let j = i + 1;
      while (j < parts.length) {
        const next = parts[j];
        if (next.type === "step-start") {
          j++;
          continue;
        }
        if (isToolUIPart(next) && getToolName(next) === "draw") {
          draws.push(next);
          j++;
          continue;
        }
        break;
      }
      out.push({ key: i, draws });
      i = j;
    } else {
      out.push({ key: i, part });
      i++;
    }
  }
  return out;
}

/** The salvo as one line: a count while it runs, a tally when it settles. */
function drawsLine(draws: DrawPart[]): string {
  const n = draws.length;
  // Refused at the picker — read off the click, like a lone call's stepLine,
  // so the line does not sit on "Drawing…" while the denial makes its round
  // trip to the server.
  const denied = draws.filter(
    (p) => p.state === "output-denied" || p.approval?.approved === false,
  ).length;
  if (denied === n) return "Left the drawings undrawn";
  const drawn = draws.filter(
    (p) =>
      p.state === "output-available" &&
      !(p.output as { error?: string } | undefined)?.error,
  ).length;
  const settled =
    draws.filter(
      (p) => p.state === "output-available" || p.state === "output-error",
    ).length + denied;
  // A shot is a draw that named a board ratio; anything else is a drawing.
  const what = draws.every((p) => (p.input as { ratio?: string } | undefined)?.ratio)
    ? "shot"
    : "drawing";
  if (settled < n) return `Drawing ${n} ${what}s — ${drawn} done…`;
  if (drawn === n) return `Drew ${n} ${what}s`;
  return `Drew ${drawn} of ${n} ${what}s`;
}

/** Present tense while the tool runs; what it produced is read off the result. */
const STEPS: Record<string, { doing: string; failed: string }> = {
  list_pages: { doing: "Listing pages…", failed: "Couldn't list the pages" },
  read_page: { doing: "Reading…", failed: "Couldn't read that page" },
  open_page: { doing: "Opening…", failed: "Couldn't open that page" },
  read_open_page: { doing: "Reading…", failed: "Couldn't read the open page" },
  edit_page: { doing: "Writing…", failed: "Couldn't edit that page" },
  draw: { doing: "Drawing…", failed: "Couldn't draw that" },
  search_web: { doing: "Searching the web…", failed: "Couldn't search the web" },
  create_page: { doing: "Adding a page…", failed: "Couldn't add the page" },
  rename_page: { doing: "Retitling…", failed: "Couldn't retitle that page" },
  delete_page: { doing: "Deleting…", failed: "Couldn't delete that page" },
};

/**
 * One quiet line per tool call, in the same metadata voice as the section
 * labels — what the agent did, never the arguments it did it with. A JSON dump
 * is noise to everyone except the person debugging the prompt.
 */
/**
 * States in which a step is still going, and its line therefore ends in "…".
 *
 * Named rather than derived from "not finished": `approval-requested` is a
 * question waiting on the user, which is not the agent working, and a spinner
 * against it would say the opposite of what is true.
 */
const RUNNING: ReadonlySet<string> = new Set([
  "input-streaming",
  "input-available",
  "approval-responded",
]);

/** Whether this part is a tool call that has not finished yet. */
function isRunning(part: AbMessage["parts"][number]): boolean {
  // An approval that was refused is settled, whatever its state still reads as.
  return (
    isToolUIPart(part) && RUNNING.has(part.state) && part.approval?.approved !== false
  );
}

function stepLine(part: ToolUIPart | DynamicToolUIPart): string {
  const name = getToolName(part);
  const step = STEPS[name];
  const query = (part.input as { query?: string } | undefined)?.query;

  if (part.state === "output-error") return step?.failed ?? `${name} failed`;
  // A refusal has to read off the click. `output-denied` is the server agreeing,
  // and it is a whole request away — long enough for "Deleting…" to sit under a
  // button the user pressed to stop exactly that, and forever if that request
  // never lands.
  if (part.state === "output-denied" || part.approval?.approved === false) {
    return "Left it alone";
  }
  if (part.state !== "output-available") {
    if (query) return `Searching for “${query}”…`;
    // The brief is the one argument worth quoting: six parallel draw calls as
    // six bare "draw…" lines read as a stutter, where six briefs read as a
    // shot list assembling itself.
    const brief = (part.input as { brief?: string } | undefined)?.brief;
    if (name === "draw" && brief) return `Drawing ${clause(brief)}…`;
    return step?.doing ?? `${name}…`;
  }

  switch (name) {
    case "list_pages": {
      const n = Array.isArray(part.output) ? part.output.length : 0;
      return `Listed ${n} page${n === 1 ? "" : "s"}`;
    }
    case "read_page":
    case "read_open_page":
      return `Read ${pageTitle(part.output) ?? "an untitled page"}`;
    case "edit_page": {
      // The tool opens a successful answer with "Done:", whatever the page is
      // called — judging by title alone read every edit of an UNTITLED page as
      // "left it as it was", straight-faced, under six drawings it had placed.
      const done =
        typeof part.output === "string" && part.output.startsWith("Done:");
      if (!done) return "Left the page as it was";
      return `Edited ${pageTitle(part.output) ?? "the page"}`;
    }
    case "open_page": {
      const title = (part.output as { title?: string } | undefined)?.title;
      return `Opened ${title?.trim() || "an untitled page"}`;
    }
    case "draw": {
      const brief = (part.input as { brief?: string } | undefined)?.brief;
      // The tool answers {error} when nothing worth drawing came back — an
      // ordinary result to the protocol, a miss to the reader.
      if ((part.output as { error?: string } | undefined)?.error) {
        return "Nothing came of that drawing";
      }
      return brief ? `Drew ${clause(brief)}` : "Drew a canvas";
    }
    case "search_web":
      return query ? `Searched for “${query}”` : "Searched the web";
    case "create_page":
      return `Added ${named(part.output)}`;
    case "rename_page": {
      const title = (part.output as { title?: string }).title?.trim();
      return title ? `Retitled to “${title}”` : "Cleared a page's title";
    }
    case "delete_page":
      return `Deleted ${named(part.output)}`;
    default:
      return name;
  }
}

/**
 * A brief's opening clause, quoted — enough to tell six draw lines apart
 * without the transcript becoming the prompt. Cut at a word, never mid-one.
 */
function clause(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= 48) return `“${flat}”`;
  return `“${flat.slice(0, 48).replace(/\s+\S*$/, "")}…”`;
}

/** The page tools answer with HTML, and a page with a title says so in one. */
function pageTitle(output: unknown): string | null {
  const title =
    typeof output === "string" ? /<title>([^<]*)<\/title>/.exec(output)?.[1] : null;
  return title?.trim() || null;
}

/** The page tools answer with the title they left behind. */
function named(output: unknown): string {
  const title = (output as { title?: string } | undefined)?.title?.trim();
  return title ? `“${title}”` : "an untitled page";
}
