"use client";

import { usePageComments } from "@/app/components/comments/PageComments";
import type { LiveEditor } from "@/app/components/editor/EditorRegistry";
import type { Thread } from "@/app/lib/comments/types";
import { CommentHighlights } from "./CommentHighlights";

const NO_THREADS: Thread[] = [];

/** The open page's comments, drawn in its editor. */
export function CommentDecorationsBridge({ editor }: { editor: LiveEditor }) {
  const comments = usePageComments();
  return (
    <CommentHighlights
      editor={editor}
      threads={comments?.threads ?? NO_THREADS}
      store={comments?.store ?? null}
    />
  );
}
