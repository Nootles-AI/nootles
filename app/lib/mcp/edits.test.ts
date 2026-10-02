import { BlockNoteEditor } from "@blocknote/core";
import { yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readerSchema } from "@/app/lib/ai/readerSchema";
import { executeNmlCommands } from "@/app/lib/nml/commands";
import { NmlLegacyMirror } from "@/app/lib/nml/mirror";
import { blockNoteNmlMirrorHost } from "@/app/lib/nml/mirrorBlockNote";
import type { NmlBlock, NmlDocument } from "@/app/lib/nml/schema";
import { writeCompatibilityRoot } from "@/app/lib/nml/serverMirror";
import { createNmlYDoc, decodeNmlDocument } from "@/app/lib/nml/yjs";
import { EditInputError, parseEditOps, prepareEdit, prepareUndo, type PreparedEdit } from "./edits";

if (!("document" in globalThis)) {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document, window });
}

const para = (id: string, text: string, children: NmlBlock[] = []): NmlBlock => ({
  id,
  type: "paragraph",
  props: {},
  content: [{ type: "text", text, marks: [] }],
  children,
});

const FIXTURE: NmlDocument = {
  schemaVersion: 1,
  documentId: "doc-1",
  blocks: [
    { id: "h", type: "heading", props: { level: 1 }, content: [{ type: "text", text: "Launch plan", marks: [] }], children: [] },
    para("goal", "Ship the connector this week."),
    { id: "list", type: "bulletListItem", props: {}, content: [{ type: "text", text: "Beta", marks: [] }], children: [para("nested", "Invite testers")] },
    para("tail", "Notes"),
  ],
};

const bytes = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** A stored history as the server holds it: one update per append. */
class Store {
  updates: ArrayBuffer[] = [];
  constructor(document: NmlDocument = FIXTURE) {
    const doc = createNmlYDoc(document);
    writeCompatibilityRoot(doc, document);
    this.updates.push(bytes(Y.encodeStateAsUpdate(doc)));
    doc.destroy();
  }
  append(update: Uint8Array) {
    this.updates.push(bytes(update));
  }
  doc() {
    const doc = new Y.Doc();
    for (const u of this.updates) Y.applyUpdate(doc, new Uint8Array(u));
    return doc;
  }
  read(): NmlDocument {
    const doc = this.doc();
    try {
      return decodeNmlDocument(doc);
    } finally {
      doc.destroy();
    }
  }
  /** The compaction `ydoc.compact` does: fold into one GC'd snapshot. */
  compact() {
    const doc = new Y.Doc({ gc: true });
    for (const u of this.updates) Y.applyUpdate(doc, new Uint8Array(u));
    this.updates = [bytes(Y.encodeStateAsUpdate(doc))];
    doc.destroy();
  }
  /** A person's edit through the executor, as a served browser commits it. */
  async human(commands: Parameters<typeof executeNmlCommands>[0]["commands"]) {
    const doc = this.doc();
    const start = Y.encodeStateVector(doc);
    const before = decodeNmlDocument(doc);
    await executeNmlCommands({
      doc,
      documentId: "doc-1",
      commands,
      origin: { version: 1, transactionId: `h-${Math.random()}`, actor: { kind: "human", userId: "aryan" }, command: "type" },
      idempotencyKey: `h-${Math.random()}`,
      authorize: () => true,
    });
    writeCompatibilityRoot(doc, before);
    this.append(Y.encodeStateAsUpdate(doc, start));
    doc.destroy();
  }
}

let ids = 0;
async function edit(store: Store, ops: unknown[], key = `key-${++ids}`): Promise<PreparedEdit> {
  return await prepareEdit({
    updates: store.updates,
    batch: parseEditOps(ops),
    actor: { userId: "aryan", clientId: "mcp:grant" },
    batchId: `batch-${ids}`,
    idempotencyKey: key,
    createId: () => `new-${++ids}`,
    writeCompat: (doc, before) => writeCompatibilityRoot(doc, before),
  });
}

const texts = (document: NmlDocument) => {
  const out: string[] = [];
  const walk = (blocks: NmlBlock[]) =>
    blocks.forEach((b) => {
      out.push(`${b.id}:${"content" in b ? b.content.map((c) => (c.type === "text" ? c.text : "")).join("") : b.type}`);
      walk(b.children);
    });
  walk(document.blocks);
  return out;
};

function legacyTexts(doc: Y.Doc): string[] {
  const editor = BlockNoteEditor.create({ schema: readerSchema });
  const blocks = yXmlFragmentToBlocks(editor, doc.getXmlFragment("prosemirror")) as Array<{
    id: string;
    content?: Array<{ text?: string }>;
    children: unknown[];
  }>;
  const out: string[] = [];
  const walk = (list: typeof blocks) =>
    list.forEach((b) => {
      out.push(`${b.id}:${(b.content ?? []).map((c) => c.text ?? "").join("")}`);
      walk(b.children as typeof blocks);
    });
  walk(blocks);
  return out;
}

describe("parseEditOps", () => {
  it("takes plain strings for inline content, everywhere inline content goes", () => {
    const batch = parseEditOps([
      { kind: "setBlockContent", blockId: "goal", content: "Plain words" },
      { kind: "insertBlocks", at: { at: "docEnd" }, blocks: [{ tempId: "a", type: "paragraph", content: "New", children: [{ tempId: "b", type: "paragraph", content: "Kid" }] }] },
    ]);
    expect(batch.ops[0]).toEqual({ kind: "setBlockContent", blockId: "goal", content: [{ type: "text", text: "Plain words" }] });
    expect(batch.ops[1]).toMatchObject({ blocks: [{ content: [{ text: "New" }], children: [{ content: [{ text: "Kid" }] }] }] });
  });

  it("names the bad field", () => {
    expect(() => parseEditOps([])).toThrow(EditInputError);
    expect(() => parseEditOps([{ kind: "explode" }])).toThrow(/operations\.0/);
    expect(() => parseEditOps([{ kind: "removeBlock" }])).toThrow(/operations\.0\.blockId/);
    expect(() => parseEditOps(Array.from({ length: 101 }, () => ({ kind: "removeBlock", blockId: "x" })))).toThrow(/At most 100/);
  });
});

describe("prepareEdit", () => {
  it("lands one model batch on canonical NML and the compatibility root together", async () => {
    const store = new Store();
    const result = await edit(store, [
      { kind: "setBlockContent", blockId: "goal", content: [{ type: "text", text: "Ship it ", marks: [] }, { type: "text", text: "today", marks: ["bold"] }] },
      { kind: "insertBlocks", at: { at: "after", ref: "goal" }, blocks: [{ tempId: "risk", type: "checkListItem", content: "Write the docs" }] },
    ]);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    store.append(result.forward);

    const newId = result.created.risk;
    expect(newId).toMatch(/^new-\d+$/);
    expect(texts(store.read())).toEqual(["h:Launch plan", "goal:Ship it today", `${newId}:Write the docs`, "list:Beta", "nested:Invite testers", "tail:Notes"]);
    const doc = store.doc();
    expect(legacyTexts(doc)).toEqual(texts(store.read()));
    doc.destroy();
    expect(result.changes).toEqual([
      { kind: "changed", id: "goal", type: "paragraph", text: "Ship it today" },
      { kind: "added", id: newId, type: "checkListItem", text: "Write the docs" },
    ]);
    // Fingerprints only: no content in what is stored to check an undo by.
    expect(JSON.stringify(result.touched)).not.toMatch(/Ship|docs/);
  });

  it("gives a stale client's mirror nothing to do", async () => {
    const store = new Store();
    const result = await edit(store, [{ kind: "setBlockContent", blockId: "tail", content: "Notes, revised" }]);
    if (result.status !== "applied") throw new Error(result.status);
    const client = new Y.Doc();
    for (const u of store.updates) Y.applyUpdate(client, new Uint8Array(u));
    const editor = BlockNoteEditor.create({ schema: readerSchema });
    const mirror = new NmlLegacyMirror(client, blockNoteNmlMirrorHost(editor, client), { actor: { kind: "human", userId: "aryan" } }).start();
    await mirror.settle();
    const writes: Uint8Array[] = [];
    client.on("update", (u: Uint8Array) => writes.push(u));
    Y.applyUpdate(client, result.forward, "provider");
    await mirror.settle();
    expect(writes).toHaveLength(1);
    expect(texts(decodeNmlDocument(client)).at(-1)).toBe("tail:Notes, revised");
    expect(legacyTexts(client).at(-1)).toBe("tail:Notes, revised");
    mirror.stop();
    client.destroy();
  });

  it("is idempotent on its key and refuses a batch that names a block that is not there", async () => {
    const store = new Store();
    const first = await edit(store, [{ kind: "setBlockContent", blockId: "tail", content: "Once" }], "same");
    if (first.status !== "applied") throw new Error(first.status);
    store.append(first.forward);
    const again = await edit(store, [{ kind: "setBlockContent", blockId: "tail", content: "Once" }], "same");
    expect(again.status).toBe("replayed");
    const missing = await edit(store, [{ kind: "removeBlock", blockId: "nope" }]);
    expect(missing).toMatchObject({ status: "rejected", operationIndex: 0 });
  });
});

describe("prepareUndo", () => {
  it("puts every touched node back exactly, both roots", async () => {
    const store = new Store();
    const before = store.read();
    const result = await edit(store, [
      { kind: "removeBlock", blockId: "list" },
      { kind: "moveBlock", blockId: "tail", to: { at: "docStart" } },
      { kind: "setBlockContent", blockId: "goal", content: "Rewritten" },
      { kind: "insertBlocks", at: { at: "docEnd" }, blocks: [{ tempId: "x", type: "quote", content: "Added" }] },
    ]);
    if (result.status !== "applied") throw new Error(result.status);
    store.append(result.forward);
    expect(result.changes.map((c) => [c.kind, c.id])).toEqual([
      ["changed", "goal"],
      ["added", result.created.x],
      ["removed", "list"],
      ["moved", "tail"],
    ]);

    const undo = prepareUndo({ updates: store.updates, inverse: bytes(result.inverse), touched: result.touched, writeCompat: (d, before) => writeCompatibilityRoot(d, before) });
    if (undo.status !== "ready") throw new Error(undo.status);
    store.append(undo.update);
    expect(store.read()).toEqual(before);
    const doc = store.doc();
    expect(legacyTexts(doc)).toEqual(texts(before));
    doc.destroy();
  });

  it("still works after the log is folded into a GC'd snapshot", async () => {
    const store = new Store();
    const before = store.read();
    const result = await edit(store, [{ kind: "removeBlock", blockId: "goal" }]);
    if (result.status !== "applied") throw new Error(result.status);
    store.append(result.forward);
    store.compact();
    const undo = prepareUndo({ updates: store.updates, inverse: bytes(result.inverse), touched: result.touched });
    if (undo.status !== "ready") throw new Error(undo.status);
    store.append(undo.update);
    expect(texts(store.read())).toEqual(texts(before));
  });

  it("keeps a person's later edit elsewhere on the page", async () => {
    const store = new Store();
    const result = await edit(store, [{ kind: "setBlockContent", blockId: "goal", content: "Agent words" }]);
    if (result.status !== "applied") throw new Error(result.status);
    store.append(result.forward);
    await store.human([{ type: "replaceInline", nodeId: "tail", range: { from: 0, to: 5 }, content: [{ type: "text", text: "Human notes", marks: [] }] }]);
    const undo = prepareUndo({ updates: store.updates, inverse: bytes(result.inverse), touched: result.touched });
    if (undo.status !== "ready") throw new Error(undo.status);
    store.append(undo.update);
    expect(texts(store.read())).toEqual(["h:Launch plan", "goal:Ship the connector this week.", "list:Beta", "nested:Invite testers", "tail:Human notes"]);
  });

  it("refuses when a person has since changed what the agent changed", async () => {
    const store = new Store();
    const result = await edit(store, [{ kind: "setBlockContent", blockId: "goal", content: "Agent words" }]);
    if (result.status !== "applied") throw new Error(result.status);
    store.append(result.forward);
    await store.human([{ type: "replaceInline", nodeId: "goal", range: { from: 0, to: 5 }, content: [{ type: "text", text: "Human", marks: [] }] }]);
    const undo = prepareUndo({ updates: store.updates, inverse: bytes(result.inverse), touched: result.touched });
    expect(undo).toEqual({ status: "changed-since", ids: ["goal"] });
  });

  it("refuses when a person nested something under a block the agent added", async () => {
    const store = new Store();
    const result = await edit(store, [{ kind: "insertBlocks", at: { at: "docEnd" }, blocks: [{ tempId: "p", type: "bulletListItem", content: "Agent item" }] }]);
    if (result.status !== "applied") throw new Error(result.status);
    store.append(result.forward);
    await store.human([{ type: "insertNodes", parentId: result.created.p, nodes: [para("mine", "Mine")] }]);
    const undo = prepareUndo({ updates: store.updates, inverse: bytes(result.inverse), touched: result.touched });
    expect(undo).toMatchObject({ status: "changed-since", ids: [result.created.p] });
  });
});
