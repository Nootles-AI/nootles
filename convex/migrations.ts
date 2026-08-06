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
