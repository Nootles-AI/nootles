import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireOwner } from "./auth";
import { seedDoc } from "./prosemirror";

const mode = v.union(v.literal("create"), v.literal("complete"));

/**
 * The whole of first run's write, in one call.
 *
 * A project seeded from a template is several rows that only make sense
 * together — the project, its pages, the documents inside them, the Context
 * Sheet the survey answers become, and the profile row that stops the welcome
 * screen appearing again. Splitting them across calls would leave a failure
 * halfway through showing someone a half-built project on their first visit,
 * which is the one impression worth protecting.
 *
 * `doc` is ProseMirror JSON assembled on the client; see `seedDoc`.
 */
export const createSeededProject = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    template: v.string(),
    role: v.optional(v.string()),
    useCase: v.optional(v.string()),
    defaultMode: mode,
    pages: v.array(v.object({ title: v.string(), doc: v.any() })),
    /** Survey answers, already phrased as the Q&A the sheet holds. */
    context: v.array(v.object({ question: v.string(), answer: v.string() })),
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

    for (const [order, page] of args.pages.entries()) {
      const docId = crypto.randomUUID();
      await ctx.db.insert("pages", {
        ownerId,
        projectId,
        title: page.title,
        mode: args.defaultMode,
        order,
        docId,
        createdAt: now,
        updatedAt: now,
      });
      await seedDoc(ctx, docId, page.doc);
    }

    for (const entry of args.context) {
      await ctx.db.insert("contextSheet", {
        ownerId,
        projectId,
        question: entry.question,
        answer: entry.answer,
        // The user answered these, even though a form asked rather than a model.
        source: "human",
        createdAt: now,
      });
    }

    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
    const profile = {
      role: args.role,
      useCase: args.useCase,
      defaultMode: args.defaultMode,
      tour: { projectId, template: args.template, beat: 0, done: [] },
      status: "touring" as const,
    };
    if (existing) await ctx.db.patch(existing._id, profile);
    else await ctx.db.insert("profiles", { ownerId, ...profile, createdAt: now });

    return projectId;
  },
});
