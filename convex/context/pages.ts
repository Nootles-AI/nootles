import { mutation, type MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { isTrashed, requireEditable } from "../auth";
import { digestFits, pageDigest, searchTextOf } from "./shape";

/**
 * The pages connector: the project's own pages, as nodes in its context graph.
 *
 * The first connector, and the proof of the contract — if pages needed a path
 * the other sources do not get, the contract would be wrong. What it can do
 * that no other source can is be exact: we own the ids, so a page that
 * mentions another is an edge with no guessing in it.
 */

/**
 * Takes a page's digest, written by the browser behind the sync provider's
 * flush (see `YConvexProvider.writeDerived`). Answers whether the graph now
 * holds it.
 *
 * Quietly declines a caller who may not write the page — a viewer's provider
 * offers one too — and a page an AI turn has edited that still awaits review:
 * text nobody has accepted is not yet the project's, and letting it into
 * context would make the model's output its own evidence. The next digest
 * offered after the review settles brings the page up to date.
 */
export const digest = mutation({
  args: { docId: v.string(), digest: pageDigest },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!digestFits(args.digest)) throw new Error("Digest too large");
    const found = await ctx.db
      .query("pages")
      .withIndex("by_doc", (q) => q.eq("docId", args.docId))
      .unique();
    if (!found) return false;
    let page: Doc<"pages">;
    try {
      page = await requireEditable(ctx, "pages", found._id);
    } catch {
      return false;
    }
    if (await underReview(ctx, page)) return false;

    const node = await pageNode(ctx, page);
    const text = await textOf(ctx, node._id);
    if (text?.contentHash === args.digest.contentHash) return true;

    const { brief, summary, terms, mentions, contentHash } = args.digest;
    if (node.brief !== brief || node.title !== page.title) {
      await ctx.db.patch(node._id, { brief, title: page.title });
    }
    const fields = {
      summary,
      summaryOrigin: "template" as const,
      terms,
      searchText: searchTextOf(page.title, terms),
      contentHash,
      syncedAt: Date.now(),
    };
    if (text) await ctx.db.patch(text._id, fields);
    else {
      await ctx.db.insert("contextNodeText", {
        nodeId: node._id,
        projectId: page.projectId,
        ...fields,
      });
    }
    await linkMentions(ctx, page, node._id, mentions);
    return true;
  },
});

/** Whether a turn still streaming or awaiting review has edited this page. */
async function underReview(ctx: MutationCtx, page: Doc<"pages">): Promise<boolean> {
  for (const status of ["streaming", "pending"] as const) {
    const turns = await ctx.db
      .query("chatTurns")
      .withIndex("by_project_status", (q) =>
        q.eq("projectId", page.projectId).eq("status", status),
      )
      .take(100);
    if (turns.some((t) => t.pageIds.includes(page._id))) return true;
  }
  return false;
}

/**
 * The page's node, made on first sight. A page mentioned before it has ever
 * been digested gets one too — an edge needs both ends — with its title and
 * owner and nothing else until its own digest arrives.
 */
export async function pageNode(
  ctx: MutationCtx,
  page: Doc<"pages">,
): Promise<Doc<"contextNodes">> {
  const existing = await ctx.db
    .query("contextNodes")
    .withIndex("by_project_and_externalId", (q) =>
      q.eq("projectId", page.projectId).eq("externalId", page._id),
    )
    .unique();
  if (existing) return existing;
  const fields = {
    projectId: page.projectId,
    source: "pages" as const,
    tier: "artifact" as const,
    kind: "page" as const,
    externalId: page._id,
    title: page.title,
    brief: "",
    owner: { memberId: page.createdBy ?? page.ownerId },
  };
  const id = await ctx.db.insert("contextNodes", fields);
  await ctx.db.insert("contextNodeText", {
    nodeId: id,
    projectId: page.projectId,
    summary: "",
    summaryOrigin: "template",
    terms: "",
    searchText: searchTextOf(page.title, ""),
    contentHash: "",
    syncedAt: Date.now(),
  });
  return (await ctx.db.get(id))!;
}

async function textOf(ctx: MutationCtx, nodeId: Id<"contextNodes">) {
  return await ctx.db
    .query("contextNodeText")
    .withIndex("by_nodeId", (q) => q.eq("nodeId", nodeId))
    .unique();
}

/**
 * Brings the page's outgoing mention edges in line with what it mentions now:
 * new ones are added, ones that no longer hold are retired. Mentions of pages
 * outside the project, or in the trash, are not relations the graph keeps.
 */
async function linkMentions(
  ctx: MutationCtx,
  page: Doc<"pages">,
  from: Id<"contextNodes">,
  mentions: readonly string[],
) {
  const targets = new Set<Id<"contextNodes">>();
  for (const raw of mentions) {
    const id = ctx.db.normalizeId("pages", raw);
    if (!id || id === page._id) continue;
    const target = await ctx.db.get(id);
    if (!target || target.projectId !== page.projectId || isTrashed(target)) continue;
    targets.add((await pageNode(ctx, target))._id);
  }

  const live = await ctx.db
    .query("contextEdges")
    .withIndex("by_from_and_family_and_expiredAt", (q) =>
      q.eq("from", from).eq("family", "references").eq("expiredAt", undefined),
    )
    .take(500);
  const now = Date.now();
  for (const edge of live) {
    if (targets.has(edge.to)) targets.delete(edge.to);
    else await ctx.db.patch(edge._id, { expiredAt: now });
  }
  for (const to of targets) {
    await ctx.db.insert("contextEdges", {
      projectId: page.projectId,
      from,
      to,
      family: "references",
      type: "mentions",
      origin: "parsed",
      createdAt: now,
    });
  }
}

/** Keeps a digested page's node on its current title. Caller has authorized the page. */
export async function retitlePageNode(
  ctx: MutationCtx,
  page: Doc<"pages">,
  title: string,
) {
  const node = await ctx.db
    .query("contextNodes")
    .withIndex("by_project_and_externalId", (q) =>
      q.eq("projectId", page.projectId).eq("externalId", page._id),
    )
    .unique();
  if (!node) return;
  await ctx.db.patch(node._id, { title });
  const text = await textOf(ctx, node._id);
  if (text) await ctx.db.patch(text._id, { searchText: searchTextOf(title, text.terms) });
}

/**
 * The page's node, its text and every edge touching it, gone — for the purge
 * that deletes the page for good. Caller has authorized the page.
 */
export async function removePageNode(ctx: MutationCtx, page: Doc<"pages">) {
  const node = await ctx.db
    .query("contextNodes")
    .withIndex("by_project_and_externalId", (q) =>
      q.eq("projectId", page.projectId).eq("externalId", page._id),
    )
    .unique();
  if (!node) return;
  const edges = [
    ...(await ctx.db
      .query("contextEdges")
      .withIndex("by_from_and_family_and_expiredAt", (q) => q.eq("from", node._id))
      .collect()),
    ...(await ctx.db
      .query("contextEdges")
      .withIndex("by_to_and_family_and_expiredAt", (q) => q.eq("to", node._id))
      .collect()),
  ];
  const ids = new Set(edges.map((e) => e._id));
  await Promise.all([...ids].map((id) => ctx.db.delete(id)));
  const text = await textOf(ctx, node._id);
  if (text) await ctx.db.delete(text._id);
  await ctx.db.delete(node._id);
}
