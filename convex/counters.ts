import type { MutationCtx } from "./_generated/server";

/**
 * Monotonic counters. Not Convex functions — a helper called inside whatever
 * mutation needs the next value, so the allocation and the row that uses it
 * land in one transaction. Two submits racing for the same number is an OCC
 * conflict, which Convex retries; neither can observe the other's number.
 */

/** Feedback tickets, named `NT-{value}`. */
export const TICKET = "ticket";

export async function next(ctx: MutationCtx, name: string): Promise<number> {
  const row = await ctx.db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  if (!row) {
    await ctx.db.insert("counters", { name, value: 1 });
    return 1;
  }
  const value = row.value + 1;
  await ctx.db.patch(row._id, { value });
  return value;
}

/**
 * Move the counter forward to at least `value`, for the backfill: numbering
 * existing rows must not hand the same number to the next submit.
 */
export async function raiseTo(
  ctx: MutationCtx,
  name: string,
  value: number,
): Promise<void> {
  const row = await ctx.db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  if (!row) {
    await ctx.db.insert("counters", { name, value });
  } else if (row.value < value) {
    await ctx.db.patch(row._id, { value });
  }
}
