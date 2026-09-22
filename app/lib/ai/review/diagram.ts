import { migrateLegacyCanvas } from "@/app/components/editor/canvas/scene/migrate";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import {
  isContainer,
  walk,
  type NodeId,
  type Scene,
  type SceneEdge,
  type SceneNode,
} from "@/app/components/editor/canvas/scene/types";

/**
 * Taking back a diagram change at the grain the maps keep it: per shape.
 *
 * An agent edits a diagram the only way it can — one whole-HTML
 * `updateBlockProps` — so a hunk on a canvas block names a whole diagram, and
 * undoing it used to write the checkpoint's whole `data` prop back. That prop
 * is the diagram's mirror, and an external HTML write on it diffs INTO the
 * per-shape maps, so the rewrite took the shapes the person moved while they
 * were reading back with it. They had no undo step spanning that (NT-70).
 *
 * The maps are per-shape so that two authors merge, and this is the one writer
 * that was not speaking their language. So the answer is a three-way merge
 * against what the agent actually proposed: shapes it added go, shapes it
 * rewrote go back to the checkpoint, shapes it deleted come back where the
 * checkpoint had them, and a shape it never touched is not written at all.
 *
 * A shape the person moved after the agent had touched it is theirs, exactly as
 * a paragraph they retyped is (`isKept` in session.ts): it differs from what
 * the agent left, so it stays as it stands rather than being written over with
 * work nobody asked to lose.
 *
 * What this does not restore is a pure permutation — a change that only moved a
 * shape up or down the z-order comes back in the order the diagram now has.
 * Document order is the one part of a scene the maps hold as a fractional key
 * per shape rather than as a value, and reordering to the checkpoint would
 * speak for shapes the change never named.
 */

/** Whole HTML in, whole HTML out; the caller writes it onto the block prop. */
export function takeBackDiagram(
  checkpoint: string,
  proposal: string,
  live: string,
): string {
  const was = migrateLegacyCanvas(checkpoint);
  const asked = migrateLegacyCanvas(proposal);
  const now = migrateLegacyCanvas(live);

  const wasAt = index(was);
  const askedAt = index(asked);
  const nowAt = index(now);

  // What the change itself did — the only part an undo may speak for.
  const added = new Set(
    [...askedAt.nodes.keys()].filter((id) => !wasAt.nodes.has(id)),
  );
  const deleted = [...wasAt.nodes.keys()].filter((id) => !askedAt.nodes.has(id));

  // A shape the person drew inside a group the change added is theirs, and it
  // comes out where the group was holding it rather than going with it — a
  // child's box is relative to the group's, so it is offset by what it loses.
  const lifted = new Map<NodeId, { x: number; y: number }>();

  const build = (parent: NodeId | null): SceneNode[] => {
    const ids = (nowAt.kids.get(parent) ?? []).flatMap((id) =>
      added.has(id) ? rescue(id, added, nowAt, lifted, { x: 0, y: 0 }) : [id],
    );

    // Back where the checkpoint had them, each anchored on what still stands
    // around it — a run that went together comes back together.
    for (const id of deleted) {
      if (wasAt.parent.get(id) !== parent || nowAt.nodes.has(id)) continue;
      ids.splice(seatFor(id, wasAt.kids.get(parent) ?? [], ids), 0, id);
    }

    return ids.flatMap((id) => {
      const node = revert(wasAt.nodes.get(id), askedAt.nodes.get(id), nowAt.nodes.get(id));
      if (!node) return [];
      const out = isContainer(node) ? { ...node, children: build(id) } : node;
      const shift = lifted.get(id);
      return [shift ? { ...out, x: out.x + shift.x, y: out.y + shift.y } : out];
    });
  };

  const scene: Scene = {
    ...pick(was, asked, now),
    nodes: build(null),
    edges: edgesOf(was, asked, now),
  };
  return serializeScene(scene);
}

/**
 * Whether a change is still on the diagram — the question `restage` asks of a
 * whole-value prop write before deciding the fork died with its editor, and
 * re-applies the whole thing.
 *
 * String equality cannot answer it here. The prop is a mirror that trails the
 * maps by up to `MIRROR_MS`, so the moment anyone moves any shape it stops
 * matching what the agent wrote, and re-applying the agent's whole diagram then
 * writes that person's move away (NT-70).
 *
 * A fork that died takes everything staged in it, the person's own edits
 * included, so the diagram it leaves is the checkpoint's exactly. Anything else
 * — the change still there, or work of theirs that is not in the checkpoint —
 * means the fork it was staged in is alive and there is nothing to re-stage.
 *
 * Two shapes it cannot tell apart from a dead fork, both by construction: a
 * diagram whose only edit since was deleting exactly what the change added, and
 * one a collaborator has changed in the shared doc since (a fork's canvas never
 * sees those, so they arrive looking like work nobody here did). The first
 * re-stages a shape the person took out; the second does not re-stage, and its
 * hunks settle as superseded through the usual paths.
 */
export function diagramStanding(
  checkpoint: string,
  proposal: string,
  live: string,
): boolean {
  const back = takeBackDiagram(checkpoint, proposal, live);
  return (
    back !== serializeScene(migrateLegacyCanvas(live)) ||
    back !== serializeScene(migrateLegacyCanvas(checkpoint))
  );
}

type Indexed = {
  nodes: Map<NodeId, SceneNode>;
  parent: Map<NodeId, NodeId | null>;
  kids: Map<NodeId | null, NodeId[]>;
};

function index(scene: Scene): Indexed {
  const nodes = new Map<NodeId, SceneNode>();
  const parent = new Map<NodeId, NodeId | null>();
  const kids = new Map<NodeId | null, NodeId[]>();
  walk(scene.nodes, (node, held) => {
    const under = held?.id ?? null;
    nodes.set(node.id, node);
    parent.set(node.id, under);
    kids.set(under, [...(kids.get(under) ?? []), node.id]);
  });
  return { nodes, parent, kids };
}

/**
 * One shape's answer. `asked === now` means nobody has touched it since the
 * change left it, so the checkpoint's is written back; anything else is the
 * person's own work and stands.
 */
function revert(
  was: SceneNode | undefined,
  asked: SceneNode | undefined,
  now: SceneNode | undefined,
): SceneNode | undefined {
  return same(asked, now) ? was : now;
}

/** Deep equality on a node's own fields — its subtree is answered separately. */
function same(a: SceneNode | undefined, b: SceneNode | undefined): boolean {
  return JSON.stringify(shallow(a)) === JSON.stringify(shallow(b));
}

function shallow(node: SceneNode | undefined) {
  if (!node) return null;
  return isContainer(node) ? { ...node, children: [] } : node;
}

/**
 * Shapes standing under a node the change added, which it did not add, and how
 * far each has to move to stay where it looks.
 */
function rescue(
  id: NodeId,
  added: ReadonlySet<NodeId>,
  now: Indexed,
  lifted: Map<NodeId, { x: number; y: number }>,
  origin: { x: number; y: number },
): NodeId[] {
  const holder = now.nodes.get(id);
  if (!holder) return [];
  const at = { x: origin.x + holder.x, y: origin.y + holder.y };
  const out: NodeId[] = [];
  for (const child of now.kids.get(id) ?? []) {
    if (added.has(child)) {
      out.push(...rescue(child, added, now, lifted, at));
      continue;
    }
    lifted.set(child, at);
    out.push(child);
  }
  return out;
}

/**
 * Where something the change took out goes back among what still stands.
 *
 * On the nearest neighbour the checkpoint gave it that is still there — behind
 * it by preference, so a run restored in checkpoint order chains onto itself
 * and comes back in its own order. With no neighbour left at all the checkpoint
 * says nothing about where it sits among these, and it goes to the back: what
 * the person drew during the review was drawn on top of it.
 */
function seatFor(id: string, siblings: readonly string[], standing: readonly string[]): number {
  const at = siblings.indexOf(id);
  for (let i = at - 1; i >= 0; i--) {
    const seat = standing.indexOf(siblings[i]);
    if (seat >= 0) return seat + 1;
  }
  for (let i = at + 1; i < siblings.length; i++) {
    const seat = standing.indexOf(siblings[i]);
    if (seat >= 0) return seat;
  }
  return 0;
}

/** The surface's own fields, each on the same terms as a shape. */
function pick(was: Scene, asked: Scene, now: Scene) {
  const surface = (scene: Scene) => ({
    w: scene.w,
    h: scene.h,
    style: scene.style,
    attrs: scene.attrs,
    ...(scene.id !== undefined ? { id: scene.id } : {}),
  });
  return JSON.stringify(surface(asked)) === JSON.stringify(surface(now))
    ? surface(was)
    : surface(now);
}

/** Connectors, on the same three terms as the shapes they join. */
function edgesOf(was: Scene, asked: Scene, now: Scene): SceneEdge[] {
  const by = (scene: Scene) => new Map(scene.edges.map((edge) => [edge.id, edge]));
  const wasEdges = by(was);
  const askedEdges = by(asked);
  const nowEdges = by(now);
  const added = new Set([...askedEdges.keys()].filter((id) => !wasEdges.has(id)));

  const standing = now.edges
    .filter((edge) => !added.has(edge.id))
    .map((edge) => {
      const before = wasEdges.get(edge.id);
      const untouched =
        JSON.stringify(askedEdges.get(edge.id)) === JSON.stringify(edge);
      return untouched && before ? before : edge;
    });

  const order = was.edges.map((edge) => edge.id);
  for (const edge of was.edges) {
    if (askedEdges.has(edge.id) || nowEdges.has(edge.id)) continue;
    const seat = seatFor(edge.id, order, standing.map((live) => live.id));
    standing.splice(seat, 0, edge);
  }
  return standing;
}
