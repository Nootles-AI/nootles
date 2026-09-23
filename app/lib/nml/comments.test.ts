import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  createNmlYDoc,
  decodeNmlDocument,
  executeNmlCommands,
  NML_YJS_ROOT,
  NmlCommandConflict,
  NmlYjsDecodeError,
  parseCanonicalDocument,
  parseDocument,
  serializeDocument,
  validateDocument,
  verifyStoredNmlRoot,
  type NmlBlock,
  type NmlCommand,
  type NmlDocument,
} from ".";
import { projectNmlDocument } from "./model/projection";
import { NmlProjection } from "./view/projection";

/**
 * The comments document profile: `commentThread` and `comment` exist only in a
 * document whose `kind` is "comments", which in turn holds nothing else — and
 * every layer (validation, text, Yjs, the executor, the page projections)
 * keeps both halves of that rule.
 */

const comment = (id: string, text: string, extra: Partial<{ editedAt: number }> = {}): NmlBlock => ({
  id,
  type: "comment",
  props: { authorId: "user_ada", createdAt: 1_727_000_000_000, ...extra },
  content: [{ type: "text", text, marks: [] }],
  children: [],
});

const thread = (id: string, children: NmlBlock[] = [comment(`${id}-c1`, "First")], props: object = {}): NmlBlock => ({
  id,
  type: "commentThread",
  props: {
    anchor: { blockId: "p_7f3a", exact: "by Friday", prefix: "ship it ", suffix: " if the", offsetHint: 8 },
    status: "open",
    ...props,
  },
  children,
} as NmlBlock);

const paragraph = (id: string, text: string): NmlBlock => ({
  id,
  type: "paragraph",
  props: {},
  content: [{ type: "text", text, marks: [] }],
  children: [],
});

const commentsDoc = (blocks: NmlBlock[]): NmlDocument => ({
  schemaVersion: 1,
  documentId: "comments-doc",
  kind: "comments",
  blocks,
});

const pageDoc = (blocks: NmlBlock[]): NmlDocument => ({ schemaVersion: 1, documentId: "page-doc", blocks });

const codes = (input: unknown) => validateDocument(input).map((issue) => issue.code);

describe("validation", () => {
  it("accepts threads of comments in a comments document", () => {
    expect(validateDocument(commentsDoc([thread("t1"), thread("t2", [comment("c2", "a"), comment("c3", "b")])]))).toEqual([]);
    expect(validateDocument(commentsDoc([]))).toEqual([]);
  });

  it("refuses a thread or a comment anywhere in a page", () => {
    expect(codes(pageDoc([paragraph("p1", "x"), thread("t1")]))).toContain("document_profile");
    expect(codes(pageDoc([comment("c1", "x")]))).toContain("document_profile");
    const nested: NmlBlock = {
      id: "li",
      type: "bulletListItem",
      props: {},
      content: [],
      children: [comment("c1", "hidden in a list")],
    };
    const issues = validateDocument(pageDoc([nested]));
    expect(issues.map((issue) => issue.code)).toEqual(["document_profile"]);
    expect(issues[0].nodeId).toBe("c1");
  });

  it("refuses page blocks in a comments document, at the top or inside a thread", () => {
    expect(codes(commentsDoc([paragraph("p1", "x")]))).toContain("document_profile");
    expect(codes(commentsDoc([comment("c1", "loose")]))).toContain("document_profile");
    expect(codes(commentsDoc([thread("t1", [paragraph("p1", "x")])]))).toContain("document_profile");
    expect(codes(commentsDoc([thread("t1", [thread("t2")])]))).toContain("document_profile");
  });

  it("refuses an unknown document kind", () => {
    expect(codes({ ...commentsDoc([]), kind: "chat" })).toContain("invalid_schema");
  });

  it("carries resolvedBy and resolvedAt exactly when resolved", () => {
    expect(codes(commentsDoc([thread("t1", undefined, { status: "resolved", resolvedBy: "user_b", resolvedAt: 5 })]))).toEqual([]);
    expect(codes(commentsDoc([thread("t1", undefined, { status: "resolved" })]))).toEqual(["thread_resolution"]);
    expect(codes(commentsDoc([thread("t1", undefined, { status: "resolved", resolvedBy: "user_b" })]))).toEqual(["thread_resolution"]);
    expect(codes(commentsDoc([thread("t1", undefined, { resolvedBy: "user_b", resolvedAt: 5 })]))).toEqual(["thread_resolution"]);
  });

  it.each([
    ["an empty quotation", { anchor: { blockId: "p", exact: "", prefix: "", suffix: "", offsetHint: 0 } }],
    ["a negative offset hint", { anchor: { blockId: "p", exact: "x", prefix: "", suffix: "", offsetHint: -1 } }],
    ["a fractional offset hint", { anchor: { blockId: "p", exact: "x", prefix: "", suffix: "", offsetHint: 1.5 } }],
    ["no block id", { anchor: { blockId: "", exact: "x", prefix: "", suffix: "", offsetHint: 0 } }],
    ["a stray anchor field", { anchor: { blockId: "p", exact: "x", prefix: "", suffix: "", offsetHint: 0, range: 3 } }],
    ["an unknown status", { status: "archived" }],
    ["ambiguous spelled false", { ambiguous: false }],
    ["an unknown prop", { color: "red" }],
  ])("refuses a thread with %s", (_, props) => {
    expect(codes(commentsDoc([thread("t1", undefined, props)]))).toContain("invalid_schema");
  });

  it("refuses a comment without an author or with content-free props gone wrong", () => {
    const bad = { ...comment("c1", "x"), props: { authorId: "", createdAt: 1 } } as NmlBlock;
    expect(codes(commentsDoc([thread("t1", [bad])]))).toContain("invalid_schema");
    const noTime = { ...comment("c1", "x"), props: { authorId: "u" } } as unknown as NmlBlock;
    expect(codes(commentsDoc([thread("t1", [noTime])]))).toContain("invalid_schema");
  });

  it("claims thread and comment ids in the document's one id space", () => {
    expect(codes(commentsDoc([thread("t1", [comment("t1", "same id as its thread")])]))).toContain("duplicate_id");
    expect(codes(commentsDoc([thread("t1", [comment("c1", "a")]), thread("t2", [comment("c1", "b")])]))).toContain("duplicate_id");
  });
});

describe("canonical text", () => {
  const document = commentsDoc([
    thread("t1", [comment("c1", "Is Friday realistic?"), comment("c2", "Yes.", { editedAt: 1_727_000_000_500 })]),
    thread("t2", [comment("c3", "Done")], { status: "resolved", resolvedBy: "user_b", resolvedAt: 9, orphanedAt: 7, ambiguous: true }),
  ]);

  it("serializes to a fixed, attribute-ordered form", () => {
    expect(serializeDocument(document)).toBe(
      [
        `<nt-document id="comments-doc" schema-version="1" kind="comments">`,
        `  <nt-thread id="t1" block-id="p_7f3a" exact="by Friday" prefix="ship it " suffix=" if the" offset-hint="8" status="open">`,
        `    <nt-comment id="c1" author-id="user_ada" created-at="1727000000000">Is Friday realistic?</nt-comment>`,
        `    <nt-comment id="c2" author-id="user_ada" created-at="1727000000000" edited-at="1727000000500">Yes.</nt-comment>`,
        `  </nt-thread>`,
        `  <nt-thread id="t2" block-id="p_7f3a" exact="by Friday" prefix="ship it " suffix=" if the" offset-hint="8" status="resolved" resolved-by="user_b" resolved-at="9" orphaned-at="7" ambiguous="true">`,
        `    <nt-comment id="c3" author-id="user_ada" created-at="1727000000000">Done</nt-comment>`,
        `  </nt-thread>`,
        `</nt-document>`,
        ``,
      ].join("\n"),
    );
  });

  it("round-trips exactly: parse(serialize(d)) = d and serialize(parse(s)) = s", () => {
    const source = serializeDocument(document);
    const parsed = parseCanonicalDocument(source);
    expect(parsed).toEqual(document);
    expect(serializeDocument(parsed)).toBe(source);
  });

  it("keeps a quotation's awkward characters byte for byte", () => {
    const awkward = commentsDoc([
      thread("t1", undefined, {
        anchor: {
          blockId: "p1",
          exact: `"quoted" & <tagged> 'single'`,
          prefix: "  two leading spaces\tand a tab",
          suffix: "line\nbreak\r\nand emoji 🧵 ",
          offsetHint: 0,
        },
      }),
    ]);
    const source = serializeDocument(awkward);
    expect(source).toContain(`exact="&quot;quoted&quot; &amp; &lt;tagged&gt; 'single'"`);
    expect(source).toContain("&#9;");
    expect(source).toContain("&#10;");
    expect(source).toContain("&#13;");
    const parsed = parseCanonicalDocument(source);
    expect(parsed).toEqual(awkward);
    expect(serializeDocument(parsed)).toBe(source);
  });

  it("serializes an empty thread without a stray line", () => {
    const source = serializeDocument(commentsDoc([thread("t1", [])]));
    expect(source).toContain(`status="open"></nt-thread>`);
    expect(serializeDocument(parseCanonicalDocument(source))).toBe(source);
  });

  it("keeps rich inline content in a comment", () => {
    const rich: NmlBlock = {
      ...comment("c1", ""),
      content: [
        { type: "text", text: "see ", marks: [] },
        { type: "text", text: "this", marks: ["bold"] },
        { type: "text", text: " and ", marks: [] },
        { type: "link", href: "https://example.com", content: [{ type: "text", text: "that", marks: [] }] },
        { type: "pageRef", id: "ref1", pageId: "page_2", fallbackTitle: "Roadmap" },
      ],
    } as NmlBlock;
    const doc = commentsDoc([thread("t1", [rich])]);
    const source = serializeDocument(doc);
    expect(parseCanonicalDocument(source)).toEqual(doc);
  });

  it("a page serializes as it always has — no kind attribute", () => {
    expect(serializeDocument(pageDoc([paragraph("p1", "hi")]))).toBe(
      `<nt-document id="page-doc" schema-version="1">\n  <p id="p1">hi</p>\n</nt-document>\n`,
    );
  });

  it("refuses a thread in a page's text, and page text in a comments document", () => {
    const threadInPage = `<nt-document id="d" schema-version="1">\n  <nt-thread id="t1" block-id="p" exact="x" prefix="" suffix="" offset-hint="0" status="open"></nt-thread>\n</nt-document>\n`;
    expect(parseDocument(threadInPage).diagnostics.map((d) => d.code)).toContain("document_profile");
    const pageInComments = `<nt-document id="d" schema-version="1" kind="comments">\n  <p id="p1">hi</p>\n</nt-document>\n`;
    expect(parseDocument(pageInComments).diagnostics.map((d) => d.code)).toContain("document_profile");
    expect(() => parseCanonicalDocument(pageInComments)).toThrow();
  });

  it("refuses an unknown kind and a noncanonical spelling", () => {
    const unknown = `<nt-document id="d" schema-version="1" kind="chat">\n</nt-document>\n`;
    expect(parseDocument(unknown).diagnostics.map((d) => d.code)).toEqual(["unknown_document_kind"]);
    const reordered = `<nt-document id="d" schema-version="1" kind="comments">\n  <nt-thread id="t1" status="open" block-id="p" exact="x" prefix="" suffix="" offset-hint="0"></nt-thread>\n</nt-document>\n`;
    expect(parseDocument(reordered).diagnostics.map((d) => d.code)).toContain("noncanonical_source");
    // …which the model/import modes accept and normalize.
    const model = parseDocument(reordered, { mode: "model" });
    expect(model.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(model.document).toEqual({
      schemaVersion: 1,
      documentId: "d",
      kind: "comments",
      blocks: [{
        id: "t1",
        type: "commentThread",
        props: { anchor: { blockId: "p", exact: "x", prefix: "", suffix: "", offsetHint: 0 }, status: "open" },
        children: [],
      }],
    });
  });

  it("refuses a comment whose timestamps are not integers", () => {
    const bad = `<nt-document id="d" schema-version="1" kind="comments">\n  <nt-thread id="t1" block-id="p" exact="x" prefix="" suffix="" offset-hint="0" status="open">\n    <nt-comment id="c1" author-id="u" created-at="yesterday">x</nt-comment>\n  </nt-thread>\n</nt-document>\n`;
    expect(parseDocument(bad).diagnostics.some((d) => d.severity === "error")).toBe(true);
  });
});

describe("Yjs encoding", () => {
  const document = commentsDoc([
    thread("t1", [comment("c1", "one"), comment("c2", "two")], { orphanedAt: 3, ambiguous: true }),
    thread("t2", [comment("c3", "three")], { status: "resolved", resolvedBy: "user_b", resolvedAt: 9 }),
  ]);

  it("encodes and decodes a comments document losslessly, kind included", () => {
    const doc = createNmlYDoc(document);
    expect(doc.getMap(NML_YJS_ROOT).get("kind")).toBe("comments");
    expect(decodeNmlDocument(doc)).toEqual(document);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
    expect(decodeNmlDocument(replica)).toEqual(document);
  });

  it("a page root carries no kind", () => {
    const doc = createNmlYDoc(pageDoc([paragraph("p1", "x")]));
    expect(doc.getMap(NML_YJS_ROOT).has("kind")).toBe(false);
    expect(decodeNmlDocument(doc).kind).toBeUndefined();
  });

  it("refuses to write a thread into a page root", () => {
    expect(() => createNmlYDoc(pageDoc([thread("t1")]))).toThrow();
  });

  it("still reads a comments root whose kind was lost, and validation says what is wrong", () => {
    const doc = createNmlYDoc(document);
    doc.getMap(NML_YJS_ROOT).delete("kind");
    const decoded = decodeNmlDocument(doc);
    expect(decoded.kind).toBeUndefined();
    expect(validateDocument(decoded).map((issue) => issue.code)).toContain("document_profile");
  });

  it("refuses to decode an unknown kind", () => {
    const doc = createNmlYDoc(document);
    doc.getMap(NML_YJS_ROOT).set("kind", "chat");
    expect(() => decodeNmlDocument(doc)).toThrow(NmlYjsDecodeError);
  });

  it("is never verified as a page's root", () => {
    const verdict = verifyStoredNmlRoot([Y.encodeStateAsUpdate(createNmlYDoc(document))]);
    expect(verdict.ok).toBe(false);
    expect(verdict.errorCodes).toContain("document_kind");
    const page = verifyStoredNmlRoot([Y.encodeStateAsUpdate(createNmlYDoc(pageDoc([paragraph("p1", "x")])))]);
    expect(page.ok).toBe(true);
  });
});

describe("the page projections leave comments out", () => {
  it("the editor projection refuses a comments document", () => {
    expect(() => new NmlProjection().project(commentsDoc([thread("t1")]))).toThrow(/page document/);
  });

  it("the model projection refuses a comments document", () => {
    expect(() => projectNmlDocument(commentsDoc([thread("t1")]))).toThrow(/page document/);
  });
});

describe("the command executor on a comments document", () => {
  let n = 0;
  const run = (doc: Y.Doc, commands: NmlCommand[], documentId = "comments-doc") => {
    const id = `tx-${n++}`;
    return executeNmlCommands({
      doc,
      documentId,
      commands,
      origin: { version: 1, transactionId: id, actor: { userId: "user_ada", kind: "human" }, command: "comments-test" },
      idempotencyKey: id,
      authorize: () => true,
    });
  };
  const fresh = () => createNmlYDoc(commentsDoc([]));
  const blocks = (doc: Y.Doc) => decodeNmlDocument(doc).blocks;

  it("starts a thread, replies, edits, resolves, reopens, deletes", async () => {
    const doc = fresh();
    await run(doc, [{ type: "insertNodes", parentId: null, nodes: [thread("t1")] }]);
    await run(doc, [{ type: "insertNodes", parentId: "t1", anchor: { afterId: "t1-c1" }, nodes: [comment("c2", "A reply")] }]);
    expect(blocks(doc)[0].children.map((child) => child.id)).toEqual(["t1-c1", "c2"]);

    await run(doc, [
      { type: "replaceInline", nodeId: "c2", range: { from: 0, to: 7 }, content: [{ type: "text", text: "An edited reply", marks: [] }] },
      { type: "setNodeProps", nodeId: "c2", patch: { editedAt: 1_727_000_001_000 } },
    ]);
    const edited = blocks(doc)[0].children[1];
    expect(edited.type === "comment" && edited.content).toEqual([{ type: "text", text: "An edited reply", marks: [] }]);
    expect(edited.props).toMatchObject({ editedAt: 1_727_000_001_000 });

    await run(doc, [{ type: "setNodeProps", nodeId: "t1", patch: { status: "resolved", resolvedBy: "user_b", resolvedAt: 50 } }]);
    expect(blocks(doc)[0].props).toMatchObject({ status: "resolved", resolvedBy: "user_b", resolvedAt: 50 });
    await run(doc, [{ type: "setNodeProps", nodeId: "t1", patch: { status: "open", resolvedBy: undefined, resolvedAt: undefined } }]);
    expect(blocks(doc)[0].props).not.toHaveProperty("resolvedBy");

    await run(doc, [{ type: "removeNodes", nodeIds: ["c2"] }]);
    expect(blocks(doc)[0].children.map((child) => child.id)).toEqual(["t1-c1"]);
    await run(doc, [{ type: "removeNodes", nodeIds: ["t1"] }]);
    expect(blocks(doc)).toEqual([]);
  });

  it("re-homes an anchor, and two replicas re-homing alike converge", async () => {
    const a = fresh();
    await run(a, [{ type: "insertNodes", parentId: null, nodes: [thread("t1")] }]);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const rehome = { blockId: "p_new", exact: "by Friday", prefix: "ship it ", suffix: " if the", offsetHint: 0 };
    await run(a, [{ type: "setNodeProps", nodeId: "t1", patch: { anchor: rehome, orphanedAt: undefined } }]);
    await run(b, [{ type: "setNodeProps", nodeId: "t1", patch: { anchor: rehome, orphanedAt: undefined } }]);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(decodeNmlDocument(a)).toEqual(decodeNmlDocument(b));
    expect(blocks(a)[0].props).toMatchObject({ anchor: rehome });
  });

  it("refuses a half-resolved thread", async () => {
    const doc = fresh();
    await run(doc, [{ type: "insertNodes", parentId: null, nodes: [thread("t1")] }]);
    await expect(run(doc, [{ type: "setNodeProps", nodeId: "t1", patch: { status: "resolved" } }])).rejects.toMatchObject({
      code: "invalid_command",
    });
    expect(blocks(doc)[0].props).toMatchObject({ status: "open" });
  });

  it("refuses page blocks at the top or inside a thread, and leaves the document as it was", async () => {
    const doc = fresh();
    await run(doc, [{ type: "insertNodes", parentId: null, nodes: [thread("t1")] }]);
    const before = decodeNmlDocument(doc);
    await expect(run(doc, [{ type: "insertNodes", parentId: null, nodes: [paragraph("p1", "x")] }])).rejects.toBeInstanceOf(NmlCommandConflict);
    await expect(run(doc, [{ type: "insertNodes", parentId: "t1", nodes: [paragraph("p1", "x")] }])).rejects.toBeInstanceOf(NmlCommandConflict);
    await expect(run(doc, [{ type: "insertNodes", parentId: "t1", nodes: [thread("t2")] }])).rejects.toBeInstanceOf(NmlCommandConflict);
    await expect(run(doc, [{ type: "insertNodes", parentId: null, nodes: [comment("c9", "loose")] }])).rejects.toBeInstanceOf(NmlCommandConflict);
    await expect(run(doc, [{ type: "moveNodes", nodeIds: ["t1-c1"], destination: { parentId: null } }])).rejects.toBeInstanceOf(NmlCommandConflict);
    expect(decodeNmlDocument(doc)).toEqual(before);
  });

  it("a reply racing its thread's deletion goes with the thread, and the document stays usable", async () => {
    const ada = fresh();
    await run(ada, [{ type: "insertNodes", parentId: null, nodes: [thread("t1"), thread("t2")] }]);
    const bram = new Y.Doc();
    Y.applyUpdate(bram, Y.encodeStateAsUpdate(ada));
    await run(ada, [{ type: "removeNodes", nodeIds: ["t1"] }]);
    await run(bram, [{ type: "insertNodes", parentId: "t1", nodes: [comment("late", "A reply nobody will see")] }]);
    Y.applyUpdate(ada, Y.encodeStateAsUpdate(bram));
    Y.applyUpdate(bram, Y.encodeStateAsUpdate(ada));
    for (const doc of [ada, bram]) {
      const merged = decodeNmlDocument(doc);
      expect(merged.blocks.map((block) => block.id)).toEqual(["t2"]);
      expect(validateDocument(merged)).toEqual([]);
    }
    await run(bram, [{ type: "insertNodes", parentId: "t2", nodes: [comment("next", "Still works")] }]);
    expect(blocks(bram)[0].children.map((child) => child.id)).toEqual(["t2-c1", "next"]);
  });

  it("a page's orphan still recovers at the root, as before", async () => {
    const list: NmlBlock = { id: "li", type: "bulletListItem", props: {}, content: [], children: [] };
    const a = createNmlYDoc(pageDoc([list]));
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    await run(a, [{ type: "removeNodes", nodeIds: ["li"] }], "page-doc");
    await run(b, [{ type: "insertNodes", parentId: "li", nodes: [paragraph("p1", "kept")] }], "page-doc");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(decodeNmlDocument(a).blocks.map((block) => block.id)).toEqual(["p1"]);
  });

  it("refuses a thread in a page document", async () => {
    const doc = createNmlYDoc(pageDoc([paragraph("p1", "x")]));
    await expect(
      run(doc, [{ type: "insertNodes", parentId: null, nodes: [thread("t1")] }], "page-doc"),
    ).rejects.toBeInstanceOf(NmlCommandConflict);
    expect(decodeNmlDocument(doc).blocks.map((block) => block.id)).toEqual(["p1"]);
  });
});
