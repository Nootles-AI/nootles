import { isAutoLayout } from "@/app/components/editor/canvas/scene/autoLayout";
import { blocksToLabel, labelBlocks, textToLabel } from "@/app/components/editor/canvas/scene/label";
import { applyOps, duplicateNodes, mintId } from "@/app/components/editor/canvas/scene/ops";
import {
  findNode,
  findParent,
  isContainer,
  isGroup,
  type BooleanOp,
  type NodeId,
  type Scene,
  type SceneOp,
  type ZTarget,
} from "@/app/components/editor/canvas/scene/types";
import { isRefusal, refused, type Refusal } from "./host";

/**
 * The nine thin verbs, sent together as `canvas_edit`'s `ops` (NT-92). Each
 * compiles to a small, fixed number of {@link SceneOp}s and returns a report
 * the executor turns into one line of model-facing text; {@link planEdits}
 * folds a whole list into one scene, so a call is one reviewable change and
 * one round trip however many shapes it touches.
 */

export type Verb =
  | { op: "set_text"; id: string; text: string; markup?: boolean }
  | { op: "rename"; id: string; name: string | null }
  | { op: "duplicate"; ids: string[]; offset?: number }
  | { op: "move"; ids: string[]; dx?: number; dy?: number; x?: number; y?: number }
  | { op: "delete"; ids: string[] }
  | {
      op: "reorder";
      ids: string[];
      to: "front" | "back" | "forward" | "backward" | { parent: string | null; index: number };
    }
  | { op: "group"; ids: string[]; name?: string; boolean?: BooleanOp }
  | { op: "ungroup"; ids: string[] }
  | { op: "flip"; ids: string[]; axis: "horizontal" | "vertical" };

export type VerbPlan = {
  ops: SceneOp[];
  next: Scene;
  result: Record<string, unknown>;
  summary: string;
  /** Non-fatal caveats worth relaying — e.g. a `reorder` an auto-layout
   *  group places by flow rather than by screen position. */
  notes?: string[];
};

/** The ids a verb mints are in its summary line, so the list's plan carries
 *  no separate result. */
export type EditsPlan = Omit<VerbPlan, "result">;

const NOT_APPLIED = "That change was not applied, and nothing on the diagram changed.";

function unknownId(id: string): Refusal {
  return refused(`This diagram has no shape or connector with id "${id}".`);
}

function nodeExists(scene: Scene, id: string): boolean {
  return findNode(scene, id) !== null;
}

function edgeOf(scene: Scene, id: string) {
  return scene.edges.find((e) => e.id === id) ?? null;
}

/** One plan for a list of verbs, each planned against the scene the ones
 *  before it left. All or nothing: a refused verb refuses the whole list,
 *  named by its place in it, and nothing lands. */
export function planEdits(scene: Scene, verbs: Verb[]): EditsPlan | Refusal {
  const ops: SceneOp[] = [];
  const summaries: string[] = [];
  const notes: string[] = [];
  let next = scene;
  for (const [i, verb] of verbs.entries()) {
    const plan = planVerb(next, verb);
    if (isRefusal(plan)) {
      if (verbs.length === 1) return refused(`${NOT_APPLIED} ${plan.refused}`);
      return refused(
        `None of these ${verbs.length} edits was applied, and nothing on the diagram changed. ` +
          `Edit ${i + 1} (${verb.op}) was refused: ${plan.refused}`,
      );
    }
    ops.push(...plan.ops);
    summaries.push(plan.summary);
    notes.push(...(plan.notes ?? []));
    next = plan.next;
  }
  if (verbs.length === 1) return { ops, next, summary: summaries[0], ...(notes.length ? { notes } : {}) };
  return {
    ops,
    next,
    summary: [
      `Done: ${verbs.length} edits, as one change.`,
      ...summaries.map((line, i) => `${i + 1}. ${line.replace(/^Done: /, "")}`),
    ].join("\n"),
    ...(notes.length ? { notes } : {}),
  };
}

export function planVerb(scene: Scene, verb: Verb): VerbPlan | Refusal {
  switch (verb.op) {
    case "set_text":
      return planSetText(scene, verb);
    case "rename":
      return planRename(scene, verb);
    case "duplicate":
      return planDuplicate(scene, verb);
    case "move":
      return planMove(scene, verb);
    case "delete":
      return planDelete(scene, verb);
    case "reorder":
      return planReorder(scene, verb);
    case "group":
      return planGroup(scene, verb);
    case "ungroup":
      return planUngroup(scene, verb);
    case "flip":
      return planFlip(scene, verb);
  }
}

function landed(scene: Scene, ops: SceneOp[], result: Record<string, unknown>, summary: string, notes?: string[]): VerbPlan {
  const next = applyOps(scene, ops);
  return { ops, next, result, summary, ...(notes?.length ? { notes } : {}) };
}

function planSetText(scene: Scene, verb: Extract<Verb, { op: "set_text" }>): VerbPlan | Refusal {
  const node = findNode(scene, verb.id);
  if (node) {
    if (node.kind === "group" || node.kind === "image" || node.kind === "path") {
      const noun = node.kind === "image" ? "a picture" : `a ${node.kind}`;
      return refused(
        `"${verb.id}" is ${noun} and holds no words. Put an <nt-text> beside it with write_nodes, or label the shape it sits on.`,
      );
    }
    const label = verb.markup ? blocksToLabel(labelBlocks(verb.text)) : textToLabel(verb.text);
    return landed(
      scene,
      [{ type: "setLabel", id: verb.id, label }],
      {},
      `Done: "${verb.id}" now reads "${verb.text}".`,
    );
  }
  const edge = edgeOf(scene, verb.id);
  if (!edge) return unknownId(verb.id);
  return landed(
    scene,
    [{ type: "setEdgeLabel", id: verb.id, label: verb.text }],
    {},
    `Done: "${verb.id}" now reads "${verb.text}".`,
  );
}

function planRename(scene: Scene, verb: Extract<Verb, { op: "rename" }>): VerbPlan | Refusal {
  if (!nodeExists(scene, verb.id)) return unknownId(verb.id);
  return landed(
    scene,
    [{ type: "setName", id: verb.id, name: verb.name ?? undefined }],
    {},
    verb.name === null
      ? `Done: "${verb.id}" has no explicit name any more.`
      : `Done: "${verb.id}" is now named "${verb.name}".`,
  );
}

function planDuplicate(scene: Scene, verb: Extract<Verb, { op: "duplicate" }>): VerbPlan | Refusal {
  for (const id of verb.ids) if (!nodeExists(scene, id)) return unknownId(id);
  const { scene: next, ids: copies } = duplicateNodes(scene, verb.ids, verb.offset);
  if (!copies.length) {
    return landed(scene, [], { copies: [] }, "Nothing to do — the diagram already reads that way.");
  }
  // Read the ops back out of the scene the op layer already built — see
  // `ContextMenu.tsx`'s `duplicate`, which this mirrors exactly.
  const ops: SceneOp[] = copies.map((id) => {
    const parent = findParent(next, id);
    const siblings = parent && isContainer(parent) ? parent.children : next.nodes;
    return {
      type: "insert" as const,
      nodes: [findNode(next, id)!],
      parentId: parent?.id ?? null,
      index: siblings.findIndex((n) => n.id === id),
    };
  });
  return {
    ops,
    next,
    result: { copies },
    summary: `Done: ${copies.length} cop${copies.length === 1 ? "y" : "ies"} made (${copies.join(", ")}).`,
  };
}

function planMove(scene: Scene, verb: Extract<Verb, { op: "move" }>): VerbPlan | Refusal {
  for (const id of verb.ids) if (!nodeExists(scene, id)) return unknownId(id);
  const hasDelta = verb.dx !== undefined || verb.dy !== undefined;
  const hasAbsolute = verb.x !== undefined || verb.y !== undefined;
  if (hasDelta && hasAbsolute) {
    return refused(`Move by a distance (dx/dy) or to a position (x/y), not both.`);
  }
  for (const id of verb.ids) {
    const parent = findParent(scene, id);
    if (parent && isAutoLayout(parent)) {
      return refused(
        `"${id}" is placed by "${parent.id}"'s layout — a flex or grid group's own children cannot be moved directly; reorder it instead.`,
      );
    }
  }
  if (hasAbsolute) {
    const ops: SceneOp[] = verb.ids.map((id) => {
      const node = findNode(scene, id)!;
      const dx = verb.x !== undefined ? verb.x - node.x : 0;
      const dy = verb.y !== undefined ? verb.y - node.y : 0;
      return { type: "move" as const, ids: [id], dx, dy };
    });
    const single = verb.ids.length === 1 ? findNode(scene, verb.ids[0])! : null;
    const summary = single
      ? `Done: moved "${verb.ids[0]}" to (${verb.x ?? single.x}, ${verb.y ?? single.y}).`
      : `Done: moved ${verb.ids.length} shapes.`;
    return landed(scene, ops, {}, summary);
  }
  const dx = verb.dx ?? 0;
  const dy = verb.dy ?? 0;
  return landed(
    scene,
    [{ type: "move", ids: verb.ids, dx, dy }],
    {},
    `Done: moved ${verb.ids.length} shape${verb.ids.length === 1 ? "" : "s"} by (${dx}, ${dy}).`,
  );
}

function planDelete(scene: Scene, verb: Extract<Verb, { op: "delete" }>): VerbPlan | Refusal {
  const nodeIds: NodeId[] = [];
  const edgeIds: string[] = [];
  for (const id of verb.ids) {
    if (nodeExists(scene, id)) nodeIds.push(id);
    else if (edgeOf(scene, id)) edgeIds.push(id);
    else return unknownId(id);
  }
  const ops: SceneOp[] = [
    ...(nodeIds.length ? [{ type: "remove" as const, ids: nodeIds }] : []),
    ...(edgeIds.length ? [{ type: "removeEdge" as const, ids: edgeIds }] : []),
  ];
  const parts = [
    nodeIds.length && `${nodeIds.length} shape${nodeIds.length === 1 ? "" : "s"}`,
    edgeIds.length && `${edgeIds.length} connector${edgeIds.length === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return landed(scene, ops, {}, `Done: removed ${parts.join(", ")}.`);
}

function planReorder(scene: Scene, verb: Extract<Verb, { op: "reorder" }>): VerbPlan | Refusal {
  for (const id of verb.ids) {
    if (edgeOf(scene, id)) {
      return refused(`"${id}" is a connector; reorder only takes shapes.`);
    }
    if (!nodeExists(scene, id)) return unknownId(id);
  }
  let to: ZTarget;
  let destinationParent: NodeId | null;
  if (typeof verb.to === "string") {
    to = { at: verb.to };
    // The relative forms move a node within its OWN current parent.
    destinationParent = findParent(scene, verb.ids[0])?.id ?? null;
  } else {
    if (verb.to.parent !== null) {
      const parent = findNode(scene, verb.to.parent);
      if (!parent || !isGroup(parent)) {
        return refused(`"${verb.to.parent}" is not a group on this diagram.`);
      }
      for (const id of verb.ids) {
        if (verb.to.parent === id) {
          return refused(`A group cannot be placed inside itself.`);
        }
      }
    }
    to = { at: "index", parentId: verb.to.parent, index: verb.to.index };
    destinationParent = verb.to.parent;
  }
  const parentNode = destinationParent ? findNode(scene, destinationParent) : null;
  const notes =
    parentNode && isGroup(parentNode) && isAutoLayout(parentNode)
      ? verb.ids.map(
          (id) => `${destinationParent} has a layout; ${id} is now placed by its flow, not by screen position.`,
        )
      : undefined;
  return landed(
    scene,
    [{ type: "reorder", ids: verb.ids, to }],
    {},
    `Done: reordered ${verb.ids.length} shape${verb.ids.length === 1 ? "" : "s"}.`,
    notes,
  );
}

function planGroup(scene: Scene, verb: Extract<Verb, { op: "group" }>): VerbPlan | Refusal {
  for (const id of verb.ids) {
    if (edgeOf(scene, id)) {
      return refused(`"${id}" is a connector; group only takes shapes.`);
    }
    if (!nodeExists(scene, id)) return unknownId(id);
  }
  if (verb.boolean && verb.ids.length < 2) {
    return refused(`A boolean needs two shapes.`);
  }
  const groupId = mintId(scene);
  const op: SceneOp = { type: "group", ids: verb.ids, groupId, name: verb.name, op: verb.boolean };
  const next = applyOps(scene, [op]);
  const absorbed = verb.ids.find((id) => findNode(next, id) === null);
  const notes = absorbed ? [`${absorbed} became the group's own box and paint.`] : undefined;
  return {
    ops: [op],
    next,
    result: { groupId },
    summary: `Done: grouped ${verb.ids.length} shape${verb.ids.length === 1 ? "" : "s"} as "${groupId}".`,
    ...(notes ? { notes } : {}),
  };
}

function planUngroup(scene: Scene, verb: Extract<Verb, { op: "ungroup" }>): VerbPlan | Refusal {
  const notes: string[] = [];
  for (const id of verb.ids) {
    const node = findNode(scene, id);
    if (!node) return unknownId(id);
    if (!isGroup(node)) {
      return refused(`"${id}" is not a group.`);
    }
    if (isAutoLayout(node)) {
      notes.push(`children of ${id}, a flex or grid group, land at the group's origin.`);
    }
  }
  return landed(
    scene,
    [{ type: "ungroup", ids: verb.ids }],
    {},
    `Done: ungrouped ${verb.ids.length} group${verb.ids.length === 1 ? "" : "s"}.`,
    notes,
  );
}

function planFlip(scene: Scene, verb: Extract<Verb, { op: "flip" }>): VerbPlan | Refusal {
  for (const id of verb.ids) {
    if (edgeOf(scene, id)) {
      return refused(`"${id}" is a connector; it follows the shapes it joins, so flip those.`);
    }
    if (!nodeExists(scene, id)) return unknownId(id);
  }
  const n = verb.ids.length;
  return landed(
    scene,
    [{ type: "flip", ids: verb.ids, axis: verb.axis === "horizontal" ? "x" : "y" }],
    {},
    `Done: flipped ${n} shape${n === 1 ? "" : "s"} ${verb.axis === "horizontal" ? "horizontally" : "vertically"}.`,
  );
}
