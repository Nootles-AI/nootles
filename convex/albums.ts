import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireOwner } from "./auth";

/**
 * Where an album's photos and videos are put.
 *
 * An upload door and the one lookup that follows it, because an album keeps the
 * storage URL rather than the storage id. `storage.getUrl` returns a permanent
 * bearer URL — it stops working only when the file is deleted — so the id is
 * exchanged for a URL once, as the file lands, and that URL is what goes into
 * the block's markup. It buys two things a stored id cannot: a tile starts
 * loading on the first paint instead of after a round trip, and a shared page,
 * which has no signed-in identity to derive a URL with, can show its pictures at
 * all. The URL is exactly as shareable as the page holding it.
 *
 * Separate from `chat/attachments.ts` deliberately: that door decides what a
 * model may read and holds ids because a thread is re-read months later; this
 * one decides what a document may hold. They are the same four lines today and
 * will not stay the same shape.
 */

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Signed-in only, which is as far as ownership can reach: a storage id is not a
 * row, so there is nothing to hang an `ownerId` off. It is read exactly once per
 * file, by the account that just uploaded it.
 */
export const url = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.storage.getUrl(args.storageId);
  },
});
