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
    /**
     * One finished conversation, so the chat panel is not empty on arrival.
     *
     * The guide asks the user to start a NEW chat, and "new" needs something to
     * be new next to — a panel holding one blank thread teaches nothing about
     * threads, while a panel holding a finished exchange says they are kept and
     * that they belong to the project without spending a sentence on it.
     */
    priorChat: v.object({
      title: v.string(),
      asked: v.string(),
      answered: v.string(),
    }),
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

    const threadId = await ctx.db.insert("chatThreads", {
      ownerId,
      projectId,
      title: args.priorChat.title,
      createdAt: now,
      updatedAt: now,
    });
    // `parts` is stored exactly as the AI SDK's UIMessage carries it, so a
    // seeded exchange re-renders through the same path a streamed one does and
    // `convertToModelMessages` can hand it back to the model unchanged.
    const said = [
      { role: "user" as const, text: args.priorChat.asked },
      { role: "assistant" as const, text: args.priorChat.answered },
    ];
    for (const [seq, turn] of said.entries()) {
      await ctx.db.insert("chatMessages", {
        ownerId,
        threadId,
        uiId: `seed-${projectId}-${seq}`,
        role: turn.role,
        seq,
        parts: [{ type: "text", text: turn.text }],
        createdAt: now + seq,
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
