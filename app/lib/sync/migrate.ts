"use client";

import type { ConvexReactClient } from "convex/react";
import { prosemirrorToYDoc } from "y-prosemirror";
import * as Y from "yjs";
import { api } from "@/convex/_generated/api";
import { nodeFromSnapshot } from "@/app/lib/ai/snapshot";

/**
 * Moving one document from the legacy pipeline to Yjs, lazily, on first open
 * by someone who may write. No live-editor hand-off is needed: the server
 * already holds the whole document (snapshot + steps ARE the doc), so the
 * migrating client rebuilds it, converts, and submits — and the server's
 * first-writer-wins `init` settles any race. The loser's work is discarded
 * unused; the reactive `state` query is what flips every open tab over.
 */

function encode(doc: Y.Doc): ArrayBuffer {
  const u = Y.encodeStateAsUpdate(doc);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

/** A brand-new doc: nothing to convert, the editor bootstraps content. */
export async function initEmptyYDoc(client: ConvexReactClient, docId: string) {
  const doc = new Y.Doc();
  await client.mutation(api.ydoc.init, { docId, update: encode(doc) });
  doc.destroy();
}

export async function migrateLegacyDoc(client: ConvexReactClient, docId: string) {
  const snapshot = await client.query(api.prosemirror.getSnapshot, { id: docId });
  if (!snapshot.content) {
    await initEmptyYDoc(client, docId);
    return;
  }
  const since = await client.query(api.prosemirror.getSteps, {
    id: docId,
    version: snapshot.version,
  });
  const node = nodeFromSnapshot(snapshot.content, since.steps);
  const doc = prosemirrorToYDoc(node, "prosemirror");
  const legacyVersion = snapshot.version + since.steps.length;
  await client.mutation(api.ydoc.init, {
    docId,
    update: encode(doc),
    legacyVersion,
  });
  doc.destroy();
}
