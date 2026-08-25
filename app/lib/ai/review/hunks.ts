import type { Operation } from "@/convex/ai/operations";
import type { OpTrace } from "../apply";
import { flattenBlocks, type AnyBlock } from "../projection";
import { consumes, produces, target } from "./ops";

/**
 * Hunks: the units a change can be kept or discarded in.
 *
 * A hunk is an equivalence class of the must-live-or-die-together relation over
 * a batch's ops, so an incoherent partial reject is impossible by construction
 * rather than by care. Nothing downstream has to ask "but does this still make
 * sense without that" — if it didn't, they would be the same hunk.
 *
 * Ops are canonical here (every `tempId` is already the real id it produced), so
 * "was this here before the turn" is the only distinction that matters, and the
 * checkpoint document answers it.
 */

export type HunkKind = "insert" | "replace" | "remove" | "move" | "update";

/** What a run of ops did to the document — the part an undo has to reverse. */
export type Change = {
  /** Blocks it adds, in document order. */
  added: string[];
  /** Blocks it deletes, as they were — the red side of a replace. */
  removed: AnyBlock[];
  /** Blocks that were already there and are rewritten in place. */
  changed: string[];
  /** Blocks that were already there and are only somewhere else now. */
  moved: string[];
};

export type Hunk = Change & {
  id: string;
  kind: HunkKind;
  /** Positions in the page's accumulated op list, ascending. */
  opIndices: number[];
};

export function computeHunks({
  chatPromptId,
  pageId,
  ops,
  trace,
  before,
  replacing,
}: {
  chatPromptId: string;
  pageId: string;
  ops: Operation[];
  trace: OpTrace[];
  /** The page as it stood before the turn touched it — the checkpoint. */
  before: AnyBlock[];
  /** Blocks each rewrite declared it consumes, one entry per call. */
  replacing?: string[][];
}): Hunk[] {
  const parent = ops.map((_, i) => i);
  const find = (start: number): number => {
    let root = start;
    while (parent[root] !== root) root = parent[root];
    for (let i = start; parent[i] !== root; ) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // 1. Identity. Acting on something an earlier op created is not a preference
  //    about layout, it is the op having a subject at all.
  const producer = new Map<string, number>();
  ops.forEach((op, i) => {
    for (const name of produces(op)) if (!producer.has(name)) producer.set(name, i);
  });
  ops.forEach((op, i) => {
    for (const name of consumes(op)) {
      const p = producer.get(name);
      if (p !== undefined && p !== i) union(p, i);
    }
  });

  // 2. One block, one decision. Two rewrites of the same paragraph are one
  //    thought, and a diagram half of whose shapes were kept is a diagram nobody
  //    authored — both fall out of grouping by the block an op addresses.
  const first = new Map<string, number>();
  ops.forEach((op, i) => {
    const id = target(op);
    if (id === undefined) return;
    const seen = first.get(id);
    if (seen === undefined) first.set(id, i);
    else union(seen, i);
  });

  // 3. Replacement. Folding four paragraphs into a table is one insert and four
  //    removals, and offering it as five decisions offers the user a document
  //    with the table and the paragraphs both in it. Contiguity with the spot
  //    the insert landed on is what identifies the run being replaced — grown
  //    outward, so the whole run comes along rather than only its ends.
  //
  //    Grown over SIBLINGS, not over the flattened document: a removed block's
  //    own children sit between it and the next block at its level, so a walk
  //    one flat slot at a time stops at the first nested item and splits a fold
  //    across a nested list into hunks that make no sense apart.
  const place = positions(before);
  const removalOf = new Map<string, number>();
  ops.forEach((op, i) => {
    if (op.kind === "removeBlock") removalOf.set(op.blockId, i);
  });
  ops.forEach((op, i) => {
    if (op.kind !== "insertBlocks") return;
    const anchor = trace[i]?.anchor;
    if (!anchor) return;
    const spot = place.get(anchor.ref);
    // The insert hangs off a block this same turn made; there is no run of
    // existing blocks around it to have replaced.
    if (!spot) return;
    const gap = anchor.placement === "after" ? spot.at + 1 : spot.at;
    const grow = (from: number, step: number) => {
      for (let k = from; k >= 0 && k < spot.siblings.length; k += step) {
        const removal = removalOf.get(spot.siblings[k]);
        if (removal === undefined) return;
        union(i, removal);
      }
    };
    grow(gap - 1, -1);
    grow(gap, 1);
  });

  // 4. Lifting out. The vocabulary has no op for changing a block's type, so a
  //    retype compiles to an insert, its children carried across one move at a
  //    time, and a removal. Those moves are not preferences about layout — the
  //    children are only going anywhere because what held them is going — so
  //    each belongs to the removal it was lifted out of, and through it to
  //    whatever took its place.
  ops.forEach((op, i) => {
    if (op.kind !== "moveBlock") return;
    for (let up = place.get(op.blockId)?.parent; up; up = place.get(up)?.parent) {
      const removal = removalOf.get(up);
      if (removal === undefined) continue;
      union(removal, i);
      return;
    }
  });

  // 5. Declared replacement. `replacing` names the blocks a rewrite consumes, so
  //    what it wrote and what it consumed are one decision — a relation the
  //    caller stated outright. Step 3 can only see it when the replacement is an
  //    insert; a fold that rewrites one of the blocks in place has no insert for
  //    the removals to be adjacent to.
  //
  //    Per declaration, and per contiguous run within it: a declared set is not
  //    an interval. Two folds at opposite ends of a page are two decisions, and
  //    an unrelated edit that merely sits between them is a third.
  for (const declaration of replacing ?? []) {
    for (const run of contiguous(declaration, place)) {
      let root: number | undefined;
      ops.forEach((op, i) => {
        // An insert is part of the fold when it is written where one of the
        // consumed blocks stands; elsewhere it is its own change.
        const id = op.kind === "insertBlocks" ? trace[i]?.anchor?.ref : target(op);
        if (id === undefined || !run.has(id)) return;
        if (root === undefined) root = i;
        else union(root, i);
      });
    }
  }

  const groups = new Map<number, number[]>();
  ops.forEach((_, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(i);
    else groups.set(root, [i]);
  });

  const existed = new Set(place.keys());
  return [...groups.values()]
    .sort((a, b) => a[0] - b[0])
    .map((opIndices) => {
      const change = changeOf(opIndices, trace, existed);
      return {
        id: hunkId(chatPromptId, pageId, opIndices),
        kind: kindOf(opIndices, ops, change.added.length > 0, change.removed.length > 0),
        opIndices,
        ...change,
      };
    });
}

function changeOf(
  opIndices: number[],
  trace: OpTrace[],
  existed: ReadonlySet<string>,
): Change {
  const added: string[] = [];
  const removed: AnyBlock[] = [];
  const changed: string[] = [];
  const moved: string[] = [];
  const note = (into: string[], ids: string[] | undefined) => {
    for (const id of ids ?? []) if (existed.has(id) && !into.includes(id)) into.push(id);
  };
  for (const i of opIndices) {
    for (const block of trace[i]?.produced ?? []) {
      for (const flat of flattenBlocks([block])) added.push(flat.id);
    }
    removed.push(...(trace[i]?.removed ?? []));
    note(changed, trace[i]?.touched);
    note(moved, trace[i]?.moved);
  }
  return { added, removed, changed, moved };
}

/**
 * Where a block sat in the checkpoint: its place in the document, among its
 * siblings, what held it, and where its own subtree ends.
 */
type Seat = {
  index: number;
  siblings: string[];
  at: number;
  end: number;
  parent?: string;
};

function positions(blocks: AnyBlock[]): Map<string, Seat> {
  const out = new Map<string, Seat>();
  let index = 0;
  const walk = (level: AnyBlock[], parent?: string) => {
    const siblings = level.map((b) => b.id);
    level.forEach((block, at) => {
      const seat: Seat = { index: index++, siblings, at, end: index, parent };
      out.set(block.id, seat);
      if (block.children?.length) walk(block.children, block.id);
      seat.end = index;
    });
  };
  walk(blocks);
  return out;
}

/**
 * Declared ids grouped into the runs of the document they form. A block's own
 * subtree counts as part of it, so naming a list and the item under it is one
 * run rather than two.
 */
function contiguous(declared: string[], place: Map<string, Seat>): Set<string>[] {
  const seated = declared
    .flatMap((id) => {
      const seat = place.get(id);
      return seat ? [{ id, ...seat }] : [];
    })
    .sort((a, b) => a.index - b.index);

  const runs: Set<string>[] = [];
  let end = -1;
  for (const block of seated) {
    if (block.index > end) runs.push(new Set());
    runs[runs.length - 1].add(block.id);
    end = Math.max(end, block.end);
  }
  return runs;
}

function kindOf(
  opIndices: number[],
  ops: Operation[],
  adds: boolean,
  removes: boolean,
): HunkKind {
  if (adds && removes) return "replace";
  if (adds) return "insert";
  if (removes) return "remove";
  if (opIndices.every((i) => ops[i].kind === "moveBlock")) return "move";
  return "update";
}

/**
 * Stable across a replay, because a replay changes neither the turn nor which
 * ops belong together. The page is in there because a turn can edit several,
 * and their op lists are numbered independently.
 */
function hunkId(chatPromptId: string, pageId: string, opIndices: number[]): string {
  const key = `${chatPromptId}:${pageId}:${opIndices.join(",")}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `h${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
