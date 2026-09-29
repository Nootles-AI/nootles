import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { agentOwnsPage, agentProjects, isTrashed } from "../auth";
import { recordAudit } from "../audit";
import { retitlePageNode } from "../context/pages";
import { entitlementIn, hasRoom } from "../entitlements";
import { serveEnabled, servedAuthority } from "../nmlMigration";
import { insertPage } from "../pages";
import { insertProject, refreshPageSummary, stampProject } from "../projects";
import { isRateRefusal, limitMode } from "../requestLimits";
import { grantMayWrite } from "./oauth";
import { pageFor } from "./docs";

/**
 * MCP's workspace verbs (NT-124): the agent's projects, and making, renaming and
 * trashing pages and projects — each the same row changes the app's own
 * mutations make (`pages.insertPage`, `projects.insertProject`, the rename and
 * soft-delete patches), so a page an agent makes is indistinguishable from one
 * a person makes, born on NML when it would be served.
 *
 * Every write re-checks the grant (`docs:write`, switch, allowlist) inside its
 * own transaction, spends one unit of the subject's `mcpEdit` budget, keeps to
 * the subject's live personal projects, and leaves one content-free audit line.
 */

/** Past this many a project is not listed with its page counts; the agent is told. */
const PROJECTS = 100;

const writeRefusal = v.union(
  v.literal("no-write"),
  v.literal("not-found"),
  v.literal("not-served"),
  v.literal("serving-off"),
  v.literal("quota"),
  v.literal("rate-limited"),
);
export type WriteRefusal = Infer<typeof writeRefusal>;
const refused = (reason: WriteRefusal) => ({ status: "refused" as const, reason });

/** The subject's own live personal project, by id or by exact title (ignoring case). */
async function ownProject(ctx: QueryCtx, subject: string, ref: string): Promise<Doc<"projects"> | null> {
  const id = ctx.db.normalizeId("projects", ref.trim());
  if (id) {
    const project = await ctx.db.get(id);
    return project && project.ownerId === subject && !project.workspaceId && !isTrashed(project) ? project : null;
  }
  const wanted = ref.trim().toLowerCase();
  const matches = (await agentProjects(ctx, subject, PROJECTS)).filter((p) => p.title.trim().toLowerCase() === wanted);
  return matches.length === 1 ? matches[0] : null;
}

/** The grant, then one unit of edit budget — or why not. */
async function mayWrite(
  ctx: MutationCtx,
  args: { subject: string; grantId: Id<"mcpGrants"> },
): Promise<WriteRefusal | null> {
  if (!(await grantMayWrite(ctx, args.grantId, args.subject))) return "no-write";
  if (limitMode() === "off") return null;
  try {
    await ctx.runMutation(internal.requestLimits.debitFor, { bucket: "mcpEdit", subject: args.subject });
    return null;
  } catch (error) {
    if (isRateRefusal(error)) return "rate-limited";
    throw error;
  }
}

async function audit(
  ctx: MutationCtx,
  args: { subject: string; grantId: Id<"mcpGrants"> },
  action: string,
  projectId: Id<"projects">,
  subject: { kind: "page" | "project"; id: string },
) {
  await recordAudit(ctx, {
    actorId: args.subject,
    actorKind: "user",
    action,
    projectId,
    subjectKind: subject.kind,
    subjectId: subject.id,
    meta: { ids: { grant: args.grantId } },
  });
}

const projectSummary = v.object({
  projectId: v.id("projects"),
  title: v.string(),
  description: v.optional(v.string()),
  pages: v.number(),
  served: v.number(),
  updatedAt: v.number(),
});

/** The subject's live personal projects, newest first, with how many pages each has served. */
export const listProjects = internalQuery({
  args: { subject: v.string() },
  returns: v.object({ projects: v.array(projectSummary), truncated: v.boolean() }),
  handler: async (ctx, args) => {
    const projects = await agentProjects(ctx, args.subject, PROJECTS + 1);
    const on = await serveEnabled(ctx);
    const out = [];
    for (const project of projects.slice(0, PROJECTS)) {
      let pages = 0;
      let served = 0;
      let updatedAt = project.updatedAt ?? project.createdAt;
      for await (const page of ctx.db.query("pages").withIndex("by_project", (q) => q.eq("projectId", project._id))) {
        if (isTrashed(page)) continue;
        pages++;
        updatedAt = Math.max(updatedAt, page.updatedAt ?? page.createdAt);
        if (on && (await servedAuthority(ctx, page.docId)).serve) served++;
      }
      out.push({ projectId: project._id, title: project.title, description: project.description, pages, served, updatedAt });
    }
    return { projects: out.sort((a, b) => b.updatedAt - a.updatedAt), truncated: projects.length > PROJECTS };
  },
});

const created = v.object({
  status: v.literal("created"),
  projectId: v.id("projects"),
  projectTitle: v.string(),
  pageId: v.id("pages"),
  docId: v.string(),
  title: v.string(),
});

/**
 * A new personal project with one blank page, as the app's "New project" makes
 * it — within the subject's plan's project quota. Only while serving is on, so
 * the page it hands back is one the agent can go on to write.
 */
export const createProject = internalMutation({
  args: {
    subject: v.string(),
    grantId: v.id("mcpGrants"),
    title: v.string(),
    description: v.optional(v.string()),
    pageTitle: v.optional(v.string()),
  },
  returns: v.union(created, v.object({ status: v.literal("refused"), reason: writeRefusal })),
  handler: async (ctx, args) => {
    const refusal = await mayWrite(ctx, args);
    if (refusal) return refused(refusal);
    if (!(await serveEnabled(ctx))) return refused("serving-off");
    if (!hasRoom(await entitlementIn(ctx, { kind: "account", ownerId: args.subject }), "projects")) return refused("quota");
    const now = Date.now();
    const title = args.title.trim().slice(0, 200) || "Untitled";
    const projectId = await insertProject(ctx, args.subject, { title, description: args.description?.trim() || undefined }, now);
    const pageTitle = args.pageTitle?.trim().slice(0, 200) ?? "";
    const pageId = await insertPage(ctx, { projectId, ownerId: args.subject, createdBy: args.subject, title: pageTitle });
    const page = (await ctx.db.get(pageId))!;
    await audit(ctx, args, "mcp.createProject", projectId, { kind: "project", id: projectId });
    return { status: "created" as const, projectId, projectTitle: title, pageId, docId: page.docId, title: pageTitle };
  },
});

/** A new page at the end of one of the subject's projects, born on NML. */
export const createPage = internalMutation({
  args: { subject: v.string(), grantId: v.id("mcpGrants"), project: v.string(), title: v.optional(v.string()) },
  returns: v.union(created, v.object({ status: v.literal("refused"), reason: writeRefusal })),
  handler: async (ctx, args) => {
    const refusal = await mayWrite(ctx, args);
    if (refusal) return refused(refusal);
    if (!(await serveEnabled(ctx))) return refused("serving-off");
    const project = await ownProject(ctx, args.subject, args.project);
    if (!project) return refused("not-found");
    const title = args.title?.trim().slice(0, 200) ?? "";
    const pageId = await insertPage(ctx, { projectId: project._id, ownerId: args.subject, createdBy: args.subject, title });
    const page = (await ctx.db.get(pageId))!;
    // Born served when the owner is in the cohort, which an MCP subject always is;
    // said rather than assumed, so a cohort change can never hand back a page the
    // agent then cannot see.
    if (!(await servedAuthority(ctx, page.docId)).serve) return refused("not-served");
    await stampProject(ctx, project._id, page.createdAt);
    await audit(ctx, args, "mcp.createPage", project._id, { kind: "page", id: pageId });
    return { status: "created" as const, projectId: project._id, projectTitle: project.title, pageId, docId: page.docId, title };
  },
});

/** A served page the subject owns, found as `read_doc` finds one. */
async function ownServedPage(ctx: QueryCtx, subject: string, ref: string) {
  const page = await pageFor(ctx, ref);
  const project = page && (await agentOwnsPage(ctx, subject, page));
  if (!page || !project) return "not-found" as const;
  if (!(await serveEnabled(ctx)) || !(await servedAuthority(ctx, page.docId)).serve) return "not-served" as const;
  return { page, project };
}

export const rename = internalMutation({
  args: {
    subject: v.string(),
    grantId: v.id("mcpGrants"),
    target: v.union(v.literal("page"), v.literal("project")),
    ref: v.string(),
    title: v.string(),
  },
  returns: v.union(
    v.object({ status: v.literal("renamed"), target: v.union(v.literal("page"), v.literal("project")), id: v.string(), from: v.string(), to: v.string(), projectId: v.id("projects"), pageId: v.optional(v.id("pages")) }),
    v.object({ status: v.literal("refused"), reason: writeRefusal }),
  ),
  handler: async (ctx, args) => {
    const refusal = await mayWrite(ctx, args);
    if (refusal) return refused(refusal);
    const title = args.title.trim().slice(0, 200);
    const now = Date.now();
    if (args.target === "project") {
      const project = await ownProject(ctx, args.subject, args.ref);
      if (!project) return refused("not-found");
      await ctx.db.patch(project._id, { title });
      await audit(ctx, args, "mcp.renameProject", project._id, { kind: "project", id: project._id });
      return { status: "renamed" as const, target: "project" as const, id: project._id, from: project.title, to: title, projectId: project._id };
    }
    const found = await ownServedPage(ctx, args.subject, args.ref);
    if (typeof found === "string") return refused(found);
    await ctx.db.patch(found.page._id, { title, updatedAt: now });
    await retitlePageNode(ctx, found.page, title);
    await stampProject(ctx, found.project._id, now);
    await audit(ctx, args, "mcp.renamePage", found.project._id, { kind: "page", id: found.page._id });
    return {
      status: "renamed" as const,
      target: "page" as const,
      id: found.page.docId,
      from: found.page.title,
      to: title,
      projectId: found.project._id,
      pageId: found.page._id,
    };
  },
});

/**
 * Moves a page to the trash, as the sidebar's Delete does: a stamp, restorable
 * from the app's Trash until the purge cron's retention passes.
 */
export const trashPage = internalMutation({
  args: { subject: v.string(), grantId: v.id("mcpGrants"), ref: v.string() },
  returns: v.union(
    v.object({ status: v.literal("trashed"), docId: v.string(), title: v.string(), projectTitle: v.string() }),
    v.object({ status: v.literal("refused"), reason: writeRefusal }),
  ),
  handler: async (ctx, args) => {
    const refusal = await mayWrite(ctx, args);
    if (refusal) return refused(refusal);
    const found = await ownServedPage(ctx, args.subject, args.ref);
    if (typeof found === "string") return refused(found);
    await ctx.db.patch(found.page._id, { deletedAt: Date.now() });
    await refreshPageSummary(ctx, found.project._id);
    await audit(ctx, args, "mcp.trashPage", found.project._id, { kind: "page", id: found.page._id });
    return { status: "trashed" as const, docId: found.page.docId, title: found.page.title, projectTitle: found.project.title };
  },
});
