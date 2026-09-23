import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

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

/** Unplaced drawings from the draw tool; placed ones live in the document. */
crons.interval(
  "purge stale drawings",
  { hours: 6 },
  internal.ai.drawings.purgeStale,
  {},
);

/** The same story for pictures find_images turned up and nobody added. */
crons.interval(
  "purge stale found images",
  { hours: 6 },
  internal.ai.found.purgeStale,
  {},
);

/**
 * Addresses Clerk has not vouched for lately. The gates judge a stamp's age
 * themselves; this keeps the queries, which cannot, from showing doors the
 * gates would refuse for more than the hour between runs.
 */
crons.interval("lapse stale identity stamps", { hours: 1 }, internal.identity.expire, {});

/**
 * The AI substrate's two write-only tables, past the window anything reads
 * them over. Both sweeps take a bounded bite and are frequent enough that a
 * busy account's backlog drains between them.
 */
/**
 * Soft-deleted pages, folders and projects past their restore window — the
 * moment a delete becomes the irreversible one it used to be immediately.
 */
crons.interval("purge the trash", { hours: 24 }, internal.trash.purge, {});

/**
 * The GitHub organisation rule, asked again of each workspace's App for
 * everyone whose GitHub account it knows — what keeps a proof from lapsing
 * (`auth.GITHUB_ORG_PROOF_MS`) without anyone pressing anything.
 */
crons.interval(
  "recheck GitHub organisation proofs",
  { hours: 24 },
  internal.github.orgProof.sweep,
  { cursor: null },
);

crons.interval("prune the op log", { hours: 1 }, internal.ai.opLog.purgeOld, {});
crons.interval(
  "prune old checkpoints",
  { hours: 1 },
  internal.ai.checkpoints.purgeOld,
  {},
);

/**
 * Each Team workspace's AI spend past its seats' allowance, reported to
 * Stripe's meter as the day's usage; and any seat count Stripe was not told.
 * At a fixed hour rather than an interval, so a deploy never moves it.
 */
crons.cron("report Team usage", "0 7 * * *", internal.teamBilling.reportUsage, {});

export default crons;
