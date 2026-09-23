import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { parseHTML } from "linkedom";
import type { Node } from "prosemirror-model";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { afterAll, describe, expect, it } from "vitest";
import { readerSchema } from "@/app/lib/ai/readerSchema";
import { createNmlYDoc, decodeNmlDocument, type NmlDocument } from "@/app/lib/nml";
import { NmlLegacyMirror } from "@/app/lib/nml/mirror";
import { blockNoteNmlMirrorHost } from "@/app/lib/nml/mirrorBlockNote";
import { mintAnchor } from "./anchor";
import {
  anchorForSelection,
  checkChar,
  nmlBlockTexts,
  offsetAt,
  pmBlockTexts,
  pmRange,
  positionAt,
  selectionSpans,
} from "./pmText";
import { resolveAnchor } from "./resolve";

if (!("document" in globalThis)) {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document, window });
}

const editors: Array<{ _tiptapEditor?: { destroy(): void } }> = [];
afterAll(() => editors.forEach((editor) => editor._tiptapEditor?.destroy()));

type Blocks = PartialBlock<
  (typeof readerSchema)["blockSchema"],
  (typeof readerSchema)["inlineContentSchema"],
  (typeof readerSchema)["styleSchema"]
>[];

/** A real ProseMirror document, built by BlockNote from the editor's schema. */
function pmDoc(blocks: Blocks): Node {
  const editor = BlockNoteEditor.create({ schema: readerSchema, initialContent: blocks });
  editors.push(editor);
  return editor.prosemirrorState.doc;
}

const RICH: Blocks = [
  { id: "h", type: "heading", props: { level: 2 }, content: "Plan for Friday" },
  {
    id: "p",
    type: "paragraph",
    content: [
      { type: "text", text: "Solve ", styles: {} },
      { type: "math", props: { latex: "x^2" } },
      { type: "text", text: " first, see ", styles: { bold: true } },
      { type: "pageMention", props: { pageId: "pg1", title: "Roadmap" } },
      { type: "text", text: " and ", styles: {} },
      { type: "link", href: "https://example.com", content: "the doc" },
      { type: "text", text: ".\nNext line ", styles: {} },
      { type: "checkbox", props: { checked: true } },
      { type: "text", text: " done", styles: {} },
    ],
  },
  {
    id: "table",
    type: "table",
    content: { type: "tableContent", rows: [{ cells: ["cell one", "cell two"] }] },
  },
  {
    id: "list",
    type: "bulletListItem",
    content: "Parent item",
    children: [
      { id: "child", type: "checkListItem", props: { checked: true }, content: "Nested 😀 child" },
    ],
  },
  { id: "code", type: "codeBlock", props: { language: "ts", code: "const x = 1;" } },
  { id: "empty", type: "paragraph", content: "" },
  { id: "q", type: "quote", content: "Quoted café́ text" },
];

describe("pmBlockTexts", () => {
  const doc = pmDoc(RICH);
  const blocks = pmBlockTexts(doc);

  it("reads every block with inline content, in document order, children after parents", () => {
    expect(blocks.map(({ blockId, text }) => ({ blockId, text }))).toEqual([
      { blockId: "h", text: "Plan for Friday" },
      {
        blockId: "p",
        text: `Solve  first, see  and the doc.\nNext line ${checkChar(true)} done`,
      },
      { blockId: "list", text: "Parent item" },
      { blockId: "child", text: "Nested 😀 child" },
      { blockId: "empty", text: "" },
      { blockId: "q", text: "Quoted café́ text" },
    ]);
  });

  it("reads only the blocks a range touches when given one", () => {
    const list = blocks.find((block) => block.blockId === "list")!;
    const child = blocks.find((block) => block.blockId === "child")!;
    expect(pmBlockTexts(doc, list.start + 1, child.start + 2)).toEqual([list, child]);
  });

  it("maps every character to the position that holds it", () => {
    for (const block of blocks) {
      block.map.posAt.slice(0, -1).forEach((pos, i) => {
        const char = block.text[i];
        const node = doc.nodeAt(pos)!;
        if (char === "\n") expect(node.type.name).toBe("hardBreak");
        else if (char === checkChar(true) || char === checkChar(false)) expect(node.type.name).toBe("checkbox");
        else expect(doc.textBetween(pos, pos + 1)).toBe(char);
      });
      expect(block.map.posAt[block.text.length]).toBe(block.end);
      expect(doc.resolve(block.start).parent.type.spec.group).toBe("blockContent");
    }
  });

  it("puts a range's ends against its characters, leaving atoms at either edge outside", () => {
    const p = blocks.find((block) => block.blockId === "p")!;
    // "Solve " then the maths atom, then " first".
    const beforeMath = pmRange(blocks, "p", 0, 5)!; // "Solve"
    expect(doc.textBetween(beforeMath.from, beforeMath.to)).toBe("Solve");
    const upToMath = positionAt(p, 6, "end");
    expect(doc.nodeAt(upToMath)!.type.name).toBe("math");
    const afterMath = positionAt(p, 6, "start");
    expect(doc.nodeAt(afterMath - 1)!.type.name).toBe("math");
    const linked = p.text.indexOf("the doc");
    const range = pmRange(blocks, "p", linked, linked + 7)!;
    expect(doc.textBetween(range.from, range.to)).toBe("the doc");
    expect(doc.rangeHasMark(range.from, range.to, doc.type.schema.marks.link)).toBe(true);
    expect(pmRange(blocks, "gone", 0, 1)).toBeNull();
  });

  it("maps positions back to offsets, atoms counting for nothing", () => {
    const p = blocks.find((block) => block.blockId === "p")!;
    for (let i = 0; i <= p.text.length; i++) {
      expect(offsetAt(p, positionAt(p, i, "start"))).toBe(i);
    }
    expect(offsetAt(p, p.start)).toBe(0);
    expect(offsetAt(p, p.end)).toBe(p.text.length);
  });

  it("gives an emoji its two code units, as ProseMirror does", () => {
    const child = blocks.find((block) => block.blockId === "child")!;
    const at = child.text.indexOf("😀");
    const range = pmRange(blocks, "child", at, at + 2)!;
    expect(range.to - range.from).toBe(2);
    expect(doc.textBetween(range.from, range.to)).toBe("😀");
  });
});

describe("selections", () => {
  const doc = pmDoc(RICH);
  const blocks = pmBlockTexts(doc);
  const at = (blockId: string, offset: number) =>
    positionAt(blocks.find((block) => block.blockId === blockId)!, offset, "start");

  it("anchors a selection inside one block", () => {
    const anchor = anchorForSelection(doc, at("h", 9), at("h", 15));
    expect(anchor).toEqual({ blockId: "h", exact: "Friday", prefix: "Plan for ", suffix: "", offsetHint: 9 });
  });

  it("anchors a selection across blocks to the block it starts in, clamped", () => {
    expect(selectionSpans(blocks, at("h", 5), at("list", 6))).toEqual([
      { blockId: "h", from: 5, to: 15 },
      { blockId: "p", from: 0, to: blocks[1].text.length },
      { blockId: "list", from: 0, to: 6 },
    ]);
    expect(anchorForSelection(doc, at("list", 6), at("h", 5))).toMatchObject({ blockId: "h", exact: "for Friday" });
  });

  it("belongs to the next block with words when it starts at a block's end", () => {
    expect(anchorForSelection(doc, at("h", 15), at("p", 5))).toMatchObject({ blockId: "p", exact: "Solve" });
    const empty = blocks.find((block) => block.blockId === "empty")!;
    expect(anchorForSelection(doc, empty.start, at("q", 6))).toMatchObject({ blockId: "q", exact: "Quoted" });
  });

  it("quotes nothing inside a table, or from an empty selection", () => {
    let inTable = -1;
    doc.descendants((node, pos) => {
      if (inTable < 0 && node.isText && node.text === "cell one") inTable = pos;
    });
    expect(inTable).toBeGreaterThan(0);
    expect(anchorForSelection(doc, inTable, inTable + 4)).toBeNull();
    expect(anchorForSelection(doc, at("h", 3), at("h", 3))).toBeNull();
  });

  it("the whole document anchors to its first words", () => {
    expect(anchorForSelection(doc, 0, doc.content.size)).toMatchObject({ blockId: "h", exact: "Plan for Friday" });
  });

  it("a minted anchor resolves to the range it was minted from, in positions", () => {
    const p = blocks.find((block) => block.blockId === "p")!;
    const from = p.text.indexOf("first");
    const anchor = anchorForSelection(doc, positionAt(p, from, "start"), positionAt(p, from + 5, "end"))!;
    const r = resolveAnchor({ anchor }, blocks);
    expect(r.kind).toBe("anchored");
    if (r.kind !== "anchored") return;
    const range = pmRange(blocks, r.blockId, r.from, r.to)!;
    expect(doc.textBetween(range.from, range.to)).toBe("first");
  });
});

describe("the NML reading agrees with the editor's", () => {
  const nml: NmlDocument = {
    schemaVersion: 1,
    documentId: "agree",
    blocks: [
      { id: "h", type: "heading", props: { level: 1 }, children: [], content: [{ type: "text", text: "Title", marks: [] }] },
      {
        id: "p",
        type: "paragraph",
        props: {},
        children: [],
        content: [
          { type: "text", text: "Solve ", marks: [] },
          { type: "math", id: "m1", latex: "x^2" },
          { type: "text", text: " first,", marks: ["bold"] },
          { type: "text", text: " see ", marks: [] },
          { type: "pageRef", id: "r1", pageId: "pg1", fallbackTitle: "Roadmap" },
          { type: "link", href: "https://example.com", content: [{ type: "text", text: "the doc", marks: ["italic"] }] },
          { type: "text", text: " line two ", marks: [] },
          { type: "checkbox", id: "c1", checked: false },
          { type: "text", text: " 😀 周五 café", marks: [] },
        ],
      },
      {
        id: "t",
        type: "table",
        props: { headerRows: 0 },
        children: [],
        columns: [{ id: "c1" }],
        rows: [{ id: "r1", cells: [{ id: "x1", content: [{ type: "text", text: "cell", marks: [] }] }] }],
      },
      {
        id: "l",
        type: "numberedListItem",
        props: {},
        content: [{ type: "text", text: "Parent", marks: [] }],
        children: [
          { id: "l2", type: "toggleListItem", props: {}, children: [], content: [{ type: "text", text: "Child", marks: [] }] },
        ],
      },
      { id: "d", type: "divider", props: {}, children: [] },
      { id: "e", type: "paragraph", props: {}, children: [], content: [] },
    ],
  };

  it("reads the same blocks and the same text from NML as from the served ProseMirror mirror", () => {
    const editor = BlockNoteEditor.create({ schema: readerSchema });
    editors.push(editor);
    const doc = createNmlYDoc(nml);
    const mirror = new NmlLegacyMirror(doc, blockNoteNmlMirrorHost(editor, doc), {
      actor: { kind: "human", userId: "reader" },
    }).start();
    const pm = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment("prosemirror"), editor.pmSchema);
    // The fixture is canonical: what the document stores reads the same.
    expect(nmlBlockTexts(decodeNmlDocument(doc))).toEqual(nmlBlockTexts(nml));
    mirror.stop();
    doc.destroy();

    const fromPm = pmBlockTexts(pm).map(({ blockId, text }) => ({ blockId, text }));
    const fromNml = nmlBlockTexts(nml);
    expect(fromPm).toEqual(fromNml);
    expect(fromNml.map((block) => block.blockId)).toEqual(["h", "p", "l", "l2", "e"]);

    // So an anchor minted on the server lands on the same words in the editor.
    const p = fromNml.find((block) => block.blockId === "p")!;
    const from = p.text.indexOf("周五");
    const anchor = mintAnchor(p, from, from + 2)!;
    const r = resolveAnchor({ anchor }, pmBlockTexts(pm));
    expect(r).toMatchObject({ kind: "anchored", stage: 1, blockId: "p", from });
    if (r.kind === "anchored") {
      const range = pmRange(pmBlockTexts(pm), "p", r.from, r.to)!;
      expect(pm.textBetween(range.from, range.to)).toBe("周五");
    }
  });

  it("reads canonical text: NML stores a run of whitespace as one space", () => {
    const doc = createNmlYDoc({
      schemaVersion: 1,
      documentId: "ws",
      blocks: [{ id: "p", type: "paragraph", props: {}, children: [], content: [{ type: "text", text: "a\n\nb  c", marks: [] }] }],
    });
    expect(nmlBlockTexts(decodeNmlDocument(doc))).toEqual([{ blockId: "p", text: "a b c" }]);
    doc.destroy();
  });

  it("refuses to read a comments document as page text", () => {
    expect(() => nmlBlockTexts({ ...nml, kind: "comments", blocks: [] })).toThrow();
  });
});
