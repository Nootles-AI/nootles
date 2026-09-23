import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { canReadCode, readVisible } from "../auth";
import { searchTextOf } from "../context/shape";
import { BATCH, edge, node } from "./graphShape";

/**
 * The GitHub connector's writes into the context graph.
 *
 * The indexer (`indexer.ts`) runs in Node and has no database, so it hands
 * its result here in batches: a repository's graph is replaced whole on every
 * index, which is simple and exact — code files are updated by content, and
 * git already holds their history (docs/context-graph.md).
 */

/**
 * An indexed file, if the caller may read the code of the project it is
 * context for (`canReadCode`), with the repository row whose linker's token
 * reads it.
 */
export const fileForReader = internalQuery({
  args: { projectId: v.id("projects"), nodeId: v.id("contextNodes") },
  handler: async (ctx, args) => {
    const project = await readVisible(ctx, "projects", args.projectId);
    if (!project || !(await canReadCode(ctx, project))) return null;
    const node = await ctx.db.get(args.nodeId);
    if (!node || node.projectId !== args.projectId || node.kind !== "file" || !node.repoId) {
      return null;
    }
    const repo = await ctx.db.get(node.repoId);
    return repo ? { path: node.title, url: node.url ?? null, repo } : null;
  },
});

export const repoById = internalQuery({
  args: { repoId: v.id("projectRepos") },
  handler: async (ctx, args) => await ctx.db.get(args.repoId),
});

export const setIndex = internalMutation({
  args: {
    repoId: v.id("projectRepos"),
    index: v.object({
      state: v.union(
        v.literal("queued"),
        v.literal("indexing"),
        v.literal("naming"),
        v.literal("ready"),
        v.literal("failed"),
      ),
      error: v.optional(v.string()),
      sha: v.optional(v.string()),
      at: v.optional(v.number()),
      files: v.optional(v.number()),
      concerns: v.optional(v.number()),
      areas: v.optional(v.number()),
      references: v.optional(v.number()),
      claimedAt: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repoId);
    if (!repo) return;
    // A failure keeps the last good graph's facts, so the row still says what
    // is there while it says why the refresh did not land.
    const index =
      args.index.state === "failed" ? { ...repo.index, ...args.index } : args.index;
    await ctx.db.patch(args.repoId, { index });
  },
});

/** Deletes a batch of the repository's old graph; answers whether any is left. */
export const clear = internalMutation({
  args: { repoId: v.id("projectRepos") },
  returns: v.boolean(),
  handler: async (ctx, args) => await clearBatch(ctx, args.repoId),
});

/**
 * Writes one batch of nodes and their search text, answering each node's id by
 * its external id so the indexer can lay edges between them.
 */
export const writeNodes = internalMutation({
  args: { repoId: v.id("projectRepos"), nodes: v.array(node) },
  returns: v.array(v.object({ externalId: v.string(), id: v.id("contextNodes") })),
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repoId);
    if (!repo) return [];
    const out: { externalId: string; id: Id<"contextNodes"> }[] = [];
    const now = Date.now();
    const known = new Map<string, Id<"contextNodes">>();
    const parentOf = async (externalId: string) => {
      if (!known.has(externalId)) {
        const row = await ctx.db
          .query("contextNodes")
          .withIndex("by_project_and_externalId", (q) =>
            q.eq("projectId", repo.projectId).eq("externalId", externalId),
          )
          .unique();
        if (row) known.set(externalId, row._id);
      }
      return known.get(externalId);
    };
    for (const n of args.nodes) {
      const parentId = n.parent ? await parentOf(n.parent) : undefined;
      const id = await ctx.db.insert("contextNodes", {
        projectId: repo.projectId,
        source: "github",
        repoId: repo._id,
        ...(parentId ? { parentId } : {}),
        tier: n.tier,
        kind: n.kind,
        externalId: n.externalId,
        title: n.title,
        brief: n.brief,
        ...(n.url ? { url: n.url } : {}),
        ...(n.styling ? { styling: true } : {}),
        // Code has no owner worth claiming (blame is not ownership); the repo
        // itself belongs to whoever linked it.
        owner: n.kind === "repo" ? { memberId: repo.ownerId } : {},
      });
      await ctx.db.insert("contextNodeText", {
        nodeId: id,
        projectId: repo.projectId,
        summary: n.summary,
        summaryOrigin: "template",
        terms: n.terms,
        searchText: searchTextOf(n.title, n.terms),
        contentHash: "",
        syncedAt: now,
      });
      known.set(n.externalId, id);
      out.push({ externalId: n.externalId, id });
    }
    return out;
  },
});

export const writeEdges = internalMutation({
  args: {
    repoId: v.id("projectRepos"),
    edges: v.array(edge),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repoId);
    if (!repo) return;
    const now = Date.now();
    for (const e of args.edges) {
      await ctx.db.insert("contextEdges", {
        projectId: repo.projectId,
        repoId: repo._id,
        from: e.from,
        to: e.to,
        family: e.family,
        type: e.type,
        origin: e.family === "about" ? "inferred" : "parsed",
        ...(e.weight !== undefined ? { weight: e.weight } : {}),
        createdAt: now,
      });
    }
  },
});

/**
 * A repository unlinked: its graph goes with it, a batch at a time so a large
 * one never meets a transaction's limits.
 */
export const forget = internalMutation({
  args: { repoId: v.id("projectRepos") },
  handler: async (ctx, args) => {
    if (await clearBatch(ctx, args.repoId)) {
      await ctx.scheduler.runAfter(0, internal.github.graphStore.forget, args);
    }
  },
});

async function clearBatch(ctx: MutationCtx, repoId: Id<"projectRepos">): Promise<boolean> {
  const edges = await ctx.db
    .query("contextEdges")
    .withIndex("by_repoId", (q) => q.eq("repoId", repoId))
    .take(BATCH * 2);
  for (const e of edges) await ctx.db.delete(e._id);
  const nodes = await ctx.db
    .query("contextNodes")
    .withIndex("by_repoId", (q) => q.eq("repoId", repoId))
    .take(BATCH);
  for (const n of nodes) {
    const text = await ctx.db
      .query("contextNodeText")
      .withIndex("by_nodeId", (q) => q.eq("nodeId", n._id))
      .unique();
    if (text) await ctx.db.delete(text._id);
    await ctx.db.delete(n._id);
  }
  return edges.length === BATCH * 2 || nodes.length === BATCH;
}
