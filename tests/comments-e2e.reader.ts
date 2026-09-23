import * as Y from "yjs";
import type { ConvexHttpClient } from "convex/browser";
import { readYDocUpdates } from "../app/lib/sync/ydocRead";
import { readThreads } from "../app/lib/comments/store";
import { commentText } from "../app/lib/comments/types";
import { decodeNmlDocument } from "../app/lib/nml/yjs";
import { serializeDocument } from "../app/lib/nml/serialize";

/**
 * The full-stack suite's reading hands on the server, run in Node
 * (comments-e2e.fullstack.mjs bundles this for it): a stored Yjs document
 * fetched over HTTP through the same wire reader the app uses, and decoded
 * afresh — never a copy any browser holds.
 */

async function stored(client: ConvexHttpClient, docId: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  for (const update of await readYDocUpdates(client as never, docId)) Y.applyUpdate(doc, new Uint8Array(update));
  return doc;
}

export async function storedThreads(client: ConvexHttpClient, docId: string) {
  const doc = await stored(client, docId);
  const threads = readThreads(doc).map((t) => ({
    id: t.id,
    blockId: t.anchor.blockId,
    exact: t.anchor.exact,
    status: t.status,
    orphaned: t.orphanedAt !== undefined,
    comments: t.comments.map((c) => ({
      id: c.id,
      text: commentText(c.content),
      authorId: c.authorId,
      ...(c.via ? { via: c.via } : {}),
    })),
  }));
  doc.destroy();
  return threads;
}

/** The comments document as NML text: what two converged replicas must agree on. */
export async function storedCommentsNml(client: ConvexHttpClient, docId: string): Promise<string> {
  const doc = await stored(client, docId);
  const text = serializeDocument(decodeNmlDocument(doc));
  doc.destroy();
  return text;
}

/** Each block's words in the stored page (its BlockNote fragment), in order. */
export async function storedBlocks(client: ConvexHttpClient, docId: string): Promise<{ id: string; text: string }[]> {
  const doc = await stored(client, docId);
  const blocks: { id: string; text: string }[] = [];
  const textOf = (node: Y.XmlElement | Y.XmlText): string =>
    node instanceof Y.XmlText
      ? node.toDelta().map((op: { insert: unknown }) => (typeof op.insert === "string" ? op.insert : "")).join("")
      : node.toArray().filter((child) => !(child instanceof Y.XmlElement && child.nodeName === "blockGroup"))
          .map((child) => textOf(child as Y.XmlElement | Y.XmlText)).join("");
  const walk = (node: Y.XmlFragment | Y.XmlElement) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === "blockContainer") blocks.push({ id: String(child.getAttribute("id")), text: textOf(child) });
      walk(child);
    }
  };
  walk(doc.getXmlFragment("prosemirror"));
  doc.destroy();
  return blocks;
}

/** A well-formed update no app surface would write: what a raw `ydoc.append` carries. */
export function forgedUpdate(by: string): ArrayBuffer {
  const doc = new Y.Doc();
  doc.getMap("forged").set("by", by);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength) as ArrayBuffer;
}
