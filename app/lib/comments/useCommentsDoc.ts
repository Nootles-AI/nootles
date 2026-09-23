"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import type * as Y from "yjs";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { acquireProvider, peekProvider, releaseProvider } from "@/app/lib/sync/YConvexProvider";
import { observeThreads, threadsSnapshot } from "./store";
import type { Thread } from "./types";

/** A comments document has no preview, digest or carets. */
const PROVIDER_OPTIONS = { derived: false, presence: false } as const;
const NO_THREADS: Thread[] = [];
const noSubscription = () => () => {};

export type CommentsDocState = {
  /**
   * `absent`: nobody has commented on this page yet (or it is not the
   * viewer's to read). `loading`: the id or the document is on its way.
   * `ready`: `doc` holds the synced comments document.
   */
  status: "absent" | "loading" | "ready";
  docId?: string;
  doc?: Y.Doc;
  threads: Thread[];
  /**
   * The synced comments document, minting it first if the page has none —
   * for the moment someone writes the first comment. Refused without
   * `canComment`.
   */
  ensure: () => Promise<Y.Doc>;
};

type Waiter = { pageId: string; docId: string; resolve: (doc: Y.Doc) => void; reject: (error: Error) => void };

/**
 * A page's comments document, synced. Reading never creates anything: a
 * viewer opening a page learns only whether comments exist, and the document
 * is minted by `ensure()` on the first write, never on mount.
 */
export function useCommentsDoc(
  pageId: Id<"pages">,
  { canComment }: { canComment: boolean },
): CommentsDocState {
  const client = useConvex();
  const queried = useQuery(api.comments.docFor, { pageId });
  const ensureDoc = useMutation(api.comments.ensureDoc);
  const docId = queried ?? null;

  // The provider is held for exactly as long as React is subscribed to it:
  // acquisition refcounts a module-level instance, and a subscription is the
  // one place React promises to pair with its teardown (StrictMode included).
  const subscribeProvider = useCallback(
    (listener: () => void) => {
      if (!docId) return () => {};
      const stop = acquireProvider(client, docId, PROVIDER_OPTIONS).subscribe(listener);
      return () => {
        stop();
        releaseProvider(docId);
      };
    },
    [client, docId],
  );
  const doc = useSyncExternalStore(
    subscribeProvider,
    () => {
      const provider = docId ? peekProvider(docId) : null;
      return provider?.synced ? provider.doc : null;
    },
    () => null,
  );

  const subscribeThreads = useCallback(
    (listener: () => void) => (doc ? observeThreads(doc, listener) : noSubscription()),
    [doc],
  );
  const threads = useSyncExternalStore(
    subscribeThreads,
    () => (doc ? threadsSnapshot(doc) : NO_THREADS),
    () => NO_THREADS,
  );

  // What `ensure` reads when it runs after this render, kept current in an
  // effect, and the calls waiting for a document to finish syncing.
  const latest = useRef<{ pageId: string; docId: string | null; doc: Y.Doc | null }>({ pageId, docId: null, doc: null });
  const waiters = useRef<Waiter[]>([]);
  useEffect(() => {
    latest.current = { pageId, docId, doc };
    const pending = waiters.current;
    waiters.current = [];
    for (const waiter of pending) {
      if (waiter.pageId !== pageId) waiter.reject(new Error("The page changed before the comment was written."));
      else if (docId === waiter.docId && doc) waiter.resolve(doc);
      else waiters.current.push(waiter);
    }
  }, [pageId, docId, doc]);
  useEffect(() => () => {
    const pending = waiters.current;
    waiters.current = [];
    for (const waiter of pending) waiter.reject(new Error("The comments document was closed."));
  }, []);

  const ensure = useCallback(async (): Promise<Y.Doc> => {
    if (!canComment) throw new Error("You can read these comments but not add to them.");
    const known = latest.current;
    if (known.pageId === pageId && known.doc) return known.doc;
    // Convex reflects a mutation in every query before its promise resolves,
    // so `docFor` names this id by the time the waiter is heard.
    const target = known.pageId === pageId && known.docId ? known.docId : await ensureDoc({ pageId });
    const now = latest.current;
    if (now.pageId !== pageId) throw new Error("The page changed before the comment was written.");
    if (now.docId === target && now.doc) return now.doc;
    return new Promise<Y.Doc>((resolve, reject) => {
      waiters.current.push({ pageId, docId: target, resolve, reject });
    });
  }, [canComment, ensureDoc, pageId]);

  const status = doc ? "ready" : docId || queried === undefined ? "loading" : "absent";
  return {
    status,
    ...(docId ? { docId } : {}),
    ...(doc ? { doc } : {}),
    threads,
    ensure,
  };
}
