"use client";

import { Comment } from "../Icons";
import { useCommentsUI } from "./commentsUI";

/** The page header's way to the comments panel, with the count of open threads. */
export function CommentsButton() {
  const ui = useCommentsUI();
  if (!ui?.canRead) return null;
  const label = ui.openCount
    ? `Comments, ${ui.openCount} open`
    : "Comments";
  return (
    <button
      type="button"
      className="nt-icon-btn nt-comments-toggle"
      aria-label={label}
      title="Comments"
      aria-pressed={ui.panelOpen}
      data-comments-toggle=""
      onClick={ui.togglePanel}
    >
      <Comment />
      {ui.openCount > 0 && <span className="nt-comments-badge">{ui.openCount}</span>}
    </button>
  );
}
