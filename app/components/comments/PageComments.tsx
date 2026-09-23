"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import type * as Y from "yjs";
import type { Id } from "@/convex/_generated/dataModel";
import { commentsHistoryFor, type CommentsHistory } from "@/app/lib/comments/history";
import { CommentsStore } from "@/app/lib/comments/store";
import type { Thread } from "@/app/lib/comments/types";
import { useCommentsDoc } from "@/app/lib/comments/useCommentsDoc";
import { useCommentAccess, type CommentAccess } from "./access";
import { CommentsEditorContext, CommentsEditorSlot } from "./editorSlot";
import { usePageCommentsRegistry } from "./registry";
import { useCommentsUndo } from "./useCommentsUndo";

/**
 * One page's comments, as every comment surface sees them: the decorations in
 * the editor, the margin cards and panel, and the assistant's tools all read
 * this one value, so they agree on which threads exist and write through the
 * same store.
 */
export type PageComments = {
  pageId: Id<"pages">;
  access: CommentAccess;
  /** The signed-in person's Clerk subject; null for a signed-out visitor. */
  userId: string | null;
  status: "absent" | "loading" | "ready";
  doc: Y.Doc | null;
  /** Empty unless `access.canRead`. */
  threads: Thread[];
  /** The person's hands on the document once it exists and they may write. */
  store: CommentsStore | null;
  /**
   * This person's undo over their own comment actions, beside the store it
   * undoes. ⌘Z reaches it from inside a `commentsScope(pageId)` surface.
   */
  history: CommentsHistory | null;
  /** Why the server refused this person's last comment change, which has been undone; see `useCommentsDoc`. */
  refusal: string | null;
  dismissRefusal: () => void;
  /**
   * The store, minting the comments document first when the page has none —
   * for the first comment. Rejects when the person may not comment.
   */
  ensureStore: () => Promise<CommentsStore>;
};

const PageCommentsContext = createContext<PageComments | null>(null);

/** The open page's comments, or null outside a page that provides them. */
export function usePageComments(): PageComments | null {
  return useContext(PageCommentsContext);
}

/** Built only for someone who may comment; the server's channel gate still decides. */
function storeFor(doc: Y.Doc, userId: string): CommentsStore {
  return new CommentsStore(doc, { actor: { userId, kind: "human" }, authorize: () => true });
}

/**
 * Made with the store, because a history hears only what lands after it
 * exists: a comment written first would be one ⌘Z could never reach.
 */
function historyFor(doc: Y.Doc, userId: string): CommentsHistory {
  return commentsHistoryFor(doc, { localUserId: userId });
}

const NO_THREADS: Thread[] = [];

/**
 * Provides {@link usePageComments} for one page. Mounting it mints nothing: it
 * asks only whether the page has a comments document, and only a reader with
 * a role asks at all — a signed-out visitor never reaches `comments.docFor`.
 *
 * It also answers ⌘Z for the page's comment surfaces (`useCommentsUndo`) and
 * holds the slot the page's editor reports itself into, from which
 * `useCommentableSelection` reads the words a comment would hang off.
 */
export function PageCommentsProvider({ pageId, children }: { pageId: Id<"pages">; children: ReactNode }) {
  const access = useCommentAccess();
  const { userId } = useAuth();
  const canComment = access.canComment && Boolean(userId);
  const comments = useCommentsDoc(pageId, { canRead: access.canRead, canComment });
  const doc = access.canRead ? (comments.doc ?? null) : null;
  const { ensure, refusal, dismissRefusal } = comments;

  const [store, history] = useMemo<[CommentsStore, CommentsHistory] | [null, null]>(
    () => (doc && userId && canComment ? [storeFor(doc, userId), historyFor(doc, userId)] : [null, null]),
    [doc, userId, canComment],
  );
  useCommentsUndo(pageId, history);
  const [editorSlot] = useState(() => new CommentsEditorSlot());

  const value = useMemo<PageComments>(
    () => ({
      pageId,
      access,
      userId: userId ?? null,
      status: access.canRead ? comments.status : "absent",
      doc,
      threads: access.canRead ? comments.threads : NO_THREADS,
      store,
      history,
      refusal,
      dismissRefusal,
      ensureStore: async () => {
        if (!userId || !canComment) throw new Error("You can read these comments but not add to them.");
        if (store) return store;
        const minted = await ensure();
        historyFor(minted, userId);
        return storeFor(minted, userId);
      },
    }),
    [pageId, access, userId, comments.status, comments.threads, doc, store, history, refusal, dismissRefusal, canComment, ensure],
  );

  // Published for the chat, which sits beside the page rather than inside it.
  const registry = usePageCommentsRegistry();
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
    registry?.changed();
  });
  useEffect(() => registry?.publish(pageId, () => latest.current), [registry, pageId]);

  return (
    <PageCommentsContext value={value}>
      <CommentsEditorContext value={editorSlot}>{children}</CommentsEditorContext>
    </PageCommentsContext>
  );
}
