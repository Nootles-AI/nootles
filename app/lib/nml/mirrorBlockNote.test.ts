import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment, yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { readerSchema } from "@/app/lib/ai/readerSchema";
import { createNmlYDoc, decodeNmlDocument, type NmlDocument } from ".";
import { NmlLegacyMirror } from "./mirror";
import { blockNoteNmlMirrorHost } from "./mirrorBlockNote";

if (!("document" in globalThis)) {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document, window });
}

const fixture: NmlDocument = {
  schemaVersion: 1,
  documentId: "blocknote-mirror",
  blocks: [{
    id: "paragraph", type: "paragraph", props: {}, children: [],
    content: [{ type: "text", text: "canonical", marks: ["bold"] }],
  }],
};

describe("BlockNote NML mirror adapter", () => {
  it("round-trips the real ProseMirror fragment in both directions", async () => {
    const editor = BlockNoteEditor.create({ schema: readerSchema });
    const doc = createNmlYDoc(fixture);
    const fragment = doc.getXmlFragment("prosemirror");
    const mirror = new NmlLegacyMirror(
      doc,
      blockNoteNmlMirrorHost(editor, doc),
      { actor: { kind: "human", userId: "blocknote-user" } },
    ).start();
    const projected = yXmlFragmentToBlocks(editor, fragment);
    expect(projected[0]).toMatchObject({ id: "paragraph", content: [{ text: "canonical", styles: { bold: true } }] });

    projected[0].content = [{ type: "text", text: "legacy edit", styles: { italic: true } }];
    doc.transact(() => {
      blocksToYXmlFragment(editor, projected, fragment);
    }, "legacy-client");
    await mirror.settle();
    expect(decodeNmlDocument(doc).blocks[0]).toMatchObject({
      id: "paragraph",
      content: [{ type: "text", text: "legacy edit", marks: ["italic"] }],
    });
    mirror.stop();
    doc.destroy();
    editor._tiptapEditor?.destroy();
  });
});
