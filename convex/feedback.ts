import { mutation, query } from "./_generated/server";
import { feedbackCategory } from "./schema";
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { ownerId as currentOwner, requireOwned, requireOwner } from "./auth";
import { uploadUrl } from "./uploads";
import { next as nextCounter, TICKET } from "./counters";

/**
 * In-app "report issue / suggest feature" submissions. The operator inbox is
 * the Convex dashboard over `by_status` — deliberately no admin surface in v0
 * tenancy, where every account only ever sees its own rows.
 */

const TEXT_CAP = 10_000;
const CONSOLE_CAP = 100_000;

export const generateUploadUrl = mutation({ args: {}, handler: uploadUrl });

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

/** How far the "what your reports changed" list goes back. */
const HISTORY_MAX = 50;

/** How many ids one acknowledgement may carry. */
const ANNOUNCE_MAX = 50;

/**
 * Every one of the caller's own reports that has been fixed, newest first.
 *
 * This is the other half of the promise the founder's note makes — "you'll be
 * notified when yours has been fixed". Owner-scoped like everything else here:
 * you are only ever told about your own.
 *
 * Returns the announced ones too, carrying `notifiedAt` so the caller can tell
 * them apart. Filtering them out here was the obvious shape and the wrong one:
 * the list is reactive, so acknowledging the toast emptied the very query the
 * open dialog was reading from, and the dialog vanished as it was being read.
 * It is also what makes the list worth keeping — a standing record of what your
 * reports actually changed, rather than a notice that evaporates.
 */
export const resolvedForMe = query({
  args: {},
  handler: async (ctx) => {
    const owner = await currentOwner(ctx);
    if (!owner) return [];
    const rows = await ctx.db
      .query("feedback")
      .withIndex("by_owner", (q) => q.eq("ownerId", owner))
      .order("desc")
      .filter((q) => q.eq(q.field("status"), "done"))
      .take(HISTORY_MAX);
    return rows.map((row) => ({
      id: row._id,
      number: row.number,
      kind: row.kind,
      text: row.text,
      category: row.category ?? "general",
      createdAt: row.createdAt,
      notifiedAt: row.notifiedAt ?? null,
    }));
  },
});

/**
 * Remember that the reporter has been told, so it is said once.
 *
 * Called when the toast is acknowledged rather than when it is rendered: a
 * toast that flashed past during a page change was never read, and spending
 * the announcement on it would lose the news silently.
 */
export const markNotified = mutation({
  args: { ids: v.array(v.id("feedback")) },
  handler: async (ctx, args) => {
    const owner = await requireOwner(ctx);
    const now = Date.now();
    for (const id of args.ids.slice(0, ANNOUNCE_MAX)) {
      const row = await ctx.db.get(id);
      // Yours, actually fixed, and not already announced. A stale id is
      // routine — the ticket may have moved on since the toast was drawn.
      if (!row || row.ownerId !== owner) continue;
      if (row.status !== "done" || row.notifiedAt !== undefined) continue;
      await ctx.db.patch(id, { notifiedAt: now });
    }
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
