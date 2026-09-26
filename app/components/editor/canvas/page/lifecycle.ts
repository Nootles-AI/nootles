import { copiesInto, remapEdges } from "../engine/clipboard";
import { bandHeight } from "../scene/band";
import type { NodeId, Scene, SceneOp } from "../scene/types";

/**
 * How diagram blocks end: with their last shape, or into the diagram above.
 * Both are one undo step, and neither ever writes a block prop the diagram's
 * store has not written itself — a prop trails the store by seconds.
 */

/** The editor calls a diagram's death needs. */
export type LifecycleEditor = {
  transact<T>(fn: () => T): T;
  removeBlocks(ids: string[]): unknown;
  getPrevBlock(id: string): { id: string } | undefined;
  getNextBlock(id: string): { id: string } | undefined;
  setTextCursorPosition(id: string, placement: "start" | "end"): void;
  focus(): void;
};

/**
 * Takes a diagram's block out of the page in one text step, with the caret
 * where the block was: at the end of the block before it, or else the start
 * of the one after.
 */
export function deleteDiagramBlock(editor: LifecycleEditor, blockId: string): void {
  const prev = editor.getPrevBlock(blockId);
  const next = editor.getNextBlock(blockId);
  editor.transact(() => {
    editor.removeBlocks([blockId]);
    if (prev) editor.setTextCursorPosition(prev.id, "end");
    else if (next) editor.setTextCursorPosition(next.id, "start");
  });
  editor.focus();
}

/**
 * The ops that bring the diagram below into this one: its shapes under this
 * band, as far down as this band is tall, with ids of their own here and its
 * connectors following them; the band as tall as the two were together —
 * pinned only if the lower one was, since its pin is the room left at the
 * bottom — and wide if either was. What was below's own ground is not brought: a diagram
 * has one.
 */
export function mergeOps(upper: Scene, lower: Scene): SceneOp[] {
  const dy = bandHeight(upper);
  const map = new Map<NodeId, NodeId>();
  const nodes = copiesInto(upper, lower.nodes, 0, dy, map);
  const edges = remapEdges(upper, lower.edges, map);
  const ops: SceneOp[] = [];
  if (nodes.length) ops.push({ type: "insert", nodes });
  if (edges.length) ops.push({ type: "addEdge", edges });
  const h = lower.h > 0 ? dy + bandHeight(lower) : 0;
  const root: Extract<SceneOp, { type: "setDiagram" }> = { type: "setDiagram" };
  if (h !== upper.h) root.h = h;
  if (lower.wide && !upper.wide) root.wide = true;
  if (Object.keys(root).length > 1) ops.push(root);
  return ops;
}
