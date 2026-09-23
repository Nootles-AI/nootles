import * as Y from "yjs";
import { executeNmlCommands, type NmlCommand } from "@/app/lib/nml/commands";
import type { NmlCommentBlock, NmlCommentThreadBlock } from "@/app/lib/nml/schema";
import { decodeNmlDocument } from "@/app/lib/nml/yjs";

/**
 * Raw comments-document updates for tests of what the server lets land: built
 * with the executor (which checks no authorship, as a forger's client would
 * not) or with plain Yjs, against a replica of what the server holds.
 */

export function bytes(update: Uint8Array): ArrayBuffer {
  return update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength) as ArrayBuffer;
}

/** An update that changes nothing: what a gate test sends when only the gate is on trial. */
export function noChange(): ArrayBuffer {
  return bytes(Y.encodeStateAsUpdate(new Y.Doc()));
}

/** What `change` does to `doc`, as the one update a provider would send. */
export async function updateOf(doc: Y.Doc, change: () => unknown): Promise<ArrayBuffer> {
  const sent: Uint8Array[] = [];
  const listen = (update: Uint8Array) => void sent.push(update);
  doc.on("update", listen);
  try {
    await change();
  } finally {
    doc.off("update", listen);
  }
  return sent.length ? bytes(Y.mergeUpdates(sent)) : noChange();
}

export function comment(id: string, authorId: string, text = "A comment", props: Partial<NmlCommentBlock["props"]> = {}): NmlCommentBlock {
  return { id, type: "comment", props: { authorId, createdAt: 10, ...props }, content: [{ type: "text", text, marks: [] }], children: [] };
}

export function thread(id: string, comments: NmlCommentBlock[]): NmlCommentThreadBlock {
  return {
    id,
    type: "commentThread",
    props: { anchor: { blockId: "p_1", exact: "page", prefix: "", suffix: "", offsetHint: 0 }, status: "open" },
    children: comments,
  };
}

let transactions = 0;

/** Runs NML commands on a replica, as `userId`, with nobody asking whether they may. */
export async function run(doc: Y.Doc, userId: string, commands: NmlCommand[]): Promise<void> {
  const transactionId = `fixture:${++transactions}`;
  await executeNmlCommands({
    doc,
    documentId: decodeNmlDocument(doc).documentId,
    commands,
    origin: { version: 1, transactionId, actor: { userId, kind: "human" }, command: "fixture" },
    idempotencyKey: transactionId,
    authorize: () => true,
  });
}

/** The update that starts `threadId` on the replica, its one comment signed `authorId`. */
export function startThread(doc: Y.Doc, userId: string, threadId: string, authorId = userId, commentId = `${threadId}-c1`) {
  return updateOf(doc, () =>
    run(doc, userId, [{ type: "insertNodes", parentId: null, nodes: [thread(threadId, [comment(commentId, authorId)])] }]),
  );
}
