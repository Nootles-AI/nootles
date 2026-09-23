/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";
import { EDIT_WINDOW_MS, RETAIN_MS } from "./audit";

/**
 * A workspace's audit log: every discrete change writes exactly one row, by
 * the right actor about the right subject, in the mutation that made it;
 * editing folds into one row per page, person and window; a personal project
 * writes nothing; only admins read it, on a plan that includes it; a year is
 * all it keeps; and an operator standing in for someone is told to every
 * workspace that person sits in.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

type Identity = { subject: string; email?: string; act?: string };

const OWNER = { subject: "user_ws_owner", email: "olive@acme.com" };
const ADMIN = { subject: "user_ws_admin", email: "ada@acme.com" };
const MEMBER = { subject: "user_member", email: "max@acme.com" };
const GUEST = { subject: "user_guest", email: "gus@partner.io" };
const STRANGER = { subject: "user_stranger", email: "sal@elsewhere.org" };
const NEWCOMER = { subject: "user_newcomer", email: "nia@acme.com" };

const NOW = Date.UTC(2026, 8, 23, 12);
const DAY = 24 * 60 * 60_000;
/** What a page says. The log must never carry it. */
const PROSE = "The launch slips to March because the vendor";

type T = TestConvex<typeof schema>;

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  return t;
}

beforeEach(() => {
  // Fake timers hold every scheduled read (repositories, files, Notion) back,
  // and `fetch` answers nothing, so no test here reaches anything outside.
  vi.useFakeTimers({ now: NOW });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function workspace(
  t: T,
  slug: string,
  seats: [Identity, Doc<"memberships">["role"], Doc<"memberships">["status"]?][],
  settings: Partial<Doc<"workspaces">["settings"]> = {},
) {
  return await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      slug,
      name: slug.toUpperCase(),
      createdBy: OWNER.subject,
      plan: "team",
      settings: {
        linkSharing: true,
        guestCodeAccess: false,
        joinDomains: [],
        autoJoin: false,
        ...settings,
      },
      createdAt: 1,
    });
    await ctx.db.insert("workspaceSlugs", { slug, workspaceId });
    for (const [who, role, status] of seats) {
      await ctx.db.insert("memberships", {
        workspaceId,
        userId: who.subject,
        role,
        status: status ?? "active",
        joinedAt: 1,
      });
    }
    // On Team, so its log may be read and its projects are unmetered.
    await ctx.db.insert("workspaceEntitlements", {
      workspaceId,
      feature: "plan",
      value: "team",
      note: "test",
      grantedBy: "test",
      grantedAt: 1,
    });
    return workspaceId;
  });
}

/** Acme, with a project and a page in it, and the owner's own project beside it. */
async function world(t: T, settings: Partial<Doc<"workspaces">["settings"]> = {}) {
  const workspaceId = await workspace(
    t,
    "acme",
    [
      [OWNER, "owner"],
      [ADMIN, "admin"],
      [MEMBER, "member"],
      [GUEST, "guest"],
    ],
    settings,
  );
  return await t.run(async (ctx) => {
    for (const who of [OWNER, ADMIN, MEMBER, GUEST, STRANGER]) {
      await ctx.db.insert("profiles", {
        ownerId: who.subject,
        email: who.email,
        name: who.subject.replace("user_", ""),
        status: "done",
        createdAt: 1,
      });
    }
    const projectId = await ctx.db.insert("projects", {
      ownerId: MEMBER.subject,
      title: "Roadmap",
      createdAt: 1,
      workspaceId,
      visibility: "workspace",
    });
    const docId = crypto.randomUUID();
    const pageId = await ctx.db.insert("pages", {
      ownerId: MEMBER.subject,
      projectId,
      title: "Launch",
      order: 0,
      docId,
      createdAt: 1,
    });
    const personalId = await ctx.db.insert("projects", {
      ownerId: OWNER.subject,
      title: "Mine",
      createdAt: 1,
    });
    const personalDocId = crypto.randomUUID();
    const personalPageId = await ctx.db.insert("pages", {
      ownerId: OWNER.subject,
      projectId: personalId,
      title: "Diary",
      order: 0,
      docId: personalDocId,
      createdAt: 1,
    });
    return { workspaceId, projectId, docId, pageId, personalId, personalDocId, personalPageId };
  });
}

async function log(t: T, workspaceId?: Id<"workspaces">) {
  return await t.run(async (ctx) =>
    workspaceId
      ? await ctx.db
          .query("auditEvents")
          .withIndex("by_workspace_at", (q) => q.eq("workspaceId", workspaceId))
          .collect()
      : await ctx.db.query("auditEvents").collect(),
  );
}

/** Runs `act` and returns the one row it logged — failing if it logged none, or more. */
async function one(t: T, workspaceId: Id<"workspaces">, act: () => Promise<unknown>) {
  const before = new Set((await log(t, workspaceId)).map((row) => row._id));
  await act();
  const added = (await log(t, workspaceId)).filter((row) => !before.has(row._id));
  expect(added.map((row) => row.action)).toHaveLength(1);
  return added[0];
}

function update(text: string): ArrayBuffer {
  const doc = new Y.Doc();
  doc.getText("t").insert(0, text);
  const u = Y.encodeStateAsUpdate(doc);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

describe("the workspace itself", () => {
  test("create, rename, address, each setting and delete write one row each", async () => {
    vi.stubEnv("TEAMS_ROLLOUT", "on");
    const t = harness();
    const owner = t.withIdentity(OWNER);
    const { workspaceId } = await owner.mutation(api.workspaces.create, { name: "Beta" });
    const created = (await log(t, workspaceId))[0];
    expect(created).toMatchObject({
      action: "workspace.create",
      category: "workspace",
      actorId: OWNER.subject,
      actorKind: "user",
      subjectKind: "workspace",
      subjectId: workspaceId,
    });

    expect(
      await one(t, workspaceId, () => owner.mutation(api.workspaces.rename, { workspaceId, name: "Gamma" })),
    ).toMatchObject({ action: "workspace.rename", meta: { from: "Beta", to: "Gamma" } });
    expect(
      await one(t, workspaceId, () => owner.mutation(api.workspaces.setSlug, { workspaceId, slug: "gamma" })),
    ).toMatchObject({ action: "workspace.slug", meta: { from: "beta", to: "gamma" } });
    expect(
      await one(t, workspaceId, () =>
        owner.mutation(api.workspaces.updateSettings, {
          workspaceId,
          patch: { allowPersonalTokens: false },
        }),
      ),
    ).toMatchObject({
      action: "workspace.settings",
      meta: { setting: "allowPersonalTokens", from: null, to: false },
    });
    // Two settings at once are two events, one sentence each.
    await owner.mutation(api.workspaces.updateSettings, {
      workspaceId,
      patch: { linkSharing: false, linkTtlDays: 30, guestCodeAccess: false },
    });
    const settings = (await log(t, workspaceId)).filter((r) => r.action === "workspace.settings");
    expect(settings.map((r) => r.meta?.setting).sort()).toEqual([
      "allowPersonalTokens",
      "linkSharing",
      "linkTtlDays",
    ]);

    // Unchanged is not news.
    await owner.mutation(api.workspaces.rename, { workspaceId, name: "Gamma" });
    expect(
      await one(t, workspaceId, () => owner.mutation(api.workspaces.remove, { workspaceId })),
    ).toMatchObject({ action: "workspace.delete", actorId: OWNER.subject, meta: { projects: 0 } });
    expect((await log(t, workspaceId)).filter((r) => r.action === "workspace.rename")).toHaveLength(1);
  });
});

describe("membership", () => {
  test("invite, renew and withdraw an invitation", async () => {
    const t = harness();
    const { workspaceId } = await world(t);
    const admin = t.withIdentity(ADMIN);
    const invited = await one(t, workspaceId, () =>
      admin.mutation(api.members.invite, { workspaceId, email: "Nia@acme.com", role: "member" }),
    );
    expect(invited).toMatchObject({
      action: "member.invite",
      actorId: ADMIN.subject,
      subjectKind: "invitation",
      meta: { email: "nia@acme.com", role: "member", renewed: false },
    });
    const renewed = await one(t, workspaceId, () =>
      admin.mutation(api.members.invite, { workspaceId, email: "nia@acme.com", role: "guest" }),
    );
    expect(renewed).toMatchObject({ subjectId: invited.subjectId, meta: { renewed: true, role: "guest" } });
    expect(
      await one(t, workspaceId, () =>
        admin.mutation(api.members.revokeInvite, {
          invitationId: invited.subjectId as Id<"invitations">,
        }),
      ),
    ).toMatchObject({ action: "member.invite.revoke", meta: { email: "nia@acme.com" } });
  });

  test("accepting an invitation and joining by domain are joins, by the joiner", async () => {
    const t = harness();
    const { workspaceId } = await world(t, { autoJoin: true, joinDomains: ["acme.com"] });
    await t.run(async (ctx) => {
      await ctx.db.insert("workspaceDomains", { domain: "acme.com", workspaceId });
    });
    const { token } = await t
      .withIdentity(ADMIN)
      .mutation(api.members.invite, { workspaceId, email: NEWCOMER.email, role: "member" });
    expect(
      await one(t, workspaceId, () =>
        t.withIdentity(NEWCOMER).mutation(api.members.acceptInvite, { token }),
      ),
    ).toMatchObject({
      action: "member.join",
      actorId: NEWCOMER.subject,
      subjectKind: "user",
      subjectId: NEWCOMER.subject,
      meta: { via: "invitation", role: "member", invitedBy: ADMIN.subject },
    });
    // Accepting again changes nothing, and says nothing.
    await t.withIdentity(NEWCOMER).mutation(api.members.acceptInvite, { token });

    const DEE = { subject: "user_dee", email: "dee@acme.com" };
    expect(
      await one(t, workspaceId, () =>
        t.withIdentity(DEE).mutation(api.members.joinByDomain, { workspaceId }),
      ),
    ).toMatchObject({ action: "member.join", actorId: DEE.subject, meta: { via: "domain" } });
    await t.withIdentity(DEE).mutation(api.members.joinByDomain, { workspaceId });
    expect((await log(t, workspaceId)).filter((r) => r.action === "member.join")).toHaveLength(2);
  });

  test("a role change, a removal and leaving name who they were about", async () => {
    const t = harness();
    const { workspaceId } = await world(t);
    expect(
      await one(t, workspaceId, () =>
        t.withIdentity(OWNER).mutation(api.members.setRole, {
          workspaceId,
          userId: MEMBER.subject,
          role: "admin",
        }),
      ),
    ).toMatchObject({
      action: "member.role",
      actorId: OWNER.subject,
      subjectId: MEMBER.subject,
      meta: { from: "member", to: "admin" },
    });
    expect(
      await one(t, workspaceId, () =>
        t.withIdentity(ADMIN).mutation(api.members.remove, { workspaceId, userId: GUEST.subject }),
      ),
    ).toMatchObject({ action: "member.remove", actorId: ADMIN.subject, subjectId: GUEST.subject });
    expect(
      await one(t, workspaceId, () => t.withIdentity(MEMBER).mutation(api.members.leave, { workspaceId })),
    ).toMatchObject({
      action: "member.leave",
      actorId: MEMBER.subject,
      subjectId: MEMBER.subject,
      meta: { heir: OWNER.subject },
    });
  });

  test("a refused change writes nothing", async () => {
    const t = harness();
    const { workspaceId } = await world(t);
    await expect(
      t.withIdentity(MEMBER).mutation(api.members.remove, { workspaceId, userId: GUEST.subject }),
    ).rejects.toThrow();
    await expect(
      t.withIdentity(ADMIN).mutation(api.members.remove, { workspaceId, userId: OWNER.subject }),
    ).rejects.toThrow();
    expect(await log(t, workspaceId)).toEqual([]);
  });
});

describe("sharing", () => {
  test("a link on, its expiry moved, and off", async () => {
    const t = harness();
    const { workspaceId, projectId } = await world(t);
    const admin = t.withIdentity(ADMIN);
    expect(
      await one(t, workspaceId, () =>
        admin.mutation(api.share.setLink, { projectId, role: "editor", enabled: true }),
      ),
    ).toMatchObject({
      action: "share.link.on",
      actorId: ADMIN.subject,
      subjectKind: "project",
      subjectId: projectId,
      meta: { role: "editor", projectId, project: "Roadmap" },
    });
    expect(
      await one(t, workspaceId, () =>
        admin.mutation(api.share.setLink, {
          projectId,
          role: "editor",
          enabled: true,
          expiresInDays: 7,
        }),
      ),
    ).toMatchObject({ action: "share.link.expiry", meta: { expiresAt: NOW + 7 * DAY } });
    // Pressing it again with nothing to change is not an event.
    await admin.mutation(api.share.setLink, { projectId, role: "editor", enabled: true });
    expect(
      await one(t, workspaceId, () =>
        admin.mutation(api.share.setLink, { projectId, role: "editor", enabled: false }),
      ),
    ).toMatchObject({ action: "share.link.off" });
    await admin.mutation(api.share.setLink, { projectId, role: "editor", enabled: false });
    expect(await log(t, workspaceId)).toHaveLength(3);
  });

  test("a claim, code access, an edit request answered, and a claim revoked", async () => {
    const t = harness();
    const { workspaceId, projectId } = await world(t, { guestCodeAccess: true });
    const admin = t.withIdentity(ADMIN);
    const token = (await admin.mutation(api.share.setLink, {
      projectId,
      role: "viewer",
      enabled: true,
    }))!;

    expect(
      await one(t, workspaceId, () => t.withIdentity(STRANGER).mutation(api.share.claim, { token })),
    ).toMatchObject({
      action: "share.claim",
      actorId: STRANGER.subject,
      subjectId: STRANGER.subject,
      meta: { role: "viewer" },
    });
    // Visiting the same link again is not a new claim.
    await t.withIdentity(STRANGER).mutation(api.share.claim, { token });
    await t.withIdentity(GUEST).mutation(api.share.claim, { token });

    expect(
      await one(t, workspaceId, () =>
        admin.mutation(api.share.setCodeAccess, { projectId, granteeId: GUEST.subject, allowed: true }),
      ),
    ).toMatchObject({ action: "share.code.grant", subjectId: GUEST.subject });
    expect(
      await one(t, workspaceId, () =>
        admin.mutation(api.share.setCodeAccess, { projectId, granteeId: GUEST.subject, allowed: false }),
      ),
    ).toMatchObject({ action: "share.code.revoke", subjectId: GUEST.subject });

    const requestId = (await t
      .withIdentity(STRANGER)
      .mutation(api.share.requestEdit, { projectId }))!;
    expect(
      await one(t, workspaceId, () =>
        admin.mutation(api.share.decideRequest, { requestId, grant: true }),
      ),
    ).toMatchObject({ action: "share.request.grant", actorId: ADMIN.subject, subjectId: STRANGER.subject });
    await t.withIdentity(GUEST).mutation(api.share.requestEdit, { projectId });
    const guestRequest = (await t.withIdentity(GUEST).mutation(api.share.requestEdit, { projectId }))!;
    expect(
      await one(t, workspaceId, () =>
        admin.mutation(api.share.decideRequest, { requestId: guestRequest, grant: false }),
      ),
    ).toMatchObject({ action: "share.request.deny", subjectId: GUEST.subject });

    expect(
      await one(t, workspaceId, () =>
        admin.mutation(api.share.revokeClaim, { projectId, granteeId: STRANGER.subject }),
      ),
    ).toMatchObject({ action: "share.claim.revoke", subjectId: STRANGER.subject, meta: { role: "editor" } });
  });
});

describe("projects, pages and folders", () => {
  test("create, rename, delete and restore a project", async () => {
    const t = harness();
    const { workspaceId } = await world(t);
    const member = t.withIdentity(MEMBER);
    const projectId = await member.mutation(api.projects.create, {
      title: "Plan",
      workspaceId,
      visibility: "private",
    });
    const created = (await log(t, workspaceId)).find((r) => r.action === "project.create");
    expect(created).toMatchObject({
      actorId: MEMBER.subject,
      subjectId: projectId,
      meta: { visibility: "private", project: "Plan" },
    });
    const admin = t.withIdentity(ADMIN);
    expect(
      await one(t, workspaceId, () => admin.mutation(api.projects.rename, { projectId, title: "Plan B" })),
    ).toMatchObject({ action: "project.rename", meta: { from: "Plan", to: "Plan B" } });
    expect(
      await one(t, workspaceId, () => admin.mutation(api.projects.remove, { projectId })),
    ).toMatchObject({ action: "project.delete", actorId: ADMIN.subject, subjectId: projectId });
    expect(
      await one(t, workspaceId, () => admin.mutation(api.trash.restore, { projects: [projectId] })),
    ).toMatchObject({ action: "project.restore", subjectId: projectId });
  });

  test("a page and a folder deleted and restored", async () => {
    const t = harness();
    const { workspaceId, projectId, pageId } = await world(t);
    const member = t.withIdentity(MEMBER);
    expect(
      await one(t, workspaceId, () => member.mutation(api.pages.remove, { pageId })),
    ).toMatchObject({ action: "page.delete", subjectId: pageId, meta: { page: "Launch", projectId } });
    expect(
      await one(t, workspaceId, () => member.mutation(api.trash.restore, { pages: [pageId] })),
    ).toMatchObject({ action: "page.restore", subjectId: pageId });
    expect(
      await one(t, workspaceId, () => member.mutation(api.trash.remove, { pages: [pageId] })),
    ).toMatchObject({ action: "page.delete", subjectId: pageId });

    const folderId = await t.run((ctx) =>
      ctx.db.insert("folders", { ownerId: MEMBER.subject, projectId, title: "Specs", order: 1, createdAt: 1 }),
    );
    expect(
      await one(t, workspaceId, () => member.mutation(api.folders.remove, { folderId })),
    ).toMatchObject({ action: "folder.delete", subjectId: folderId, meta: { folder: "Specs" } });
    expect(
      await one(t, workspaceId, () => member.mutation(api.trash.restore, { folders: [folderId] })),
    ).toMatchObject({ action: "folder.restore", subjectId: folderId });
  });

  test("a folder's delete, its undo and its redo are one row each, whatever it holds", async () => {
    const t = harness();
    const { workspaceId, projectId } = await world(t);
    const member = t.withIdentity(MEMBER);
    const { folderId, looseId } = await t.run(async (ctx) => {
      const row = { ownerId: MEMBER.subject, projectId, createdAt: 1 };
      const folderId = await ctx.db.insert("folders", { ...row, title: "Specs", order: 1 });
      const subId = await ctx.db.insert("folders", { ...row, title: "Old", order: 0, parentId: folderId });
      for (const [i, folder] of [folderId, folderId, subId].entries()) {
        await ctx.db.insert("pages", {
          ...row,
          title: `Spec ${i}`,
          order: i,
          folderId: folder,
          docId: crypto.randomUUID(),
        });
      }
      const looseId = await ctx.db.insert("pages", {
        ...row,
        title: "Loose",
        order: 2,
        docId: crypto.randomUUID(),
      });
      return { folderId, looseId };
    });

    // The sidebar's undo and redo hand back exactly what the delete marked.
    let marked!: { pages: Id<"pages">[]; folders: Id<"folders">[] };
    expect(
      await one(t, workspaceId, async () => {
        marked = await member.mutation(api.folders.remove, { folderId });
      }),
    ).toMatchObject({ action: "folder.delete", subjectId: folderId, meta: { folder: "Specs", pages: 3 } });
    expect(marked.pages).toHaveLength(3);
    expect(marked.folders).toHaveLength(2);

    const whole = { action: "folder.restore", subjectId: folderId, meta: { folder: "Specs", pages: 3 } };
    expect(await one(t, workspaceId, () => member.mutation(api.trash.restore, marked))).toMatchObject(
      whole,
    );
    expect(await one(t, workspaceId, () => member.mutation(api.trash.remove, marked))).toMatchObject({
      ...whole,
      action: "folder.delete",
    });

    // A page of the same call that sits outside the folder is its own event.
    await member.mutation(api.pages.remove, { pageId: looseId });
    const before = (await log(t, workspaceId)).length;
    await member.mutation(api.trash.restore, { ...marked, pages: [...marked.pages, looseId] });
    const added = (await log(t, workspaceId)).slice(before);
    expect(added.map((row) => [row.action, row.subjectId])).toEqual([
      ["folder.restore", folderId],
      ["page.restore", looseId],
    ]);
  });
});

describe("carrying out and moving", () => {
  /** A second Acme project, and the owner's personal one, to carry into. */
  async function places(t: T, workspaceId: Id<"workspaces">) {
    return await t.run(async (ctx) => ({
      opsId: await ctx.db.insert("projects", {
        ownerId: MEMBER.subject,
        title: "Ops",
        createdAt: 1,
        workspaceId,
        visibility: "workspace",
      }),
      memberOwnId: await ctx.db.insert("projects", {
        ownerId: MEMBER.subject,
        title: "Max’s",
        createdAt: 1,
      }),
    }));
  }

  test("a copy out of the workspace is one row, and says it was a copy", async () => {
    const t = harness();
    const { workspaceId, projectId, pageId } = await world(t);
    const { memberOwnId } = await places(t, workspaceId);
    expect(
      await one(t, workspaceId, () =>
        t.withIdentity(MEMBER).mutation(api.tree.copyTo, {
          items: [{ kind: "page", id: pageId }],
          projectId: memberOwnId,
        }),
      ),
    ).toMatchObject({
      action: "page.carryOut",
      actorId: MEMBER.subject,
      subjectKind: "page",
      subjectId: pageId,
      meta: { page: "Launch", to: "personal", move: false, projectId, project: "Roadmap" },
    });
  });

  test("a move out of the workspace is one row, not a carry and a delete", async () => {
    const t = harness();
    const { workspaceId, pageId } = await world(t);
    const { memberOwnId } = await places(t, workspaceId);
    expect(
      await one(t, workspaceId, () =>
        t.withIdentity(MEMBER).mutation(api.tree.copyTo, {
          items: [{ kind: "page", id: pageId }],
          projectId: memberOwnId,
          move: true,
        }),
      ),
    ).toMatchObject({
      action: "page.carryOut",
      subjectId: pageId,
      meta: { page: "Launch", to: "personal", move: true },
    });
  });

  test("a move between two of its projects is one move, and a folder counts its pages", async () => {
    const t = harness();
    const { workspaceId, projectId, pageId } = await world(t);
    const { opsId } = await places(t, workspaceId);
    const member = t.withIdentity(MEMBER);
    expect(
      await one(t, workspaceId, () =>
        member.mutation(api.tree.copyTo, {
          items: [{ kind: "page", id: pageId }],
          projectId: opsId,
          move: true,
        }),
      ),
    ).toMatchObject({
      action: "page.move",
      actorId: MEMBER.subject,
      subjectId: pageId,
      meta: { page: "Launch", projectId, project: "Roadmap", toProjectId: opsId, toProject: "Ops" },
    });

    const folderId = await t.run(async (ctx) => {
      const row = { ownerId: MEMBER.subject, projectId, createdAt: 1 };
      const folderId = await ctx.db.insert("folders", { ...row, title: "Specs", order: 1 });
      await ctx.db.insert("pages", { ...row, title: "Spec", order: 0, folderId, docId: crypto.randomUUID() });
      return folderId;
    });
    expect(
      await one(t, workspaceId, () =>
        member.mutation(api.tree.copyTo, {
          items: [{ kind: "folder", id: folderId }],
          projectId: opsId,
          move: true,
        }),
      ),
    ).toMatchObject({ action: "folder.move", subjectId: folderId, meta: { folder: "Specs", pages: 1 } });

    // A copy that stays inside the workspace takes nothing out of it.
    const [spec] = await t.run((ctx) =>
      ctx.db
        .query("pages")
        .withIndex("by_project", (q) => q.eq("projectId", opsId))
        .collect(),
    );
    const before = (await log(t, workspaceId)).length;
    await member.mutation(api.tree.copyTo, {
      items: [{ kind: "page", id: spec._id }],
      projectId,
    });
    expect(await log(t, workspaceId)).toHaveLength(before);
  });
});

describe("integrations and context", () => {
  test("a GitHub installation recorded, suspended and removed; the organisation rule", async () => {
    const t = harness();
    const { workspaceId } = await world(t);
    const record = {
      workspaceId,
      installationId: 42,
      accountLogin: "acme",
      accountType: "Organization" as const,
      repositorySelection: "selected" as const,
      suspended: false,
    };
    expect(
      await one(t, workspaceId, () =>
        t.withIdentity(ADMIN).mutation(internal.github.installations.record, record),
      ),
    ).toMatchObject({
      action: "github.installation.record",
      actorId: ADMIN.subject,
      subjectKind: "githubInstallation",
      subjectId: "42",
      meta: { account: "acme", reinstalled: false },
    });
    expect(
      await one(t, workspaceId, () =>
        t.withIdentity(ADMIN).mutation(api.github.app.setOrgRule, { workspaceId, org: "ACME" }),
      ),
    ).toMatchObject({ action: "github.orgRule", meta: { from: null, to: "acme" } });
    expect(
      await one(t, workspaceId, () =>
        t.mutation(internal.github.installations.onInstallation, {
          installationId: 42,
          action: "suspend",
        }),
      ),
    ).toMatchObject({ action: "github.installation.suspend", actorId: "github", actorKind: "system" });
    // GitHub delivering the same event twice changes nothing the second time.
    await t.mutation(internal.github.installations.onInstallation, { installationId: 42, action: "suspend" });
    expect(
      await one(t, workspaceId, () =>
        t.mutation(internal.github.installations.onInstallation, {
          installationId: 42,
          action: "deleted",
        }),
      ),
    ).toMatchObject({ action: "github.installation.remove", meta: { unlinked: 0 } });
  });

  test("a repository, a Notion page and a file, each added and taken away", async () => {
    const t = harness();
    const { workspaceId, projectId } = await world(t);
    await t.run((ctx) =>
      ctx.db.insert("githubInstallations", {
        workspaceId,
        installationId: 42,
        accountLogin: "acme",
        accountType: "Organization",
        repositorySelection: "selected",
        installedBy: ADMIN.subject,
        createdAt: 1,
      }),
    );
    const admin = t.withIdentity(ADMIN);
    const linked = await one(t, workspaceId, () =>
      admin.mutation(api.github.repos.link, {
        projectId,
        repos: [{ fullName: "acme/rover", defaultBranch: "main", private: true, installationId: 42 }],
      }),
    );
    expect(linked).toMatchObject({
      action: "repo.link",
      subjectKind: "repo",
      meta: { repo: "acme/rover", via: "app", projectId },
    });
    expect(
      await one(t, workspaceId, () =>
        admin.mutation(api.github.repos.unlink, { repoId: linked.subjectId as Id<"projectRepos"> }),
      ),
    ).toMatchObject({ action: "repo.unlink", meta: { repo: "acme/rover" } });

    const notion = await one(t, workspaceId, () =>
      admin.mutation(api.notion.context.link, {
        projectId,
        pages: [{ pageId: "abc-123", title: "Brief" }],
      }),
    );
    expect(notion).toMatchObject({ action: "notion.link", meta: { page: "Brief" } });
    expect(
      await one(t, workspaceId, () =>
        admin.mutation(api.notion.context.unlink, { rowId: notion.subjectId as Id<"projectNotion"> }),
      ),
    ).toMatchObject({ action: "notion.unlink", meta: { page: "Brief" } });

    const storageId = await t.run((ctx) => ctx.storage.store(new Blob([PROSE])));
    const added = await one(t, workspaceId, () =>
      admin.mutation(api.files.context.add, {
        projectId,
        storageId,
        filename: "notes.md",
        mediaType: "text/markdown",
      }),
    );
    expect(added).toMatchObject({ action: "file.add", meta: { file: "notes.md" } });
    expect(
      await one(t, workspaceId, () =>
        admin.mutation(api.files.context.remove, { fileId: added.subjectId as Id<"projectFiles"> }),
      ),
    ).toMatchObject({ action: "file.remove", meta: { file: "notes.md" } });
  });
});

describe("billing and operators", () => {
  const subscription = {
    subscriptionId: "sub_1",
    status: "active",
    seatItemId: "si_seat",
    usageItemId: "si_usage",
    seats: 3,
    periodStart: NOW,
    periodEnd: NOW + 30 * DAY,
    cancelAtPeriodEnd: false,
  };

  // Checkout is an action that reaches Stripe; its row is tested beside
  // Stripe's mock, in teamBilling.test.ts.
  test("a change of subscription status, and a seat sync", async () => {
    const t = harness();
    const { workspaceId } = await world(t);
    const mirror = (status: string) =>
      t.mutation(internal.teamBilling.applyMirror, {
        workspaceId,
        stripeCustomerId: "cus_1",
        subscription: { ...subscription, status },
      });
    expect(await one(t, workspaceId, () => mirror("active"))).toMatchObject({
      action: "billing.subscription",
      actorId: "stripe",
      actorKind: "system",
      meta: { from: "none", to: "active", seats: 3 },
    });
    // Stripe telling us again what we already hold is not a change.
    await mirror("active");
    expect(await one(t, workspaceId, () => mirror("past_due"))).toMatchObject({
      meta: { from: "active", to: "past_due" },
    });
    expect(
      await one(t, workspaceId, () =>
        t.mutation(internal.teamBilling.recordSeats, { workspaceId, seats: 4 }),
      ),
    ).toMatchObject({ action: "billing.seats", actorKind: "system", meta: { from: 3, to: 4 } });
    await t.mutation(internal.teamBilling.recordSeats, { workspaceId, seats: 4 });
    expect(await log(t, workspaceId)).toHaveLength(3);
  });

  test("an operator's override set and cleared", async () => {
    const t = harness();
    const { workspaceId } = await world(t);
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("adminSessions", { token: "ops", createdAt: 1, expiresAt: NOW + DAY }),
    );
    expect(
      await one(t, workspaceId, () =>
        t.mutation(api.adminBilling.workspaceOverrideSet, {
          token: "ops",
          workspaceId,
          feature: "guestDailyAiUsd",
          value: 3,
          note: "Asked for by their CTO",
        }),
      ),
    ).toMatchObject({
      action: "entitlement.set",
      actorId: sessionId,
      actorKind: "operator",
      meta: { feature: "guestDailyAiUsd", value: 3 },
    });
    expect(
      await one(t, workspaceId, () =>
        t.mutation(api.adminBilling.workspaceOverrideClear, {
          token: "ops",
          workspaceId,
          feature: "guestDailyAiUsd",
        }),
      ),
    ).toMatchObject({ action: "entitlement.clear", actorKind: "operator" });
    await t.mutation(api.adminBilling.workspaceOverrideClear, {
      token: "ops",
      workspaceId,
      feature: "guestDailyAiUsd",
    });
    expect(await log(t, workspaceId)).toHaveLength(2);
  });

  test("a stand-in is written to every workspace its subject sits in", async () => {
    const t = harness();
    const { workspaceId } = await world(t);
    const other = await workspace(t, "other", [
      [OWNER, "owner"],
      [MEMBER, "guest"],
    ]);
    const left = await workspace(t, "left", [
      [OWNER, "owner"],
      [MEMBER, "member", "removed"],
    ]);
    const unrelated = await workspace(t, "unrelated", [[OWNER, "owner"]]);
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("adminSessions", { token: "ops", createdAt: 1, expiresAt: NOW + DAY }),
    );
    const { jti } = await t.mutation(internal.impersonation.begin, {
      token: "ops",
      subject: MEMBER.subject,
      reason: "Their sidebar is empty",
    });
    for (const id of [workspaceId, other]) {
      const rows = await log(t, id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "operator.standIn",
        actorId: sessionId,
        actorKind: "operator",
        subjectKind: "user",
        subjectId: MEMBER.subject,
        meta: { reason: "Their sidebar is empty", sessionId: jti },
      });
    }
    expect(await log(t, left)).toEqual([]);
    expect(await log(t, unrelated)).toEqual([]);
  });
});

describe("edit activity", () => {
  async function opened(t: T, docId: string) {
    await t.withIdentity(MEMBER).mutation(api.ydoc.init, { docId, update: update(PROSE) });
  }
  const edit = (t: T, who: Identity, docId: string) =>
    t.withIdentity(who).mutation(api.ydoc.append, { docId, update: update(PROSE) });

  test("one window, one person, one page is one row that counts", async () => {
    const t = harness();
    const { workspaceId, docId, pageId, projectId } = await world(t);
    await opened(t, docId);
    for (let i = 0; i < 3; i++) await edit(t, MEMBER, docId);
    const rows = await log(t, workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "page.edit",
      actorId: MEMBER.subject,
      subjectKind: "page",
      subjectId: pageId,
      count: 3,
      meta: { page: "Launch", project: "Roadmap", projectId },
    });
    expect(JSON.stringify(rows)).not.toContain("launch slips");
    expect(JSON.stringify(rows)).not.toContain(PROSE);
  });

  test("a new window is a new row, and another person is their own", async () => {
    const t = harness();
    const { workspaceId, docId } = await world(t);
    await opened(t, docId);
    vi.setSystemTime(Math.floor(NOW / EDIT_WINDOW_MS) * EDIT_WINDOW_MS + EDIT_WINDOW_MS - 1);
    await edit(t, MEMBER, docId);
    await edit(t, ADMIN, docId);
    vi.advanceTimersByTime(1);
    await edit(t, MEMBER, docId);
    await edit(t, MEMBER, docId);
    const rows = (await log(t, workspaceId)).map((r) => [r.actorId, r.count]);
    expect(rows).toEqual([
      [MEMBER.subject, 1],
      [ADMIN.subject, 1],
      [MEMBER.subject, 2],
    ]);
  });

  test("the legacy prosemirror path counts its snapshot and its steps, and carries no text", async () => {
    const t = harness();
    const { workspaceId, docId, pageId, personalDocId } = await world(t);
    const content = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: PROSE }] }],
    });
    const legacy = async (who: Identity, id: string) => {
      const as = t.withIdentity(who);
      await as.mutation(api.prosemirror.submitSnapshot, { id, version: 1, content });
      await as.mutation(api.prosemirror.submitSteps, {
        id,
        version: 1,
        clientId: "c1",
        steps: [
          JSON.stringify({
            stepType: "replace",
            from: 1,
            to: 1,
            slice: { content: [{ type: "text", text: PROSE }] },
          }),
        ],
      });
    };

    await legacy(MEMBER, docId);
    const rows = await log(t, workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "page.edit",
      actorId: MEMBER.subject,
      subjectId: pageId,
      count: 2,
    });
    expect(JSON.stringify(rows)).not.toContain(PROSE);

    await legacy(OWNER, personalDocId);
    expect(await log(t)).toHaveLength(1);
  });

  test("an edit refused writes nothing", async () => {
    const t = harness();
    const { docId } = await world(t);
    await opened(t, docId);
    await expect(edit(t, STRANGER, docId)).rejects.toThrow();
    await expect(edit(t, { ...MEMBER, act: "ops" }, docId)).rejects.toThrow();
    expect(await log(t)).toEqual([]);
  });
});

describe("a personal project", () => {
  test("writes nothing to any log", async () => {
    const t = harness();
    const { personalId, personalDocId, personalPageId } = await world(t);
    const owner = t.withIdentity(OWNER);
    await owner.mutation(api.ydoc.init, { docId: personalDocId, update: update(PROSE) });
    await owner.mutation(api.ydoc.append, { docId: personalDocId, update: update(PROSE) });
    await owner.mutation(api.projects.rename, { projectId: personalId, title: "Still mine" });
    const token = (await owner.mutation(api.share.setLink, {
      projectId: personalId,
      role: "viewer",
      enabled: true,
    }))!;
    await t.withIdentity(STRANGER).mutation(api.share.claim, { token });
    await owner.mutation(api.share.revokeClaim, { projectId: personalId, granteeId: STRANGER.subject });
    await owner.mutation(api.share.setLink, { projectId: personalId, role: "viewer", enabled: false });
    await owner.mutation(api.pages.remove, { pageId: personalPageId });
    await owner.mutation(api.trash.restore, { pages: [personalPageId] });
    await owner.mutation(api.projects.remove, { projectId: personalId });
    await owner.mutation(api.trash.restore, { projects: [personalId] });
    expect(await log(t)).toEqual([]);
  });
});

describe("reading the log", () => {
  async function seeded(t: T) {
    const w = await world(t);
    const admin = t.withIdentity(ADMIN);
    await admin.mutation(api.share.setLink, { projectId: w.projectId, role: "viewer", enabled: true });
    await t.withIdentity(OWNER).mutation(api.members.setRole, {
      workspaceId: w.workspaceId,
      userId: GUEST.subject,
      role: "member",
    });
    vi.advanceTimersByTime(DAY);
    await admin.mutation(api.members.invite, {
      workspaceId: w.workspaceId,
      email: "zed@acme.com",
      role: "guest",
    });
    await admin.mutation(api.share.setLink, { projectId: w.projectId, role: "viewer", enabled: false });
    return w;
  }

  test("admins and owners read it; members, guests and strangers do not", async () => {
    const t = harness();
    const { workspaceId } = await seeded(t);
    const page = { numItems: 10, cursor: null };
    for (const who of [ADMIN, OWNER]) {
      const { page: rows } = await t
        .withIdentity(who)
        .query(api.audit.list, { workspaceId, paginationOpts: page });
      expect(rows).toHaveLength(4);
    }
    for (const who of [MEMBER, GUEST]) {
      await expect(
        t.withIdentity(who).query(api.audit.list, { workspaceId, paginationOpts: page }),
      ).rejects.toThrow("Only a workspace admin");
      await expect(
        t.withIdentity(who).query(api.audit.exportRows, { workspaceId, from: 0, to: NOW * 2, cursor: null }),
      ).rejects.toThrow("Only a workspace admin");
    }
    await expect(
      t.withIdentity(STRANGER).query(api.audit.list, { workspaceId, paginationOpts: page }),
    ).rejects.toThrow("Not found");
    await expect(t.query(api.audit.list, { workspaceId, paginationOpts: page })).rejects.toThrow(
      "Not found",
    );
    expect(await t.withIdentity(MEMBER).query(api.audit.access, { workspaceId })).toBeNull();
    expect(await t.withIdentity(ADMIN).query(api.audit.access, { workspaceId })).toEqual({
      included: true,
    });
  });

  test("a plan without it keeps the log shut, and still writes it", async () => {
    const t = harness();
    const { workspaceId } = await seeded(t);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("workspaceEntitlements").collect()) await ctx.db.delete(row._id);
    });
    await expect(
      t.withIdentity(ADMIN).query(api.audit.list, { workspaceId, paginationOpts: { numItems: 10, cursor: null } }),
    ).rejects.toThrow("Team plan");
    expect(await t.withIdentity(ADMIN).query(api.audit.access, { workspaceId })).toEqual({
      included: false,
    });
    expect(await log(t, workspaceId)).toHaveLength(4);
  });

  test("newest first, filtered by person, kind of event and period, and named", async () => {
    const t = harness();
    const { workspaceId } = await seeded(t);
    const admin = t.withIdentity(ADMIN);
    const list = async (filters: { actorId?: string; action?: string; from?: number; to?: number }) =>
      (
        await admin.query(api.audit.list, {
          workspaceId,
          paginationOpts: { numItems: 10, cursor: null },
          filters,
        })
      ).page.map((row) => row.action);

    expect(await list({})).toEqual(["share.link.off", "member.invite", "member.role", "share.link.on"]);
    expect(await list({ actorId: OWNER.subject })).toEqual(["member.role"]);
    expect(await list({ action: "share" })).toEqual(["share.link.off", "share.link.on"]);
    expect(await list({ action: "share.link.on" })).toEqual(["share.link.on"]);
    expect(await list({ actorId: ADMIN.subject, action: "member" })).toEqual(["member.invite"]);
    expect(await list({ actorId: ADMIN.subject, action: "share.link.o" })).toEqual([
      "share.link.off",
      "share.link.on",
    ]);
    expect(await list({ from: NOW + DAY })).toEqual(["share.link.off", "member.invite"]);
    expect(await list({ to: NOW + DAY })).toEqual(["member.role", "share.link.on"]);

    const [role] = (
      await admin.query(api.audit.list, {
        workspaceId,
        paginationOpts: { numItems: 10, cursor: null },
        filters: { action: "member.role" },
      })
    ).page;
    expect(role).toMatchObject({
      actorKind: "user",
      actor: { name: "ws_owner", email: OWNER.email },
      subject: { name: "guest", email: GUEST.email },
      meta: { from: "guest", to: "member" },
    });
  });

  test("pages through, and exports a period oldest first", async () => {
    const t = harness();
    const { workspaceId } = await seeded(t);
    const admin = t.withIdentity(ADMIN);
    const first = await admin.query(api.audit.list, {
      workspaceId,
      paginationOpts: { numItems: 3, cursor: null },
    });
    expect(first.page).toHaveLength(3);
    expect(first.isDone).toBe(false);
    const rest = await admin.query(api.audit.list, {
      workspaceId,
      paginationOpts: { numItems: 3, cursor: first.continueCursor },
    });
    expect(rest.page.map((row) => row.action)).toEqual(["share.link.on"]);

    const exported = await admin.query(api.audit.exportRows, {
      workspaceId,
      from: NOW,
      to: NOW + 1,
      cursor: null,
    });
    expect(exported.done).toBe(true);
    expect(exported.rows.map((row) => row.action)).toEqual(["share.link.on", "member.role"]);
  });

  test("an export is narrowed on the server, as the list is", async () => {
    const t = harness();
    const { workspaceId } = await seeded(t);
    const admin = t.withIdentity(ADMIN);
    const exported = async (filters: { actorId?: string; action?: string }) =>
      (
        await admin.query(api.audit.exportRows, {
          workspaceId,
          from: 0,
          to: NOW * 2,
          filters,
          cursor: null,
        })
      ).rows.map((row) => row.action);
    expect(await exported({})).toEqual(["share.link.on", "member.role", "member.invite", "share.link.off"]);
    expect(await exported({ actorId: OWNER.subject })).toEqual(["member.role"]);
    expect(await exported({ action: "member" })).toEqual(["member.role", "member.invite"]);
    expect(await exported({ actorId: ADMIN.subject, action: "share.link.off" })).toEqual([
      "share.link.off",
    ]);
  });
});

describe("retention", () => {
  test("deletes what is past a year, in batches, and nothing younger", async () => {
    const t = harness();
    const { workspaceId } = await world(t);
    await t.run(async (ctx) => {
      const row = (at: number, action: string) =>
        ctx.db.insert("auditEvents", {
          workspaceId,
          actorId: OWNER.subject,
          actorKind: "user",
          action,
          category: action.split(".")[0],
          at,
        });
      for (let i = 0; i < 520; i++) await row(NOW - RETAIN_MS - DAY - i, "member.old");
      await row(NOW - RETAIN_MS + DAY, "member.kept");
      await row(NOW, "member.new");
    });
    await t.mutation(internal.audit.prune, {});
    expect((await log(t, workspaceId)).length).toBe(22);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await log(t, workspaceId)).map((r) => r.action).sort()).toEqual([
      "member.kept",
      "member.new",
    ]);
  });
});
