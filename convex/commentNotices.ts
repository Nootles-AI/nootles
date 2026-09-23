import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  channelAdmits,
  isTrashed,
  ownerId,
  readVisible,
  requireCommentable,
  requireOwner,
  roleForProject,
  standInActor,
} from "./auth";
import { isAuditId, recordAudit } from "./audit";
import { containerMembers, mentionablePeople } from "./container";
import { commentsEnabled } from "./entitlements";

/**
 * Who is told about a comment, and the record that it happened
 * (docs/commenting-plan.md §9–§10).
 *
 * The thread itself lives in the page's comments document, written by the
 * client straight into the Yjs log; the server never reads those bytes, so
 * nothing in them — an `authorId` included — is proof of anything. What the
 * client says here is therefore only ever a request: the actor is the
 * authenticated caller, and every person named is checked against the
 * project's own membership before a row is written for them.
 */

/** Most people one event may name — a thread is a conversation, not a list. */
export const MAX_PEOPLE = 50;

const COMMENTS_OFF = () =>
  new ConvexError("Comments are turned off for this project.");

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
    .withIndex("by_page", (q) => q.eq("pageId", pageId))
    .collect();
  for (const notice of told) {
    if (notice.threadId === threadId && notice.seenAt === undefined) await ctx.db.delete(notice._id);
  }
}

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
 * `delete` names a comment (`commentId`) or, without one, the whole thread.
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
    if (!(await commentsEnabled(ctx, project))) throw COMMENTS_OFF();
    const actor = (await ownerId(ctx))!;
    if (!isAuditId(args.threadId)) throw new ConvexError("That is not a thread.");
    if (args.commentId !== undefined && !isAuditId(args.commentId)) {
      throw new ConvexError("That is not a comment.");
    }
    const writes = args.kind === "create" || args.kind === "reply";
    if (!writes && args.mentions.length) {
      throw new ConvexError("Only a new comment can mention someone.");
    }

    const mentions = people(args.mentions, "people");
    const participants = people(args.participants ?? [], "participants");
    const members = new Set((await containerMembers(ctx, project)).map((m) => m.userId));

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

    if (args.kind === "delete" && args.commentId === undefined) {
      await forgetThread(ctx, page._id, args.threadId);
    }

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

/**
 * The people an @ in a comment on this page may name — everyone who can open
 * the project except the caller. Empty for anyone who may not comment here,
 * including an operator standing in, so the menu simply has nobody to offer.
 */
export const mentionable = query({
  args: { pageId: v.id("pages") },
  returns: v.array(
    v.object({
      userId: v.string(),
      name: v.union(v.string(), v.null()),
      imageUrl: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const me = await ownerId(ctx);
    if (!me || (await standInActor(ctx))) return [];
    const page = await readVisible(ctx, "pages", args.pageId);
    if (!page) return [];
    const project = await ctx.db.get(page.projectId);
    if (!project || !(await commentsEnabled(ctx, project))) return [];
    const role = await roleForProject(ctx, project);
    if (!channelAdmits({ channel: "comments", access: "write", role, linkLive: false })) {
      return [];
    }
    return (await mentionablePeople(ctx, project))
      .filter((person) => person.userId !== me)
      .map(({ userId, name, imageUrl }) => ({ userId, name, imageUrl }));
  },
});

/** Newest first, and no more than an inbox can show. */
const INBOX_LIMIT = 100;

/**
 * What the caller has not yet been told, across every project — the query is
 * keyed on them, so the notice reaches them wherever they are standing.
 *
 * A notice outlives the access it was sent under: a project since unshared,
 * trashed, or with comments turned off drops out here rather than offering a
 * door that no longer opens.
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
    const notices = await ctx.db
      .query("commentNotices")
      .withIndex("by_recipient_unseen", (q) => q.eq("recipientId", me).eq("seenAt", undefined))
      .order("desc")
      .take(INBOX_LIMIT);

    const openable = new Map<Id<"projects">, Doc<"projects"> | null>();
    const projectFor = async (id: Id<"projects">) => {
      if (!openable.has(id)) {
        const project = await ctx.db.get(id);
        const ok =
          project &&
          !isTrashed(project) &&
          (await roleForProject(ctx, project)) !== null &&
          (await commentsEnabled(ctx, project));
        openable.set(id, ok ? project : null);
      }
      return openable.get(id)!;
    };

    const rows = await Promise.all(
      notices.map(async (notice) => {
        const project = await projectFor(notice.projectId);
        if (!project) return null;
        const page = await ctx.db.get(notice.pageId);
        if (!page || isTrashed(page) || page.projectId !== project._id) return null;
        const actor = await ctx.db
          .query("profiles")
          .withIndex("by_owner", (q) => q.eq("ownerId", notice.actorId))
          .unique();
        return {
          noticeId: notice._id,
          kind: notice.kind,
          projectId: project._id,
          projectTitle: project.title,
          pageId: page._id,
          pageTitle: page.title,
          threadId: notice.threadId,
          actorName: actor?.name ?? null,
          actorImageUrl: actor?.imageUrl ?? null,
          createdAt: notice.createdAt,
        };
      }),
    );
    return rows
      .filter((row) => row !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
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
    return null;
  },
});

/** Everything the caller was told about one page — for when they have opened it. */
export const markPageSeen = mutation({
  args: { pageId: v.id("pages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const me = await requireOwner(ctx);
    const unseen = await unseenFor(ctx, me);
    await markOwn(ctx, me, unseen.filter((n) => n.pageId === args.pageId));
    return null;
  },
});

async function unseenFor(ctx: QueryCtx, me: string): Promise<Doc<"commentNotices">[]> {
  return await ctx.db
    .query("commentNotices")
    .withIndex("by_recipient_unseen", (q) => q.eq("recipientId", me).eq("seenAt", undefined))
    .collect();
}
