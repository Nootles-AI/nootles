import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { canReadCode, requireManageable } from "../auth";
import { searchTextOf } from "../context/shape";

/**
 * Stage 2 of the GitHub pipeline: a model names what clustering found.
 *
 * The call itself is made in Next (`app/api/context/name`), where every other
 * model call lives, with its keys and its ledger. These are its two ends: what
 * it is shown, and where its answer lands. Directory names stand in until
 * then, and stay if naming fails — the graph is usable either way.
 */

/** A run holds its claim this long; past it, a fresh tab may try again. */
const CLAIM_MS = 3 * 60_000;
/** What a model needs to name a concern: a dozen paths and what they export. */
const FILES_SHOWN = 12;

/**
 * Takes the repository for one naming run, or answers null: not yet indexed,
 * already named, or another tab is naming it now. The claim is the guard
 * against two open tabs each paying for the same answer.
 */
export const claim = mutation({
  args: { repoId: v.id("projectRepos") },
  handler: async (ctx, args) => {
    const repo = await nameable(ctx, args.repoId);
    const index = repo.index;
    if (index?.state !== "naming") return null;
    const now = Date.now();
    if (index.claimedAt && now - index.claimedAt < CLAIM_MS) return null;
    await ctx.db.patch(repo._id, { index: { ...index, claimedAt: now } });
    return await outline(ctx, repo);
  },
});

/**
 * The model's names, written over the directory-derived ones. The styling
 * concern keeps its name — it is an invariant other lanes look for — and takes
 * only the brief.
 */
export const apply = mutation({
  args: {
    repoId: v.id("projectRepos"),
    names: v.array(
      v.object({ nodeId: v.string(), title: v.string(), brief: v.string() }),
    ),
  },
  handler: async (ctx, args) => {
    const repo = await nameable(ctx, args.repoId);
    for (const n of args.names) {
      const id = ctx.db.normalizeId("contextNodes", n.nodeId);
      const node = id ? await ctx.db.get(id) : null;
      if (!node || node.repoId !== repo._id) continue;
      if (node.kind !== "area" && node.kind !== "concern") continue;
      const title = node.styling ? node.title : clip(n.title, 60) || node.title;
      await ctx.db.patch(node._id, { title, brief: clip(n.brief, 200) || node.brief });
      const text = await ctx.db
        .query("contextNodeText")
        .withIndex("by_nodeId", (q) => q.eq("nodeId", node._id))
        .unique();
      if (text) {
        await ctx.db.patch(text._id, {
          searchText: searchTextOf(title, text.terms),
          summaryOrigin: "model",
        });
      }
    }
    await settle(ctx, repo);
  },
});

/** Naming failed or is not configured: the directory names stand. */
export const skip = mutation({
  args: { repoId: v.id("projectRepos") },
  handler: async (ctx, args) => {
    const repo = await nameable(ctx, args.repoId);
    if (repo.index?.state === "naming") await settle(ctx, repo);
  },
});

/**
 * The repository, for whoever manages its project — the run is shown the
 * code's outline, so reading the code has to be theirs too.
 */
async function nameable(ctx: MutationCtx, repoId: Id<"projectRepos">) {
  const repo = await requireManageable(ctx, "projectRepos", repoId);
  const project = await ctx.db.get(repo.projectId);
  if (!project || !(await canReadCode(ctx, project))) throw new Error("Not found");
  return repo;
}

async function settle(ctx: MutationCtx, repo: Doc<"projectRepos">) {
  if (!repo.index) return;
  await ctx.db.patch(repo._id, {
    index: { ...repo.index, state: "ready", claimedAt: undefined },
  });
}

type Outline = {
  fullName: string;
  description: string;
  areas: {
    nodeId: string;
    name: string;
    concerns: {
      nodeId: string;
      name: string;
      styling: boolean;
      files: { path: string; brief: string }[];
      more: number;
    }[];
  }[];
};

/** The repository's map as the naming prompt reads it. */
async function outline(ctx: QueryCtx, repo: Doc<"projectRepos">): Promise<Outline> {
  const children = (id: Id<"contextNodes">, limit: number) =>
    ctx.db
      .query("contextNodes")
      .withIndex("by_parentId", (q) => q.eq("parentId", id))
      .take(limit);
  const root = await ctx.db
    .query("contextNodes")
    .withIndex("by_project_and_externalId", (q) =>
      q.eq("projectId", repo.projectId).eq("externalId", repo.fullName),
    )
    .unique();
  const areas = root ? await children(root._id, 200) : [];
  return {
    fullName: repo.fullName,
    description: repo.description ?? "",
    areas: await Promise.all(
      areas.map(async (area) => ({
        nodeId: area._id as string,
        name: area.title,
        concerns: await Promise.all(
          (await children(area._id, 200)).map(async (concern) => {
            const files = await children(concern._id, 400);
            return {
              nodeId: concern._id as string,
              name: concern.title,
              styling: !!concern.styling,
              files: files
                .slice(0, FILES_SHOWN)
                .map((f) => ({ path: f.title, brief: f.brief })),
              more: Math.max(0, files.length - FILES_SHOWN),
            };
          }),
        ),
      })),
    ),
  };
}

export type NamingOutline = Outline;

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
