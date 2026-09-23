/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";
import { FREE_LIMITS, isQuotaRefusal } from "./entitlements";

/**
 * Where a project lives decides whose it is to pay for. A workspace project
 * is made by a member and counted against nobody's personal limit; its chats
 * and completions spend the workspace's allowance and never the person's; the
 * ledger charges its calls to the workspace, worked out from the project and
 * the caller's role there rather than from anything a request says. A
 * personal project behaves exactly as it did before workspaces.
 */

const modules = import.meta.glob("./**/*.ts");

const OWNER = { subject: "user_ws_owner" };
const ADMIN = { subject: "user_ws_admin" };
const MEMBER = { subject: "user_member" };
const OTHER = { subject: "user_other_member" };
const GUEST = { subject: "user_guest" };
const REMOVED = { subject: "user_removed" };
const STRANGER = { subject: "user_stranger" };

type Identity = { subject: string; act?: string };
type T = TestConvex<typeof schema>;

async function world(t: T) {
  return await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      slug: "acme",
      name: "Acme",
      createdBy: OWNER.subject,
      plan: "team",
      settings: { linkSharing: true, guestCodeAccess: false, joinDomains: [], autoJoin: false },
      createdAt: 1,
    });
    const seat = (who: Identity, role: Doc<"memberships">["role"], removed = false) =>
      ctx.db.insert("memberships", {
        workspaceId,
        userId: who.subject,
        role,
        status: removed ? "removed" : "active",
        joinedAt: 1,
        ...(removed ? { removedAt: 2 } : {}),
      });
    await seat(OWNER, "owner");
    await seat(ADMIN, "admin");
    await seat(MEMBER, "member");
    await seat(OTHER, "member");
    await seat(GUEST, "guest");
    await seat(REMOVED, "member", true);
    return { workspaceId };
  });
}

/** A project with one page, straight into the table. */
async function project(t: T, fields: Partial<Doc<"projects">> & { ownerId: string }) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { title: "P", createdAt: 1, ...fields });
    const pageId = await ctx.db.insert("pages", {
      ownerId: fields.ownerId,
      projectId,
      title: "",
      order: 0,
      docId: crypto.randomUUID(),
      createdAt: 1,
    });
    return { projectId, pageId };
  });
}

/** Spends someone's whole free allowance of one meter. */
async function spent(t: T, who: Identity, meter: "completions" | "chats") {
  await t.run(async (ctx) => {
    await ctx.db.insert("billingAccounts", {
      ownerId: who.subject,
      acceptedCompletions: meter === "completions" ? FREE_LIMITS.completions : 0,
      chatConversations: meter === "chats" ? FREE_LIMITS.chats : 0,
      createdAt: 1,
    });
  });
}

async function account(t: T, who: Identity) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("billingAccounts")
      .withIndex("by_owner", (q) => q.eq("ownerId", who.subject))
      .unique(),
  );
}

const refusedFor = (meter: string) => (e: unknown) =>
  isQuotaRefusal(e) && e.data.meter === meter;

describe("making a project in a workspace", () => {
  test("a member makes it: theirs to edit, the workspace's to manage", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const bytes = new Uint8Array([1, 1, 1]).buffer;
    const projectId = await t.withIdentity(MEMBER).mutation(api.projects.create, {
      title: "Roadmap",
      description: "What ships this quarter",
      workspaceId,
      seed: [{ kind: "page", title: "Overview", update: bytes }],
    });

    const { row, pages, sheet } = await t.run(async (ctx) => ({
      row: await ctx.db.get(projectId),
      pages: await ctx.db
        .query("pages")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect(),
      sheet: await ctx.db
        .query("contextSheet")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect(),
    }));
    expect(row).toMatchObject({ ownerId: MEMBER.subject, workspaceId });
    // The seeded page's document was born through the member's own role.
    expect(pages.map((p) => [p.title, p.ownerId, p.yjs])).toEqual([
      ["Overview", MEMBER.subject, true],
    ]);
    expect(sheet.map((row) => row.ownerId)).toEqual([MEMBER.subject]);

    const role = (who: Identity) =>
      t.withIdentity(who).query(api.projects.myRole, { projectId });
    expect(await role(MEMBER)).toBe("editor");
    expect(await role(OTHER)).toBe("editor");
    expect(await role(ADMIN)).toBe("owner");
  });

  test("a private one is its creator's and the admins' alone", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const projectId = await t
      .withIdentity(MEMBER)
      .mutation(api.projects.create, { title: "Offsite", workspaceId, visibility: "private" });
    expect(await t.run(async (ctx) => (await ctx.db.get(projectId))?.visibility)).toBe("private");
    const role = (who: Identity) =>
      t.withIdentity(who).query(api.projects.myRole, { projectId });
    expect(await role(MEMBER)).toBe("editor");
    expect(await role(OTHER)).toBeNull();
    expect(await role(OWNER)).toBe("owner");
  });

  test("an admin's project is theirs to manage, as every admin's is", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const projectId = await t
      .withIdentity(ADMIN)
      .mutation(api.projects.create, { title: "Budget", workspaceId });
    expect(await t.withIdentity(ADMIN).query(api.projects.myRole, { projectId })).toBe("owner");
    expect(await t.withIdentity(MEMBER).query(api.projects.myRole, { projectId })).toBe("editor");
  });

  test("a guest is told why; nobody else learns the workspace exists", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const create = (who: Identity) =>
      t.withIdentity(who).mutation(api.projects.create, { title: "X", workspaceId });
    await expect(create(GUEST)).rejects.toThrow("A guest can’t do that here.");
    await expect(create(REMOVED)).rejects.toThrow("Not found");
    await expect(create(STRANGER)).rejects.toThrow("Not found");
    await expect(create({ ...MEMBER, act: "ops_session_1" })).rejects.toThrow("Read-only");
    await expect(
      t.mutation(api.projects.create, { title: "X", workspaceId }),
    ).rejects.toThrow("Not signed in");
  });

  test("a deleted workspace takes no new projects", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await t.withIdentity(OWNER).mutation(api.workspaces.remove, { workspaceId });
    await expect(
      t.withIdentity(OWNER).mutation(api.projects.create, { title: "X", workspaceId }),
    ).rejects.toThrow("Not found");
  });

  test("the rollout flag does not stand between a member and their workspace", async () => {
    // `TEAMS_ROLLOUT` is unset here, which is "off": it gates making a
    // workspace, never working in one.
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await expect(
      t.withIdentity(MEMBER).mutation(api.projects.create, { title: "X", workspaceId }),
    ).resolves.toBeTruthy();
  });

  test("visibility means nothing on a personal project, so none is kept", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t
      .withIdentity(MEMBER)
      .mutation(api.projects.create, { title: "Mine", visibility: "private" });
    const row = await t.run(async (ctx) => await ctx.db.get(projectId));
    expect(row?.workspaceId).toBeUndefined();
    expect(row?.visibility).toBeUndefined();
  });
});

describe("the personal project limit", () => {
  test("workspace projects never count against it, whoever made them", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const me = t.withIdentity(MEMBER);
    for (let i = 0; i <= FREE_LIMITS.projects; i++) {
      await me.mutation(api.projects.create, { title: `Team ${i}`, workspaceId });
    }
    for (let i = 0; i < FREE_LIMITS.projects; i++) {
      await me.mutation(api.projects.create, { title: `Mine ${i}` });
    }
    await expect(me.mutation(api.projects.create, { title: "One more" })).rejects.toSatisfy(
      refusedFor("projects"),
    );
    // And with the personal slots full, the workspace still takes more.
    await expect(
      me.mutation(api.projects.create, { title: "Team again", workspaceId }),
    ).resolves.toBeTruthy();
    expect((await me.query(api.entitlements.mine, {}))?.used?.projects).toBe(
      FREE_LIMITS.projects,
    );
  });

  test("restoring a workspace project asks nobody's personal limit", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    for (let i = 0; i < FREE_LIMITS.projects; i++) {
      await project(t, { ownerId: ADMIN.subject });
    }
    const { projectId } = await project(t, {
      ownerId: MEMBER.subject,
      workspaceId,
      deletedAt: 5,
    });
    await t.withIdentity(ADMIN).mutation(api.trash.restore, { projects: [projectId] });
    expect((await t.run(async (ctx) => await ctx.db.get(projectId)))?.deletedAt).toBeUndefined();
  });
});

describe("the lists", () => {
  test("the personal screen lists personal, live projects only", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const mine = await project(t, { ownerId: MEMBER.subject, title: "Mine" });
    await project(t, { ownerId: MEMBER.subject, title: "Binned", deletedAt: 5 });
    await project(t, { ownerId: MEMBER.subject, title: "Team", workspaceId });
    const rows = await t.withIdentity(MEMBER).query(api.projects.listForScreen, {});
    expect(rows.map((row) => row._id)).toEqual([mine.projectId]);
  });

  test("shared with me leaves a seat-holder's workspace projects to its home", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const linked = await project(t, {
      ownerId: MEMBER.subject,
      title: "Linked",
      workspaceId,
      shareToken: "view-token",
    });
    await t.run(async (ctx) => {
      for (const who of [GUEST, STRANGER]) {
        await ctx.db.insert("shareClaims", {
          projectId: linked.projectId,
          granteeId: who.subject,
          role: "viewer",
          createdAt: 1,
        });
      }
    });

    // The guest's link already lists it on the workspace home...
    expect(await t.withIdentity(GUEST).query(api.projects.sharedWithMe, {})).toEqual([]);
    const home = await t
      .withIdentity(GUEST)
      .query(api.workspaces.projectsFor, { workspaceId });
    expect(home.map((row) => row._id)).toEqual([linked.projectId]);
    // ...while someone with no seat has nowhere else to find it.
    const shared = await t.withIdentity(STRANGER).query(api.projects.sharedWithMe, {});
    expect(shared.map((row) => [row._id, row.role])).toEqual([[linked.projectId, "viewer"]]);
  });
});

describe("entitlements resolve by container", () => {
  test("the same person has chat in a team project and not in their own", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await spent(t, MEMBER, "chats");
    const personal = await project(t, { ownerId: MEMBER.subject });
    const team = await project(t, { ownerId: OTHER.subject, workspaceId });
    const me = t.withIdentity(MEMBER);

    expect(
      await me.query(api.entitlements.forProject, { projectId: personal.projectId }),
    ).toMatchObject({ plan: "free", source: "none", left: { chats: 0 } });
    expect(
      await me.query(api.entitlements.forProject, { projectId: team.projectId }),
    ).toEqual({ plan: "pro", source: "workspace", left: null, used: null });
  });

  test("naming a project you cannot write in is asking about your own account", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const team = await project(t, {
      ownerId: MEMBER.subject,
      workspaceId,
      shareToken: "view-token",
    });
    const secret = await project(t, { ownerId: MEMBER.subject, workspaceId, visibility: "private" });
    await t.run(async (ctx) => {
      await ctx.db.insert("shareClaims", {
        projectId: team.projectId,
        granteeId: GUEST.subject,
        role: "viewer",
        createdAt: 1,
      });
    });
    const own = { plan: "free", source: "none" };
    const ask = (who: Identity, projectId: string) =>
      t.withIdentity(who).query(api.entitlements.forProject, { projectId });

    // A guest who only reads, a stranger, a member shut out of a private
    // project, and ids that name nothing: every one of them is on their own.
    expect(await ask(GUEST, team.projectId)).toMatchObject(own);
    expect(await ask(STRANGER, team.projectId)).toMatchObject(own);
    expect(await ask(REMOVED, team.projectId)).toMatchObject(own);
    expect(await ask(OTHER, secret.projectId)).toMatchObject(own);
    expect(await ask(MEMBER, "not-an-id")).toMatchObject(own);
    expect(await ask(MEMBER, workspaceId)).toMatchObject(own);
    // A trashed project is nobody's to work in.
    await t.run(async (ctx) => ctx.db.patch(team.projectId, { deletedAt: 5 }));
    expect(await ask(MEMBER, team.projectId)).toMatchObject(own);
    // Signed out has no answer at all, like `mine`.
    expect(await t.query(api.entitlements.forProject, { projectId: team.projectId })).toBeNull();
  });

  test("a guest an editor link let in writes on the workspace's allowance", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const team = await project(t, {
      ownerId: MEMBER.subject,
      workspaceId,
      editShareToken: "edit-token",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("shareClaims", {
        projectId: team.projectId,
        granteeId: GUEST.subject,
        role: "editor",
        createdAt: 1,
      });
    });
    expect(
      await t
        .withIdentity(GUEST)
        .query(api.entitlements.forProject, { projectId: team.projectId }),
    ).toMatchObject({ source: "workspace" });
  });
});

describe("metering", () => {
  test("a chat in a workspace project spends nothing of the person's own", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await spent(t, MEMBER, "chats");
    const team = await project(t, { ownerId: OTHER.subject, workspaceId });
    const me = t.withIdentity(MEMBER);
    const threadId = await me.mutation(api.chat.threads.create, { projectId: team.projectId });

    await me.mutation(api.entitlements.beginChat, { threadId, projectId: team.projectId });
    expect((await t.run(async (ctx) => await ctx.db.get(threadId)))?.billedAt).toBeUndefined();
    expect((await account(t, MEMBER))?.chatConversations).toBe(FREE_LIMITS.chats);

    // The same person, spent, in their own project: the wall.
    const personal = await project(t, { ownerId: MEMBER.subject });
    const own = await me.mutation(api.chat.threads.create, { projectId: personal.projectId });
    await expect(me.mutation(api.entitlements.beginChat, { threadId: own })).rejects.toSatisfy(
      refusedFor("chats"),
    );
  });

  test("an accepted completion in a workspace page spends nothing of the person's own", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const team = await project(t, { ownerId: OTHER.subject, workspaceId });
    const personal = await project(t, { ownerId: MEMBER.subject });
    const settled = { kind: "code", gateOk: true, shown: true, latencyMs: 1, outcome: "accepted" as const };
    const me = t.withIdentity(MEMBER);

    await me.mutation(api.ai.suggestions.log, { pageId: team.pageId, ...settled });
    expect((await account(t, MEMBER))?.acceptedCompletions ?? 0).toBe(0);
    await me.mutation(api.ai.suggestions.log, { pageId: personal.pageId, ...settled });
    expect((await account(t, MEMBER))?.acceptedCompletions).toBe(1);
  });
});

describe("beginChat asks the thread's project", () => {
  test("refuses a thread charged against a project it is not about", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const team = await project(t, { ownerId: OTHER.subject, workspaceId });
    const personal = await project(t, { ownerId: MEMBER.subject });
    const me = t.withIdentity(MEMBER);
    const threadId = await me.mutation(api.chat.threads.create, { projectId: personal.projectId });
    await expect(
      me.mutation(api.entitlements.beginChat, { threadId, projectId: team.projectId }),
    ).rejects.toThrow("Not found");
    expect((await t.run(async (ctx) => await ctx.db.get(threadId)))?.billedAt).toBeUndefined();
  });

  test("a thread already paid for is no pass once its author can only read", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await project(t, {
      ownerId: OWNER.subject,
      shareToken: "view-token",
      editShareToken: "edit-token",
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("shareClaims", {
        projectId,
        granteeId: GUEST.subject,
        role: "editor",
        createdAt: 1,
      });
    });
    const guest = t.withIdentity(GUEST);
    const threadId = await guest.mutation(api.chat.threads.create, { projectId });
    await guest.mutation(api.entitlements.beginChat, { threadId, projectId });
    expect((await t.run(async (ctx) => await ctx.db.get(threadId)))?.billedAt).toBeDefined();

    // The editor link is revoked; the view link still stands.
    await t.run(async (ctx) => ctx.db.patch(projectId, { editShareToken: undefined }));
    await expect(guest.mutation(api.entitlements.beginChat, { threadId })).rejects.toThrow(
      "Not found",
    );
  });

  test("a removed member's thread stops at once, billed or not", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const team = await project(t, { ownerId: OTHER.subject, workspaceId });
    const member = t.withIdentity(MEMBER);
    const threadId = await member.mutation(api.chat.threads.create, { projectId: team.projectId });
    await member.mutation(api.entitlements.beginChat, { threadId });

    await t.withIdentity(ADMIN).mutation(api.members.remove, {
      workspaceId,
      userId: MEMBER.subject,
    });
    await expect(member.mutation(api.entitlements.beginChat, { threadId })).rejects.toThrow(
      "Not found",
    );
  });
});

describe("the ledger charges the container, and works it out itself", () => {
  const call = {
    feature: "chat" as const,
    model: "m",
    latencyMs: 1,
    status: "ok" as const,
    costUsd: 0.01,
  };

  async function rows(t: T) {
    return await t.run(async (ctx) => await ctx.db.query("aiCalls").collect());
  }

  test("a call in a workspace project is the workspace's", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const team = await project(t, { ownerId: OTHER.subject, workspaceId });
    await t.withIdentity(MEMBER).mutation(api.ai.calls.record, {
      ...call,
      projectId: team.projectId,
    });
    expect(await rows(t)).toMatchObject([{ ownerId: MEMBER.subject, workspaceId }]);
  });

  test("naming a workspace's project buys no charge to it", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const team = await project(t, { ownerId: OTHER.subject, workspaceId });
    const secret = await project(t, { ownerId: OTHER.subject, workspaceId, visibility: "private" });
    const personal = await project(t, { ownerId: MEMBER.subject });
    const record = (who: Identity, projectId?: string) =>
      t.withIdentity(who).mutation(api.ai.calls.record, { ...call, projectId });

    await record(STRANGER, team.projectId);
    await record(GUEST, team.projectId);
    await record(MEMBER, secret.projectId);
    await record(MEMBER, personal.projectId);
    await record(MEMBER, "not-an-id");
    await record(MEMBER);
    const ledger = await rows(t);
    // Every row still lands — a lost row is a cost nobody sees — and none of
    // them is the workspace's.
    expect(ledger).toHaveLength(6);
    expect(ledger.every((row) => row.workspaceId === undefined)).toBe(true);
  });

  test("an operator standing in writes nothing", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.withIdentity({ ...MEMBER, act: "ops_session_1" }).mutation(api.ai.calls.record, call),
    ).rejects.toThrow("Read-only");
  });
});
