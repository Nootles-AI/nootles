import { mutation, query } from "./_generated/server";
import { feedbackCategory } from "./schema";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { ownerId as currentOwner, requireOwned, requireOwner } from "./auth";
import { next as nextCounter, TICKET } from "./counters";

/**
 * In-app "report issue / suggest feature" submissions. The operator inbox is
 * the Convex dashboard over `by_status` — deliberately no admin surface in v0
 * tenancy, where every account only ever sees its own rows.
 */

const TEXT_CAP = 10_000;
const CONSOLE_CAP = 100_000;

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

export const submit = mutation({
  args: {
    kind: v.union(v.literal("issue"), v.literal("wish")),
    text: v.string(),
    screenshotStorageId: v.optional(v.id("_storage")),
    consoleLog: v.optional(v.string()),
    recentOps: v.optional(v.any()),
    pageId: v.optional(v.id("pages")),
    projectId: v.optional(v.id("projects")),
    replayUrl: v.optional(v.string()),
    env: v.object({
      sha: v.optional(v.string()),
      ua: v.string(),
      viewport: v.string(),
    }),
    category: v.optional(feedbackCategory),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireOwner(ctx);
    // Off the verified identity, not an argument: a reporter cannot claim to
    // be someone else, and a reply address is the point of keeping it.
    const email = (await ctx.auth.getUserIdentity())?.email;
    if (args.pageId) await requireOwned(ctx, "pages", args.pageId);
    if (args.projectId) await requireOwned(ctx, "projects", args.projectId);
    return await ctx.db.insert("feedback", {
      number: await nextCounter(ctx, TICKET),
      ownerId,
      ...args,
      ...(email ? { email } : {}),
      text: args.text.slice(0, TEXT_CAP),
      consoleLog: args.consoleLog?.slice(-CONSOLE_CAP),
      status: "new",
      createdAt: Date.now(),
    });
  },
});

/** The caller's own submissions, newest first — the "you'll hear back" list. */
export const listMine = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const owner = await currentOwner(ctx);
    if (!owner) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const result = await ctx.db
      .query("feedback")
      .withIndex("by_owner", (q) => q.eq("ownerId", owner))
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: await Promise.all(
        result.page.map(async (row) => ({
          ...row,
          screenshotUrl: row.screenshotStorageId
            ? await ctx.storage.getUrl(row.screenshotStorageId)
            : null,
        })),
      ),
    };
  },
});
