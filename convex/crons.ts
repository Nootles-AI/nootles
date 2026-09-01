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
 * The AI substrate's two write-only tables, past the window anything reads
 * them over. Both sweeps take a bounded bite and are frequent enough that a
 * busy account's backlog drains between them.
 */
/**
 * Soft-deleted pages, folders and projects past their restore window — the
 * moment a delete becomes the irreversible one it used to be immediately.
 */
crons.interval("purge the trash", { hours: 24 }, internal.trash.purge, {});

crons.interval("prune the op log", { hours: 1 }, internal.ai.opLog.purgeOld, {});
crons.interval(
  "prune old checkpoints",
  { hours: 1 },
  internal.ai.checkpoints.purgeOld,
  {},
);

export default crons;
