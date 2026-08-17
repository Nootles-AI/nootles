"use client";

import type { EditorView } from "prosemirror-view";
import * as Y from "yjs";
import {
  armFlash,
  flashBlocksInView,
} from "@/app/components/editor/arrivalFlash";
import type { YConvexProvider } from "./YConvexProvider";
import { peekProvider } from "./YConvexProvider";

/**
 * The arrival flash's transport: when someone's AI writes — an accepted tab
 * completion, an approved agent turn — the text lands on every OTHER screen
 * wearing the accent and settles into ink, FROM ITS FIRST PAINTED FRAME.
 * Amber means AI activity, and a frame of plain ink first would read as a
 * person typing impossibly fast, then a glitch.
 *
 * First-frame gold dictates the transport: the marker rides THE DOC ITSELF,
 * written in the same task as the content so both travel in one sync flush.
 * On arrival, `beforeObserverCalls` fires before the sync plugin dispatches
 * anything — the marker ARMS the flash (arrivalFlash.ts), and the very
 * transaction that first renders the content decorates it gold. Awareness
 * could never promise that order; a doc value can.
 *
 * The marker is one LWW entry per doc (`nt:flash`), overwritten per accept —
 * a few bytes that ride snapshots harmlessly and touch no reader: canvas
 * maps, the prosemirror fragment and this map share a doc, nothing more.
 */

type FlashMarker = { ids: string[]; n: number; by: number };

const FLASH_MAP = "nt:flash";

/**
 * Announce blocks someone's AI just wrote. MUST be called in the same task
 * as the content mutation (before or after both work — the provider batches
 * a task's updates into one flush), never deferred behind an await.
 */
export function broadcastFimFlash(docId: string, blockIds: string[]) {
  if (!blockIds.length) return;
  const provider = peekProvider(docId);
  if (!provider) return;
  provider.doc.transact(() => {
    provider.doc.getMap<FlashMarker>(FLASH_MAP).set("last", {
      ids: blockIds,
      n: Date.now(),
      by: provider.doc.clientID,
    });
  });
}

/**
 * Watches a provider's doc for other people's markers. Arms unseen blocks so
 * they render gold from their first frame; blocks already on screen (the
 * marker lost a race it usually wins) flash late instead.
 */
export function watchFimFlash(
  provider: YConvexProvider,
  getView: () => EditorView | null,
): () => void {
  let lastSeen = 0;

  const onBefore = (transaction: Y.Transaction) => {
    // Only what arrived from elsewhere: local writes are the accepter's own.
    if (transaction.origin !== provider) return;
    const marker = provider.doc
      .getMap<FlashMarker>(FLASH_MAP)
      .get("last");
    if (!marker || marker.by === provider.doc.clientID) return;
    if (marker.n <= lastSeen) return;
    lastSeen = marker.n;

    const view = getView();
    const present = new Set<string>();
    if (view) {
      view.state.doc.descendants((node) => {
        const id = node.attrs.id as string | undefined;
        if (id && marker.ids.includes(id)) present.add(id);
        return true;
      });
    }
    const unseen = marker.ids.filter((id) => !present.has(id));
    if (unseen.length) armFlash(unseen);
    if (present.size && view) {
      // Deferred out of the observer window: dispatching mid-apply re-enters
      // the sync plugin.
      const ids = [...present];
      setTimeout(() => {
        const live = getView();
        if (live) flashBlocksInView(live, ids);
      }, 0);
    }
  };

  provider.doc.on("beforeObserverCalls", onBefore);
  return () => {
    provider.doc.off("beforeObserverCalls", onBefore);
  };
}
