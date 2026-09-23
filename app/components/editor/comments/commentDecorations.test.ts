import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { parseHTML } from "linkedom";
import { Slice, type Node } from "prosemirror-model";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { StepMap } from "prosemirror-transform";
import * as Y from "yjs";
import { ySyncPluginKey } from "y-prosemirror";
import { afterAll, describe, expect, it } from "vitest";
import { readerSchema } from "@/app/lib/ai/readerSchema";
import { asReview } from "@/app/lib/ai/review/attribution";
import { anchorAt } from "@/app/lib/comments/anchor";
import { persistable } from "@/app/lib/comments/anchorWrite";
import { pmBlockTexts } from "@/app/lib/comments/pmText";
import type { ResolutionWrite } from "@/app/lib/comments/resolve";
import { CommentsStore, readThreads } from "@/app/lib/comments/store";
import { emptyCommentsDocument, type Thread } from "@/app/lib/comments/types";
import { createNmlYDoc } from "@/app/lib/nml/yjs";
import {
  activeThread,
  commentDecorationsPlugin,
  commentKey,
  commentRanges,
  commentResolveCount,
  mapRange,
  straddles,
} from "./commentDecorations";

if (!("document" in globalThis)) {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document, window });
}

const editors: Array<{ _tiptapEditor?: { destroy(): void } }> = [];
afterAll(() => editors.forEach((editor) => editor._tiptapEditor?.destroy()));

type Blocks = PartialBlock<
  (typeof readerSchema)["blockSchema"],
  (typeof readerSchema)["inlineContentSchema"],
  (typeof readerSchema)["styleSchema"]
>[];

const PAGE: Blocks = [
  { id: "title", type: "heading", props: { level: 1 }, content: "Launch plan" },
  { id: "p1", type: "paragraph", content: "We ship it by Friday if the review passes." },
  { id: "p2", type: "paragraph", content: "Design signs off on Thursday." },
  { id: "tail", type: "paragraph", content: "" },
];

/** A real ProseMirror document from BlockNote, with the plugin installed. */
function stateFor(blocks: Blocks = PAGE): EditorState {
  const editor = BlockNoteEditor.create({ schema: readerSchema, initialContent: blocks });
  editors.push(editor);
  return EditorState.create({ doc: editor.prosemirrorState.doc, plugins: [commentDecorationsPlugin()] });
}

function blockText(doc: Node, blockId: string) {
  const block = pmBlockTexts(doc).find((candidate) => candidate.blockId === blockId);
  if (!block) throw new Error(`no block ${blockId}`);
  return block;
}

/** The document position of character `offset` of a block's text. */
function pos(doc: Node, blockId: string, offset: number): number {
  const block = blockText(doc, blockId);
  return offset < block.text.length ? block.map.posAt[offset] : block.end;
}

function thread(id: string, doc: Node, blockId: string, phrase: string, occurrence = 0, extra: Partial<Thread> = {}): Thread {
  const block = blockText(doc, blockId);
  let from = -1;
  for (let i = 0; i <= occurrence; i++) from = block.text.indexOf(phrase, from + 1);
  if (from < 0) throw new Error(`"${phrase}" not in ${blockId}`);
  return { id, anchor: anchorAt(block, from, from + phrase.length), status: "open", ambiguous: false, comments: [], ...extra };
}

const meta = (state: EditorState, value: object) => state.apply(state.tr.setMeta(commentKey, value));
const withThreads = (state: EditorState, threads: Thread[]) => meta(state, { threads });

function rangeText(state: EditorState, id: string): string | null {
  const range = commentRanges(state).get(id);
  return range ? state.doc.textBetween(range.from, range.to) : null;
}

const writesOf = (state: EditorState) => commentKey.getState(state)!.writes;

function decorated(state: EditorState) {
  return commentKey
    .getState(state)!
    .decorations.find()
    .map((d) => ({
      text: state.doc.textBetween(d.from, d.to),
      thread: d.spec.threadId as string,
      active: String((d as unknown as { type: { attrs: { class: string } } }).type.attrs.class).includes("active"),
    }));
}

/**
 * The same change as y-prosemirror delivers it: one step replacing the whole
 * document, built from a local transaction so unchanged nodes are shared — as
 * the binding's node cache shares them.
 */
function asRemote(state: EditorState, change: (tr: Transaction) => void): Transaction {
  const local = state.tr;
  change(local);
  return state.tr.replace(0, state.doc.content.size, new Slice(local.doc.content, 0, 0)).setMeta("addToHistory", false);
}

describe("mapRange", () => {
  const range = { from: 10, to: 20 };
  it("grows for an insertion inside and keeps the same object when untouched", () => {
    expect(mapRange(range, [new StepMap([15, 0, 3])])).toEqual({ from: 10, to: 23 });
    expect(mapRange(range, [new StepMap([30, 0, 3])])).toBe(range);
  });
  it("does not grow for an insertion at either edge", () => {
    expect(mapRange(range, [new StepMap([10, 0, 2])])).toEqual({ from: 12, to: 22 });
    expect(mapRange(range, [new StepMap([20, 0, 2])])).toEqual(range);
  });
  it("shrinks for a partial deletion and dies when every character goes", () => {
    expect(mapRange(range, [new StepMap([8, 4, 0])])).toEqual({ from: 8, to: 16 });
    expect(mapRange(range, [new StepMap([10, 10, 0])])).toBeNull();
    expect(mapRange(range, [new StepMap([5, 20, 0])])).toBeNull();
  });
  it("tells a span that straddles an edge from one inside or outside", () => {
    expect(straddles(range, [new StepMap([15, 10, 2])])).toBe(true);
    expect(straddles(range, [new StepMap([5, 10, 2])])).toBe(true);
    expect(straddles(range, [new StepMap([12, 3, 1])])).toBe(false);
    expect(straddles(range, [new StepMap([15, 0, 4])])).toBe(false);
    expect(straddles(range, [new StepMap([20, 5, 0])])).toBe(false);
  });
  it("counts a replacement that swallows the range as a deletion", () => {
    expect(mapRange(range, [new StepMap([10, 10, 4])])).toBeNull();
    expect(mapRange(range, [new StepMap([10, 5, 0]), new StepMap([10, 5, 0])])).toBeNull();
  });
});

describe("resolving once, then mapping", () => {
  it("resolves a new thread once and draws it", () => {
    let state = stateFor();
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    expect(rangeText(state, "t1")).toBe("by Friday");
    expect(commentResolveCount(state)).toBe(1);
    expect(decorated(state)).toEqual([{ text: "by Friday", thread: "t1", active: false }]);
    expect(writesOf(state).size).toBe(0);
  });

  it("typing inside the phrase grows the range without consulting the selector", () => {
    let state = stateFor();
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    let at = pos(state.doc, "p1", "We ship it by".length);
    for (const ch of " next") state = state.apply(state.tr.insertText(ch, at++));
    expect(rangeText(state, "t1")).toBe("by next Friday");
    expect(commentResolveCount(state)).toBe(1);
    expect(writesOf(state).size).toBe(0);
  });

  it("typing at either edge does not grow the range", () => {
    let state = stateFor();
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    const start = pos(state.doc, "p1", "We ship it ".length);
    state = state.apply(state.tr.insertText("X", start));
    expect(rangeText(state, "t1")).toBe("by Friday");
    const end = commentRanges(state).get("t1")!.to;
    state = state.apply(state.tr.insertText("Y", end));
    expect(rangeText(state, "t1")).toBe("by Friday");
    expect(blockText(state.doc, "p1").text).toBe("We ship it Xby FridayY if the review passes.");
    expect(commentResolveCount(state)).toBe(1);
  });

  it("keeps a known thread's range when its stored anchor changes", () => {
    let state = stateFor();
    const t1 = thread("t1", state.doc, "p1", "by Friday");
    state = withThreads(state, [t1]);
    state = withThreads(state, [{ ...t1, anchor: { ...t1.anchor, exact: "something else" } }]);
    expect(rangeText(state, "t1")).toBe("by Friday");
    expect(commentResolveCount(state)).toBe(1);
  });

  it("drops a thread that leaves the document, and its focus with it", () => {
    let state = stateFor();
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday"), thread("t2", state.doc, "p2", "Thursday")]);
    state = meta(state, { active: "t2" });
    expect(activeThread(state)).toBe("t2");
    expect(decorated(state).map((d) => [d.thread, d.active])).toEqual([["t1", false], ["t2", true]]);
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    expect(activeThread(state)).toBeNull();
    expect([...commentRanges(state).keys()]).toEqual(["t1"]);
  });

  it("draws only open threads, and none that resolve nowhere", () => {
    let state = stateFor();
    const resolved = thread("t1", state.doc, "p1", "by Friday", 0, { status: "resolved" });
    const gone = { ...thread("t2", state.doc, "p2", "Thursday"), anchor: { blockId: "p2", exact: "Saturday", prefix: "", suffix: "", offsetHint: 0 } };
    state = withThreads(state, [resolved, gone]);
    expect(rangeText(state, "t1")).toBe("by Friday");
    expect(commentRanges(state).get("t2")).toBeNull();
    expect(decorated(state)).toEqual([]);
    // First sight of an orphan records it.
    expect([...writesOf(state)]).toEqual([["t2", { orphaned: true }]]);
  });

  it("an idle transaction and typing after every range leave the state alone", () => {
    let state = stateFor();
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    const before = commentKey.getState(state);
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)));
    expect(commentKey.getState(state)).toBe(before);
    state = state.apply(state.tr.insertText("!", pos(state.doc, "p2", 5)));
    expect(commentKey.getState(state)).toBe(before);
  });
});

describe("the settle pass makes an edited quotation durable", () => {
  it("words typed inside the range become the stored `exact` once, when the edits pause", () => {
    let state = stateFor();
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    let at = pos(state.doc, "p1", "We ship it by".length);
    for (const ch of " next") {
      state = state.apply(state.tr.insertText(ch, at++));
      expect(writesOf(state).size).toBe(0);
    }
    state = meta(state, { settle: true });
    const write = writesOf(state).get("t1")!;
    expect(write.anchor).toEqual({
      blockId: "p1",
      exact: "by next Friday",
      prefix: "We ship it ",
      suffix: " if the review passes.",
      offsetHint: "We ship it ".length,
    });
    expect(commentResolveCount(state)).toBe(1);
    // Nothing left to settle: the state, and so its writes, do not change.
    const settled = commentKey.getState(state);
    state = meta(state, { settle: true });
    expect(commentKey.getState(state)).toBe(settled);
  });

  it("typing at the edges, or elsewhere, is not an edit of the quotation", () => {
    let state = stateFor();
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    state = state.apply(state.tr.insertText("X", commentRanges(state).get("t1")!.from));
    state = state.apply(state.tr.insertText("Y", commentRanges(state).get("t1")!.to));
    state = state.apply(state.tr.insertText("Z", pos(state.doc, "p2", 2)));
    state = meta(state, { settle: true });
    expect(writesOf(state).size).toBe(0);
  });

  it("an edit that puts the stored words back writes nothing", () => {
    let state = stateFor();
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    const at = pos(state.doc, "p1", "We ship it by".length);
    state = state.apply(state.tr.insertText("!", at));
    state = state.apply(state.tr.delete(at, at + 1));
    state = meta(state, { settle: true });
    expect(writesOf(state).size).toBe(0);
  });

  it("a remote edit inside the range is the other client's to settle", () => {
    let state = stateFor();
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    const at = pos(state.doc, "p1", "We ship it by".length);
    state = state.apply(asRemote(state, (tr) => tr.insertText(" next", at)));
    expect(rangeText(state, "t1")).toBe("by next Friday");
    state = meta(state, { settle: true });
    expect(writesOf(state).size).toBe(0);
  });

  it("nothing is settled from a fork", () => {
    let forked = true;
    let state = stateFor();
    state = meta(state, { isForked: () => forked });
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    state = state.apply(state.tr.insertText(" next", pos(state.doc, "p1", "We ship it by".length)));
    state = meta(state, { settle: true });
    expect(writesOf(state).size).toBe(0);
    forked = false;
    state = meta(state, { settle: true });
    expect(writesOf(state).size).toBe(0);
  });
});

describe("the focused thread", () => {
  it("follows the caret into and out of a highlight, the narrowest when they nest", () => {
    let state = stateFor();
    state = withThreads(state, [thread("wide", state.doc, "p1", "ship it by Friday"), thread("narrow", state.doc, "p1", "Friday")]);
    const caret = (offset: number) => state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos(state.doc, "p1", offset))));
    state = caret("We ship".length);
    expect(activeThread(state)).toBe("wide");
    state = caret("We ship it by Fri".length);
    expect(activeThread(state)).toBe("narrow");
    state = caret(1);
    expect(activeThread(state)).toBeNull();
  });

  it("stays on a thread named outright until the caret moves, not when a remote change restores it", () => {
    let state = stateFor();
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    state = meta(state, { active: "t1" });
    const remote = asRemote(state, (tr) => tr.insertText("!", pos(state.doc, "p2", 3)));
    remote.setSelection(TextSelection.create(remote.doc, 3)).setMeta(ySyncPluginKey, { isChangeOrigin: true });
    state = state.apply(remote);
    expect(activeThread(state)).toBe("t1");
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)));
    expect(activeThread(state)).toBeNull();
  });
});

describe("when the range is deleted", () => {
  it("re-resolves at once and, finding nothing, records the orphan only on the retry", () => {
    let state = stateFor();
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    const { from, to } = commentRanges(state).get("t1")!;
    state = state.apply(state.tr.delete(from, to));
    expect(commentRanges(state).get("t1")).toBeNull();
    expect(commentResolveCount(state)).toBe(2);
    expect(writesOf(state).size).toBe(0);
    state = meta(state, { settle: true });
    expect([...writesOf(state)]).toEqual([["t1", { orphaned: true }]]);
  });

  it("re-anchors when the words come back, clearing the orphan mark", () => {
    let state = stateFor();
    const t1 = thread("t1", state.doc, "p1", "by Friday");
    state = withThreads(state, [{ ...t1, orphanedAt: 5 }]);
    expect([...writesOf(state)]).toEqual([["t1", { orphaned: false }]]);
  });

  it("a small rewrite of the whole phrase re-resolves through stage 2 and rewrites `exact`", () => {
    let state = stateFor();
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    const { from, to } = commentRanges(state).get("t1")!;
    state = state.apply(state.tr.insertText("by friday", from, to));
    expect(rangeText(state, "t1")).toBe("by friday");
    expect(writesOf(state).size).toBe(0);
    state = meta(state, { settle: true });
    const write = writesOf(state).get("t1")!;
    expect(write.anchor?.exact).toBe("by friday");
    expect(write.anchor?.blockId).toBe("p1");
  });

  it("a twin found while the phrase is on the clipboard is shown but never written", () => {
    let state = stateFor([
      { id: "p", type: "paragraph", content: "Ship the beta on Friday. Ship the beta on Monday." },
      { id: "tail", type: "paragraph", content: "" },
    ]);
    state = withThreads(state, [thread("t1", state.doc, "p", "beta on Friday")]);
    const { from, to } = commentRanges(state).get("t1")!;
    state = state.apply(state.tr.delete(from, to));
    // Stage 2 finds "beta on Monday" for now; nothing is stored.
    expect(rangeText(state, "t1")).toBe("beta on Monday");
    expect(writesOf(state).size).toBe(0);
    // Pasted back at the end of the sentence before the edits pause: the
    // settle pass finds the words themselves, and the stored anchor never
    // named the twin.
    state = state.apply(state.tr.insertText(" Or beta on Friday.", blockText(state.doc, "p").end));
    state = meta(state, { settle: true });
    expect(rangeText(state, "t1")).toBe("beta on Friday");
    expect(commentRanges(state).get("t1")!.from).toBe(pos(state.doc, "p", "Ship the . Ship the beta on Monday. Or ".length));
    expect(writesOf(state).size).toBe(0);
  });

  it("typing over one letter keeps both ends and is still an edit of the quotation", () => {
    let state = stateFor([{ id: "p", type: "paragraph", content: "the cat sat" }]);
    state = withThreads(state, [thread("t1", state.doc, "p", "cat")]);
    const a = pos(state.doc, "p", "the c".length);
    const before = commentRanges(state).get("t1");
    state = state.apply(state.tr.insertText("o", a, a + 1));
    expect(commentRanges(state).get("t1")).toEqual(before);
    state = meta(state, { settle: true });
    expect(writesOf(state).get("t1")?.anchor?.exact).toBe("cot");
  });

  it("cut and pasted into a new block re-homes on the retry, with no orphan in between", () => {
    let state = stateFor();
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    const p1 = state.doc.child(0).child(1);
    const at = pos(state.doc, "p1", 0) - 2;
    state = state.apply(state.tr.delete(at, at + p1.nodeSize));
    expect(commentRanges(state).get("t1")).toBeNull();
    expect(writesOf(state).size).toBe(0);
    const pasted = state.schema.nodes.blockContainer.create({ id: "p9" }, state.schema.nodes.paragraph.create({}, state.schema.text("We ship it by Friday if the review passes.")));
    const tail = pos(state.doc, "tail", 0) - 2;
    state = state.apply(state.tr.insert(tail, pasted));
    state = meta(state, { settle: true });
    expect(rangeText(state, "t1")).toBe("by Friday");
    const write = writesOf(state).get("t1")!;
    expect(write.anchor?.blockId).toBe("p9");
    expect(write.orphaned).toBeUndefined();
  });

  it("a thread without a range is tried again when another client moves its anchor", () => {
    let state = stateFor();
    const t1 = thread("t1", state.doc, "p1", "by Friday");
    const lost = { ...t1, anchor: { ...t1.anchor, blockId: "nope", exact: "Monday" } };
    state = withThreads(state, [lost]);
    expect(commentRanges(state).get("t1")).toBeNull();
    state = withThreads(state, [t1]);
    expect(rangeText(state, "t1")).toBe("by Friday");
  });
});

describe("remote changes (one whole-document step)", () => {
  it("map by what actually changed: inside grows, edges do not", () => {
    let state = stateFor();
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    const inside = pos(state.doc, "p1", "We ship it by".length);
    state = state.apply(asRemote(state, (tr) => tr.insertText(" next", inside)));
    expect(rangeText(state, "t1")).toBe("by next Friday");
    state = state.apply(asRemote(state, (tr) => tr.insertText("Q", commentRanges(state).get("t1")!.to)));
    state = state.apply(asRemote(state, (tr) => tr.insertText("Z", commentRanges(state).get("t1")!.from)));
    expect(rangeText(state, "t1")).toBe("by next Friday");
    expect(blockText(state.doc, "p1").text).toBe("We ship it Zby next FridayQ if the review passes.");
    expect(commentResolveCount(state)).toBe(1);
  });

  it("a batch of edits arrives as one changed span; a range inside it is resolved again", () => {
    let state = stateFor();
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    const { from, to } = commentRanges(state).get("t1")!;
    state = state.apply(asRemote(state, (tr) => tr.insertText("Q", to).insertText("Z", from)));
    expect(commentResolveCount(state)).toBe(2);
    expect(rangeText(state, "t1")).toBe("by Friday");
  });

  it("a batch that starts inside the range and ends past it asks the selector", () => {
    let state = stateFor();
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    const f = pos(state.doc, "p1", "We ship it by ".length);
    const end = blockText(state.doc, "p1").end;
    state = state.apply(asRemote(state, (tr) => tr.insertText(", maybe", end).insertText("f", f, f + 1)));
    // Mapped, the span would have cut the range to "by "; the selector finds it whole.
    expect(rangeText(state, "t1")).toBe("by friday");
    expect(commentResolveCount(state)).toBe(2);
    expect(writesOf(state).size).toBe(0);
    state = meta(state, { settle: true });
    expect(writesOf(state).get("t1")?.anchor?.exact).toBe("by friday");
  });

  it("an identical re-render (a fork swap) moves nothing", () => {
    let state = stateFor();
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    const before = commentKey.getState(state);
    // Rebuilt node for node, as y-prosemirror rebuilds a document it re-renders.
    const again = state.schema.nodeFromJSON(state.doc.toJSON());
    expect(again.content.child(0)).not.toBe(state.doc.content.child(0));
    state = state.apply(state.tr.replace(0, state.doc.content.size, new Slice(again.content, 0, 0)));
    expect(commentKey.getState(state)).toBe(before);
  });

  it("a remote deletion of the phrase re-resolves like a local one", () => {
    let state = stateFor();
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    const { from, to } = commentRanges(state).get("t1")!;
    state = state.apply(asRemote(state, (tr) => tr.delete(from, to)));
    expect(commentRanges(state).get("t1")).toBeNull();
    expect(commentResolveCount(state)).toBe(2);
  });
});

describe("under a review fork", () => {
  it("leaves a range the fork deleted unanchored, resolves nothing and writes nothing until it ends", () => {
    let forked = true;
    let state = stateFor();
    state = meta(state, { isForked: () => forked });
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday")]);
    const resolves = commentResolveCount(state);
    const { from, to } = commentRanges(state).get("t1")!;
    state = state.apply(state.tr.insertText("by friday", from, to));
    expect(commentRanges(state).get("t1")).toBeNull();
    expect(commentResolveCount(state)).toBe(resolves);
    state = meta(state, { settle: true });
    expect(commentRanges(state).get("t1")).toBeNull();
    expect(writesOf(state).size).toBe(0);
    forked = false;
    state = meta(state, { resolve: "all" });
    expect(rangeText(state, "t1")).toBe("by friday");
    expect(writesOf(state).get("t1")?.anchor?.exact).toBe("by friday");
  });

  it("a proposal that rewrites any of the range unanchors it; the person's own typing maps", () => {
    let state = stateFor();
    state = meta(state, { isForked: () => true });
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday"), thread("t2", state.doc, "p2", "Thursday")]);
    // The person types inside one phrase in the fork: it maps.
    state = state.apply(state.tr.insertText("!", pos(state.doc, "p2", "Design signs off on Thurs".length)));
    expect(rangeText(state, "t2")).toBe("Thurs!day");
    // The applier rewrites one letter of the other: the steps keep "by ", the thread goes.
    const f = pos(state.doc, "p1", "We ship it by ".length);
    state = asReview(() => state.apply(state.tr.insertText("f", f, f + 1)));
    expect(commentRanges(state).get("t1")).toBeNull();
    expect(rangeText(state, "t2")).toBe("Thurs!day");
    expect(writesOf(state).size).toBe(0);
  });

  it("resolves a thread that arrives during the fork for display only", () => {
    let state = stateFor();
    state = meta(state, { isForked: () => true });
    const gone = { ...thread("t2", state.doc, "p2", "Thursday"), anchor: { blockId: "p2", exact: "Saturday", prefix: "", suffix: "", offsetHint: 0 } };
    state = withThreads(state, [thread("t1", state.doc, "p1", "by Friday"), gone]);
    expect(rangeText(state, "t1")).toBe("by Friday");
    expect(commentRanges(state).get("t2")).toBeNull();
    expect(writesOf(state).size).toBe(0);
  });
});

describe("the same phrase twice in one block", () => {
  const TWICE: Blocks = [
    { id: "p", type: "paragraph", content: "ok then ok then ok" },
    { id: "q", type: "paragraph", content: "note: alpha beta; note: gamma" },
  ];

  it("context picks the right one", () => {
    let state = stateFor(TWICE);
    state = withThreads(state, [thread("t1", state.doc, "q", "note", 1)]);
    const range = commentRanges(state).get("t1")!;
    expect(range.from).toBe(pos(state.doc, "q", "note: alpha beta; ".length));
    expect(writesOf(state).size).toBe(0);
  });

  it("identical context falls to the offset hint, then the lowest offset, and says it is ambiguous", () => {
    let state = stateFor(TWICE);
    const block = blockText(state.doc, "p");
    const bare = (hint: number): Thread => ({
      id: `h${hint}`,
      anchor: { blockId: "p", exact: "ok", prefix: "", suffix: "", offsetHint: hint },
      status: "open",
      ambiguous: false,
      comments: [],
    });
    state = withThreads(state, [bare(8), bare(4), bare(12)]);
    const offsets = ["h8", "h4", "h12"].map((id) => commentRanges(state).get(id)!.from - block.start);
    expect(offsets).toEqual([8, 0, 8]);
    expect(writesOf(state).get("h8")).toEqual({ ambiguous: true });
  });
});

describe("two replicas converge", () => {
  const DOC = "comments";
  const sync = (a: Y.Doc, b: Y.Doc) => {
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), "remote");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), "remote");
  };
  const persist = async (store: CommentsStore, writes: ReadonlyMap<string, ResolutionWrite>, now: number) => {
    for (const [id, write] of writes) await store.applyAnchorWrite(id, persistable(write, now));
  };

  it("both re-homing the same cut-and-paste write the same anchor, a bounded number of times", async () => {
    let ids = 0;
    const left = createNmlYDoc(emptyCommentsDocument(DOC));
    const right = new Y.Doc();
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    const leftStore = new CommentsStore(left, { actor: { userId: "ada", kind: "human" }, authorize: () => true, createId: () => `c${++ids}` });
    const rightStore = new CommentsStore(right, { actor: { userId: "bram", kind: "human" }, authorize: () => true });

    let a = stateFor();
    let b = EditorState.create({ doc: a.doc, plugins: a.plugins });
    const seed = thread("t1", a.doc, "p1", "by Friday");
    await leftStore.createThread({ anchor: seed.anchor, body: "Realistic?", authorId: "ada", threadId: "t1" });
    sync(left, right);
    a = withThreads(a, readThreads(left));
    b = withThreads(b, readThreads(right));

    let updates = 0;
    const count = () => void updates++;
    left.on("update", (_: Uint8Array, origin: unknown) => origin !== "remote" && count());
    right.on("update", (_: Uint8Array, origin: unknown) => origin !== "remote" && count());

    // The same cut and paste reaches both, as it would through the page doc.
    const move = (state: EditorState) => {
      const p1 = state.doc.child(0).child(1);
      const at = pos(state.doc, "p1", 0) - 2;
      let next = state.apply(state.tr.delete(at, at + p1.nodeSize));
      const pasted = next.schema.nodes.blockContainer.create({ id: "p9" }, next.schema.nodes.paragraph.create({}, next.schema.text(p1.textContent)));
      next = next.apply(next.tr.insert(pos(next.doc, "tail", 0) - 2, pasted));
      return meta(next, { settle: true });
    };
    a = move(a);
    b = move(b);
    await persist(leftStore, writesOf(a), 1000);
    await persist(rightStore, writesOf(b), 2000);
    sync(left, right);
    a = withThreads(a, readThreads(left));
    b = withThreads(b, readThreads(right));
    // Hearing the other's write resolves nothing more.
    expect(writesOf(a).size + writesOf(b).size).toBe(0);

    const [l] = readThreads(left);
    const [r] = readThreads(right);
    expect(l.anchor).toEqual(r.anchor);
    expect(l.anchor.blockId).toBe("p9");
    expect(l.orphanedAt).toBeUndefined();
    expect(updates).toBeLessThanOrEqual(2);
    expect(rangeText(a, "t1")).toBe("by Friday");
    expect(rangeText(b, "t1")).toBe("by Friday");
  });
});
