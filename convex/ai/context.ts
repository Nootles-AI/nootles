import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { projectRole, readOwned, requireEditable, requireOwned } from "../auth";
import { FILE_HEAD } from "../files/shared";

/**
 * The per-project Context Sheet — an evolving list of Q&A that primes every LLM
 * request. Entries are human-added or AI-generated; answers can be filled in
 * later (a model may ask, then answer once it learns).
 */

const source = v.union(v.literal("human"), v.literal("ai"));

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    if (!(await readOwned(ctx, "projects", args.projectId))) return [];
    return await ctx.db
      .query("contextSheet")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

/**
 * The project as the agent should be told about it, in one round trip: the chat
 * route reads this before every turn, so a query per row would be latency on the
 * path to the first token. Editors' agents read it too — the sheet is what any
 * agent on this project is primed with.
 */
export const forPrompt = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const role = await projectRole(ctx, args.projectId);
    if (role !== "owner" && role !== "editor") return null;
    const project = await ctx.db.get(args.projectId);
    if (!project) return null;
    const [entries, repos, files] = await Promise.all([
      ctx.db
        .query("contextSheet")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .collect(),
      ctx.db
        .query("projectRepos")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .collect(),
      ctx.db
        .query("projectFiles")
        .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
        .collect(),
    ]);
    return {
      title: project.title,
      entries: entries.map((e) => ({ question: e.question, answer: e.answer })),
      // A repo whose summary has not landed yet is still worth naming: the tools
      // work the moment it is linked, and the summary only decides how much the
      // agent knows before it uses them.
      repos: repos.map((r) => ({
        fullName: r.fullName,
        defaultBranch: r.defaultBranch,
        summary: r.summary,
      })),
      // Same shape as a repo's summary: the head of each file, enough to know
      // it is worth opening with read_context_file and never a substitute.
      files: files.map((f) => ({
        filename: f.filename,
        head: f.text?.slice(0, FILE_HEAD),
      })),
    };
  },
});

export const add = mutation({
  args: {
    projectId: v.id("projects"),
    question: v.string(),
    answer: v.optional(v.string()),
    source,
  },
  handler: async (ctx, args) => {
    // Inherited ownership, like pages: the sheet is the project's, so entries
    // an editor's agent adds still answer to the owner in the context dialog.
    const { ownerId } = await requireEditable(ctx, "projects", args.projectId);
    return await ctx.db.insert("contextSheet", {
      ownerId,
      projectId: args.projectId,
      question: args.question,
      answer: args.answer,
      source: args.source,
      createdAt: Date.now(),
    });
  },
});

export const answer = mutation({
  args: { id: v.id("contextSheet"), answer: v.string() },
  handler: async (ctx, args) => {
    await requireOwned(ctx, "contextSheet", args.id);
    await ctx.db.patch(args.id, { answer: args.answer });
  },
});

export const remove = mutation({
  args: { id: v.id("contextSheet") },
  handler: async (ctx, args) => {
    await requireOwned(ctx, "contextSheet", args.id);
    await ctx.db.delete(args.id);
  },
});
