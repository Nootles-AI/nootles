"use client";

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useAuth } from "@clerk/nextjs";
import type * as Y from "yjs";
import type { Id } from "@/convex/_generated/dataModel";
import { CommentsStore } from "@/app/lib/comments/store";
import type { Thread } from "@/app/lib/comments/types";
import { useCommentsDoc } from "@/app/lib/comments/useCommentsDoc";
import { useCommentAccess, type CommentAccess } from "./access";
import { usePageCommentsRegistry } from "./registry";

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

const NO_THREADS: Thread[] = [];

/**
 * Provides {@link usePageComments} for one page. Mounting it mints nothing: it
 * asks only whether the page has a comments document, and a reader without a
 * role learns nothing (`comments.docFor` answers null to them).
 */
export function PageCommentsProvider({ pageId, children }: { pageId: Id<"pages">; children: ReactNode }) {
  const access = useCommentAccess();
  const { userId } = useAuth();
  const canComment = access.canComment && Boolean(userId);
  const comments = useCommentsDoc(pageId, { canComment });
  const doc = access.canRead ? (comments.doc ?? null) : null;
  const { ensure } = comments;

  const store = useMemo(
    () => (doc && userId && canComment ? storeFor(doc, userId) : null),
    [doc, userId, canComment],
  );

  const value = useMemo<PageComments>(
    () => ({
      pageId,
      access,
      userId: userId ?? null,
      status: access.canRead ? comments.status : "absent",
      doc,
      threads: access.canRead ? comments.threads : NO_THREADS,
      store,
      ensureStore: async () => {
        if (!userId || !canComment) throw new Error("You can read these comments but not add to them.");
        return store ?? storeFor(await ensure(), userId);
      },
    }),
    [pageId, access, userId, comments.status, comments.threads, doc, store, canComment, ensure],
  );

  // Published for the chat, which sits beside the page rather than inside it.
  const registry = usePageCommentsRegistry();
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
    registry?.changed();
  });
  useEffect(() => registry?.publish(pageId, () => latest.current), [registry, pageId]);

  return <PageCommentsContext value={value}>{children}</PageCommentsContext>;
}
