import type {
  Batch,
  InlineRun,
  NewBlock,
  Operation,
  Position,
} from "@/convex/ai/operations";
import type { DocNode, Run } from "./grammar";

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
  "quote",
]);

function runsToInline(runs: Run[]): InlineRun[] {
  return runs.map((r) =>
    r.type === "math"
      ? { type: "math", latex: r.latex }
      : { type: "text", text: r.text, ...(r.marks?.length ? { marks: r.marks } : {}) },
  );
}

function sameRuns(a: Run[], b: Run[]): boolean {
  return JSON.stringify(runsToInline(a)) === JSON.stringify(runsToInline(b));
}

function propsOf(node: DocNode): Record<string, string | number | boolean> | undefined {
  if (node.type === "heading") return { level: node.level ?? 2 };
  if (node.type === "checkListItem") return { checked: node.checked ?? false };
  if (node.type === "codeBlock") return { language: node.language, code: node.code };
  if (node.type === "mathBlock") return { source: node.rows.join("\n") };
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

  if (next.type === "mathBlock" && current.type === "mathBlock") {
    if (next.rows.join("\n") !== current.rows.join("\n")) {
      ops.push({ kind: "setMathRows", blockId: id, rows: next.rows });
    }
    return ops;
  }

  if (next.type === "canvas" && current.type === "canvas") {
    const currentById = new Map(current.nodes.filter((n) => n.id).map((n) => [n.id!, n]));
    const seen = new Set<string>();

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
        tempId: n.id ?? `n${i}`,
        shape: n.shape,
        // Absent coordinates mean "lay it out for me"; stack as a fallback.
        position: { x: n.x ?? i * 220, y: n.y ?? 0 },
        label: n.label,
      });
    });

    for (const c of current.nodes) {
      if (c.id && !seen.has(c.id)) {
        ops.push({ kind: "removeShape", blockId: id, shapeId: c.id });
      }
    }

    // Existing shapes keep their ids; new ones take the tempId minted above.
    const resolve = edgeResolver(next.nodes, (n, i) => n.id ?? `n${i}`);
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
        tempId: `e${i}`,
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
    ...(children ? { children } : {}),
  };
}

/** Nested items are ordinary blocks with their own ids — flatten for diffing. */
function flatten(nodes: DocNode[]): DocNode[] {
  return nodes.flatMap((n) =>
    "children" in n && n.children?.length ? [n, ...flatten(n.children)] : [n],
  );
}

export type CompileContext = {
  /**
   * Fallback insertion point for new blocks, used only when their position
   * can't be inferred from surrounding tagged blocks. Normally the cursor block.
   */
  anchorBlockId?: string;
  /** Current document in the same normalized shape, for like-for-like diffing. */
  current: DocNode[];
};

export function compileDocHtml(next: DocNode[], ctx: CompileContext): Batch {
  const currentById = new Map(
    flatten(ctx.current)
      .filter((n) => n.id)
      .map((n) => [n.id!, n]),
  );
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

  all.forEach((node, i) => {
    if (insertedWithParent.has(node)) return;
    const existing = node.id ? currentById.get(node.id) : undefined;

    if (existing && existing.type === node.type) {
      ops.push(...updateOps(node, existing));
      anchor = { at: "after", ref: node.id! };
      return;
    }

    // Placement: after whatever preceded it, else BEFORE the next known block
    // (so a new block written at the top of the document lands at the top),
    // else the caller's fallback.
    let at: Position;
    if (anchor) {
      at = anchor;
    } else {
      const following = all
        .slice(i + 1)
        .find((n) => n.id && currentById.has(n.id));
      if (following) at = { at: "before", ref: following.id! };
      else if (ctx.anchorBlockId) at = { at: "after", ref: ctx.anchorBlockId };
      else at = { at: "docEnd" };
    }

    // Either brand new, or the same id with a different type — the vocabulary
    // has no "change type" op, so insert the replacement and drop the original.
    const tempId = `t${temp++}`;
    ops.push({
      kind: "insertBlocks",
      at,
      blocks: [newBlockFor(node, tempId)],
    });
    if ("children" in node && node.children?.length) {
      for (const d of flatten(node.children)) insertedWithParent.add(d);
    }
    if (node.type === "canvas") {
      const shapeId = (n: { id?: string }, i: number) => n.id ?? `${tempId}n${i}`;
      node.nodes.forEach((n, i) =>
        ops.push({
          kind: "addShape",
          blockId: tempId,
          tempId: shapeId(n, i),
          shape: n.shape,
          position: { x: n.x ?? i * 220, y: n.y ?? 0 },
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
    if (existing) ops.push({ kind: "removeBlock", blockId: existing.id! });
    anchor = { at: "after", ref: tempId };
  });

  return { ops };
}
