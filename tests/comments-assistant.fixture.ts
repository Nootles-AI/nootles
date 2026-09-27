import { useCallback, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { observeThreads, threadsSnapshot } from "../app/lib/comments/store";
import { emptyCommentsDocument, type Thread } from "../app/lib/comments/types";
import type { CommentsDocState } from "../app/lib/comments/useCommentsDoc";
import { createNmlYDoc, isNmlOrigin, type NmlTransactionOrigin } from "../app/lib/nml/yjs";

/**
 * Stands in for `useCommentsDoc` in the assistant harness: the page's comments
 * document, minted on the first `ensure()` the way `comments.ensureDoc` mints
 * it (the empty root as the first update), and exchanging every update with a
 * collaborator's replica — which is what the harness asserts on, never the
 * copy the writer holds.
 */

const RELAYED = { relayed: true };
const NO_THREADS: Thread[] = [];

let local: Y.Doc | null = null;
let peer: Y.Doc | null = null;
const listeners = new Set<() => void>();

/**
 * A second page's comments, already there when the harness starts: someone
 * commented on the roadmap before this session. Not relayed — nothing here
 * writes to it, and the checks read what the assistant was told.
 */
export const ROADMAP = "page2";
const roadmap = createNmlYDoc(emptyCommentsDocument("roadmap-comments"));

export const commentsFixture = {
  local: () => local,
  peer: () => peer,
  roadmap: () => roadmap,
  ensured: 0,
  /** Every attributed transaction on the writer's copy, in order. */
  origins: [] as NmlTransactionOrigin[],
};

function mint(): Y.Doc {
  const doc = createNmlYDoc(emptyCommentsDocument("comments-doc"));
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc), RELAYED);
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== RELAYED) Y.applyUpdate(replica, update, RELAYED);
  });
  replica.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== RELAYED) Y.applyUpdate(doc, update, RELAYED);
  });
  doc.on("afterTransaction", (transaction: Y.Transaction) => {
    if (isNmlOrigin(transaction.origin)) commentsFixture.origins.push(transaction.origin);
  });
  local = doc;
  peer = replica;
  for (const listener of listeners) listener();
  return doc;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

const noSubscription = () => () => {};

export function useCommentsDoc(pageId: string, { canComment }: { canComment: boolean }): CommentsDocState {
  const launch = useSyncExternalStore(subscribe, () => local, () => null);
  const doc = pageId === ROADMAP ? roadmap : launch;
  const threads = useSyncExternalStore(
    useCallback((listener: () => void) => (doc ? observeThreads(doc, listener) : noSubscription()), [doc]),
    () => (doc ? threadsSnapshot(doc) : NO_THREADS),
    () => NO_THREADS,
  );
  const ensure = useCallback(async () => {
    if (!canComment) throw new Error("You can read these comments but not add to them.");
    if (pageId === ROADMAP) return roadmap;
    commentsFixture.ensured++;
    return local ?? mint();
  }, [canComment, pageId]);
  return {
    status: doc ? "ready" : "absent",
    ...(doc ? { docId: pageId === ROADMAP ? "roadmap-comments" : "comments-doc", doc } : {}),
    threads,
    refusal: null,
    dismissRefusal: () => {},
    ensure,
  };
}
