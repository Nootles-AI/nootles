import { query, type QueryCtx } from "../_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { isTrashed, readVisible } from "../auth";

/**
 * Reading a project's context graph: what every lane's pack is rendered from,
 * and the three verbs the agent walks it with. Everyone who can see the
 * project can read all of it — ownership is shown, never enforced.
 */

/** Past this, a pack lists the rest by count; `list_pages` still has them all. */
const MAX_PAGES = 1000;
const MAX_NOTES = 50;
const MAX_LINKS = 50;

/**
 * Everything a pack is rendered from, in one round trip. The renderers are
 * pure functions over this (`app/lib/ai/context/pack.ts`), so the chat route
 * and the completion lane print the same project the same way.
 *
 * `pageId` is the open page, whose links seed the pack. A string rather than
 * an id because it arrives from the client: a malformed one is simply no page,
 * never a failed read that takes the whole context with it.
 */
export const packInputs = query({
  args: { projectId: v.id("projects"), pageId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const project = await readVisible(ctx, "projects", args.projectId);
    if (!project) return null;
    const [notes, pages, nodes] = await Promise.all([
      ctx.db
        .query("contextSheet")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(MAX_NOTES),
      ctx.db
        .query("pages")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(MAX_PAGES),
      ctx.db
        .query("contextNodes")
        .withIndex("by_project_and_externalId", (q) => q.eq("projectId", args.projectId))
        .take(MAX_PAGES),
    ]);

    const byExternal = new Map(nodes.map((n) => [n.externalId, n]));
    const byId = new Map(nodes.map((n) => [n._id, n]));
    const pageId = args.pageId ? ctx.db.normalizeId("pages", args.pageId) : null;
    const open = pageId ? byExternal.get(pageId) : undefined;
    const pageOf = (ids: Id<"contextNodes">[]) =>
      ids.flatMap((id) => {
        const node = byId.get(id);
        return node ? [node.externalId] : [];
      });

    return {
      title: project.title,
      notes: notes.flatMap((n) =>
        n.answer?.trim() ? [{ question: n.question, answer: n.answer }] : [],
      ),
      pages: pages
        .filter((p) => !isTrashed(p))
        .map((p) => ({
          pageId: p._id as string,
          title: p.title,
          brief: byExternal.get(p._id)?.brief ?? "",
          updatedAt: p.updatedAt ?? p.createdAt,
        })),
      links: open
        ? {
            out: pageOf((await edges(ctx, open._id, "from")).map((e) => e.to)),
            in: pageOf((await edges(ctx, open._id, "to")).map((e) => e.from)),
          }
        : { out: [], in: [] },
    };
  },
});

/**
 * `search_context`: nodes whose words match, best first. Full-text only for
 * now — every node is in plain words already, so this finds a page by what it
 * says as well as by its title.
 */
export const search = query({
  args: {
    projectId: v.id("projects"),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!(await readVisible(ctx, "projects", args.projectId))) return [];
    const limit = Math.min(10, Math.max(1, Math.floor(args.limit ?? 6)));
    // Twice over, because a hit on a page in the trash is dropped after.
    const hits = await ctx.db
      .query("contextNodeText")
      .withSearchIndex("search_text", (q) =>
        q.search("searchText", args.query).eq("projectId", args.projectId),
      )
      .take(limit * 2);
    const describe = describer(ctx);
    const found: Described[] = [];
    for (const hit of hits) {
      const node = await ctx.db.get(hit.nodeId);
      const item = node && (await describe(node));
      if (item) found.push(item);
      if (found.length === limit) break;
    }
    return found;
  },
});

/** `expand_context`: the item and what it is connected to, each way. */
export const expand = query({
  args: { projectId: v.id("projects"), id: v.string() },
  handler: async (ctx, args) => {
    const node = await resolve(ctx, args.projectId, args.id);
    if (!node) return null;
    const describe = describer(ctx);
    const item = await describe(node);
    if (!item) return null;
    const linked = async (ids: Id<"contextNodes">[], relation: string) => {
      const out: (Described & { relation: string })[] = [];
      for (const id of ids) {
        const other = await ctx.db.get(id);
        const described = other && (await describe(other));
        if (described) out.push({ relation, ...described });
      }
      return out;
    };
    return {
      ...item,
      links: [
        ...(await linked((await edges(ctx, node._id, "from")).map((e) => e.to), "mentions")),
        ...(await linked(
          (await edges(ctx, node._id, "to")).map((e) => e.from),
          "mentioned by",
        )),
      ],
    };
  },
});

/** `read_context`: the item at summary resolution. The body stays at its source. */
export const read = query({
  args: { projectId: v.id("projects"), id: v.string() },
  handler: async (ctx, args) => {
    const node = await resolve(ctx, args.projectId, args.id);
    if (!node) return null;
    const item = await describer(ctx)(node);
    if (!item) return null;
    const text = await ctx.db
      .query("contextNodeText")
      .withIndex("by_nodeId", (q) => q.eq("nodeId", node._id))
      .unique();
    return { ...item, summary: text?.summary ?? "" };
  },
});

type Described = {
  id: Id<"contextNodes">;
  kind: Doc<"contextNodes">["kind"];
  pageId: Id<"pages">;
  title: string;
  brief: string;
  owner: string | null;
  updatedAt: number;
};

/**
 * A node as a tool result, or null when what it stands for is gone — a page in
 * the trash is not context. The title is the page's, not the node's copy, so a
 * rename reads through at once. Owners are looked up once per call.
 */
function describer(ctx: QueryCtx) {
  const names = new Map<string, Promise<string | null>>();
  const nameOf = (memberId: string) => {
    if (!names.has(memberId)) {
      names.set(
        memberId,
        ctx.db
          .query("profiles")
          .withIndex("by_owner", (q) => q.eq("ownerId", memberId))
          .unique()
          .then((p) => p?.name ?? p?.email ?? null),
      );
    }
    return names.get(memberId)!;
  };
  return async (node: Doc<"contextNodes">): Promise<Described | null> => {
    const pageId = ctx.db.normalizeId("pages", node.externalId);
    const page = pageId ? await ctx.db.get(pageId) : null;
    if (!page || isTrashed(page) || page.projectId !== node.projectId) return null;
    return {
      id: node._id,
      kind: node.kind,
      pageId: page._id,
      title: page.title,
      brief: node.brief,
      owner: node.owner.memberId
        ? await nameOf(node.owner.memberId)
        : (node.owner.handle ?? null),
      updatedAt: page.updatedAt ?? page.createdAt,
    };
  };
}

/**
 * An id from the model, as the node it names: a node id from `search_context`,
 * or a page id, which is what the model more often holds. Anything outside the
 * project, or unreadable to the caller, is no node.
 */
async function resolve(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  raw: string,
): Promise<Doc<"contextNodes"> | null> {
  if (!(await readVisible(ctx, "projects", projectId))) return null;
  const nodeId = ctx.db.normalizeId("contextNodes", raw);
  if (nodeId) {
    const node = await ctx.db.get(nodeId);
    return node?.projectId === projectId ? node : null;
  }
  const pageId = ctx.db.normalizeId("pages", raw);
  if (!pageId) return null;
  return await ctx.db
    .query("contextNodes")
    .withIndex("by_project_and_externalId", (q) =>
      q.eq("projectId", projectId).eq("externalId", pageId),
    )
    .unique();
}

/** Live mention edges leaving (`from`) or arriving at (`to`) a node. */
async function edges(ctx: QueryCtx, node: Id<"contextNodes">, end: "from" | "to") {
  return end === "from"
    ? await ctx.db
        .query("contextEdges")
        .withIndex("by_from_and_family_and_expiredAt", (q) =>
          q.eq("from", node).eq("family", "references").eq("expiredAt", undefined),
        )
        .take(MAX_LINKS)
    : await ctx.db
        .query("contextEdges")
        .withIndex("by_to_and_family_and_expiredAt", (q) =>
          q.eq("to", node).eq("family", "references").eq("expiredAt", undefined),
        )
        .take(MAX_LINKS);
}
