import { internalMutation, mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { components, internal } from "../_generated/api";
import {
  ownerId as currentOwner,
  readVisible,
  requireEditable,
  requireOwned,
  requireOwner,
} from "../auth";

/**
 * Telemetry for the ambient suggestion pipeline. Every proposal that reaches
 * the gate is recorded with its outcome, so we can measure precision (how often
 * a shown suggestion is accepted) and tune the heuristics — and, later, use it
 * as training data.
 *
 * Acceptance alone lies: people accept and then rewrite. So an accepted row is
 * scored again at T+10min against the live document (`scoreSurvival`), and the
 * client reports an undo within 30s (`amend`) — together they grade a
 * suggestion accepted → survived → survived-verbatim.
 */

const SURVIVAL_DELAY_MS = 10 * 60 * 1000;
const TEXT_CAP = 2000;

export const log = mutation({
  args: {
    pageId: v.id("pages"),
    kind: v.string(),
    gateOk: v.boolean(),
    shown: v.boolean(),
    outcome: v.union(
      v.literal("gated"),
      v.literal("accepted"),
      v.literal("dismissed"),
      v.literal("superseded"),
      v.literal("failed"),
    ),
    latencyMs: v.number(),
    suggestionText: v.optional(v.string()),
    contextBefore: v.optional(v.string()),
    model: v.optional(v.string()),
    pageMode: v.optional(v.union(v.literal("create"), v.literal("complete"))),
    docLength: v.optional(v.number()),
    decisionMs: v.optional(v.number()),
    dismissReason: v.optional(
      v.union(
        v.literal("typed-through"),
        v.literal("cursor-moved"),
        v.literal("superseded"),
        v.literal("escape"),
        v.literal("timeout"),
      ),
    ),
    blockIds: v.optional(v.array(v.string())),
    acceptedText: v.optional(v.string()),
    candidateCount: v.optional(v.number()),
    chosenIndex: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireEditable(ctx, "pages", args.pageId);
    // The row records whose completion this was, not whose page it landed on.
    const ownerId = await requireOwner(ctx);
    const id = await ctx.db.insert("suggestionLog", {
      ownerId,
      ...args,
      suggestionText: args.suggestionText?.slice(0, TEXT_CAP),
      acceptedText: args.acceptedText?.slice(0, TEXT_CAP),
      contextBefore: args.contextBefore?.slice(0, 500),
      createdAt: Date.now(),
    });
    if (args.outcome === "accepted" && args.acceptedText && args.blockIds?.length) {
      await ctx.scheduler.runAfter(
        SURVIVAL_DELAY_MS,
        internal.ai.suggestions.scoreSurvival,
        { id },
      );
    }
    return id;
  },
});

/** Post-hoc correction from the client — today only "the accept was undone". */
export const amend = mutation({
  args: {
    id: v.id("suggestionLog"),
    undoneWithinMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwned(ctx, "suggestionLog", args.id);
    await ctx.db.patch(args.id, { undoneWithinMs: args.undoneWithinMs });
  },
});

/** Recent suggestion outcomes for a page — the acceptance-rate read-out. */
export const recent = query({
  args: { pageId: v.id("pages"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!(await readVisible(ctx, "pages", args.pageId))) return [];
    const me = await currentOwner(ctx);
    const rows = await ctx.db
      .query("suggestionLog")
      .withIndex("by_page", (q) => q.eq("pageId", args.pageId))
      .order("desc")
      .take(args.limit ?? 100);
    // One person's completion telemetry never tunes another's.
    return rows.filter((r) => r.ownerId === me);
  },
});

/** Has this account ever accepted a suggestion? Gates the PMF survey. */
export const hasAccepted = query({
  args: {},
  handler: async (ctx) => {
    const owner = await currentOwner(ctx);
    if (!owner) return false;
    const row = await ctx.db
      .query("suggestionLog")
      .withIndex("by_owner", (q) => q.eq("ownerId", owner))
      .order("desc")
      .filter((q) => q.eq(q.field("outcome"), "accepted"))
      .first();
    return row !== null;
  },
});

/**
 * Scheduled at accept+10min. Reads the page's current prosemirror-sync
 * snapshot, extracts the text of the blocks the accept produced, and scores
 * how much of the accepted text is still there.
 */
export const scoreSurvival = internalMutation({
  args: { id: v.id("suggestionLog") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || row.outcome !== "accepted" || !row.acceptedText || !row.blockIds?.length)
      return;
    if (row.undoneWithinMs !== undefined) {
      await ctx.db.patch(args.id, { survivalScore: 0, survivalCheckedAt: Date.now() });
      return;
    }
    const page = await ctx.db.get(row.pageId);
    const snap = page
      ? await ctx.runQuery(components.prosemirrorSync.lib.getSnapshot, {
          id: page.docId,
        })
      : { content: null };
    if (snap.content === null) {
      // Page deleted or doc never snapshotted — unknown, not a failure.
      await ctx.db.patch(args.id, { survivalCheckedAt: Date.now() });
      return;
    }

    const { found, text } = extractBlocks(JSON.parse(snap.content), row.blockIds);
    const accepted = normalize(row.acceptedText).slice(0, TEXT_CAP);
    let score: number;
    if (!found) {
      score = 0;
    } else if (accepted.length === 0 || row.kind === "Add diagram") {
      // Canvas blocks are void nodes in the doc — existence is the signal.
      score = 1;
    } else {
      // Substring-tolerant: a prose accept lands inside a block that already
      // had text, so the question is how intact the accepted part still is,
      // not how much of the block it makes up.
      const current = normalize(text).slice(0, 2 * TEXT_CAP);
      score = 1 - fuzzyContainDist(accepted, current) / accepted.length;
    }
    await ctx.db.patch(args.id, {
      survivalScore: Math.max(0, Math.min(1, score)),
      survivalCheckedAt: Date.now(),
    });
  },
});

/** Text of every node under a blockContainer whose id is in `ids`. */
function extractBlocks(doc: unknown, ids: string[]): { found: boolean; text: string } {
  const wanted = new Set(ids);
  const parts: string[] = [];
  let found = false;
  const walk = (node: unknown, inside: boolean) => {
    if (!node || typeof node !== "object") return;
    const n = node as {
      attrs?: { id?: unknown };
      text?: unknown;
      content?: unknown[];
    };
    const hit = inside || (typeof n.attrs?.id === "string" && wanted.has(n.attrs.id));
    if (hit && !inside) found = true;
    if (hit && typeof n.text === "string") parts.push(n.text);
    if (Array.isArray(n.content)) for (const child of n.content) walk(child, hit);
  };
  walk(doc, false);
  return { found, text: parts.join(" ") };
}

function normalize(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Edits needed to find `needle` somewhere inside `hay` — Levenshtein with a
 * free start and end in the haystack. Inputs are pre-capped, so the cost is
 * bounded.
 */
function fuzzyContainDist(needle: string, hay: string): number {
  if (!needle.length) return 0;
  if (!hay.length) return needle.length;
  let prev = new Array<number>(hay.length + 1).fill(0);
  for (let i = 1; i <= needle.length; i++) {
    const next = new Array<number>(hay.length + 1);
    next[0] = i;
    for (let j = 1; j <= hay.length; j++) {
      next[j] = Math.min(
        prev[j] + 1,
        next[j - 1] + 1,
        prev[j - 1] + (needle[i - 1] === hay[j - 1] ? 0 : 1),
      );
    }
    prev = next;
  }
  let min = prev[0];
  for (const d of prev) if (d < min) min = d;
  return min;
}
