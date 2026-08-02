import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { requireOwner } from "../auth";

/**
 * Files attached to a chat message.
 *
 * Only the bytes live here. What the model reads is decided when the message is
 * built — an image becomes a file part pointing at this storage, a text file is
 * inlined into the message itself — so nothing about the conversation is stored
 * twice.
 *
 * URLs are never persisted, only derived: `chat/messages.list` re-derives them
 * on every read, and this query is the same derivation for a file that has just
 * been uploaded and is not in a message yet.
 */

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Signed-in only, which is as far as ownership can reach here: a storage id is
 * not a row, so there is nothing to hang an `ownerId` off. Closing it properly
 * means recording who uploaded what — see the note in `chat/messages.ts` on
 * where attachments get their meaning.
 */
export const url = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.storage.getUrl(args.storageId);
  },
});
