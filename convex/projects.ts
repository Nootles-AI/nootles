import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { ownerId as currentOwner, readOwned, requireOwned, requireOwner } from "./auth";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const owner = await currentOwner(ctx);
    if (!owner) return [];
    return await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerId", owner))
      .order("desc")
      .collect();
  },
});

export const get = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => await readOwned(ctx, "projects", args.projectId),
});

export const create = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    /** Freeform: whatever the user wants the agent to know going in. */
    context: v.optional(v.string()),
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
      ["What is this project?", args.description],
      ["What should be known before working on it?", args.context],
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
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerId", owner))
      .collect();

    const rows = await Promise.all(
      projects.map(async (p) => {
        // Ordered by the index, so the first row is the page the sidebar shows
        // at the top — the one a thumbnail of "this project" should be of.
        const pages = await ctx.db
          .query("pages")
          .withIndex("by_project", (q) => q.eq("projectId", p._id))
          .collect();

        return {
          ...p,
          pageCount: pages.length,
          firstPageDocId: pages[0]?.docId ?? null,
          updatedAt: pages.reduce(
            (m, pg) => Math.max(m, pg.updatedAt ?? pg.createdAt),
            p.createdAt,
          ),
        };
      }),
    );

    // Most recently touched first. Sorted here rather than by an index because
    // `updatedAt` is derived from the pages, not stored on the project.
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
 * Deletes a project and everything hanging off it. The hierarchy is bounded
 * (project → page → canvas → shape/edge) so this terminates, but it is a lot of
 * rows: a very large project could approach Convex's per-mutation write limit,
 * at which point this needs to become a paginated action.
 *
 * Irreversible — the UI asks for confirmation before calling it.
 */
export const remove = mutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireOwned(ctx, "projects", args.projectId);
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    for (const page of pages) {
      const canvases = await ctx.db
        .query("canvases")
        .withIndex("by_page", (q) => q.eq("pageId", page._id))
        .collect();
      for (const canvas of canvases) {
        for (const table of ["shapes", "edges"] as const) {
          const rows = await ctx.db
            .query(table)
            .withIndex("by_canvas", (q) => q.eq("canvasId", canvas._id))
            .collect();
          await Promise.all(rows.map((r) => ctx.db.delete(r._id)));
        }
        await ctx.db.delete(canvas._id);
      }

      for (const table of ["opLog", "checkpoints", "suggestionLog"] as const) {
        const rows = await ctx.db
          .query(table)
          .withIndex("by_page", (q) => q.eq("pageId", page._id))
          .collect();
        await Promise.all(rows.map((r) => ctx.db.delete(r._id)));
      }

      await ctx.db.delete(page._id);
    }

    const sheet = await ctx.db
      .query("contextSheet")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
    await Promise.all(sheet.map((r) => ctx.db.delete(r._id)));

    // The conversations about a project go with it. Turns in particular outlive
    // the pages they edited — they are what a reload reads to find changes still
    // awaiting an answer — so orphaned ones would accumulate for good.
    const threads = await ctx.db
      .query("chatThreads")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
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

    await ctx.db.delete(args.projectId);
  },
});
