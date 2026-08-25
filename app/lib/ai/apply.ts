import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";
import type {
  Batch,
  InlineRun,
  Mark,
  NewBlock,
  Operation,
  Position,
} from "@/convex/ai/operations";
import type { AnyBlock } from "./projection";
import { duringAiApply, pushAiOp, type OpFeature } from "@/app/lib/debugRing";

/**
 * The applier: turns a validated op batch into the EXACT same BlockNote editor
 * calls a human action would make (`insertBlocks`/`updateBlock`/`removeBlocks`),
 * with math ops handled as a read-modify-write of the block's props. This is the
 * concrete meaning of "the AI edits through the same operations a human uses".
 *
 * A diagram is edited as a whole through `updateBlockProps` — its canvas HTML is
 * the mirror of per-shape Yjs maps, so there is no per-shape op here to bypass
 * them with.
 *
 * The applier — not the caller — mints every new id: blocks get their real ids
 * from `insertBlocks`' return value. `tempId`s in the batch are resolved to those
 * real ids as we go, so later ops can reference blocks created earlier in the
 * same batch.
 *
 * It also records what each op DID — where it landed, what it produced, what it
 * changed, what it deleted. Minting is what makes an op non-repeatable, so none
 * of that can be re-derived once the call has ended, and a review answered per
 * hunk has to know it (see app/lib/ai/review/).
 *
 * Assumes the batch already passed `resolveBatch` (references are valid). Take a
 * checkpoint before calling this if you need to undo a partially-applied batch.
 */

// The op layer is dynamic by design; bridge to BlockNote's schema-generic editor
// with a loosely-typed handle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPartialBlock = PartialBlock<any, any, any>;

type BNText = { type: "text"; text: string; styles: Partial<Record<Mark, boolean>> };
type BNInline =
  | BNText
  | { type: "math"; props: { latex: string } }
  | { type: "pageMention"; props: { pageId: string; title: string } }
  | { type: "link"; href: string; content: BNText[] };

const styled = (r: { text: string; marks?: Mark[] }): BNText => ({
  type: "text",
  text: r.text,
  styles: Object.fromEntries((r.marks ?? []).map((m) => [m, true])),
});

function compileInline(runs: InlineRun[]): BNInline[] {
  return runs.map((r) => {
    if (r.type === "math") return { type: "math" as const, props: { latex: r.latex } };
    if (r.type === "pageRef") {
      return {
        type: "pageMention" as const,
        props: { pageId: r.pageId, title: r.title },
      };
    }
    if (r.type === "link") {
      return { type: "link" as const, href: r.href, content: r.content.map(styled) };
    }
    return styled(r);
  });
}

/**
 * BlockNote holds a table as `tableContent` rather than a run list. Column
 * widths are the user's, not the model's — left undefined only when there is no
 * previous set to keep, which is BlockNote's "size these yourself".
 */
function tableContent(
  rows: InlineRun[][][],
  headerRows?: number,
  columnWidths?: Array<number | undefined>,
) {
  return {
    type: "tableContent" as const,
    columnWidths: columnWidths ?? (rows[0] ?? []).map(() => undefined),
    ...(headerRows ? { headerRows } : {}),
    rows: rows.map((cells) => ({ cells: cells.map(compileInline) })),
  };
}

/** `tempId` → the real id it was given, for blocks (including nested ones). */
export type IdMap = {
  blocks: Record<string, string>;
};

/**
 * What one op actually did. Enough to undo it without re-deriving anything:
 * `anchor` is the position with `docStart`/`docEnd` already resolved to a
 * concrete block, and `produced` is post-apply block JSON, ids baked in.
 */
export type OpTrace = {
  opIndex: number;
  anchor?: { ref: string; placement: "before" | "after" };
  produced?: AnyBlock[];
  /** Existing blocks the op changed in place. */
  touched?: string[];
  /**
   * Blocks it left where they were but somewhere else. Kept apart from
   * `touched` because nothing about them changed except position, and position
   * is the one thing rewriting their content cannot put back.
   */
  moved?: string[];
  /** Blocks it deleted, as they were. */
  removed?: AnyBlock[];
};

export type ApplyResult = IdMap & { trace: OpTrace[] };

type Wants = (block: AnyBlock) => boolean;

const holdsText: Wants = (b) => Array.isArray(b.content);
const holdsWords: Wants = (b) => Array.isArray(b.content) && b.content.length > 0;

/** The last block in a subtree the caret could sit in. */
function lastLeaf(block: AnyBlock, wants: Wants): string | undefined {
  const children = block.children ?? [];
  for (let i = children.length - 1; i >= 0; i--) {
    const found = lastLeaf(children[i], wants);
    if (found) return found;
  }
  return wants(block) ? (block.id as string) : undefined;
}

function lastProduced(result: ApplyResult, wants: Wants): string | undefined {
  for (let i = result.trace.length - 1; i >= 0; i--) {
    const produced = result.trace[i].produced;
    if (!produced?.length) continue;
    for (let j = produced.length - 1; j >= 0; j--) {
      const found = lastLeaf(produced[j], wants);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Where the caret belongs once a batch has been applied: the end of the last
 * block it actually wrote. Accepting a suggestion should leave you where you
 * would be if you had typed it, and after a three-item list that is the end of
 * item three.
 *
 * A block with WORDS in it is preferred over merely one that could hold them,
 * because splicing a completion into the middle of a paragraph leaves the far
 * half of that paragraph behind as an empty block at the end of the batch.
 * Nothing draws it — it is the seam, not the suggestion — so landing the caret
 * there reads as overshooting onto a blank line.
 *
 * `undefined` when the batch wrote nothing to sit in (a diagram, say), in which
 * case the caret is better left alone.
 */
export function caretTarget(result: ApplyResult): string | undefined {
  return lastProduced(result, holdsWords) ?? lastProduced(result, holdsText);
}

/**
 * Apply a batch, recording it as the AI's work.
 *
 * The inner call runs inside {@link duringAiApply} so the editor's transaction
 * listener — which logs what a person types — recognises these edits as already
 * accounted for and stays quiet. `feature` is the `aiCalls` name of whatever
 * asked, so a report's op timeline can be lined up against the cost ledger.
 */
export function applyBatch(
  editor: Editor,
  batch: Batch,
  feature?: OpFeature,
): ApplyResult {
  for (const op of batch.ops) pushAiOp(op, feature);
  return duringAiApply(() => applyBatchInner(editor, batch));
}

function applyBatchInner(editor: Editor, batch: Batch): ApplyResult {
  const blockIds = new Map<string, string>();
  const trace: OpTrace[] = [];

  const rBlock = (id: string) => blockIds.get(id) ?? id;

  const clone = (block: unknown) => structuredClone(block) as AnyBlock;
  const read = (id: string) => {
    const block = editor.getBlock(id);
    return block ? clone(block) : undefined;
  };

  /**
   * The applier only resolves top-level `tempId`s, but BlockNote mints an id for
   * every descendant of an inserted block too. Walking the returned tree beside
   * the one we asked for is what gives every nested item a real name — without
   * it an inserted outline reaches the hunks and the op log under `tempId`s,
   * which mean nothing once the call that minted them has ended.
   */
  const mapIds = (nb: NewBlock, block: AnyBlock) => {
    blockIds.set(nb.tempId, block.id);
    nb.children?.forEach((child, i) => {
      const real = block.children?.[i];
      if (real) mapIds(child, real);
    });
  };

  const firstId = () => editor.document[0].id as string;
  const lastId = () => {
    const d = editor.document;
    return d[d.length - 1].id as string;
  };

  const resolvePosition = (
    pos: Position,
  ): { ref: string; placement: "before" | "after" } => {
    switch (pos.at) {
      case "after":
        return { ref: rBlock(pos.ref), placement: "after" };
      case "before":
        return { ref: rBlock(pos.ref), placement: "before" };
      case "docStart":
        return { ref: firstId(), placement: "before" };
      case "docEnd":
        return { ref: lastId(), placement: "after" };
    }
  };

  const runOp = (op: Operation, opIndex: number) => {
    const entry: OpTrace = { opIndex };
    trace.push(entry);
    switch (op.kind) {
      case "insertBlocks": {
        const { ref, placement } = resolvePosition(op.at);
        // BlockNote's PartialBlock takes `children` directly, so nesting round-
        // trips natively. Only top-level tempIds get resolved to real ids.
        const toPartial = (nb: NewBlock): AnyPartialBlock => ({
          type: nb.type,
          ...(nb.props ? { props: nb.props } : {}),
          ...(nb.content ? { content: compileInline(nb.content) } : {}),
          ...(nb.rows ? { content: tableContent(nb.rows, nb.headerRows) } : {}),
          ...(nb.children?.length
            ? { children: nb.children.map(toPartial) }
            : {}),
        });
        const partials: AnyPartialBlock[] = op.blocks.map(toPartial);
        const inserted = editor.insertBlocks(partials, ref, placement);
        op.blocks.forEach((nb, i) => {
          const real = inserted[i] as AnyBlock | undefined;
          if (real) mapIds(nb, real);
        });
        entry.anchor = { ref, placement };
        entry.produced = inserted.map(clone);
        break;
      }
      case "updateBlockProps":
        entry.touched = [rBlock(op.blockId)];
        editor.updateBlock(rBlock(op.blockId), {
          props: op.props,
        } as AnyPartialBlock);
        break;
      case "setBlockContent":
        entry.touched = [rBlock(op.blockId)];
        editor.updateBlock(rBlock(op.blockId), {
          content: compileInline(op.content),
        } as AnyPartialBlock);
        break;
      case "setTableRows": {
        const real = rBlock(op.blockId);
        entry.touched = [real];
        const held = (
          editor.getBlock(real)?.content as
            | { columnWidths?: Array<number | undefined> }
            | undefined
        )?.columnWidths;
        const columns = op.rows[0]?.length ?? 0;
        editor.updateBlock(real, {
          content: tableContent(
            op.rows,
            op.headerRows,
            held?.length === columns ? held : undefined,
          ),
        } as AnyPartialBlock);
        break;
      }
      case "moveBlock": {
        const real = rBlock(op.blockId);
        const { ref, placement } = resolvePosition(op.to);
        if (ref === real) break;
        const block = editor.getBlock(real);
        if (!block) break;
        entry.anchor = { ref, placement };
        entry.moved = [real];
        editor.removeBlocks([real]);
        editor.insertBlocks([block as AnyPartialBlock], ref, placement);
        break;
      }
      case "removeBlock": {
        const real = rBlock(op.blockId);
        const gone = read(real);
        // Already went with its parent. `removeBlocks` throws on an id it cannot
        // find, and a batch that dies halfway leaves a document nobody can review.
        if (!gone) break;
        entry.removed = [gone];
        editor.removeBlocks([real]);
        break;
      }
      case "setMathRows":
        entry.touched = [rBlock(op.blockId)];
        editor.updateBlock(rBlock(op.blockId), {
          props: { source: op.rows.join("\n") },
        } as AnyPartialBlock);
        break;
      case "updateMathRow": {
        const real = rBlock(op.blockId);
        entry.touched = [real];
        const block = editor.getBlock(real);
        const source = String(
          (block?.props as { source?: string } | undefined)?.source ?? "",
        );
        const rows = source.length ? source.split("\n") : [""];
        if (op.rowIndex < rows.length) {
          rows[op.rowIndex] = op.latex;
          editor.updateBlock(real, {
            props: { source: rows.join("\n") },
          } as AnyPartialBlock);
        }
        break;
      }
    }
  };

  batch.ops.forEach(runOp);

  // Read back at the end rather than at insert time: later ops in the same batch
  // may still write to a block this one produced, so the block handed back by
  // `insertBlocks` is not yet what the batch leaves behind.
  for (const entry of trace) {
    if (entry.produced) entry.produced = entry.produced.map((b) => read(b.id) ?? b);
  }
  return { blocks: Object.fromEntries(blockIds), trace };
}
