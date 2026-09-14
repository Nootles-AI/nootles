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
import { refused, type Refusal } from "./host";

/**
 * The eight thin verbs — "one call, one thing" (TOOLS.md §5.6). Each compiles
 * to a small, fixed number of {@link SceneOp}s and returns a report the
 * executor turns into one line of model-facing text.
 */

export type Verb =
  | { verb: "set_text"; id: string; text: string; markup?: boolean }
  | { verb: "rename"; id: string; name: string | null }
  | { verb: "duplicate"; ids: string[]; offset?: number }
  | { verb: "move"; ids: string[]; dx?: number; dy?: number; x?: number; y?: number }
  | { verb: "delete"; ids: string[] }
  | {
      verb: "reorder";
      ids: string[];
      to: "front" | "back" | "forward" | "backward" | { parent: string | null; index: number };
    }
  | { verb: "group"; ids: string[]; name?: string; op?: BooleanOp }
  | { verb: "ungroup"; ids: string[] };

export type VerbPlan = {
  ops: SceneOp[];
  next: Scene;
  result: Record<string, unknown>;
  summary: string;
  /** Non-fatal caveats worth relaying — e.g. a `reorder` an auto-layout
   *  group places by flow rather than by screen position. */
  notes?: string[];
};

const NOT_APPLIED = "That change was not applied, and nothing on the diagram changed.";

function unknownId(id: string): Refusal {
  return refused(`${NOT_APPLIED} This diagram has no shape or connector with id "${id}".`);
}

function nodeExists(scene: Scene, id: string): boolean {
  return findNode(scene, id) !== null;
}

function edgeOf(scene: Scene, id: string) {
  return scene.edges.find((e) => e.id === id) ?? null;
}

export function planVerb(scene: Scene, verb: Verb): VerbPlan | Refusal {
  switch (verb.verb) {
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
  }
}

function landed(scene: Scene, ops: SceneOp[], result: Record<string, unknown>, summary: string, notes?: string[]): VerbPlan {
  const next = applyOps(scene, ops);
  return { ops, next, result, summary, ...(notes?.length ? { notes } : {}) };
}

function planSetText(scene: Scene, verb: Extract<Verb, { verb: "set_text" }>): VerbPlan | Refusal {
  const node = findNode(scene, verb.id);
  if (node) {
    if (node.kind === "group" || node.kind === "image" || node.kind === "path") {
      const noun = node.kind === "image" ? "a picture" : `a ${node.kind}`;
      return refused(
        `${NOT_APPLIED} "${verb.id}" is ${noun} and holds no words. Put an <nt-text> beside it with write_nodes, or label the shape it sits on.`,
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

function planRename(scene: Scene, verb: Extract<Verb, { verb: "rename" }>): VerbPlan | Refusal {
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

function planDuplicate(scene: Scene, verb: Extract<Verb, { verb: "duplicate" }>): VerbPlan | Refusal {
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

function planMove(scene: Scene, verb: Extract<Verb, { verb: "move" }>): VerbPlan | Refusal {
  for (const id of verb.ids) if (!nodeExists(scene, id)) return unknownId(id);
  const hasDelta = verb.dx !== undefined || verb.dy !== undefined;
  const hasAbsolute = verb.x !== undefined || verb.y !== undefined;
  if (hasDelta && hasAbsolute) {
    return refused(`${NOT_APPLIED} Move by a distance (dx/dy) or to a position (x/y), not both.`);
  }
  for (const id of verb.ids) {
    const parent = findParent(scene, id);
    if (parent && isAutoLayout(parent)) {
      return refused(
        `${NOT_APPLIED} "${id}" is placed by "${parent.id}"'s layout — a flex or grid group's own children cannot be moved directly; reorder it instead.`,
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

function planDelete(scene: Scene, verb: Extract<Verb, { verb: "delete" }>): VerbPlan | Refusal {
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

function planReorder(scene: Scene, verb: Extract<Verb, { verb: "reorder" }>): VerbPlan | Refusal {
  for (const id of verb.ids) {
    if (edgeOf(scene, id)) {
      return refused(`${NOT_APPLIED} "${id}" is a connector; reorder only takes shapes.`);
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
        return refused(`${NOT_APPLIED} "${verb.to.parent}" is not a group on this diagram.`);
      }
      for (const id of verb.ids) {
        if (verb.to.parent === id) {
          return refused(`${NOT_APPLIED} A group cannot be placed inside itself.`);
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

function planGroup(scene: Scene, verb: Extract<Verb, { verb: "group" }>): VerbPlan | Refusal {
  for (const id of verb.ids) {
    if (edgeOf(scene, id)) {
      return refused(`${NOT_APPLIED} "${id}" is a connector; group only takes shapes.`);
    }
    if (!nodeExists(scene, id)) return unknownId(id);
  }
  if (verb.op && verb.ids.length < 2) {
    return refused(`${NOT_APPLIED} A boolean needs two shapes.`);
  }
  const groupId = mintId(scene);
  const op: SceneOp = { type: "group", ids: verb.ids, groupId, name: verb.name, op: verb.op };
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

function planUngroup(scene: Scene, verb: Extract<Verb, { verb: "ungroup" }>): VerbPlan | Refusal {
  const notes: string[] = [];
  for (const id of verb.ids) {
    const node = findNode(scene, id);
    if (!node) return unknownId(id);
    if (!isGroup(node)) {
      return refused(`${NOT_APPLIED} "${id}" is not a group.`);
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
