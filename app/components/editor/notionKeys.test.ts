import { BlockNoteEditor, defaultBlockSpecs, type PartialBlock } from "@blocknote/core";
import { parseHTML } from "linkedom";
import { TextSelection } from "prosemirror-state";
import { afterAll, describe, expect, it } from "vitest";
import { readerSchema } from "@/app/lib/ai/readerSchema";
import {
  inlineEquation,
  notionKeysExtension,
  toggleAtCaret,
  turnInto,
  withoutShortcuts,
} from "./notionKeys";

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

function editorWith(blocks: Blocks) {
  const editor = BlockNoteEditor.create({ schema: readerSchema, initialContent: blocks });
  editors.push(editor);
  return editor;
}

/** Selects characters `from`–`to` of the block's inline text. */
function selectText(editor: ReturnType<typeof editorWith>, id: string, from: number, to: number) {
  editor.setTextCursorPosition(id, "start");
  editor.transact((tr) => {
    const start = tr.selection.from;
    tr.setSelection(TextSelection.create(tr.doc, start + from, start + to));
  });
}

describe("turn-into keys", () => {
  it("binds Notion's ⌘⌥4–8 row, ⌘↵, ⌘⇧X and ⌘⇧E", () => {
    const extension =
      typeof notionKeysExtension === "function"
        ? notionKeysExtension({} as never)
        : notionKeysExtension;
    expect(Object.keys(extension.keyboardShortcuts ?? {})).toEqual(
      expect.arrayContaining([
        "Mod-Alt-4", "Mod-Alt-5", "Mod-Alt-6", "Mod-Alt-7", "Mod-Alt-8",
        "Mod-Enter", "Mod-Shift-x", "Mod-Shift-e",
      ]),
    );
  });

  it("retypes the caret's block and keeps its words", () => {
    const editor = editorWith([{ id: "a", type: "heading", props: { level: 2 }, content: "Ship it" }]);
    editor.setTextCursorPosition("a", "end");
    expect(turnInto(editor, "checkListItem")).toBe(true);
    expect(editor.getBlock("a")).toMatchObject({
      type: "checkListItem",
      content: [{ type: "text", text: "Ship it" }],
    });
    turnInto(editor, "numberedListItem");
    expect(editor.getBlock("a")?.type).toBe("numberedListItem");
  });

  it("carries the text into a code block's code", () => {
    const editor = editorWith([{ id: "a", type: "paragraph", content: "const x = 1;" }]);
    editor.setTextCursorPosition("a", "end");
    expect(turnInto(editor, "codeBlock")).toBe(true);
    expect(editor.getBlock("a")).toMatchObject({
      type: "codeBlock",
      props: { code: "const x = 1;" },
    });
  });

  it("leaves a block with no text alone", () => {
    const editor = editorWith([{ id: "d", type: "divider" }, { id: "p", type: "paragraph" }]);
    editor.setTextCursorPosition("d");
    expect(turnInto(editor, "bulletListItem")).toBe(false);
    expect(editor.getBlock("d")?.type).toBe("divider");
  });

  it("takes ⌘⌥4–6 off the heading, and only those", () => {
    const spec = withoutShortcuts(defaultBlockSpecs.heading, ["Mod-Alt-4", "Mod-Alt-5", "Mod-Alt-6"]);
    const keys = (spec.extensions ?? []).flatMap((extension) =>
      Object.keys(
        (typeof extension === "function" ? extension({} as never) : extension)
          .keyboardShortcuts ?? {},
      ),
    );
    expect(keys).toEqual(["Mod-Alt-1", "Mod-Alt-2", "Mod-Alt-3"]);
  });
});

describe("⌘↵", () => {
  it("ticks the caret's to-do, and unticks it again", () => {
    const editor = editorWith([{ id: "t", type: "checkListItem", content: "Buy milk" }]);
    editor.setTextCursorPosition("t", "end");
    expect(toggleAtCaret(editor)).toBe(true);
    expect(editor.getBlock("t")?.props).toMatchObject({ checked: true });
    toggleAtCaret(editor);
    expect(editor.getBlock("t")?.props).toMatchObject({ checked: false });
  });

  it("ticks every selected to-do when any was open, in one step", () => {
    const editor = editorWith([
      { id: "a", type: "checkListItem", props: { checked: true }, content: "one" },
      { id: "b", type: "checkListItem", content: "two" },
    ]);
    editor.setSelection("a", "b");
    expect(toggleAtCaret(editor)).toBe(true);
    expect(editor.document.map((block) => block.props)).toMatchObject([
      { checked: true },
      { checked: true },
    ]);
    toggleAtCaret(editor);
    expect(editor.document.map((block) => block.props)).toMatchObject([
      { checked: false },
      { checked: false },
    ]);
  });

  it("falls through anywhere it has nothing to flip", () => {
    const editor = editorWith([{ id: "p", type: "paragraph", content: "text" }]);
    editor.setTextCursorPosition("p", "end");
    expect(toggleAtCaret(editor)).toBe(false);
  });
});

describe("⌘⇧E", () => {
  it("turns the selected text into an inline equation's source", () => {
    const editor = editorWith([{ id: "p", type: "paragraph", content: "area x^2 here" }]);
    selectText(editor, "p", 5, 8);
    expect(inlineEquation(editor)).toBe(true);
    expect(editor.getBlock("p")?.content).toMatchObject([
      { type: "text", text: "area " },
      { type: "math", props: { latex: "x^2" } },
      { type: "text", text: " here" },
    ]);
  });

  it("drops an empty equation at a bare caret, as the slash item does", () => {
    const editor = editorWith([{ id: "p", type: "paragraph", content: "a" }]);
    editor.setTextCursorPosition("p", "end");
    expect(inlineEquation(editor)).toBe(true);
    expect(editor.getBlock("p")?.content).toMatchObject([
      { type: "text", text: "a" },
      { type: "math", props: { latex: "" } },
      { type: "text", text: " " },
    ]);
  });

  it("declines a selection that leaves its line", () => {
    const editor = editorWith([
      { id: "a", type: "paragraph", content: "one" },
      { id: "b", type: "paragraph", content: "two" },
    ]);
    editor.setSelection("a", "b");
    expect(inlineEquation(editor)).toBe(false);
  });
});
