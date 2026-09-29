"use node";

import { randomUUID } from "node:crypto";
import { v, type Infer } from "convex/values";
import { DOMParser, parseHTML } from "linkedom";
import { internal } from "../_generated/api";
import { action, internalAction, type ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { requireOwner } from "../auth";
import { isRateRefusal, limitMode } from "../requestLimits";
import { splitUpdate } from "../yshape";
import { writeCompatibilityRoot } from "@/app/lib/nml/serverMirror";
import { EditInputError, parseEditOps, prepareEdit, prepareUndo, type EditChange } from "@/app/lib/mcp/edits";
import { material as materialValidator } from "./docs";
import { mediaUrls, rebuild as decodeUpdates } from "./read";
import { sha256Hex } from "./tokens";

/**
 * MCP Phase 4 — `edit_doc` and `undo_edit` on the server (NT-123).
 *
 * An edit is computed here, in Node, against the stored history the isolate
 * hands over (`docs.readMaterial`), by `app/lib/mcp/edits.ts`: one attributed
 * model batch through the NML applier, the compatibility root projected in the
 * same update, and its inverse captured for undo. It is then committed by
 * `docs.commitEdit` only if the log is still where it was read — otherwise the
 * page moved under the agent, and the edit is computed again on the new page.
 * The executor validated the result against the exact state it lands on.
 *
 * Node, and linkedom's `document`, for the reasons `read.ts` gives plus one:
 * the compatibility projection runs a headless BlockNote.
 */

(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;
if (!("document" in globalThis)) {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document, window });
}

const parseHtml = (html: string) => new DOMParser().parseFromString(html, "text/html") as unknown as Document;

/**
 * One unit of the subject's `mcpEdit` budget, or the wait until there is one.
 * Enforced under `observe` too, for `admitBearer`'s reason: an agent loop has
 * nothing to learn from.
 */
async function spendEdit(ctx: ActionCtx, subject: string): Promise<number | null> {
  if (limitMode() === "off") return null;
  try {
    await ctx.runMutation(internal.requestLimits.debitFor, { bucket: "mcpEdit", subject });
    return null;
  } catch (error) {
    if (!isRateRefusal(error)) throw error;
    return error.data.retryAfterMs;
  }
}

/** Past this many rebuilds the page is too busy to edit; the agent is told to retry. */
const ATTEMPTS = 4;
const bytes = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

const change = v.object({
  kind: v.union(v.literal("added"), v.literal("changed"), v.literal("removed"), v.literal("moved")),
  id: v.string(),
  type: v.string(),
  text: v.string(),
});

const docRef = v.object({ docId: v.string(), pageId: v.id("pages"), projectId: v.id("projects"), title: v.string(), projectTitle: v.string() });

const editResult = v.union(
  v.object({
    status: v.literal("applied"),
    editId: v.id("mcpEdits"),
    doc: docRef,
    changes: v.array(change),
    created: v.record(v.string(), v.string()),
    blockCount: v.number(),
  }),
  v.object({ status: v.literal("replayed"), editId: v.id("mcpEdits"), doc: docRef }),
  v.object({
    status: v.literal("rejected"),
    code: v.string(),
    message: v.string(),
    operationIndex: v.optional(v.number()),
  }),
  v.object({
    status: v.literal("refused"),
    reason: v.union(
      v.literal("not-found"),
      v.literal("not-served"),
      v.literal("too-large"),
      v.literal("no-write"),
      v.literal("busy"),
      v.literal("rate-limited"),
    ),
    detail: v.optional(v.string()),
  }),
);
export type EditResult = Infer<typeof editResult>;

function counts(changes: EditChange[]) {
  const out = { added: 0, changed: 0, removed: 0, moved: 0 };
  for (const c of changes) out[c.kind]++;
  return out;
}

export const editDoc = internalAction({
  args: {
    subject: v.string(),
    grantId: v.id("mcpGrants"),
    clientName: v.string(),
    ref: v.string(),
    operations: v.any(),
    idempotencyKey: v.optional(v.string()),
  },
  returns: editResult,
  handler: async (ctx, args): Promise<EditResult> => {
    let batch;
    try {
      batch = parseEditOps(args.operations);
    } catch (error) {
      if (error instanceof EditInputError) return { status: "rejected", code: "invalid_input", message: error.message };
      throw error;
    }
    const wait = await spendEdit(ctx, args.subject);
    if (wait !== null) return { status: "refused", reason: "rate-limited", detail: String(Math.ceil(wait / 1000)) };
    const opsHash = await sha256Hex(JSON.stringify(batch.ops));
    const key = args.idempotencyKey?.trim() ? `mcp:${args.grantId}:${args.idempotencyKey.trim()}` : `mcp:${randomUUID()}`;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const material: Infer<typeof materialValidator> = await ctx.runQuery(internal.mcp.docs.readMaterial, {
        subject: args.subject,
        ref: args.ref,
      });
      if (material.status !== "ok") return material;
      const doc = {
        docId: material.doc.docId,
        pageId: material.doc.pageId,
        projectId: material.doc.projectId,
        title: material.doc.title,
        projectTitle: material.doc.projectTitle,
      };
      const prior = await ctx.runQuery(internal.mcp.docs.priorEdit, { subject: args.subject, idempotencyKey: key });
      if (prior) {
        if (prior.opsHash !== opsHash || prior.docId !== doc.docId) {
          return {
            status: "rejected",
            code: "idempotency_mismatch",
            message: "That idempotency_key was already used for a different edit. Use a new key for new operations.",
          };
        }
        return { status: "replayed", editId: prior.editId, doc };
      }
      const urls = await mediaUrls(ctx, decodeUpdates(material.updates));
      const batchId = randomUUID();
      const prepared = await prepareEdit({
        updates: material.updates,
        batch,
        actor: { userId: args.subject, clientId: `mcp:${args.grantId}` },
        batchId,
        idempotencyKey: key,
        createId: () => randomUUID(),
        parseHtml,
        writeCompat: (d) => writeCompatibilityRoot(d, (id) => urls.get(id)),
      });
      if (prepared.status === "rejected") return prepared;
      if (prepared.status === "replayed") {
        // The key is spent in the document but no record names it: the commit that
        // spent it is the one being read right now. Look again.
        continue;
      }
      // Typed: the storage API refuses a Blob whose content-type is empty.
      const inverse: Id<"_storage"> = await ctx.storage.store(
        new Blob([bytes(prepared.inverse)], { type: "application/octet-stream" }),
      );
      const committed = await ctx.runMutation(internal.mcp.docs.commitEdit, {
        subject: args.subject,
        grantId: args.grantId,
        clientName: args.clientName,
        docId: doc.docId,
        seq: material.seq,
        chunks: splitUpdate(prepared.forward),
        inverse,
        batchId,
        idempotencyKey: key,
        opsHash,
        counts: counts(prepared.changes),
        changedIds: prepared.changes.map((c) => c.id),
        touched: prepared.touched,
      });
      if (committed.status !== "ok") await ctx.runMutation(internal.mcp.docs.discardInverse, { storageId: inverse });
      if (committed.status === "stale") continue;
      if (committed.status === "refused") return { status: "refused", reason: committed.reason };
      return {
        status: "applied",
        editId: committed.editId,
        doc,
        changes: prepared.changes,
        created: prepared.created,
        blockCount: prepared.blockCount,
      };
    }
    return { status: "refused", reason: "busy", detail: "The page kept changing while the edit was being made." };
  },
});

const undoResult = v.union(
  v.object({ status: v.literal("undone"), docId: v.string(), pageId: v.id("pages"), projectId: v.id("projects"), title: v.string() }),
  v.object({
    status: v.literal("refused"),
    reason: v.union(
      v.literal("not-found"),
      v.literal("not-served"),
      v.literal("no-write"),
      v.literal("already-undone"),
      v.literal("expired"),
      v.literal("too-large"),
      v.literal("changed-since"),
      v.literal("inexact"),
      v.literal("busy"),
      v.literal("rate-limited"),
    ),
    ids: v.optional(v.array(v.string())),
  }),
);
export type UndoResult = Infer<typeof undoResult>;

async function undo(
  ctx: ActionCtx,
  args: { subject: string; editId: string; by: "agent" | "person"; grantId?: Id<"mcpGrants"> },
): Promise<UndoResult> {
  // A person's Undo is theirs to press; an agent's comes out of its edit budget.
  if (args.by === "agent" && (await spendEdit(ctx, args.subject)) !== null) return { status: "refused", reason: "rate-limited" };
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const material = await ctx.runQuery(internal.mcp.docs.undoMaterial, {
      subject: args.subject,
      editId: args.editId,
      grantId: args.grantId,
    });
    if (material.status !== "ok") return material;
    const blob = await ctx.storage.get(material.inverse);
    if (!blob) return { status: "refused", reason: "expired" };
    const urls = await mediaUrls(ctx, decodeUpdates(material.updates));
    const prepared = prepareUndo({
      updates: material.updates,
      inverse: await blob.arrayBuffer(),
      touched: material.touched,
      writeCompat: (d) => writeCompatibilityRoot(d, (id) => urls.get(id)),
    });
    if (prepared.status !== "ready") return { status: "refused", reason: prepared.status, ids: prepared.ids.slice(0, 20) };
    const committed = await ctx.runMutation(internal.mcp.docs.commitUndo, {
      subject: args.subject,
      editId: material.editId,
      grantId: args.grantId,
      by: args.by,
      seq: material.seq,
      chunks: splitUpdate(prepared.update),
    });
    if (committed.status === "stale") continue;
    if (committed.status === "refused") return committed;
    return { status: "undone", docId: material.docId, pageId: material.pageId, projectId: material.projectId, title: material.title };
  }
  return { status: "refused", reason: "busy" };
}

/** The agent taking back its own edit (`undo_edit`), through a grant that may still write. */
export const undoEdit = internalAction({
  args: {
    subject: v.string(),
    editId: v.string(),
    by: v.union(v.literal("agent"), v.literal("person")),
    grantId: v.optional(v.id("mcpGrants")),
  },
  returns: undoResult,
  handler: async (ctx, args): Promise<UndoResult> => await undo(ctx, args),
});

/** The page owner's Undo, from the page or Settings — signed in as themselves, never a stand-in. */
export const undoMine = action({
  args: { editId: v.id("mcpEdits") },
  returns: undoResult,
  handler: async (ctx, args): Promise<UndoResult> => {
    const subject = await requireOwner(ctx);
    return await undo(ctx, { subject, editId: args.editId, by: "person" });
  },
});
