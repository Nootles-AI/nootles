/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * Commenting inside a workspace: where the comments design's seams
 * (`docs/commenting-plan.md` §10) meet the Teams container. Who a workspace
 * project's comments admit, who its mention menu lists, which log its comment
 * events land in and who reads them, and what a workspace's links, expiry and
 * overrides do to the comment link.
 */

const modules = import.meta.glob("./**/*.ts");

const OWNER = { subject: "user_ws_owner" };
const ADMIN = { subject: "user_ws_admin" };
const MEMBER = { subject: "user_member" };
const MAKER = { subject: "user_maker" };
const GUEST = { subject: "user_guest" };
const OUTSIDER = { subject: "user_outsider" };
const REMOVED = { subject: "user_removed" };

type World = {
  workspaceId: Id<"workspaces">;
  projectId: Id<"projects">;
  pageId: Id<"pages">;
};

/**
 * A Team-plan workspace with one of every seat, a project a member made there
 * with its comment link on, and a guest and an outsider who came in by it.
 */
async function world(
  t: TestConvex<typeof schema>,
  over: { visibility?: "private"; plan?: "team" | null; linkSharing?: boolean } = {},
): Promise<World> {
  return await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      slug: "acme",
      name: "Acme",
      createdBy: OWNER.subject,
      plan: "team",
      settings: {
        linkSharing: over.linkSharing ?? true,
        guestCodeAccess: false,
        joinDomains: [],
        autoJoin: false,
      },
      createdAt: 1,
    });
    if (over.plan !== null) {
      await ctx.db.insert("workspaceEntitlements", {
        workspaceId,
        feature: "plan",
        value: "team",
        note: "test",
        grantedBy: "test",
        grantedAt: 1,
      });
    }
    const seats: [{ subject: string }, Doc<"memberships">["role"], boolean][] = [
      [OWNER, "owner", false],
      [ADMIN, "admin", false],
      [MEMBER, "member", false],
      [MAKER, "member", false],
      [GUEST, "guest", false],
      [REMOVED, "member", true],
    ];
    for (const [who, role, removed] of seats) {
      await ctx.db.insert("memberships", {
        workspaceId,
        userId: who.subject,
        role,
        status: removed ? "removed" : "active",
        joinedAt: 1,
        ...(removed ? { removedAt: 2 } : {}),
      });
    }
    const projectId = await ctx.db.insert("projects", {
      ownerId: MAKER.subject,
      title: "Launch",
      createdAt: 1,
      workspaceId,
      commentShareToken: "comment-tok",
      ...(over.visibility ? { visibility: over.visibility } : {}),
    });
    const pageId = await ctx.db.insert("pages", {
      ownerId: MAKER.subject,
      projectId,
      title: "Plan",
      order: 0,
      docId: crypto.randomUUID(),
      createdAt: 1,
    });
    for (const who of [GUEST, OUTSIDER, REMOVED]) {
      await ctx.db.insert("shareClaims", { projectId, granteeId: who.subject, role: "commenter", createdAt: 1 });
    }
    return { workspaceId, projectId, pageId };
  });
}

const role = (t: TestConvex<typeof schema>, who: { subject: string }, projectId: Id<"projects">) =>
  t.withIdentity(who).query(api.projects.myRole, { projectId });

const mentionable = async (t: TestConvex<typeof schema>, who: { subject: string }, pageId: Id<"pages">) =>
  (await t.withIdentity(who).query(api.commentNotices.mentionable, { pageId })).map((p) => p.userId).sort();

const comment = (t: TestConvex<typeof schema>, who: { subject: string }, pageId: Id<"pages">, mentions: string[] = []) =>
  t.withIdentity(who).mutation(api.commentNotices.event, { pageId, threadId: "t_1", kind: "create", mentions });

afterEach(() => {
  vi.useRealTimers();
});

describe("who comments in a workspace project", () => {
  test("seats answer first; a guest and an outsider comment by the link; a removed member by nothing but it", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    expect(await role(t, OWNER, w.projectId)).toBe("owner");
    expect(await role(t, ADMIN, w.projectId)).toBe("owner");
    expect(await role(t, MEMBER, w.projectId)).toBe("editor");
    // The maker of a workspace project owns nothing there.
    expect(await role(t, MAKER, w.projectId)).toBe("editor");
    expect(await role(t, GUEST, w.projectId)).toBe("commenter");
    expect(await role(t, OUTSIDER, w.projectId)).toBe("commenter");
    // Their seat gone, the link they also hold is what is left.
    expect(await role(t, REMOVED, w.projectId)).toBe("commenter");
    await comment(t, GUEST, w.pageId);
  });

  test("the workspace turning links off pauses the comment link, and turning them on restores it", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t, { linkSharing: false });
    expect(await role(t, GUEST, w.projectId)).toBeNull();
    await expect(comment(t, GUEST, w.pageId)).rejects.toThrow("Not found");
    expect(await mentionable(t, MEMBER, w.pageId)).not.toContain(GUEST.subject);
    await t.run((ctx) =>
      ctx.db.patch(w.workspaceId, {
        settings: { linkSharing: true, guestCodeAccess: false, joinDomains: [], autoJoin: false },
      }),
    );
    expect(await role(t, GUEST, w.projectId)).toBe("commenter");
  });

  test("an expired comment link admits nobody, and neither does a claim that ran out with it", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const t = convexTest(schema, modules);
    const w = await world(t);
    await t.run((ctx) => ctx.db.patch(w.projectId, { commentShareExpiresAt: 5_000 }));
    expect(await role(t, OUTSIDER, w.projectId)).toBeNull();
    await expect(comment(t, OUTSIDER, w.pageId)).rejects.toThrow("Not found");
  });

  test("a workspace's own override turns its comments off, and the project's own override wins over it", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await t.run((ctx) =>
      ctx.db.insert("workspaceEntitlements", {
        workspaceId: w.workspaceId,
        feature: "comments",
        value: false,
        note: "test",
        grantedBy: "test",
        grantedAt: 1,
      }),
    );
    await expect(comment(t, MEMBER, w.pageId)).rejects.toThrow("Comments are turned off");
    await t.run((ctx) =>
      ctx.db.insert("entitlementOverrides", {
        scope: "project",
        scopeId: w.projectId,
        feature: "comments",
        value: true,
        note: "test",
        grantedBy: "operator_1",
        grantedAt: 1,
      }),
    );
    await comment(t, MEMBER, w.pageId);
  });
});

describe("who a workspace project's mention menu lists", () => {
  test("its seats and the people let in by link — to those with a seat", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    expect(await mentionable(t, MEMBER, w.pageId)).toEqual(
      [OWNER, ADMIN, MAKER, GUEST, OUTSIDER, REMOVED].map((p) => p.subject).sort(),
    );
  });

  test("a guest or someone in by link sees nobody: the roster is the workspace's members' to see", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    expect(await mentionable(t, GUEST, w.pageId)).toEqual([]);
    expect(await mentionable(t, OUTSIDER, w.pageId)).toEqual([]);
  });

  test("a private project lists its owners, its admins and its maker, not the other members", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t, { visibility: "private" });
    const listed = await mentionable(t, MAKER, w.pageId);
    expect(listed).toEqual(expect.arrayContaining([OWNER.subject, ADMIN.subject]));
    expect(listed).not.toContain(MEMBER.subject);
    expect(await mentionable(t, ADMIN, w.pageId)).toContain(MAKER.subject);
  });

  test("naming someone the project does not admit is refused; naming a guest who holds the link is not", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t, { visibility: "private" });
    await expect(comment(t, MAKER, w.pageId, [MEMBER.subject])).rejects.toThrow();
    await comment(t, MAKER, w.pageId, [GUEST.subject, ADMIN.subject]);
    const told = await t.run((ctx) => ctx.db.query("commentNotices").collect());
    expect(told.map((n) => n.recipientId).sort()).toEqual([ADMIN.subject, GUEST.subject].sort());
  });
});

describe("where a workspace project's comment events are logged", () => {
  test("in the workspace's log, named, and in the project's slice of it — both read by its admins", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await comment(t, GUEST, w.pageId, [MEMBER.subject]);

    const log = await t.withIdentity(ADMIN).query(api.audit.list, {
      workspaceId: w.workspaceId,
      paginationOpts: { numItems: 10, cursor: null },
      filters: { action: "comment" },
    });
    expect(log.page).toHaveLength(1);
    expect(log.page[0]).toMatchObject({
      action: "comment.create",
      actorId: GUEST.subject,
      meta: { projectId: w.projectId, project: "Launch", pageId: w.pageId, page: "Plan", mentions: 1 },
    });

    const slice = await t.withIdentity(ADMIN).query(api.audit.forProject, {
      projectId: w.projectId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(slice.page.map((row) => [row.action, row.pageTitle])).toEqual([["comment.create", "Plan"]]);
  });

  test("a member reads neither, and a workspace without the audit log reads no slice of it either", async () => {
    const t = convexTest(schema, modules);
    const w = await world(t);
    await comment(t, GUEST, w.pageId);
    const args = { projectId: w.projectId, paginationOpts: { numItems: 10, cursor: null } };
    await expect(t.withIdentity(MEMBER).query(api.audit.forProject, args)).rejects.toThrow("Not found");
    // The maker is no owner here, whatever `ownerId` says.
    await expect(t.withIdentity(MAKER).query(api.audit.forProject, args)).rejects.toThrow("Not found");

    const free = convexTest(schema, modules);
    const f = await world(free, { plan: null });
    await comment(free, GUEST, f.pageId);
    await expect(
      free.withIdentity(ADMIN).query(api.audit.forProject, { ...args, projectId: f.projectId }),
    ).rejects.toThrow("Not found");
  });

  test("another person's comment keeps a fresh project from being discarded", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const t = convexTest(schema, modules);
    const w = await world(t);
    await t.run((ctx) => ctx.db.patch(w.projectId, { commentShareToken: undefined, createdAt: 1_000 }));
    await comment(t, MEMBER, w.pageId);
    // No link and no claim left: the comment's log row is the only trace.
    await t.run(async (ctx) => {
      for (const claim of await ctx.db.query("shareClaims").collect()) await ctx.db.delete(claim._id);
    });
    await expect(
      t.withIdentity(MAKER).mutation(api.projects.discardFresh, { projectId: w.projectId }),
    ).rejects.toThrow("Someone else has worked in this project");
  });
});
