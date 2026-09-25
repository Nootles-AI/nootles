import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { parseHTML } from "linkedom";
import type { Node as PMNode } from "prosemirror-model";
import {
  NodeSelection,
  TextSelection,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import { afterAll, describe, expect, it } from "vitest";
import { dashesToDivider, typeBelowDivider } from "./divider";

if (!("document" in globalThis)) {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document, window });
}

const editors: BlockNoteEditor[] = [];
afterAll(() => editors.forEach((editor) => editor._tiptapEditor?.destroy()));

function stateOf(blocks: PartialBlock[]): EditorState {
  const editor = BlockNoteEditor.create({ initialContent: blocks });
  editors.push(editor);
  return editor.prosemirrorState;
}

function posOf(doc: PMNode, id: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.attrs.id === id) found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error(`no block ${id}`);
  return found;
}

/** Each block as `type:text`, in reading order, nested ones included. */
function outline(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.type.isInGroup("blockContent")) {
      out.push(`${node.type.name}:${node.textContent}`);
    }
    return true;
  });
  return out;
}

/** The dashes' range inside `id`'s text, as the input rule reports it. */
function dashes(state: EditorState, id: string) {
  const start = posOf(state.doc, id) + 2;
  return { start, end: start + 3 };
}

function caretBlock(tr: Transaction): string {
  const { $from, empty } = tr.selection;
  expect(empty).toBe(true);
  return `${$from.parent.type.name}:${$from.parent.textContent}`;
}

describe("dashesToDivider", () => {
  it("turns the block into a divider and puts the caret in a new line below", () => {
    const state = stateOf([
      { id: "a", type: "paragraph", content: "---" },
      { id: "b", type: "paragraph", content: "after" },
    ]);
    const { start, end } = dashes(state, "a");
    const tr = dashesToDivider(state, start, end)!;
    expect(outline(tr.doc)).toEqual(["divider:", "paragraph:", "paragraph:after"]);
    expect(caretBlock(tr)).toBe("paragraph:");
    // The divider keeps the block's identity.
    expect(tr.doc.nodeAt(posOf(tr.doc, "a"))!.firstChild!.type.name).toBe("divider");
  });

  it("reuses an empty paragraph already below", () => {
    const state = stateOf([
      { id: "a", type: "paragraph", content: "---" },
      { id: "b", type: "paragraph" },
    ]);
    const { start, end } = dashes(state, "a");
    const tr = dashesToDivider(state, start, end)!;
    expect(outline(tr.doc)).toEqual(["divider:", "paragraph:"]);
    expect(tr.selection.from).toBe(posOf(tr.doc, "b") + 2);
  });

  it("lands in the divider's first nested block", () => {
    const state = stateOf([
      {
        id: "a",
        type: "paragraph",
        content: "---",
        children: [{ id: "c", type: "paragraph", content: "child" }],
      },
    ]);
    const { start, end } = dashes(state, "a");
    const tr = dashesToDivider(state, start, end)!;
    expect(outline(tr.doc)).toEqual(["divider:", "paragraph:", "paragraph:child"]);
    expect(caretBlock(tr)).toBe("paragraph:");
    expect(tr.doc.resolve(tr.selection.from).depth).toBeGreaterThan(
      tr.doc.resolve(posOf(tr.doc, "a") + 2).depth,
    );
  });

  it("declines when text follows the dashes", () => {
    const state = stateOf([{ id: "a", type: "paragraph", content: "---kept" }]);
    const { start, end } = dashes(state, "a");
    expect(dashesToDivider(state, start, end)).toBeNull();
  });
});

describe("typeBelowDivider", () => {
  function selectDivider(state: EditorState, id: string): EditorState {
    const divider = posOf(state.doc, id) + 1;
    return state.apply(state.tr.setSelection(NodeSelection.create(state.doc, divider)));
  }

  it("writes the keystroke on a new line below the divider", () => {
    const state = selectDivider(
      stateOf([
        { id: "a", type: "divider" },
        { id: "b", type: "paragraph", content: "after" },
      ]),
      "a",
    );
    const tr = typeBelowDivider(state, "x")!;
    expect(outline(tr.doc)).toEqual(["divider:", "paragraph:x", "paragraph:after"]);
    expect(caretBlock(tr)).toBe("paragraph:x");
    expect(tr.selection.$from.parentOffset).toBe(1);
  });

  it("writes into an empty paragraph below instead of making another", () => {
    const state = selectDivider(
      stateOf([
        { id: "a", type: "divider" },
        { id: "b", type: "paragraph" },
      ]),
      "a",
    );
    const tr = typeBelowDivider(state, "x")!;
    expect(outline(tr.doc)).toEqual(["divider:", "paragraph:x"]);
  });

  it("leaves other selections to ProseMirror", () => {
    const initial = stateOf([
      { id: "a", type: "divider" },
      { id: "b", type: "paragraph", content: "after" },
    ]);
    const caret = TextSelection.create(initial.doc, posOf(initial.doc, "b") + 2);
    const state = initial.apply(initial.tr.setSelection(caret));
    expect(typeBelowDivider(state, "x")).toBeNull();
  });
});
