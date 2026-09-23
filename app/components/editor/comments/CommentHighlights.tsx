"use client";

import { useEffect } from "react";
import type { LiveEditor } from "@/app/components/editor/EditorRegistry";
import { forkStore, isForked } from "@/app/lib/ai/review/fork";
import { persistable } from "@/app/lib/comments/anchorWrite";
import { CommentsStoreError, type CommentsStore } from "@/app/lib/comments/store";
import type { Thread } from "@/app/lib/comments/types";
import {
  persistCommentWrites,
  reresolveComments,
  setCommentThreads,
  setForkProbe,
} from "./commentDecorations";

function refusedUnderFork(error: unknown) {
  if (error instanceof CommentsStoreError && error.code === "forked") return;
  console.error("A comment anchor could not be saved.", error);
}

/**
 * Feeds one editor's comment highlights: the threads, whether a review has
 * forked the page, and — for someone who may comment — where the anchor
 * maintenance the highlights discover is written. A viewer's editor resolves
 * and draws exactly the same, and writes nothing.
 */
export function CommentHighlights({
  editor,
  threads,
  store,
}: {
  editor: LiveEditor;
  threads: readonly Thread[];
  store: CommentsStore | null;
}) {
  // Declared first: the probe must be in place before any thread resolves.
  useEffect(() => {
    const view = editor.prosemirrorView;
    if (!view) return;
    setForkProbe(view, () => isForked(editor));
    let forked = isForked(editor);
    return forkStore(editor)?.subscribe(() => {
      const now = isForked(editor);
      // After the merge has finished landing, so the text resolved against is
      // what Keep or Discard left — never the moment between.
      if (forked && !now) queueMicrotask(() => reresolveComments(view));
      forked = now;
    });
  }, [editor]);

  useEffect(() => {
    const view = editor.prosemirrorView;
    if (!view || !store) return;
    const disconnect = persistCommentWrites(view, (writes) => {
      const forked = isForked(editor);
      const now = Date.now();
      // Out of the editor's dispatch: the store's own transaction notifies React.
      queueMicrotask(() => {
        for (const [threadId, write] of writes) {
          store.applyAnchorWrite(threadId, persistable(write, now), { forked }).catch(refusedUnderFork);
        }
      });
    });
    // What was resolved before there was anywhere to write it is found again.
    reresolveComments(view);
    return disconnect;
  }, [editor, store]);

  useEffect(() => {
    const view = editor.prosemirrorView;
    if (view) setCommentThreads(view, threads);
  }, [editor, threads]);

  return null;
}
