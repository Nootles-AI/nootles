import { describe, expect, it } from "vitest";
import { bearDiagram, type BirthEditor } from "./birth";

type Block = { id: string; type: string; content?: unknown; children?: unknown[]; props?: unknown };

/** A flat page of blocks, with ids minted the way BlockNote's are: never twice. */
function page(blocks: Block[]) {
  let minted = 0;
  let steps = 0;
  const editor: BirthEditor & { blocks: Block[]; steps: () => number } = {
    blocks,
    steps: () => steps,
    transact: (fn) => {
      steps += 1;
      return fn();
    },
    getBlock: (id) => blocks.find((block) => block.id === id),
    insertBlocks: (made, ref, where) => {
      const at = blocks.findIndex((block) => block.id === ref) + (where === "after" ? 1 : 0);
      const fresh = made.map((block) => ({ ...block, id: `new-${++minted}` }));
      blocks.splice(at, 0, ...fresh);
      return fresh;
    },
    removeBlocks: (ids) => {
      for (const id of ids) blocks.splice(blocks.findIndex((block) => block.id === id), 1);
    },
  };
  return editor;
}

const summary = (editor: ReturnType<typeof page>) => editor.blocks.map((block) => `${block.id}:${block.type}`);

describe("bearDiagram", () => {
  it("takes an empty line's place under an id of its own, in one step", () => {
    const editor = page([
      { id: "intro", type: "paragraph", content: [{ type: "text", text: "Above" }] },
      { id: "was-a-diagram", type: "paragraph", content: [] },
    ]);
    const id = bearDiagram(editor, "was-a-diagram", "");
    expect(id).not.toBe("was-a-diagram");
    expect(summary(editor)).toEqual(["intro:paragraph", `${id}:canvas`]);
    expect(editor.steps()).toBe(1);
  });

  it("carries the source it was asked for", () => {
    const editor = page([{ id: "line", type: "paragraph", content: [] }]);
    const id = bearDiagram(editor, "line", '<nt-diagram wide="pinned"></nt-diagram>');
    expect(editor.blocks.find((block) => block.id === id)?.props).toEqual({ data: '<nt-diagram wide="pinned"></nt-diagram>' });
  });

  it("goes after a line with words on it, which it leaves alone", () => {
    const editor = page([{ id: "line", type: "paragraph", content: [{ type: "text", text: "Keep me" }] }]);
    const id = bearDiagram(editor, "line", "");
    expect(summary(editor)).toEqual(["line:paragraph", `${id}:canvas`]);
  });

  it("goes after an empty line that holds nested blocks, which it leaves alone", () => {
    const editor = page([{ id: "line", type: "paragraph", content: [], children: [{ id: "child" }] }]);
    const id = bearDiagram(editor, "line", "");
    expect(summary(editor)).toEqual(["line:paragraph", `${id}:canvas`]);
  });

  it("takes the place of any empty line of text, a heading's too", () => {
    const editor = page([{ id: "h", type: "heading", content: [] }]);
    const id = bearDiagram(editor, "h", "");
    expect(summary(editor)).toEqual([`${id}:canvas`]);
  });

  it("goes after a block that holds no text", () => {
    const editor = page([{ id: "code", type: "codeBlock" }]);
    const id = bearDiagram(editor, "code", "");
    expect(summary(editor)).toEqual(["code:codeBlock", `${id}:canvas`]);
  });
});
