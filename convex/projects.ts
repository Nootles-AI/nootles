import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import {
  ownerId as currentOwner,
  isTrashed,
  projectRole,
  readVisible,
  requireOwned,
  requireOwner,
  roleForProject,
} from "./auth";
import { ABOUT, BACKGROUND } from "./ai/questions";
import { add as addRepos } from "./github/repos";
import { repoRef } from "./schema";

/**
 * The page facts the projects screen draws — how many, which one to preview,
 * and when the project was last touched.
 *
 * Read off the project row wherever it carries them: derived the honest way,
 * a screen listing N projects reads every page of all of them, and any page
 * edit anywhere re-runs it. `pageCount` being set is what says the whole
 * summary is; projects written before it existed fall back to the pages.
 */
async function pageSummary(ctx: QueryCtx, project: Doc<"projects">) {
  if (project.pageCount !== undefined) {
    // Verify the one reference a reader acts on before handing it out: a
    // `firstPageDocId` whose page has since been deleted subscribes every
    // card to a document `checkRead` refuses, and that server error unmounts
    // the whole screen. A dangling summary falls back to the live scan.
    const docId = project.firstPageDocId ?? null;
    const first = docId
      ? await ctx.db
          .query("pages")
          .withIndex("by_doc", (q) => q.eq("docId", docId))
          .unique()
      : null;
    if (docId === null || first?.projectId === project._id) {
      return {
        pageCount: project.pageCount,
        firstPageDocId: docId,
        updatedAt: project.updatedAt ?? project.createdAt,
      };
    }
  }
  // Ordered by the index, so the first row is the page the sidebar shows at
  // the top — the one a thumbnail of "this project" should be of.
  const pages = (
    await ctx.db
      .query("pages")
      .withIndex("by_project", (q) => q.eq("projectId", project._id))
      .collect()
  ).filter((p) => !isTrashed(p));
  return {
    pageCount: pages.length,
    firstPageDocId: pages[0]?.docId ?? null,
    updatedAt: pages.reduce(
      (m, pg) => Math.max(m, pg.updatedAt ?? pg.createdAt),
      project.createdAt,
    ),
  };
}

/**
 * Recomputes the denormalized summary. EVERY mutation that adds, removes,
 * renames or reorders a page has to call this — nothing else refreshes it, and
 * what it holds is what the projects screen believes.
 */
export async function refreshPageSummary(
  ctx: MutationCtx,
  projectId: Id<"projects">,
) {
  const project = await ctx.db.get(projectId);
  if (!project) return;
  const pages = (
    await ctx.db
      .query("pages")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect()
  ).filter((p) => !isTrashed(p));
  await ctx.db.patch(projectId, {
    pageCount: pages.length,
    firstPageDocId: pages[0]?.docId,
    updatedAt: pages.reduce(
      (m, pg) => Math.max(m, pg.updatedAt ?? pg.createdAt),
      project.createdAt,
    ),
  });
}

/**
 * Carries a page's edited-stamp up to the project, for the debounced touches
 * that change nothing else about the page set. A project that has no summary
 * yet gets a whole one — which is how projects predating it are folded in,
 * one first edit at a time, without a migration.
 */
export async function stampProject(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  at: number,
) {
  const project = await ctx.db.get(projectId);
  if (!project) return;
  if (project.pageCount === undefined) return await refreshPageSummary(ctx, projectId);
  await ctx.db.patch(projectId, { updatedAt: at });
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const owner = await currentOwner(ctx);
    if (!owner) return [];
    return (
      await ctx.db
        .query("projects")
        .withIndex("by_owner", (q) => q.eq("ownerId", owner))
        .order("desc")
        .collect()
    ).filter((p) => !isTrashed(p));
  },
});

export const get = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => await readVisible(ctx, "projects", args.projectId),
});

/**
 * What the caller is to this project, so the workspace knows which chrome to
 * draw — share controls and project settings are the owner's, editing is the
 * owner's and editors', viewers read. Null means "not yours to see", which the
 * client treats the same as a project that does not exist.
 */
export const myRole = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => await projectRole(ctx, args.projectId),
});

/**
 * Projects other people shared with the caller — the claims that still grant a
 * role, joined to what the projects screen needs to draw a row. The owner's
 * name rides along because "by whom" is the one fact that distinguishes this
 * list from "mine".
 */
export const sharedWithMe = query({
  args: {},
  handler: async (ctx) => {
    const me = await currentOwner(ctx);
    if (!me) return [];
    const claims = await ctx.db
      .query("shareClaims")
      .withIndex("by_grantee", (q) => q.eq("granteeId", me))
      .collect();

    const rows = await Promise.all(
      claims.map(async (claim) => {
        const project = await ctx.db.get(claim.projectId);
        if (!project || isTrashed(project)) return null;
        const role = await roleForProject(ctx, project);
        // "owner" would mean a stray claim on the caller's own project —
        // already listed under "mine", so here it would only duplicate it
        // under a role label that lies.
        if (!role || role === "owner") return null;
        const [summary, ownerProfile] = await Promise.all([
          pageSummary(ctx, project),
          ctx.db
            .query("profiles")
            .withIndex("by_owner", (q) => q.eq("ownerId", project.ownerId))
            .unique(),
        ]);
        return {
          _id: project._id,
          title: project.title,
          role,
          ownerName: ownerProfile?.name ?? ownerProfile?.email ?? null,
          ...summary,
        };
      }),
    );

    return rows
      .filter((r) => r !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const create = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    /** Freeform: whatever the user wants the agent to know going in. */
    context: v.optional(v.string()),
    /** Repositories chosen in the dialog, before there was a project to hang them on. */
    repos: v.optional(v.array(repoRef)),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireOwner(ctx);
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      ownerId,
      title: args.title,
      description: args.description,
      createdAt: now,
    });

    // What the user said when they made the project IS the project's context —
    // the sheet is what primes every LLM request, so anything that stopped at
    // the project row would never reach a model. Phrased as the Q&A the sheet
    // holds, the same way first run phrases the survey's answers.
    const asked: [string, string | undefined][] = [
      [ABOUT, args.description],
      [BACKGROUND, args.context],
    ];
    for (const [question, said] of asked) {
      const answer = said?.trim();
      if (!answer) continue;
      await ctx.db.insert("contextSheet", {
        ownerId,
        projectId,
        question,
        answer,
        source: "human",
        createdAt: now,
      });
    }

    // Repositories are context too, just the kind that is read rather than
    // written: each one is linked here and summarised by a scheduled action, so
    // the project opens with the fetch already under way.
    if (args.repos?.length) {
      await addRepos(ctx, ownerId, projectId, args.repos);
    }

    // Seed one page so a new project is immediately usable. Empty title so the
    // doc shows its placeholder; the sidebar renders an "Untitled" fallback.
    await ctx.db.insert("pages", {
      ownerId,
      projectId,
      title: "",
      order: 0,
      docId: crypto.randomUUID(),
      createdAt: now,
    });
    await refreshPageSummary(ctx, projectId);
    return projectId;
  },
});

/**
 * Everything the projects screen draws, except the thumbnail.
 *
 * The thumbnail is deliberately NOT built here. It needs the document, and the
 * document is not something this side can assemble: `getSnapshot` returns a
 * snapshot written on a debounce that is dropped whenever the server runs
 * ahead, so a page can sit indefinitely with edits that exist only as steps
 * (`chat/clientTools.ts` measured a live page at snapshot 743, document 752).
 * Replaying those steps needs `Step.fromJSON` against the BlockNote schema,
 * which is a browser bundle. Reading the snapshot alone is what made every
 * preview come back empty.
 *
 * So this hands out the first page's `docId` and the client reads the document
 * the same way the AI layer does.
 */
export const listForScreen = query({
  args: {},
  handler: async (ctx) => {
    const owner = await currentOwner(ctx);
    if (!owner) return [];
    const projects = (
      await ctx.db
        .query("projects")
        .withIndex("by_owner", (q) => q.eq("ownerId", owner))
        .collect()
    ).filter((p) => !isTrashed(p));

    const rows = await Promise.all(
      projects.map(async (p) => ({ ...p, ...(await pageSummary(ctx, p)) })),
    );

    // Most recently touched first. Sorted here rather than by an index because
    // the summary is maintained, not indexed.
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const rename = mutation({
  args: { projectId: v.id("projects"), title: v.string() },
  handler: async (ctx, args) => {
    await requireOwned(ctx, "projects", args.projectId);
    await ctx.db.patch(args.projectId, { title: args.title });
  },
});

/**
 * Deletes a project — softly, one stamp on the row. Every read resolves
 * through the project (`auth.ts`), so its pages, folders and conversations
 * all vanish with it and all come back with `trash.restore`. The purge cron
 * runs {@link purgeProject} once retention passes.
 */
export const remove = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireOwned(ctx, "projects", args.projectId);
    await ctx.db.patch(args.projectId, { deletedAt: Date.now() });
  },
});

/**
 * The hard cascade, now the purge's. The hierarchy is bounded (project → page
 * → its substrate rows) so this terminates, but it is a lot of rows: a very
 * large project could approach Convex's per-mutation write limit, at which
 * point this needs to become a paginated action.
 */
export async function purgeProject(ctx: MutationCtx, projectId: Id<"projects">) {
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();

    for (const page of pages) {
      for (const table of ["opLog", "checkpoints", "suggestionLog"] as const) {
        const rows = await ctx.db
          .query(table)
          .withIndex("by_page", (q) => q.eq("pageId", page._id))
          .collect();
        await Promise.all(rows.map((r) => ctx.db.delete(r._id)));
      }

      await ctx.db.delete(page._id);
    }

    for (const table of ["contextSheet", "projectRepos", "folders"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect();
      await Promise.all(rows.map((r) => ctx.db.delete(r._id)));
    }

    // The conversations about a project go with it. Turns in particular outlive
    // the pages they edited — they are what a reload reads to find changes still
    // awaiting an answer — so orphaned ones would accumulate for good.
    const threads = await ctx.db
      .query("chatThreads")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect();
    for (const thread of threads) {
      for (const table of ["chatMessages", "chatTurns"] as const) {
        const rows = await ctx.db
          .query(table)
          .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
          .collect();
        await Promise.all(rows.map((r) => ctx.db.delete(r._id)));
      }
      await ctx.db.delete(thread._id);
    }

    await ctx.db.delete(projectId);
}
