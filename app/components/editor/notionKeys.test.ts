import { BlockNoteEditor, defaultBlockSpecs, type PartialBlock } from "@blocknote/core";
import { parseHTML } from "linkedom";
import { TextSelection } from "prosemirror-state";
import { afterAll, describe, expect, it } from "vitest";
import { readerSchema } from "@/app/lib/ai/readerSchema";
import { blockRangeFor } from "./blockSelection";
import {
  inlineEquation,
  notionKeysExtension,
  textAboveHeading,
  toggleAtCaret,
  TURN_INTO,
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

const shapes = (editor: ReturnType<typeof editorWith>) =>
  editor.document.map((block) => ({ id: block.id, type: block.type }));

describe("turn-into keys", () => {
  it("binds Notion's ⌘⌥0–7 row, ⌘↵, ⌘⇧X and ⌘⇧E — and leaves ⌘⌥8 to the code block", () => {
    const extension =
      typeof notionKeysExtension === "function"
        ? notionKeysExtension({} as never)
        : notionKeysExtension;
    const keys = Object.keys(extension.keyboardShortcuts ?? {});
    expect(keys).toEqual(
      expect.arrayContaining([
        "Mod-Alt-0", "Mod-Alt-1", "Mod-Alt-2", "Mod-Alt-3", "Mod-Alt-4",
        "Mod-Alt-5", "Mod-Alt-6", "Mod-Alt-7",
        "Mod-Enter", "Mod-Shift-x", "Mod-Shift-e", "Enter",
      ]),
    );
    expect(keys).not.toContain("Mod-Alt-8");
  });

  it("retypes the caret's block and keeps its words", () => {
    const editor = editorWith([{ id: "a", type: "heading", props: { level: 2 }, content: "Ship it" }]);
    editor.setTextCursorPosition("a", "end");
    expect(turnInto(editor, TURN_INTO["Mod-Alt-4"])).toBe(true);
    expect(editor.getBlock("a")).toMatchObject({
      type: "checkListItem",
      content: [{ type: "text", text: "Ship it" }],
    });
    turnInto(editor, TURN_INTO["Mod-Alt-6"]);
    expect(editor.getBlock("a")?.type).toBe("numberedListItem");
    turnInto(editor, TURN_INTO["Mod-Alt-3"]);
    expect(editor.getBlock("a")).toMatchObject({ type: "heading", props: { level: 3 } });
    turnInto(editor, TURN_INTO["Mod-Alt-0"]);
    expect(editor.getBlock("a")?.type).toBe("paragraph");
  });

  it("retypes every block a text selection spans, in one undo step", () => {
    const editor = editorWith([
      { id: "a", type: "paragraph", content: "one" },
      { id: "b", type: "heading", content: "two" },
      { id: "c", type: "paragraph", content: "three" },
    ]);
    editor.setSelection("a", "b");
    let changes = 0;
    editor.onChange(() => changes++);
    expect(turnInto(editor, TURN_INTO["Mod-Alt-5"])).toBe(true);
    expect(shapes(editor).map((block) => block.type)).toEqual([
      "bulletListItem", "bulletListItem", "paragraph",
    ]);
    expect(changes).toBe(1);
  });

  it("retypes a block selection, passing over what has no text", () => {
    const editor = editorWith([
      { id: "a", type: "paragraph", content: "one" },
      { id: "d", type: "divider" },
      { id: "b", type: "paragraph", content: "two" },
    ]);
    editor.transact((tr) => tr.setSelection(blockRangeFor(tr.doc, ["a", "b"])!));
    expect(turnInto(editor, TURN_INTO["Mod-Alt-1"])).toBe(true);
    expect(editor.document).toMatchObject([
      { type: "heading", props: { level: 1 } },
      { type: "divider" },
      { type: "heading", props: { level: 1 } },
    ]);
  });

  it("leaves a block with no text alone", () => {
    const editor = editorWith([{ id: "d", type: "divider" }, { id: "p", type: "paragraph" }]);
    editor.setTextCursorPosition("d");
    expect(turnInto(editor, TURN_INTO["Mod-Alt-5"])).toBe(false);
    expect(editor.getBlock("d")?.type).toBe("divider");
  });

  it("does nothing, and lets the key go, in a page it cannot edit", () => {
    const editor = editorWith([{ id: "a", type: "paragraph", content: "one" }]);
    editor.setTextCursorPosition("a", "end");
    editor.isEditable = false;
    expect(turnInto(editor, TURN_INTO["Mod-Alt-5"])).toBe(false);
    expect(inlineEquation(editor)).toBe(false);
    expect(editor.getBlock("a")?.type).toBe("paragraph");
  });

  it("takes ⌘⌥0–6 off the paragraph and heading, and nothing else", () => {
    const keysOf = (spec: typeof defaultBlockSpecs.heading | typeof defaultBlockSpecs.paragraph) =>
      (spec.extensions ?? []).flatMap((extension) =>
        Object.keys(
          (typeof extension === "function" ? extension({} as never) : extension)
            .keyboardShortcuts ?? {},
        ),
      );
    const row = Object.keys(TURN_INTO);
    expect(keysOf(withoutShortcuts(defaultBlockSpecs.heading, row))).toEqual([]);
    expect(keysOf(withoutShortcuts(defaultBlockSpecs.paragraph, row))).toEqual([]);
    expect(keysOf(withoutShortcuts(defaultBlockSpecs.heading, ["Mod-Alt-4"]))).toEqual([
      "Mod-Alt-1", "Mod-Alt-2", "Mod-Alt-3", "Mod-Alt-5", "Mod-Alt-6",
    ]);
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

  it("declines a selection holding an equation, rather than lose its source", () => {
    const editor = editorWith([
      {
        id: "p",
        type: "paragraph",
        content: ["ab", { type: "math", props: { latex: "y" } }, "cd"],
      },
    ]);
    selectText(editor, "p", 0, 5);
    expect(inlineEquation(editor)).toBe(false);
    expect(editor.getBlock("p")?.content).toMatchObject([
      { type: "text", text: "ab" },
      { type: "math", props: { latex: "y" } },
      { type: "text", text: "cd" },
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

describe("Enter at the start of a heading", () => {
  it("opens a text line above and keeps the heading, its id and the caret", () => {
    const editor = editorWith([
      { id: "h", type: "heading", props: { level: 1 }, content: "Plan" },
    ]);
    editor.setTextCursorPosition("h", "start");
    expect(textAboveHeading(editor)).toBe(true);
    const [above, heading] = editor.document;
    expect(above).toMatchObject({ type: "paragraph", content: [] });
    expect(heading).toMatchObject({ id: "h", type: "heading", content: [{ text: "Plan" }] });
    expect(editor.getTextCursorPosition().block.id).toBe("h");
    expect(editor.prosemirrorState.selection.$from.parentOffset).toBe(0);
  });

  it("leaves every other Enter to BlockNote", () => {
    const editor = editorWith([
      { id: "h", type: "heading", content: "Plan" },
      { id: "e", type: "heading", content: "" },
      { id: "p", type: "paragraph", content: "text" },
    ]);
    editor.setTextCursorPosition("h", "end");
    expect(textAboveHeading(editor)).toBe(false);
    editor.setTextCursorPosition("e", "start");
    expect(textAboveHeading(editor)).toBe(false);
    editor.setTextCursorPosition("p", "start");
    expect(textAboveHeading(editor)).toBe(false);
    expect(shapes(editor).map((block) => block.id)).toEqual(["h", "e", "p"]);
  });
});
