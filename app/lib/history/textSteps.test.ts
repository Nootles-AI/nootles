import { describe, expect, it } from "vitest";
import { Schema, Slice, Fragment } from "prosemirror-model";
import { EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { liftTarget } from "prosemirror-transform";
import { ySyncPluginKey } from "y-prosemirror";
import { asOneStep, breaksTypingRun, caretOffNode, textStepOf, textStepsPlugin } from "./textSteps";

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
    mention: { group: "inline", inline: true, atom: true },
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

  it("stands something a menu put in a line on its own", () => {
    expect(breaksTypingRun(state().tr.insert(5, schema.nodes.mention.create()))).toBe(true);
  });

  it("stands a paste on its own, even of plain words", () => {
    expect(breaksTypingRun(state().tr.insertText("pasted").setMeta("uiEvent", "paste"))).toBe(true);
  });

  it("stands a pasted block on its own", () => {
    const slice = new Slice(Fragment.from(para("new")), 0, 0);
    expect(breaksTypingRun(state().tr.replace(7, 7, slice))).toBe(true);
  });
});

describe("textStepsPlugin", () => {
  const withPlugin = () => EditorState.create({ doc: state().doc, plugins: [textStepsPlugin] });

  it("records a boundary edit", () => {
    const s = withPlugin();
    const next = s.apply(s.tr.split(5, 2));
    expect(textStepOf(next)).toMatchObject({ boundary: true, group: null, unwritten: false });
  });

  it("stamps every edit made inside one asOneStep with the same group", () => {
    let s = withPlugin();
    const groups = asOneStep(() => {
      const found: Array<number | null | undefined> = [];
      for (const at of [5, 3]) {
        s = s.apply(s.tr.split(at, 2));
        found.push(textStepOf(s)?.group);
      }
      return found;
    });
    expect(groups[0]).not.toBeNull();
    expect(groups[1]).toBe(groups[0]);
    s = s.apply(s.tr.insertText("x"));
    expect(textStepOf(s)?.group).toBeNull();
    const again = asOneStep(() => textStepOf(s.apply(s.tr.insertText("y")))?.group);
    expect(again).not.toBe(groups[0]);
  });

  it("treats a redraw from the shared doc as nobody's edit", () => {
    const s = withPlugin();
    const redraw = s.tr.split(5, 2).setMeta(ySyncPluginKey, { isChangeOrigin: true });
    expect(textStepOf(s.apply(redraw))).toMatchObject({ boundary: false, before: null });
  });

  it("flags a repair appended to a redraw as unwritten, and clears it on the next dispatch", () => {
    const s = withPlugin();
    const redraw = s.tr.insertText("x").setMeta(ySyncPluginKey, { isChangeOrigin: true });
    const redrawn = s.apply(redraw);
    const repaired = redrawn.apply(redrawn.tr.insertText("y").setMeta("appendedTransaction", redraw));
    expect(textStepOf(repaired)?.unwritten).toBe(true);
    const flushed = repaired.apply(repaired.tr.setMeta("addToHistory", false));
    expect(textStepOf(flushed)?.unwritten).toBe(false);
  });

  it("does not flag a repair appended to the person's own edit", () => {
    const s = withPlugin();
    const edit = s.tr.insertText("x");
    const edited = s.apply(edit);
    const repaired = edited.apply(edited.tr.insertText("y").setMeta("appendedTransaction", edit));
    expect(textStepOf(repaired)?.unwritten).toBe(false);
  });
});

describe("caretOffNode", () => {
  const withDiagram = new Schema({
    nodes: {
      doc: { content: "group" },
      group: { content: "block+" },
      block: { content: "(paragraph | diagram) group?" },
      paragraph: { content: "inline*" },
      diagram: { atom: true, selectable: true },
      text: { group: "inline" },
    },
  });
  const n = withDiagram.nodes;
  const wrap = (child: ReturnType<typeof n.paragraph.create>) => n.block.create(null, child);
  const line = (s: string) => wrap(n.paragraph.create(null, s ? withDiagram.text(s) : null));
  const held = (blocks: ReturnType<typeof wrap>[], at: number) => {
    const d = n.doc.create(null, n.group.create(null, blocks));
    return EditorState.create({ doc: d, selection: NodeSelection.create(d, at) });
  };

  it("puts the caret at the end of the text before a held diagram", () => {
    // "one" runs 3–6; the second block opens at 8 and its diagram sits at 9.
    const s = held([line("one"), wrap(n.diagram.create()), line("two")], 9);
    expect(caretOffNode(s)?.head).toBe(6);
  });

  it("or, for a diagram that is the first block, at the start of the text after it", () => {
    // The diagram sits at 2; the next block's text starts at 6.
    const s = held([wrap(n.diagram.create()), line("two")], 2);
    expect(caretOffNode(s)?.head).toBe(6);
  });

  it("leaves a text selection alone", () => {
    expect(caretOffNode(state())).toBeNull();
  });
});
