import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { isTrashed, LINK_FIELDS } from "./auth";
import { upsertDocument } from "./context/documents";
import { pageNode } from "./context/pages";
import { documentId } from "./files/context";
import { raiseTo, TICKET } from "./counters";
import { forgetPagesIn, pagesInBlob } from "./pages";
import { PLAN_OVERRIDE } from "./plans";

/**
 * One-off backfills, run by hand with `npx convex run`. Internal: none of this
 * belongs to the app's API, and a migration reachable from the internet is a
 * migration someone can re-run.
 */

/** Rows per transaction. Small enough to stay well inside the write limit. */
const BATCH = 100;

/** How far ahead the dry run looks. Reading is cheap; guessing is not. */
const PREVIEW_CAP = 500;

/**
 * What {@link numberTickets} would do, without doing it. Convex has no dry-run
 * mode for mutations, so the preview is its own read-only function — the same
 * selection and the same ordering, reporting the numbers it would hand out.
 */
export const numberTicketsPreview = internalQuery({
  args: {},
  handler: async (ctx) => {
    const unnumbered = await ctx.db
      .query("feedback")
      .filter((q) => q.eq(q.field("number"), undefined))
      .take(PREVIEW_CAP);

    const counter = await ctx.db
      .query("counters")
      .withIndex("by_name", (q) => q.eq("name", TICKET))
      .unique();
    const start = counter?.value ?? 0;

    return {
      counterAt: start,
      toNumber: unnumbered.length,
      capped: unnumbered.length === PREVIEW_CAP,
      /** Oldest first — the order the numbers will actually be handed out in. */
      first: unnumbered.slice(0, 5).map((row, i) => ({
        willBe: `NT-${start + i + 1}`,
        createdAt: new Date(row.createdAt).toISOString(),
        kind: row.kind,
        text: row.text.slice(0, 60),
      })),
      last: unnumbered.slice(-5).map((row, i) => ({
        willBe: `NT-${start + unnumbered.length - Math.min(5, unnumbered.length) + i + 1}`,
        createdAt: new Date(row.createdAt).toISOString(),
        kind: row.kind,
        text: row.text.slice(0, 60),
      })),
    };
  },
});

/**
 * Gives every pre-numbering ticket its `NT-{n}`, oldest first, so the numbers
 * ascend with age the way new ones will.
 *
 * Idempotent: it selects only unnumbered rows, so a second run finds nothing.
 * The counter is raised to the highest number handed out, which is what stops
 * the next submit reusing one. Later batches re-scan the rows already numbered
 * — the cost of having no index for "field is absent", and not worth an index
 * that exists to be dropped.
 */
export const numberTickets = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ numbered: number; done: boolean }> => {
    const rows = await ctx.db
      .query("feedback")
      .filter((q) => q.eq(q.field("number"), undefined))
      .take(BATCH);
    if (rows.length === 0) return { numbered: 0, done: true };

    const counter = await ctx.db
      .query("counters")
      .withIndex("by_name", (q) => q.eq("name", TICKET))
      .unique();

    let n = counter?.value ?? 0;
    for (const row of rows) {
      n += 1;
      await ctx.db.patch(row._id, { number: n });
    }
    await raiseTo(ctx, TICKET, n);

    const done = rows.length < BATCH;
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.migrations.numberTickets, {});
    }
    return { numbered: rows.length, done };
  },
});

/**
 * Moves every sidebar level onto its unified order line: folders renumbered
 * 0..k-1 by their old order, that level's pages k..n-1 after them — exactly
 * the sequence the old "folders above pages" sort displayed, so nobody's tree
 * visibly moves. Idempotent: a second run recomputes the same numbers and
 * patches nothing.
 *
 * Run once when the interleaved-order code ships (either side of the deploy is
 * fine — the old sort reads these numbers identically). Until it has run, a
 * level whose folder and page orders overlap may briefly render interleaved.
 */
export const interleaveSidebarRows = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ projects: number; patched: number; done: boolean }> => {
    const batch = await ctx.db
      .query("projects")
      .paginate({ numItems: 25, cursor: args.cursor ?? null });

    let patched = 0;
    for (const project of batch.page) {
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();
      const pages = await ctx.db
        .query("pages")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();

      // Per level, in the by_project index's (order, creation) sequence the
      // collects already carry. Levels keyed by the raw parent link: a broken
      // link groups its orphans together, which preserves their relative order
      // wherever the tree chooses to surface them.
      const levels = new Set<string>([
        ...folders.map((f) => String(f.parentId ?? "")),
        ...pages.map((p) => String(p.folderId ?? "")),
      ]);
      for (const level of levels) {
        let n = 0;
        for (const f of folders.filter(
          (f) => String(f.parentId ?? "") === level,
        )) {
          if (f.order !== n) {
            await ctx.db.patch(f._id, { order: n });
            patched++;
          }
          n++;
        }
        for (const p of pages.filter(
          (p) => String(p.folderId ?? "") === level,
        )) {
          if (p.order !== n) {
            await ctx.db.patch(p._id, { order: n });
            patched++;
          }
          n++;
        }
      }
    }

    if (!batch.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.interleaveSidebarRows, {
        cursor: batch.continueCursor,
      });
    }
    return { projects: batch.page.length, patched, done: batch.isDone };
  },
});

/**
 * Marks every conversation that already exists as paid for.
 *
 * The chat meter charges a thread the first time it reaches the model, and
 * `billedAt` is what records that it has been charged. Threads written before
 * the paywall existed carry no stamp, so without this the first message
 * somebody sends in a conversation they have been having for weeks would spend
 * one of their ten free slots — charging them, retroactively, for something
 * that was free when they did it.
 *
 * Stamped with the thread's own `createdAt` rather than now, so the record says
 * when the conversation started rather than when this ran.
 *
 * Run ONCE, immediately before or after the paywall deploys; either side is
 * fine, since a thread stamped here and a thread stamped by `beginChat` are
 * indistinguishable afterwards. Idempotent — a second run finds nothing left
 * unstamped and patches nothing.
 */
export const grandfatherChatThreads = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ seen: number; stamped: number; done: boolean; cursor: string | null }> => {
    const batch = await ctx.db
      .query("chatThreads")
      .paginate({ numItems: BATCH, cursor: args.cursor ?? null });

    let stamped = 0;
    for (const thread of batch.page) {
      if (thread.billedAt !== undefined) continue;
      await ctx.db.patch(thread._id, { billedAt: thread.createdAt });
      stamped += 1;
    }

    return {
      seen: batch.page.length,
      stamped,
      done: batch.isDone,
      cursor: batch.isDone ? null : batch.continueCursor,
    };
  },
});

/**
 * Keeps the workspaces made before Team billing on the plan they had.
 *
 * Until billing, every workspace was unlimited; after it, one with no live
 * subscription is on the free allowance, so every tester's workspace would
 * lose chat and completions the moment it deploys. This grants each the
 * `plan: "team"` override instead — the one an operator grants a tester by
 * hand (`adminBilling.grantWorkspaceOverride`), and cleared the same way.
 *
 * Run once, right after the deploy. Idempotent: a workspace that already has
 * a plan override, or has been deleted, is left as it is.
 */
export const grandfatherWorkspaces = internalMutation({
  args: { note: v.string(), cursor: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ seen: number; granted: number; done: boolean; cursor: string | null }> => {
    const note = args.note.trim();
    if (!note) throw new Error("Say why these workspaces keep the Team plan.");
    const batch = await ctx.db
      .query("workspaces")
      .paginate({ numItems: BATCH, cursor: args.cursor ?? null });

    let granted = 0;
    for (const workspace of batch.page) {
      if (workspace.deletedAt !== undefined) continue;
      const existing = await ctx.db
        .query("workspaceEntitlements")
        .withIndex("by_workspace_and_feature", (q) =>
          q.eq("workspaceId", workspace._id).eq("feature", PLAN_OVERRIDE),
        )
        .unique();
      if (existing) continue;
      await ctx.db.insert("workspaceEntitlements", {
        workspaceId: workspace._id,
        feature: PLAN_OVERRIDE,
        value: "team",
        note,
        grantedBy: "convex run",
        grantedAt: Date.now(),
      });
      granted += 1;
    }

    return {
      seen: batch.page.length,
      granted,
      done: batch.isDone,
      cursor: batch.isDone ? null : batch.continueCursor,
    };
  },
});

/**
 * Chat turns per transaction. Capped in bytes as well as rows: a packed turn
 * can approach the 1MiB value ceiling, so a count alone would not keep a batch
 * inside the read limit.
 */
const TURN_BATCH = { numItems: 25, maximumBytesRead: 4 * 1024 * 1024 };

/**
 * The pages a chat turn names that no longer exist, wherever it names them: the
 * id lists, and the entries inside `trace` and `hunks`. A page in the trash
 * still exists, and is left to the purge.
 */
async function deletedPagesOf(ctx: QueryCtx, turn: Doc<"chatTurns">): Promise<Set<string>> {
  const named = new Set<string>([
    ...turn.pageIds,
    ...pagesInBlob(turn.trace),
    ...pagesInBlob(turn.hunks),
  ]);
  const gone = new Set<string>();
  for (const raw of named) {
    const id = ctx.db.normalizeId("pages", raw);
    if (!id || !(await ctx.db.get(id))) gone.add(raw);
  }
  return gone;
}

/**
 * What {@link forgetDeletedTurnPages} would change, one batch of turns at a
 * time: every turn naming a page that is gone, and whether the turn goes too.
 */
export const forgetDeletedTurnPagesPreview = internalQuery({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const batch = await ctx.db
      .query("chatTurns")
      .paginate({ ...TURN_BATCH, cursor: args.cursor ?? null });

    const affected: Array<{
      chatPromptId: string;
      status: Doc<"chatTurns">["status"];
      createdAt: string;
      pages: number;
      gone: number;
      deletesTurn: boolean;
    }> = [];
    for (const turn of batch.page) {
      const gone = await deletedPagesOf(ctx, turn);
      if (!gone.size) continue;
      affected.push({
        chatPromptId: turn.chatPromptId,
        status: turn.status,
        createdAt: new Date(turn.createdAt).toISOString(),
        pages: turn.pageIds.length,
        gone: gone.size,
        deletesTurn: turn.pageIds.every((id) => gone.has(id)),
      });
    }

    return {
      seen: batch.page.length,
      affected,
      done: batch.isDone,
      cursor: batch.isDone ? null : batch.continueCursor,
    };
  },
});

/**
 * Takes pages that no longer exist out of the chat turns still naming them.
 *
 * The purge once left a purged page inside a multi-page turn's packed `trace`
 * and `hunks`, and answering that turn wrote the page's ids back into its id
 * lists. Either way a reload offered a change on a page nobody could open, and
 * answering it failed the turn. Each turn is cleaned the way the purge now
 * cleans one ({@link forgetPagesIn}); a turn left with no page is deleted.
 *
 * Run again with the returned cursor until `done`. Idempotent: a second pass
 * finds nothing gone and writes nothing.
 */
export const forgetDeletedTurnPages = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ seen: number; patched: number; deleted: number; done: boolean; cursor: string | null }> => {
    const batch = await ctx.db
      .query("chatTurns")
      .paginate({ ...TURN_BATCH, cursor: args.cursor ?? null });

    let patched = 0;
    let deleted = 0;
    for (const turn of batch.page) {
      const gone = await deletedPagesOf(ctx, turn);
      if (!gone.size) continue;
      const result = await forgetPagesIn(ctx, turn, gone);
      if (result === "patched") patched += 1;
      else if (result === "deleted") deleted += 1;
    }

    return {
      seen: batch.page.length,
      patched,
      deleted,
      done: batch.isDone,
      cursor: batch.isDone ? null : batch.continueCursor,
    };
  },
});

/**
 * Stamps `pages.yjs` on every page whose document already has a `ydocs` row.
 *
 * The flag was only ever written by `ydoc.append`, so a page nobody has edited
 * since it migrated never got one — measured at 38% of production's Yjs pages.
 * The flag is what lets the editor start loading a document in the same round
 * trip as `meta` instead of the one after it (`Editor`'s `yjs` prop), and what
 * lets `ydoc.state` answer without the `ydocs` lookup, so the pages it is
 * missing from are exactly the ones opened to be read. `ydoc.init` stamps it
 * at birth now; this is for the documents born before that.
 *
 * Run again with the returned cursor until `done`. Idempotent.
 */
export const stampYjsPages = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (
    ctx,
    args,
  ): Promise<{ seen: number; stamped: number; done: boolean; cursor: string | null }> => {
    const batch = await ctx.db
      .query("ydocs")
      .paginate({ numItems: BATCH, cursor: args.cursor ?? null });
    let stamped = 0;
    for (const ydoc of batch.page) {
      const page = await ctx.db
        .query("pages")
        .withIndex("by_doc", (q) => q.eq("docId", ydoc.docId))
        .unique();
      if (!page || page.yjs) continue;
      await ctx.db.patch(page._id, { yjs: true });
      stamped++;
    }
    return {
      seen: batch.page.length,
      stamped,
      done: batch.isDone,
      cursor: batch.isDone ? null : batch.continueCursor,
    };
  },
});

/**
 * Gives every live page a node in its project's context graph, so
 * `search_context` finds pages by title before anyone has opened them since
 * the graph shipped. Titles only: a page's words arrive with its first digest,
 * which the browser writes the next time the page is opened or edited.
 * Idempotent — a page that already has a node is left alone.
 */
export const contextPageNodes = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ pages: number; done: boolean }> => {
    const batch = await ctx.db
      .query("pages")
      .paginate({ numItems: BATCH, cursor: args.cursor ?? null });
    for (const page of batch.page) {
      if (!isTrashed(page)) await pageNode(ctx, page);
    }
    if (!batch.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.contextPageNodes, {
        cursor: batch.continueCursor,
      });
    }
    return { pages: batch.page.length, done: batch.isDone };
  },
});

/**
 * Reads every uploaded file that already has its text into the context graph
 * as a document — files uploaded before the graph read them. Idempotent: a
 * file already there is written again with the same text.
 */
export const contextFileNodes = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ files: number; done: boolean }> => {
    const batch = await ctx.db
      .query("projectFiles")
      .paginate({ numItems: 25, cursor: args.cursor ?? null });
    for (const file of batch.page) {
      if (!file.text) continue;
      await upsertDocument(ctx, {
        projectId: file.projectId,
        source: "files",
        externalId: documentId(file._id),
        title: file.filename,
        memberId: file.ownerId,
        text: file.text,
      });
    }
    if (!batch.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.contextFileNodes, {
        cursor: batch.continueCursor,
      });
    }
    return { files: batch.page.length, done: batch.isDone };
  },
});

/**
 * Stamps `code` on every context text row written before the field, from its
 * node's source. Until it has run, search leaves those rows out for a reader
 * who may not see code — pages included — so run it with the deploy that adds
 * the field. Idempotent: a stamped row is left alone.
 */
export const markContextCode = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ stamped: number; done: boolean }> => {
    const batch = await ctx.db
      .query("contextNodeText")
      .paginate({ numItems: BATCH, cursor: args.cursor ?? null });
    let stamped = 0;
    for (const row of batch.page) {
      if (row.code !== undefined) continue;
      const node = await ctx.db.get(row.nodeId);
      if (!node) continue;
      await ctx.db.patch(row._id, { code: node.source === "github" });
      stamped++;
    }
    if (!batch.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.markContextCode, {
        cursor: batch.continueCursor,
      });
    }
    return { stamped, done: batch.isDone };
  },
});

/**
 * Schedules `share.lapse` for every link expiry, and every claim's, still to
 * come when the job arrived — `setLink` schedules one only for the expiries it
 * sets from then on. Run once, right after the deploy that adds it.
 * Idempotent: a second run schedules the same stamps again, and a lapse whose
 * moment is already stamped does nothing.
 */
export const armLinkLapses = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ armed: number; done: boolean }> => {
    const now = Date.now();
    const batch = await ctx.db
      .query("projects")
      .paginate({ numItems: BATCH, cursor: args.cursor ?? null });
    let armed = 0;
    for (const project of batch.page) {
      const claims = await ctx.db
        .query("shareClaims")
        .withIndex("by_project_and_grantee", (q) => q.eq("projectId", project._id))
        .collect();
      const moments = new Set([
        ...Object.values(LINK_FIELDS).map(({ expiresAt }) => project[expiresAt]),
        ...claims.map((claim) => claim.expiresAt),
      ]);
      for (const at of moments) {
        if (at === undefined || at <= now) continue;
        await ctx.scheduler.runAt(at, internal.share.lapse, { projectId: project._id, at });
        armed++;
      }
    }
    if (!batch.isDone) {
      await ctx.scheduler.runAfter(0, internal.migrations.armLinkLapses, {
        cursor: batch.continueCursor,
      });
    }
    return { armed, done: batch.isDone };
  },
});
