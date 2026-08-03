"use client";

import { pendingHunks } from "@/app/lib/ai/review/session";
import { useOpenReviews, useReview, useReviewFailure } from "./ReviewContext";

/**
 * One bar for everything the agent has changed and nobody has answered, at the
 * foot of the window rather than beside the text — it is a control for the SET
 * of changes, the same distinction the reformat switcher draws, and it stays
 * neutral for the same reason: the colour on this screen belongs to the diff.
 *
 * Mounted above the workspace rather than inside the editor, because it speaks
 * for the project and the editor speaks for one page. The agent's own tools open
 * pages mid-turn, and a bar living under the editor went out with it every time
 * one did — the question flickered away while its answer was still owed.
 */
export function ReviewBar() {
  const session = useReview();
  const open = useOpenReviews();
  const failure = useReviewFailure();

  if (!open.length) return null;

  // The buttons take everything unanswered. Changes stack — asking a second
  // question about the same paragraph is the ordinary case — so a bar that spoke
  // only for the newest turn would leave the earlier ones with no way to be
  // answered at all.
  const hunks = open.flatMap((turn) => turn.pages.flatMap(pendingHunks));
  const pages = new Set(
    open.flatMap((turn) =>
      turn.pages.filter((page) => pendingHunks(page).length).map((page) => page.pageId),
    ),
  ).size;
  const oldest = open[0];
  // Up from the first change rather than at the end of the turn. The edits are
  // applied for real as they are made, so withholding the bar until the agent
  // stops talking leaves the document visibly rewritten with nothing on screen
  // to answer it — which reads as the bar being late, or missing.
  const writing = open.some((turn) => session.isWriting(turn.chatPromptId));

  return (
    <div className="nt-review-bar" style={{ zIndex: "var(--z-sticky)" }} role="status">
      <span className="nt-review-count">
        {hunks.length} change{hunks.length === 1 ? "" : "s"}
        {pages > 1 ? ` · ${pages} pages` : ""}
        {open.length > 1 ? ` · ${open.length} messages` : ""}
      </span>
      <span className="nt-review-sep" aria-hidden />
      {/* A hunk the agent is still growing can be regrouped, and regrouped it
          has a different id — so it cannot honestly be answered yet. The bar
          says why instead of offering buttons that would quietly do nothing. */}
      {writing ? (
        <span className="nt-review-count">still writing…</span>
      ) : (
        <>
          <button
            className="nt-review-action"
            onClick={() => session.answer(session.acceptAll())}
          >
            Keep all
          </button>
          <button
            className="nt-review-action"
            onClick={() => session.answer(session.rejectAll())}
          >
            Discard all
          </button>
          <button
            className="nt-review-action is-quiet"
            onClick={() => session.answer(session.revertTurn(oldest.chatPromptId))}
            title="Put the page back exactly as it was, including anything you have typed since"
          >
            Revert
          </button>
        </>
      )}
      {failure && <span className="nt-review-failure">{failure}</span>}
    </div>
  );
}
