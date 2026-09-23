"use client";

import { useEffect } from "react";
import type { CommentsHistory } from "@/app/lib/comments/history";
import { currentUndoRoute, undoKeyOf } from "@/app/lib/history/undoRoute";

/**
 * ⌘Z / ⌘⇧Z for one page's comment surfaces: with focus inside an element
 * carrying `commentsScope(pageId)` and not in a text field, the press steps
 * this person's comment history and goes no further — never to the workspace
 * spine, whose handler stands aside for the same route (`undoRoute.ts`).
 *
 * Without a history (a reader who may not comment, or a page nobody has
 * commented on yet) the press is still claimed, so it cannot fall through to
 * the document. A second provider for the same page — the page open in both
 * panes — shares the history and sees the press already answered.
 */
export function useCommentsUndo(pageId: string, history: CommentsHistory | null): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const key = undoKeyOf(event);
      if (!key) return;
      const route = currentUndoRoute();
      if (route.to !== "comments" || route.pageId !== pageId) return;
      event.preventDefault();
      event.stopPropagation();
      if (key === "undo") history?.undo();
      else history?.redo();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [pageId, history]);
}
