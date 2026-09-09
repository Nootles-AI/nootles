import { AllSelection, NodeSelection, TextSelection } from "prosemirror-state";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createNmlYDoc,
  decodeNmlDocument,
  executeNmlCommands,
  type NmlBlock,
  type NmlDocument,
} from "..";
import { convertLegacyDocument } from "../legacy";
import domains from "../__fixtures__/legacy/domains.json";
import {
  PlainTextNmlBridge,
  ReadOnlyNmlBridge,
  parseAwarenessSelection,
  type NmlSelection,
} from ".";

const actor = { userId: "selection-test", kind: "human" } as const;
const paragraph = (id: string, text: string): NmlBlock => ({
  id, type: "paragraph", props: {}, children: [],
  content: text ? [{ type: "text", text, marks: [] }] : [],
});
const document = (blocks: NmlBlock[]): NmlDocument => ({ schemaVersion: 1, documentId: "selection-test", blocks });
const editable = (doc: Y.Doc, awareness?: Awareness) => new PlainTextNmlBridge(doc, {
  actor,
  authorize: () => true,
  awareness,
});
let sequence = 0;
const command = (doc: Y.Doc, commands: Parameters<typeof executeNmlCommands>[0]["commands"]) => executeNmlCommands({
  doc,
  documentId: "selection-test",
  commands,
  idempotencyKey: `selection-${++sequence}`,
  origin: { version: 1, transactionId: `selection-${sequence}`, actor, command: "selection-test" },
  authorize: () => true,
});

describe("durable NML selections", () => {
  it("round-trips directional text selections through Yjs-relative positions", () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "abcdef")]));
    const bridge = editable(ydoc);
    const start = bridge.index.get("p")!.contentStart!;
    const pm = TextSelection.create(bridge.state.doc, start + 5, start + 2);
    const durable = bridge.toNmlSelection(pm)!;

    expect(durable.anchor).toMatchObject({ kind: "text", nodeId: "p", affinity: "before" });
    expect(durable.head).toMatchObject({ kind: "text", nodeId: "p", affinity: "after" });
    expect(durable.anchor.kind === "text" && durable.anchor.relative).toBeInstanceOf(Uint8Array);
    expect(bridge.toPmSelection(durable).eq(pm)).toBe(true);
    bridge.destroy();
    ydoc.destroy();
  });

  it("keeps a caret attached to canonical text across remote inserts at its boundary", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "abcd")]));
    const bridge = editable(ydoc);
    const start = bridge.index.get("p")!.contentStart!;
    bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, start + 2)));
    const before = bridge.nmlSelection()!;

    await command(ydoc, [{
      type: "replaceInline", nodeId: "p", range: { from: 2, to: 2 },
      content: [{ type: "text", text: "REMOTE", marks: [] }],
    }]);

    expect(bridge.state.selection.from - bridge.index.get("p")!.contentStart!).toBe(8);
    expect(bridge.toPmSelection(before).from).toBe(bridge.state.selection.from);
    expect(decodeNmlDocument(ydoc).blocks[0]).toMatchObject({ content: [{ text: "abREMOTEcd" }] });
    bridge.destroy();
    ydoc.destroy();
  });

  it("round-trips every offset when concurrent first inserts create multiple Y.XmlText runs", async () => {
    const seed = createNmlYDoc(document([paragraph("p", "")]));
    const update = Y.encodeStateAsUpdate(seed);
    const left = new Y.Doc(); const right = new Y.Doc(); const merged = new Y.Doc();
    Y.applyUpdate(left, update); Y.applyUpdate(right, update); Y.applyUpdate(merged, update);
    const leftBridge = editable(left); const rightBridge = editable(right);
    expect(leftBridge.dispatch(leftBridge.state.tr.insertText("A", leftBridge.index.get("p")!.contentStart!))).toBe(true);
    expect(rightBridge.dispatch(rightBridge.state.tr.insertText("B", rightBridge.index.get("p")!.contentStart!))).toBe(true);
    await Promise.resolve();
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(left));
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(right));
    const bridge = editable(merged);
    const start = bridge.index.get("p")!.contentStart!;

    expect(bridge.state.doc.textContent).toHaveLength(2);
    for (let offset = 0; offset <= 2; offset++) {
      const pm = TextSelection.create(bridge.state.doc, start + offset);
      expect(bridge.toPmSelection(bridge.toNmlSelection(pm)!).eq(pm)).toBe(true);
    }
    bridge.destroy();
    leftBridge.destroy(); rightBridge.destroy();
    left.destroy(); right.destroy(); merged.destroy(); seed.destroy();
  });

  it("moves a deleted text selection to the nearest surviving editable neighbor", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p1", "one"), paragraph("p2", "two"), paragraph("p3", "three")]));
    const bridge = editable(ydoc);
    const second = bridge.index.get("p2")!.contentStart!;
    bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, second + 1)));

    await command(ydoc, [{ type: "removeNodes", nodeIds: ["p2"] }]);
    expect(bridge.state.selection.from).toBe(bridge.index.get("p3")!.contentStart);
    expect(bridge.nmlSelection()?.anchor).toMatchObject({ kind: "text", nodeId: "p3" });

    await command(ydoc, [{ type: "removeNodes", nodeIds: ["p3"] }]);
    expect(bridge.state.selection.from).toBe(bridge.index.get("p1")!.pmEnd - 1);
    expect(bridge.nmlSelection()?.anchor).toMatchObject({ kind: "text", nodeId: "p1" });
    bridge.destroy();
    ydoc.destroy();
  });

  it("moves a deleted atomic node selection to the next surviving atom", async () => {
    const ydoc = createNmlYDoc(document([
      { id: "first", type: "divider", props: {}, children: [] },
      { id: "second", type: "divider", props: {}, children: [] },
    ]));
    const bridge = editable(ydoc);
    bridge.dispatch(bridge.state.tr.setSelection(NodeSelection.create(bridge.state.doc, bridge.index.get("first")!.pmStart)));

    await command(ydoc, [{ type: "removeNodes", nodeIds: ["first"] }]);
    expect(bridge.state.selection).toBeInstanceOf(NodeSelection);
    expect(bridge.nmlSelection()).toEqual({
      anchor: { kind: "node", nodeId: "second", side: "on" },
      head: { kind: "node", nodeId: "second", side: "on" },
    });
    bridge.destroy();
    ydoc.destroy();
  });

  it("maps node, document, table-cell, gap, and custom-domain boundaries without PM positions", () => {
    let id = 0;
    const converted = convertLegacyDocument(domains, { createId: () => `domain-${id++}` });
    if (!converted.document) throw new Error("Invalid domain fixture");
    const table: NmlBlock = {
      id: "table", type: "table", props: { headerRows: 0 }, children: [], columns: [{ id: "column" }],
      rows: [{ id: "row", cells: [{ id: "cell", content: [{ type: "text", text: "value", marks: [] }] }] }],
    };
    const ydoc = createNmlYDoc(document([paragraph("before", "before"), table, ...converted.document.blocks]));
    const bridge = new ReadOnlyNmlBridge(ydoc);

    for (const nodeId of ["cell", converted.document.blocks[0].id]) {
      const entry = bridge.index.get(nodeId)!;
      const selected = NodeSelection.create(bridge.state.doc, entry.pmStart);
      const durable = bridge.toNmlSelection(selected)!;
      expect(durable).toEqual({
        anchor: { kind: "node", nodeId, side: "on" },
        head: { kind: "node", nodeId, side: "on" },
      });
      expect(bridge.toPmSelection(durable)).toBeInstanceOf(NodeSelection);
    }

    const all = bridge.toNmlSelection(new AllSelection(bridge.state.doc))!;
    expect(all.anchor).toMatchObject({ kind: "node", side: "before" });
    expect(all.head).toMatchObject({ kind: "node", side: "after" });
    expect(bridge.toPmSelection(all)).toBeInstanceOf(AllSelection);
    const gap: NmlSelection = {
      anchor: { kind: "node", nodeId: "table", side: "before" },
      head: { kind: "node", nodeId: "table", side: "before" },
    };
    expect(bridge.toPmSelection(gap).from).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(all)).not.toMatch(/pm(Start|End)|"(anchor|head)":\d/);
    bridge.destroy();
    ydoc.destroy();
  });
});

describe("NML awareness selections", () => {
  it("broadcasts a JSON-safe NML selection and resolves it through remote text", async () => {
    const seed = createNmlYDoc(document([paragraph("p", "shared text")]));
    const update = Y.encodeStateAsUpdate(seed);
    const left = new Y.Doc(); const right = new Y.Doc();
    Y.applyUpdate(left, update); Y.applyUpdate(right, update);
    const leftAwareness = new Awareness(left); const rightAwareness = new Awareness(right);
    leftAwareness.setLocalStateField("user", { name: "Left", color: "#123456" });
    const leftBridge = editable(left, leftAwareness); const rightBridge = editable(right, rightAwareness);
    const start = leftBridge.index.get("p")!.contentStart!;
    leftBridge.dispatch(leftBridge.state.tr.setSelection(TextSelection.create(leftBridge.state.doc, start + 6)));

    const wire = leftAwareness.getLocalState()?.nmlSelection;
    expect(parseAwarenessSelection(wire)).toEqual(leftBridge.nmlSelection());
    expect(leftAwareness.getLocalState()?.user).toEqual({ name: "Left", color: "#123456" });
    expect(JSON.stringify(wire)).not.toMatch(/pm(Start|End)|"(anchor|head)":\d/);
    applyAwarenessUpdate(rightAwareness, encodeAwarenessUpdate(leftAwareness, [left.clientID]), "test");
    const remoteSelection = rightBridge.remoteSelections().get(left.clientID);
    expect(remoteSelection).toBeDefined();
    expect(remoteSelection!.from - rightBridge.index.get("p")!.contentStart!).toBe(6);

    await command(right, [{
      type: "replaceInline", nodeId: "p", range: { from: 6, to: 6 },
      content: [{ type: "text", text: "REMOTE", marks: [] }],
    }]);
    expect(rightBridge.remoteSelections().get(left.clientID)!.from - rightBridge.index.get("p")!.contentStart!).toBe(12);

    rightAwareness.getStates().set(999, { nmlSelection: { version: 1, anchor: { kind: "text", nodeId: "p", relative: [999], affinity: "after" }, head: null } });
    expect(() => rightBridge.remoteSelections()).not.toThrow();
    expect(rightBridge.remoteSelections().has(999)).toBe(false);
    leftBridge.destroy();
    expect(leftAwareness.getLocalState()?.nmlSelection).toBeNull();
    rightBridge.destroy(); leftAwareness.destroy(); rightAwareness.destroy(); left.destroy(); right.destroy(); seed.destroy();
  });
});
