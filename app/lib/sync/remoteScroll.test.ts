import { Schema } from "prosemirror-model";
import { EditorState, Plugin, type Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { describe, expect, it } from "vitest";
import { ySyncPluginKey } from "y-prosemirror";
import { arrivedFromDoc, remoteScrollPlugin } from "./remoteScroll";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});

const fromDoc = (tr: Transaction) =>
  tr.setMeta(ySyncPluginKey, { isChangeOrigin: true, isUndoRedoOperation: false });
const undoRedo = (tr: Transaction) =>
  tr.setMeta(ySyncPluginKey, { isChangeOrigin: true, isUndoRedoOperation: true });

function start(plugins: Plugin[] = []) {
  return EditorState.create({
    doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text("hello")])]),
    plugins: [remoteScrollPlugin, ...plugins],
  });
}

/** What ProseMirror asks the plugin before it scrolls to the selection. */
function holdsStill(state: EditorState): boolean {
  return remoteScrollPlugin.props.handleScrollToSelection!.call(
    remoteScrollPlugin,
    { state } as EditorView,
  );
}

describe("arrivedFromDoc", () => {
  it("names the sync binding's re-render of a change nobody here made", () => {
    const state = start();
    expect(arrivedFromDoc(fromDoc(state.tr))).toBe(true);
  });

  it("leaves local edits, undo/redo, and other sync metadata alone", () => {
    const state = start();
    expect(arrivedFromDoc(state.tr.insertText("x", 1))).toBe(false);
    expect(arrivedFromDoc(undoRedo(state.tr))).toBe(false);
    expect(arrivedFromDoc(state.tr.setMeta(ySyncPluginKey, { addToHistory: false }))).toBe(false);
  });
});

describe("remoteScrollPlugin", () => {
  it("holds the page still when a change from the doc asks to scroll", () => {
    const state = start();
    expect(holdsStill(state.apply(fromDoc(state.tr.insertText("peer ", 1)).scrollIntoView()))).toBe(true);
  });

  it("still scrolls for the person's own typing and their undo/redo", () => {
    const state = start();
    expect(holdsStill(state.apply(state.tr.insertText("x", 1).scrollIntoView()))).toBe(false);
    expect(holdsStill(state.apply(undoRedo(state.tr.insertText("x", 1)).scrollIntoView()))).toBe(false);
  });

  it("changes its answer only on a transaction that asks to scroll", () => {
    let state = start();
    state = state.apply(state.tr.insertText("x", 1).scrollIntoView());
    state = state.apply(fromDoc(state.tr.insertText("peer ", 1)));
    expect(holdsStill(state)).toBe(false);

    state = state.apply(fromDoc(state.tr.insertText("peer ", 1)).scrollIntoView());
    state = state.apply(state.tr.setMeta("unrelated", true));
    expect(holdsStill(state)).toBe(true);
  });

  it("lets a local scroll appended to a remote change win", () => {
    const appendsScroll = new Plugin({
      appendTransaction: (trs, _old, next) =>
        trs.some((tr) => arrivedFromDoc(tr)) ? next.tr.insertText("!", 1).scrollIntoView() : null,
    });
    const state = start([appendsScroll]);
    const { state: next } = state.applyTransaction(fromDoc(state.tr.insertText("peer ", 1)).scrollIntoView());
    expect(next.doc.textContent).toBe("!peer hello");
    expect(holdsStill(next)).toBe(false);
  });
});
