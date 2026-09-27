"use node";

import { v, type Infer } from "convex/values";
import { parseHTML } from "linkedom";
import * as Y from "yjs";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import { splitUpdate } from "./yshape";
import { NmlYjsDecodeError } from "@/app/lib/nml/yjs";
import { normalizeDiagramsInDoc, type DiagramBandReport } from "@/app/lib/sync/diagramBand";

/**
 * Every stored diagram rewritten as a band, once — the maps, the block prop
 * and the NML copy of each, as `app/lib/sync/diagramBand.ts` describes. Run by
 * hand, a batch at a time, following the cursor until `done`:
 *
 *   npx convex run diagramBand:migrate '{"dryRun":true}'
 *   npx convex run diagramBand:migrate '{"dryRun":true,"cursor":"…"}'
 *
 * The dry run is the same path short of the write, so the preview is what the
 * real run will do; its samples are the before/after root tags to check by
 * eye. Idempotent: a band normalizes to itself, so a second pass writes
 * nothing, and a last dry run reporting nothing changed is the confirmation.
 *
 * Node, because the rewrite parses prop HTML (linkedom stands in for the
 * browser's DOMParser) and rebuilds whole documents, which an isolate has
 * neither the DOM nor the heap for. A document someone writes to between the
 * read and the write is read again, and after a third try is left `busy` for
 * a later pass. Whatever is skipped still reads as a band — every diagram
 * reader normalizes — and is stored as one on its next edit.
 */

const BATCH = 20;
const ATTEMPTS = 3;

const parseHtml = (html: string) => parseHTML(html).document as unknown as Document;

const changedDoc = v.object({
  docId: v.string(),
  diagrams: v.number(),
  maps: v.number(),
  props: v.number(),
  nml: v.number(),
  wide: v.number(),
  /** Reads repeated because somebody wrote in between. */
  moved: v.number(),
  samples: v.array(v.object({ blockId: v.string(), before: v.string(), after: v.string() })),
});

const skippedDoc = v.object({
  docId: v.string(),
  reason: v.union(
    v.literal("too-large"),
    v.literal("no-doc"),
    v.literal("busy"),
    v.literal("nml-undecodable"),
    v.literal("corrupt"),
    v.literal("failed"),
  ),
  /** What went wrong, for a `failed` document. */
  message: v.optional(v.string()),
});

const migrateResult = v.object({
  seen: v.number(),
  changed: v.array(changedDoc),
  skipped: v.array(skippedDoc),
  done: v.boolean(),
  cursor: v.union(v.string(), v.null()),
});

type Outcome =
  | { changed: Infer<typeof changedDoc> }
  | { skipped: Infer<typeof skippedDoc> }
  | null;

export const migrate = internalAction({
  args: {
    cursor: v.optional(v.string()),
    dryRun: v.boolean(),
    numItems: v.optional(v.number()),
  },
  returns: migrateResult,
  // Annotated: the handler calls through `internal`, which includes this module.
  handler: async (ctx, args): Promise<Infer<typeof migrateResult>> => {
    const batch: { docIds: string[]; done: boolean; cursor: string | null } = await ctx.runQuery(internal.migrations.diagramBandPages, {
      cursor: args.cursor ?? null,
      numItems: args.numItems ?? BATCH,
    });
    const changed: Infer<typeof changedDoc>[] = [];
    const skipped: Infer<typeof skippedDoc>[] = [];
    for (const docId of batch.docIds) {
      const outcome = await migrateDoc(ctx, docId, args.dryRun).catch(failed(docId));
      if (outcome && "changed" in outcome) changed.push(outcome.changed);
      else if (outcome) skipped.push(outcome.skipped);
    }
    return { seen: batch.docIds.length, changed, skipped, done: batch.done, cursor: batch.cursor };
  },
});

/**
 * A document whose read or write threw — too big for one, a function limit —
 * is reported rather than thrown: a throw loses the batch's cursor, and every
 * run after would stop at this document.
 */
const failed =
  (docId: string) =>
  (error: unknown): Outcome => ({
    skipped: { docId, reason: "failed", message: error instanceof Error ? error.message : String(error) },
  });

async function migrateDoc(ctx: ActionCtx, docId: string, dryRun: boolean): Promise<Outcome> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const material = await ctx.runQuery(internal.migrations.diagramBandMaterial, { docId });
    if (material.status !== "ok") return { skipped: { docId, reason: material.status } };

    const doc = new Y.Doc();
    try {
      try {
        for (const update of material.updates) Y.applyUpdate(doc, new Uint8Array(update));
      } catch {
        return { skipped: { docId, reason: "corrupt" } };
      }
      // Heard only from here on: the load above is the stored state, not a change.
      const heard: { update: Uint8Array | null } = { update: null };
      doc.on("update", (update: Uint8Array) => {
        heard.update = update;
      });
      let report: DiagramBandReport;
      try {
        report = normalizeDiagramsInDoc(doc, parseHtml);
      } catch (error) {
        if (error instanceof NmlYjsDecodeError) return { skipped: { docId, reason: "nml-undecodable" } };
        // Nothing is written until the rewrite has finished.
        return failed(docId)(error);
      }
      // The update event rather than a state-vector diff, which would carry
      // the document's whole delete set along with the rewrite.
      if (!heard.update) return null;
      const entry = { docId, ...report, moved: attempt };
      if (dryRun) return { changed: entry };
      const written = await ctx.runMutation(internal.migrations.diagramBandWrite, {
        docId,
        baseSeq: material.seq,
        chunks: splitUpdate(heard.update),
      });
      if (written.status === "written") return { changed: entry };
    } finally {
      doc.destroy();
    }
  }
  return { skipped: { docId, reason: "busy" } };
}
