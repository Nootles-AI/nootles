import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { parseHTML } from "linkedom";
import { Selection, TextSelection, type EditorState, type Transaction } from "prosemirror-state";
import { afterAll, describe, expect, it } from "vitest";
import { dropEmptyFirstBlock, enterBody, splitTitle } from "./titleBoundary";

if (!("document" in globalThis)) {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document, window });
}

const editors: BlockNoteEditor[] = [];
afterAll(() => editors.forEach((editor) => editor._tiptapEditor?.destroy()));

function editorFor(blocks: PartialBlock[]) {
  const editor = BlockNoteEditor.create({ initialContent: blocks });
  editors.push(editor);
  return editor;
}

const texts = (editor: BlockNoteEditor) =>
  editor.document.map((block) => [
    block.type,
    (block.content as { text?: string }[]).map((run) => run.text ?? "").join(""),
  ]);

describe("Enter in the title", () => {
  it("opens a new first paragraph above what the page already says", () => {
    const editor = editorFor([{ type: "heading", content: "Plan" }]);
    enterBody(editor, "");
    expect(texts(editor)).toEqual([["paragraph", ""], ["heading", "Plan"]]);
    expect(editor.getTextCursorPosition().block.id).toBe(editor.document[0].id);
  });

  it("carries the text after the caret into that paragraph", () => {
    const editor = editorFor([{ type: "paragraph", content: "Body" }]);
    enterBody(editor, "tail of the title");
    expect(texts(editor)).toEqual([["paragraph", "tail of the title"], ["paragraph", "Body"]]);
    const caret = editor.prosemirrorState.selection;
    expect(caret.empty && caret.$head.parentOffset).toBe(0);
    expect(editor.getTextCursorPosition().block.id).toBe(editor.document[0].id);
  });

  it("writes into a page that is only its one empty line", () => {
    const editor = editorFor([{ type: "paragraph" }]);
    const only = editor.document[0].id;
    enterBody(editor, "moved");
    expect(texts(editor)).toEqual([["paragraph", "moved"]]);
    expect(editor.document[0].id).toBe(only);
  });

  it("opens a fresh block above a leading blank line", () => {
    const editor = editorFor([{ type: "paragraph" }, { type: "paragraph", content: "Body" }]);
    enterBody(editor, "");
    expect(texts(editor)).toEqual([["paragraph", ""], ["paragraph", ""], ["paragraph", "Body"]]);
    expect(editor.getTextCursorPosition().block.id).toBe(editor.document[0].id);
  });

  it("commits the title before the document changes, so undo reads the split back in order", () => {
    const editor = editorFor([{ type: "paragraph", content: "Body" }]);
    const seen: unknown[] = [];
    splitTitle(editor, "Launch plan", { start: 7, end: 7 }, (title) =>
      seen.push([title, texts(editor)]),
    );
    expect(seen).toEqual([["Launch ", [["paragraph", "Body"]]]]);
    expect(texts(editor)).toEqual([["paragraph", "plan"], ["paragraph", "Body"]]);
  });

  it("drops a selection in the title, carrying only what followed it", () => {
    const editor = editorFor([{ type: "paragraph", content: "Body" }]);
    const seen: string[] = [];
    splitTitle(editor, "Launch big plan", { start: 7, end: 11 }, (title) => seen.push(title));
    expect(seen).toEqual(["Launch "]);
    expect(texts(editor)[0]).toEqual(["paragraph", "plan"]);
  });
});

describe("Backspace at the top of the page", () => {
  function run(state: EditorState) {
    let tr: Transaction | undefined;
    const handled = dropEmptyFirstBlock(state, (t) => (tr = t));
    return { handled, next: tr ? state.apply(tr) : state };
  }
  const at = (editor: BlockNoteEditor, pos: number) => {
    const state = editor.prosemirrorState;
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
  };
  // doc(0) › blockGroup(1) › blockContainer(2) › paragraph(3): the first
  // block's text starts at 3.
  const FIRST = 3;

  it("removes an empty first paragraph", () => {
    const editor = editorFor([{ type: "paragraph" }, { type: "paragraph", content: "Body" }]);
    const { handled, next } = run(at(editor, FIRST));
    expect(handled).toBe(true);
    expect(next.doc.firstChild?.childCount).toBe(1);
    expect(next.doc.textContent).toBe("Body");
  });

  it("keeps the page's only line but still hands the caret up", () => {
    const editor = editorFor([{ type: "paragraph" }]);
    const state = at(editor, FIRST);
    const { handled, next } = run(state);
    expect(handled).toBe(true);
    expect(next.doc.eq(state.doc)).toBe(true);
  });

  it("leaves a written first line, and an empty line further down, alone", () => {
    const written = editorFor([{ type: "paragraph", content: "Hi" }]);
    expect(run(at(written, FIRST)).handled).toBe(false);
    const lower = editorFor([{ type: "paragraph", content: "Hi" }, { type: "paragraph" }]);
    const end = Selection.atEnd(lower.prosemirrorState.doc);
    expect(end.$head.parent.content.size).toBe(0);
    expect(run(at(lower, end.head)).handled).toBe(false);
  });

  it("leaves an empty first heading to become a paragraph first", () => {
    const editor = editorFor([{ type: "heading" }, { type: "paragraph", content: "Body" }]);
    expect(run(at(editor, FIRST)).handled).toBe(false);
  });
});
