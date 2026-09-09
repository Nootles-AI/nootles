import { TextSelection } from "prosemirror-state";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  createNmlYDoc,
  decodeNmlDocument,
  executeNmlCommands,
  type NmlBlock,
  type NmlCommand,
  type NmlDocument,
} from "..";
import { PlainTextNmlBridge, type BridgeUpdate } from ".";

const actor = { userId: "composition-test", kind: "human" } as const;
const paragraph = (id: string, text: string, marked = false): NmlBlock => ({
  id, type: "paragraph", props: {}, children: [],
  content: text ? [{ type: "text", text, marks: marked ? ["bold"] : [] }] : [],
});
const document = (blocks: NmlBlock[]): NmlDocument => ({ schemaVersion: 1, documentId: "composition-test", blocks });
const editable = (doc: Y.Doc, diagnostic = vi.fn()) => new PlainTextNmlBridge(doc, {
  actor,
  authorize: () => true,
  createRequestId: (() => { let id = 0; return () => `composition-request-${++id}`; })(),
}, diagnostic);
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
const text = (doc: Y.Doc, nodeId: string) => {
  const block = decodeNmlDocument(doc).blocks.find((item) => item.id === nodeId);
  return block && "content" in block ? block.content.map((item) => item.type === "text" ? item.text : "").join("") : undefined;
};
let sequence = 0;
const remote = (doc: Y.Doc, commands: NmlCommand[]) => executeNmlCommands({
  doc,
  documentId: "composition-test",
  commands,
  idempotencyKey: `composition-remote-${++sequence}`,
  origin: { version: 1, transactionId: `composition-remote-${sequence}`, actor: { ...actor, userId: "remote" }, command: "remote-test" },
  authorize: () => true,
});
const select = (bridge: PlainTextNmlBridge, nodeId: string, from: number, to = from) => {
  const start = bridge.index.get(nodeId)!.contentStart!;
  bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, start + from, start + to)));
  return start;
};

describe("NML composition and IME", () => {
  it.each([
    ["CJK", "日本語"],
    ["Korean", "한글"],
    ["Indic", "नमस्ते"],
    ["dead key", "é"],
    ["emoji", "👩🏽‍💻"],
    ["autocorrect", "can’t"],
  ])("commits %s input as one canonical request", async (_name, composed) => {
    const ydoc = createNmlYDoc(document([paragraph("p", "prefix ")]));
    const bridge = editable(ydoc);
    const events: BridgeUpdate[] = [];
    bridge.subscribe((event) => events.push(event));
    const updates = vi.fn();
    ydoc.on("update", updates);
    const start = select(bridge, "p", 7);

    expect(bridge.beginComposition()).toBe(true);
    expect(bridge.dispatch(bridge.state.tr.insertText(composed, start + 7))).toBe(true);
    expect(text(ydoc, "p")).toBe("prefix ");
    expect(updates).not.toHaveBeenCalled();
    expect(bridge.endComposition()).toBe(true);
    await flush();

    expect(text(ydoc, "p")).toBe(`prefix ${composed}`);
    expect(bridge.state.doc.textContent).toBe(`prefix ${composed}`);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.request?.status).filter(Boolean)).toEqual(["optimistic", "acknowledged"]);
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy();
    ydoc.destroy();
  });

  it("accepts multiple provisional IME replacements before one acknowledgement", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "word ")]));
    const bridge = editable(ydoc);
    const start = select(bridge, "p", 5);
    const updates = vi.fn(); ydoc.on("update", updates);

    expect(bridge.beginComposition()).toBe(true);
    expect(bridge.dispatch(bridge.state.tr.insertText("n", start + 5))).toBe(true);
    expect(bridge.dispatch(bridge.state.tr.insertText("に", start + 5, start + 6))).toBe(true);
    expect(bridge.dispatch(bridge.state.tr.insertText("日本", start + 5, start + 6))).toBe(true);
    expect(text(ydoc, "p")).toBe("word ");
    expect(bridge.endComposition()).toBe(true);
    await flush();

    expect(text(ydoc, "p")).toBe("word 日本");
    expect(updates).toHaveBeenCalledTimes(1);
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("applies non-intersecting remote edits while preserving the provisional composition", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "abcd"), paragraph("other", "second")]));
    const bridge = editable(ydoc);
    const start = select(bridge, "p", 2);
    bridge.beginComposition();
    bridge.dispatch(bridge.state.tr.insertText("漢", start + 2));

    await remote(ydoc, [
      { type: "replaceInline", nodeId: "p", range: { from: 0, to: 0 }, content: [{ type: "text", text: "L", marks: [] }] },
      { type: "replaceInline", nodeId: "other", range: { from: 6, to: 6 }, content: [{ type: "text", text: "!", marks: [] }] },
    ]);
    expect(bridge.state.doc.textContent).toContain("Lab漢cd");
    expect(bridge.state.doc.textContent).toContain("second!");
    expect(text(ydoc, "p")).toBe("Labcd");

    bridge.endComposition();
    await flush();
    expect(text(ydoc, "p")).toBe("Lab漢cd");
    expect(text(ydoc, "other")).toBe("second!");
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("buffers an intersecting remote insertion until composition ends and retains both edits", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "abcd")]));
    const bridge = editable(ydoc);
    const start = select(bridge, "p", 2);
    bridge.beginComposition();
    bridge.dispatch(bridge.state.tr.insertText("漢", start + 2));

    await remote(ydoc, [{
      type: "replaceInline", nodeId: "p", range: { from: 2, to: 2 },
      content: [{ type: "text", text: "R", marks: [] }],
    }]);
    expect(text(ydoc, "p")).toBe("abRcd");
    expect(bridge.state.doc.textContent).toBe("ab漢cd");

    bridge.endComposition();
    await flush();
    expect(text(ydoc, "p")).toBe("abR漢cd");
    expect(bridge.state.doc.textContent).toBe("abR漢cd");
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("buffers a grapheme replacement that shares a collapsed composition boundary", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "😀rest")]));
    const bridge = editable(ydoc);
    const start = select(bridge, "p", 0);
    bridge.beginComposition();
    bridge.dispatch(bridge.state.tr.insertText("漢", start));

    await remote(ydoc, [{
      type: "replaceInline", nodeId: "p", range: { from: 0, to: 2 },
      content: [{ type: "text", text: "😃", marks: [] }],
    }]);
    expect(text(ydoc, "p")).toBe("😃rest");
    expect(bridge.state.doc.textContent).toBe("漢😀rest");

    bridge.endComposition();
    await flush();
    expect(text(ydoc, "p")).toBe("漢😃rest");
    expect(bridge.state.doc.textContent).toBe("漢😃rest");
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("applies unrelated structural changes after the active composition node without dropping its DOM text", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "compose")]));
    const bridge = editable(ydoc);
    const start = select(bridge, "p", 7);
    bridge.beginComposition();
    bridge.dispatch(bridge.state.tr.insertText("中", start + 7));

    await remote(ydoc, [{ type: "insertNodes", parentId: null, nodes: [paragraph("remote", "new block")] }]);
    expect(bridge.index.get("remote")).toBeDefined();
    expect(bridge.state.doc.textContent).toContain("compose中");
    bridge.endComposition();
    await flush();

    expect(text(ydoc, "p")).toBe("compose中");
    expect(text(ydoc, "remote")).toBe("new block");
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("maps the active composition through an unrelated block inserted before it", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "compose")]));
    const bridge = editable(ydoc);
    const start = select(bridge, "p", 7);
    bridge.beginComposition();
    bridge.dispatch(bridge.state.tr.insertText("中", start + 7));

    await remote(ydoc, [{
      type: "insertNodes", parentId: null, nodes: [paragraph("remote", "before")],
      anchor: { beforeId: "p" },
    }]);
    expect(decodeNmlDocument(ydoc).blocks.map((block) => block.id)).toEqual(["remote", "p"]);
    expect(bridge.state.doc.firstChild?.attrs.nmlId).toBe("remote");
    expect(bridge.state.doc.textContent).toContain("compose中");
    expect(bridge.state.selection.from - bridge.index.get("p")!.contentStart!).toBe(8);
    bridge.endComposition();
    await flush();

    expect(decodeNmlDocument(ydoc).blocks.map((block) => block.id)).toEqual(["remote", "p"]);
    expect(text(ydoc, "p")).toBe("compose中");
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("reconciles a remotely moved composition target before committing its text", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "compose"), paragraph("other", "other")]));
    const bridge = editable(ydoc);
    const start = select(bridge, "p", 7);
    bridge.beginComposition();
    bridge.dispatch(bridge.state.tr.insertText("中", start + 7));

    await remote(ydoc, [{
      type: "moveNodes", nodeIds: ["p"],
      destination: { parentId: null, anchor: { afterId: "other" } },
    }]);
    expect(bridge.state.doc.firstChild?.attrs.nmlId).toBe("p");
    expect(bridge.state.doc.textContent).toContain("compose中");
    expect(bridge.endComposition()).toBe(true);
    await flush();

    expect(decodeNmlDocument(ydoc).blocks.map((block) => block.id)).toEqual(["other", "p"]);
    expect(text(ydoc, "p")).toBe("compose中");
    expect(bridge.state.doc.lastChild?.attrs.nmlId).toBe("p");
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("retains unfinished text and moves selection when the composed node is deleted", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "hello"), paragraph("next", "survivor")]));
    const diagnostic = vi.fn();
    const bridge = editable(ydoc, diagnostic);
    const start = select(bridge, "p", 5);
    bridge.beginComposition();
    bridge.dispatch(bridge.state.tr.insertText("秘密", start + 5));

    await remote(ydoc, [{ type: "removeNodes", nodeIds: ["p"] }]);
    expect(bridge.compositionRecovery()).toEqual({ nodeId: "p", text: "秘密" });
    expect(bridge.state.selection.from).toBe(bridge.index.get("next")!.contentStart);
    expect(bridge.endComposition()).toBe(false);
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain("秘密");
    expect(diagnostic).toHaveBeenCalledWith({ code: "composition_recovered", nodeId: "p" });
    expect(decodeNmlDocument(ydoc).blocks.map((block) => block.id)).toEqual(["next"]);
    bridge.clearCompositionRecovery();
    expect(bridge.compositionRecovery()).toBeNull();
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("rejects composition on rich text without mutating canonical state", () => {
    const ydoc = createNmlYDoc(document([paragraph("rich", "marked", true)]));
    const diagnostic = vi.fn();
    const bridge = editable(ydoc, diagnostic);
    const start = bridge.index.get("rich")!.contentStart!;
    bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, start + 2)));
    const before = Y.encodeStateAsUpdate(ydoc);

    expect(bridge.beginComposition()).toBe(false);
    expect(Y.encodeStateAsUpdate(ydoc)).toEqual(before);
    expect(diagnostic).toHaveBeenCalledWith({ code: "composition_rejected" });
    bridge.destroy(); ydoc.destroy();
  });
});
