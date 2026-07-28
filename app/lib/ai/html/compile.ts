import type { Batch, InlineRun, Operation } from "@/convex/ai/operations";
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

    const key = (e: { from: string; to: string }) => `${e.from}->${e.to}`;
    const currentEdges = new Set(current.edges.map(key));
    next.edges.forEach((e, i) => {
      if (currentEdges.has(key(e))) return;
      ops.push({
        kind: "connectEdge",
        blockId: id,
        tempId: `e${i}`,
        source: { tempId: e.from },
        target: { tempId: e.to },
        ...(e.label ? { label: e.label } : {}),
      });
    });
    return ops;
  }

  return ops;
}

function newBlockFor(node: DocNode, tempId: string) {
  const props = propsOf(node);
  return {
    tempId,
    type: node.type,
    ...(props ? { props } : {}),
    ...("content" in node ? { content: runsToInline(node.content) } : {}),
  };
}

export type CompileContext = {
  /** Where untagged (new) blocks are inserted. */
  anchorBlockId: string;
  /** Current document in the same normalized shape, for like-for-like diffing. */
  current: DocNode[];
};

export function compileDocHtml(next: DocNode[], ctx: CompileContext): Batch {
  const currentById = new Map(
    ctx.current.filter((n) => n.id).map((n) => [n.id!, n]),
  );
  const ops: Operation[] = [];
  let anchor = ctx.anchorBlockId;
  let temp = 0;

  for (const node of next) {
    const existing = node.id ? currentById.get(node.id) : undefined;

    if (existing && existing.type === node.type) {
      ops.push(...updateOps(node, existing));
      anchor = node.id!;
      continue;
    }

    // Either brand new, or the same id with a different type — the vocabulary
    // has no "change type" op, so insert the replacement and drop the original.
    const tempId = `t${temp++}`;
    ops.push({
      kind: "insertBlocks",
      at: { at: "after", ref: anchor },
      blocks: [newBlockFor(node, tempId)],
    });
    if (node.type === "canvas") {
      node.nodes.forEach((n, i) =>
        ops.push({
          kind: "addShape",
          blockId: tempId,
          tempId: n.id ?? `${tempId}n${i}`,
          shape: n.shape,
          position: { x: n.x ?? i * 220, y: n.y ?? 0 },
          label: n.label,
        }),
      );
      node.edges.forEach((e, i) =>
        ops.push({
          kind: "connectEdge",
          blockId: tempId,
          tempId: `${tempId}e${i}`,
          source: { tempId: e.from },
          target: { tempId: e.to },
          ...(e.label ? { label: e.label } : {}),
        }),
      );
    }
    if (existing) ops.push({ kind: "removeBlock", blockId: existing.id! });
    anchor = tempId;
  }

  return { ops };
}
