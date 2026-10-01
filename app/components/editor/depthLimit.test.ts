import { BlockNoteEditor, docToBlocks, type PartialBlock } from "@blocknote/core";
import { parseHTML } from "linkedom";
import { Fragment, Slice, type Node } from "prosemirror-model";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { ySyncPluginKey } from "y-prosemirror";
import { afterAll, describe, expect, it } from "vitest";
import { readerSchema } from "@/app/lib/ai/readerSchema";
import { convertLegacyDocument, type LegacyBlock } from "@/app/lib/nml/legacy";
import { depthLimitPlugin } from "./depthLimit";
import { indentSelection } from "./indent";

if (!("document" in globalThis)) {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document, window });
}

const editors: BlockNoteEditor<typeof readerSchema.blockSchema, typeof readerSchema.inlineContentSchema, typeof readerSchema.styleSchema>[] = [];
afterAll(() => editors.forEach((editor) => editor._tiptapEditor?.destroy()));

type Blocks = PartialBlock<
  (typeof readerSchema)["blockSchema"],
  (typeof readerSchema)["inlineContentSchema"],
  (typeof readerSchema)["styleSchema"]
>[];

const li = (id: string, children: Blocks = []): Blocks[number] => ({ id, type: "bulletListItem", content: id, children });
const p = (id: string, children: Blocks = []): Blocks[number] => ({ id, type: "paragraph", content: id, children });

/** Four levels of bullets: a(b(c(d))) then whatever `last` holds beside d. */
const fourDeep = (...beside: Blocks) => [li("a", [li("b", [li("c", [li("d"), ...beside])])]), p("tail")];

function editorOf(blocks: Blocks) {
  const editor = BlockNoteEditor.create({ schema: readerSchema, initialContent: blocks });
  editors.push(editor);
  return editor;
}
const docOf = (blocks: Blocks): Node => editorOf(blocks).prosemirrorState.doc;

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

function blockPos(doc: Node, id: string): number {
  return at(doc, id) - 2;
}

function tab(doc: Node, from: string, to = from) {
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, at(doc, from), at(doc, to, 1)) });
  const tr = state.tr;
  return { changed: indentSelection(tr, "in"), outline: outline(tr.doc) };
}

/** Dispatches `edit` through the plugin; the result includes anything it appended. */
function dispatch(doc: Node, edit: (state: EditorState) => Transaction, selection?: (doc: Node) => TextSelection) {
  const state = EditorState.create({ doc, plugins: [depthLimitPlugin(() => true)], selection: selection?.(doc) });
  const { state: next, transactions } = state.applyTransaction(edit(state));
  return { doc: next.doc, outline: outline(next.doc), selection: next.selection, transactions };
}

/** What converting `doc` to canonical NML, as the mirror does, refuses. */
function nmlErrors(doc: Node): string[] {
  const blocks = docToBlocks(doc) as unknown as LegacyBlock[];
  return convertLegacyDocument({ documentId: "d", blocks }, { createId: () => crypto.randomUUID() })
    .diagnostics.filter((issue) => issue.severity === "error").map((issue) => issue.code);
}

describe("Tab at NML's four levels (NT-127)", () => {
  it("leaves a fourth-level item where it is", () => {
    const doc = docOf(fourDeep(li("e")));
    expect(tab(doc, "e")).toEqual({ changed: false, outline: "a(b(c(d e))) tail" });
  });

  it("leaves a third-level item whose child would go fifth, and nests one without", () => {
    const doc = docOf([li("a", [li("b", [li("c"), li("c2", [li("d")])])]), li("free")]);
    expect(tab(doc, "c2")).toEqual({ changed: false, outline: "a(b(c c2(d))) free" });
    expect(tab(doc, "d")).toEqual({ changed: false, outline: "a(b(c c2(d))) free" });
    const shallow = docOf([li("a", [li("b", [li("c"), li("c2")])])]);
    expect(tab(shallow, "c2")).toEqual({ changed: true, outline: "a(b(c(c2)))" });
  });

  it("still nests under a line, which NML gives no level of its own", () => {
    const doc = docOf(fourDeep(p("line"), li("e")));
    expect(tab(doc, "e")).toEqual({ changed: true, outline: "a(b(c(d line(e)))) tail" });
  });

  it("moves the runs that fit and keeps the one that doesn't", () => {
    const doc = docOf([li("a", [li("b", [li("c", [li("d"), li("e")])])]), li("x"), li("y")]);
    // e (fourth level) through y: e's run stays, x..y's run nests under a.
    expect(tab(doc, "e", "y")).toEqual({ changed: true, outline: "a(b(c(d e)) x y)" });
  });
});

describe("the depth limit on any other edit (NT-127)", () => {
  /** `blocks` as content of `state`'s schema; every editor builds its own. */
  const nodes = (state: EditorState, blocks: Blocks) =>
    Fragment.fromJSON(state.schema, docOf(blocks).firstChild!.content.toJSON());
  /** A pasted three-level list, as the clipboard parser hands it over. */
  const pasted = (state: EditorState) => nodes(state, [li("h1", [li("h2", [li("h3")]), li("h2b")])]);

  it("brings a paste below the fourth level back to it, in order, with the caret where it was", () => {
    const doc = docOf(fourDeep());
    const result = dispatch(doc, (state) => {
      const end = blockPos(state.doc, "d") + state.doc.nodeAt(blockPos(state.doc, "d"))!.nodeSize;
      const tr = state.tr.replace(end, end, new Slice(pasted(state), 0, 0));
      return tr.setSelection(TextSelection.create(tr.doc, at(tr.doc, "h2b", 3)));
    });
    expect(result.outline).toBe("a(b(c(d h1 h2 h3 h2b))) tail");
    expect(result.selection.head).toBe(at(result.doc, "h2b", 3));
    expect(result.transactions).toHaveLength(2);
    expect(nmlErrors(result.doc)).toEqual([]);
  });

  it("flattens the children of a line made a list item at the fourth level", () => {
    const doc = docOf(fourDeep(p("line", [p("q", [li("r")])])));
    const result = dispatch(doc, (state) => {
      const pos = blockPos(state.doc, "line");
      return state.tr.setNodeMarkup(pos + 1, state.schema.nodes.bulletListItem);
    });
    expect(result.outline).toBe("a(b(c(d line q r))) tail");
    expect(nmlErrors(result.doc)).toEqual([]);
  });

  it("leaves a document within the limit alone", () => {
    const doc = docOf(fourDeep());
    const result = dispatch(doc, (state) => {
      const end = blockPos(state.doc, "c");
      return state.tr.insert(end, nodes(state, [li("n", [li("m")])]));
    });
    expect(result.outline).toBe("a(b(n(m) c(d))) tail");
    expect(result.transactions).toHaveLength(1);
  });

  it("never repairs a remote edit, which every client would repair at once", () => {
    const doc = docOf(fourDeep());
    const result = dispatch(doc, (state) => {
      const end = blockPos(state.doc, "d") + state.doc.nodeAt(blockPos(state.doc, "d"))!.nodeSize;
      return state.tr.insert(end, pasted(state)).setMeta(ySyncPluginKey, { isChangeOrigin: true });
    });
    expect(result.outline).toBe("a(b(c(d h1(h2(h3) h2b)))) tail");
    expect(result.transactions).toHaveLength(1);
  });

  it("leaves deeper nesting from before the limit alone until an edit reaches it", () => {
    const deep = [li("a", [li("b", [li("c", [li("d", [li("old")])])])]), p("tail")];
    const typed = dispatch(docOf(deep), (state) => state.tr.insertText("!", at(state.doc, "old", 3)));
    expect(typed.outline).toBe("a(b(c(d(old)))) tail");
    const elsewhere = dispatch(docOf(deep), (state) =>
      state.tr.insert(blockPos(state.doc, "tail"), nodes(state, [li("n", [li("m")])])));
    expect(elsewhere.outline).toBe("a(b(c(d(old)))) n(m) tail");
    const beside = dispatch(docOf(deep), (state) =>
      state.tr.insert(blockPos(state.doc, "d") + state.doc.nodeAt(blockPos(state.doc, "d"))!.nodeSize, nodes(state, [li("n")])));
    expect(beside.outline).toBe("a(b(c(d(old) n))) tail");
    const reached = dispatch(docOf(deep), (state) =>
      state.tr.split(at(state.doc, "old", 1), 2));
    expect(reached.outline).not.toContain("d(");
  });
});
