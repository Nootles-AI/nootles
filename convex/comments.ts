import { ConvexError, v } from "convex/values";
import * as Y from "yjs";
import { mutation, query } from "./_generated/server";
import { readVisible, requireCommentable } from "./auth";
import { commentsEnabled } from "./entitlements";
import { registerYDoc } from "./ydoc";
import { emptyCommentsDocument } from "@/app/lib/comments/types";
import { createNmlYDoc } from "@/app/lib/nml/yjs";

/**
 * A page's comments document: the second Yjs document every page may have,
 * holding its threads as NML (`kind: "comments"`). It syncs through the same
 * `ydoc.ts` log as the page — gated by channel, so a commenter can write here
 * and nowhere else — and Convex rows never hold a comment's words.
 *
 * This module only brings the document into being and says where it is;
 * everything written to it afterwards is an ordinary Yjs append.
 */

const COMMENTS_OFF = () =>
  new ConvexError("Comments are turned off for this project.");

/**
 * The encoded birth state of a comments document: its NML root with no
 * threads, written server-side as update #1. A root is a set of top-level
 * keys, and two clients each writing their own would leave one replica's
 * threads under a root the merge discarded — so exactly one writer makes it,
 * here, inside the transaction that mints the id.
 */
function birthUpdate(docId: string): ArrayBuffer {
  const doc = createNmlYDoc(emptyCommentsDocument(docId));
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength) as ArrayBuffer;
}

/**
 * The page's comments docId, minted on first use. Idempotent: the page row is
 * read and written in one transaction, so two first comments racing conflict
 * and the retry finds the id the winner minted.
 *
 * Open to whoever may comment — commenter, editor, owner — and refused, as
 * "Not found", to viewers, strangers, an operator standing in, and a trashed
 * page or project.
 */
export const ensureDoc = mutation({
  args: { pageId: v.id("pages") },
  returns: v.string(),
  handler: async (ctx, args) => {
    const { page, project } = await requireCommentable(ctx, args.pageId);
    if (!(await commentsEnabled(ctx, project))) throw COMMENTS_OFF();
    if (page.commentsDocId) return page.commentsDocId;
    const docId = crypto.randomUUID();
    await registerYDoc(ctx, docId, birthUpdate(docId));
    await ctx.db.patch(page._id, { commentsDocId: docId });
    return docId;
  },
});

/**
 * Where a page's comments are, for a signed-in reader with any role — null
 * when nobody has commented yet, the page is not theirs to see, or comments
 * are off. A signed-out link visitor holds no role and so learns nothing,
 * matching the comments channel's own refusal of them.
 */
export const docFor = query({
  args: { pageId: v.id("pages") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const page = await readVisible(ctx, "pages", args.pageId);
    if (!page?.commentsDocId) return null;
    const project = await ctx.db.get(page.projectId);
    if (!project || !(await commentsEnabled(ctx, project))) return null;
    return page.commentsDocId;
  },
});
