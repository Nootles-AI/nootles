import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * Often enough that a PR you just opened is linked before you've stopped
 * thinking about it, rare enough to stay far inside GitHub's rate limit.
 */
crons.interval(
  "link PRs to tickets",
  { minutes: 15 },
  internal.prs.poll,
  {},
);

/**
 * Ghost presences — tabs that closed without a goodbye. Clients already
 * ignore stale rows on their own clock; this just keeps the table from
 * accumulating them.
 */
crons.interval(
  "sweep stale presence",
  { minutes: 1 },
  internal.presence.sweep,
  {},
);

export default crons;
