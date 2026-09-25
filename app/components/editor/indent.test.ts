import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { parseHTML } from "linkedom";
import type { Node } from "prosemirror-model";
import { EditorState, NodeSelection, TextSelection, type Selection } from "prosemirror-state";
import { afterAll, describe, expect, it } from "vitest";
import { readerSchema } from "@/app/lib/ai/readerSchema";
import { BlockRangeSelection, blockRangeFor } from "./blockSelection";
import { indentSelection, type IndentDirection } from "./indent";

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

const p = (id: string, children: Blocks = []): Blocks[number] => ({
  id,
  type: "paragraph",
  content: id,
  children,
});

function docOf(blocks: Blocks): Node {
  const editor = BlockNoteEditor.create({ schema: readerSchema, initialContent: blocks });
  editors.push(editor);
  return editor.prosemirrorState.doc;
}

/** `a b(c d)`: block ids in order, children in parentheses. */
function outline(doc: Node): string {
  const walk = (group: Node): string =>
    Array.from({ length: group.childCount }, (_, i) => {
      const block = group.child(i);
      const children = block.childCount > 1 ? `(${walk(block.lastChild!)})` : "";
      return `${block.attrs.id}${children}`;
    }).join(" ");
  return walk(doc.firstChild!);
}

/** The position of character `offset` inside block `id`'s text. */
function at(doc: Node, id: string, offset = 0): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.attrs.id === id) found = pos + 2 + offset;
    return true;
  });
  if (found < 0) throw new Error(`no block ${id}`);
  return found;
}

function press(doc: Node, selection: Selection, direction: IndentDirection) {
  const state = EditorState.create({ doc, selection });
  const tr = state.tr;
  const changed = indentSelection(tr, direction);
  return { changed, doc: tr.doc, selection: tr.selection, outline: outline(tr.doc) };
}

const caret = (doc: Node, id: string, offset = 0) => TextSelection.create(doc, at(doc, id, offset));
const span = (doc: Node, from: string, to: string, toOffset = 1) =>
  TextSelection.create(doc, at(doc, from), at(doc, to, toOffset));

describe("Tab on a caret", () => {
  it("nests the block under the one before it", () => {
    const doc = docOf([p("a"), p("b"), p("c")]);
    const result = press(doc, caret(doc, "b"), "in");
    expect(result.changed).toBe(true);
    expect(result.outline).toBe("a(b) c");
  });

  it("joins the children the block before already has, and takes its own along", () => {
    const doc = docOf([p("a", [p("x")]), p("b", [p("y")])]);
    expect(press(doc, caret(doc, "b"), "in").outline).toBe("a(x b(y))");
  });

  it("changes nothing on the first block, or a first child", () => {
    const doc = docOf([p("a", [p("x")]), p("b")]);
    expect(press(doc, caret(doc, "a"), "in").changed).toBe(false);
    expect(press(doc, caret(doc, "x"), "in").changed).toBe(false);
  });

  it("touches only the nested block the caret is in, never its parent", () => {
    const doc = docOf([p("a", [p("x"), p("y")])]);
    expect(press(doc, caret(doc, "y"), "in").outline).toBe("a(x(y))");
  });
});

describe("Shift+Tab on a caret", () => {
  it("changes nothing at the top level", () => {
    const doc = docOf([p("a"), p("b")]);
    expect(press(doc, caret(doc, "b"), "out").changed).toBe(false);
  });

  it("steps out after its parent, adopting the siblings below it", () => {
    const doc = docOf([p("a", [p("x"), p("y"), p("z")]), p("b")]);
    expect(press(doc, caret(doc, "y"), "out").outline).toBe("a(x) y(z) b");
  });
});

describe("a text selection across blocks", () => {
  it("indents every block it touches and keeps the selection", () => {
    const doc = docOf([p("a"), p("b"), p("c"), p("d")]);
    const selection = span(doc, "b", "c");
    const result = press(doc, selection, "in");
    expect(result.outline).toBe("a(b c) d");
    expect(result.doc.textBetween(result.selection.from, result.selection.to, "\n")).toBe(
      doc.textBetween(selection.from, selection.to, "\n"),
    );
  });

  it("outdents every block it touches", () => {
    const doc = docOf([p("a", [p("x"), p("y")]), p("b")]);
    expect(press(doc, span(doc, "x", "y"), "out").outline).toBe("a x y b");
  });

  it("moves each run of siblings at its own depth", () => {
    const doc = docOf([p("a", [p("x"), p("y")]), p("b")]);
    // From inside a's second child to b: y and b move; a, only reached
    // through its child, stays.
    expect(press(doc, span(doc, "y", "b"), "in").outline).toBe("a(x(y) b)");
  });

  it("leaves a run that cannot move and moves the rest", () => {
    const doc = docOf([p("a", [p("x")]), p("b")]);
    // x is a first child with nothing to nest under; b can go under a.
    expect(press(doc, span(doc, "x", "b"), "in").outline).toBe("a(x b)");
  });

  it("does not count a block it only reaches the very start of", () => {
    const doc = docOf([p("a"), p("b"), p("c")]);
    const selection = TextSelection.create(doc, at(doc, "b"), at(doc, "c"));
    expect(press(doc, selection, "in").outline).toBe("a(b) c");
  });
});

describe("a block selection", () => {
  it("indents the selected blocks and stays selected", () => {
    const doc = docOf([p("a"), p("b"), p("c"), p("d")]);
    const result = press(doc, blockRangeFor(doc, ["b", "c"])!, "in");
    expect(result.outline).toBe("a(b c) d");
    expect(result.selection).toBeInstanceOf(BlockRangeSelection);
    expect((result.selection as BlockRangeSelection).blockIds).toEqual(["b", "c"]);
  });

  it("outdents the selected blocks and stays selected", () => {
    const doc = docOf([p("a", [p("x"), p("y")])]);
    const result = press(doc, blockRangeFor(doc, ["x", "y"])!, "out");
    expect(result.outline).toBe("a x y");
    expect((result.selection as BlockRangeSelection).blockIds).toEqual(["x", "y"]);
  });

  it("changes nothing when the first selected block has nothing above it", () => {
    const doc = docOf([p("a"), p("b")]);
    expect(press(doc, blockRangeFor(doc, ["a", "b"])!, "in").changed).toBe(false);
  });
});

describe("a content-less block", () => {
  it("indents when it is the selected node", () => {
    const doc = docOf([p("a"), { id: "d", type: "canvas" }]);
    let content = -1;
    doc.descendants((node, pos) => {
      if (node.type.name === "canvas") content = pos;
      return content < 0;
    });
    expect(press(doc, NodeSelection.create(doc, content), "in").outline).toBe("a(d)");
  });
});
