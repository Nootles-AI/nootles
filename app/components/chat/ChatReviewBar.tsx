"use client";

import type { Id } from "@/convex/_generated/dataModel";
import { useOpenReviews, useReview, useReviewFailure } from "../ReviewContext";
import { pendingHunks } from "@/app/lib/ai/review/session";

/**
 * The answer to what THIS conversation changed, directly above the box you would
 * type the next question into.
 *
 * The bar under the document speaks for the project — every change on every page
 * that is still outstanding, whoever asked for it. This one is scoped to the
 * thread, because the question it answers is the one the transcript just showed
 * you, and reaching for the document to answer it means leaving the place where
 * you read what happened.
 *
 * It is not a second source of truth: both read the same session, and answering
 * in either settles the same hunks.
 */
export function ChatReviewBar({ threadId }: { threadId: Id<"chatThreads"> | null }) {
  const session = useReview();
  const open = useOpenReviews();
  const failure = useReviewFailure();

  const mine = threadId ? open.filter((turn) => turn.threadId === threadId) : [];
  if (!mine.length) return null;

  const hunks = mine.flatMap((turn) => turn.pages.flatMap(pendingHunks));
  const pages = new Set(
    mine.flatMap((turn) =>
      turn.pages.filter((page) => pendingHunks(page).length).map((page) => page.pageId),
    ),
  ).size;
  const writing = mine.some((turn) => session.isWriting(turn.chatPromptId));
  const answering = new Set(
    hunks.map((hunk) => session.answeringAs(hunk.id)).filter((answer) => answer !== null),
  );
  const busy = answering.size > 0;

  // Turn at a time, in order, rather than one call with a thread filter: each
  // settle re-reads the turns it is about to rewrite, so they have to land one
  // after another — and a thread with two unanswered questions is ordinary.
  const answerAll = (verdict: "accepted" | "rejected") =>
    session.answer(
      (async () => {
        for (const turn of mine) {
          await (verdict === "accepted"
            ? session.acceptAll(turn.chatPromptId)
            : session.rejectAll(turn.chatPromptId));
        }
      })(),
    );

  return (
    <div className="nt-chat-review" aria-busy={busy}>
      <div className="nt-chat-review-row">
        <span className="nt-chat-review-count">
          {hunks.length} change{hunks.length === 1 ? "" : "s"}
          {pages > 1 ? ` · ${pages} pages` : ""}
        </span>
        {/* A hunk the agent is still growing gets regrouped under a new id, so a
            button here would settle nothing. It says so instead. */}
        {writing ? (
          <span className="nt-chat-review-count is-writing">
            <span className="nt-thinking-dot" aria-hidden />
            still writing…
          </span>
        ) : (
          <div className="nt-chat-review-actions">
            <button
              className="nt-chat-review-btn"
              disabled={busy}
              onClick={() => answerAll("rejected")}
            >
              {answering.has("rejected") ? "Discarding…" : "Discard"}
            </button>
            <button
              className="nt-chat-review-btn is-keep"
              disabled={busy}
              onClick={() => answerAll("accepted")}
            >
              {answering.has("accepted") ? "Keeping…" : "Keep"}
            </button>
          </div>
        )}
      </div>
      {failure && <p className="nt-chat-review-failure">{failure}</p>}
    </div>
  );
}
