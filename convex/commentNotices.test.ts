/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { claimRole } from "./auth";
import { isOutsiderRefusal, MAX_PEOPLE } from "./commentNotices";
import { containerOf } from "./container";
import { purgeProject } from "./projects";
import { appendYUpdate, registerYDoc } from "./ydoc";
import { CommentsStore } from "@/app/lib/comments/store";
import { emptyCommentsDocument, MAX_SIGNERS } from "@/app/lib/comments/types";
import { createNmlYDoc } from "@/app/lib/nml/yjs";

/**
 * Mentions, notices and the comment audit trail (docs/commenting-plan.md
 * §9–§10). One small world per test: an owner's project with two pages, an
 * editor and a viewer who came by live links, and a stranger who never did.
 * Every person is a real `withIdentity` session, so each assertion is what
 * that person's own client would get.
 */

const modules = import.meta.glob("./**/*.ts");

const OWNER = { subject: "user_owner" };
const EDITOR = { subject: "user_editor" };
const VIEWER = { subject: "user_viewer" };
const COMMENTER = { subject: "user_commenter" };
const STRANGER = { subject: "user_stranger" };
/** The owner's own subject, carried by an operator's stand-in token. */
const STAND_IN = { subject: OWNER.subject, act: "operator_1" };

type World = {
  projectId: Id<"projects">;
  pageId: Id<"pages">;
  otherPageId: Id<"pages">;
};

async function world(t: TestConvex<typeof schema>): Promise<World> {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      ownerId: OWNER.subject,
      title: "Launch",
      createdAt: 1,
      updatedAt: 1,
      shareToken: "view-tok",
      editShareToken: "edit-tok",
    });
    const page = (title: string, order: number) =>
      ctx.db.insert("pages", {
        ownerId: OWNER.subject,
        projectId,
        title,
        order,
        docId: crypto.randomUUID(),
        createdAt: 1,
        updatedAt: 1,
      });
    const pageId = await page("Plan", 0);
    const otherPageId = await page("Budget", 1);
    await ctx.db.insert("shareClaims", { projectId, granteeId: EDITOR.subject, role: "editor", createdAt: 1 });
    await ctx.db.insert("shareClaims", { projectId, granteeId: VIEWER.subject, role: "viewer", createdAt: 1 });
    for (const [ownerId, name] of [
      [OWNER.subject, "Ada Owner"],
      [EDITOR.subject, "Bram Editor"],
      [VIEWER.subject, "Cleo Viewer"],
      [STRANGER.subject, "Dev Stranger"],
    ] as const) {
      await ctx.db.insert("profiles", {
        ownerId,
        name,
        imageUrl: `https://img.example/${ownerId}.png`,
        status: "done",
        createdAt: 1,
      });
    }
    return { projectId, pageId, otherPageId };
  });
}

type EventArgs = {
  pageId: Id<"pages">;
  threadId: string;
  kind: "create" | "reply" | "resolve" | "reopen" | "delete";
  commentId?: string;
  mentions: string[];
  participants?: string[];
};

function event(t: TestConvex<typeof schema>, who: { subject: string }, args: EventArgs) {
  return t.withIdentity(who).mutation(api.commentNotices.event, args);
}

async function notices(t: TestConvex<typeof schema>): Promise<Doc<"commentNotices">[]> {
  return await t.run(async (ctx) => ctx.db.query("commentNotices").collect());
}

async function audits(t: TestConvex<typeof schema>): Promise<Doc<"auditEvents">[]> {
  return await t.run(async (ctx) => ctx.db.query("auditEvents").collect());
}

const summary = (rows: Doc<"commentNotices">[]) =>
  rows
    .map((n) => `${n.recipientId}:${n.kind}:${n.threadId}:${n.actorId}`)
    .sort();

describe("who can be mentioned", () => {
  test("everyone who can open the project, minus the caller, named from their profiles", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    expect(await t.withIdentity(OWNER).query(api.commentNotices.mentionable, { pageId: w.pageId })).toEqual([
      { userId: EDITOR.subject, name: "Bram Editor", imageUrl: `https://img.example/${EDITOR.subject}.png` },
      { userId: VIEWER.subject, name: "Cleo Viewer", imageUrl: `https://img.example/${VIEWER.subject}.png` },
    ]);
    const forEditor = await t.withIdentity(EDITOR).query(api.commentNotices.mentionable, { pageId: w.pageId });
    expect(forEditor.map((p) => p.userId)).toEqual([OWNER.subject, VIEWER.subject]);
  });

  test("a stranger is never on the list", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const ids = (await t.withIdentity(OWNER).query(api.commentNotices.mentionable, { pageId: w.pageId })).map((p) => p.userId);
    expect(ids).not.toContain(STRANGER.subject);
  });

  test("the list follows live roles: a revoked editor link demotes, revoking every link closes", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await t.run((ctx) => ctx.db.patch(w.projectId, { editShareToken: undefined }));
    const demoted = await t.withIdentity(OWNER).query(api.commentNotices.mentionable, { pageId: w.pageId });
    expect(demoted.map((p) => p.userId)).toEqual([EDITOR.subject, VIEWER.subject]);

    // An editor handed the pen by name keeps it past the editor link — and is
    // still only as reachable as the project is shared at all.
    await t.run(async (ctx) => {
      const claim = await ctx.db
        .query("shareClaims")
        .withIndex("by_project_and_grantee", (q) => q.eq("projectId", w.projectId).eq("granteeId", EDITOR.subject))
        .unique();
      await ctx.db.patch(claim!._id, { grantedRole: "editor" });
      await ctx.db.patch(w.projectId, { shareToken: undefined });
    });
    expect(await t.withIdentity(OWNER).query(api.commentNotices.mentionable, { pageId: w.pageId })).toEqual([]);
  });

  test("a profile's email is never offered in place of a name", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await t.run(async (ctx) => {
      const profile = await ctx.db.query("profiles").withIndex("by_owner", (q) => q.eq("ownerId", VIEWER.subject)).unique();
      await ctx.db.patch(profile!._id, { name: undefined, email: "cleo@example.com" });
    });
    const people = await t.withIdentity(EDITOR).query(api.commentNotices.mentionable, { pageId: w.pageId });
    expect(people.find((p) => p.userId === VIEWER.subject)?.name).toBeNull();
    expect(JSON.stringify(people)).not.toContain("cleo@example.com");
  });

  test("a claimant without a profile is listed, nameless", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await t.run((ctx) =>
      ctx.db.insert("shareClaims", { projectId: w.projectId, granteeId: "user_fresh", role: "viewer", createdAt: 2 }),
    );
    const people = await t.withIdentity(OWNER).query(api.commentNotices.mentionable, { pageId: w.pageId });
    expect(people.find((p) => p.userId === "user_fresh")).toEqual({ userId: "user_fresh", name: null, imageUrl: null });
  });

  test("nobody to offer anyone who may not comment", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    for (const who of [VIEWER, STRANGER, STAND_IN]) {
      expect(await t.withIdentity(who).query(api.commentNotices.mentionable, { pageId: w.pageId })).toEqual([]);
    }
    expect(await t.query(api.commentNotices.mentionable, { pageId: w.pageId })).toEqual([]);
    await t.run((ctx) => ctx.db.patch(w.pageId, { deletedAt: 5 }));
    expect(await t.withIdentity(OWNER).query(api.commentNotices.mentionable, { pageId: w.pageId })).toEqual([]);
  });

  test("the container seam answers the personal branch today", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const project = await t.run(async (ctx) => (await ctx.db.get(w.projectId))!);
    expect(containerOf(project)).toEqual({ kind: "account", userId: OWNER.subject });
  });
});

describe("who signed a comment", () => {
  const everyone = [OWNER.subject, EDITOR.subject, VIEWER.subject];

  test("every reader is told the names they ask for, their own included", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    for (const who of [OWNER, EDITOR, VIEWER, STAND_IN]) {
      const people = await t.withIdentity(who).query(api.commentNotices.authors, { pageId: w.pageId, userIds: everyone });
      expect(people.map((p) => p.userId)).toEqual(everyone);
    }
    const viewer = await t.withIdentity(VIEWER).query(api.commentNotices.authors, { pageId: w.pageId, userIds: everyone });
    expect(viewer[1]).toEqual({ userId: EDITOR.subject, name: "Bram Editor", imageUrl: `https://img.example/${EDITOR.subject}.png` });
  });

  test("only the people asked about — not the project's roster", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const asked = [EDITOR.subject, EDITOR.subject];
    expect(await t.withIdentity(VIEWER).query(api.commentNotices.authors, { pageId: w.pageId, userIds: asked })).toEqual([
      { userId: EDITOR.subject, name: "Bram Editor", imageUrl: `https://img.example/${EDITOR.subject}.png` },
    ]);
    expect(await t.withIdentity(VIEWER).query(api.commentNotices.authors, { pageId: w.pageId, userIds: [] })).toEqual([]);
  });

  test("an id typed in names nobody who cannot open the project", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const people = await t
      .withIdentity(VIEWER)
      .query(api.commentNotices.authors, { pageId: w.pageId, userIds: [STRANGER.subject, OWNER.subject] });
    expect(people.map((p) => p.userId)).toEqual([OWNER.subject]);
    // An author who has since lost access is named no further.
    await t.run((ctx) => ctx.db.patch(w.projectId, { editShareToken: undefined, shareToken: undefined }));
    const after = await t.withIdentity(OWNER).query(api.commentNotices.authors, { pageId: w.pageId, userIds: everyone });
    expect(after.map((p) => p.userId)).toEqual([OWNER.subject]);
  });

  test(`at most ${MAX_SIGNERS} people asked about per read`, async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const filler = Array.from({ length: MAX_SIGNERS }, (_, i) => `user_filler_${i}`);
    const people = await t
      .withIdentity(OWNER)
      .query(api.commentNotices.authors, { pageId: w.pageId, userIds: [...filler, EDITOR.subject] });
    expect(people).toEqual([]);
  });

  test("nobody for a stranger, a signed-out visitor, or a page gone", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const args = { pageId: w.pageId, userIds: everyone };
    expect(await t.withIdentity(STRANGER).query(api.commentNotices.authors, args)).toEqual([]);
    expect(await t.query(api.commentNotices.authors, args)).toEqual([]);
    await t.run((ctx) => ctx.db.patch(w.pageId, { deletedAt: 5 }));
    expect(await t.withIdentity(OWNER).query(api.commentNotices.authors, args)).toEqual([]);
  });

  test("a profile's email is never offered in place of a name", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await t.run(async (ctx) => {
      const profile = await ctx.db.query("profiles").withIndex("by_owner", (q) => q.eq("ownerId", VIEWER.subject)).unique();
      await ctx.db.patch(profile!._id, { name: undefined, email: "cleo@example.com" });
    });
    const people = await t.withIdentity(OWNER).query(api.commentNotices.authors, { pageId: w.pageId, userIds: everyone });
    expect(JSON.stringify(people)).not.toContain("cleo@example.com");
  });
});

describe("who may report a comment event", () => {
  const args = (w: World): EventArgs => ({ pageId: w.pageId, threadId: "t_1", kind: "create", mentions: [] });

  test("owner and editor may", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, OWNER, args(w));
    await event(t, EDITOR, args(w));
    expect((await audits(t)).map((a) => a.actorId)).toEqual([OWNER.subject, EDITOR.subject]);
  });

  test("a viewer, a stranger, and the signed-out are refused as Not found", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await expect(event(t, VIEWER, args(w))).rejects.toThrow("Not found");
    await expect(event(t, STRANGER, args(w))).rejects.toThrow("Not found");
    await expect(t.mutation(api.commentNotices.event, args(w))).rejects.toThrow("Not found");
    expect(await audits(t)).toEqual([]);
  });

  test("an operator standing in is refused as read-only", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await expect(event(t, STAND_IN, args(w))).rejects.toThrow("Read-only");
    expect(await audits(t)).toEqual([]);
  });

  test("a trashed page or project is refused", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await t.run((ctx) => ctx.db.patch(w.pageId, { deletedAt: 5 }));
    await expect(event(t, OWNER, args(w))).rejects.toThrow("Not found");
    await t.run(async (ctx) => {
      await ctx.db.patch(w.pageId, { deletedAt: undefined });
      await ctx.db.patch(w.projectId, { deletedAt: 5 });
    });
    await expect(event(t, OWNER, args(w))).rejects.toThrow("Not found");
  });

  // The commenter role becomes resolvable in U3 (`auth.claimRole`). Until that
  // lands on this branch, a commenter claim resolves as a viewer and is
  // refused like one; once it does, the first case runs and the second skips.
  const resolved: string | null = claimRole(
    { shareToken: "v", commentShareToken: "c" } as Doc<"projects">,
    { role: "commenter" } as Doc<"shareClaims">,
  );
  const commenterResolves = resolved === "commenter";

  test.runIf(commenterResolves)("a commenter may, and can mention and be mentioned", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(w.projectId, { commentShareToken: "comment-tok" });
      await ctx.db.insert("shareClaims", { projectId: w.projectId, granteeId: COMMENTER.subject, role: "commenter", createdAt: 1 });
    });
    await event(t, COMMENTER, { ...args(w), mentions: [OWNER.subject] });
    await event(t, OWNER, { ...args(w), threadId: "t_2", mentions: [COMMENTER.subject] });
    expect(summary(await notices(t))).toEqual([
      `${COMMENTER.subject}:mention:t_2:${OWNER.subject}`,
      `${OWNER.subject}:mention:t_1:${COMMENTER.subject}`,
    ]);
  });

  test.runIf(!commenterResolves)("until the role resolves, a commenter claim is refused like a viewer", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(w.projectId, { commentShareToken: "comment-tok" });
      await ctx.db.insert("shareClaims", { projectId: w.projectId, granteeId: COMMENTER.subject, role: "commenter", createdAt: 1 });
    });
    await expect(event(t, COMMENTER, args(w))).rejects.toThrow("Not found");
    // Still somebody who can open the project, so still somebody to mention.
    await event(t, OWNER, { ...args(w), mentions: [COMMENTER.subject] });
    expect(summary(await notices(t))).toEqual([`${COMMENTER.subject}:mention:t_1:${OWNER.subject}`]);
  });
});

describe("mentions", () => {
  test("a new thread tells each person named in it", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "create", mentions: [EDITOR.subject, VIEWER.subject] });
    const rows = await notices(t);
    expect(summary(rows)).toEqual([
      `${EDITOR.subject}:mention:t_1:${OWNER.subject}`,
      `${VIEWER.subject}:mention:t_1:${OWNER.subject}`,
    ]);
    expect(rows.every((n) => n.projectId === w.projectId && n.pageId === w.pageId && n.seenAt === undefined)).toBe(true);
  });

  test("mentioning a stranger is refused with a sentence, and nothing is written", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const refusal = await event(t, OWNER, {
      pageId: w.pageId,
      threadId: "t_1",
      kind: "create",
      mentions: [EDITOR.subject, STRANGER.subject],
    }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ConvexError);
    expect(isOutsiderRefusal(refusal)).toBe(true);
    const data = (refusal as ConvexError<{ code: string; userIds: string[]; message: string }>).data;
    expect(data.userIds).toEqual([STRANGER.subject]);
    expect(data.message).toBe("The person you mentioned can't open this project, so they wouldn't see it.");
    // The refusal does not read the stranger's profile back to whoever typed their id.
    expect(JSON.stringify(data)).not.toContain("Dev Stranger");
    expect(await notices(t)).toEqual([]);
    expect(await audits(t)).toEqual([]);
  });

  test("several outsiders are counted in the one refusal", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const refusal = await event(t, OWNER, {
      pageId: w.pageId,
      threadId: "t_1",
      kind: "create",
      mentions: [STRANGER.subject, "user_nobody"],
    }).catch((e: unknown) => e);
    expect((refusal as ConvexError<{ message: string }>).data.message).toBe(
      "2 of the people you mentioned can't open this project, so they wouldn't see it.",
    );
  });

  test("someone who has lost access can no longer be mentioned", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await t.run((ctx) => ctx.db.patch(w.projectId, { shareToken: undefined, editShareToken: undefined }));
    const refusal = await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "create", mentions: [EDITOR.subject] }).catch((e: unknown) => e);
    expect(isOutsiderRefusal(refusal)).toBe(true);
  });

  test("only a new comment carries mentions", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    for (const kind of ["resolve", "reopen", "delete"] as const) {
      await expect(
        event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind, mentions: [EDITOR.subject] }),
      ).rejects.toThrow("Only a new comment can mention someone.");
    }
  });

  test("the same person named twice is told once, and nobody is told about their own comment", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, EDITOR, {
      pageId: w.pageId,
      threadId: "t_1",
      kind: "create",
      mentions: [OWNER.subject, OWNER.subject, EDITOR.subject],
    });
    expect(summary(await notices(t))).toEqual([`${OWNER.subject}:mention:t_1:${EDITOR.subject}`]);
  });

  test(`at most ${MAX_PEOPLE} people per event, each id-shaped`, async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const many = Array.from({ length: MAX_PEOPLE + 1 }, (_, i) => `user_${i}`);
    await expect(
      event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "create", mentions: many }),
    ).rejects.toThrow(`at most ${MAX_PEOPLE}`);
    await expect(
      event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "reply", mentions: [], participants: many }),
    ).rejects.toThrow(`at most ${MAX_PEOPLE}`);
    await expect(
      event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "create", mentions: ["Ada, please look"] }),
    ).rejects.toThrow("not a person");
  });

  test("a thread or comment id has to look like one", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await expect(
      event(t, OWNER, { pageId: w.pageId, threadId: "we should ship friday", kind: "create", mentions: [] }),
    ).rejects.toThrow("not a thread");
    await expect(
      event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "delete", commentId: "the words", mentions: [] }),
    ).rejects.toThrow("not a comment");
    expect(await audits(t)).toEqual([]);
  });
});

describe("replies and resolutions", () => {
  test("a reply tells the thread's other participants; a mention outranks it", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, EDITOR, {
      pageId: w.pageId,
      threadId: "t_1",
      kind: "reply",
      mentions: [VIEWER.subject],
      participants: [OWNER.subject, EDITOR.subject, VIEWER.subject],
    });
    expect(summary(await notices(t))).toEqual([
      `${OWNER.subject}:reply:t_1:${EDITOR.subject}`,
      `${VIEWER.subject}:mention:t_1:${EDITOR.subject}`,
    ]);
  });

  test("a participant the client names but who cannot open the project is skipped, not refused", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, OWNER, {
      pageId: w.pageId,
      threadId: "t_1",
      kind: "reply",
      mentions: [],
      participants: [STRANGER.subject, EDITOR.subject],
    });
    expect(summary(await notices(t))).toEqual([`${EDITOR.subject}:reply:t_1:${OWNER.subject}`]);
  });

  test("resolving tells the participants; reopening and deleting tell nobody", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const participants = [OWNER.subject, EDITOR.subject, VIEWER.subject];
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "resolve", mentions: [], participants });
    expect(summary(await notices(t))).toEqual([
      `${EDITOR.subject}:resolved:t_1:${OWNER.subject}`,
      `${VIEWER.subject}:resolved:t_1:${OWNER.subject}`,
    ]);
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "reopen", mentions: [], participants });
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "delete", commentId: "c_1", mentions: [], participants });
    expect(await notices(t)).toHaveLength(2);
  });

  test("deleting a thread takes back what nobody has read yet, on that page only", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "create", mentions: [EDITOR.subject, VIEWER.subject] });
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_2", kind: "create", mentions: [EDITOR.subject] });
    await event(t, OWNER, { pageId: w.otherPageId, threadId: "t_1", kind: "create", mentions: [EDITOR.subject] });
    const read = (await notices(t)).find((n) => n.recipientId === VIEWER.subject)!;
    await t.withIdentity(VIEWER).mutation(api.commentNotices.markSeen, { ids: [read._id] });

    await event(t, EDITOR, { pageId: w.pageId, threadId: "t_1", kind: "delete", mentions: [] });
    const left = await notices(t);
    expect(left.map((n) => `${n.recipientId}:${n.pageId === w.pageId ? "plan" : "budget"}:${n.threadId}`).sort()).toEqual([
      `${EDITOR.subject}:budget:t_1`,
      `${EDITOR.subject}:plan:t_2`,
      `${VIEWER.subject}:plan:t_1`,
    ]);
    // What was read stays read: it is history, not a door.
    expect(left.find((n) => n._id === read._id)?.seenAt).toBeTypeOf("number");
  });

  test("a create does not notify participants — there are none yet but the writer", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "create", mentions: [], participants: [EDITOR.subject] });
    expect(await notices(t)).toEqual([]);
  });

  test("a busy thread is one unseen notice per person and kind, refreshed by the latest", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const reply = (who: { subject: string }) =>
      event(t, who, { pageId: w.pageId, threadId: "t_1", kind: "reply", mentions: [], participants: [OWNER.subject, EDITOR.subject, VIEWER.subject] });
    await reply(EDITOR);
    const [first] = (await notices(t)).filter((n) => n.recipientId === VIEWER.subject);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await reply(OWNER);
    const forViewer = (await notices(t)).filter((n) => n.recipientId === VIEWER.subject);
    expect(forViewer).toHaveLength(1);
    expect(forViewer[0].actorId).toBe(OWNER.subject);
    expect(forViewer[0].createdAt).toBeGreaterThan(first.createdAt);
    expect(forViewer[0]._creationTime).toBeGreaterThan(first._creationTime);

    // Once read, the next reply is news again.
    await t.withIdentity(VIEWER).mutation(api.commentNotices.markSeen, { ids: [forViewer[0]._id] });
    await reply(EDITOR);
    expect((await notices(t)).filter((n) => n.recipientId === VIEWER.subject)).toHaveLength(2);
  });

  test("a thread that keeps talking keeps its place at the top of the inbox", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const reply = (threadId: string) =>
      event(t, OWNER, { pageId: w.pageId, threadId, kind: "reply", mentions: [], participants: [EDITOR.subject] });
    await reply("t_old");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await reply("t_new");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await reply("t_old");
    expect((await t.withIdentity(EDITOR).query(api.commentNotices.inbox, {})).map((n) => n.threadId)).toEqual(["t_old", "t_new"]);
  });

  test("the same thread id on another page is another thread", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "create", mentions: [EDITOR.subject] });
    await event(t, OWNER, { pageId: w.otherPageId, threadId: "t_1", kind: "create", mentions: [EDITOR.subject] });
    expect((await notices(t)).map((n) => n.pageId).sort()).toEqual([w.pageId, w.otherPageId].sort());
  });
});

describe("the audit record", () => {
  test("every event is one row: who, which thread, ids and counts — never words", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "create", commentId: "c_1", mentions: [EDITOR.subject, VIEWER.subject] });
    await event(t, EDITOR, { pageId: w.pageId, threadId: "t_1", kind: "reply", commentId: "c_2", mentions: [], participants: [OWNER.subject] });
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "resolve", mentions: [], participants: [OWNER.subject, EDITOR.subject] });
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "reopen", mentions: [] });
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "delete", commentId: "c_2", mentions: [] });

    const rows = await audits(t);
    expect(rows.map((r) => r.action)).toEqual([
      "comment.create",
      "comment.reply",
      "comment.resolve",
      "comment.reopen",
      "comment.delete",
    ]);
    for (const row of rows) {
      expect(row.projectId).toBe(w.projectId);
      expect(row.actorKind).toBe("user");
      expect(row.subjectKind).toBe("commentThread");
      expect(row.subjectId).toBe("t_1");
      expect(Object.keys(row).sort()).toEqual(
        ["_creationTime", "_id", "action", "actorId", "actorKind", "at", "meta", "projectId", "subjectId", "subjectKind"],
      );
      expect(Object.keys(row.meta!).sort()).toEqual(["counts", "ids"]);
      expect(Object.keys(row.meta!.counts!).sort()).toEqual(["mentions", "notified"]);
    }
    expect(rows[0].meta).toEqual({ ids: { pageId: w.pageId, commentId: "c_1" }, counts: { mentions: 2, notified: 2 } });
    expect(rows[1].meta).toEqual({ ids: { pageId: w.pageId, commentId: "c_2" }, counts: { mentions: 0, notified: 1 } });
    expect(rows[2].meta).toEqual({ ids: { pageId: w.pageId }, counts: { mentions: 0, notified: 1 } });
    expect(rows[4].meta).toEqual({ ids: { pageId: w.pageId, commentId: "c_2" }, counts: { mentions: 0, notified: 0 } });
    expect(rows.map((r) => r.actorId)).toEqual([OWNER.subject, EDITOR.subject, OWNER.subject, OWNER.subject, OWNER.subject]);
  });
});

describe("the inbox", () => {
  test("what the caller has not seen, newest first, with the page and project named", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "create", mentions: [EDITOR.subject] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await event(t, OWNER, { pageId: w.otherPageId, threadId: "t_2", kind: "resolve", mentions: [], participants: [EDITOR.subject] });
    const inbox = await t.withIdentity(EDITOR).query(api.commentNotices.inbox, {});
    expect(inbox.map((n) => ({ ...n, noticeId: typeof n.noticeId, createdAt: typeof n.createdAt }))).toEqual([
      {
        noticeId: "string",
        kind: "resolved",
        projectId: w.projectId,
        projectTitle: "Launch",
        pageId: w.otherPageId,
        pageTitle: "Budget",
        threadId: "t_2",
        actorName: "Ada Owner",
        actorImageUrl: `https://img.example/${OWNER.subject}.png`,
        createdAt: "number",
      },
      {
        noticeId: "string",
        kind: "mention",
        projectId: w.projectId,
        projectTitle: "Launch",
        pageId: w.pageId,
        pageTitle: "Plan",
        threadId: "t_1",
        actorName: "Ada Owner",
        actorImageUrl: `https://img.example/${OWNER.subject}.png`,
        createdAt: "number",
      },
    ]);
    expect(await t.withIdentity(OWNER).query(api.commentNotices.inbox, {})).toEqual([]);
    expect(await t.query(api.commentNotices.inbox, {})).toEqual([]);
  });

  test("a notice for a project the caller has since lost is not shown", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "create", mentions: [EDITOR.subject, VIEWER.subject] });
    await t.run((ctx) => ctx.db.patch(w.projectId, { shareToken: undefined, editShareToken: undefined }));
    expect(await t.withIdentity(EDITOR).query(api.commentNotices.inbox, {})).toEqual([]);
    expect(await t.withIdentity(VIEWER).query(api.commentNotices.inbox, {})).toEqual([]);
    // Re-shared, the notice was never lost — only not shown, and no mark in
    // the meantime swept it.
    await t.withIdentity(VIEWER).mutation(api.commentNotices.markSeen, { ids: [] });
    await t.run((ctx) => ctx.db.patch(w.projectId, { shareToken: "view-tok-2" }));
    expect(await t.withIdentity(VIEWER).query(api.commentNotices.inbox, {})).toHaveLength(1);
  });

  test("a trashed page or project drops out of the inbox", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "create", mentions: [EDITOR.subject] });
    await event(t, OWNER, { pageId: w.otherPageId, threadId: "t_2", kind: "create", mentions: [EDITOR.subject] });
    await t.run((ctx) => ctx.db.patch(w.pageId, { deletedAt: 5 }));
    expect((await t.withIdentity(EDITOR).query(api.commentNotices.inbox, {})).map((n) => n.threadId)).toEqual(["t_2"]);
    await t.run((ctx) => ctx.db.patch(w.projectId, { deletedAt: 5 }));
    expect(await t.withIdentity(EDITOR).query(api.commentNotices.inbox, {})).toEqual([]);
  });

  test("marking seen touches only the caller's own notices", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "create", mentions: [EDITOR.subject, VIEWER.subject] });
    const rows = await notices(t);
    const editors = rows.find((n) => n.recipientId === EDITOR.subject)!;
    const viewers = rows.find((n) => n.recipientId === VIEWER.subject)!;

    await t.withIdentity(EDITOR).mutation(api.commentNotices.markSeen, { ids: [editors._id, viewers._id] });
    const after = await notices(t);
    expect(after.find((n) => n._id === editors._id)!.seenAt).toBeTypeOf("number");
    expect(after.find((n) => n._id === viewers._id)!.seenAt).toBeUndefined();
    expect(await t.withIdentity(EDITOR).query(api.commentNotices.inbox, {})).toEqual([]);
    expect(await t.withIdentity(VIEWER).query(api.commentNotices.inbox, {})).toHaveLength(1);
  });

  test("marking seen is a write: refused signed out and to a stand-in, and bounded", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, EDITOR, { pageId: w.pageId, threadId: "t_1", kind: "create", mentions: [OWNER.subject] });
    const [row] = await notices(t);
    await expect(t.mutation(api.commentNotices.markSeen, { ids: [row._id] })).rejects.toThrow("Not signed in");
    await expect(t.withIdentity(STAND_IN).mutation(api.commentNotices.markSeen, { ids: [row._id] })).rejects.toThrow("Read-only");
    await expect(t.withIdentity(STAND_IN).mutation(api.commentNotices.markPageSeen, { pageId: w.pageId })).rejects.toThrow("Read-only");
    expect((await notices(t))[0].seenAt).toBeUndefined();
    // A stand-in reads the inbox the way the user would see it.
    expect(await t.withIdentity(STAND_IN).query(api.commentNotices.inbox, {})).toHaveLength(1);
    await expect(
      t.withIdentity(OWNER).mutation(api.commentNotices.markSeen, { ids: Array.from({ length: 201 }, () => row._id) }),
    ).rejects.toThrow("At most 200");
  });

  test("opening a page marks what the caller was told about it, and nothing else", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "create", mentions: [EDITOR.subject, VIEWER.subject] });
    await event(t, OWNER, { pageId: w.otherPageId, threadId: "t_2", kind: "create", mentions: [EDITOR.subject] });
    await t.withIdentity(EDITOR).mutation(api.commentNotices.markPageSeen, { pageId: w.pageId });
    expect((await t.withIdentity(EDITOR).query(api.commentNotices.inbox, {})).map((n) => n.threadId)).toEqual(["t_2"]);
    expect(await t.withIdentity(VIEWER).query(api.commentNotices.inbox, {})).toHaveLength(1);
  });

  test("purging the project takes the notices an event wrote", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "create", mentions: [EDITOR.subject] });
    await t.run((ctx) => purgeProject(ctx, w.projectId));
    expect(await notices(t)).toEqual([]);
  });
});

describe("a deletion is believed only once the document shows it", () => {
  /** A client's copy of the page's comments document, and a way to send what it wrote. */
  async function commentsDoc(t: TestConvex<typeof schema>, w: World) {
    const docId = crypto.randomUUID();
    const doc = createNmlYDoc(emptyCommentsDocument(docId));
    const bytes = (update: Uint8Array) =>
      update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength) as ArrayBuffer;
    await t.run(async (ctx) => {
      await registerYDoc(ctx, docId, bytes(Y.encodeStateAsUpdate(doc)));
      await ctx.db.patch(w.pageId, { commentsDocId: docId });
    });
    let sent = Y.encodeStateVector(doc);
    const store = new CommentsStore(doc, { actor: { userId: OWNER.subject, kind: "human" }, authorize: () => true });
    const sync = () =>
      t.run(async (ctx) => {
        const update = Y.encodeStateAsUpdate(doc, sent);
        sent = Y.encodeStateVector(doc);
        await appendYUpdate(ctx, docId, [bytes(update)]);
      });
    const anchor = { blockId: "p_1", exact: "by Friday", prefix: "", suffix: "", offsetHint: 0 };
    await store.createThread({ anchor, body: "Is this real?", authorId: OWNER.subject, threadId: "t_1", commentId: "c_1" });
    await store.reply({ threadId: "t_1", body: "Yes.", authorId: EDITOR.subject, commentId: "c_2" });
    await sync();
    return { store, sync };
  }

  async function told(t: TestConvex<typeof schema>, w: World) {
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "create", commentId: "c_1", mentions: [EDITOR.subject, VIEWER.subject] });
  }

  const deletions = async (t: TestConvex<typeof schema>) =>
    (await audits(t)).filter((row) => row.action === "comment.delete");

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a thread still there keeps everyone's notices, and no deletion is recorded — now or on the second look", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const w = await world(t);
    await commentsDoc(t, w);
    await told(t, w);

    await event(t, EDITOR, { pageId: w.pageId, threadId: "t_1", kind: "delete", mentions: [] });
    await event(t, EDITOR, { pageId: w.pageId, threadId: "t_1", kind: "delete", commentId: "c_1", mentions: [] });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await notices(t)).toHaveLength(2);
    expect(await deletions(t)).toEqual([]);
  });

  test("a deletion the document shows takes back the notices and is recorded", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    const { store, sync } = await commentsDoc(t, w);
    await told(t, w);

    await store.deleteComment({ commentId: "c_2", by: EDITOR.subject });
    await sync();
    await event(t, EDITOR, { pageId: w.pageId, threadId: "t_1", kind: "delete", commentId: "c_2", mentions: [] });
    expect((await deletions(t)).map((row) => row.meta?.ids)).toEqual([{ pageId: w.pageId, commentId: "c_2" }]);
    expect(await notices(t)).toHaveLength(2);

    await store.deleteThread({ threadId: "t_1" });
    await sync();
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "delete", mentions: [] });
    expect(await notices(t)).toEqual([]);
    expect(await deletions(t)).toHaveLength(2);
  });

  test("a deletion that reaches the document after its notice is confirmed on the second look", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const w = await world(t);
    const { store, sync } = await commentsDoc(t, w);
    await told(t, w);

    await store.deleteThread({ threadId: "t_1" });
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "delete", mentions: [] });
    expect(await notices(t)).toHaveLength(2);
    expect(await deletions(t)).toEqual([]);

    await sync();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await notices(t)).toEqual([]);
    expect((await deletions(t)).map((row) => row.actorId)).toEqual([OWNER.subject]);
  });
});

describe("the inbox, past what no longer opens", () => {
  /** Notices on a page trashed (`closed`), or deleted outright (`gone`). */
  async function stale(t: TestConvex<typeof schema>, w: World, count: number, how: "closed" | "gone") {
    await t.run(async (ctx) => {
      const gone = await ctx.db.insert("pages", {
        ownerId: OWNER.subject,
        projectId: w.projectId,
        title: "Old",
        order: 9,
        docId: crypto.randomUUID(),
        createdAt: 1,
        updatedAt: 1,
        deletedAt: 5,
      });
      for (let i = 0; i < count; i++) {
        await ctx.db.insert("commentNotices", {
          recipientId: EDITOR.subject,
          projectId: w.projectId,
          pageId: gone,
          threadId: `t_stale_${i}`,
          actorId: OWNER.subject,
          kind: "mention",
          createdAt: 10 + i,
        });
      }
      if (how === "gone") await ctx.db.delete(gone);
    });
  }

  test("a hundred notices that no longer open anything do not hide the one that does", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_live", kind: "create", mentions: [EDITOR.subject] });
    await stale(t, w, 150, "closed");
    expect((await t.withIdentity(EDITOR).query(api.commentNotices.inbox, {})).map((n) => n.threadId)).toEqual(["t_live"]);
  });

  test("the caller's next marks sweep the ones gone for good, so they cannot pile up in front", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_live", kind: "create", mentions: [EDITOR.subject] });
    await stale(t, w, 600, "gone");
    // Past the walk's bound, the live notice is out of reach...
    expect(await t.withIdentity(EDITOR).query(api.commentNotices.inbox, {})).toEqual([]);
    await t.withIdentity(EDITOR).mutation(api.commentNotices.markSeen, { ids: [] });
    await t.withIdentity(EDITOR).mutation(api.commentNotices.markSeen, { ids: [] });
    // ...until the marks have swept what stood in front of it.
    expect((await t.withIdentity(EDITOR).query(api.commentNotices.inbox, {})).map((n) => n.threadId)).toEqual(["t_live"]);
    const unseen = (await notices(t)).filter((n) => n.seenAt === undefined);
    expect(unseen.map((n) => n.threadId)).toEqual(["t_live"]);
  });

  test("marking one page seen reaches only that page's notices", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_1", kind: "create", mentions: [EDITOR.subject] });
    await event(t, OWNER, { pageId: w.pageId, threadId: "t_2", kind: "create", mentions: [EDITOR.subject] });
    await event(t, OWNER, { pageId: w.otherPageId, threadId: "t_3", kind: "create", mentions: [EDITOR.subject] });
    await t.withIdentity(EDITOR).mutation(api.commentNotices.markPageSeen, { pageId: w.pageId });
    const unseen = (await notices(t)).filter((n) => n.seenAt === undefined);
    expect(unseen.map((n) => n.threadId)).toEqual(["t_3"]);
  });
});
