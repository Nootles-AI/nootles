import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { parseHTML } from "linkedom";
import type { Node } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import type { DecorationSet } from "prosemirror-view";
import { afterAll, describe, expect, it } from "vitest";
import { readerSchema } from "@/app/lib/ai/readerSchema";
import { MARKER_ATTR, markersPlugin, numberedMarker } from "./listMarkers";

if (!("document" in globalThis)) {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document, window });
}

type Blocks = PartialBlock<
  (typeof readerSchema)["blockSchema"],
  (typeof readerSchema)["inlineContentSchema"],
  (typeof readerSchema)["styleSchema"]
>[];

const editors: Array<{ _tiptapEditor?: { destroy(): void } }> = [];
afterAll(() => editors.forEach((editor) => editor._tiptapEditor?.destroy()));

function stateFor(blocks: Blocks): EditorState {
  const editor = BlockNoteEditor.create({ schema: readerSchema, initialContent: blocks });
  editors.push(editor);
  return EditorState.create({ doc: editor.prosemirrorState.doc, plugins: [markersPlugin()] });
}

/** Block id → the marker drawn for it, for every item that has one. */
function markers(state: EditorState): Record<string, string> {
  const set = state.plugins[0].getState(state) as DecorationSet;
  return Object.fromEntries(
    set.find().map((deco) => [
      state.doc.resolve(deco.from).parent.attrs.id,
      (deco as unknown as { type: { attrs: Record<string, string> } }).type.attrs[MARKER_ATTR],
    ]),
  );
}

/** The position of the start of a block's text. */
function textStart(doc: Node, id: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.type.name === "blockContainer" && node.attrs.id === id) found = pos + 2;
    return found < 0;
  });
  return found;
}

const item = (id: string, children: Blocks = [], start?: number): Blocks[number] => ({
  id,
  type: "numberedListItem",
  props: start ? { start } : {},
  content: id,
  children,
});

const OUTLINE: Blocks = [
  item("1", [
    item("1a", [item("1ai", [item("1ai1")]), item("1aii")]),
    item("1b"),
    item("1c"),
  ]),
  item("2"),
];

describe("numberedMarker", () => {
  it("cycles decimal, letters, numerals by depth", () => {
    expect(numberedMarker(3, 0)).toBeNull();
    expect(numberedMarker(3, 1)).toBe("c");
    expect(numberedMarker(4, 2)).toBe("iv");
    expect(numberedMarker(2, 3)).toBeNull();
    expect(numberedMarker(9, 5)).toBe("ix");
  });

  it("counts past z the way lower-alpha does", () => {
    expect(numberedMarker(26, 1)).toBe("z");
    expect(numberedMarker(27, 1)).toBe("aa");
    expect(numberedMarker(53, 1)).toBe("ba");
  });
});

describe("nested numbered markers", () => {
  it("draws a. under 1. and i. under a., then 1. again", () => {
    expect(markers(stateFor(OUTLINE))).toEqual({
      "1a": "a",
      "1ai": "i",
      "1aii": "ii",
      "1b": "b",
      "1c": "c",
    });
  });

  it("starts a nested run where its first item says", () => {
    const state = stateFor([
      item("1", [item("x", [], 4), item("y")]),
    ]);
    expect(markers(state)).toEqual({ x: "d", y: "e" });
  });

  it("counts only numbered ancestors", () => {
    const state = stateFor([
      { id: "b", type: "bulletListItem", content: "b", children: [item("n", [item("m")])] },
    ]);
    expect(markers(state)).toEqual({ m: "a" });
  });

  it("renumbers after an item is deleted", () => {
    const state = stateFor(OUTLINE);
    const $b = state.doc.resolve(textStart(state.doc, "1b"));
    const container = $b.before($b.depth - 1);
    const next = state.apply(state.tr.delete(container, $b.after($b.depth - 1)));
    expect(markers(next)).toMatchObject({ "1c": "b" });
    expect(markers(next)).not.toHaveProperty("1b");
  });

  it("renumbers after a deletion that joins two items", () => {
    const state = stateFor(OUTLINE);
    // From inside "1b" to inside "1c": what is left is one item, "1" + "c".
    const from = textStart(state.doc, "1b") + 1;
    const to = textStart(state.doc, "1c") + 1;
    const next = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, from, to)).deleteSelection(),
    );
    expect(Object.values(markers(next))).toEqual(["a", "i", "ii", "b"]);
  });

  it("keeps every marker while words are typed", () => {
    const state = stateFor(OUTLINE);
    const next = state.apply(state.tr.insertText("typed", textStart(state.doc, "1ai")));
    expect(markers(next)).toEqual(markers(state));
  });

  it("draws markers for a list that becomes nested", () => {
    const state = stateFor([item("1"), item("2")]);
    const $two = state.doc.resolve(textStart(state.doc, "2"));
    const two = state.doc.nodeAt($two.before($two.depth - 1))!;
    const tr = state.tr.delete($two.before($two.depth - 1), $two.after($two.depth - 1));
    const $one = tr.doc.resolve(textStart(tr.doc, "1"));
    const oneEnd = $one.after($one.depth - 1) - 1;
    tr.insert(oneEnd, state.schema.nodes.blockGroup.create(null, two));
    expect(markers(state.apply(tr))).toEqual({ "2": "a" });
  });
});
