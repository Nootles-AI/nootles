import { BlockNoteEditor } from "@blocknote/core";
import { parseHTML } from "linkedom";
import type { Node as PMNode } from "prosemirror-model";
import { AllSelection, NodeSelection, TextSelection } from "prosemirror-state";
import { afterAll, describe, expect, it } from "vitest";
import { BlockRangeSelection, blockRangeFor } from "./blockSelection";
import { hasFormattableText } from "./formattable";

if (!("document" in globalThis)) {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document, window });
}

const editor = BlockNoteEditor.create({
  initialContent: [
    { id: "a", type: "paragraph", content: "above" },
    { id: "rule", type: "divider" },
    { id: "rule2", type: "divider" },
    { id: "b", type: "paragraph", content: "below" },
  ],
});
afterAll(() => editor._tiptapEditor?.destroy());
const doc = editor.prosemirrorState.doc;

function posOf(id: string): number {
  let found = -1;
  doc.descendants((node: PMNode, pos) => {
    if (found < 0 && node.attrs.id === id) found = pos;
    return found < 0;
  });
  return found;
}

describe("hasFormattableText", () => {
  it("closes the toolbar on a node-selected divider", () => {
    expect(hasFormattableText(NodeSelection.create(doc, posOf("rule") + 1))).toBe(false);
    expect(hasFormattableText(NodeSelection.create(doc, posOf("rule")))).toBe(false);
  });

  it("closes it on a band of dividers only", () => {
    const band = blockRangeFor(doc, ["rule", "rule2"]);
    expect(band).toBeInstanceOf(BlockRangeSelection);
    expect(hasFormattableText(band!)).toBe(false);
  });

  it("keeps it shut for a caret", () => {
    expect(hasFormattableText(TextSelection.create(doc, posOf("b") + 2))).toBe(false);
  });

  it("keeps it for anything that reaches text", () => {
    expect(hasFormattableText(NodeSelection.create(doc, posOf("a")))).toBe(true);
    expect(hasFormattableText(blockRangeFor(doc, ["a", "rule"])!)).toBe(true);
    expect(hasFormattableText(new AllSelection(doc))).toBe(true);
    expect(
      hasFormattableText(TextSelection.create(doc, posOf("a") + 2, posOf("a") + 5)),
    ).toBe(true);
  });
});
