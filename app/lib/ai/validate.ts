import { parseBatch, type Batch } from "@/convex/ai/operations";
import type { DocIndex } from "./projection";

/**
 * The two-gate validation that runs before ANY mutation touches the document:
 *
 *   1. Zod shape validation (via `parseBatch`).
 *   2. Reference resolution against the current doc's reverse index — every
 *      referenced block id must already exist, or be a `tempId` declared
 *      earlier in the same batch.
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
  const requireMath = (id: string, ctx: string) => requireType(id, "mathBlock", ctx);
  const checkPositionRef = (
    at: { at: string; ref?: string },
    ctx: string,
  ) => {
    if ((at.at === "after" || at.at === "before") && at.ref) {
      requireBlock(at.ref, `${ctx} position`);
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
    }
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, batch };
}
