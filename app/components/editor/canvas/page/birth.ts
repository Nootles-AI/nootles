/**
 * How a diagram block begins: always as a block of its own, never as an
 * existing block turned into one.
 *
 * A diagram's identity is its block id. Its CRDT maps (`canvas:<id>`, see
 * `collab/ymap.ts`), its warm scene store and its undo domain are all keyed on
 * it, and all of them outlive the block on purpose, so that undoing a delete
 * brings the diagram back whole. An id that has held a diagram once can
 * therefore never be the start of a new one: a line that was a wide diagram
 * until ⌘Z took it back, turned into a diagram in place, would wake up as that
 * wide diagram, shapes and all. A new block has a new id, and so nothing to
 * inherit — and an undo that brings the old block back brings its old id, which
 * finds the old diagram exactly as it was.
 */

/** The editor calls a diagram's birth needs. */
export type BirthEditor = {
  transact<T>(fn: () => T): T;
  getBlock(id: string): { id: string; type: string; content?: unknown; children?: unknown[] } | undefined;
  insertBlocks(
    blocks: { type: "canvas"; props: { data: string } }[],
    ref: string,
    where: "before" | "after",
  ): { id: string }[];
  removeBlocks(ids: string[]): unknown;
};

/** A block of text with no words and nothing nested under it: what a diagram can take the place of. */
function isEmptyLine(block: ReturnType<BirthEditor["getBlock"]>): boolean {
  if (!block || !Array.isArray(block.content) || block.children?.length) return false;
  return block.content.every((run) => (run as { text?: unknown }).text === "");
}

/**
 * A new diagram with this source at `blockId`: in place of it when it is an
 * empty line of any kind, which is taken out in the same step, else just after
 * it. One undo step either way. Returns the diagram's block id — never `blockId`.
 */
export function bearDiagram(editor: BirthEditor, blockId: string, data: string): string {
  return editor.transact(() => {
    const replace = isEmptyLine(editor.getBlock(blockId));
    const [made] = editor.insertBlocks([{ type: "canvas", props: { data } }], blockId, replace ? "before" : "after");
    if (replace) editor.removeBlocks([blockId]);
    return made.id;
  });
}
