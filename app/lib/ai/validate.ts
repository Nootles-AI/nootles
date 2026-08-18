import { parseBatch, type Batch } from "@/convex/ai/operations";
import type { DocIndex } from "./projection";

/**
 * The two-gate validation that runs before ANY mutation touches the document:
 *
 *   1. Zod shape validation (via `parseBatch`).
 *   2. Reference resolution against the current doc's reverse index — every
 *      referenced block/shape/edge id must already exist, or be a `tempId`
 *      declared earlier in the same batch.
 *
 * A batch is all-or-nothing: if any op fails either gate, the whole batch is
 * rejected with a structured error and nothing is applied. (A future LLM can
 * read these errors and retry.) `tempId` minting happens later in the applier —
 * this gate only proves the batch is internally consistent and well-addressed.
 */

export type ResolveResult =
  | { ok: true; batch: Batch }
  | { ok: false; errors: string[] };

/**
 * A rejected batch is invisible by design — the suggestion simply never appears,
 * which is right for the reader and terrible for us. This is the one place that
 * says so out loud, in development only.
 *
 * Deliberately NOT a partial apply: a batch is atomic because its ops are
 * interdependent. Folding four paragraphs into a table compiles to one
 * `insertBlocks` plus four `removeBlock`s, so applying "the valid ones" after
 * dropping the insert deletes the rows and creates nothing.
 */
export function warnRejected(where: string, result: ResolveResult): void {
  if (result.ok || process.env.NODE_ENV === "production") return;
  console.warn(`[Nootles] ${where}: batch rejected\n  ${result.errors.join("\n  ")}`);
}

/**
 * Blocks that hold no inline content: their text, if any, lives in props. An
 * op trying to write runs into one of these is always a mistake, and catching
 * it here is what stops a stray rewrite turning a divider into a paragraph.
 */
const CONTENTLESS = new Set([
  "codeBlock",
  "mathBlock",
  "canvas",
  "album",
  "storyboard",
  "divider",
  "image",
  "video",
  "audio",
  "location",
  "file",
]);

function typeHasContent(type: string): boolean {
  return !CONTENTLESS.has(type);
}

type BlockRef = { type: string; hasContent: boolean };
type ShapeRefInfo = { canvasBlockId: string };
type EdgeRefInfo = { canvasBlockId: string };

export function resolveBatch(input: unknown, index: DocIndex): ResolveResult {
  const parsed = parseBatch(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "batch"}: ${i.message}`,
      ),
    };
  }
  const batch = parsed.data;
  const errors: string[] = [];

  // Known ids grow as we walk the batch: real ids from the index, plus tempIds
  // declared by earlier ops.
  const blocks = new Map<string, BlockRef>();
  for (const [id, e] of index.blocks) {
    blocks.set(id, { type: e.type, hasContent: e.hasContent });
  }
  const shapes = new Map<string, ShapeRefInfo>(index.shapes);
  const edges = new Map<string, EdgeRefInfo>(index.edges);

  const tag = (id: string) => `⟦${id}⟧`;

  const requireBlock = (id: string, ctx: string): BlockRef | null => {
    const b = blocks.get(id);
    if (!b) errors.push(`${ctx}: unknown block ${tag(id)}`);
    return b ?? null;
  };
  const requireType = (id: string, type: string, ctx: string): boolean => {
    const b = blocks.get(id);
    if (!b) {
      errors.push(`${ctx}: unknown block ${tag(id)}`);
      return false;
    }
    if (b.type !== type) {
      errors.push(`${ctx}: block ${tag(id)} is a ${b.type}, not a ${type}`);
      return false;
    }
    return true;
  };
  const requireCanvas = (id: string, ctx: string) => requireType(id, "canvas", ctx);
  const requireMath = (id: string, ctx: string) => requireType(id, "mathBlock", ctx);
  const checkPositionRef = (
    at: { at: string; ref?: string },
    ctx: string,
  ) => {
    if ((at.at === "after" || at.at === "before") && at.ref) {
      requireBlock(at.ref, `${ctx} position`);
    }
  };

  const checkShapeInCanvas = (
    shapeId: string,
    canvasBlockId: string,
    ctx: string,
  ) => {
    const s = shapes.get(shapeId);
    if (!s) {
      errors.push(`${ctx}: unknown shape ${tag(shapeId)}`);
      return;
    }
    if (s.canvasBlockId !== canvasBlockId) {
      errors.push(`${ctx}: shape ${tag(shapeId)} is not in ${tag(canvasBlockId)}`);
    }
  };

  const checkEdgeInCanvas = (
    edgeId: string,
    canvasBlockId: string,
    ctx: string,
  ) => {
    const e = edges.get(edgeId);
    if (!e) {
      errors.push(`${ctx}: unknown edge ${tag(edgeId)}`);
      return;
    }
    if (e.canvasBlockId !== canvasBlockId) {
      errors.push(`${ctx}: edge ${tag(edgeId)} is not in ${tag(canvasBlockId)}`);
    }
  };

  batch.ops.forEach((op, i) => {
    const ctx = `ops[${i}] ${op.kind}`;
    switch (op.kind) {
      case "insertBlocks": {
        checkPositionRef(op.at, ctx);
        for (const nb of op.blocks) {
          if (blocks.has(nb.tempId)) {
            errors.push(`${ctx}: duplicate tempId ${tag(nb.tempId)}`);
          }
          if (nb.content && !typeHasContent(nb.type)) {
            errors.push(`${ctx}: ${nb.type} cannot hold inline content`);
          }
          blocks.set(nb.tempId, {
            type: nb.type,
            hasContent: typeHasContent(nb.type),
          });
        }
        break;
      }
      case "updateBlockProps":
        requireBlock(op.blockId, ctx);
        break;
      case "setBlockContent": {
        const b = requireBlock(op.blockId, ctx);
        if (b && !b.hasContent) {
          errors.push(`${ctx}: block ${tag(op.blockId)} (${b.type}) holds no inline content`);
        }
        break;
      }
      case "setTableRows":
        requireType(op.blockId, "table", ctx);
        break;
      case "moveBlock":
        requireBlock(op.blockId, ctx);
        checkPositionRef(op.to, ctx);
        break;
      case "removeBlock":
        requireBlock(op.blockId, ctx);
        break;
      case "setMathRows":
      case "updateMathRow": {
        if (requireMath(op.blockId, ctx) && op.kind === "updateMathRow") {
          const rows = index.mathRows.get(op.blockId);
          if (rows !== undefined && op.rowIndex >= rows) {
            errors.push(
              `${ctx}: rowIndex ${op.rowIndex} out of range (${rows} rows)`,
            );
          }
        }
        break;
      }
      case "addShape": {
        if (requireCanvas(op.blockId, ctx)) {
          if (shapes.has(op.tempId)) {
            errors.push(`${ctx}: duplicate tempId ${tag(op.tempId)}`);
          }
          shapes.set(op.tempId, { canvasBlockId: op.blockId });
        }
        break;
      }
      case "updateShape":
        if (requireCanvas(op.blockId, ctx)) {
          checkShapeInCanvas(op.shapeId, op.blockId, ctx);
        }
        break;
      case "removeShape":
        if (requireCanvas(op.blockId, ctx)) {
          checkShapeInCanvas(op.shapeId, op.blockId, ctx);
        }
        break;
      case "connectEdge": {
        if (requireCanvas(op.blockId, ctx)) {
          const resolveRef = (
            ref: { shapeId: string } | { tempId: string },
            side: string,
          ) => {
            const id = "shapeId" in ref ? ref.shapeId : ref.tempId;
            checkShapeInCanvas(id, op.blockId, `${ctx} ${side}`);
          };
          resolveRef(op.source, "source");
          resolveRef(op.target, "target");
          if (edges.has(op.tempId)) {
            errors.push(`${ctx}: duplicate tempId ${tag(op.tempId)}`);
          }
          edges.set(op.tempId, { canvasBlockId: op.blockId });
        }
        break;
      }
      case "disconnectEdge":
        if (requireCanvas(op.blockId, ctx)) {
          checkEdgeInCanvas(op.edgeId, op.blockId, ctx);
        }
        break;
      case "setEdgeLabel":
        if (requireCanvas(op.blockId, ctx)) {
          checkEdgeInCanvas(op.edgeId, op.blockId, ctx);
        }
        break;
    }
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, batch };
}
