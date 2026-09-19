import { describe, expect, it, vi } from "vitest";
import { createNmlYDoc, decodeNmlDocument, executeNmlCommands, type NmlDocument } from ".";
import {
  NML_LEGACY_MIRROR_ORIGIN,
  NmlLegacyMirror,
  preserveLegacyOnlyIdentities,
  type NmlLegacyMirrorHost,
} from "./mirror";
import type { LegacyBlock } from "./legacy";

const actor = { kind: "human", userId: "mirror-user" } as const;
const fixture = (): NmlDocument => ({
  schemaVersion: 1,
  documentId: "mirror-doc",
  blocks: [{
    id: "p", type: "paragraph", props: {}, children: [],
    content: [
      { type: "text", text: "hello ", marks: ["bold"] },
      { type: "math", id: "inline-math", latex: "x" },
      { type: "pageRef", id: "inline-page", pageId: "page-2", fallbackTitle: "Page two" },
    ],
  }, {
    id: "code", type: "codeBlock", props: { language: "ts" }, children: [], code: "const x = 1",
  }, {
    id: "table", type: "table", props: { headerRows: 1 }, children: [],
    columns: [{ id: "column-a" }, { id: "column-b" }],
    rows: [{ id: "row-a", cells: [
      { id: "cell-a", content: [{ type: "text", text: "A", marks: [] }] },
      { id: "cell-b", content: [{ type: "text", text: "B", marks: [] }] },
    ] }],
  }],
});

class MemoryHost implements NmlLegacyMirrorHost {
  blocks: LegacyBlock[] = [{ id: "stale", type: "paragraph", content: [{ type: "text", text: "stale", styles: {} }] }];
  private listeners = new Set<(origin: unknown) => void>();
  readBlocks = () => structuredClone(this.blocks);
  writeBlocks = (blocks: LegacyBlock[], origin: typeof NML_LEGACY_MIRROR_ORIGIN) => {
    this.blocks = structuredClone(blocks);
    this.emit(origin);
  };
  subscribe = (listener: (origin: unknown) => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  emit(origin: unknown = "legacy-client") { this.listeners.forEach((listener) => listener(origin)); }
}

describe("NML ↔ legacy live mirror", () => {
  it("coalesces a queued legacy burst before compiling it into canonical commands", async () => {
    const document = fixture();
    const paragraph = document.blocks[0];
    if (!("content" in paragraph)) throw new Error("Fixture mismatch");
    paragraph.content = [{ type: "text", text: "Start", marks: [] }];
    const doc = createNmlYDoc(document);
    const host = new MemoryHost();
    const errors = vi.fn();
    const mirror = new NmlLegacyMirror(doc, host, { actor, onError: errors }).start();
    const mirrorTransactions: unknown[] = [];
    doc.on("afterTransaction", (transaction) => {
      if (transaction.origin && typeof transaction.origin === "object" &&
          (transaction.origin as { command?: string }).command === "legacy-mirror") {
        mirrorTransactions.push(transaction.origin);
      }
    });

    host.blocks[0].content = [{ type: "text", text: "Start a", styles: {} }];
    host.emit();
    host.blocks[0].content = [{ type: "text", text: "Start ab", styles: {} }];
    host.emit();
    await mirror.settle();

    expect(decodeNmlDocument(doc).blocks[0]).toMatchObject({
      content: [{ type: "text", text: "Start ab", marks: [] }],
    });
    expect(mirrorTransactions).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
    mirror.stop(); doc.destroy();
  });

  it("keeps coalescing while asynchronous authorization is pending", async () => {
    const document = fixture();
    const paragraph = document.blocks[0];
    if (!("content" in paragraph)) throw new Error("Fixture mismatch");
    paragraph.content = [{ type: "text", text: "Start", marks: [] }];
    const doc = createNmlYDoc(document);
    const host = new MemoryHost();
    let releaseAuthorization!: (allowed: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => { releaseAuthorization = resolve; });
    const authorize = vi.fn(() => authorization);
    const createRequestId = vi.fn(() => "coalesced-request");
    const mirror = new NmlLegacyMirror(doc, host, {
      actor,
      authorize,
      createRequestId,
    }).start();

    host.blocks[0].content = [{ type: "text", text: "Start a", styles: {} }];
    host.emit();
    await Promise.resolve();
    expect(authorize).toHaveBeenCalledTimes(1);
    host.blocks[0].content = [{ type: "text", text: "Start ab", styles: {} }];
    host.emit();
    host.blocks[0].content = [{ type: "text", text: "Start abc", styles: {} }];
    host.emit();
    releaseAuthorization(true);
    await mirror.settle();

    expect(decodeNmlDocument(doc).blocks[0]).toMatchObject({
      content: [{ type: "text", text: "Start abc", marks: [] }],
    });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(createRequestId).toHaveBeenCalledTimes(1);
    mirror.stop(); doc.destroy();
  });

  it("preserves an interleaved canonical write while coalescing a legacy burst", async () => {
    const document = fixture();
    const paragraph = document.blocks[0];
    if (!("content" in paragraph)) throw new Error("Fixture mismatch");
    paragraph.content = [{ type: "text", text: "Start", marks: [] }];
    const doc = createNmlYDoc(document);
    const host = new MemoryHost();
    const mirror = new NmlLegacyMirror(doc, host, { actor }).start();

    host.blocks[0].content = [{ type: "text", text: "Start a", styles: {} }];
    host.emit();
    host.blocks[0].content = [{ type: "text", text: "Start ab", styles: {} }];
    host.emit();
    await executeNmlCommands({
      doc,
      documentId: "mirror-doc",
      commands: [{ type: "setCode", nodeId: "code", range: { from: 0, to: 11 }, text: "direct code" }],
      idempotencyKey: "direct-during-burst",
      origin: { version: 1, transactionId: "direct-during-burst", actor, command: "test" },
      authorize: () => true,
    });
    await mirror.settle();

    const canonical = decodeNmlDocument(doc);
    expect(canonical.blocks[0]).toMatchObject({
      content: [{ type: "text", text: "Start ab", marks: [] }],
    });
    expect(canonical.blocks[1]).toMatchObject({ type: "codeBlock", code: "direct code" });
    mirror.stop(); doc.destroy();
  });

  it("preserves a same-block canonical insertion beside the latest legacy edit", async () => {
    const document = fixture();
    const paragraph = document.blocks[0];
    if (!("content" in paragraph)) throw new Error("Fixture mismatch");
    paragraph.content = [{ type: "text", text: "Start", marks: [] }];
    const doc = createNmlYDoc(document);
    const host = new MemoryHost();
    const mirror = new NmlLegacyMirror(doc, host, { actor }).start();

    host.blocks[0].content = [{ type: "text", text: "Start legacy", styles: {} }];
    host.emit();
    await executeNmlCommands({
      doc,
      documentId: "mirror-doc",
      commands: [{
        type: "replaceInline",
        nodeId: "p",
        range: { from: 5, to: 5 },
        content: [{ type: "text", text: " canonical", marks: [] }],
      }],
      idempotencyKey: "same-block-canonical",
      origin: { version: 1, transactionId: "same-block-canonical", actor, command: "test" },
      authorize: () => true,
    });
    await mirror.settle();

    const canonical = JSON.stringify(decodeNmlDocument(doc).blocks[0]);
    expect(canonical.match(/legacy/g)).toHaveLength(1);
    expect(canonical.match(/canonical/g)).toHaveLength(1);
    mirror.stop(); doc.destroy();
  });

  it("coalesces structural snapshots without inserting the same node twice", async () => {
    const doc = createNmlYDoc(fixture());
    const host = new MemoryHost();
    const errors = vi.fn();
    const mirror = new NmlLegacyMirror(doc, host, { actor, onError: errors }).start();
    host.blocks.push({
      id: "new-paragraph",
      type: "paragraph",
      content: [{ type: "text", text: "draft", styles: {} }],
    });
    host.emit();
    host.blocks[3].content = [{ type: "text", text: "final", styles: {} }];
    host.emit();
    await mirror.settle();

    const inserted = decodeNmlDocument(doc).blocks.filter((block) => block.id === "new-paragraph");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      content: [{ type: "text", text: "final", marks: [] }],
    });
    expect(errors).not.toHaveBeenCalled();
    mirror.stop(); doc.destroy();
  });

  it("projects coalesced bursts through multiple mirrors without drift", async () => {
    const document = fixture();
    const paragraph = document.blocks[0];
    if (!("content" in paragraph)) throw new Error("Fixture mismatch");
    paragraph.content = [{ type: "text", text: "Start", marks: [] }];
    const doc = createNmlYDoc(document);
    const left = new MemoryHost();
    const right = new MemoryHost();
    const leftErrors = vi.fn();
    const rightErrors = vi.fn();
    const leftMirror = new NmlLegacyMirror(doc, left, { actor, onError: leftErrors }).start();
    const rightMirror = new NmlLegacyMirror(doc, right, { actor, onError: rightErrors }).start();

    left.blocks[0].content = [{ type: "text", text: "Start a", styles: {} }];
    left.emit();
    left.blocks[0].content = [{ type: "text", text: "Start ab", styles: {} }];
    left.emit();
    await Promise.all([leftMirror.settle(), rightMirror.settle()]);
    expect(left.blocks).toEqual(right.blocks);
    expect(decodeNmlDocument(doc).blocks[0]).toMatchObject({
      content: [{ type: "text", text: "Start ab", marks: [] }],
    });

    right.blocks[0].content = [{ type: "text", text: "Start abc", styles: {} }];
    right.emit();
    right.blocks[0].content = [{ type: "text", text: "Start abcd", styles: {} }];
    right.emit();
    await Promise.all([leftMirror.settle(), rightMirror.settle()]);
    expect(decodeNmlDocument(doc).blocks[0]).toMatchObject({
      content: [{ type: "text", text: "Start abcd", marks: [] }],
    });
    expect(leftErrors).not.toHaveBeenCalled();
    expect(rightErrors).not.toHaveBeenCalled();
    expect(left.blocks).toEqual(right.blocks);
    leftMirror.stop(); rightMirror.stop(); doc.destroy();
  });

  it("merges simultaneous coalesced bursts from multiple mirrors", async () => {
    const document = fixture();
    const paragraph = document.blocks[0];
    if (!("content" in paragraph)) throw new Error("Fixture mismatch");
    paragraph.content = [{ type: "text", text: "Start", marks: [] }];
    const doc = createNmlYDoc(document);
    const left = new MemoryHost();
    const right = new MemoryHost();
    const leftErrors = vi.fn();
    const rightErrors = vi.fn();
    const leftMirror = new NmlLegacyMirror(doc, left, { actor, onError: leftErrors }).start();
    const rightMirror = new NmlLegacyMirror(doc, right, { actor, onError: rightErrors }).start();

    left.blocks[0].content = [{ type: "text", text: "Start left", styles: {} }];
    left.emit();
    left.blocks[0].content = [{ type: "text", text: "Start LEFT", styles: {} }];
    left.emit();
    right.blocks[0].content = [{ type: "text", text: "Start right", styles: {} }];
    right.emit();
    right.blocks[0].content = [{ type: "text", text: "Start RIGHT", styles: {} }];
    right.emit();
    await Promise.all([leftMirror.settle(), rightMirror.settle()]);

    const canonical = JSON.stringify(decodeNmlDocument(doc).blocks[0]);
    expect(canonical.match(/LEFT/g)).toHaveLength(1);
    expect(canonical.match(/RIGHT/g)).toHaveLength(1);
    expect(left.blocks).toEqual(right.blocks);
    expect(leftErrors).not.toHaveBeenCalled();
    expect(rightErrors).not.toHaveBeenCalled();
    leftMirror.stop(); rightMirror.stop(); doc.destroy();
  });

  it("initializes from canonical NML and compiles legacy edits back to commands", async () => {
    const doc = createNmlYDoc(fixture());
    const host = new MemoryHost();
    let minted = 0;
    const errors = vi.fn();
    const mirror = new NmlLegacyMirror(doc, host, {
      actor,
      createId: () => `minted-${++minted}`,
      onError: errors,
    }).start();
    expect(host.blocks.map((block) => block.id)).toEqual(["p", "code", "table"]);
    const paragraph = host.blocks[0];
    paragraph.content = [
      { type: "text", text: "changed ", styles: { italic: true } },
      { type: "math", props: { latex: "y" } },
      { type: "pageMention", props: { pageId: "page-2", title: "Page two" } },
    ];
    host.blocks[1].props = { language: "python", code: "answer = 42" };
    host.emit();
    await mirror.settle();
    const canonical = decodeNmlDocument(doc);
    expect(canonical.blocks[0]).toMatchObject({
      content: [
        { type: "text", text: "changed ", marks: ["italic"] },
        { type: "math", id: "inline-math", latex: "y" },
        { type: "pageRef", id: "inline-page", pageId: "page-2" },
      ],
    });
    expect(canonical.blocks[1]).toMatchObject({ props: { language: "python" }, code: "answer = 42" });
    expect(canonical.blocks[2]).toMatchObject({
      columns: [{ id: "column-a" }, { id: "column-b" }],
      rows: [{ id: "row-a", cells: [{ id: "cell-a" }, { id: "cell-b" }] }],
    });
    expect(errors).not.toHaveBeenCalled();
    mirror.stop(); doc.destroy();
  });

  it("projects direct canonical edits to every legacy client and converges their writes", async () => {
    const doc = createNmlYDoc(fixture());
    const left = new MemoryHost();
    const right = new MemoryHost();
    const leftMirror = new NmlLegacyMirror(doc, left, { actor }).start();
    const rightMirror = new NmlLegacyMirror(doc, right, { actor }).start();
    await executeNmlCommands({
      doc,
      documentId: "mirror-doc",
      commands: [{ type: "replaceInline", nodeId: "p", range: { from: 0, to: 5 }, content: [{ type: "text", text: "direct", marks: [] }] }],
      idempotencyKey: "direct",
      origin: { version: 1, transactionId: "direct", actor, command: "test" },
      authorize: () => true,
    });
    expect(JSON.stringify(left.blocks)).toContain("direct");
    expect(left.blocks).toEqual(right.blocks);

    left.blocks[0].content = [{ type: "text", text: "from legacy", styles: {} }];
    left.emit();
    await leftMirror.settle();
    expect(JSON.stringify(decodeNmlDocument(doc))).toContain("from legacy");
    expect(left.blocks).toEqual(right.blocks);
    leftMirror.stop(); rightMirror.stop(); doc.destroy();
  });

  it("preserves an independent canonical edit that interleaves with a legacy write", async () => {
    const doc = createNmlYDoc(fixture());
    const host = new MemoryHost();
    const mirror = new NmlLegacyMirror(doc, host, { actor }).start();
    host.blocks[0].content = [{ type: "text", text: "legacy prose", styles: {} }];
    host.emit();
    await executeNmlCommands({
      doc,
      documentId: "mirror-doc",
      commands: [{ type: "setCode", nodeId: "code", range: { from: 0, to: 11 }, text: "direct code" }],
      idempotencyKey: "interleaved-direct",
      origin: { version: 1, transactionId: "interleaved-direct", actor, command: "test" },
      authorize: () => true,
    });
    await mirror.settle();
    const canonical = decodeNmlDocument(doc);
    expect(JSON.stringify(canonical.blocks[0])).toContain("legacy prose");
    expect(canonical.blocks[1]).toMatchObject({ type: "codeBlock", code: "direct code" });
    mirror.stop(); doc.destroy();
  });

  it("reattaches hidden identities deterministically", () => {
    const before = fixture();
    const after = structuredClone(before);
    const paragraph = after.blocks[0];
    if (!("content" in paragraph)) throw new Error("Fixture mismatch");
    paragraph.content = [
      { type: "text", text: "prefix", marks: [] },
      { type: "math", id: "new-math", latex: "x" },
      { type: "pageRef", id: "new-page", pageId: "page-2", fallbackTitle: "Page two" },
    ];
    const table = after.blocks[2];
    if (table.type !== "table") throw new Error("Fixture mismatch");
    table.columns.forEach((column, index) => { column.id = `new-column-${index}`; });
    table.rows[0].id = "new-row";
    table.rows[0].cells.forEach((cell, index) => { cell.id = `new-cell-${index}`; });
    preserveLegacyOnlyIdentities(before, after);
    expect(paragraph.content.slice(1)).toMatchObject([{ id: "inline-math" }, { id: "inline-page" }]);
    expect(table.columns.map((column) => column.id)).toEqual(["column-a", "column-b"]);
    expect(table.rows[0]).toMatchObject({ id: "row-a", cells: [{ id: "cell-a" }, { id: "cell-b" }] });
  });

  it("drains an already-observed write after stop for authority transitions", async () => {
    const doc = createNmlYDoc(fixture());
    const host = new MemoryHost();
    const mirror = new NmlLegacyMirror(doc, host, { actor }).start();
    host.blocks[0].content = [{ type: "text", text: "queued", styles: {} }];
    host.emit();
    mirror.stop();
    await mirror.settle();
    // Authority may flip between the fragment event and the async command
    // executor. An edit observed before cleanup still drains into canonical
    // NML, so flipping serving back on cannot erase it.
    expect(JSON.stringify(decodeNmlDocument(doc))).toContain("queued");
    doc.destroy();
  });

  it("captures model attribution at the legacy transaction boundary", async () => {
    const doc = createNmlYDoc(fixture());
    const host = new MemoryHost();
    let modelWrite = false;
    const mirror = new NmlLegacyMirror(doc, host, {
      actor,
      actorForChange: () => modelWrite
        ? { kind: "model", userId: "agent" }
        : actor,
    }).start();
    let observed: unknown;
    doc.on("afterTransaction", (transaction) => {
      if (transaction.origin && typeof transaction.origin === "object" &&
          (transaction.origin as { command?: string }).command === "legacy-mirror") {
        observed = transaction.origin;
      }
    });
    modelWrite = true;
    host.blocks[0].content = [{ type: "text", text: "agent edit", styles: {} }];
    host.emit();
    modelWrite = false;
    await mirror.settle();
    expect(observed).toMatchObject({ actor: { kind: "model", userId: "agent" } });
    mirror.stop(); doc.destroy();
  });

  it("hydrates storage-backed media into the derived legacy projection", async () => {
    const document: NmlDocument = {
      schemaVersion: 1,
      documentId: "storage-mirror",
      blocks: [{
        id: "image", type: "image", children: [],
        props: { source: { kind: "storage", storageId: "stored-image" }, caption: "Stored" },
      }],
    };
    const doc = createNmlYDoc(document);
    const host = new MemoryHost();
    const mirror = new NmlLegacyMirror(doc, host, {
      actor,
      resolveStorageUrl: async (storageId) => `https://files.example/${storageId}`,
    }).start();
    await mirror.settle();
    expect(host.blocks[0]).toMatchObject({
      id: "image",
      props: { url: "https://files.example/stored-image", caption: "Stored" },
    });
    mirror.stop(); doc.destroy();
  });
});
