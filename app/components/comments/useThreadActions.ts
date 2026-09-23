"use client";

import { useEffect, useMemo, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { refusedOutsiders } from "@/app/lib/comments/compose";
import type { CommentAnchor, Thread } from "@/app/lib/comments/types";
import type { PageComments } from "./PageComments";

/**
 * The comment verbs a person uses, each one write to the comments document
 * through the store and then one `commentNotices.event` — the same verbs and
 * the same notice the assistant's tools send, so a thread cannot tell who
 * started it except by the `via` it carries.
 *
 * The write is the truth and the notice is news about it: a notice that fails
 * leaves the comment written. Only an outsider refusal is reported back, so
 * the card can say who was not told; any other failure is logged.
 */
export type ThreadActions = {
  create(input: { anchor: CommentAnchor; body: string; mentions: string[] }): Promise<Written & { threadId: string }>;
  reply(thread: Thread, body: string, mentions: string[]): Promise<Written>;
  edit(commentId: string, body: string): Promise<void>;
  deleteComment(thread: Thread, commentId: string): Promise<void>;
  deleteThread(thread: Thread): Promise<void>;
  resolve(thread: Thread): Promise<void>;
  reopen(thread: Thread): Promise<void>;
};

/** Who a notice could not reach because they cannot open the project; empty when everyone was told. */
type Written = { outsiders: string[] };

function participants(thread: Thread): string[] {
  return [...new Set(thread.comments.map((comment) => comment.authorId))];
}

export function useThreadActions(comments: PageComments | null): ThreadActions {
  const notify = useMutation(api.commentNotices.event);
  const latest = useRef(comments);
  useEffect(() => {
    latest.current = comments;
  });

  return useMemo<ThreadActions>(() => {
    const current = () => {
      const value = latest.current;
      if (!value?.userId) throw new Error("Sign in to comment.");
      return { ...value, userId: value.userId };
    };
    const store = () => {
      const value = current();
      if (!value.store) throw new Error("You can read these comments but not add to them.");
      return value.store;
    };
    const tell = async (event: Omit<Parameters<typeof notify>[0], "pageId">): Promise<Written> => {
      try {
        await notify({ pageId: current().pageId, ...event });
        return { outsiders: [] };
      } catch (error) {
        const outsiders = refusedOutsiders(error);
        if (outsiders) return { outsiders };
        console.warn("A comment was written, but telling people about it failed.", error);
        return { outsiders: [] };
      }
    };
    const newId = () => crypto.randomUUID();

    return {
      async create({ anchor, body, mentions }) {
        const { userId, ensureStore } = current();
        const writer = await ensureStore();
        const threadId = newId();
        const commentId = newId();
        await writer.createThread({ anchor, body, authorId: userId, threadId, commentId });
        const told = await tell({ threadId, kind: "create", commentId, mentions });
        return { threadId, ...told };
      },
      async reply(thread, body, mentions) {
        const { userId } = current();
        const commentId = newId();
        await store().reply({ threadId: thread.id, body, authorId: userId, commentId });
        return tell({ threadId: thread.id, kind: "reply", commentId, mentions, participants: participants(thread) });
      },
      async edit(commentId, body) {
        await store().editComment({ commentId, body, editorId: current().userId });
      },
      async deleteComment(thread, commentId) {
        const removed = await store().deleteComment({ commentId, by: current().userId });
        await tell({
          threadId: thread.id,
          kind: "delete",
          ...(removed === "comment" ? { commentId } : {}),
          mentions: [],
        });
      },
      async deleteThread(thread) {
        await store().deleteThread({ threadId: thread.id });
        await tell({ threadId: thread.id, kind: "delete", mentions: [] });
      },
      async resolve(thread) {
        if (!(await store().resolve({ threadId: thread.id, by: current().userId }))) return;
        await tell({ threadId: thread.id, kind: "resolve", mentions: [], participants: participants(thread) });
      },
      async reopen(thread) {
        if (!(await store().reopen({ threadId: thread.id }))) return;
        await tell({ threadId: thread.id, kind: "reopen", mentions: [] });
      },
    };
  }, [notify]);
}
