import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import {
  createNmlYDoc,
  decodeNmlDocument,
  NML_YJS_ROOT,
  NmlYjsDecodeError,
  normalizeDocument,
  observeNmlChanges,
  writeNmlDocument,
  type NmlDocument,
  type NmlTransactionOrigin,
} from ".";

const document: NmlDocument = {
  schemaVersion: 1,
  documentId: "doc-yjs",
  blocks: [
    {
      id: "p1",
      type: "paragraph",
      props: {},
      content: [
        { type: "text", text: "Plain", marks: ["bold", "italic"] },
        { type: "link", href: "https://nootles.ai", content: [{ type: "text", text: "link", marks: ["underline"] }] },
        { type: "math", id: "inline-math", latex: "x^2" },
        { type: "pageRef", id: "ref1", pageId: "page2", fallbackTitle: "Other" },
      ],
      children: [],
    },
    {
      id: "list1",
      type: "toggleListItem",
      props: { checked: true },
      content: [{ type: "text", text: "Parent", marks: [] }],
      children: [{ id: "child1", type: "paragraph", props: {}, content: [{ type: "text", text: "Child", marks: [] }], children: [] }],
    },
    {
      id: "table1",
      type: "table",
      props: { headerRows: 1 },
      columns: [{ id: "col1" }],
      rows: [{ id: "row1", cells: [{ id: "cell1", content: [{ type: "text", text: "Cell", marks: ["code"] }] }] }],
      children: [],
    },
    { id: "code1", type: "codeBlock", props: { language: "ts" }, code: "const x = 1;\n", children: [] },
    { id: "math1", type: "mathBlock", props: {}, rows: [{ id: "math-row1", latex: "a+b" }], children: [] },
    {
      id: "canvas1",
      type: "canvas",
      props: {},
      scene: {
        id: "canvas1",
        w: 640,
        h: 360,
        style: { background: "white" },
        attrs: { title: "Board" },
        nodes: [
          {
            id: "group1", kind: "group", x: 0, y: 0, w: 300, h: 200, rot: 0,
            style: {}, label: "", locked: false, hidden: false, attrs: {},
            children: [
              { id: "shape1", kind: "ellipse", x: 10, y: 20, w: 80, h: 60, rot: 5, style: { color: "red" }, label: "Hello", locked: false, hidden: false, attrs: {}, start: 0, sweep: 180, inner: 0.2 },
              { id: "shape2", kind: "image", x: 110, y: 20, w: 80, h: 60, rot: 0, style: {}, label: "", locked: true, hidden: false, attrs: {}, src: "/image.png" },
            ],
          },
        ],
        edges: [{ id: "edge1", from: "shape1", to: "shape2", label: "connects", style: { stroke: "black" }, attrs: {} }],
      },
      children: [],
    },
    { id: "album1", type: "album", props: {}, domain: { id: "album1", items: [{ kind: "image", src: "/one.jpg", w: 2, h: 1 }] }, legacyMarkup: "<old />", children: [] },
    { id: "story1", type: "storyboard", props: {}, domain: { id: "story1", ratio: "16:9", shots: [{ scene: "", note: "Shot" }] }, children: [] },
    { id: "location1", type: "location", props: {}, domain: { id: "location1", name: "Here", images: [], off: [] }, children: [] },
    { id: "heading1", type: "heading", props: { level: 3 }, content: [{ type: "text", text: "Heading", marks: [] }], children: [] },
    { id: "quote1", type: "quote", props: {}, content: [{ type: "text", text: "Quote", marks: [] }], children: [] },
    { id: "bullet1", type: "bulletListItem", props: {}, content: [{ type: "text", text: "Bullet", marks: [] }], children: [] },
    { id: "number1", type: "numberedListItem", props: { start: 2 }, content: [{ type: "text", text: "Number", marks: [] }], children: [] },
    { id: "check1", type: "checkListItem", props: { checked: false }, content: [{ type: "text", text: "Check", marks: [] }], children: [] },
    { id: "divider1", type: "divider", props: {}, children: [] },
    { id: "image1", type: "image", props: { source: { kind: "url", url: "/image.png" }, caption: "Image" }, children: [] },
    { id: "video1", type: "video", props: { source: { kind: "storage", storageId: "storage1" } }, children: [] },
    { id: "audio1", type: "audio", props: {}, children: [] },
    { id: "file1", type: "file", props: { name: "notes.txt" }, children: [] },
  ],
};

const blockMap = (doc: Y.Doc, index: number) =>
  ((doc.getMap(NML_YJS_ROOT).get("blocks") as Y.Array<Y.Map<unknown>>).get(index));

const origin: NmlTransactionOrigin = {
  version: 1,
  transactionId: "tx-1",
  actor: { userId: "user-1", kind: "human", clientId: "browser-1" },
  command: "test-edit",
  requestId: "request-1",
};

describe("canonical NML Yjs encoding", () => {
  it("round-trips every shared representation without semantic loss", () => {
    const doc = createNmlYDoc(document, origin);
    expect(decodeNmlDocument(doc)).toEqual(normalizeDocument(document));

    const blocks = doc.getMap(NML_YJS_ROOT).get("blocks") as Y.Array<Y.Map<unknown>>;
    expect(blocks.get(0).get("content")).toBeInstanceOf(Y.XmlFragment);
    expect(blocks.get(3).get("code")).toBeInstanceOf(Y.Text);
    expect((blocks.get(4).get("rows") as Y.Array<Y.Map<unknown>>).get(0).get("latex")).toBeInstanceOf(Y.Text);
    const scene = blocks.get(5).get("scene") as Y.Map<unknown>;
    expect(scene.get("shapes")).toBeInstanceOf(Y.Map);
    expect(((scene.get("shapes") as Y.Map<Y.Map<unknown>>).get("shape1")?.get("label"))).toBeInstanceOf(Y.Text);
    expect(blocks.get(6).get("domain")).toBeInstanceOf(Y.Map);
  });

  it("decodes the same AST after update chunking and in an independent runtime document", () => {
    const source = createNmlYDoc(document);
    const update = Y.encodeStateAsUpdate(source);
    const chunks = Array.from({ length: Math.ceil(update.byteLength / 97) }, (_, index) => update.slice(index * 97, (index + 1) * 97));
    const joined = new Uint8Array(update.byteLength);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    const target = new Y.Doc();
    Y.applyUpdate(target, joined);
    expect(decodeNmlDocument(target)).toEqual(decodeNmlDocument(source));
  });

  it("merges concurrent character edits without replacing whole strings", () => {
    const a = createNmlYDoc(document);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const aCode = blockMap(a, 3).get("code") as Y.Text;
    const bCode = blockMap(b, 3).get("code") as Y.Text;
    a.transact(() => aCode.insert(0, "A"), origin);
    b.transact(() => bCode.insert(bCode.length, "B"), { ...origin, transactionId: "tx-2" });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    expect(decodeNmlDocument(a)).toEqual(decodeNmlDocument(b));
    expect((decodeNmlDocument(a).blocks[3] as { code: string }).code).toBe("Aconst x = 1;\nB");
  });

  it("keeps independent canvas shape-field and label edits from separate clients", () => {
    const a = createNmlYDoc(document);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const shape = (doc: Y.Doc) => {
      const scene = blockMap(doc, 5).get("scene") as Y.Map<unknown>;
      return (scene.get("shapes") as Y.Map<Y.Map<unknown>>).get("shape1")!;
    };
    a.transact(() => shape(a).set("geometry", new Y.Map(Object.entries({ x: 25, y: 20, w: 80, h: 60, rot: 5 }))), origin);
    b.transact(() => (shape(b).get("label") as Y.Text).insert(5, " world"), { ...origin, transactionId: "tx-2" });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    const canvas = decodeNmlDocument(a).blocks[5];
    if (canvas.type !== "canvas" || canvas.scene.nodes[0].kind !== "group") throw new Error("Expected canvas group");
    expect(canvas.scene.nodes[0].children[0]).toMatchObject({ x: 25, label: "Hello world" });
    expect(decodeNmlDocument(b)).toEqual(decodeNmlDocument(a));
  });

  it("emits attributed semantic change sets and state-vector boundaries", () => {
    const doc = createNmlYDoc(document);
    const listener = vi.fn();
    const stop = observeNmlChanges(doc, listener);
    const code = blockMap(doc, 3).get("code") as Y.Text;
    doc.transact(() => code.insert(code.length, "more"), origin);
    stop();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toMatchObject({ transactionId: "tx-1", origin, changes: [{ kind: "text", nodeId: "code1" }], diagnostics: [] });
    expect(listener.mock.calls[0][0].beforeStateVector).toBeInstanceOf(Uint8Array);
    expect(listener.mock.calls[0][0].afterStateVector).toBeInstanceOf(Uint8Array);
  });

  it("fails closed for unknown versions and malformed shared types", () => {
    const newer = createNmlYDoc(document);
    newer.getMap(NML_YJS_ROOT).set("schemaVersion", 2);
    expect(() => decodeNmlDocument(newer)).toThrow(NmlYjsDecodeError);

    const malformed = createNmlYDoc(document);
    blockMap(malformed, 0).set("content", "not collaborative");
    expect(() => decodeNmlDocument(malformed)).toThrow(/collaborative inline content/);
    const unknown = createNmlYDoc(document);
    unknown.getMap(NML_YJS_ROOT).set("extra", "not allowed");
    expect(() => decodeNmlDocument(unknown)).toThrow(/Unknown canonical Yjs key/);
  });

  it("refuses to initialize over canonical state", () => {
    const doc = createNmlYDoc(document);
    expect(() => createNmlYDoc(decodeNmlDocument(doc))).not.toThrow();
    expect(() => writeNmlDocument(doc, document)).toThrow(/semantic executor/);
  });
});
