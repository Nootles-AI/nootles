import * as Y from "yjs";
import { batch as batchSchema, type Batch, type Operation } from "@/convex/ai/operations";
import type { ParseHtml } from "@/app/components/editor/canvas/scene/parse";
import { applyNmlBatch, NmlBatchCompileError } from "@/app/lib/nml/model/apply";
import { NML_RECEIPTS_ROOT, NmlCommandConflict, type NmlCommandReceipt } from "@/app/lib/nml/commands";
import { decodeNmlDocument, type NmlTransactionOrigin } from "@/app/lib/nml/yjs";
import { assertValidDocument, NmlValidationError } from "@/app/lib/nml/validate";
import type { NmlBlock, NmlDocument } from "@/app/lib/nml/schema";
import { nmlOutline } from "./outline";

/**
 * MCP Phase 4 — an agent's edit of a served document, and its undo, as pure
 * functions over the document's stored update history.
 *
 * An edit is the model's operation vocabulary (`convex/ai/operations.ts`)
 * compiled by Phase 2.5's applier into ONE attributed canonical transaction:
 * `actor.kind: "model"`, one `batchId`, an idempotency key. Its result is two
 * Yjs updates — the edit itself, and its inverse, captured at the same moment
 * by an origin-scoped `Y.UndoManager` the way `NmlReviewHistory` captures a
 * model batch in a browser. The inverse is what "Undo" applies later.
 *
 * An undo is only ever exact. Every node the edit touched is fingerprinted
 * before and after (hashes, never content); an undo is refused when any of them
 * has changed since, and a result whose touched nodes are not back to their
 * "before" or whose untouched nodes moved at all is refused rather than
 * written. So an undo can never take back work a person did after the agent.
 *
 * Nothing here touches the `prosemirror` compatibility root: callers pass
 * `writeCompat`, which projects canonical NML into it inside the same update
 * (the server does that with a headless BlockNote, `nml/serverMirror.ts`).
 */

// ---- Input -------------------------------------------------------------------

export class EditInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditInputError";
  }
}

/** A tool-call argument an agent might reasonably send, made into a Batch. */
export function parseEditOps(input: unknown): Batch {
  if (!Array.isArray(input) || input.length === 0) {
    throw new EditInputError("`operations` must be a non-empty array of operations.");
  }
  if (input.length > MAX_OPERATIONS) {
    throw new EditInputError(`At most ${MAX_OPERATIONS} operations fit in one edit; split it into several edits.`);
  }
  const parsed = batchSchema.safeParse({ ops: input.map(loosen) });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue.path.slice(1).join(".");
    throw new EditInputError(`operations${where ? `.${where}` : ""}: ${issue.message}`);
  }
  return parsed.data;
}

export const MAX_OPERATIONS = 100;

/**
 * Agents write `"content": "plain words"` far more often than a run list; both
 * mean the same thing, so a string is taken as one unmarked text run wherever
 * inline content goes. Nothing else is guessed at.
 */
function loosen(op: unknown): unknown {
  if (typeof op !== "object" || op === null) return op;
  const record = op as Record<string, unknown>;
  const runs = (value: unknown) => (typeof value === "string" ? (value ? [{ type: "text", text: value }] : []) : value);
  const block = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value;
    const b = { ...(value as Record<string, unknown>) };
    if ("content" in b) b.content = runs(b.content);
    if (Array.isArray(b.rows)) b.rows = b.rows.map((row) => (Array.isArray(row) ? row.map(runs) : row));
    if (Array.isArray(b.children)) b.children = b.children.map(block);
    return b;
  };
  const next = { ...record };
  if ("content" in next) next.content = runs(next.content);
  if (Array.isArray(next.blocks)) next.blocks = next.blocks.map(block);
  if (Array.isArray(next.rows)) next.rows = next.rows.map((row) => (Array.isArray(row) ? row.map(runs) : row));
  return next;
}

// ---- What changed --------------------------------------------------------------

export type EditChangeKind = "added" | "changed" | "removed" | "moved";
export type EditChange = { kind: EditChangeKind; id: string; type: string; text: string };
/** One node's fingerprint either side of an edit; null where it did not exist. */
export type Touched = { id: string; before: string | null; after: string | null };

type Placed = { block: NmlBlock; parentId: string | null };

function index(document: NmlDocument): Map<string, Placed> {
  const out = new Map<string, Placed>();
  const walk = (blocks: NmlBlock[], parentId: string | null) => {
    for (const block of blocks) {
      out.set(block.id, { block, parentId });
      walk(block.children, block.id);
    }
  };
  walk(document.blocks, null);
  return out;
}

/** cyrb53: a fast 53-bit string hash. Fingerprints only ever compare. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A node as itself: what it says and where it hangs, but not its children's content. */
function ownState({ block, parentId }: Placed): string {
  const { children, ...own } = block;
  return JSON.stringify([own, parentId, children.map((child) => child.id)]);
}

function fingerprint(placed: Placed | undefined): string | null {
  return placed ? hash(ownState(placed)) : null;
}

function describe(block: NmlBlock): string {
  const line = nmlOutline({ schemaVersion: 1, documentId: "", blocks: [{ ...block, children: [] }] }, { maxChars: 120 }).blocks[0];
  return line?.text.replace(/\s+/g, " ").trim() ?? "";
}

/**
 * Which nodes an edit touched and how, for the agent's receipt, the card and
 * the undo check. A removed or added subtree reports its top node only; a node
 * whose parent or child list changed because of that is still fingerprinted, so
 * an undo notices anyone editing around it.
 */
export function diffDocuments(
  before: NmlDocument,
  after: NmlDocument,
  movedIds: ReadonlySet<string> = new Set(),
): { changes: EditChange[]; touched: Touched[] } {
  const was = index(before);
  const now = index(after);
  const changes: EditChange[] = [];
  const touched = new Map<string, Touched>();
  const touch = (id: string) => {
    if (!touched.has(id)) touched.set(id, { id, before: fingerprint(was.get(id)), after: fingerprint(now.get(id)) });
  };
  for (const [id, placed] of now) {
    const prior = was.get(id);
    if (!prior) {
      touch(id);
      if (placed.parentId !== null && !was.has(placed.parentId)) continue;
      changes.push({ kind: "added", id, type: placed.block.type, text: describe(placed.block) });
      continue;
    }
    if (ownState(prior) === ownState(placed)) continue;
    touch(id);
    const { children: _a, ...ownBefore } = prior.block;
    const { children: _b, ...ownAfter } = placed.block;
    const content = JSON.stringify(ownBefore) !== JSON.stringify(ownAfter);
    const moved = movedIds.has(id) || prior.parentId !== placed.parentId;
    if (content) changes.push({ kind: "changed", id, type: placed.block.type, text: describe(placed.block) });
    else if (moved) changes.push({ kind: "moved", id, type: placed.block.type, text: describe(placed.block) });
  }
  for (const [id, placed] of was) {
    if (now.has(id)) continue;
    touch(id);
    if (placed.parentId !== null && !now.has(placed.parentId)) continue;
    changes.push({ kind: "removed", id, type: placed.block.type, text: describe(placed.block) });
  }
  // A move within the same parent changes no node's own state but the parent's
  // child order — reported by the op, fingerprinted through the parent above.
  for (const id of movedIds) {
    if (changes.some((c) => c.id === id) || !now.has(id)) continue;
    changes.push({ kind: "moved", id, type: now.get(id)!.block.type, text: describe(now.get(id)!.block) });
  }
  if (movedIds.size) {
    // Top-level order has no parent node to carry it; the moved node's
    // neighbours in `after` stand in, so an undo sees the order it restores.
    for (const id of movedIds) touch(id);
  }
  return { changes, touched: [...touched.values()] };
}

// ---- Edit --------------------------------------------------------------------

export type EditActor = { userId: string; clientId: string };

export type PreparedEdit =
  | {
      status: "applied";
      /** The update to append: canonical NML plus its compatibility projection. */
      forward: Uint8Array;
      /** Applied to the document later, this takes the canonical change back. */
      inverse: Uint8Array;
      changes: EditChange[];
      touched: Touched[];
      /** The agent's `tempId`s, resolved to the ids the blocks now have. */
      created: Record<string, string>;
      blockCount: number;
    }
  /** The idempotency key was already spent on these same operations: nothing new to write. */
  | { status: "replayed"; created: Record<string, string> }
  | { status: "rejected"; code: string; message: string; operationIndex?: number };

export type PrepareEditOptions = {
  updates: ArrayBuffer[];
  batch: Batch;
  actor: EditActor;
  batchId: string;
  idempotencyKey: string;
  createId: () => string;
  parseHtml?: ParseHtml;
  /** Rewrites the compatibility root from canonical NML (`before`: as it stood before the batch). */
  writeCompat?: (doc: Y.Doc, before: NmlDocument) => void;
};

export function rebuild(updates: ArrayBuffer[]): Y.Doc {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, new Uint8Array(update));
  return doc;
}

function movedBy(ops: Operation[]): Set<string> {
  return new Set(ops.flatMap((op) => (op.kind === "moveBlock" ? [op.blockId] : [])));
}

/** Where a model batch's tempIds landed, from the executor's receipt. */
function createdIds(batch: Batch, temporaryIds: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (blocks: Array<{ tempId: string; children?: Array<{ tempId: string; children?: unknown[] }> }>) => {
    for (const block of blocks) {
      if (temporaryIds[block.tempId]) out[block.tempId] = temporaryIds[block.tempId];
      if (block.children) visit(block.children as never);
    }
  };
  for (const op of batch.ops) if (op.kind === "insertBlocks") visit(op.blocks);
  return out;
}

export async function prepareEdit(options: PrepareEditOptions): Promise<PreparedEdit> {
  const doc = rebuild(options.updates);
  try {
    // A key already spent means this call is a retry of one that landed. It is
    // judged here, before compiling: the batch compiled against the edited page
    // is not the batch that was sent (the server has checked it is the same
    // operations — `mcp/docs.ts`).
    const spent = doc.getMap<string>(NML_RECEIPTS_ROOT).get(options.idempotencyKey);
    if (spent) {
      const receipt = JSON.parse(spent) as NmlCommandReceipt;
      return { status: "replayed", created: createdIds(options.batch, receipt.temporaryIds) };
    }
    const origin: NmlTransactionOrigin = {
      version: 1,
      transactionId: options.batchId,
      actor: { kind: "model", userId: options.actor.userId, clientId: options.actor.clientId },
      command: "mcp-edit",
      requestId: options.idempotencyKey,
      batchId: options.batchId,
    };
    // Scoped to the doc, as `NmlReviewHistory` is: NML edits land deep in
    // nested types. Only this batch's own transaction is captured.
    const capture = new Y.UndoManager(doc, { trackedOrigins: new Set([origin]), captureTimeout: 0 });
    const before = decodeNmlDocument(doc);
    const start = Y.encodeStateVector(doc);
    let applied;
    try {
      applied = await applyNmlBatch({
        doc,
        batch: options.batch,
        origin,
        idempotencyKey: options.idempotencyKey,
        authorize: () => true,
        createId: options.createId,
        parseHtml: options.parseHtml,
      });
    } catch (error) {
      if (error instanceof NmlCommandConflict) return { status: "rejected", code: error.code, message: error.message };
      if (error instanceof NmlBatchCompileError) {
        return { status: "rejected", code: "invalid_operation", message: error.message, operationIndex: error.operationIndex };
      }
      if (error instanceof NmlValidationError) return { status: "rejected", code: "invalid_command", message: error.message };
      throw error;
    }
    const created = createdIds(options.batch, applied.receipt.temporaryIds);
    if (capture.undoStack.length === 0) {
      capture.destroy();
      return { status: "replayed", created };
    }
    options.writeCompat?.(doc, before);
    const forward = Y.encodeStateAsUpdate(doc, start);
    const afterEdit = Y.encodeStateVector(doc);
    capture.undo();
    const inverse = Y.encodeStateAsUpdate(doc, afterEdit);
    capture.destroy();
    const { changes, touched } = diffDocuments(before, applied.after, movedBy(options.batch.ops));
    return { status: "applied", forward, inverse, changes, touched, created, blockCount: index(applied.after).size };
  } finally {
    doc.destroy();
  }
}

// ---- Undo --------------------------------------------------------------------

export type PreparedUndo =
  | { status: "ready"; update: Uint8Array }
  /** Someone changed these nodes after the agent did; undoing would take their work too. */
  | { status: "changed-since"; ids: string[] }
  /** The inverse did not land exactly; nothing is written. */
  | { status: "inexact"; ids: string[] };

export function prepareUndo(options: {
  updates: ArrayBuffer[];
  inverse: ArrayBuffer;
  touched: Touched[];
  writeCompat?: (doc: Y.Doc, before: NmlDocument) => void;
}): PreparedUndo {
  const doc = rebuild(options.updates);
  try {
    const current = decodeNmlDocument(doc);
    const now = index(current);
    const moved = options.touched.filter((t) => fingerprint(now.get(t.id)) !== t.after).map((t) => t.id);
    if (moved.length) return { status: "changed-since", ids: moved };

    const start = Y.encodeStateVector(doc);
    Y.applyUpdate(doc, new Uint8Array(options.inverse));
    let reverted: NmlDocument;
    try {
      reverted = decodeNmlDocument(doc);
      assertValidDocument(reverted);
    } catch {
      return { status: "inexact", ids: options.touched.map((t) => t.id) };
    }
    const back = index(reverted);
    const wrong = options.touched.filter((t) => fingerprint(back.get(t.id)) !== t.before).map((t) => t.id);
    const touchedIds = new Set(options.touched.map((t) => t.id));
    for (const [id, placed] of now) {
      if (touchedIds.has(id)) continue;
      if (fingerprint(back.get(id)) !== fingerprint(placed)) wrong.push(id);
    }
    for (const id of back.keys()) if (!now.has(id) && !touchedIds.has(id)) wrong.push(id);
    if (wrong.length) return { status: "inexact", ids: wrong };

    options.writeCompat?.(doc, current);
    return { status: "ready", update: Y.encodeStateAsUpdate(doc, start) };
  } finally {
    doc.destroy();
  }
}
