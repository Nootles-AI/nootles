"use client";

import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { EditorView } from "prosemirror-view";
import { Comment } from "../Icons";
import type { CommentableSelection, SelectedWords } from "./useCommentableSelection";

/**
 * The Comment button of a page with no formatting toolbar — a commenter's
 * read-only page, or a comment link's signed-out guest, whom it offers
 * "Sign in to comment" instead. It floats just above where the selection
 * starts, as the toolbar would.
 *
 * The anchor is taken on the press, before the button can take focus: in a
 * read-only view the selection is gone the moment anything else has it.
 */
export function SelectionAffordance({
  view,
  selection,
  onComment,
}: {
  view: EditorView;
  selection: CommentableSelection;
  onComment: (words: SelectedWords) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const held = useRef<CommentableSelection | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      let start: { top: number; left: number };
      try {
        start = view.coordsAtPos(selection.from, 1);
      } catch {
        return;
      }
      const top = start.top - el.offsetHeight - 8;
      el.style.top = `${top < 8 ? view.coordsAtPos(selection.to, -1).bottom + 8 : top}px`;
      el.style.left = `${Math.max(8, Math.min(start.left, window.innerWidth - el.offsetWidth - 8))}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [view, selection]);

  const signIn = selection.kind === "signIn";
  return createPortal(
    <button
      ref={ref}
      type="button"
      className="nt-comment-float"
      data-comment-affordance={selection.kind}
      onMouseDown={(e) => {
        e.preventDefault();
        held.current = selection;
      }}
      onClick={() => {
        const words = held.current ?? selection;
        held.current = null;
        if (words.kind === "signIn") words.signIn();
        else onComment(words);
      }}
    >
      <Comment width={14} height={14} />
      {signIn ? "Sign in to comment" : "Comment"}
    </button>,
    document.body,
  );
}
