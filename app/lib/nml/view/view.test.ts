import { describe, expect, it, vi } from "vitest";
import { TextSelection } from "prosemirror-state";
import { DOMSerializer } from "prosemirror-model";
import { parseHTML } from "linkedom";
import * as Y from "yjs";
import { createNmlYDoc, decodeNmlDocument, executeNmlCommands, type NmlBlock, type NmlDocument, type NmlCommand } from "..";
import { convertLegacyDocument, type LegacyDocumentInput } from "../legacy";
import { NmlProjection, NodeAdapterRegistry, BLOCK_TYPES, PositionIndex, ReadOnlyNmlBridge } from ".";
import richText from "../__fixtures__/legacy/rich-text.json";
import table from "../__fixtures__/legacy/table.json";
import codeMath from "../__fixtures__/legacy/code-math.json";
import media from "../__fixtures__/legacy/media.json";
import domains from "../__fixtures__/legacy/domains.json";
import canvas from "../__fixtures__/legacy/canvas-html.json";
import oldCanvas from "../__fixtures__/legacy/canvas-legacy-json.json";
import edges from "../__fixtures__/legacy/edge-cases.json";

const paragraph = (id: string, text = "hello"): NmlBlock => ({ id, type: "paragraph", props: {}, children: [], content: [{ type: "text", text, marks: [] }] });
const doc = (blocks: NmlBlock[] = [paragraph("p1"), paragraph("p2")]): NmlDocument => ({ schemaVersion: 1, documentId: "view-test", blocks });
const fixtures: LegacyDocumentInput[] = [richText, table, codeMath, media, domains, canvas, oldCanvas, edges];
const converted = (fixture: LegacyDocumentInput): NmlDocument => {
  let id = 0;
  const result = convertLegacyDocument(fixture, { createId: () => `generated-${id++}` });
  if (!result.document) throw new Error("Invalid fixture");
  return result.document;
};
let transactionId = 0;
const execute = async (ydoc: Y.Doc, commands: NmlCommand[]) => {
  const result = await executeNmlCommands({
    doc: ydoc, commands, documentId: decodeNmlDocument(ydoc).documentId, idempotencyKey: `key-${transactionId}`,
    origin: { version: 1, transactionId: `view-${++transactionId}`, actor: { userId: "test", kind: "human" }, command: "test" },
    authorize: () => true,
  });
  expect(result.status).toBe("applied");
};

describe("read-only NML view adapters", () => {
  it.each(fixtures)("round-trips the legacy corpus: $documentId", (fixture) => {
    const document = converted(fixture);
    const projection = new NmlProjection();
    const pm = projection.project(document);
    expect(projection.read(pm, document)).toEqual(document);
    expect(projection.project(document).eq(pm)).toBe(true);
    pm.check();
  });

  it("covers every block adapter, including empty domain/text/table values", () => {
    const covered = new Set<string>();
    for (const fixture of fixtures) {
      const document = converted(fixture);
      const visit = (block: NmlBlock) => { covered.add(block.type); block.children.forEach(visit); };
      document.blocks.forEach(visit);
    }
    expect([...covered].sort()).toEqual([...BLOCK_TYPES].sort());
    const document = doc([
      { ...paragraph("empty"), content: [] } as NmlBlock,
      { id: "table", type: "table", props: { headerRows: 0 }, rows: [], columns: [], children: [] },
      { id: "math", type: "mathBlock", props: {}, rows: [], children: [] },
      { id: "code", type: "codeBlock", props: { language: "" }, code: "", children: [] },
    ]);
    const projection = new NmlProjection();
    expect(projection.read(projection.project(document), document)).toEqual(document);
    expect(projection.project(doc([])).childCount).toBe(0);
  });

  it("preserves adjacent equal-URL links, marks, embeds, and astral text", () => {
    const document = doc([{ ...paragraph("p"), content: [
      { type: "text", text: "👩🏽‍💻é", marks: ["code", "bold", "italic", "strike", "underline"] },
      { type: "link", href: "https://example.org", content: [{ type: "text", text: "one", marks: ["bold"] }] },
      { type: "link", href: "https://example.org", content: [{ type: "text", text: "two", marks: [] }] },
      { type: "math", id: "im", latex: "a < b" },
      { type: "pageRef", id: "ref", pageId: "page", fallbackTitle: "Other page" },
    ] } as NmlBlock]);
    const projection = new NmlProjection();
    expect(projection.read(projection.project(document), document)).toEqual(document);
  });

  it("preserves omitted-adapter payloads and IDs as inert selectable atoms", () => {
    const registry = new NodeAdapterRegistry(new NodeAdapterRegistry().values().filter((adapter) => adapter.nmlType !== "toggleListItem"));
    const document = converted(richText);
    const projection = new NmlProjection(registry);
    const pm = projection.project(document);
    expect(projection.read(pm, document)).toEqual(document);
    let placeholders = 0;
    pm.descendants((node) => { if (node.type.name === "unsupported") { placeholders++; expect(node.isAtom).toBe(true); expect(node.attrs.payload.id).toBe(node.attrs.nmlId); } });
    expect(placeholders).toBeGreaterThan(0);
  });

  it("rejects duplicate adapters and unsafe or duplicate canonical input", () => {
    const adapter = new NodeAdapterRegistry().values()[0];
    expect(() => new NodeAdapterRegistry([adapter, adapter])).toThrow(/Duplicate/);
    const projection = new NmlProjection();
    expect(() => projection.project(doc([paragraph("same"), paragraph("same")]))).toThrow(/Invalid/);
    expect(() => projection.project(doc([{ ...paragraph("p"), content: [{ type: "link", href: "javascript:alert(1)", content: [{ type: "text", text: "bad", marks: [] }] }] } as NmlBlock]))).toThrow(/Invalid/);
  });

  it("renders semantic DOM without leaking payloads, columns, or view wrappers into AST", () => {
    const { document: dom } = parseHTML("<html><body></body></html>");
    for (const fixture of fixtures) {
      const document = converted(fixture);
      const projection = new NmlProjection();
      const pm = projection.project(document);
      const host = dom.createElement("div");
      host.appendChild(DOMSerializer.fromSchema(projection.schema).serializeFragment(pm.content, { document: dom as unknown as Document }));
      expect(host.querySelectorAll("[data-nml-id]").length).toBeGreaterThan(0);
      expect(host.innerHTML).not.toContain("legacyMarkup=");
      if (fixture === table) expect(host.querySelector("th")).not.toBeNull();
      if (fixture === richText) { expect(host.querySelector("strong")).not.toBeNull(); expect(host.querySelector("blockquote")).not.toBeNull(); }
      expect(projection.read(pm, document)).toEqual(document);
    }
  });

  it("updates reordered, removed, and edited nested children without stale cache entries", () => {
    const document = doc([{ id: "list", type: "bulletListItem", props: {}, content: [], children: [paragraph("a"), paragraph("b")] }]);
    const projection = new NmlProjection();
    projection.project(document);
    document.blocks[0].children.reverse();
    expect(projection.read(projection.project(document), document)).toEqual(document);
    document.blocks[0].children = [paragraph("b", "changed")];
    expect(projection.read(projection.project(document), document)).toEqual(document);
    document.blocks[0].children = [];
    expect(projection.read(projection.project(document), document)).toEqual(document);
  });
});

describe("incremental view and identity index", () => {
  it("reindexes only changed subtrees and shifts the suffix without traversing it", () => {
    const projection = new NmlProjection();
    const document = doc(Array.from({ length: 10_000 }, (_, i) => paragraph(`p${i}`)));
    const first = projection.project(document);
    const index = new PositionIndex();
    expect(index.update(first)).toBe(20_000);
    document.blocks[2] = paragraph("p2", "longer paragraph");
    const next = projection.project(document);
    expect(next.child(9000)).toBe(first.child(9000));
    expect(index.update(next)).toBe(2);
    const fresh = new PositionIndex();
    fresh.update(next);
    expect(index.byId).toEqual(fresh.byId);
    expect(index.nodeAt(index.get("p9000")!.contentStart!)?.nodeId).toBe("p9000");
    expect(index.nodeAt(-1)).toBeNull();
    expect(index.nodeAt(next.content.size)).toBeNull();
  });

  it("indexes nested blocks, inline embeds, table rows/cells and math rows", () => {
    for (const fixture of fixtures) {
      const document = converted(fixture);
      const projection = new NmlProjection();
      const pm = projection.project(document);
      const index = new PositionIndex();
      index.update(pm);
      pm.descendants((node, position) => {
        if (!node.attrs.nmlId) return;
        const entry = index.get(node.attrs.nmlId)!;
        expect(entry.pmStart).toBe(position);
        expect(entry.pmEnd).toBe(position + node.nodeSize);
        let at = pm;
        for (const child of entry.path) at = at.child(child);
        expect(at).toBe(node);
      });
    }
  });

  it("projects canonical text updates with mapped selection and no writes/echo", async () => {
    const ydoc = createNmlYDoc(doc());
    const report = vi.fn();
    const bridge = new ReadOnlyNmlBridge(ydoc, report);
    const update = vi.fn();
    bridge.subscribe(update);
    bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, bridge.index.get("p2")!.contentStart!)));
    const beforePosition = bridge.state.selection.from;
    const updates = vi.fn();
    ydoc.on("update", updates);
    await execute(ydoc, [{ type: "replaceInline", nodeId: "p1", range: { from: 0, to: 0 }, content: [{ type: "text", text: "prefix ", marks: [] }] }]);
    expect(bridge.state.doc.firstChild!.textContent).toBe("prefix hello");
    expect(bridge.state.selection.from).toBe(beforePosition + 7);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(update.mock.calls.at(-1)![0].transaction.getMeta("addToHistory")).toBe(false);
    expect(bridge.projection.read(bridge.state.doc, decodeNmlDocument(ydoc))).toEqual(decodeNmlDocument(ydoc));
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("rejects typing, paste-style replacements, and forged bridge metadata", () => {
    const ydoc = createNmlYDoc(doc());
    const bridge = new ReadOnlyNmlBridge(ydoc);
    const bytes = Y.encodeStateAsUpdate(ydoc);
    const tr = bridge.state.tr.insertText("bad", 1).setMeta("nmlBridge", { direction: "nml-to-pm" });
    expect(bridge.dispatch(tr)).toBe(false);
    expect(bridge.state.apply(tr).doc).toBe(bridge.state.doc);
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(bytes);
    bridge.destroy(); ydoc.destroy();
  });

  it("keeps canvas scene updates outside PM and notifies domain subscribers", async () => {
    const document = converted(canvas);
    const block = document.blocks.find((block) => block.type === "canvas")!;
    if (block.type !== "canvas") throw new Error("Expected canvas");
    const ydoc = createNmlYDoc(document);
    const bridge = new ReadOnlyNmlBridge(ydoc);
    const before = bridge.state.doc;
    const listener = vi.fn(); bridge.subscribe(listener);
    await execute(ydoc, [{ type: "updateShapes", canvasId: block.id, patches: [{ id: block.scene.nodes[0].id, patch: { x: 77 } }] }]);
    expect(bridge.state.doc).toBe(before);
    expect(listener.mock.calls.at(-1)![0].transaction).toBeNull();
    expect(listener.mock.calls.at(-1)![0].changedNodeIds).toContain(block.id);
    expect(JSON.stringify(bridge.state.doc.toJSON())).not.toContain('"scene"');
    expect(bridge.projection.read(bridge.state.doc, bridge.snapshot()!)).toEqual(decodeNmlDocument(ydoc));
    bridge.destroy(); ydoc.destroy();
  });

  it("retains the last safe view on malformed/newer canonical state", () => {
    const ydoc = createNmlYDoc(doc());
    const report = vi.fn();
    const bridge = new ReadOnlyNmlBridge(ydoc, report);
    const before = bridge.state.doc;
    ydoc.getMap("nml").set("schemaVersion", 999);
    expect(bridge.status()).toBe("frozen");
    expect(bridge.state.doc).toBe(before);
    expect(report).toHaveBeenCalledWith({ code: "invalid_source" });
    const bytes = Y.encodeStateAsUpdate(ydoc);
    const unsupported = new ReadOnlyNmlBridge(ydoc);
    expect(unsupported.status()).toBe("frozen");
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(bytes);
    unsupported.destroy(); bridge.destroy(); ydoc.destroy();
  });

  it("detects drift, rebuilds once, then freezes without changing canonical data", () => {
    const ydoc = createNmlYDoc(doc());
    const report = vi.fn();
    const bridge = new ReadOnlyNmlBridge(ydoc, report);
    const bytes = Y.encodeStateAsUpdate(ydoc);
    const suspect = bridge.state.tr.insertText("drift", 1).doc;
    expect(bridge.checkDrift(suspect)).toBe(false);
    expect(bridge.status()).toBe("ready");
    expect(bridge.checkDrift()).toBe(true);
    expect(bridge.checkDrift(suspect)).toBe(false);
    expect(bridge.status()).toBe("frozen");
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(bytes);
    expect(report.mock.calls.every(([event]) => !JSON.stringify(event).includes("hello"))).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("unsubscribes without destroying the caller's Y.Doc", async () => {
    const ydoc = createNmlYDoc(doc());
    const bridge = new ReadOnlyNmlBridge(ydoc);
    const listener = vi.fn(); bridge.subscribe(listener);
    const before = bridge.state;
    bridge.destroy();
    await execute(ydoc, [{ type: "replaceInline", nodeId: "p1", range: { from: 0, to: 0 }, content: [{ type: "text", text: "still alive", marks: [] }] }]);
    expect(listener).not.toHaveBeenCalled();
    expect(bridge.state).toBe(before);
    expect(bridge.status()).toBe("destroyed");
    ydoc.destroy();
  });

  it("keeps three browser projections convergent through offline edits and structural merges", async () => {
    const original = createNmlYDoc(doc());
    const replicas = Array.from({ length: 3 }, () => { const replica = new Y.Doc(); Y.applyUpdate(replica, Y.encodeStateAsUpdate(original)); return replica; });
    const bridges = replicas.map((replica) => new ReadOnlyNmlBridge(replica));
    await execute(replicas[0], [{ type: "replaceInline", nodeId: "p1", range: { from: 0, to: 0 }, content: [{ type: "text", text: "Alice ", marks: [] }] }]);
    await execute(replicas[1], [{ type: "replaceInline", nodeId: "p1", range: { from: 5, to: 5 }, content: [{ type: "text", text: " Bob", marks: [] }] }]);
    await execute(replicas[2], [{ type: "moveNodes", nodeIds: ["p2"], destination: { parentId: null, anchor: { beforeId: "p1" } } }]);
    const updates = replicas.map((replica) => Y.encodeStateAsUpdate(replica));
    for (let i = 0; i < replicas.length; i++) for (const update of [...updates].reverse()) { Y.applyUpdate(replicas[i], update); Y.applyUpdate(replicas[i], update); }
    for (const bridge of bridges) {
      expect(bridge.status()).toBe("ready");
      expect(bridge.checkDrift()).toBe(true);
      expect(bridge.state.doc.toJSON()).toEqual(bridges[0].state.doc.toJSON());
      expect(bridge.state.doc.textContent).toContain("Alice hello Bob");
      bridge.destroy();
    }
    replicas.forEach((replica) => replica.destroy()); original.destroy();
  });

  it("sustains generated insert/move/remove/text batches and indexes after every projection", async () => {
    const ydoc = createNmlYDoc(doc());
    const bridge = new ReadOnlyNmlBridge(ydoc);
    let seed = 0x12345678;
    const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
    for (let step = 0; step < 160; step++) {
      const current = decodeNmlDocument(ydoc);
      const selected = current.blocks[Math.floor(random() * current.blocks.length)];
      const choice = Math.floor(random() * 4);
      let commands: NmlCommand[];
      if (!selected || choice === 0) commands = [{ type: "insertNodes", parentId: null, nodes: [paragraph(`new-${step}`)] }];
      else if (choice === 1) commands = [{ type: "removeNodes", nodeIds: [selected.id] }];
      else if (choice === 2) commands = [{ type: "moveNodes", nodeIds: [selected.id], destination: { parentId: null } }];
      else commands = [{ type: "replaceInline", nodeId: selected.id, range: { from: 0, to: 0 }, content: [{ type: "text", text: `${step} `, marks: [] }] }];
      await execute(ydoc, commands);
      expect(bridge.status(), `step ${step}`).toBe("ready");
      expect(bridge.projection.read(bridge.state.doc, decodeNmlDocument(ydoc))).toEqual(decodeNmlDocument(ydoc));
      const fresh = new PositionIndex(); fresh.update(bridge.state.doc);
      expect(bridge.index.byId).toEqual(fresh.byId);
    }
    bridge.destroy(); ydoc.destroy();
  });

  it("updates table cells, math/code and custom domains through canonical commands", async () => {
    for (const fixture of [table, codeMath, domains]) {
      const document = converted(fixture);
      const ydoc = createNmlYDoc(document);
      const bridge = new ReadOnlyNmlBridge(ydoc);
      for (const block of document.blocks) {
        if (block.type === "codeBlock") await execute(ydoc, [{ type: "setCode", nodeId: block.id, range: { from: 0, to: 0 }, text: "// changed\n" }]);
        if (block.type === "mathBlock" && block.rows.length) await execute(ydoc, [{ type: "setMathRow", nodeId: block.id, rowId: block.rows[0].id, latex: "x^2" }]);
        if (block.type === "table" && block.rows.length) await execute(ydoc, [{ type: "replaceTableRange", tableId: block.id, rowIds: [block.rows[0].id], columnIds: [block.columns[0].id], cells: [[{ id: block.rows[0].cells[0].id, content: [{ type: "text", text: "Changed cell", marks: ["bold"] }] }]] }]);
        if (block.type === "location") await execute(ydoc, [{ type: "replaceDomain", nodeId: block.id, domain: { ...block.domain, name: "Changed location" } }]);
      }
      expect(bridge.status()).toBe("ready");
      expect(bridge.projection.read(bridge.state.doc, decodeNmlDocument(ydoc))).toEqual(decodeNmlDocument(ydoc));
      expect(bridge.checkDrift()).toBe(true);
      bridge.destroy(); ydoc.destroy();
    }
  });

  it("renumbers list presentation without introducing canonical properties", () => {
    const document = doc([3, undefined, undefined].map((start, i) => ({ id: `li-${i}`, type: "numberedListItem", props: start ? { start } : {}, children: [], content: [] })));
    const projection = new NmlProjection();
    const first = projection.project(document);
    expect([first.child(0).attrs.viewOrdinal, first.child(1).attrs.viewOrdinal, first.child(2).attrs.viewOrdinal]).toEqual([3, 4, 5]);
    document.blocks.reverse();
    const reversed = projection.project(document);
    expect([reversed.child(0).attrs.viewOrdinal, reversed.child(1).attrs.viewOrdinal, reversed.child(2).attrs.viewOrdinal]).toEqual([1, 2, 3]);
    expect(projection.read(reversed, document)).toEqual(document);
  });
});
