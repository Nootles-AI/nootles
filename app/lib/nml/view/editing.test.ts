import { describe, expect, it, vi } from "vitest";
import { TextSelection } from "prosemirror-state";
import * as Y from "yjs";
import {
  createNmlYDoc,
  decodeNmlDocument,
  executeNmlCommands,
  NmlCommandConflict,
  NML_LIMITS,
  NmlYjsIndex,
  type ExecuteNmlCommandsOptions,
  type NmlBlock,
  type NmlDocument,
  type NmlHeadingBlock,
  type NmlTextBlock,
} from "..";
import { PlainTextNmlBridge, type BridgeUpdate } from ".";

const actor = { userId: "editor", kind: "human" } as const;
const paragraph = (id: string, text = "hello"): NmlTextBlock => ({
  id, type: "paragraph", props: {}, children: [],
  content: text ? [{ type: "text", text, marks: [] }] : [],
});
const heading = (id: string, text = "Heading"): NmlHeadingBlock => ({
  id, type: "heading", props: { level: 2 }, children: [],
  content: text ? [{ type: "text", text, marks: [] }] : [],
});
const quote = (id: string, text = "Quote"): NmlTextBlock => ({
  id, type: "quote", props: {}, children: [],
  content: text ? [{ type: "text", text, marks: [] }] : [],
});
const document = (blocks: NmlBlock[] = [paragraph("p1")]): NmlDocument => ({
  schemaVersion: 1, documentId: "editing-test", blocks,
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const blockText = (block: NmlBlock | undefined) => block && "content" in block
  ? block.content.map((node) => node.type === "text" ? node.text : "").join("")
  : undefined;
const text = (bridge: PlainTextNmlBridge, nodeId: string) => blockText(bridge.getBlock(nodeId));
const replace = (bridge: PlainTextNmlBridge, nodeId: string, from: number, to: number, value: string) => {
  const start = bridge.index.get(nodeId)!.contentStart!;
  return bridge.dispatch(bridge.state.tr.insertText(value, start + from, start + to));
};
const editable = (
  doc: Y.Doc,
  overrides: Partial<ConstructorParameters<typeof PlainTextNmlBridge>[1]> = {},
  diagnostic = vi.fn(),
) => new PlainTextNmlBridge(doc, {
  actor,
  authorize: () => true,
  createRequestId: (() => { let id = 0; return () => `request-${++id}`; })(),
  ...overrides,
}, diagnostic);

describe("plain-text NML editing bridge", () => {
  it("edits paragraphs, headings, and quotes with optimistic requests and canonical acknowledgements", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "alpha"), heading("h", "beta"), quote("q", "gamma")]));
    const bridge = editable(ydoc);
    const events: BridgeUpdate[] = [];
    bridge.subscribe((event) => events.push(event));
    const updates = vi.fn();
    ydoc.on("update", updates);

    expect(replace(bridge, "p", 5, 5, "!")).toBe(true);
    expect(replace(bridge, "h", 0, 1, "B")).toBe(true);
    expect(replace(bridge, "q", 0, 5, "Quote updated")).toBe(true);
    await flush();

    expect([text(bridge, "p"), text(bridge, "h"), text(bridge, "q")]).toEqual(["alpha!", "Beta", "Quote updated"]);
    expect(decodeNmlDocument(ydoc)).toEqual(bridge.snapshot());
    expect(bridge.checkDrift()).toBe(true);
    expect(updates).toHaveBeenCalledTimes(3);
    expect(events.map((event) => event.request?.status).filter(Boolean)).toEqual([
      "optimistic", "acknowledged", "optimistic", "acknowledged", "optimistic", "acknowledged",
    ]);
    expect(events.filter((event) => event.request?.status === "acknowledged").every((event) => event.transaction === null)).toBe(true);
    expect(events.filter((event) => event.request).map((event) => event.request!.requestId)).toEqual([
      "request-1", "request-1", "request-2", "request-2", "request-3", "request-3",
    ]);
    bridge.destroy(); ydoc.destroy();
  });

  it("keeps selection-only transactions local and rejects every out-of-scope content shape", () => {
    const rich: NmlTextBlock = {
      ...paragraph("rich", ""),
      content: [{ type: "text", text: "marked", marks: ["bold"] }],
    };
    const list: NmlBlock = {
      id: "list", type: "bulletListItem", props: {}, children: [],
      content: [{ type: "text", text: "item", marks: [] }],
    };
    const ydoc = createNmlYDoc(document([paragraph("plain", "safe"), rich, list]));
    const report = vi.fn();
    const bridge = editable(ydoc, {}, report);
    const before = Y.encodeStateAsUpdate(ydoc);
    const start = bridge.index.get("plain")!.contentStart!;

    expect(bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, start + 2)))).toBe(true);
    expect(bridge.state.selection.from).toBe(start + 2);
    expect(bridge.dispatch(bridge.state.tr.insertText("x", bridge.index.get("rich")!.contentStart! + 1))).toBe(false);
    expect(bridge.dispatch(bridge.state.tr.insertText("x", bridge.index.get("list")!.contentStart! + 1))).toBe(false);
    expect(bridge.dispatch(bridge.state.tr.split(start + 1))).toBe(false);
    expect(bridge.dispatch(bridge.state.tr.addMark(start, start + 1, bridge.projection.schema.marks.bold.create()))).toBe(false);
    const forged = bridge.state.tr.insertText("x", bridge.index.get("rich")!.contentStart! + 1)
      .setMeta("nmlBridge", { direction: "nml-to-pm", requestId: "forged" });
    expect(bridge.dispatch(forged)).toBe(false);
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    expect(report.mock.calls.filter(([entry]) => entry.code === "content_rejected")).toHaveLength(5);
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("rolls an unauthorized optimistic edit back to canonical content without leaking content in diagnostics", async () => {
    let decide!: (allowed: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => { decide = resolve; });
    const ydoc = createNmlYDoc(document());
    const diagnostic = vi.fn();
    const bridge = editable(ydoc, { authorize: () => authorization }, diagnostic);
    const events: BridgeUpdate[] = [];
    bridge.subscribe((event) => events.push(event));

    expect(replace(bridge, "p1", 5, 5, " SECRET")).toBe(true);
    expect(bridge.state.doc.textContent).toBe("hello SECRET");
    expect(blockText(decodeNmlDocument(ydoc).blocks[0])).toBe("hello");
    decide(false);
    await flush();

    expect(bridge.state.doc.textContent).toBe("hello");
    expect(events.map((event) => event.request?.status).filter(Boolean)).toEqual(["optimistic", "rejected"]);
    expect(diagnostic).toHaveBeenCalledWith({ code: "commit_rejected", nodeId: "p1" });
    expect(diagnostic).toHaveBeenCalledWith({ code: "content_rejected", nodeId: "p1" });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("SECRET");
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("preserves a remote edit that arrives while local authorization is pending", async () => {
    let approve!: () => void;
    const authorization = new Promise<boolean>((resolve) => { approve = () => resolve(true); });
    const ydoc = createNmlYDoc(document());
    const bridge = editable(ydoc, { authorize: () => authorization });
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(ydoc));

    expect(replace(bridge, "p1", 5, 5, " local")).toBe(true);
    await executeNmlCommands({
      doc: remote, documentId: "editing-test",
      commands: [{ type: "replaceInline", nodeId: "p1", range: { from: 0, to: 0 }, content: [{ type: "text", text: "remote ", marks: [] }] }],
      idempotencyKey: "remote", origin: { version: 1, transactionId: "remote", actor, command: "test" }, authorize: () => true,
    });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remote));
    expect(bridge.state.doc.textContent).toBe("remote hello");
    approve();
    await flush();

    expect(blockText(decodeNmlDocument(ydoc).blocks[0])).toBe("remote hello");
    expect(bridge.state.doc.textContent).toBe("remote hello");
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy(); remote.destroy();
  });

  it("maps a caret through remote text without a whole-document decode, projection, or index scan", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p1", "one"), paragraph("p2", "second")]));
    const bridge = editable(ydoc);
    const second = bridge.index.get("p2")!.contentStart!;
    bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, second + 3)));
    const before = bridge.performance();
    await executeNmlCommands({
      doc: ydoc, documentId: "editing-test",
      commands: [{ type: "replaceInline", nodeId: "p1", range: { from: 0, to: 0 }, content: [{ type: "text", text: "prefix ", marks: [] }] }],
      idempotencyKey: "remote-map", origin: { version: 1, transactionId: "remote-map", actor, command: "test" }, authorize: () => true,
    });
    const after = bridge.performance();

    expect(bridge.state.selection.from).toBe(second + 7 + 3);
    expect(after.fullObserverDecodes).toBe(before.fullObserverDecodes);
    expect(after.fullProjections).toBe(before.fullProjections);
    expect(after.yjsIndexScans).toBe(before.yjsIndexScans);
    expect(after.lastIndexNodesVisited).toBe(2);
    expect(after.incrementalTextTransactions).toBe(before.incrementalTextTransactions + 1);
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("keeps a caret anchored within the same block across a remote insertion", async () => {
    const ydoc = createNmlYDoc(document([quote("q", "Quote text")]));
    const bridge = editable(ydoc);
    const start = bridge.index.get("q")!.contentStart!;
    bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, start + 2)));
    await executeNmlCommands({
      doc: ydoc, documentId: "editing-test",
      commands: [{ type: "replaceInline", nodeId: "q", range: { from: 0, to: 0 }, content: [{ type: "text", text: "R", marks: [] }] }],
      idempotencyKey: "remote-same-block", origin: { version: 1, transactionId: "remote-same-block", actor, command: "test" }, authorize: () => true,
    });
    expect(bridge.state.selection.from - bridge.index.get("q")!.contentStart!).toBe(3);
    expect(bridge.state.doc.textContent).toBe("RQuote text");
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("edits one of 10,000 blocks without scanning the document or shifting the suffix eagerly", async () => {
    const ydoc = createNmlYDoc(document(Array.from({ length: 10_000 }, (_, index) => paragraph(`p${index}`, "x"))));
    const bridge = editable(ydoc);
    const before = bridge.performance();
    const suffixBefore = bridge.index.get("p9999")!.contentStart!;

    expect(replace(bridge, "p2", 1, 1, "expanded")).toBe(true);
    await flush();
    const after = bridge.performance();

    expect(text(bridge, "p2")).toBe("xexpanded");
    expect(bridge.index.get("p9999")!.contentStart).toBe(suffixBefore + 8);
    expect(after.fullObserverDecodes).toBe(before.fullObserverDecodes);
    expect(after.fullProjections).toBe(before.fullProjections);
    expect(after.yjsIndexScans).toBe(before.yjsIndexScans);
    expect(after.lastIndexNodesVisited).toBe(2);
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  }, 20_000);

  it("converges offline start, middle, and end edits in duplicate and reverse delivery order", async () => {
    const seed = createNmlYDoc(document([paragraph("p", "abcd")]));
    const baseline = Y.encodeStateAsUpdate(seed);
    const docs = Array.from({ length: 3 }, () => { const item = new Y.Doc(); Y.applyUpdate(item, baseline); return item; });
    const bridges = docs.map((item) => editable(item));
    expect(replace(bridges[0], "p", 0, 0, "A")).toBe(true);
    expect(replace(bridges[1], "p", 2, 2, "B")).toBe(true);
    expect(replace(bridges[2], "p", 4, 4, "C")).toBe(true);
    await flush();
    const updates = docs.map((item) => Y.encodeStateAsUpdate(item));
    for (const target of docs) {
      for (const update of [...updates].reverse()) Y.applyUpdate(target, update);
      for (const update of updates) Y.applyUpdate(target, update);
    }
    await flush();

    const serialized = docs.map((item) => JSON.stringify(decodeNmlDocument(item)));
    expect(new Set(serialized).size).toBe(1);
    expect(bridges.map((bridge) => bridge.state.doc.textContent)).toEqual(Array(3).fill(bridges[0].state.doc.textContent));
    expect(bridges.every((bridge) => bridge.checkDrift())).toBe(true);
    bridges.forEach((bridge) => bridge.destroy()); docs.forEach((item) => item.destroy()); seed.destroy();
  });

  it("merges concurrent first inserts into an empty block and remains editable with multiple Y.XmlText children", async () => {
    const seed = createNmlYDoc(document([paragraph("p", "")]));
    const baseline = Y.encodeStateAsUpdate(seed);
    const left = new Y.Doc(); const right = new Y.Doc();
    Y.applyUpdate(left, baseline); Y.applyUpdate(right, baseline);
    const leftBridge = editable(left); const rightBridge = editable(right);
    expect(replace(leftBridge, "p", 0, 0, "left")).toBe(true);
    expect(replace(rightBridge, "p", 0, 0, "right")).toBe(true);
    await flush();
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    await flush();
    expect(leftBridge.state.doc.textContent).toBe(rightBridge.state.doc.textContent);
    expect(replace(leftBridge, "p", 2, 2, "!")).toBe(true);
    await flush();
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    expect(rightBridge.state.doc.textContent).toBe(leftBridge.state.doc.textContent);
    expect(leftBridge.checkDrift()).toBe(true);
    expect(rightBridge.checkDrift()).toBe(true);
    leftBridge.destroy(); rightBridge.destroy(); left.destroy(); right.destroy(); seed.destroy();
  });

  it("rejects a UTF-16 edit that splits a grapheme and restores the caret and canonical emoji", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "A👩🏽‍💻B")]));
    const diagnostic = vi.fn();
    const bridge = editable(ydoc, {}, diagnostic);
    const start = bridge.index.get("p")!.contentStart!;
    expect(bridge.dispatch(bridge.state.tr.insertText("x", start + 2))).toBe(true);
    expect(bridge.state.doc.textContent).toContain("x");
    await flush();
    expect(bridge.state.doc.textContent).toBe("A👩🏽‍💻B");
    expect(blockText(decodeNmlDocument(ydoc).blocks[0])).toBe("A👩🏽‍💻B");
    expect(diagnostic).toHaveBeenCalledWith({ code: "commit_rejected", nodeId: "p" });
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("accepts replacement of one complete emoji grapheme with another", async () => {
    const original = "👩🏽‍💻";
    const ydoc = createNmlYDoc(document([paragraph("p", `A${original}B`)]));
    const bridge = editable(ydoc);
    expect(replace(bridge, "p", 1, 1 + original.length, "👨🏽‍💻")).toBe(true);
    await flush();
    expect(text(bridge, "p")).toBe("A👨🏽‍💻B");
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("validates indexed multi-command edits atomically", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "abc"), quote("q", "xyz")]));
    const command = {
      doc: ydoc, documentId: "editing-test", index: new NmlYjsIndex(ydoc, decodeNmlDocument(ydoc)),
      commands: [
        { type: "replaceInline" as const, nodeId: "p", range: { from: 1, to: 2 }, content: [{ type: "text" as const, text: "B", marks: [] }] },
        { type: "replaceInline" as const, nodeId: "q", range: { from: 1, to: 99 }, content: [] },
      ],
      idempotencyKey: "atomic", origin: { version: 1 as const, transactionId: "atomic", actor, command: "test" }, authorize: () => true,
    } satisfies ExecuteNmlCommandsOptions;
    await expect(executeNmlCommands(command)).rejects.toMatchObject({ code: "invalid_range" });
    expect(decodeNmlDocument(ydoc).blocks.map((block) => "content" in block ? block.content : null)).toEqual([
      [{ type: "text", text: "abc", marks: [] }], [{ type: "text", text: "xyz", marks: [] }],
    ]);
    ydoc.destroy();
  });

  it("retains document limits and idempotency on the indexed fast path", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "abc")]));
    const index = new NmlYjsIndex(ydoc, decodeNmlDocument(ydoc));
    const updates = vi.fn(); ydoc.on("update", updates);
    const options: ExecuteNmlCommandsOptions = {
      doc: ydoc, documentId: "editing-test", index,
      commands: [{ type: "replaceInline", nodeId: "p", range: { from: 1, to: 2 }, content: [{ type: "text", text: "B", marks: [] }] }],
      idempotencyKey: "same", origin: { version: 1, transactionId: "same", actor, command: "test" }, authorize: () => true,
    };
    const first = await executeNmlCommands(options);
    expect(await executeNmlCommands(options)).toEqual(first);
    expect(updates).toHaveBeenCalledTimes(1);
    await expect(executeNmlCommands({
      ...options,
      commands: [{ type: "replaceInline", nodeId: "p", range: { from: 0, to: 0 }, content: [{ type: "text", text: "different", marks: [] }] }],
    })).rejects.toMatchObject({ code: "idempotency_mismatch" });
    expect(blockText(decodeNmlDocument(ydoc).blocks[0])).toBe("aBc");
    ydoc.destroy();

    const full = createNmlYDoc(document([paragraph("p", "x".repeat(NML_LIMITS.maxInlineUtf16))]));
    const fullIndex = new NmlYjsIndex(full, decodeNmlDocument(full));
    const bytes = Y.encodeStateAsUpdate(full);
    await expect(executeNmlCommands({
      doc: full, documentId: "editing-test", index: fullIndex,
      commands: [{ type: "replaceInline", nodeId: "p", range: { from: 0, to: 0 }, content: [{ type: "text", text: "x", marks: [] }] }],
      idempotencyKey: "over-limit", origin: { version: 1, transactionId: "over-limit", actor, command: "test" }, authorize: () => true,
    })).rejects.toMatchObject({ code: "invalid_command" });
    expect(Y.encodeStateAsUpdate(full)).toEqual(bytes);
    full.destroy();
  }, 15_000);

  it("takes the validated full path for structural changes, refreshes both indexes, and resumes editing", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "one")]));
    const bridge = editable(ydoc);
    const before = bridge.performance();
    await executeNmlCommands({
      doc: ydoc, documentId: "editing-test",
      commands: [{ type: "insertNodes", parentId: null, nodes: [paragraph("new", "two")] }],
      idempotencyKey: "structure", origin: { version: 1, transactionId: "structure", actor, command: "test" }, authorize: () => true,
    });
    const afterStructure = bridge.performance();
    expect(afterStructure.fullObserverDecodes).toBe(before.fullObserverDecodes + 1);
    expect(afterStructure.fullProjections).toBe(before.fullProjections + 1);
    expect(afterStructure.yjsIndexScans).toBe(before.yjsIndexScans + 1);
    expect(bridge.index.get("new")).toBeDefined();
    expect(replace(bridge, "new", 3, 3, "!")).toBe(true);
    await flush();
    expect(text(bridge, "new")).toBe("two!");
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("fully validates a rich-to-plain transition before enabling its text fast path", async () => {
    const rich: NmlTextBlock = {
      ...paragraph("p", ""),
      content: [{ type: "text", text: "rich", marks: ["bold"] }],
    };
    const ydoc = createNmlYDoc(document([rich]));
    const bridge = editable(ydoc);
    const before = bridge.performance();
    await executeNmlCommands({
      doc: ydoc, documentId: "editing-test",
      commands: [{ type: "setInlineMarks", nodeId: "p", range: { from: 0, to: 4 }, marks: [] }],
      idempotencyKey: "remove-mark", origin: { version: 1, transactionId: "remove-mark", actor, command: "test" }, authorize: () => true,
    });
    const afterTransition = bridge.performance();
    expect(afterTransition.fullObserverDecodes).toBe(before.fullObserverDecodes + 1);
    expect(afterTransition.fullProjections).toBe(before.fullProjections + 1);
    expect(afterTransition.yjsIndexScans).toBe(before.yjsIndexScans + 1);
    expect(replace(bridge, "p", 4, 4, " text")).toBe(true);
    await flush();
    expect(text(bridge, "p")).toBe("rich text");
    expect(bridge.performance().fullObserverDecodes).toBe(afterTransition.fullObserverDecodes);
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("survives hundreds of deterministic edits while retaining exact AST, PM, and index parity", async () => {
    const ydoc = createNmlYDoc(document(Array.from({ length: 64 }, (_, index) => paragraph(`p${index}`, `value-${index}`))));
    const bridge = editable(ydoc);
    const model = Array.from({ length: 64 }, (_, index) => `value-${index}`);
    const before = bridge.performance();
    for (let edit = 0; edit < 512; edit++) {
      const index = (edit * 37) % model.length;
      const prior = model[index];
      const from = (edit * 17) % (prior.length + 1);
      const remove = Math.min(edit % 3, prior.length - from);
      const inserted = String.fromCharCode(97 + (edit % 26));
      expect(replace(bridge, `p${index}`, from, from + remove, inserted)).toBe(true);
      model[index] = prior.slice(0, from) + inserted + prior.slice(from + remove);
    }
    await flush();

    expect(Array.from({ length: 64 }, (_, index) => text(bridge, `p${index}`))).toEqual(model);
    expect(bridge.snapshot()).toEqual(decodeNmlDocument(ydoc));
    expect(bridge.performance().fullObserverDecodes).toBe(before.fullObserverDecodes);
    expect(bridge.performance().fullProjections).toBe(before.fullProjections);
    expect(bridge.performance().yjsIndexScans).toBe(before.yjsIndexScans);
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  }, 20_000);

  it("ignores a late async rejection after destruction", async () => {
    let reject!: (error: unknown) => void;
    const commit = vi.fn(() => new Promise<never>((_resolve, fail) => { reject = fail; }));
    const ydoc = createNmlYDoc(document());
    const diagnostic = vi.fn();
    const bridge = editable(ydoc, { commit }, diagnostic);
    expect(replace(bridge, "p1", 0, 0, "x")).toBe(true);
    bridge.destroy();
    reject(new NmlCommandConflict("unauthorized", "denied"));
    await flush();
    expect(diagnostic).not.toHaveBeenCalled();
    expect(bridge.status()).toBe("destroyed");
    ydoc.destroy();
  });
});
