import { describe, expect, it } from "vitest";
import { ySyncPluginKey } from "y-prosemirror";
import * as Y from "yjs";
import { AFTER, BEFORE, captureTextSteps } from "./textCapture";
import type { RelativeSelection, TextStep } from "./textSteps";

/** A stand-in for a relative selection: only identity matters here. */
const at = (n: number) => ({ type: "text", anchor: n, head: n }) as unknown as RelativeSelection;

function setup() {
  const doc = new Y.Doc();
  const text = doc.getXmlFragment("prosemirror");
  const manager = new Y.UndoManager(text, {
    trackedOrigins: new Set([ySyncPluginKey]),
    captureTransaction: (tr) => tr.meta.get("addToHistory") !== false,
  });
  let step: TextStep | undefined;
  let selection = at(0);
  let edits = 0;
  const capture = captureTextSteps(manager, doc, () => step, () => selection, () => edits++);
  /** One dispatch as the sync plugin writes it. */
  const write = (next: Partial<TextStep> & { after?: number; addToHistory?: false }) => {
    step = { boundary: false, before: null, group: null, unwritten: false, ...next };
    if (next.after !== undefined) selection = at(next.after);
    doc.transact((tr) => {
      if (next.addToHistory === false) tr.meta.set("addToHistory", false);
      text.insert(text.length, [new Y.XmlText("x")]);
    }, ySyncPluginKey);
  };
  return { doc, text, manager, capture, write, edits: () => edits };
}

describe("captureTextSteps", () => {
  it("keeps a typing run as one entry", () => {
    const t = setup();
    t.write({ before: at(1) });
    t.write({ before: at(2) });
    t.write({ before: at(3) });
    expect(t.manager.undoStack).toHaveLength(1);
    expect(t.edits()).toBe(1);
  });

  it("stands a boundary on its own, closing the run before and after", () => {
    const t = setup();
    t.write({});
    t.write({ boundary: true });
    t.write({});
    expect(t.manager.undoStack).toHaveLength(3);
    expect(t.edits()).toBe(3);
  });

  it("lets an off-history write land mid-run without cutting it", () => {
    const t = setup();
    t.write({});
    t.write({ addToHistory: false });
    t.write({});
    expect(t.manager.undoStack).toHaveLength(1);
  });

  it("makes a group of boundaries one entry, apart from what comes either side", () => {
    const t = setup();
    t.write({});
    t.write({ boundary: true, group: 1 });
    t.write({ boundary: true, group: 1 });
    t.write({ boundary: true, group: 1 });
    t.write({});
    expect(t.manager.undoStack).toHaveLength(3);
  });

  it("keeps two groups back to back apart", () => {
    const t = setup();
    t.write({ boundary: true, group: 1 });
    t.write({ boundary: true, group: 1 });
    t.write({ boundary: true, group: 2 });
    expect(t.manager.undoStack).toHaveLength(2);
  });

  it("undoes a whole group at once", () => {
    const t = setup();
    t.write({});
    t.write({ boundary: true, group: 1 });
    t.write({ boundary: true, group: 1 });
    expect(t.text.length).toBe(3);
    expect(t.capture.step("undo")).toMatchObject({ consumed: 1, redoable: true });
    expect(t.text.length).toBe(1);
  });

  it("keeps the first selection before an entry and the last after it", () => {
    const t = setup();
    t.write({ before: at(1), after: 2 });
    t.write({ before: at(2), after: 3 });
    const { meta } = t.manager.undoStack[0];
    expect(meta.get(BEFORE)).toEqual(at(1));
    expect(meta.get(AFTER)).toEqual(at(3));
  });

  it("carries both selections onto the inverse entry, and across a redo", () => {
    const t = setup();
    t.write({ before: at(1), after: 2 });
    const undone = t.capture.step("undo");
    expect(undone.item?.meta.get(BEFORE)).toEqual(at(1));
    expect(t.manager.redoStack[0].meta.get(AFTER)).toEqual(at(2));
    const redone = t.capture.step("redo");
    expect(redone).toMatchObject({ consumed: 1, redoable: true });
    expect(t.manager.undoStack[0].meta.get(BEFORE)).toEqual(at(1));
  });

  it("does not count its own undo or redo as an edit", () => {
    const t = setup();
    t.write({});
    t.capture.step("undo");
    t.capture.step("redo");
    expect(t.edits()).toBe(1);
  });

  it("hears nothing once disposed", () => {
    const t = setup();
    t.capture.dispose();
    t.write({});
    t.write({ boundary: true });
    expect(t.manager.undoStack).toHaveLength(1);
    expect(t.edits()).toBe(0);
  });
});
