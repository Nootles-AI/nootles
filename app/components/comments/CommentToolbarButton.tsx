"use client";

import { useRef } from "react";
import { useComponentsContext } from "@blocknote/react";
import { Comment } from "../Icons";
import { useCommentsUI } from "./commentsUI";
import { useCommentableSelection, type SelectedWords } from "./useCommentableSelection";

/**
 * "Comment" in the formatting toolbar, for anyone who may comment on the
 * words selected. Absent for a reader who may not, and on a page with no
 * comment layer.
 *
 * The words are taken on the press, and the press keeps the editor's focus:
 * once the composer has the keyboard the selection is gone.
 */
export function CommentToolbarButton() {
  const Components = useComponentsContext()!;
  const ui = useCommentsUI();
  const selection = useCommentableSelection();
  const held = useRef<SelectedWords | null>(null);
  if (!ui || selection?.kind !== "comment") return null;

  return (
    <span
      className="contents"
      onMouseDownCapture={(e) => {
        e.preventDefault();
        held.current = selection;
      }}
    >
      <Components.FormattingToolbar.Button
        className="bn-button"
        label="Comment"
        mainTooltip="Comment"
        secondaryTooltip="Mod+Alt+M"
        icon={<Comment width={16} height={16} />}
        onClick={() => {
          const words = held.current ?? selection;
          held.current = null;
          ui.start(words);
        }}
      />
    </span>
  );
}
