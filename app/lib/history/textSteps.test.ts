import { describe, expect, it } from "vitest";
import { Schema, Slice, Fragment } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { liftTarget } from "prosemirror-transform";
import { breaksTypingRun } from "./textSteps";

// BlockNote's shape where it matters here: blocks that wrap a text block and
// can nest in a group beneath it.
const schema = new Schema({
  nodes: {
    doc: { content: "group" },
    group: { content: "block+" },
    block: { content: "(paragraph | heading) group?" },
    paragraph: { content: "inline*", group: "content" },
    heading: { content: "inline*", group: "content" },
    text: { group: "inline" },
  },
  marks: { bold: {} },
});

const { doc, group, block, paragraph, heading } = schema.nodes;
const text = (s: string) => (s ? [schema.text(s)] : []);
const para = (s: string, kids?: ReturnType<typeof group.create>) =>
  block.create(null, kids ? [paragraph.create(null, text(s)), kids] : [paragraph.create(null, text(s))]);

/** "one" / "two", with the caret after "on" — the positions every case below uses. */
function state() {
  const d = doc.create(null, group.create(null, [para("one"), para("two")]));
  return EditorState.create({ doc: d, selection: TextSelection.create(d, 5) });
}

describe("breaksTypingRun", () => {
  it("keeps characters typed into one block together", () => {
    expect(breaksTypingRun(state().tr.insertText("x"))).toBe(false);
  });

  it("keeps characters deleted inside one block together", () => {
    expect(breaksTypingRun(state().tr.delete(4, 5))).toBe(false);
  });

  it("keeps typing over a selection inside one block together", () => {
    expect(breaksTypingRun(state().tr.insertText("x", 3, 6))).toBe(false);
  });

  it("does not treat a caret move as an edit", () => {
    const s = state();
    expect(breaksTypingRun(s.tr.setSelection(TextSelection.create(s.doc, 3)))).toBe(false);
  });

  it("stands Enter's split on its own", () => {
    expect(breaksTypingRun(state().tr.split(5, 2))).toBe(true);
  });

  it("stands a merge of two blocks on its own", () => {
    // Backspace at the start of "two": the blocks between the texts go.
    expect(breaksTypingRun(state().tr.delete(6, 10))).toBe(true);
  });

  it("stands a block type change on its own", () => {
    expect(breaksTypingRun(state().tr.setBlockType(3, 3, heading))).toBe(true);
  });

  it("stands an indent or outdent on its own", () => {
    const d = doc.create(null, group.create(null, [para("one", group.create(null, [para("two")]))]));
    const s = EditorState.create({ doc: d });
    const $pos = s.doc.resolve(12);
    const range = $pos.blockRange(s.doc.resolve(12), (node) => node.type === group);
    const target = range && liftTarget(range);
    expect(range && target !== null).toBe(true);
    expect(breaksTypingRun(s.tr.lift(range!, target!))).toBe(true);
  });

  it("stands a formatting change on its own", () => {
    expect(breaksTypingRun(state().tr.addMark(3, 6, schema.marks.bold.create()))).toBe(true);
  });

  it("stands a paste on its own, even of plain words", () => {
    expect(breaksTypingRun(state().tr.insertText("pasted").setMeta("uiEvent", "paste"))).toBe(true);
  });

  it("stands a pasted block on its own", () => {
    const slice = new Slice(Fragment.from(para("new")), 0, 0);
    expect(breaksTypingRun(state().tr.replace(7, 7, slice))).toBe(true);
  });
});
