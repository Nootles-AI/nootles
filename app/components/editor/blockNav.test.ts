import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { parseHTML } from "linkedom";
import type { Node } from "prosemirror-model";
import { afterAll, describe, expect, it } from "vitest";
import { readerSchema } from "@/app/lib/ai/readerSchema";
import {
  blockAt,
  blockBeside,
  blockPosById,
  blocksInReadingOrder,
  blocksTouched,
  caretBesidePlate,
  ownTextRange,
} from "./blockNav";

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

function pmDoc(blocks: Blocks): Node {
  const editor = BlockNoteEditor.create({ schema: readerSchema, initialContent: blocks });
  editors.push(editor);
  return editor.prosemirrorState.doc;
}

const doc = pmDoc([
  { id: "a", type: "paragraph", content: "Alpha" },
  {
    id: "b",
    type: "paragraph",
    content: "Bravo",
    children: [{ id: "b1", type: "bulletListItem", content: "Child" }],
  },
  { id: "d", type: "divider" },
  { id: "c", type: "codeBlock", props: { code: "x = 1" } },
  { id: "e", type: "paragraph", content: "Echo" },
]);

const order = blocksInReadingOrder(doc);
const spot = (id: string) => order.find((s) => s.id === id)!;
const ids = (list: readonly { id: string }[]) => list.map((s) => s.id);

describe("blocksInReadingOrder", () => {
  it("lists parents before their children, as the page reads", () => {
    // BlockNote keeps an empty paragraph at the end of every page.
    expect(ids(order).slice(0, 6)).toEqual(["a", "b", "b1", "d", "c", "e"]);
  });

  it("drops a hidden block together with everything inside it", () => {
    const folded = blocksInReadingOrder(doc, (pos) => pos !== spot("b").pos);
    expect(ids(folded).slice(0, 4)).toEqual(["a", "d", "c", "e"]);
  });
});

describe("blockBeside", () => {
  it("steps down past the children a selected parent already covers", () => {
    const b = spot("b");
    expect(blockBeside(order, b.pos, b.end, 1)?.id).toBe("d");
  });

  it("steps up onto the block just above on screen, even a nested one", () => {
    const d = spot("d");
    expect(blockBeside(order, d.pos, d.end, -1)?.id).toBe("b1");
  });

  it("has nothing past either end of the page", () => {
    const a = spot("a");
    expect(blockBeside(order, a.pos, a.end, -1)).toBeNull();
    const last = order[order.length - 1];
    expect(blockBeside(order, last.pos, last.end, 1)).toBeNull();
  });
});

describe("blocksTouched", () => {
  const inText = (id: string, offset: number) => ownTextRange(doc, spot(id).pos)!.start + offset;

  it("is the one block a caret sits in", () => {
    expect(blocksTouched(doc, inText("a", 2), inText("a", 2))).toEqual(["a"]);
  });

  it("is the innermost block, not its parent", () => {
    expect(blocksTouched(doc, inText("b1", 1), inText("b1", 3))).toEqual(["b1"]);
  });

  it("is both ends of a selection that runs across blocks", () => {
    expect(blocksTouched(doc, inText("a", 1), inText("e", 2))).toEqual(["a", "e"]);
  });

  it("finds a block from the position just before it", () => {
    expect(blockAt(doc, spot("c").pos)?.id).toBe("c");
  });
});

describe("ownTextRange", () => {
  it("spans a block's own words and not its children's", () => {
    const range = ownTextRange(doc, spot("b").pos)!;
    expect(doc.textBetween(range.start, range.end)).toBe("Bravo");
  });

  it("is null for a block with no text of its own", () => {
    expect(ownTextRange(doc, spot("c").pos)).toBeNull();
    expect(ownTextRange(doc, spot("d").pos)).toBeNull();
  });
});

describe("blockPosById", () => {
  it("finds nested blocks, and says when there is none", () => {
    expect(blockPosById(doc, "b1")).toBe(spot("b1").pos);
    expect(blockPosById(doc, "nope")).toBe(-1);
  });
});

describe("caretBesidePlate", () => {
  const page = pmDoc([
    { id: "above", type: "paragraph", content: "Above" },
    { id: "pic", type: "canvas" },
    { id: "below", type: "paragraph", content: "Below" },
    { id: "code", type: "codeBlock", props: { code: "x" } },
    { id: "after", type: "paragraph", content: "After" },
  ]);
  const reading = blocksInReadingOrder(page);
  const at = (id: string) => reading.find((s) => s.id === id)!;

  it("steps off a void block into the text below, at its start", () => {
    expect(caretBesidePlate(page, reading, [at("pic").pos], 1)).toBe(ownTextRange(page, at("below").pos)!.start);
  });

  it("and into the text above, at its end", () => {
    expect(caretBesidePlate(page, reading, [at("pic").pos], -1)).toBe(ownTextRange(page, at("above").pos)!.end);
  });

  it("leaves a text block's plate stepping plate to plate", () => {
    expect(caretBesidePlate(page, reading, [at("above").pos], 1)).toBeNull();
  });

  it("leaves a code block to its own keys", () => {
    expect(caretBesidePlate(page, reading, [at("code").pos], 1)).toBeNull();
  });

  it("only ever for one block", () => {
    expect(caretBesidePlate(page, reading, [at("pic").pos, at("below").pos], 1)).toBeNull();
  });

  it("stays put where the block beside has no text", () => {
    expect(caretBesidePlate(page, reading, [at("below").pos], 1)).toBeNull();
    expect(caretBesidePlate(page, reading, [at("code").pos], -1)).toBeNull();
  });
});
