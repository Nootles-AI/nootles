import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { PREVIEW_MAX_CHARS } from "./previewShape";
import { checkRead, mayWrite } from "./prosemirror";

/**
 * Stored page previews — see `schema.pagePreviews` for why they exist and who
 * writes them. Access is the document's own: whoever may read the page may
 * read its preview, and only a writer may leave one.
 */

async function previewRow(ctx: { db: QueryCtx["db"] }, docId: string) {
  return await ctx.db
    .query("pagePreviews")
    .withIndex("by_doc", (q) => q.eq("docId", docId))
    .unique();
}

/** Null means none is stored, and the caller reads the document instead. */
export const get = query({
  args: { docId: v.string() },
  returns: v.union(v.null(), v.object({ blocks: v.string(), seq: v.number() })),
  handler: async (ctx, args) => {
    await checkRead(ctx, args.docId);
    const row = await previewRow(ctx, args.docId);
    return row ? { blocks: row.blocks, seq: row.seq } : null;
  },
});

/**
 * Leaves a preview behind. Quietly does nothing for a caller who may not
 * write the page — a viewer's card offers one too, and that is routine — and
 * for a preview read at an older `seq` than the one already held.
 *
 * Null `blocks` is a document whose top grew too heavy to keep
 * (`previewShape.encodePreview`): the row goes, rather than staying behind as
 * a picture of a page that no longer looks like that.
 */
export const set = mutation({
  args: {
    docId: v.string(),
    blocks: v.union(v.string(), v.null()),
    seq: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { docId, blocks, seq } = args;
    if (blocks !== null && blocks.length > PREVIEW_MAX_CHARS) {
      throw new Error("Preview too large");
    }
    if (!(await mayWrite(ctx, docId))) return null;
    const row = await previewRow(ctx, docId);
    if (row && seq < row.seq) return null;
    if (blocks === null) {
      if (row) await ctx.db.delete(row._id);
    } else if (!row) {
      await ctx.db.insert("pagePreviews", { docId, blocks, seq, updatedAt: Date.now() });
    } else if (blocks !== row.blocks) {
      await ctx.db.patch(row._id, { blocks, seq, updatedAt: Date.now() });
    }
    return null;
  },
});

/** A copied document's preview goes with it — the copy is the same picture. */
export async function copyPreview(ctx: MutationCtx, from: string, to: string) {
  const row = await previewRow(ctx, from);
  if (!row) return;
  await ctx.db.insert("pagePreviews", {
    docId: to,
    blocks: row.blocks,
    seq: row.seq,
    updatedAt: Date.now(),
  });
}

export async function deletePreview(ctx: MutationCtx, docId: string) {
  const row = await previewRow(ctx, docId);
  if (row) await ctx.db.delete(row._id);
}
