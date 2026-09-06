import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Infer } from "convex/values";
import type { feedbackStatus } from "./schema";

/**
 * Ticket rules that more than one caller has to obey — the operator's
 * dashboard and the agent both move tickets around, and a rule enforced in
 * only one of those places is not a rule.
 */

export type TicketStatus = Infer<typeof feedbackStatus>;

/** How many duplicates one ticket may carry. Far past any real number. */
const MAX_DUPLICATES = 200;

/**
 * The ticket a duplicate ultimately points at.
 *
 * `duplicateOf` is kept one hop deep by {@link setDuplicate}, so this is a
 * single lookup rather than a walk — but it answers correctly either way, and
 * the invariant is cheaper to hold than to trust.
 */
export async function canonical(
  ctx: QueryCtx,
  ticket: Doc<"feedback">,
): Promise<Doc<"feedback">> {
  let current = ticket;
  for (let hop = 0; hop < 8 && current.duplicateOf; hop++) {
    const parent = await ctx.db.get(current.duplicateOf);
    if (!parent) break;
    current = parent;
  }
  return current;
}

/**
 * Point `ticket` at `target` as a duplicate, or clear it when target is null.
 *
 * Chains are collapsed here rather than tolerated: a ticket marked duplicate of
 * something that is itself a duplicate stores the far end instead, so the
 * pointer is always one hop and the cascade below never has to recurse.
 * Marking a ticket a duplicate of itself is silently refused.
 */
export async function setDuplicate(
  ctx: MutationCtx,
  ticketId: Id<"feedback">,
  targetId: Id<"feedback"> | null,
  setBy: "agent" | "human",
): Promise<void> {
  if (targetId === null) {
    await ctx.db.patch(ticketId, {
      duplicateOf: undefined,
      duplicateSetBy: undefined,
    });
    return;
  }
  const target = await ctx.db.get(targetId);
  if (!target) throw new Error("No such ticket");

  const root = await canonical(ctx, target);
  if (root._id === ticketId) return;

  await ctx.db.patch(ticketId, {
    duplicateOf: root._id,
    duplicateSetBy: setBy,
  });
}

/**
 * Move a ticket's status, carrying its duplicates with it when it is answered.
 *
 * Reaching `done` cascades: everyone who reported the same thing asked the same
 * question and deserves the same answer, and a duplicate left behind at `new`
 * would come back around the triage queue forever. Nothing else cascades —
 * `in_progress` on one report says nothing about another.
 */
export async function setStatus(
  ctx: MutationCtx,
  ticketId: Id<"feedback">,
  status: TicketStatus,
): Promise<void> {
  await ctx.db.patch(ticketId, { status });
  if (status !== "done") return;

  const duplicates = await ctx.db
    .query("feedback")
    .withIndex("by_duplicateOf", (q) => q.eq("duplicateOf", ticketId))
    .take(MAX_DUPLICATES);
  for (const duplicate of duplicates) {
    if (duplicate.status !== "done") {
      await ctx.db.patch(duplicate._id, { status: "done" });
    }
  }
}
