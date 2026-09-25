import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { parseHTML } from "linkedom";
import { Selection, type EditorState } from "prosemirror-state";
import { afterAll, describe, expect, it } from "vitest";
import { opensPageLink } from "./pageLinkTrigger";

if (!("document" in globalThis)) {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document, window });
}

const editors: BlockNoteEditor[] = [];
afterAll(() => editors.forEach((editor) => editor._tiptapEditor?.destroy()));

/** The state with the caret at the end of the first block's text. */
function stateAfter(blocks: PartialBlock[]): EditorState {
  const editor = BlockNoteEditor.create({ initialContent: blocks });
  editors.push(editor);
  const state = editor.prosemirrorState;
  const end = Selection.findFrom(state.doc.resolve(0), 1, true)!.$from.end();
  return state.apply(state.tr.setSelection(Selection.near(state.doc.resolve(end), -1)));
}

const typing = (state: EditorState, text = "[", menuShown = false) =>
  opensPageLink(state, state.selection.from, state.selection.to, text, menuShown);

describe("[[ opens the page menu", () => {
  it("after a [ in running text", () => {
    expect(typing(stateAfter([{ type: "paragraph", content: "See [" }]))).toBe(true);
  });

  it("not after any other character, nor for any other key", () => {
    expect(typing(stateAfter([{ type: "paragraph", content: "See (" }]))).toBe(false);
    expect(typing(stateAfter([{ type: "paragraph", content: "See [" }]), "(")).toBe(false);
  });

  it("not inside inline code", () => {
    const state = stateAfter([
      { type: "paragraph", content: [{ type: "text", text: "a[", styles: { code: true } }] },
    ]);
    expect(typing(state)).toBe(false);
  });

  it("not in a code block", () => {
    expect(typing(stateAfter([{ type: "codeBlock", content: "x = [" }]))).toBe(false);
  });

  it("not while another menu is open", () => {
    expect(typing(stateAfter([{ type: "paragraph", content: "/[" }]), "[", true)).toBe(false);
  });
});
