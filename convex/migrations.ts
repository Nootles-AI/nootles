import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import { raiseTo, TICKET } from "./counters";

/**
 * One-off backfills, run by hand with `npx convex run`. Internal: none of this
 * belongs to the app's API, and a migration reachable from the internet is a
 * migration someone can re-run.
 */

/** Rows per transaction. Small enough to stay well inside the write limit. */
const BATCH = 100;

/** How far ahead the dry run looks. Reading is cheap; guessing is not. */
const PREVIEW_CAP = 500;

/**
 * What {@link numberTickets} would do, without doing it. Convex has no dry-run
 * mode for mutations, so the preview is its own read-only function — the same
 * selection and the same ordering, reporting the numbers it would hand out.
 */
export const numberTicketsPreview = internalQuery({
  args: {},
  handler: async (ctx) => {
    const unnumbered = await ctx.db
      .query("feedback")
      .filter((q) => q.eq(q.field("number"), undefined))
      .take(PREVIEW_CAP);

    const counter = await ctx.db
      .query("counters")
      .withIndex("by_name", (q) => q.eq("name", TICKET))
      .unique();
    const start = counter?.value ?? 0;

    return {
      counterAt: start,
      toNumber: unnumbered.length,
      capped: unnumbered.length === PREVIEW_CAP,
      /** Oldest first — the order the numbers will actually be handed out in. */
      first: unnumbered.slice(0, 5).map((row, i) => ({
        willBe: `NT-${start + i + 1}`,
        createdAt: new Date(row.createdAt).toISOString(),
        kind: row.kind,
        text: row.text.slice(0, 60),
      })),
      last: unnumbered.slice(-5).map((row, i) => ({
        willBe: `NT-${start + unnumbered.length - Math.min(5, unnumbered.length) + i + 1}`,
        createdAt: new Date(row.createdAt).toISOString(),
        kind: row.kind,
        text: row.text.slice(0, 60),
      })),
    };
  },
});

/**
 * Gives every pre-numbering ticket its `NT-{n}`, oldest first, so the numbers
 * ascend with age the way new ones will.
 *
 * Idempotent: it selects only unnumbered rows, so a second run finds nothing.
 * The counter is raised to the highest number handed out, which is what stops
 * the next submit reusing one. Later batches re-scan the rows already numbered
 * — the cost of having no index for "field is absent", and not worth an index
 * that exists to be dropped.
 */
export const numberTickets = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ numbered: number; done: boolean }> => {
    const rows = await ctx.db
      .query("feedback")
      .filter((q) => q.eq(q.field("number"), undefined))
      .take(BATCH);
    if (rows.length === 0) return { numbered: 0, done: true };

    const counter = await ctx.db
      .query("counters")
      .withIndex("by_name", (q) => q.eq("name", TICKET))
      .unique();

    let n = counter?.value ?? 0;
    for (const row of rows) {
      n += 1;
      await ctx.db.patch(row._id, { number: n });
    }
    await raiseTo(ctx, TICKET, n);

    const done = rows.length < BATCH;
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.migrations.numberTickets, {});
    }
    return { numbered: rows.length, done };
  },
});

/**
 * Moves every sidebar level onto its unified order line: folders renumbered
 * 0..k-1 by their old order, that level's pages k..n-1 after them — exactly
 * the sequence the old "folders above pages" sort displayed, so nobody's tree
 * visibly moves. Idempotent: a second run recomputes the same numbers and
 * patches nothing.
 *
 * Run once when the interleaved-order code ships (either side of the deploy is
 * fine — the old sort reads these numbers identically). Until it has run, a
 * level whose folder and page orders overlap may briefly render interleaved.
 */
export const interleaveSidebarRows = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ projects: number; patched: number; done: boolean }> => {
    const batch = await ctx.db
      .query("projects")
      .paginate({ numItems: 25, cursor: args.cursor ?? null });

    let patched = 0;
    for (const project of batch.page) {
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();
      const pages = await ctx.db
        .query("pages")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();

      // Per level, in the by_project index's (order, creation) sequence the
      // collects already carry. Levels keyed by the raw parent link: a broken
      // link groups its orphans together, which preserves their relative order
      // wherever the tree chooses to surface them.
      const levels = new Set<string>([
        ...folders.map((f) => String(f.parentId ?? "")),
        ...pages.map((p) => String(p.folderId ?? "")),
      ]);
      for (const level of levels) {
        let n = 0;
        for (const f of folders.filter(
          (f) => String(f.parentId ?? "") === level,
        )) {
          if (f.order !== n) {
            await ctx.db.patch(f._id, { order: n });
            patched++;
          }
          n++;
        }
        for (const p of pages.filter(
          (p) => String(p.folderId ?? "") === level,
        )) {
          if (p.order !== n) {
            await ctx.db.patch(p._id, { order: n });
            patched++;
          }
          n++;
        }
      }
    }

    if (!batch.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.interleaveSidebarRows, {
        cursor: batch.continueCursor,
      });
    }
    return { projects: batch.page.length, patched, done: batch.isDone };
  },
});

/**
 * Marks every conversation that already exists as paid for.
 *
 * The chat meter charges a thread the first time it reaches the model, and
 * `billedAt` is what records that it has been charged. Threads written before
 * the paywall existed carry no stamp, so without this the first message
 * somebody sends in a conversation they have been having for weeks would spend
 * one of their ten free slots — charging them, retroactively, for something
 * that was free when they did it.
 *
 * Stamped with the thread's own `createdAt` rather than now, so the record says
 * when the conversation started rather than when this ran.
 *
 * Run ONCE, immediately before or after the paywall deploys; either side is
 * fine, since a thread stamped here and a thread stamped by `beginChat` are
 * indistinguishable afterwards. Idempotent — a second run finds nothing left
 * unstamped and patches nothing.
 */
export const grandfatherChatThreads = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ seen: number; stamped: number; done: boolean; cursor: string | null }> => {
    const batch = await ctx.db
      .query("chatThreads")
      .paginate({ numItems: BATCH, cursor: args.cursor ?? null });

    let stamped = 0;
    for (const thread of batch.page) {
      if (thread.billedAt !== undefined) continue;
      await ctx.db.patch(thread._id, { billedAt: thread.createdAt });
      stamped += 1;
    }

    return {
      seen: batch.page.length,
      stamped,
      done: batch.isDone,
      cursor: batch.isDone ? null : batch.continueCursor,
    };
  },
});

/**
 * Clears the ground the PR poller stood on, so the schema can stop describing
 * it.
 *
 * This one is NOT optional and NOT run at leisure: Convex validates a pushed
 * schema against the documents already in the database, so the deploy that
 * drops `ticketPrs` and the `pr_filed` literal is refused outright while a
 * single row of either still exists. Deploy this function first, run it, then
 * deploy the removal.
 *
 * `pr_filed` becomes `in_progress` rather than `done`. The two facts a PR
 * carried are not the same fact — opened is work begun, merged is work
 * finished — and only merging ever moved a ticket to `done`. Anything sitting
 * at `pr_filed` therefore has an unmerged PR against it, which is exactly what
 * `in_progress` has always meant.
 *
 * Idempotent, and safe to re-run: the second pass finds no `pr_filed` rows and
 * no `ticketPrs`, and reports zeroes.
 */
export const retirePrLinks = internalMutation({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ moved: number; unlinked: number; done: boolean }> => {
    const stalled = await ctx.db
      .query("feedback")
      .withIndex("by_status", (q) => q.eq("status", "pr_filed"))
      .take(BATCH);
    for (const ticket of stalled) {
      await ctx.db.patch(ticket._id, { status: "in_progress" });
    }

    // Whole rows, not a field: the table itself is going. Taken in the same
    // bounded bite so one transaction cannot outgrow the write limit.
    const links = await ctx.db.query("ticketPrs").take(BATCH);
    for (const link of links) {
      await ctx.db.delete(link._id);
    }

    const done = stalled.length < BATCH && links.length < BATCH;
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.migrations.retirePrLinks, {});
    }
    return { moved: stalled.length, unlinked: links.length, done };
  },
});
