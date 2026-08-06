import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import { setStatus } from "./tickets";

/**
 * Linking pull requests to the tickets they fix.
 *
 * A PR names its ticket in its title — `NT-42_what_was_fixed` — and this poll
 * is what notices. Deliberately not part of the nightly agent: matching a
 * prefix is a regex, not a judgment, so it runs on a cron every few minutes,
 * costs nothing, and lets everything downstream assume the links already
 * exist. It also means a PR *you* wrote by hand links itself.
 *
 * No webhook and no GitHub App — a token with read access is the whole setup.
 */

/** Repos whose PRs may name a ticket. */
const REPOS = ["ahosseini06/nootles", "ahosseini06/nootles-ops"];

/**
 * The convention, anchored at the start of the title. Title only: a ticket
 * mentioned in a PR body ("similar to NT-17") is prose, not a claim to fix it.
 * The trailing `_`-or-end is what stops `NT-4` matching `NT-42`.
 */
const TITLE = /^NT-(\d+)(?:_|$)/i;

/** Enough to cover every PR either repo will have for a long time. */
const PER_PAGE = 100;

type Seen = {
  repo: string;
  prNumber: number;
  ticketNumber: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  mergedAt?: number;
};

export const poll = internalAction({
  args: {},
  handler: async (ctx): Promise<{ seen: number; linked: number; unknown: number }> => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      // Not an error: a deployment without the token simply doesn't link PRs.
      console.warn("prs.poll: GITHUB_TOKEN unset, skipping");
      return { seen: 0, linked: 0, unknown: 0 };
    }

    const seen: Seen[] = [];
    for (const repo of REPOS) {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/pulls?state=all&per_page=${PER_PAGE}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (!res.ok) {
        // One unreachable repo shouldn't cost the other its links.
        console.error(`prs.poll: ${repo} responded ${res.status}`);
        continue;
      }
      const pulls = (await res.json()) as {
        number: number;
        title: string;
        html_url: string;
        state: string;
        merged_at: string | null;
      }[];
      for (const pull of pulls) {
        const match = TITLE.exec(pull.title);
        if (!match) continue;
        seen.push({
          repo,
          prNumber: pull.number,
          ticketNumber: Number(match[1]),
          title: pull.title,
          url: pull.html_url,
          // GitHub reports a merged PR as "closed"; `merged_at` is the tell.
          state: pull.merged_at
            ? "merged"
            : pull.state === "open"
              ? "open"
              : "closed",
          ...(pull.merged_at
            ? { mergedAt: Date.parse(pull.merged_at) }
            : {}),
        });
      }
    }

    // One mutation for the whole batch: every lookup and write lands in a
    // single transaction, so a run can't half-apply.
    return await ctx.runMutation(internal.prs.commit, { seen });
  },
});

export const commit = internalMutation({
  args: {
    seen: v.array(
      v.object({
        repo: v.string(),
        prNumber: v.number(),
        ticketNumber: v.number(),
        title: v.string(),
        url: v.string(),
        state: v.union(
          v.literal("open"),
          v.literal("closed"),
          v.literal("merged"),
        ),
        mergedAt: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    let linked = 0;
    let unknown = 0;

    for (const pr of args.seen) {
      const ticket = await ctx.db
        .query("feedback")
        .withIndex("by_number", (q) => q.eq("number", pr.ticketNumber))
        .unique();
      if (!ticket) {
        // A typo'd number is the author's problem, not a reason to throw.
        unknown += 1;
        continue;
      }

      const existing = await ctx.db
        .query("ticketPrs")
        .withIndex("by_repo_and_prNumber", (q) =>
          q.eq("repo", pr.repo).eq("prNumber", pr.prNumber),
        )
        .unique();

      if (existing) {
        await ctx.db.patch(existing._id, {
          ticketId: ticket._id,
          title: pr.title,
          url: pr.url,
          state: pr.state,
          ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("ticketPrs", {
          ticketId: ticket._id,
          repo: pr.repo,
          prNumber: pr.prNumber,
          title: pr.title,
          url: pr.url,
          state: pr.state,
          ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
          // The agent stamps its own PRs when it files them; anything the
          // poller discovers first is assumed to be a person's.
          agentFiled: false,
          firstSeenAt: now,
          updatedAt: now,
        });
      }
      linked += 1;
      await advance(ctx, ticket, pr.state);
    }

    return { seen: args.seen.length, linked, unknown };
  },
});

/**
 * What a PR's state means for the ticket it names.
 *
 * Merging is an explicit human act, so it's safe to key `done` on — and `done`
 * carries the ticket's duplicates with it. A PR closed without merging says
 * nothing: that was a decision made for reasons the ticket doesn't know, so the
 * status is left where it is.
 */
async function advance(
  ctx: MutationCtx,
  ticket: Doc<"feedback">,
  state: "open" | "closed" | "merged",
) {
  if (state === "merged") {
    if (ticket.status !== "done") await setStatus(ctx, ticket._id, "done");
    return;
  }
  const settled = ticket.status === "done" || ticket.status === "declined";
  if (state === "open" && !settled && ticket.status !== "pr_filed") {
    await setStatus(ctx, ticket._id, "pr_filed");
  }
}
