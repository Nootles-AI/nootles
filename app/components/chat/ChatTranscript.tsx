"use client";

import { useEffect, useRef } from "react";
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
  approval,
  projectId,
  threadId,
  onAnswerApproval,
  onRewind,
  error,
}: {
  messages: AbMessage[];
  busy: boolean;
  approval: PendingApproval | null;
  projectId: Id<"projects">;
  threadId: Id<"chatThreads"> | null;
  onAnswerApproval: (approved: boolean) => void;
  onRewind: (message: AbMessage, what: RewindScope) => void;
  error?: Error;
}) {
  const restorable = useQuery(
    api.chat.turns.restorable,
    threadId ? { threadId } : "skip",
  );
  const endRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Follow the stream, but only when already at the bottom: yanking someone
  // back down while they are reading an earlier answer is worse than not
  // following at all.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const distance =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (distance < 120) endRef.current?.scrollIntoView({ block: "end" });
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

  return (
    <div ref={scrollerRef} className="ab-transcript">
      {messages.map((message) => (
        <div key={message.id} className={`ab-turn is-${message.role}`}>
          {message.parts.map((part, i) => {
            if (part.type === "text") {
              return (
                <p key={i} className="ab-turn-text">
                  {part.text}
                </p>
              );
            }
            // What came with the question. A mention keeps its "@" because that
            // is how it was written; a file gets the clip it was attached with.
            if (part.type === "data-mention") {
              const { data } = part;
              return (
                <span key={i} className="ab-chip">
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
              return (
                <p key={i} className={`ab-turn-step${failed ? " is-failed" : ""}`}>
                  {stepLine(part)}
                </p>
              );
            }
            return null;
          })}
          {message.role === "user" && !busy && (
            <Rewind
              pageCount={pagesChangedBy(restorable, message.metadata?.chatPromptId)}
              onRewind={(what) => onRewind(message, what)}
            />
          )}
        </div>
      ))}

      {approval ? (
        <DeleteApproval
          projectId={projectId}
          input={approval.input}
          onAnswer={onAnswerApproval}
        />
      ) : (
        busy && <div className="ab-turn-pending">Thinking…</div>
      )}
      {error && <div className="ab-turn-error">{error.message}</div>}
      <div ref={endRef} />
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
        className="ab-rewind"
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
        <button {...props} className="ab-rewind">
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
            <span className="ab-menu-stack">
              <span>{option.label}</span>
              <span className="ab-menu-hint">{option.hint}</span>
            </span>
          </MenuItem>
        ))
      }
    </Menu>
  );
}

export type RewindScope = "both" | "conversation" | "notes";

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
      <span className="ab-chip-label">{filename}</span>
    </>
  );
  return href ? (
    <a className="ab-chip" href={href} target="_blank" rel="noreferrer" title={filename}>
      {inside}
    </a>
  ) : (
    <span className="ab-chip" title={filename}>
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
 * `delete_page` is the only tool declared with `needsApproval`; the day there is
 * another, this chooses between them.
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
    <div role="alert" className="ab-turn-confirm">
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

/** Present tense while the tool runs; what it produced is read off the result. */
const STEPS: Record<string, { doing: string; failed: string }> = {
  list_pages: { doing: "Listing pages…", failed: "Couldn't list the pages" },
  read_page: { doing: "Reading…", failed: "Couldn't read that page" },
  open_page: { doing: "Opening…", failed: "Couldn't open that page" },
  read_open_page: { doing: "Reading…", failed: "Couldn't read the open page" },
  edit_page: { doing: "Writing…", failed: "Couldn't edit that page" },
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
    return query ? `Searching for “${query}”…` : (step?.doing ?? `${name}…`);
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
      // Answered with the page as it now stands, so a result carrying no page is
      // an edit that did not happen — a bad id, or nothing left to change.
      const title = pageTitle(part.output);
      return title ? `Edited ${title}` : "Left the page as it was";
    }
    case "open_page": {
      const title = (part.output as { title?: string } | undefined)?.title;
      return `Opened ${title?.trim() || "an untitled page"}`;
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
