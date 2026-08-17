"use client";

import type { EditorView } from "prosemirror-view";
import type { Transaction } from "yjs";
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
 * A flash names blocks a person just accepted; past this it is a page-sized
 * wash of gold that says nothing more, and the marker is a doc value that
 * should stay a few bytes.
 */
const MAX_FLASH_IDS = 256;

/**
 * The marker is a doc value ANY peer can write, and this runs inside a Yjs
 * observer — a throw here would disrupt applying the very update that
 * carried it. So: never trust the shape, never throw, drop what isn't a
 * plausible marker.
 */
function readMarker(raw: unknown): FlashMarker | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { ids, n, by } = raw as Record<string, unknown>;
  if (!Array.isArray(ids)) return null;
  const safe = ids
    .filter((id): id is string => typeof id === "string")
    .slice(0, MAX_FLASH_IDS);
  if (!safe.length) return null;
  return { ids: safe, n: n as number, by: by as number };
}

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
      ids: blockIds.slice(0, MAX_FLASH_IDS),
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
  // Seeded with whatever the doc already carries: markers persist in the
  // CRDT, and an old one must not replay on the session's first remote edit.
  // Newness is identity (n, by), not ordering — accepters' clocks can skew,
  // and a marker stamped "earlier" than the last is still a fresh accept.
  let seen = readMarker(provider.doc.getMap(FLASH_MAP).get("last"));

  const onBefore = (transaction: Transaction) => {
    // Only what arrived from elsewhere: local writes are the accepter's own.
    if (transaction.origin !== provider) return;
    const marker = readMarker(provider.doc.getMap(FLASH_MAP).get("last"));
    if (!marker || (seen && marker.n === seen.n && marker.by === seen.by)) return;
    seen = marker;
    if (marker.by === provider.doc.clientID) return;

    const view = getView();
    const wanted = new Set(marker.ids);
    const present = new Set<string>();
    if (view) {
      view.state.doc.descendants((node) => {
        const id = node.attrs.id as string | undefined;
        if (id && wanted.has(id)) present.add(id);
        // Ids live on block-level nodes; don't walk the inline content.
        return !node.isTextblock;
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
