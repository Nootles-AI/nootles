import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { agentOwnsPage, agentProjects } from "../auth";
import { recordAudit } from "../audit";
import { serveEnabled, servedAuthority } from "../nmlMigration";
import { pageForDoc } from "../prosemirror";
import { readStoredUpdates } from "../ydoc";

/**
 * Which documents an MCP agent can see, and the bytes of one it may read.
 *
 * The rule the whole MCP design rests on: an agent only ever sees a document
 * whose canonical NML root is served — migrated, independently verified, in the
 * cohort, with the master serve switch on. A legacy document is not refused
 * after being found; it is never listed, and reading one by id answers the same
 * as an id that does not exist. Ownership is `auth.agentOwnsPage`'s, asked
 * first, so a document that is not the agent's principal's says nothing about
 * whether it is served.
 *
 * These run in the isolate and hand raw bytes to `mcp/read.ts`, which decodes in
 * Node for the heap a large document needs — the `nmlVerify` split.
 */

const PROJECTS = 100;
const PAGES = 1000;

export const docSummary = v.object({
  docId: v.string(),
  pageId: v.id("pages"),
  projectId: v.id("projects"),
  title: v.string(),
  projectTitle: v.string(),
  updatedAt: v.number(),
});

async function servable(ctx: QueryCtx, subject: string, page: Doc<"pages">) {
  const project = await agentOwnsPage(ctx, subject, page);
  if (!project) return { project: null, served: false };
  return { project, served: (await servedAuthority(ctx, page.docId)).serve };
}

const summarize = (page: Doc<"pages">, project: Doc<"projects">) => ({
  docId: page.docId,
  pageId: page._id,
  projectId: project._id,
  title: page.title,
  projectTitle: project.title,
  updatedAt: page.updatedAt ?? page.createdAt,
});

/** Every served document the subject owns, most recently edited first. */
export const servedDocs = internalQuery({
  args: { subject: v.string() },
  returns: v.array(docSummary),
  handler: async (ctx, args) => {
    if (!(await serveEnabled(ctx))) return [];
    const docs = [];
    let pagesRead = 0;
    for (const project of await agentProjects(ctx, args.subject, PROJECTS)) {
      for await (const page of ctx.db.query("pages").withIndex("by_project", (q) => q.eq("projectId", project._id))) {
        if (++pagesRead > PAGES) break;
        const { project: owned, served } = await servable(ctx, args.subject, page);
        if (owned && served) docs.push(summarize(page, owned));
      }
      if (pagesRead > PAGES) break;
    }
    return docs.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

/**
 * A reference as a person or model might give one: a docId, a page id, or a
 * Nootles page URL (`/p/<projectId>?page=<pageId>`).
 */
async function pageFor(ctx: QueryCtx, ref: string): Promise<Doc<"pages"> | null> {
  const trimmed = ref.trim();
  let candidate = trimmed;
  try {
    const url = new URL(trimmed);
    candidate = url.searchParams.get("page") ?? candidate;
  } catch {
    // Not a URL: an id.
  }
  const pageId = ctx.db.normalizeId("pages", candidate);
  if (pageId) return await ctx.db.get(pageId);
  return await pageForDoc(ctx, candidate);
}

export const material = v.union(
  v.object({
    status: v.literal("ok"),
    doc: docSummary,
    updates: v.array(v.bytes()),
  }),
  v.object({
    status: v.literal("refused"),
    reason: v.union(v.literal("not-found"), v.literal("not-served"), v.literal("too-large")),
    detail: v.optional(v.string()),
  }),
);

export const readMaterial = internalQuery({
  args: { subject: v.string(), ref: v.string() },
  returns: material,
  handler: async (ctx, args) => {
    const page = await pageFor(ctx, args.ref);
    if (!page) return { status: "refused" as const, reason: "not-found" as const };
    const project = await agentOwnsPage(ctx, args.subject, page);
    if (!project) return { status: "refused" as const, reason: "not-found" as const };
    if (!(await serveEnabled(ctx))) {
      return { status: "refused" as const, reason: "not-served" as const, detail: "serving-off" };
    }
    const authority = await servedAuthority(ctx, page.docId);
    if (!authority.serve) {
      return { status: "refused" as const, reason: "not-served" as const, detail: authority.reason };
    }
    const stored = await readStoredUpdates(ctx, page.docId);
    if (!stored) return { status: "refused" as const, reason: "not-found" as const };
    if ("tooLarge" in stored) return { status: "refused" as const, reason: "too-large" as const };
    return { status: "ok" as const, doc: summarize(page, project), updates: stored.updates };
  },
});

/**
 * The owner's project log gets one line per document an agent read: which page,
 * through which connection, and how many blocks — never what they said.
 */
export const recordRead = internalMutation({
  args: {
    subject: v.string(),
    grantId: v.id("mcpGrants"),
    pageId: v.id("pages"),
    projectId: v.id("projects"),
    blocks: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordAudit(ctx, {
      actorId: args.subject,
      actorKind: "user",
      action: "mcp.read",
      projectId: args.projectId,
      subjectKind: "page",
      subjectId: args.pageId,
      meta: { ids: { grant: args.grantId }, counts: { blocks: args.blocks } },
    });
    return null;
  },
});
