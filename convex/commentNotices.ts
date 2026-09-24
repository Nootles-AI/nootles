import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  channelAdmits,
  commentsProject,
  isTrashed,
  ownerId,
  readableComments,
  requireCommentable,
  requireOwner,
  roleForProject,
  standInActor,
} from "./auth";
import { isAuditId, recordAudit } from "./audit";
import { storedThreads } from "./comments";
import { memberRole, mentionablePeople } from "./container";
import { MAX_SIGNERS } from "@/app/lib/comments/types";

/**
 * Who is told about a comment, and the record that it happened
 * (docs/commenting-plan.md §9–§10).
 *
 * The thread itself lives in the page's comments document, written by the
 * client straight into the Yjs log by anyone who may comment, so nothing in
 * it — an `authorId` included — is proof of who did what. What the client
 * says here is therefore only ever a request: the actor is the authenticated
 * caller, and every person named is checked against the project's own
 * membership before a row is written for them. The one claim checked against
 * the document itself is a deletion, which would otherwise let anyone clear
 * everybody's news of a thread that is still there.
 */

/** Most people one event may name — a thread is a conversation, not a list. */
export const MAX_PEOPLE = 50;

const kind = v.union(
  v.literal("create"),
  v.literal("reply"),
  v.literal("resolve"),
  v.literal("reopen"),
  v.literal("delete"),
);

type NoticeKind = Doc<"commentNotices">["kind"];

/**
 * A mention of someone who cannot open the project. It carries the ids, not
 * names: the composer knows what it called each person, and the server
 * reading a stranger's profile back to whoever typed their id would hand out
 * names by guesswork.
 */
export type OutsiderRefusal = { code: "outsider"; userIds: string[]; message: string };

function outsiderRefusal(userIds: string[]): ConvexError<OutsiderRefusal> {
  return new ConvexError({
    code: "outsider",
    userIds,
    message:
      userIds.length === 1
        ? "The person you mentioned can't open this project, so they wouldn't see it."
        : `${userIds.length} of the people you mentioned can't open this project, so they wouldn't see it.`,
  });
}

/** True when `e` is this module's outsider refusal — the composer's narrowing hook. */
export function isOutsiderRefusal(e: unknown): e is ConvexError<OutsiderRefusal> {
  return (
    e instanceof ConvexError &&
    typeof e.data === "object" &&
    e.data !== null &&
    (e.data as { code?: unknown }).code === "outsider"
  );
}

/** Id-shaped and deduplicated, or refused: these become rows and audit ids. */
function people(list: string[], what: string): string[] {
  if (list.length > MAX_PEOPLE) {
    throw new ConvexError(`A comment can name at most ${MAX_PEOPLE} ${what}.`);
  }
  for (const id of list) {
    if (!isAuditId(id)) throw new ConvexError(`That is not a person to notify.`);
  }
  return [...new Set(list)];
}

/**
 * One unseen notice per person, thread and kind. A second reply while the
 * first is still unread replaces it — newer actor, newer time — so a busy
 * thread is one line in someone's inbox, not a pile of them. Replaced rather
 * than patched: the inbox reads newest first by creation, and a thread that
 * keeps talking must keep its place at the top.
 */
async function notify(
  ctx: MutationCtx,
  notice: Omit<Doc<"commentNotices">, "_id" | "_creationTime" | "seenAt">,
): Promise<void> {
  const unseen = await ctx.db
    .query("commentNotices")
    .withIndex("by_recipient_thread_unseen", (q) =>
      q
        .eq("recipientId", notice.recipientId)
        .eq("threadId", notice.threadId)
        .eq("seenAt", undefined),
    )
    .collect();
  const same = unseen.find((n) => n.pageId === notice.pageId && n.kind === notice.kind);
  if (same) await ctx.db.delete(same._id);
  await ctx.db.insert("commentNotices", notice);
}

/** A deleted thread has nothing left to open, so nobody is still told of it. */
async function forgetThread(ctx: MutationCtx, pageId: Id<"pages">, threadId: string): Promise<void> {
  const told = await ctx.db
    .query("commentNotices")
    .withIndex("by_page", (q) => q.eq("pageId", pageId).eq("threadId", threadId).eq("seenAt", undefined))
    .collect();
  for (const notice of told) await ctx.db.delete(notice._id);
}

/**
 * Whether the comments document no longer holds what a `delete` names — the
 * thread, or one comment of it. An unreadable document proves nothing, so it
 * counts as still there.
 */
async function deleted(
  ctx: QueryCtx,
  page: Doc<"pages">,
  threadId: string,
  commentId: string | undefined,
): Promise<boolean> {
  const threads = await storedThreads(ctx, page);
  if (!threads) return false;
  const thread = threads.find((t) => t.id === threadId);
  return !thread || (commentId !== undefined && !thread.comments.some((c) => c.id === commentId));
}

/**
 * How long a deletion the document does not show yet is given to arrive. The
 * client tells the server after its own write, but that write reaches the log
 * on the provider's flush, which may trail the notice by a throttle or a retry.
 */
export const DELETE_RECHECK_MS = 10_000;

type Deletion = {
  pageId: Id<"pages">;
  projectId: Id<"projects">;
  threadId: string;
  commentId?: string;
  actorId: string;
};

/** A deletion the document shows: its notices go, and it is recorded. */
async function recordDeletion(ctx: MutationCtx, deletion: Deletion): Promise<void> {
  const { pageId, projectId, threadId, commentId, actorId } = deletion;
  if (commentId === undefined) await forgetThread(ctx, pageId, threadId);
  await recordAudit(ctx, {
    projectId,
    actorId,
    actorKind: "user",
    action: "comment.delete",
    subjectKind: "commentThread",
    subjectId: threadId,
    meta: {
      ids: { pageId, ...(commentId !== undefined ? { commentId } : {}) },
      counts: { mentions: 0, notified: 0 },
    },
  });
}

/** The second and last look at a deletion that had not reached the document yet. */
export const confirmDeletion = internalMutation({
  args: {
    pageId: v.id("pages"),
    projectId: v.id("projects"),
    threadId: v.string(),
    commentId: v.optional(v.string()),
    actorId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db.get(args.pageId);
    if (page && page.projectId === args.projectId && (await deleted(ctx, page, args.threadId, args.commentId))) {
      await recordDeletion(ctx, args);
    }
    return null;
  },
});

/**
 * Something happened to a thread; say so to whom it concerns, and record it.
 *
 * Called by the client after its write to the comments document has been
 * made. `mentions` are the people @-named in the comment just written, and
 * may only accompany a new comment (`create`, `reply`). `participants` are
 * the thread's authors as the client read them; since those ids are not
 * authenticated, a participant who cannot open the project is skipped
 * silently — it is the client's claim, not the caller's intent — whereas
 * mentioning such a person is refused outright, because the caller meant to
 * reach somebody the notice would never reach. A client that lies about
 * participants reaches no one it could not reach by mentioning them, and
 * repeating itself refreshes one card rather than adding more.
 *
 * `delete` names a comment (`commentId`) or, without one, the whole thread,
 * and is believed only once the comments document shows it: until then no
 * notice is cleared and nothing is recorded, and one later look is scheduled
 * for a write still on its way. It names nobody, so it tells nobody.
 */
export const event = mutation({
  args: {
    pageId: v.id("pages"),
    threadId: v.string(),
    kind,
    commentId: v.optional(v.string()),
    mentions: v.array(v.string()),
    participants: v.optional(v.array(v.string())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { page, project } = await requireCommentable(ctx, args.pageId);
    const actor = (await ownerId(ctx))!;
    if (!isAuditId(args.threadId)) throw new ConvexError("That is not a thread.");
    if (args.commentId !== undefined && !isAuditId(args.commentId)) {
      throw new ConvexError("That is not a comment.");
    }
    const writes = args.kind === "create" || args.kind === "reply";
    if (!writes && args.mentions.length) {
      throw new ConvexError("Only a new comment can mention someone.");
    }

    if (args.kind === "delete") {
      const deletion: Deletion = {
        pageId: page._id,
        projectId: project._id,
        threadId: args.threadId,
        ...(args.commentId !== undefined ? { commentId: args.commentId } : {}),
        actorId: actor,
      };
      if (await deleted(ctx, page, args.threadId, args.commentId)) await recordDeletion(ctx, deletion);
      else await ctx.scheduler.runAfter(DELETE_RECHECK_MS, internal.commentNotices.confirmDeletion, deletion);
      return null;
    }

    const mentions = people(args.mentions, "people");
    const participants = people(args.participants ?? [], "participants");
    const named = [...new Set([...mentions, ...participants])];
    const roles = await Promise.all(named.map((id) => memberRole(ctx, project, id)));
    const members = new Set(named.filter((_, i) => roles[i] !== null));

    const outsiders = mentions.filter((id) => !members.has(id));
    if (outsiders.length) throw outsiderRefusal(outsiders);

    const recipients = new Map<string, NoticeKind>();
    for (const id of mentions) recipients.set(id, "mention");
    const followUp: NoticeKind | null =
      args.kind === "reply" ? "reply" : args.kind === "resolve" ? "resolved" : null;
    if (followUp) {
      for (const id of participants) {
        if (members.has(id) && !recipients.has(id)) recipients.set(id, followUp);
      }
    }
    recipients.delete(actor);

    const createdAt = Date.now();
    for (const [recipientId, noticeKind] of recipients) {
      await notify(ctx, {
        recipientId,
        projectId: project._id,
        pageId: page._id,
        threadId: args.threadId,
        actorId: actor,
        kind: noticeKind,
        createdAt,
      });
    }

    await recordAudit(ctx, {
      projectId: project._id,
      actorId: actor,
      actorKind: "user",
      action: `comment.${args.kind}`,
      subjectKind: "commentThread",
      subjectId: args.threadId,
      meta: {
        ids: {
          pageId: page._id,
          ...(args.commentId !== undefined ? { commentId: args.commentId } : {}),
        },
        counts: { mentions: mentions.length, notified: recipients.size },
      },
    });
    return null;
  },
});

const person = v.object({
  userId: v.string(),
  name: v.union(v.string(), v.null()),
  imageUrl: v.union(v.string(), v.null()),
});

/**
 * The people an @ in a comment on this page may name — everyone who can open
 * the project except the caller, as a name and a face (never an email). The
 * roster goes to whoever may comment, as Docs' mention menu does: naming
 * someone is what a commenter is for. It stays closed to viewers, strangers,
 * signed-out visitors and an operator standing in, who get nobody.
 */
export const mentionable = query({
  args: { pageId: v.id("pages") },
  returns: v.array(person),
  handler: async (ctx, args) => {
    if (await standInActor(ctx)) return [];
    const found = await readableComments(ctx, args.pageId);
    if (!found || !channelAdmits({ channel: "comments", access: "write", role: found.role, linkLive: false })) {
      return [];
    }
    const me = await ownerId(ctx);
    return (await mentionablePeople(ctx, found.project))
      .filter((person) => person.userId !== me)
      .map(({ userId, name, imageUrl }) => ({ userId, name, imageUrl }));
  },
});

/**
 * The names the page's comments are signed with, for the people the caller
 * names — the authors their copy of the comments document shows. Answered to
 * every reader of the comments, a viewer too: whoever may read a comment may
 * see who wrote it. But only for someone who can open the project now, so an
 * id typed in is not a way to list the project's people, nor to look up a
 * stranger's name; an author who has since lost access is named no further.
 */
export const authors = query({
  args: { pageId: v.id("pages"), userIds: v.array(v.string()) },
  returns: v.array(person),
  handler: async (ctx, args) => {
    const found = await readableComments(ctx, args.pageId);
    if (!found) return [];
    const asked = new Set(args.userIds.slice(0, MAX_SIGNERS));
    const ids = [...asked];
    const roles = await Promise.all(ids.map((id) => memberRole(ctx, found.project, id)));
    const members = ids.filter((_, i) => roles[i] !== null);
    return await Promise.all(
      members.map(async (userId) => {
        const profile = await ctx.db
          .query("profiles")
          .withIndex("by_owner", (q) => q.eq("ownerId", userId))
          .unique();
        return { userId, name: profile?.name ?? null, imageUrl: profile?.imageUrl ?? null };
      }),
    );
  },
});

/** Newest first, and no more than an inbox can show. */
const INBOX_LIMIT = 100;
/**
 * Most unseen notices one read walks. A notice can outlive its door (below),
 * and the walk skips those, so it is bounded on what it reads rather than on
 * what it keeps.
 */
const SCAN_LIMIT = 500;

/**
 * Where an unseen notice leads: the page and project it opens; `closed` while
 * it opens nothing but may again (the project unshared, trashed or with
 * comments off, the page trashed — each undone by a re-share or a restore);
 * `gone` once nothing can bring it back (the page deleted or moved away).
 */
type Door = { project: Doc<"projects">; page: Doc<"pages"> } | "closed" | "gone";

/** The caller's unseen notices, newest first, each with where it leads. */
async function* unseenNotices(
  ctx: QueryCtx,
  me: string,
): AsyncGenerator<{ notice: Doc<"commentNotices">; door: Door }> {
  const open = new Map<Id<"projects">, Doc<"projects"> | null>();
  let scanned = 0;
  for await (const notice of ctx.db
    .query("commentNotices")
    .withIndex("by_recipient_unseen", (q) => q.eq("recipientId", me).eq("seenAt", undefined))
    .order("desc")) {
    if (++scanned > SCAN_LIMIT) return;
    const page = await ctx.db.get(notice.pageId);
    if (!page || page.projectId !== notice.projectId) {
      yield { notice, door: "gone" };
      continue;
    }
    if (isTrashed(page)) {
      yield { notice, door: "closed" };
      continue;
    }
    if (!open.has(page.projectId)) {
      const project = await commentsProject(ctx, page);
      open.set(page.projectId, project && (await roleForProject(ctx, project)) ? project : null);
    }
    const project = open.get(page.projectId)!;
    yield { notice, door: project ? { project, page } : "closed" };
  }
}

/**
 * What the caller has not yet been told, across every project — the query is
 * keyed on them, so the notice reaches them wherever they are standing. A
 * notice that no longer opens anything drops out rather than offering a door
 * that no longer opens.
 */
export const inbox = query({
  args: {},
  returns: v.array(
    v.object({
      noticeId: v.id("commentNotices"),
      kind: v.union(v.literal("mention"), v.literal("reply"), v.literal("resolved")),
      projectId: v.id("projects"),
      projectTitle: v.string(),
      pageId: v.id("pages"),
      pageTitle: v.string(),
      threadId: v.string(),
      actorName: v.union(v.string(), v.null()),
      actorImageUrl: v.union(v.string(), v.null()),
      createdAt: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const me = await ownerId(ctx);
    if (!me) return [];
    const rows = [];
    for await (const { notice, door } of unseenNotices(ctx, me)) {
      if (typeof door === "string") continue;
      const actor = await ctx.db
        .query("profiles")
        .withIndex("by_owner", (q) => q.eq("ownerId", notice.actorId))
        .unique();
      rows.push({
        noticeId: notice._id,
        kind: notice.kind,
        projectId: door.project._id,
        projectTitle: door.project.title,
        pageId: door.page._id,
        pageTitle: door.page.title,
        threadId: notice.threadId,
        actorName: actor?.name ?? null,
        actorImageUrl: actor?.imageUrl ?? null,
        createdAt: notice.createdAt,
      });
      if (rows.length >= INBOX_LIMIT) break;
    }
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  },
});

/** Most notices one call may mark — an inbox's worth. */
const MARK_LIMIT = 200;

async function markOwn(
  ctx: MutationCtx,
  me: string,
  notices: (Doc<"commentNotices"> | null)[],
): Promise<void> {
  const now = Date.now();
  for (const notice of notices) {
    if (notice?.recipientId === me && notice.seenAt === undefined) {
      await ctx.db.patch(notice._id, { seenAt: now });
    }
  }
}

/**
 * Marks seen the notices whose door is gone for good, so they cannot crowd the
 * inbox's walk. A closed one is left: it comes back with a re-share or a
 * restore, as it always has.
 */
async function sweepGone(ctx: MutationCtx, me: string): Promise<void> {
  const gone: Doc<"commentNotices">[] = [];
  for await (const { notice, door } of unseenNotices(ctx, me)) if (door === "gone") gone.push(notice);
  await markOwn(ctx, me, gone);
}

/** Records that the caller was told. Someone else's notice is left alone. */
export const markSeen = mutation({
  args: { ids: v.array(v.id("commentNotices")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const me = await requireOwner(ctx);
    if (args.ids.length > MARK_LIMIT) {
      throw new ConvexError(`At most ${MARK_LIMIT} notices at once.`);
    }
    await markOwn(ctx, me, await Promise.all(args.ids.map((id) => ctx.db.get(id))));
    await sweepGone(ctx, me);
    return null;
  },
});

/** Everything the caller was told about one page — for when they have opened it. */
export const markPageSeen = mutation({
  args: { pageId: v.id("pages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const me = await requireOwner(ctx);
    const unseen = await ctx.db
      .query("commentNotices")
      .withIndex("by_recipient_page_unseen", (q) =>
        q.eq("recipientId", me).eq("pageId", args.pageId).eq("seenAt", undefined),
      )
      .collect();
    await markOwn(ctx, me, unseen);
    return null;
  },
});
