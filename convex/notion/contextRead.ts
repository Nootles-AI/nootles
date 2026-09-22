"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalAction } from "../_generated/server";
import { withToken } from "./account";
import { flattenBlocks } from "./flatten";
import { pacer } from "./pacing";
import { children } from "./pages";
import { json } from "./rest";

/**
 * A linked Notion page, read into the context graph as text.
 *
 * Scheduled by `context.link` and `context.reindex`, and nobody's request by
 * the time it runs — so the page is read with the token of whoever linked it,
 * in that connection's queue, and a failure is written on the row for the
 * card to show rather than lost in a scheduled function's logs.
 */
export const run = internalAction({
  args: { rowId: v.id("projectNotion") },
  handler: async (ctx, args): Promise<void> => {
    const row: Doc<"projectNotion"> | null = await ctx.runQuery(
      internal.notion.context.row,
      args,
    );
    if (!row) return;
    await ctx.runMutation(internal.notion.context.setIndex, {
      rowId: row._id,
      index: { state: "reading" },
    });
    try {
      const paced = pacer(ctx, row.ownerId);
      // `withToken` records a revoked connection on the account itself.
      const { title, blocks } = await withToken(ctx, row.ownerId, async (token) => {
        const page = await paced(() => json<Page>(token, `/pages/${row.pageId}`));
        return {
          title: page ? titleOf(page) : "",
          blocks: await children(paced, token, row.pageId, 0),
        };
      });
      const { text, headings } = flattenBlocks(blocks);
      if (!text) throw new Error("This page has no text to read.");
      await ctx.runMutation(internal.notion.context.write, {
        rowId: row._id,
        title,
        text,
        headings,
      });
    } catch (error) {
      await ctx.runMutation(internal.notion.context.setIndex, {
        rowId: row._id,
        index: {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  },
});

type Page = { properties?: Record<string, unknown> };

/** The title property, whatever the workspace happens to have called it. */
function titleOf(page: Page): string {
  for (const value of Object.values(page.properties ?? {})) {
    if (typeof value !== "object" || value === null) continue;
    const property = value as { type?: string; title?: { plain_text?: string }[] };
    if (property.type === "title" && Array.isArray(property.title)) {
      return property.title.map((run) => run.plain_text ?? "").join("").trim();
    }
  }
  return "";
}
