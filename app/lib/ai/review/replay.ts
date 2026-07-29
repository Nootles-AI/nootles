import type { Operation, Position } from "@/convex/ai/operations";
import type { OpTrace } from "../apply";
import { flattenBlocks, type AnyBlock } from "../projection";
import type { Hunk } from "./hunks";
import { produces } from "./ops";

/**
 * What to run against the checkpoint to leave only the kept hunks standing.
 *
 * Reject replays EFFECTS, not intentions: the document goes back to the
 * checkpoint and the surviving ops run again, seeded with the ids they produced
 * the first time. Re-deriving them instead would renumber every inserted block
 * and take the op log, the hunk anchors and the ids the model was given with it.
 *
 * The one thing that cannot simply be re-run is a position that pointed at
 * something no longer being made. That reference is repaired rather than fused
 * away, because two paragraphs written one after the other are two changes, not
 * one — the second merely has to be told where to go now that the first is not
 * there. Where it goes is where the first one went: an anchor chain, walked back
 * until it reaches a block that is actually going to exist.
 */
export function planReplay({
  ops,
  trace,
  hunks,
  keep,
  before,
}: {
  ops: Operation[];
  trace: OpTrace[];
  hunks: Hunk[];
  /** Hunk ids to keep; everything else is undone. */
  keep: ReadonlySet<string>;
  before: AnyBlock[];
}): Operation[] {
  const kept = new Set<number>();
  for (const hunk of hunks) {
    if (keep.has(hunk.id)) for (const i of hunk.opIndices) kept.add(i);
  }

  const exists = new Set(flattenBlocks(before).map((b) => b.id));
  for (const i of kept) for (const name of produces(ops[i])) exists.add(name);

  const producer = new Map<string, number>();
  ops.forEach((op, i) => {
    for (const name of produces(op)) if (!producer.has(name)) producer.set(name, i);
  });

  const repair = (position: Position): Position => {
    if (position.at !== "after" && position.at !== "before") return position;
    let ref = position.ref;
    let placement: "before" | "after" = position.at;
    const seen = new Set<string>();
    while (!exists.has(ref) && !seen.has(ref)) {
      seen.add(ref);
      const made = producer.get(ref);
      const anchor = made === undefined ? undefined : trace[made]?.anchor;
      if (!anchor) break;
      // Where the missing block itself sat. "Before it" and "after it" both
      // collapse to that same spot once it is gone.
      ref = anchor.ref;
      placement = anchor.placement;
    }
    if (exists.has(ref)) return { at: placement, ref };
    // Nothing in the chain survives, which means the run this hung off is gone
    // in its entirety. The end it was written towards is all that is left of it.
    return placement === "before" ? { at: "docStart" } : { at: "docEnd" };
  };

  return [...kept]
    .sort((a, b) => a - b)
    .map((i) => {
      const op = ops[i];
      if (op.kind === "insertBlocks") return { ...op, at: repair(op.at) };
      if (op.kind === "moveBlock") return { ...op, to: repair(op.to) };
      return op;
    });
}
