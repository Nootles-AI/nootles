import { adoptScene } from "@/app/components/editor/canvas/scene/adopt";
import { bandHeight, bandWidth, fitOps } from "@/app/components/editor/canvas/scene/band";
import {
  applyOp,
  applyOps,
  mintEdgeIds,
  mintIds,
  reflowHugs,
} from "@/app/components/editor/canvas/scene/ops";
import type { Fragment } from "@/app/components/editor/canvas/scene/parse";
import { isAutoLayout } from "@/app/components/editor/canvas/scene/autoLayout";
import {
  findNode,
  findParent,
  hasText,
  isGroup,
  nodePath,
  walk,
  type EdgeId,
  type NodeId,
  type Scene,
  type SceneNode,
  type SceneNodeKind,
  type SceneOp,
  type ShapeParams,
} from "@/app/components/editor/canvas/scene/types";
import { refused, type Refusal } from "./host";

/**
 * `write_nodes`' planner — the compiler from "a few `<nt-…>` elements" to the
 * exact `SceneOp[]` a human editing the same diagram by hand would have
 * produced. Pure: takes a {@link Scene} and a parsed {@link Fragment}, returns
 * a plan or a {@link Refusal}. `execute.ts` is the only caller, and it is the
 * only thing that ever turns `plan.next` into a real write.
 *
 * See TOOLS.md §5.4 for the full behaviour table (W1–W24) this file is
 * written against.
 */

export type Anchor =
  | { after: string }
  | { before: string }
  | { inside: string | null };

export type WritePlan = {
  ops: SceneOp[];
  next: Scene;
  inserted: NodeId[];
  updated: NodeId[];
  removed: string[];
  edgesAdded: EdgeId[];
  edgesUpdated: EdgeId[];
  edgesRemoved: EdgeId[];
  /** Fragment id (as parsed) → id it landed under in the diagram, for every
   *  node or edge this call reminted. */
  minted: Record<string, string>;
  /** Non-fatal remarks the model should relay — never a reason not to apply. */
  notes: string[];
};

const KIND_NOUN: Record<SceneNodeKind, string> = {
  rect: "rectangle",
  ellipse: "ellipse",
  polygon: "polygon",
  text: "text",
  image: "image",
  path: "path",
  group: "group",
};

/** One node's outward-facing id, whether the fragment named it or this call
 *  minted a fresh one. */
type Resolved = { id: NodeId; node: SceneNode; existing: boolean };

export function planWriteNodes(
  scene: Scene,
  fragment: Fragment,
  opts: { removing?: readonly string[]; at?: Anchor } = {},
): WritePlan | Refusal {
  const frag = adoptScene(fragment.scene);
  const removing = opts.removing ?? [];

  // ---- Step 2: classify + remint --------------------------------------
  const isExistingNode = (id: NodeId) =>
    fragment.authored.has(id) && findNode(scene, id) !== null;
  const isExistingEdge = (id: EdgeId) =>
    fragment.authored.has(id) && scene.edges.some((e) => e.id === id);

  const minted: Record<string, string> = {};
  const nodeMintOrder: NodeId[] = [];
  const edgeMintOrder: EdgeId[] = [];
  collectMintOrder(frag.nodes, fragment.authored, nodeMintOrder);
  for (const edge of frag.edges) {
    if (!fragment.authored.has(edge.id)) edgeMintOrder.push(edge.id);
  }
  const freshNodeIds = mintIds(scene, nodeMintOrder.length);
  const freshEdgeIds = mintEdgeIds(scene, edgeMintOrder.length);
  nodeMintOrder.forEach((fragId, i) => (minted[fragId] = freshNodeIds[i]));
  edgeMintOrder.forEach((fragId, i) => (minted[fragId] = freshEdgeIds[i]));

  const resolvedNodes = frag.nodes.map((n) => resolveIds(n, minted));
  const resolvedEdges = frag.edges.map((e) => ({
    ...e,
    id: minted[e.id] ?? e.id,
    from: minted[e.from] ?? e.from,
    to: minted[e.to] ?? e.to,
  }));

  const existingFinalIds = new Set(
    collectAll(resolvedNodes)
      .map((n) => n.id)
      .filter(isExistingNode),
  );
  const isFinalExisting = (id: NodeId) => existingFinalIds.has(id);

  // ---- Step 3: refusals -------------------------------------------------
  const everyFragNode = collectAll(resolvedNodes);
  const everyFragId = new Set(everyFragNode.map((n) => n.id));

  for (const n of everyFragNode) {
    if (!isFinalExisting(n.id)) continue;
    const current = findNode(scene, n.id)!;
    if (current.kind !== n.kind) {
      return refused(
        `"${n.id}" is a ${KIND_NOUN[current.kind]}; a shape cannot change kind in place — list it in removing and write the new one without an id.`,
      );
    }
  }

  for (const id of removing) {
    const inFragment = everyFragId.has(id) || resolvedEdges.some((e) => e.id === id);
    if (inFragment) {
      return refused(
        `"${id}" is both in removing and in the HTML you wrote — say which one you mean.`,
      );
    }
    const isNode = findNode(scene, id) !== null;
    const isEdge = scene.edges.some((e) => e.id === id);
    if (!isNode && !isEdge) {
      return refused(
        `This diagram has no shape or connector with id "${id}". Read it again for the ids it actually has.`,
      );
    }
  }

  const removingSet = new Set(removing);
  const allSceneIds = new Set<NodeId>();
  walk(scene.nodes, (n) => void allSceneIds.add(n.id));
  const knownAfterInsert = new Set([
    ...allSceneIds,
    ...everyFragNode.map((n) => n.id).filter((id) => !removingSet.has(id)),
  ]);

  for (const edge of resolvedEdges) {
    if (edge.from === edge.to) {
      return refused(
        `An edge cannot join "${edge.from}" to itself.`,
      );
    }
    const fromKnown = knownAfterInsert.has(edge.from) && !removingSet.has(edge.from);
    const toKnown = knownAfterInsert.has(edge.to) && !removingSet.has(edge.to);
    if (!fromKnown || !toKnown) {
      return refused(
        `"${!fromKnown ? edge.from : edge.to}" is not a shape on this diagram or in what you wrote.`,
      );
    }
    if (!isExistingEdge(edge.id)) {
      const dupe = scene.edges.find(
        (e) =>
          (e.from === edge.from && e.to === edge.to) ||
          (e.from === edge.to && e.to === edge.from),
      );
      if (dupe) {
        return refused(
          `"${edge.from}" and "${edge.to}" are already joined by "${dupe.id}"; change ${dupe.id} instead of adding another.`,
        );
      }
    }
  }

  if (opts.at) {
    const bad = anchorRefusal(scene, opts.at);
    if (bad) return bad;
  }

  // A fragment element written inside an id that is currently ITS OWN
  // ancestor would create a cycle — refuse before anything is applied.
  const cycle = findCycle(resolvedNodes, scene, isFinalExisting);
  if (cycle) {
    return refused(
      `"${cycle}" cannot be written inside its own descendant.`,
    );
  }

  if (!everyFragNode.length && !resolvedEdges.length && !removing.length) {
    return refused(
      'Nothing in that HTML is a shape. Write <nt-rect>, <nt-ellipse>, … as THE CANVAS describes, or name ids in removing.',
    );
  }

  // ---- Apply, tracking ops against a working scene ----------------------
  const ops: SceneOp[] = [];
  let working = scene;
  const inserted: NodeId[] = [];
  const updated: NodeId[] = [];
  const notes: string[] = [];

  const apply = (op: SceneOp) => {
    ops.push(op);
    working = applyOnce(working, op);
  };

  // Step 4: the diagram surface itself — its height only when the wrapper
  // stated one other than the height the read showed (a bare-shapes fragment,
  // one with no h, or an echo never touches it; the fit below decides whether
  // a stated one pins), and never a width: a band's is the page's, and the
  // read form's `w` is an echo. `wide`, style and attrs are merge-only diffs, so this call can widen
  // a diagram but never narrow it.
  {
    const diagramPatch: { h?: number; wide?: boolean } = {};
    if (fragment.rootH && frag.h !== bandHeight(scene) && frag.h !== working.h) diagramPatch.h = frag.h;
    if (frag.wide && !working.wide) diagramPatch.wide = true;
    const style = styleDiffMerge(working.style, frag.style);
    const attrs = styleDiffMerge(working.attrs, omit(fragment.rootAttrs, LEGACY_ROOT_ATTRS));
    if (Object.keys(diagramPatch).length || style || attrs) {
      apply({
        type: "setDiagram",
        ...diagramPatch,
        ...(style ? { style } : {}),
        ...(attrs ? { attrs } : {}),
      });
    }
  }

  // Step 5 + 6: place top-level elements, recursing into groups.
  // `container` is where a NEW top-level element lands; `enforceContainer`
  // is whether an EXISTING one gets reparented there too. Those differ: a
  // bare `<nt-rect id="c1">` at the top of the call's HTML, with no `at`,
  // rewrites c1 in place wherever it already lives (W7) — it is not, by
  // itself, an instruction to move c1 to the diagram's own top level. An
  // explicit `at`, or writing the id NESTED inside another element in the
  // fragment (handled by the recursive call below, which always enforces),
  // is what makes reparenting intentional.
  const topContainer = opts.at ? containerOf(scene, opts.at) : null;
  const els = resolvedNodes.map((node) => toResolved(node, isFinalExisting));
  placeLevel(topContainer, els, opts.at, !!opts.at);

  // Step 7: edges.
  const edgesAdded: EdgeId[] = [];
  const edgesUpdated: EdgeId[] = [];
  for (const edge of resolvedEdges) {
    if (isExistingEdge(edge.id)) {
      const current = working.edges.find((e) => e.id === edge.id)!;
      const from = edge.from !== current.from ? edge.from : undefined;
      const to = edge.to !== current.to ? edge.to : undefined;
      if (from !== undefined || to !== undefined) {
        apply({ type: "reconnect", id: edge.id, ...(from ? { from } : {}), ...(to ? { to } : {}) });
        edgesUpdated.push(edge.id);
      }
      if (edge.label !== current.label) {
        apply({ type: "setEdgeLabel", id: edge.id, label: edge.label });
        if (!edgesUpdated.includes(edge.id)) edgesUpdated.push(edge.id);
      }
      const styleDecls = fullReplace(current.style, edge.style);
      if (styleDecls) {
        apply({ type: "setEdgeStyle", ids: [edge.id], decls: styleDecls });
        if (!edgesUpdated.includes(edge.id)) edgesUpdated.push(edge.id);
      }
      if (!attrsEqual(current.attrs, edge.attrs)) {
        notes.push(`attributes on ${edge.id} were left as they were.`);
      }
    } else {
      apply({ type: "addEdge", edges: [edge] });
      edgesAdded.push(edge.id);
    }
  }

  // Step 8: removals last.
  const removedNodeIds = removing.filter((id) => findNode(scene, id) !== null);
  const removedEdgeIds = removing.filter((id) => scene.edges.some((e) => e.id === id));
  const edgesRemoved: EdgeId[] = [...removedEdgeIds];
  if (removedNodeIds.length) {
    for (const id of removedNodeIds) {
      for (const e of working.edges) {
        if ((e.from === id || e.to === id) && !edgesRemoved.includes(e.id)) {
          edgesRemoved.push(e.id);
        }
      }
    }
    apply({ type: "remove", ids: removedNodeIds });
  }
  if (removedEdgeIds.length) apply({ type: "removeEdge", ids: removedEdgeIds });

  // Step 9: land the merged diagram in its band, as ops, so `ops` still
  // reproduces `next` and the geometry report reads the fitted coordinates.
  // After the merge rather than on the fragment: a shape written into an
  // existing diagram is out of band only against what is already there.
  const fit = fitOps(reflowHugs(working));
  for (const op of fit) apply(op);
  notes.push(...fitNotes(fit, working));

  const next = applyOps(scene, ops);
  return {
    ops,
    next,
    inserted,
    updated,
    removed: removedNodeIds,
    edgesAdded,
    edgesUpdated,
    edgesRemoved,
    minted,
    notes,
  };

  // -----------------------------------------------------------------------
  // Nested helpers (closures over `working`/`ops`/`inserted`/`updated`)
  // -----------------------------------------------------------------------

  function placeLevel(
    containerId: NodeId | null,
    list: readonly Resolved[],
    anchor: Anchor | undefined,
    enforceContainer: boolean,
  ): void {
    let cursor = initialCursor(containerId, list, anchor, enforceContainer);
    for (const el of list) {
      if (el.existing) {
        const currentParent = findParent(working, el.id)?.id ?? null;
        if (enforceContainer && currentParent !== containerId) {
          apply({
            type: "reorder",
            ids: [el.id],
            to: { at: "index", parentId: containerId, index: cursor },
          });
        }
        const changed = emitUpdate(el.id, el.node);
        if (changed && !updated.includes(el.id)) updated.push(el.id);
        const effectiveContainer = enforceContainer ? containerId : currentParent;
        cursor = indexWithin(working, effectiveContainer, el.id) + 1;
        if (isGroup(el.node)) {
          placeLevel(el.id, el.node.children.map((c) => toResolved(c, isFinalExisting)), undefined, true);
        }
      } else {
        const shell: SceneNode = isGroup(el.node) ? { ...el.node, children: [] } : el.node;
        apply({ type: "insert", nodes: [shell], parentId: containerId, index: cursor });
        inserted.push(el.id);
        cursor += 1;
        if (isGroup(el.node)) {
          placeLevel(el.id, el.node.children.map((c) => toResolved(c, isFinalExisting)), undefined, true);
        }
      }
    }
  }

  function initialCursor(
    containerId: NodeId | null,
    list: readonly Resolved[],
    anchor: Anchor | undefined,
    enforceContainer: boolean,
  ): number {
    if (anchor) {
      if ("inside" in anchor) return childCount(working, anchor.inside);
      if ("after" in anchor) return indexWithin(working, containerId, anchor.after) + 1;
      return indexWithin(working, containerId, anchor.before);
    }
    if (enforceContainer && list.length && !list[0].existing) {
      const followingExisting = list.find((e) => e.existing);
      if (followingExisting) {
        const at = indexWithin(working, containerId, followingExisting.id);
        if (at >= 0) return at;
      }
    }
    return childCount(working, containerId);
  }

  /** Returns whether anything about `id` actually changed. */
  function emitUpdate(id: NodeId, frozen: SceneNode): boolean {
    const current = findNode(working, id);
    if (!current) return false;
    const before = ops.length;
    const parent = findParent(working, id);
    const autoLayout = !!parent && isAutoLayout(parent);

    if (frozen.kind === "path" && current.kind === "path") {
      const boxDiffers =
        current.x !== frozen.x || current.y !== frozen.y || current.w !== frozen.w || current.h !== frozen.h;
      if (current.d !== frozen.d || boxDiffers) {
        apply({
          type: "setPath",
          id,
          d: frozen.d,
          frame: { x: frozen.x, y: frozen.y, w: frozen.w, h: frozen.h },
        });
      }
    } else if (autoLayout) {
      if (current.w !== frozen.w || current.h !== frozen.h) {
        apply({
          type: "resize",
          frames: [{ id, x: current.x, y: current.y, w: frozen.w, h: frozen.h }],
        });
      }
    } else if (
      current.x !== frozen.x ||
      current.y !== frozen.y ||
      current.w !== frozen.w ||
      current.h !== frozen.h
    ) {
      apply({ type: "resize", frames: [{ id, x: frozen.x, y: frozen.y, w: frozen.w, h: frozen.h }] });
    }

    const refreshed = findNode(working, id) ?? current;
    if (refreshed.rot !== frozen.rot) apply({ type: "rotate", ids: [id], rot: frozen.rot });

    const afterGeometry = findNode(working, id) ?? refreshed;
    const styleDecls = fullReplace(afterGeometry.style, frozen.style);
    if (styleDecls) apply({ type: "setStyle", ids: [id], decls: styleDecls });

    const afterStyle = findNode(working, id) ?? afterGeometry;
    if (hasText(afterStyle) && hasText(frozen) && afterStyle.label !== frozen.label) {
      apply({ type: "setLabel", id, label: frozen.label });
    }
    if (afterStyle.kind === "image" && frozen.kind === "image" && afterStyle.src !== frozen.src) {
      apply({ type: "setSrc", id, src: frozen.src });
    }
    if (afterStyle.name !== frozen.name) apply({ type: "setName", id, name: frozen.name });
    if (afterStyle.locked !== frozen.locked) apply({ type: "setLocked", ids: [id], locked: frozen.locked });
    if (afterStyle.hidden !== frozen.hidden) apply({ type: "setHidden", ids: [id], hidden: frozen.hidden });

    const shapeParams = shapeParamsOf(frozen);
    if (shapeParams && !sameShapeParams(shapeParamsOf(afterStyle), shapeParams)) {
      apply({ type: "setShape", ids: [id], params: shapeParams });
    }

    const attrsDecls = fullReplace(afterStyle.attrs, frozen.attrs);
    if (attrsDecls) apply({ type: "setAttrs", id, attrs: attrsDecls });

    return ops.length > before;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** What a band fit tells the model: only a scale — a nudge back inside the
 *  band reads off the geometry, but a smaller drawing is news. `scene` is the
 *  fitted one, which knows whether the band is wide. */
export function fitNotes(fit: readonly SceneOp[], scene: Scene): string[] {
  return fit.flatMap((op) =>
    op.type === "scale"
      ? [`The diagram was scaled to ${Number(op.k.toFixed(3))}× to fit its ${bandWidth(scene)}px width.`]
      : [],
  );
}

/** Root attributes that pinned an old diagram's size. A write never brings
 *  them back — a band's width follows from `wide`, and its height from `h`. */
const LEGACY_ROOT_ATTRS = ["data-width", "data-height"] as const;

function omit(attrs: Record<string, string>, keys: readonly string[]): Record<string, string> {
  const out = { ...attrs };
  for (const key of keys) delete out[key];
  return out;
}

function toResolved(node: SceneNode, isFinalExisting: (id: NodeId) => boolean): Resolved {
  return { id: node.id, node, existing: isFinalExisting(node.id) };
}

function collectMintOrder(nodes: readonly SceneNode[], authored: ReadonlySet<string>, out: NodeId[]): void {
  for (const n of nodes) {
    if (!authored.has(n.id)) out.push(n.id);
    if (isGroup(n)) collectMintOrder(n.children, authored, out);
  }
}

function resolveIds(node: SceneNode, minted: Record<string, string>): SceneNode {
  const id = minted[node.id] ?? node.id;
  if (isGroup(node)) {
    return { ...node, id, children: node.children.map((c) => resolveIds(c, minted)) };
  }
  return { ...node, id };
}

function collectAll(nodes: readonly SceneNode[]): SceneNode[] {
  const out: SceneNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (isGroup(n)) out.push(...collectAll(n.children));
  }
  return out;
}

function indexWithin(scene: Scene, containerId: NodeId | null, id: NodeId): number {
  const list = containerId === null ? scene.nodes : childrenOf(scene, containerId);
  return list.findIndex((n) => n.id === id);
}

function childCount(scene: Scene, containerId: NodeId | null): number {
  return (containerId === null ? scene.nodes : childrenOf(scene, containerId)).length;
}

function childrenOf(scene: Scene, id: NodeId): SceneNode[] {
  const node = findNode(scene, id);
  return node && isGroup(node) ? node.children : [];
}

/** One op's worth of a scene, without `applyOps`' final `reflowHugs` pass —
 *  intermediate placement decisions (index/child-count lookups) never need
 *  hugged sizes, and `next` is recomputed with the real `applyOps` at the
 *  very end anyway, which is what actually reflows and what callers see. */
function applyOnce(scene: Scene, op: SceneOp): Scene {
  return applyOp(scene, op);
}

/** Full replacement, computed as a merge patch: every declaration the
 *  fragment carries (added or changed), plus `undefined` for every one the
 *  current value has that the fragment dropped. `null` when nothing changes —
 *  callers use that to skip emitting an op at all. */
function fullReplace(current: Record<string, string>, next: Record<string, string>): Record<string, string | undefined> | null {
  const decls: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(next)) {
    if (current[k] !== v) decls[k] = v;
  }
  for (const k of Object.keys(current)) {
    if (!(k in next)) decls[k] = undefined;
  }
  return Object.keys(decls).length ? decls : null;
}

/** Merge-only: added or changed declarations, never a removal for a key the
 *  fragment simply did not mention — the root diagram's own style/attrs. */
function styleDiffMerge(current: Record<string, string>, next: Record<string, string>): Record<string, string> | null {
  const decls: Record<string, string> = {};
  for (const [k, v] of Object.entries(next)) {
    if (current[k] !== v) decls[k] = v;
  }
  return Object.keys(decls).length ? decls : null;
}

function attrsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => a[k] === b[k]);
}

function shapeParamsOf(node: SceneNode): ShapeParams | null {
  if (node.kind === "polygon") return { sides: node.sides };
  if (node.kind === "ellipse") {
    return { start: node.start, sweep: node.sweep, inner: node.inner };
  }
  if (node.kind === "group") return { op: node.op };
  return null;
}

function sameShapeParams(a: ShapeParams | null, b: ShapeParams): boolean {
  if (!a) return false;
  return a.sides === b.sides && a.start === b.start && a.sweep === b.sweep && a.inner === b.inner && a.op === b.op;
}

/** Where a top-level `at` puts new content: `inside` names the container
 *  directly; `after`/`before` name a sibling whose OWN parent is the
 *  container. Resolved against the scene as read — anchors are ids the
 *  fragment did not write, so they only ever refer to what already exists. */
function containerOf(scene: Scene, at: Anchor): NodeId | null {
  if ("inside" in at) return at.inside;
  const id = "after" in at ? at.after : at.before;
  return findParent(scene, id)?.id ?? null;
}

function anchorRefusal(scene: Scene, at: Anchor): Refusal | null {
  if ("inside" in at) {
    if (at.inside === null) return null;
    const node = findNode(scene, at.inside);
    if (!node || !isGroup(node)) {
      return refused(`"${at.inside}" is not a group on this diagram.`);
    }
    return null;
  }
  const id = "after" in at ? at.after : at.before;
  if (!findNode(scene, id)) {
    return refused(`"${id}" is not a shape on this diagram.`);
  }
  return null;
}

/** A written EXISTING element that names, as its own descendant, an id that
 *  is currently one of ITS ancestors in the live scene — a cycle no op can
 *  express. */
function findCycle(
  resolved: readonly SceneNode[],
  scene: Scene,
  isFinalExisting: (id: NodeId) => boolean,
): NodeId | null {
  const walk = (nodes: readonly SceneNode[], ancestors: readonly NodeId[]): NodeId | null => {
    for (const n of nodes) {
      if (isFinalExisting(n.id) && ancestors.includes(n.id)) return n.id;
      if (isGroup(n)) {
        const nextAncestors = isFinalExisting(n.id) ? [...ancestors, n.id] : ancestors;
        const hit = walk(n.children, nextAncestors);
        if (hit) return hit;
      }
    }
    return null;
  };
  // Ancestors are seeded from the live scene: an EXISTING top-level element
  // written with itself as an ancestor is only a cycle if the id it names
  // deeper down is genuinely one of its current `nodePath` ancestors.
  for (const n of resolved) {
    if (!isFinalExisting(n.id) || !isGroup(n)) continue;
    const path = new Set(nodePath(scene, n.id).map((p) => p.id));
    const hit = walk(n.children, [...path]);
    if (hit) return hit;
  }
  return null;
}

/** Exported for `execute.ts`'s shared "done" formatter — a plan reports how
 *  many of each kind of thing it touched. */
export function summarize(plan: WritePlan): string {
  const parts = [
    plan.inserted.length && `${plan.inserted.length} shape${plan.inserted.length === 1 ? "" : "s"} added`,
    plan.updated.length && `${plan.updated.length} rewritten`,
    plan.removed.length && `${plan.removed.length} removed`,
    plan.edgesAdded.length &&
      `${plan.edgesAdded.length} connector${plan.edgesAdded.length === 1 ? "" : "s"} added`,
    plan.edgesUpdated.length && `${plan.edgesUpdated.length} connector${plan.edgesUpdated.length === 1 ? "" : "s"} rewritten`,
    plan.edgesRemoved.length &&
      `${plan.edgesRemoved.length} connector${plan.edgesRemoved.length === 1 ? "" : "s"} removed`,
  ].filter(Boolean);
  return parts.join(", ") || "no visible change";
}
