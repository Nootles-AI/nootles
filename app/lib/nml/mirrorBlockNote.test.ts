import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment, yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { DOMParser, parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { readerSchema } from "@/app/lib/ai/readerSchema";
import { createNmlYDoc, decodeNmlDocument, type NmlDocument } from ".";
import { NmlLegacyMirror } from "./mirror";
import { blockNoteNmlMirrorHost } from "./mirrorBlockNote";

if (!("document" in globalThis)) {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document, window });
}
// The mirror parses a diagram's `<nt-diagram>` prop back into its scene.
if (typeof globalThis.DOMParser === "undefined") Object.assign(globalThis, { DOMParser });

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

  // BlockNote keeps a block's ID when the `---` rule or the slash menu turns an
  // empty line into another kind of block (NT-125).
  const empty: NmlDocument = {
    schemaVersion: 1,
    documentId: "type-change",
    blocks: [
      { id: "line", type: "paragraph", props: {}, children: [], content: [] },
      { id: "other", type: "paragraph", props: {}, children: [], content: [{ type: "text", text: "other", marks: [] }] },
    ],
  };
  type Edit = (blocks: Array<Record<string, unknown>>) => void;
  async function served(document: NmlDocument) {
    const editor = BlockNoteEditor.create({ schema: readerSchema });
    const doc = createNmlYDoc(document);
    const fragment = doc.getXmlFragment("prosemirror");
    const onError = vi.fn();
    const mirror = new NmlLegacyMirror(doc, blockNoteNmlMirrorHost(editor, doc), {
      actor: { kind: "human", userId: "blocknote-user" },
      onError,
    }).start();
    const edit = async (change: Edit) => {
      const blocks = yXmlFragmentToBlocks(editor, fragment) as unknown as Array<Record<string, unknown>>;
      change(blocks);
      doc.transact(() => blocksToYXmlFragment(editor, blocks as never, fragment), "legacy-client");
      await mirror.settle();
    };
    const view = () => yXmlFragmentToBlocks(editor, fragment) as unknown as Array<Record<string, unknown>>;
    const close = () => { mirror.stop(); doc.destroy(); editor._tiptapEditor?.destroy(); };
    return { editor, doc, fragment, mirror, onError, edit, view, close };
  }
  const retype = (block: Record<string, unknown>, type: string, content?: unknown) => {
    block.type = type;
    block.props = {};
    block.content = content;
  };
  const typeOther = (blocks: Array<Record<string, unknown>>) => {
    blocks.find((block) => block.id === "other")!.content = [{ type: "text", text: "other, edited", styles: {} }];
  };

  it.each([
    ["divider", undefined],
    ["table", { type: "tableContent", rows: [{ cells: [[], []] }, { cells: [[], []] }] }],
    ["image", undefined],
    ["mathBlock", undefined],
    ["canvas", undefined],
  ])("carries an empty line turned into a %s into NML, and every edit after it", async (type, content) => {
    const page = await served(empty);
    await page.edit((blocks) => retype(blocks[0], type, content));
    await page.edit(typeOther);
    expect(page.onError.mock.calls.map(([error]) => String(error))).toEqual([]);
    const nml = decodeNmlDocument(page.doc);
    expect(nml.blocks.map((block) => `${block.id}:${block.type}`)).toEqual([`line:${type}`, "other:paragraph"]);
    expect(nml.blocks[1]).toMatchObject({ content: [{ type: "text", text: "other, edited" }] });

    // The next served mount projects canonical NML over the fragment; nothing
    // written since the conversion may be lost to it.
    const written = JSON.stringify(page.view());
    page.mirror.stop();
    const remount = new NmlLegacyMirror(page.doc, blockNoteNmlMirrorHost(page.editor, page.doc), {
      actor: { kind: "human", userId: "blocknote-user" },
    }).start();
    await remount.settle();
    expect(JSON.stringify(page.view())).toBe(written);
    remount.stop();
    page.close();
  });

  it("turns a divider back into a paragraph through the same path", async () => {
    const page = await served({
      ...empty,
      blocks: [{ id: "line", type: "divider", props: {}, children: [] }, empty.blocks[1]],
    });
    await page.edit((blocks) => retype(blocks[0], "paragraph", [{ type: "text", text: "words", styles: {} }]));
    expect(decodeNmlDocument(page.doc).blocks[0]).toMatchObject({
      id: "line", type: "paragraph", content: [{ type: "text", text: "words" }],
    });
    expect(page.onError).not.toHaveBeenCalled();
    page.close();
  });

  it.each(["divider", "paragraph", "heading"])(
    "hoists a list item's children before it becomes a %s",
    async (type) => {
      const page = await served({
        ...empty,
        blocks: [{
          id: "item", type: "bulletListItem", props: {}, content: [{ type: "text", text: "item", marks: [] }],
          children: [{ id: "child", type: "bulletListItem", props: {}, content: [{ type: "text", text: "child", marks: [] }], children: [] }],
        }, empty.blocks[1]],
      });
      await page.edit((blocks) => retype(blocks[0], type, type === "divider"
        ? undefined
        : [{ type: "text", text: "item", styles: {} }]));
      await page.edit(typeOther);
      const nml = decodeNmlDocument(page.doc);
      expect(nml.blocks.map((block) => `${block.id}:${block.type}:${block.children.length}`))
        .toEqual([`item:${type}:0`, "child:bulletListItem:0", "other:paragraph:0"]);
      expect(nml.blocks[2]).toMatchObject({ content: [{ type: "text", text: "other, edited" }] });
      expect(page.onError).not.toHaveBeenCalled();
      page.close();
    },
  );
});

