import { TextSelection } from "prosemirror-state";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  createNmlYDoc,
  decodeNmlDocument,
  executeNmlCommands,
  type NmlBlock,
  type NmlDocument,
  type NmlInlineContent,
} from "..";
import { EditableNmlBridge, nmlInlineOffsetToPm } from ".";

const actor = { userId: "rich-editor", kind: "human" } as const;
const paragraph = (id: string, text: string, marks: Array<"bold" | "italic"> = []): NmlBlock => ({
  id, type: "paragraph", props: {}, children: [],
  content: text ? [{ type: "text", text, marks }] : [],
});
const list = (id: string, text: string): NmlBlock => ({
  id, type: "bulletListItem", props: {}, children: [],
  content: [{ type: "text", text, marks: [] }],
});
const document = (blocks: NmlBlock[]): NmlDocument => ({ schemaVersion: 1, documentId: "rich-editing", blocks });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const editable = (doc: Y.Doc, authorize: () => boolean | Promise<boolean> = () => true) => new EditableNmlBridge(doc, {
  actor,
  authorize,
  createRequestId: (() => { let id = 0; return () => `rich-request-${++id}`; })(),
});
const content = (doc: Y.Doc, id: string) => {
  const block = decodeNmlDocument(doc).blocks.find((candidate) => candidate.id === id);
  return block && "content" in block ? block.content : [];
};

describe("rich and structural NML editing bridge", () => {
  it("translates rich typing, marks, links, inline math, and page references", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "rich text", ["bold"])]));
    const bridge = editable(ydoc);
    const start = bridge.index.get("p")!.contentStart!;

    expect(bridge.dispatch(bridge.state.tr.insertText("!", start + 4))).toBe(true);
    await flush();
    expect(content(ydoc, "p")).toEqual([{ type: "text", text: "rich! text", marks: ["bold"] }]);

    bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, start, start + 4)));
    expect(bridge.toggleMark("italic")).toBe(true);
    await flush();
    expect(content(ydoc, "p")[0]).toMatchObject({ text: "rich", marks: ["bold", "italic"] });

    bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, start + 6, start + 10)));
    expect(bridge.setLink("https://example.com")).toBe(true);
    await flush();
    expect(content(ydoc, "p")).toContainEqual({
      type: "link", href: "https://example.com", content: [{ type: "text", text: "text", marks: ["bold"] }],
    });

    const linkedEntry = bridge.index.get("p")!;
    const linkedNode = bridge.state.doc.nodeAt(linkedEntry.pmStart)!;
    bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(
      bridge.state.doc,
      linkedEntry.contentStart! + nmlInlineOffsetToPm(linkedNode, 6, "after"),
      linkedEntry.contentStart! + nmlInlineOffsetToPm(linkedNode, 10, "before"),
    )));
    const durable = bridge.toNmlSelection();
    expect(durable).not.toBeNull();
    expect(bridge.toPmSelection(durable!).eq(bridge.state.selection)).toBe(true);
    expect(bridge.setLink(null)).toBe(true);
    await flush();
    expect(content(ydoc, "p")).toEqual([
      { type: "text", text: "rich", marks: ["bold", "italic"] },
      { type: "text", text: "! text", marks: ["bold"] },
    ]);

    bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, bridge.index.get("p")!.pmEnd - 1)));
    expect(bridge.insertInlineMath("x^2")).toBe(true);
    await flush();
    expect(content(ydoc, "p").at(-1)).toMatchObject({ type: "math", latex: "x^2" });
    expect(bridge.insertPageReference("page-2", "Second page")).toBe(true);
    await flush();
    expect(content(ydoc, "p").at(-1)).toMatchObject({ type: "pageRef", pageId: "page-2" });
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("edits text and marks across partial link boundaries", async () => {
    const linked: NmlBlock = {
      id: "p", type: "paragraph", props: {}, children: [],
      content: [{
        type: "link", href: "https://example.com",
        content: [{ type: "text", text: "abcdef", marks: ["bold"] }],
      }],
    };
    const ydoc = createNmlYDoc(document([linked]));
    const bridge = editable(ydoc);
    const select = (from: number, to: number) => {
      const entry = bridge.index.get("p")!;
      const node = bridge.state.doc.nodeAt(entry.pmStart)!;
      bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(
        bridge.state.doc,
        entry.contentStart! + nmlInlineOffsetToPm(node, from, "after"),
        entry.contentStart! + nmlInlineOffsetToPm(node, to, "before"),
      )));
    };

    select(2, 4);
    expect(bridge.setLink(null)).toBe(true);
    await flush();
    expect(content(ydoc, "p")).toEqual([
      { type: "link", href: "https://example.com", content: [{ type: "text", text: "ab", marks: ["bold"] }] },
      { type: "text", text: "cd", marks: ["bold"] },
      { type: "link", href: "https://example.com", content: [{ type: "text", text: "ef", marks: ["bold"] }] },
    ]);

    select(3, 3);
    expect(bridge.dispatch(bridge.state.tr.insertText("X"))).toBe(true);
    await flush();
    select(6, 6);
    expect(bridge.dispatch(bridge.state.tr.insertText("Y"))).toBe(true);
    await flush();
    expect(content(ydoc, "p")).toEqual([
      { type: "link", href: "https://example.com", content: [{ type: "text", text: "ab", marks: ["bold"] }] },
      { type: "text", text: "cXd", marks: ["bold"] },
      { type: "link", href: "https://example.com", content: [{ type: "text", text: "eYf", marks: ["bold"] }] },
    ]);

    select(1, 7);
    expect(bridge.toggleMark("italic")).toBe(true);
    await flush();
    expect(content(ydoc, "p")).toEqual([
      {
        type: "link", href: "https://example.com",
        content: [
          { type: "text", text: "a", marks: ["bold"] },
          { type: "text", text: "b", marks: ["bold", "italic"] },
        ],
      },
      { type: "text", text: "cXd", marks: ["bold", "italic"] },
      {
        type: "link", href: "https://example.com",
        content: [
          { type: "text", text: "eY", marks: ["bold", "italic"] },
          { type: "text", text: "f", marks: ["bold"] },
        ],
      },
    ]);
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("translates native PM link creation, split boundaries, and rejoin without drift", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "abcdef")]));
    const bridge = editable(ydoc);
    const replaceProjection = async (content: NmlInlineContent) => {
      const desired = structuredClone(bridge.snapshot()!);
      const block = desired.blocks[0];
      if (!("content" in block)) throw new Error("Fixture mismatch");
      block.content = content;
      const projected = bridge.projection.project(desired);
      expect(bridge.dispatch(bridge.state.tr.replaceWith(0, bridge.state.doc.content.size, projected.content))).toBe(true);
      await flush();
      expect(bridge.checkDrift()).toBe(true);
    };
    const link = (text: string) => ({
      type: "link" as const,
      href: "https://example.com",
      content: [{ type: "text" as const, text, marks: [] }],
    });

    await replaceProjection([link("abcdef")]);
    expect(content(ydoc, "p")).toEqual([link("abcdef")]);
    await replaceProjection([link("abc"), link("def")]);
    expect(content(ydoc, "p")).toEqual([link("abc"), link("def")]);
    await replaceProjection([link("abcdef")]);
    expect(content(ydoc, "p")).toEqual([link("abcdef")]);
    bridge.destroy(); ydoc.destroy();
  });

  it("splits, joins, indents, outdents, moves, converts, and pastes blocks", async () => {
    const ydoc = createNmlYDoc(document([list("a", "alpha"), list("b", "bravo"), paragraph("c", "charlie")]));
    const bridge = editable(ydoc);
    let start = bridge.index.get("b")!.contentStart!;
    bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, start + 2)));
    expect(bridge.splitSelection()).toBe(true);
    await flush();
    let ast = decodeNmlDocument(ydoc);
    expect(ast.blocks.map((block) => "content" in block ? block.content.map((part) => part.type === "text" ? part.text : "").join("") : "")).toEqual(["alpha", "br", "avo", "charlie"]);

    const splitId = ast.blocks[2].id;
    expect(bridge.nmlSelection()?.anchor).toMatchObject({ kind: "text", nodeId: splitId });
    start = bridge.index.get(splitId)!.contentStart!;
    bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, start)));
    expect(bridge.joinBackward()).toBe(true);
    await flush();
    expect(decodeNmlDocument(ydoc).blocks).toHaveLength(3);

    start = bridge.index.get("b")!.contentStart!;
    bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, start + 1)));
    expect(bridge.indentSelection()).toBe(true);
    await flush();
    expect(decodeNmlDocument(ydoc).blocks[0].children[0].id).toBe("b");
    expect(bridge.indentSelection(true)).toBe(true);
    await flush();
    expect(decodeNmlDocument(ydoc).blocks.map((block) => block.id)).toEqual(["a", "b", "c"]);
    expect(bridge.moveSelection(1)).toBe(true);
    await flush();
    expect(decodeNmlDocument(ydoc).blocks.map((block) => block.id)).toEqual(["a", "c", "b"]);
    expect(bridge.setSelectedBlockType("numberedListItem", { start: 3 })).toBe(true);
    await flush();
    expect(decodeNmlDocument(ydoc).blocks[2]).toMatchObject({ type: "numberedListItem", props: { start: 3 } });

    expect(bridge.pasteText("one\ntwo\nthree")).toBe(true);
    await flush();
    ast = decodeNmlDocument(ydoc);
    expect(ast.blocks.slice(-3).map((block) => "content" in block ? block.content.map((part) => part.type === "text" ? part.text : "").join("") : "")).toEqual(["bone", "two", "threeravo"]);
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("does not let a late receipt overwrite a newer user selection", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "alpha"), paragraph("q", "bravo")]));
    const bridge = editable(ydoc);
    const start = bridge.index.get("p")!.contentStart!;
    bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, start + 2)));
    expect(bridge.splitSelection()).toBe(true);
    const nextSelection = bridge.index.get("q")!.contentStart! + 1;
    expect(bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, nextSelection)))).toBe(true);
    await flush();
    expect(bridge.nmlSelection()?.anchor).toMatchObject({ kind: "text", nodeId: "q" });
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("mints identities for native PM inserts, copies, and inserted wrappers", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "original")]));
    const bridge = editable(ydoc);
    const inserted = bridge.projection.schema.nodes.nml_paragraph.createChecked(
      { props: {} },
      bridge.projection.schema.text("inserted"),
    );
    expect(bridge.dispatch(bridge.state.tr.insert(bridge.state.doc.content.size, inserted))).toBe(true);
    await flush();
    let ast = decodeNmlDocument(ydoc);
    expect(ast.blocks).toHaveLength(2);
    const insertedId = ast.blocks[1].id;
    expect(insertedId).toBeTruthy();
    expect(insertedId.startsWith("$nml-")).toBe(false);

    const copied = bridge.state.doc.nodeAt(bridge.index.get(insertedId)!.pmStart)!;
    expect(bridge.dispatch(bridge.state.tr.insert(bridge.state.doc.content.size, copied))).toBe(true);
    await flush();
    ast = decodeNmlDocument(ydoc);
    expect(ast.blocks).toHaveLength(3);
    expect(new Set(ast.blocks.map((block) => block.id)).size).toBe(3);

    const desired = structuredClone(bridge.snapshot()!);
    const original = desired.blocks.find((block) => block.id === "p")!;
    desired.blocks = desired.blocks.filter((block) => block.id !== "p");
    desired.blocks.unshift({
      id: "$nml-wrapper",
      type: "toggleListItem",
      props: {},
      content: [{ type: "text", text: "wrapper", marks: [] }],
      children: [original],
    });
    const projected = bridge.projection.project(desired);
    expect(bridge.dispatch(bridge.state.tr.replaceWith(0, bridge.state.doc.content.size, projected.content))).toBe(true);
    await flush();
    ast = decodeNmlDocument(ydoc);
    expect(ast.blocks[0].type).toBe("toggleListItem");
    expect(ast.blocks[0].children[0].id).toBe("p");
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("compiles table, code, math, media, and atomic-domain projection changes", async () => {
    const blocks: NmlBlock[] = [
      { id: "table", type: "table", props: { headerRows: 1 }, children: [], columns: [{ id: "col" }], rows: [{ id: "row", cells: [{ id: "cell", content: [{ type: "text", text: "old", marks: [] }] }] }] },
      { id: "code", type: "codeBlock", props: { language: "ts" }, children: [], code: "const a = 1" },
      { id: "math", type: "mathBlock", props: {}, children: [], rows: [{ id: "math-row", latex: "x" }] },
      { id: "image", type: "image", props: {}, children: [] },
      { id: "album", type: "album", props: {}, children: [], domain: { items: [] } },
      { id: "story", type: "storyboard", props: {}, children: [], domain: { ratio: "16:9", shots: [{ scene: "", note: "old" }] } },
      { id: "location", type: "location", props: {}, children: [], domain: { name: "HQ", images: [], off: [] } },
    ];
    const ydoc = createNmlYDoc(document(blocks));
    const bridge = editable(ydoc);
    const desired = structuredClone(bridge.snapshot()!);
    const table = desired.blocks[0];
    const code = desired.blocks[1];
    const math = desired.blocks[2];
    const image = desired.blocks[3];
    const album = desired.blocks[4];
    const story = desired.blocks[5];
    const location = desired.blocks[6];
    if (table.type !== "table" || code.type !== "codeBlock" || math.type !== "mathBlock" || image.type !== "image" ||
        album.type !== "album" || story.type !== "storyboard" || location.type !== "location") throw new Error("Fixture mismatch");
    table.columns.push({ id: "$nml-column" });
    table.rows[0].cells.push({ id: "$nml-cell", content: [{ type: "text", text: "new", marks: ["italic"] }] });
    table.rows[0].cells[0].content = [{ type: "text", text: "changed", marks: ["bold"] }];
    table.rows.push({ id: "$nml-row", cells: [{ id: "$nml-row-cell-1", content: [] }, { id: "$nml-row-cell-2", content: [] }] });
    code.code = "const answer = 42";
    math.rows[0].latex = "x^2";
    math.rows.push({ id: "$nml-math-row", latex: "y" });
    image.type = "video";
    image.props = { source: { kind: "url", url: "https://example.com/video.mp4" }, caption: "Example" };
    album.domain.items.push({ kind: "image", src: "https://example.com/album.png", w: 3, h: 2 });
    story.domain.shots[0].note = "changed";
    location.domain.note = "changed";
    const projected = bridge.projection.project(desired);
    expect(bridge.dispatch(bridge.state.tr.replaceWith(0, bridge.state.doc.content.size, projected.content))).toBe(true);
    await flush();

    const canonical = decodeNmlDocument(ydoc);
    expect(canonical.blocks[0]).toMatchObject({
      type: "table",
      rows: [
        { cells: [{ content: [{ text: "changed", marks: ["bold"] }] }, { content: [{ text: "new", marks: ["italic"] }] }] },
        { cells: [{ content: [] }, { content: [] }] },
      ],
    });
    expect(canonical.blocks[1]).toMatchObject({ type: "codeBlock", code: "const answer = 42" });
    expect(canonical.blocks[2]).toMatchObject({ type: "mathBlock", rows: [{ latex: "x^2" }, { latex: "y" }] });
    expect(canonical.blocks[3]).toMatchObject({
      type: "video",
      props: { source: { kind: "url", url: "https://example.com/video.mp4" }, caption: "Example" },
    });
    expect(canonical.blocks[4]).toMatchObject({ type: "album", domain: { items: [{ src: "https://example.com/album.png" }] } });
    expect(canonical.blocks[5]).toMatchObject({ type: "storyboard", domain: { shots: [{ note: "changed" }] } });
    expect(canonical.blocks[6]).toMatchObject({ type: "location", domain: { note: "changed" } });

    const reduced = structuredClone(bridge.snapshot()!);
    const reducedTable = reduced.blocks[0];
    const reducedMath = reduced.blocks[2];
    if (reducedTable.type !== "table" || reducedMath.type !== "mathBlock") throw new Error("Fixture mismatch");
    reducedTable.columns.pop();
    reducedTable.rows.forEach((row) => row.cells.pop());
    reducedTable.rows.pop();
    reducedMath.rows.pop();
    const reducedProjection = bridge.projection.project(reduced);
    expect(bridge.dispatch(bridge.state.tr.replaceWith(0, bridge.state.doc.content.size, reducedProjection.content))).toBe(true);
    await flush();
    expect(decodeNmlDocument(ydoc).blocks[0]).toMatchObject({ type: "table", columns: [{ id: "col" }], rows: [{ id: "row", cells: [{ id: "cell" }] }] });
    expect(decodeNmlDocument(ydoc).blocks[2]).toMatchObject({ type: "mathBlock", rows: [{ id: "math-row", latex: "x^2" }] });
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("preserves concurrent rich text while a second replica changes marks", async () => {
    const seed = createNmlYDoc(document([paragraph("p", "abcdef", ["bold"])]));
    const update = Y.encodeStateAsUpdate(seed);
    const left = new Y.Doc(); const right = new Y.Doc();
    Y.applyUpdate(left, update); Y.applyUpdate(right, update);
    await executeNmlCommands({
      doc: left, documentId: "rich-editing",
      commands: [{ type: "replaceInline", nodeId: "p", range: { from: 3, to: 3 }, content: [{ type: "text", text: "LEFT", marks: ["bold"] }] }],
      idempotencyKey: "left", origin: { version: 1, transactionId: "left", actor, command: "test" }, authorize: () => true,
    });
    await executeNmlCommands({
      doc: right, documentId: "rich-editing",
      commands: [{ type: "setInlineMarks", nodeId: "p", range: { from: 0, to: 2 }, marks: ["bold", "italic"] }],
      idempotencyKey: "right", origin: { version: 1, transactionId: "right", actor, command: "test" }, authorize: () => true,
    });
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    expect(decodeNmlDocument(left)).toEqual(decodeNmlDocument(right));
    expect(JSON.stringify(decodeNmlDocument(left))).toContain("LEFT");
    expect(content(left, "p")[0]).toMatchObject({ text: "ab", marks: ["bold", "italic"] });
    left.destroy(); right.destroy(); seed.destroy();
  });

  it("preserves concurrent deletions while a partial link boundary changes", async () => {
    const linked: NmlBlock = {
      id: "p", type: "paragraph", props: {}, children: [],
      content: [{
        type: "link", href: "https://example.com",
        content: [{ type: "text", text: "abcdef", marks: [] }],
      }],
    };
    const seed = createNmlYDoc(document([linked]));
    const update = Y.encodeStateAsUpdate(seed);
    const left = new Y.Doc(); const right = new Y.Doc();
    Y.applyUpdate(left, update); Y.applyUpdate(right, update);
    await executeNmlCommands({
      doc: left, documentId: "rich-editing",
      commands: [{ type: "setInlineLink", nodeId: "p", range: { from: 2, to: 4 }, href: null }],
      idempotencyKey: "unlink", origin: { version: 1, transactionId: "unlink", actor, command: "test" }, authorize: () => true,
    });
    await executeNmlCommands({
      doc: right, documentId: "rich-editing",
      commands: [{ type: "replaceInline", nodeId: "p", range: { from: 4, to: 5 }, content: [] }],
      idempotencyKey: "delete", origin: { version: 1, transactionId: "delete", actor, command: "test" }, authorize: () => true,
    });
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    expect(decodeNmlDocument(left)).toEqual(decodeNmlDocument(right));
    expect(content(left, "p")).toEqual([
      { type: "link", href: "https://example.com", content: [{ type: "text", text: "ab", marks: [] }] },
      { type: "text", text: "cd", marks: [] },
      { type: "link", href: "https://example.com", content: [{ type: "text", text: "f", marks: [] }] },
    ]);
    left.destroy(); right.destroy(); seed.destroy();
  });

  it("converges a split with a concurrent suffix edit and sibling move", async () => {
    const seed = createNmlYDoc(document([paragraph("p", "abcdef"), paragraph("q", "tail")]));
    const update = Y.encodeStateAsUpdate(seed);
    const left = new Y.Doc(); const right = new Y.Doc();
    Y.applyUpdate(left, update); Y.applyUpdate(right, update);
    const bridge = editable(left);
    const start = bridge.index.get("p")!.contentStart!;
    bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, start + 3)));
    expect(bridge.splitSelection()).toBe(true);
    await flush();
    await executeNmlCommands({
      doc: right,
      documentId: "rich-editing",
      commands: [
        { type: "replaceInline", nodeId: "p", range: { from: 4, to: 4 }, content: [{ type: "text", text: "REMOTE", marks: [] }] },
        { type: "moveNodes", nodeIds: ["q"], destination: { parentId: null, anchor: { beforeId: "p" } } },
      ],
      idempotencyKey: "concurrent-right",
      origin: { version: 1, transactionId: "concurrent-right", actor, command: "test" },
      authorize: () => true,
    });
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    await flush();
    expect(decodeNmlDocument(left)).toEqual(decodeNmlDocument(right));
    expect(JSON.stringify(decodeNmlDocument(left))).toContain("REMOTE");
    expect(decodeNmlDocument(left).blocks[0].id).toBe("q");
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); left.destroy(); right.destroy(); seed.destroy();
  });

  it("commits rich IME as one request with inherited marks", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "bold", ["bold"])]));
    const bridge = editable(ydoc);
    const start = bridge.index.get("p")!.contentStart!;
    bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, start + 2)));
    expect(bridge.beginComposition()).toBe(true);
    expect(bridge.dispatch(bridge.state.tr.insertText("日本語", start + 2).setMeta("composition", 1))).toBe(true);
    expect(bridge.endComposition()).toBe(true);
    await flush();
    expect(content(ydoc, "p")).toEqual([{ type: "text", text: "bo日本語ld", marks: ["bold"] }]);
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });

  it("rolls a rejected rich transaction back without logging its content", async () => {
    const ydoc = createNmlYDoc(document([paragraph("p", "secret", ["bold"])]));
    const diagnostics = vi.fn();
    const bridge = new EditableNmlBridge(ydoc, { actor, authorize: () => false }, diagnostics);
    const start = bridge.index.get("p")!.contentStart!;
    expect(bridge.dispatch(bridge.state.tr.insertText(" PRIVATE", start + 6))).toBe(true);
    await flush();
    expect(bridge.state.doc.textContent).toBe("secret");
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain("PRIVATE");
    expect(bridge.checkDrift()).toBe(true);
    bridge.destroy(); ydoc.destroy();
  });
});
