import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Owned } from "./auth";

/**
 * One-shot: hand the single-user era's content to a real account.
 *
 * Temporary. Delete this file once it has been run — the sequence is deploy,
 * sign in, read `me`, then call `claimLocalUser` with that subject from the
 * dashboard. There is no way to know the subject before the first sign-in, so
 * this cannot be folded into the deploy.
 */

const LOCAL = "local-user";

/**
 * `satisfies Record<Owned, true>` is the point: adding an owned table without
 * listing it here stops compiling, rather than quietly leaving those rows
 * stranded under the old id.
 */
const OWNED = {
  projects: true,
  pages: true,
  canvases: true,
  shapes: true,
  edges: true,
  opLog: true,
  checkpoints: true,
  suggestionLog: true,
  contextSheet: true,
  chatThreads: true,
  chatMessages: true,
  chatTurns: true,
} satisfies Record<Owned, true>;

/** Your Clerk subject — how you learn what to pass to `claimLocalUser`. */
export const me = query({
  args: {},
  handler: async (ctx) => (await ctx.auth.getUserIdentity())?.subject ?? null,
});

/** Idempotent: rows already moved no longer match, so re-running is a no-op. */
export const claimLocalUser = internalMutation({
  args: { subject: v.string() },
  handler: async (ctx, args) => {
    const moved: Record<string, number> = {};
    for (const table of Object.keys(OWNED) as Owned[]) {
      const rows = await ctx.db
        .query(table)
        .filter((q) => q.eq(q.field("ownerId"), LOCAL))
        .collect();
      for (const row of rows) {
        await ctx.db.patch(row._id, { ownerId: args.subject });
      }
      if (rows.length) moved[table] = rows.length;
    }
    return moved;
  },
});
