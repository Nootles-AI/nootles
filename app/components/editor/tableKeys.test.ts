import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { parseHTML } from "linkedom";
import { EditorState, Selection, TextSelection, type Transaction } from "prosemirror-state";
import { afterAll, describe, expect, it } from "vitest";
import { appendRowFromLastCell, caretIntoTableAbove } from "./tableKeys";

if (!("document" in globalThis)) {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document, window });
}

const editors: BlockNoteEditor[] = [];
afterAll(() => editors.forEach((editor) => editor._tiptapEditor?.destroy()));

const TABLE: PartialBlock = {
  id: "t",
  type: "table",
  content: {
    type: "tableContent",
    rows: [{ cells: ["a", "b"] }, { cells: ["c", "d"] }],
  },
};

function stateFor(blocks: PartialBlock[]): EditorState {
  const editor = BlockNoteEditor.create({ initialContent: blocks });
  editors.push(editor);
  return editor.prosemirrorState;
}

/** The caret at the end (or start) of the text `text`, wherever it is. */
function caretAt(state: EditorState, text: string, at: "start" | "end" = "end"): EditorState {
  let pos = -1;
  state.doc.descendants((node, p) => {
    if (pos < 0 && node.isText && node.text === text) pos = at === "end" ? p + node.nodeSize : p;
    return pos < 0;
  });
  if (pos < 0) throw new Error(`no text ${text}`);
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
}

function run(state: EditorState, command: typeof appendRowFromLastCell) {
  let tr: Transaction | undefined;
  const handled = command(state, (t) => (tr = t));
  return { handled, next: tr ? state.apply(tr) : state };
}

function rows(state: EditorState): string[][] {
  const out: string[][] = [];
  state.doc.descendants((node) => {
    if (node.type.name === "tableRow") {
      const cells: string[] = [];
      node.forEach((cell) => cells.push(cell.textContent));
      out.push(cells);
      return false;
    }
    return true;
  });
  return out;
}

/** The text of the cell the caret is in, and which row/column that is. */
function caretCell(state: EditorState) {
  const $head = state.selection.$head;
  for (let d = $head.depth; d > 0; d--) {
    if ($head.node(d).type.name === "tableRow") {
      return { row: $head.index(d - 1), col: $head.index(d), text: $head.node(d + 1).textContent };
    }
  }
  return null;
}

describe("Tab in a table", () => {
  it("appends a row from the last cell and puts the caret in its first cell", () => {
    const { handled, next } = run(caretAt(stateFor([TABLE]), "d"), appendRowFromLastCell);
    expect(handled).toBe(true);
    expect(rows(next)).toEqual([["a", "b"], ["c", "d"], ["", ""]]);
    expect(next.selection).toBeInstanceOf(TextSelection);
    expect(caretCell(next)).toEqual({ row: 2, col: 0, text: "" });
  });

  it("leaves every other cell to BlockNote's own Tab", () => {
    const state = caretAt(stateFor([TABLE]), "c");
    expect(run(state, appendRowFromLastCell)).toEqual({ handled: false, next: state });
  });

  it("does nothing outside a table", () => {
    const state = caretAt(stateFor([{ type: "paragraph", content: "x" }]), "x");
    expect(run(state, appendRowFromLastCell).handled).toBe(false);
  });
});

describe("Backspace below a table", () => {
  const page: PartialBlock[] = [TABLE, { type: "paragraph", content: "after" }];

  it("steps into the table's last cell without changing the document", () => {
    const state = caretAt(stateFor(page), "after", "start");
    const { handled, next } = run(state, caretIntoTableAbove);
    expect(handled).toBe(true);
    expect(next.doc.eq(state.doc)).toBe(true);
    expect(caretCell(next)).toEqual({ row: 1, col: 1, text: "d" });
    expect(next.selection.$head.parentOffset).toBe(1);
  });

  it("leaves the empty line to BlockNote, which removes it on the way up", () => {
    const state = stateFor([TABLE, { type: "paragraph" }]);
    const end = state.apply(state.tr.setSelection(Selection.atEnd(state.doc)));
    expect(run(end, caretIntoTableAbove).handled).toBe(false);
  });

  it("only fires at the start of the line", () => {
    const state = caretAt(stateFor(page), "after");
    expect(run(state, caretIntoTableAbove).handled).toBe(false);
  });

  it("leaves a heading to revert to a paragraph first", () => {
    const state = caretAt(
      stateFor([TABLE, { type: "heading", content: "after" }]),
      "after",
      "start",
    );
    expect(run(state, caretIntoTableAbove).handled).toBe(false);
  });

  it("ignores a line whose neighbour above is not a table", () => {
    const state = caretAt(
      stateFor([{ type: "paragraph", content: "above" }, { type: "paragraph", content: "after" }]),
      "after",
      "start",
    );
    expect(run(state, caretIntoTableAbove).handled).toBe(false);
  });
});
