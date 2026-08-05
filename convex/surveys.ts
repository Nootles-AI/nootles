import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { ownerId as currentOwner, requireOwner } from "./auth";

/**
 * Micro-survey responses. Append-only: the PMF question shows once ever (any
 * row for it, answered or dismissed, suppresses it), while the dismiss-reason
 * sampler accumulates a labeled-rejection dataset over time.
 */

const survey = v.union(v.literal("pmf"), v.literal("dismiss_reason"));

/** Has this survey been seen by the caller? Drives show-once logic. */
export const seen = query({
  args: { survey },
  handler: async (ctx, args) => {
    const owner = await currentOwner(ctx);
    if (!owner) return true; // not signed in — never show
    const row = await ctx.db
      .query("surveyResponses")
      .withIndex("by_owner_survey", (q) =>
        q.eq("ownerId", owner).eq("survey", args.survey),
      )
      .first();
    return row !== null;
  },
});

export const answer = mutation({
  args: {
    survey,
    answer: v.optional(v.string()),
    dismissed: v.boolean(),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireOwner(ctx);
    await ctx.db.insert("surveyResponses", {
      ownerId,
      ...args,
      answer: args.answer?.slice(0, 500),
      createdAt: Date.now(),
    });
  },
});
