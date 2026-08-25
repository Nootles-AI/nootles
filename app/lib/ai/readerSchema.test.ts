import { describe, expect, it } from "vitest";
import {
  BlockNoteEditor,
  type BlockSchema,
  type CustomBlockNoteSchema,
  type InlineContentSchema,
  type StyleSchema,
} from "@blocknote/core";
import { schema } from "@/app/components/editor/schema";
import { readerSchema } from "./readerSchema";

/**
 * What a document is rebuilt against: node names, content expressions, groups,
 * attribute defaults and marks. The reader's stand-in specs carry no views, so
 * this is the whole of what has to match — and if it ever stops matching, the
 * blocks a thumbnail draws and the blocks the AI reads part company.
 */
function pmShape<
  B extends BlockSchema,
  I extends InlineContentSchema,
  S extends StyleSchema,
>(source: CustomBlockNoteSchema<B, I, S>) {
  const pm = BlockNoteEditor.create({ schema: source }).pmSchema;
  const nodes: Record<string, unknown> = {};
  pm.spec.nodes.forEach((name, node) => {
    nodes[name] = {
      content: node.content ?? null,
      group: node.group ?? null,
      attrs: Object.fromEntries(
        Object.entries(node.attrs ?? {}).map(([key, attr]) => [key, attr.default]),
      ),
    };
  });
  const marks: string[] = [];
  pm.spec.marks.forEach((name) => marks.push(name));
  return { nodes, marks: marks.sort() };
}

describe("readerSchema", () => {
  it("builds the editor's ProseMirror schema", () => {
    const reader = pmShape(readerSchema);
    expect(Object.keys(reader.nodes)).toContain("mathBlock");
    expect(reader).toEqual(pmShape(schema));
  });
});
