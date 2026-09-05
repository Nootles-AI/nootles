"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { requireOwner } from "../auth";

/**
 * Move a Notion-hosted file into Convex storage, and answer with a URL that
 * will still work tomorrow.
 *
 * Notion signs its file URLs and they expire in about an hour. An import that
 * stored them would look perfect and be broken by lunch — every picture a dead
 * link, with nothing left to re-fetch from once the hour is up. So every file
 * is copied at import time; this is most of an import's wall clock and all of
 * its storage cost, and it is not optional.
 *
 * The URL is already signed, so no token is sent: this fetch carries no
 * credential and the connection's access token never leaves the account module.
 */
export const rehost = action({
  args: { url: v.string(), contentType: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ url: string; storageId: string } | null> => {
    await requireOwner(ctx);

    let response: Response;
    try {
      response = await fetch(args.url);
    } catch {
      // A file that will not come down is not worth failing a whole page over.
      // The block keeps its caption and loses its picture, and the import
      // report says which ones — see `importRun.ts`.
      return null;
    }
    if (!response.ok) return null;

    const blob = await response.blob();
    const typed =
      args.contentType && blob.type === ""
        ? new Blob([blob], { type: args.contentType })
        : blob;
    const storageId = await ctx.storage.store(typed);
    const url = await ctx.storage.getUrl(storageId);
    return url ? { url, storageId } : null;
  },
});
