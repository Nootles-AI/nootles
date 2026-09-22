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
/** A repository's map is areas and concerns — dozens, not its thousands of files. */
const MAX_MAP = 600;
const MAX_FILES_SHOWN = 400;

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
    const [notes, pages, nodes, code] = await Promise.all([
      ctx.db
        .query("contextSheet")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(MAX_NOTES),
      ctx.db
        .query("pages")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(MAX_PAGES),
      ofKind(ctx, args.projectId, "page", MAX_PAGES),
      codeMap(ctx, args.projectId),
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
            out: pageOf((await mentions(ctx, open._id, "from")).map((e) => e.to)),
            in: pageOf((await mentions(ctx, open._id, "to")).map((e) => e.from)),
          }
        : { out: [], in: [] },
      code: code.repos.map((repo) => ({
        fullName: repo.fullName,
        files: repo.files,
        areas: code.areas
          .filter((a) => a.parentId === repo.nodeId)
          .map((a) => ({
            title: a.title,
            concerns: code.concerns.filter((c) => c.parentId === a.nodeId).map((c) => c.title),
          })),
        styling: code.concerns.find(
          (c) => c.styling && code.areas.some((a) => a.nodeId === c.parentId && a.parentId === repo.nodeId),
        )?.summary,
      })),
    };
  },
});

/**
 * `search_context`: nodes whose words match, best first — pages by what they
 * say, code by its paths, exports and leading comments. Full-text only for now.
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

/**
 * `expand_context`: the item and what it is connected to. A page's mentions,
 * each way; a concern's files and the concerns it pulls on; a file's concern
 * and what it imports and is imported by; an area's concerns; a repo's areas.
 */
export const expand = query({
  args: { projectId: v.id("projects"), id: v.string() },
  handler: async (ctx, args) => {
    const node = await resolve(ctx, args.projectId, args.id);
    if (!node) return null;
    const describe = describer(ctx);
    const item = await describe(node);
    if (!item) return null;
    const out: (Described & { relation: string })[] = [];
    const push = async (ids: Id<"contextNodes">[], relation: string) => {
      for (const id of ids) {
        const other = await ctx.db.get(id);
        const described = other && (await describe(other));
        if (described) out.push({ relation, ...described });
      }
    };

    if (node.kind === "page") {
      await push((await mentions(ctx, node._id, "from")).map((e) => e.to), "mentions");
      await push((await mentions(ctx, node._id, "to")).map((e) => e.from), "mentioned by");
    } else if (node.kind === "file") {
      if (node.parentId) await push([node.parentId], "in concern");
      const refs = await references(ctx, node._id);
      await push(refs.out, "imports");
      await push(refs.in, "imported by");
    } else {
      const children = await ctx.db
        .query("contextNodes")
        .withIndex("by_parentId", (q) => q.eq("parentId", node._id))
        .take(MAX_LINKS);
      await push(children.map((c) => c._id), "contains");
      if (node.kind === "concern") {
        await push((await rollups(ctx, node._id)).map((r) => r.id), "works with");
      }
    }
    return { ...item, links: out };
  },
});

/**
 * `read_context`: the item at summary resolution. The body stays at its source
 * — a page is read with `read_page`, a file's text is fetched from GitHub by
 * the tool (`github/read.nodeFile`).
 */
export const read = query({
  args: { projectId: v.id("projects"), id: v.string() },
  handler: async (ctx, args) => {
    const node = await resolve(ctx, args.projectId, args.id);
    if (!node) return null;
    const item = await describer(ctx)(node);
    if (!item) return null;
    return { ...item, summary: (await textOf(ctx, node._id))?.summary ?? "" };
  },
});

/**
 * One concern as the graph view's panel shows it: its summary, its files, and
 * the concerns it works with most.
 */
export const concern = query({
  args: { projectId: v.id("projects"), nodeId: v.id("contextNodes") },
  handler: async (ctx, args) => {
    if (!(await readVisible(ctx, "projects", args.projectId))) return null;
    const node = await ctx.db.get(args.nodeId);
    if (!node || node.projectId !== args.projectId) return null;
    const files = await ctx.db
      .query("contextNodes")
      .withIndex("by_parentId", (q) => q.eq("parentId", node._id))
      .take(MAX_FILES_SHOWN);
    return {
      summary: (await textOf(ctx, node._id))?.summary ?? "",
      origin: (await textOf(ctx, node._id))?.summaryOrigin ?? "template",
      files: files
        .map((f) => ({ path: f.title, brief: f.brief, url: f.url ?? null }))
        .sort((a, b) => (a.path < b.path ? -1 : 1)),
      related: await rollups(ctx, node._id),
    };
  },
});

type Described = {
  id: Id<"contextNodes">;
  kind: Doc<"contextNodes">["kind"];
  title: string;
  brief: string;
  /** For a page: its id, what read_page takes. */
  pageId?: Id<"pages">;
  /** For code: where it is on GitHub, and which repository. */
  url?: string;
  repo?: string;
  owner: string | null;
  updatedAt?: number;
};

/**
 * A node as a tool result, or null when what it stands for is gone — a page in
 * the trash is not context. A page's title is the page's own, not the node's
 * copy, so a rename reads through at once. Owners are looked up once per call.
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
  const ownerOf = async (node: Doc<"contextNodes">) =>
    node.owner.memberId ? await nameOf(node.owner.memberId) : (node.owner.handle ?? null);

  return async (node: Doc<"contextNodes">): Promise<Described | null> => {
    if (node.source === "github") {
      return {
        id: node._id,
        kind: node.kind,
        title: node.title,
        brief: node.brief,
        ...(node.url ? { url: node.url } : {}),
        repo: node.externalId.split(/[#:]/, 1)[0],
        owner: await ownerOf(node),
      };
    }
    const pageId = ctx.db.normalizeId("pages", node.externalId);
    const page = pageId ? await ctx.db.get(pageId) : null;
    if (!page || isTrashed(page) || page.projectId !== node.projectId) return null;
    return {
      id: node._id,
      kind: node.kind,
      pageId: page._id,
      title: page.title,
      brief: node.brief,
      owner: await ownerOf(node),
      updatedAt: page.updatedAt ?? page.createdAt,
    };
  };
}

/**
 * An id from the model, as the node it names: a node id from `search_context`,
 * a page id, or a file as "owner/repo:path" — whichever the model holds.
 * Anything outside the project, or unreadable to the caller, is no node.
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
  const externalId = ctx.db.normalizeId("pages", raw) ?? raw.trim();
  return await ctx.db
    .query("contextNodes")
    .withIndex("by_project_and_externalId", (q) =>
      q.eq("projectId", projectId).eq("externalId", externalId),
    )
    .unique();
}

async function ofKind(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  kind: Doc<"contextNodes">["kind"],
  limit: number,
) {
  return await ctx.db
    .query("contextNodes")
    .withIndex("by_project_and_kind", (q) => q.eq("projectId", projectId).eq("kind", kind))
    .take(limit);
}

async function textOf(ctx: QueryCtx, nodeId: Id<"contextNodes">) {
  return await ctx.db
    .query("contextNodeText")
    .withIndex("by_nodeId", (q) => q.eq("nodeId", nodeId))
    .unique();
}

/** Live mention edges leaving (`from`) or arriving at (`to`) a page's node. */
async function mentions(ctx: QueryCtx, node: Id<"contextNodes">, end: "from" | "to") {
  const rows =
    end === "from"
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
  return rows.filter((e) => e.type === "mentions");
}

/** What a file imports, and what imports it. */
async function references(ctx: QueryCtx, node: Id<"contextNodes">) {
  const out = await ctx.db
    .query("contextEdges")
    .withIndex("by_from_and_family_and_expiredAt", (q) =>
      q.eq("from", node).eq("family", "references").eq("expiredAt", undefined),
    )
    .take(MAX_LINKS);
  const into = await ctx.db
    .query("contextEdges")
    .withIndex("by_to_and_family_and_expiredAt", (q) =>
      q.eq("to", node).eq("family", "references").eq("expiredAt", undefined),
    )
    .take(MAX_LINKS);
  return { out: out.map((e) => e.to), in: into.map((e) => e.from) };
}

/** The concerns a concern works with most, strongest first, by their rollup weight. */
async function rollups(ctx: QueryCtx, node: Id<"contextNodes">) {
  const [out, into] = await Promise.all([
    ctx.db
      .query("contextEdges")
      .withIndex("by_from_and_family_and_expiredAt", (q) =>
        q.eq("from", node).eq("family", "references").eq("expiredAt", undefined),
      )
      .take(MAX_LINKS),
    ctx.db
      .query("contextEdges")
      .withIndex("by_to_and_family_and_expiredAt", (q) =>
        q.eq("to", node).eq("family", "references").eq("expiredAt", undefined),
      )
      .take(MAX_LINKS),
  ]);
  const weights = new Map<Id<"contextNodes">, number>();
  for (const e of out) if (e.type === "rollup") weights.set(e.to, (weights.get(e.to) ?? 0) + (e.weight ?? 0));
  for (const e of into) if (e.type === "rollup") weights.set(e.from, (weights.get(e.from) ?? 0) + (e.weight ?? 0));
  const rows = [];
  for (const [id, weight] of weights) {
    const other = await ctx.db.get(id);
    if (other) rows.push({ id, nodeId: id as string, title: other.title, weight });
  }
  return rows.sort((a, b) => b.weight - a.weight).slice(0, 8);
}

/**
 * Every linked repository's map: its areas and concerns, never its files. The
 * linked row is the truth for what is linked — a repository still indexing has
 * no nodes yet and is shown all the same.
 */
async function codeMap(ctx: QueryCtx, projectId: Id<"projects">) {
  const [rows, repoNodes, areas, concerns] = await Promise.all([
    ctx.db
      .query("projectRepos")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .take(50),
    ofKind(ctx, projectId, "repo", 50),
    ofKind(ctx, projectId, "area", MAX_MAP),
    ofKind(ctx, projectId, "concern", MAX_MAP),
  ]);
  const nodeByName = new Map(repoNodes.map((n) => [n.externalId, n]));
  const styling = concerns.find((c) => c.styling);
  const stylingText = styling ? await textOf(ctx, styling._id) : null;
  return {
    repos: rows.map((r) => {
      const node = nodeByName.get(r.fullName);
      return {
        repoId: r._id as string,
        nodeId: (node?._id as string | undefined) ?? null,
        fullName: r.fullName,
        url: `https://github.com/${r.fullName}`,
        description: r.description ?? "",
        state: r.index?.state ?? "ready",
        error: r.index?.error ?? null,
        files: r.index?.files ?? 0,
        indexedAt: r.index?.at ?? null,
      };
    }),
    areas: areas.map((a) => ({
      nodeId: a._id as string,
      parentId: (a.parentId as string | undefined) ?? null,
      title: a.title,
      brief: a.brief,
    })),
    concerns: await Promise.all(
      concerns.map(async (c) => ({
        nodeId: c._id as string,
        parentId: (c.parentId as string | undefined) ?? null,
        title: c.title,
        brief: c.brief,
        styling: !!c.styling,
        // Only the styling concern's summary rides in the pack; the rest are
        // read when asked for.
        summary: c._id === styling?._id ? (stylingText?.summary ?? "") : undefined,
      })),
    ),
  };
}

/**
 * The whole graph as the context view draws it: the project, its folders and
 * pages, the live mentions between them, and each linked repository's map with
 * the pull between its concerns — in one read, so the view settles once rather
 * than filling in node by node. Owners come with a face where the profile has
 * one. Summaries are not here; the panel reads them for what it is showing.
 */
export const graph = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await readVisible(ctx, "projects", args.projectId);
    if (!project) return null;
    const [folders, pages, nodes, mentionEdges, rollupEdges, code] = await Promise.all([
      ctx.db
        .query("folders")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(MAX_PAGES),
      ctx.db
        .query("pages")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .take(MAX_PAGES),
      ofKind(ctx, args.projectId, "page", MAX_PAGES),
      ctx.db
        .query("contextEdges")
        .withIndex("by_project_and_type", (q) =>
          q.eq("projectId", args.projectId).eq("type", "mentions"),
        )
        .take(MAX_PAGES * 5),
      ctx.db
        .query("contextEdges")
        .withIndex("by_project_and_type", (q) =>
          q.eq("projectId", args.projectId).eq("type", "rollup"),
        )
        .take(MAX_MAP * 4),
      codeMap(ctx, args.projectId),
    ]);

    const byExternal = new Map(nodes.map((n) => [n.externalId, n]));
    const pageOfNode = new Map(nodes.map((n) => [n._id, n.externalId]));
    const live = pages.filter((p) => !isTrashed(p));
    const livePages = new Set<string>(live.map((p) => p._id));

    const ownerOf = (p: Doc<"pages">) =>
      byExternal.get(p._id)?.owner.memberId ?? p.createdBy ?? p.ownerId;
    const faces = new Map<string, { name: string; imageUrl?: string } | null>();
    for (const memberId of new Set(live.map(ownerOf))) {
      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_owner", (q) => q.eq("ownerId", memberId))
        .unique();
      const name = profile?.name ?? profile?.email;
      faces.set(memberId, name ? { name, imageUrl: profile?.imageUrl } : null);
    }

    return {
      title: project.title,
      folders: folders
        .filter((f) => !isTrashed(f))
        .map((f) => ({
          folderId: f._id as string,
          title: f.title,
          parentId: (f.parentId as string | undefined) ?? null,
          icon: f.icon ?? null,
        })),
      pages: live.map((p) => {
        const node = byExternal.get(p._id);
        return {
          pageId: p._id as string,
          docId: p.docId,
          title: p.title,
          icon: p.icon ?? null,
          folderId: (p.folderId as string | undefined) ?? null,
          brief: node?.brief ?? "",
          digested: !!node?.brief,
          owner: faces.get(ownerOf(p)) ?? null,
          updatedAt: p.updatedAt ?? p.createdAt,
        };
      }),
      mentions: mentionEdges.flatMap((e) => {
        if (e.expiredAt !== undefined) return [];
        const from = pageOfNode.get(e.from);
        const to = pageOfNode.get(e.to);
        return from && to && livePages.has(from) && livePages.has(to) ? [{ from, to }] : [];
      }),
      code: {
        repos: code.repos,
        areas: code.areas,
        concerns: code.concerns.map((c) => ({
          nodeId: c.nodeId,
          parentId: c.parentId,
          title: c.title,
          brief: c.brief,
          styling: c.styling,
        })),
        rollups: rollupEdges.map((e) => ({
          from: e.from as string,
          to: e.to as string,
          weight: e.weight ?? 0,
        })),
      },
    };
  },
});
