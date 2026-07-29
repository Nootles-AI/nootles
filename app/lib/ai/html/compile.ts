import type {
  Batch,
  InlineRun,
  NewBlock,
  Operation,
  Position,
} from "@/convex/ai/operations";
import type { DocNode, Run, TextRun } from "./grammar";

/**
 * Compiles parsed document-language nodes into a Phase-2 op batch.
 *
 * The `id` attribute carries the entire insert/update distinction:
 *   - an element WITH an id that exists → update that block (only where it
 *     actually differs from the current document)
 *   - an element WITHOUT an id → insert a new block after the running anchor
 *
 * That one rule is what lets autocomplete (insert at the caret) and cascade
 * (rewrite blocks elsewhere) share a single grammar and a single code path.
 * Diffing is like-for-like: the current document is serialized and parsed into
 * the same `DocNode` shape, so comparison is structural rather than textual.
 */

const PROSE = new Set([
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "toggleListItem",
  "quote",
]);

const textToInline = (r: TextRun): Extract<InlineRun, { type: "text" }> => ({
  type: "text",
  text: r.text,
  ...(r.marks?.length ? { marks: r.marks } : {}),
});

function runsToInline(runs: Run[]): InlineRun[] {
  return runs.map((r) => {
    if (r.type === "math") return { type: "math", latex: r.latex };
    if (r.type === "link") {
      return { type: "link", href: r.href, content: r.content.map(textToInline) };
    }
    return textToInline(r);
  });
}

function sameRuns(a: Run[], b: Run[]): boolean {
  return JSON.stringify(runsToInline(a)) === JSON.stringify(runsToInline(b));
}

const MEDIA = new Set(["image", "video", "audio", "file"]);

function propsOf(node: DocNode): Record<string, string | number | boolean> | undefined {
  if (node.type === "heading") return { level: node.level ?? 2 };
  if (node.type === "checkListItem") return { checked: node.checked ?? false };
  if (node.type === "numberedListItem" && node.start !== undefined) {
    return { start: node.start };
  }
  if (node.type === "codeBlock") return { language: node.language, code: node.code };
  if (node.type === "mathBlock") return { source: node.rows.join("\n") };
  if (MEDIA.has(node.type) && "url" in node) {
    return {
      ...(node.url !== undefined ? { url: node.url } : {}),
      ...(node.caption !== undefined ? { caption: node.caption } : {}),
      ...(node.name !== undefined ? { name: node.name } : {}),
    };
  }
  return undefined;
}

/** Ops that bring an existing block in line with the model's version. */
function updateOps(next: DocNode, current: DocNode): Operation[] {
  const id = next.id!;
  const ops: Operation[] = [];

  // A changed block TYPE can't be patched in place; the caller handles that by
  // treating it as a replacement.
  if (next.type !== current.type) return ops;

  if (PROSE.has(next.type) && "content" in next && "content" in current) {
    if (!sameRuns(next.content, current.content)) {
      ops.push({ kind: "setBlockContent", blockId: id, content: runsToInline(next.content) });
    }
    const p = propsOf(next);
    const cp = propsOf(current);
    if (p && JSON.stringify(p) !== JSON.stringify(cp)) {
      ops.push({ kind: "updateBlockProps", blockId: id, props: p });
    }
    return ops;
  }

  if (next.type === "codeBlock" && current.type === "codeBlock") {
    if (next.code !== current.code || next.language !== current.language) {
      ops.push({
        kind: "updateBlockProps",
        blockId: id,
        props: { language: next.language, code: next.code },
      });
    }
    return ops;
  }

  if (next.type === "table" && current.type === "table") {
    const rows = next.rows.map((row) => row.map(runsToInline));
    const same =
      JSON.stringify(rows) ===
        JSON.stringify(current.rows.map((row) => row.map(runsToInline))) &&
      !!next.header === !!current.header;
    if (!same) {
      ops.push({
        kind: "setTableRows",
        blockId: id,
        rows,
        ...(next.header ? { headerRows: 1 } : {}),
      });
    }
    return ops;
  }

  if (next.type === "mathBlock" && current.type === "mathBlock") {
    if (next.rows.join("\n") !== current.rows.join("\n")) {
      ops.push({ kind: "setMathRows", blockId: id, rows: next.rows });
    }
    return ops;
  }

  // Media holds no inline content, so everything about it lives in props — a
  // re-captioned image is a props update, not a content one. What the model did
  // not state it did not mean to change, so the patch carries only the fields it
  // gave, and only where they differ; `updateBlockProps` merges the rest.
  if (MEDIA.has(next.type)) {
    const cp = propsOf(current) ?? {};
    const patch = Object.entries(propsOf(next) ?? {}).filter(([k, v]) => cp[k] !== v);
    if (patch.length) {
      ops.push({ kind: "updateBlockProps", blockId: id, props: Object.fromEntries(patch) });
    }
    return ops;
  }

  if (next.type === "canvas" && current.type === "canvas") {
    const currentById = new Map(current.nodes.filter((n) => n.id).map((n) => [n.id!, n]));
    const place = layoutFor(next.nodes);
    const seen = new Set<string>();
    // Namespaced by the diagram they belong to: `tempId`s are unique across the
    // whole batch, and two diagrams edited in one call would otherwise both call
    // their first new node `n0`.
    const nameFor = (n: { id?: string }, i: number) => n.id ?? `${id}n${i}`;

    next.nodes.forEach((n, i) => {
      if (n.id && currentById.has(n.id)) {
        seen.add(n.id);
        const c = currentById.get(n.id)!;
        const patch: Record<string, unknown> = {};
        if (n.label !== c.label) patch.label = n.label;
        if (n.x !== undefined && n.y !== undefined && (n.x !== c.x || n.y !== c.y)) {
          patch.position = { x: n.x, y: n.y };
        }
        if (Object.keys(patch).length) {
          ops.push({
            kind: "updateShape",
            blockId: id,
            shapeId: n.id,
            patch: patch as { label?: string; position?: { x: number; y: number } },
          });
        }
        return;
      }
      ops.push({
        kind: "addShape",
        blockId: id,
        tempId: nameFor(n, i),
        shape: n.shape,
        position: place(n, i),
        label: n.label,
      });
    });

    for (const c of current.nodes) {
      if (c.id && !seen.has(c.id)) {
        ops.push({ kind: "removeShape", blockId: id, shapeId: c.id });
      }
    }

    // Existing shapes keep their ids; new ones take the tempId minted above.
    const resolve = edgeResolver(next.nodes, nameFor);
    const existingPairs = new Set(
      current.edges.map((e) => `${e.from}->${e.to}`),
    );
    next.edges.forEach((e, i) => {
      const from = resolve(e.from);
      const to = resolve(e.to);
      if (!from || !to) return;
      if (existingPairs.has(`${from}->${to}`)) return;
      ops.push({
        kind: "connectEdge",
        blockId: id,
        tempId: `${id}e${i}`,
        source: { tempId: from },
        target: { tempId: to },
        ...(e.label ? { label: e.label } : {}),
      });
    });
    return ops;
  }

  return ops;
}

/**
 * Maps whatever an `<ab-edge>` calls a node onto the id the node will actually
 * have. A model writing a fresh diagram has no reason to invent matching ids, so
 * it refers to nodes however it likes — `id="n1"`, the visible label, or by
 * position. Accept all of those; an edge we still can't place is dropped rather
 * than failing validation and taking the whole diagram with it.
 */
function edgeResolver(
  nodes: Array<{ id?: string; label: string }>,
  idFor: (n: { id?: string; label: string }, i: number) => string,
): (ref: string) => string | null {
  const map = new Map<string, string>();
  const add = (key: string | undefined, value: string) => {
    const k = key?.trim();
    if (k && !map.has(k)) map.set(k, value);
  };
  nodes.forEach((n, i) => add(n.id, idFor(n, i)));
  nodes.forEach((n, i) => add(n.label, idFor(n, i)));
  nodes.forEach((n, i) => {
    const id = idFor(n, i);
    add(`n${i + 1}`, id);
    add(`${i + 1}`, id);
    add(`${i}`, id);
  });
  return (ref) => map.get(ref.trim()) ?? null;
}

/**
 * Coordinates a model writes are not trustworthy: it commonly gives every node
 * `x="0" y="0"`, or omits them. Stacked shapes look like a single shape, and the
 * edges between them collapse to zero-length lines — which reads as "the diagram
 * lost its edges". So we only honour coordinates when they actually separate the
 * nodes, and otherwise lay them out ourselves.
 */
const COL = 220;
const ROW = 140;

function layoutFor(
  nodes: Array<{ x?: number; y?: number }>,
): (n: { x?: number; y?: number }, i: number) => { x: number; y: number } {
  const row = (_n: unknown, i: number) => ({ x: i * COL, y: 0 });
  if (nodes.some((n) => n.x === undefined || n.y === undefined)) return row;

  const xs = nodes.map((n) => n.x!);
  const ys = nodes.map((n) => n.y!);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);

  // Every node on the same point: no information to preserve.
  if (width === 0 && height === 0) return row;

  // A whole diagram spanning a couple of units isn't pixels — the model is
  // writing grid indices (0,0), (0,1), (-1,2)… Scaling rather than flattening
  // keeps the structure it intended, like a diamond branching left and right.
  if (width <= 20 && height <= 20) {
    return (n) => ({ x: n.x! * COL, y: n.y! * ROW });
  }

  return (n) => ({ x: n.x!, y: n.y! });
}

/**
 * Positions and edge references for a diagram, as the compiler would resolve
 * them. Shared with the streaming preview so a half-arrived diagram is drawn
 * exactly where the finished one will land — no shuffle on accept.
 */
export function layoutDiagram(
  nodes: Array<{ id?: string; shape: string; label: string; x?: number; y?: number }>,
  edges: Array<{ from: string; to: string; label?: string }>,
) {
  const idFor = (n: { id?: string }, i: number) => n.id ?? `n${i}`;
  const place = layoutFor(nodes);
  const resolve = edgeResolver(nodes, idFor);
  return {
    nodes: nodes.map((n, i) => ({
      tempId: idFor(n, i),
      shape: n.shape,
      label: n.label,
      ...place(n, i),
    })),
    edges: edges.flatMap((e) => {
      const source = resolve(e.from);
      const target = resolve(e.to);
      if (!source || !target) return [];
      return [{ source, target, ...(e.label ? { label: e.label } : {}) }];
    }),
  };
}

function newBlockFor(node: DocNode, tempId: string): NewBlock {
  const props = propsOf(node);
  const children =
    "children" in node && node.children?.length
      ? node.children.map((c, i) => newBlockFor(c, `${tempId}c${i}`))
      : undefined;
  return {
    tempId,
    type: node.type,
    ...(props ? { props } : {}),
    ...("content" in node ? { content: runsToInline(node.content) } : {}),
    // A table is two-dimensional, so it travels in `rows` rather than `content`.
    ...(node.type === "table"
      ? {
          rows: node.rows.map((row) => row.map(runsToInline)),
          ...(node.header ? { headerRows: 1 } : {}),
        }
      : {}),
    ...(children ? { children } : {}),
  };
}

/** Nested items are ordinary blocks with their own ids — flatten for diffing. */
function flatten(nodes: DocNode[]): DocNode[] {
  return nodes.flatMap((n) =>
    "children" in n && n.children?.length ? [n, ...flatten(n.children)] : [n],
  );
}

/** Each block's ancestors, outermost first. */
function ancestry(
  nodes: DocNode[],
  above: string[] = [],
  out = new Map<string, string[]>(),
): Map<string, string[]> {
  for (const n of nodes) {
    if (n.id) out.set(n.id, above);
    if ("children" in n && n.children?.length) {
      ancestry(n.children, n.id ? [...above, n.id] : above, out);
    }
  }
  return out;
}

export type CompileContext = {
  /**
   * Fallback insertion point for new blocks, used only when their position
   * can't be inferred from surrounding tagged blocks. Normally the cursor block.
   */
  anchorBlockId?: string;
  /** Current document in the same normalized shape, for like-for-like diffing. */
  current: DocNode[];
  /**
   * Block ids this rewrite is allowed to consume. Any of them the rewrite does
   * not keep is removed.
   *
   * Absent (the default) nothing is removed for being missing, which is what
   * makes it safe to hand the compiler a fragment of the document. But folding
   * several paragraphs into one code block or table is exactly a case where the
   * others must go, and the caller is the only one who knows which blocks were
   * on the table.
   */
  replacing?: string[];
};

export function compileDocHtml(next: DocNode[], ctx: CompileContext): Batch {
  const currentOrder = flatten(ctx.current).filter((n) => n.id);
  const currentById = new Map(currentOrder.map((n) => [n.id!, n]));
  // A rewrite that consumes blocks belongs where those blocks are. Without this
  // the two headline cases — a type change, and folding a run into one table —
  // have no tagged neighbour to place against and land at the end of the page.
  const consumed = new Set(ctx.replacing ?? []);
  const firstConsumed = currentOrder.find((n) => consumed.has(n.id!))?.id;
  const ops: Operation[] = [];
  // Position of the last thing we placed; new blocks follow it.
  let anchor: Position | null = null;
  let temp = 0;

  // Existing nested items are addressable by id, so diff over the flattened
  // tree; only genuinely new blocks keep their nesting (carried via `children`).
  // A newly inserted block brings its descendants with it, so they're skipped
  // here rather than inserted twice.
  const all = flatten(next);
  const insertedWithParent = new Set<DocNode>();

  // Everything this rewrite takes away: blocks whose type changed — the
  // vocabulary has no op for that, so they are replaced — and whatever the
  // caller offered up that the rewrite did not keep.
  const kept = new Set(all.flatMap((n) => (n.id ? [n.id] : [])));
  const doomed = new Set<string>([
    ...all.flatMap((n) => {
      const c = n.id ? currentById.get(n.id) : undefined;
      return c && c.type !== n.type ? [n.id!] : [];
    }),
    ...[...consumed].filter((id) => currentById.has(id) && !kept.has(id)),
  ]);
  const above = ancestry(ctx.current);
  /**
   * The outermost block on its way out that this one is inside. A block leaves
   * with its parent, so that is where a removal has to be named — and where
   * anything written beside it has to go, since inserting next to a block inside
   * the doomed one puts it inside too, and the removal then takes it along.
   */
  const doomedAncestor = (id: string) => (above.get(id) ?? []).find((a) => doomed.has(a));
  const relocate = (at: Position): Position => {
    if (at.at !== "before" && at.at !== "after") return at;
    const outer = doomedAncestor(at.ref);
    return outer ? { at: "before", ref: outer } : at;
  };

  all.forEach((node, i) => {
    if (insertedWithParent.has(node)) return;
    const existing = node.id ? currentById.get(node.id) : undefined;

    if (existing && existing.type === node.type) {
      ops.push(...updateOps(node, existing));
      anchor = { at: "after", ref: node.id! };
      return;
    }

    // Placement: where the block it replaces stands, else after whatever
    // preceded it, else BEFORE the next known block (so a new block written at
    // the top of the document lands at the top), else where the rewrite is
    // consuming from, else the caller's fallback.
    let at: Position;
    if (existing) {
      at = { at: "before", ref: existing.id! };
    } else if (anchor) {
      at = anchor;
    } else {
      const following = all
        .slice(i + 1)
        .find((n) => n.id && currentById.has(n.id));
      if (following) at = { at: "before", ref: following.id! };
      else if (firstConsumed) at = { at: "before", ref: firstConsumed };
      else if (ctx.anchorBlockId) at = { at: "after", ref: ctx.anchorBlockId };
      else at = { at: "docEnd" };
    }

    // Either brand new, or the same id with a different type — the vocabulary
    // has no "change type" op, so insert the replacement and drop the original.
    const tempId = `t${temp++}`;
    ops.push({
      kind: "insertBlocks",
      at: relocate(at),
      blocks: [newBlockFor(node, tempId)],
    });
    if ("children" in node && node.children?.length) {
      for (const d of flatten(node.children)) insertedWithParent.add(d);
    }
    if (node.type === "canvas") {
      const shapeId = (n: { id?: string }, i: number) => n.id ?? `${tempId}n${i}`;
      const place = layoutFor(node.nodes);
      node.nodes.forEach((n, i) =>
        ops.push({
          kind: "addShape",
          blockId: tempId,
          tempId: shapeId(n, i),
          shape: n.shape,
          position: place(n, i),
          label: n.label,
        }),
      );
      const resolve = edgeResolver(node.nodes, shapeId);
      node.edges.forEach((e, i) => {
        const from = resolve(e.from);
        const to = resolve(e.to);
        if (!from || !to) return; // unplaceable edge — drop it, keep the diagram
        ops.push({
          kind: "connectEdge",
          blockId: tempId,
          tempId: `${tempId}e${i}`,
          source: { tempId: from },
          target: { tempId: to },
          ...(e.label ? { label: e.label } : {}),
        });
      });
    }
    // The replacement is a different block, so the original's children have to
    // be carried across by hand — `removeBlock` takes a whole subtree, and the
    // rewrite said nothing about what was nested under the block it retyped.
    if (existing && "children" in existing) {
      let to: Position = { at: "after", ref: tempId };
      for (const child of existing.children ?? []) {
        if (!child.id || doomed.has(child.id)) continue;
        ops.push({ kind: "moveBlock", blockId: child.id, to });
        to = { at: "after", ref: child.id };
      }
    }
    anchor = { at: "after", ref: tempId };
  });

  // Removals last, so every replacement is in place — and every child lifted out
  // — before the originals go. In document order, outermost only.
  for (const node of currentOrder) {
    if (doomed.has(node.id!) && !doomedAncestor(node.id!)) {
      ops.push({ kind: "removeBlock", blockId: node.id! });
    }
  }

  return { ops };
}
