import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { refreshPageSummary } from "./projects";

/**
 * The KR-1 demo project, written into one named account.
 *
 * An `internalMutation`, so it is reachable only from the CLI or another Convex
 * function — never from a browser, and never by a signed-in stranger. The owner
 * is an argument rather than the caller's identity because there is no caller:
 * this runs from a terminal against a deployment.
 *
 * Which makes `ownerId` the dangerous part, and the reason this returns the
 * owner it wrote to and how many projects that account already had: a mistyped
 * Clerk subject would otherwise quietly seed a project into some other person's
 * sidebar, and nothing would say so.
 *
 * Pages arrive with their documents already built — each `update` is the Yjs
 * update its document is born from, made where the editor's schema lives (see
 * `app/lib/demo/buildSeed.test.ts`). Seeded pages join the pipeline every other
 * document is on, so the first open is not a migration.
 */
export const seedKestrel = internalMutation({
  args: {
    ownerId: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    pages: v.array(v.object({ title: v.string(), update: v.bytes() })),
    context: v.array(v.object({ question: v.string(), answer: v.string() })),
    /**
     * Move any existing project of this name to trash first, rather than
     * refusing. Without it a second seed is refused outright, because a demo
     * account holding two identical sidebar entries is worse than one that is
     * out of date.
     */
    replace: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const mine = await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .collect();

    const now = Date.now();
    const already = mine.filter((p) => p.title === args.title && !p.deletedAt);
    if (already.length && !args.replace) {
      throw new Error(
        `${args.ownerId} already has ${already.length} project(s) called "${args.title}". ` +
          "Pass replace: true to move the old one to trash and seed a fresh copy.",
      );
    }

    // `replace` has to mean replace. Seeding a second project with the same
    // title leaves the demo account with two identical sidebars entries and no
    // way to tell which one is current — and whoever runs this may not have
    // access to the account to tidy up afterwards.
    //
    // Trashed the way the app trashes, not deleted: `projects:remove` sets
    // `deletedAt` and every read filters on it, so a mistaken re-seed is
    // recoverable from the user's own trash rather than gone.
    const trashed: string[] = [];
    for (const old of already) {
      await ctx.db.patch(old._id, { deletedAt: now });
      trashed.push(old._id);
    }

    const projectId = await ctx.db.insert("projects", {
      ownerId: args.ownerId,
      title: args.title,
      description: args.description,
      createdAt: now,
    });

    const pages: { pageId: string; title: string }[] = [];
    for (const [order, page] of args.pages.entries()) {
      const docId = crypto.randomUUID();
      const pageId = await ctx.db.insert("pages", {
        ownerId: args.ownerId,
        projectId,
        title: page.title,
        order,
        docId,
        yjs: true,
        createdAt: now,
        updatedAt: now,
      });
      // The two rows `ydoc.init` would write, written directly.
      //
      // `init` is a public mutation and guards itself with `checkWrite`, which
      // resolves the CALLER's role on the project. There is no caller here —
      // this runs from a terminal — so that check refuses every document. An
      // internal mutation is already trusted, and the owner is the explicit
      // argument above rather than something inferred from an identity.
      await ctx.db.insert("ydocs", {
        docId,
        seq: 1,
        snapshotSeq: 0,
        snapshotParts: 0,
        updatedAt: now,
      });
      await ctx.db.insert("yUpdates", { docId, seq: 1, update: page.update });
      pages.push({ pageId, title: page.title });
    }
    await refreshPageSummary(ctx, projectId);

    for (const entry of args.context) {
      await ctx.db.insert("contextSheet", {
        ownerId: args.ownerId,
        projectId,
        question: entry.question,
        answer: entry.answer,
        source: "human",
        createdAt: now,
      });
    }

    // Returned so the terminal that ran this can read back WHOSE sidebar it
    // landed in, and how many projects that account had before.
    return {
      projectId,
      ownerId: args.ownerId,
      pages,
      trashed,
      projectsThisOwnerHadBefore: mine.length,
    };
  },
});
