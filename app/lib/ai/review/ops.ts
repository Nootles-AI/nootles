import type {
  NewBlock,
  Operation,
  Position,
  ShapeRef,
} from "@/convex/ai/operations";
import type { IdMap } from "../apply";

/**
 * Reading an op batch as a graph.
 *
 * Every op either NAMES a node it creates or REFERS to one that already has a
 * name, and the review pipeline is built on telling those apart: a reference to
 * something created in the same turn is what makes two ops inseparable, and a
 * reference to something that was already there is what makes an op stand on its
 * own.
 *
 * Two kinds of reference, and the difference is the whole design:
 *  - IDENTITY — "act on THIS node". Drop what created it and the op is
 *    meaningless, so the two must live or die together.
 *  - POSITIONAL — "go next to that node". Drop what created it and the op still
 *    means something; it just has to be told where to go instead.
 */

/** Names an op brings into existence, including nested inserted blocks. */
export function produces(op: Operation): string[] {
  switch (op.kind) {
    case "insertBlocks":
      return [...eachNewBlock(op.blocks)].map((b) => b.tempId);
    case "addShape":
    case "connectEdge":
      return [op.tempId];
    default:
      return [];
  }
}

/** Names an op acts ON — a hard dependency on whatever created them. */
export function consumes(op: Operation): string[] {
  switch (op.kind) {
    case "insertBlocks":
      return [];
    case "connectEdge":
      return [op.blockId, shapeName(op.source), shapeName(op.target)];
    case "updateShape":
    case "removeShape":
      return [op.blockId, op.shapeId];
    case "disconnectEdge":
    case "setEdgeLabel":
      return [op.blockId, op.edgeId];
    default:
      return [op.blockId];
  }
}

/** The block an op addresses; an insert addresses none, it makes one. */
export function target(op: Operation): string | undefined {
  return op.kind === "insertBlocks" ? undefined : op.blockId;
}

export function shapeName(ref: ShapeRef): string {
  return "shapeId" in ref ? ref.shapeId : ref.tempId;
}

export function* eachNewBlock(blocks: NewBlock[]): Generator<NewBlock> {
  for (const block of blocks) {
    yield block;
    if (block.children?.length) yield* eachNewBlock(block.children);
  }
}

/**
 * The batch as it actually happened: every `tempId` replaced by the id the
 * applier gave it.
 *
 * A `tempId` is a name that lives for the length of one call, and everything
 * downstream outlives that — the op log, the hunks, the ids the model was shown.
 * Rewriting once, here, means there is only ever one name for a block.
 */
export function canonicalise(ops: Operation[], ids: IdMap): Operation[] {
  const block = (id: string) => ids.blocks[id] ?? id;
  const shape = (id: string) => ids.shapes[id] ?? id;
  const edge = (id: string) => ids.edges[id] ?? id;

  const at = (p: Position): Position =>
    p.at === "after" || p.at === "before" ? { at: p.at, ref: block(p.ref) } : p;
  const shapeRef = (r: ShapeRef): ShapeRef =>
    "shapeId" in r ? { shapeId: shape(r.shapeId) } : { tempId: shape(r.tempId) };
  const rename = (nb: NewBlock): NewBlock => ({
    ...nb,
    tempId: block(nb.tempId),
    ...(nb.children ? { children: nb.children.map(rename) } : {}),
  });

  return ops.map((op): Operation => {
    switch (op.kind) {
      case "insertBlocks":
        return { ...op, at: at(op.at), blocks: op.blocks.map(rename) };
      case "moveBlock":
        return { ...op, blockId: block(op.blockId), to: at(op.to) };
      case "addShape":
        return { ...op, blockId: block(op.blockId), tempId: shape(op.tempId) };
      case "connectEdge":
        return {
          ...op,
          blockId: block(op.blockId),
          tempId: edge(op.tempId),
          source: shapeRef(op.source),
          target: shapeRef(op.target),
        };
      case "updateShape":
      case "removeShape":
        return { ...op, blockId: block(op.blockId), shapeId: shape(op.shapeId) };
      case "disconnectEdge":
      case "setEdgeLabel":
        return { ...op, blockId: block(op.blockId), edgeId: edge(op.edgeId) };
      default:
        return { ...op, blockId: block(op.blockId) };
    }
  });
}
