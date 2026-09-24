/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { DISCARD_WINDOW_MS } from "./auth";

/**
 * A member's failed import, taken back.
 *
 * In a workspace, the member who starts an import only edits the project it
 * makes — deleting one is its owners' and admins' — so the import's cleanup
 * goes through `projects.discardFresh`: the maker, inside a short window,
 * before anyone else has touched it. Everything past that is still the
 * managers' `remove`.
 */

const modules = import.meta.glob("./**/*.ts");

const ADMIN = { subject: "user_ws_admin" };
const CREATOR = { subject: "user_creator" };
const MEMBER = { subject: "user_member" };
const STAND_IN = { ...CREATOR, act: "ops_session_1" };

type T = TestConvex<typeof schema>;

async function world(t: T) {
  return await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      slug: "acme",
      name: "Acme",
      createdBy: ADMIN.subject,
      plan: "team",
      settings: { linkSharing: true, guestCodeAccess: false, joinDomains: [], autoJoin: false },
      createdAt: 1,
    });
    const seat = (userId: string, role: Doc<"memberships">["role"]) =>
      ctx.db.insert("memberships", {
        workspaceId,
        userId,
        role,
        status: "active",
        joinedAt: 1,
      });
    await seat(ADMIN.subject, "admin");
    await seat(CREATOR.subject, "member");
    await seat(MEMBER.subject, "member");
    return workspaceId;
  });
}

/** What `runImport` does in pass one: a project, a folder, and a page in it. */
async function importInto(t: T, workspaceId?: Id<"workspaces">, visibility?: "private") {
  const me = t.withIdentity(CREATOR);
  const projectId = await me.mutation(api.projects.create, {
    title: "Whiskey",
    ...(workspaceId ? { workspaceId, ...(visibility ? { visibility } : {}) } : {}),
  });
  const folderId = await me.mutation(api.folders.create, { projectId, title: "Notes" });
  await me.mutation(api.pages.create, { projectId, title: "Tasting", folderId });
  return projectId;
}

const trashed = (t: T, projectId: Id<"projects">) =>
  t.run(async (ctx) => (await ctx.db.get(projectId))?.deletedAt !== undefined);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("No network in tests");
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a member's import into a workspace", () => {
  test("lands in the workspace, at the visibility chosen", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await world(t);
    const projectId = await importInto(t, workspaceId, "private");
    const project = await t.run((ctx) => ctx.db.get(projectId));
    expect(project).toMatchObject({ workspaceId, visibility: "private", ownerId: CREATOR.subject });
    expect(await t.withIdentity(CREATOR).query(api.projects.myRole, { projectId })).toBe("editor");
  });

  test("can't be removed by its maker, who is only an editor there", async () => {
    const t = convexTest(schema, modules);
    const projectId = await importInto(t, await world(t));
    await expect(
      t.withIdentity(CREATOR).mutation(api.projects.remove, { projectId }),
    ).rejects.toThrow();
    expect(await trashed(t, projectId)).toBe(false);
  });

  test("is discarded by its maker inside the window", async () => {
    const t = convexTest(schema, modules);
    const projectId = await importInto(t, await world(t));
    vi.advanceTimersByTime(DISCARD_WINDOW_MS - 1000);
    await t.withIdentity(CREATOR).mutation(api.projects.discardFresh, { projectId });
    expect(await trashed(t, projectId)).toBe(true);
  });

  test("is logged as its maker discarding it", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await world(t);
    const projectId = await importInto(t, workspaceId);
    await t.withIdentity(CREATOR).mutation(api.projects.discardFresh, { projectId });
    const logged = await t.run((ctx) =>
      ctx.db
        .query("workspaceAuditEvents")
        .withIndex("by_workspace_at", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
    expect(logged.find((row) => row.action === "project.delete")).toMatchObject({
      actorId: CREATOR.subject,
      subjectId: projectId,
      meta: { discarded: true, project: "Whiskey" },
    });
  });
});

describe("discardFresh refuses", () => {
  test("anyone but its maker, a workspace admin included", async () => {
    const t = convexTest(schema, modules);
    const projectId = await importInto(t, await world(t));
    for (const who of [MEMBER, ADMIN]) {
      await expect(
        t.withIdentity(who).mutation(api.projects.discardFresh, { projectId }),
      ).rejects.toThrow("Not found");
    }
    // The admin's way is the managers' own.
    await t.withIdentity(ADMIN).mutation(api.projects.remove, { projectId });
    expect(await trashed(t, projectId)).toBe(true);
  });

  test("once the window has passed", async () => {
    const t = convexTest(schema, modules);
    const projectId = await importInto(t, await world(t));
    vi.advanceTimersByTime(DISCARD_WINDOW_MS + 1000);
    await expect(
      t.withIdentity(CREATOR).mutation(api.projects.discardFresh, { projectId }),
    ).rejects.toThrow("too old");
    expect(await trashed(t, projectId)).toBe(false);
  });

  test("once someone else has made a page in it", async () => {
    const t = convexTest(schema, modules);
    const projectId = await importInto(t, await world(t));
    await t.withIdentity(MEMBER).mutation(api.pages.create, { projectId, title: "Mine" });
    await expect(
      t.withIdentity(CREATOR).mutation(api.projects.discardFresh, { projectId }),
    ).rejects.toThrow("Someone else");
    expect(await trashed(t, projectId)).toBe(false);
  });

  test("once someone else has it open", async () => {
    const t = convexTest(schema, modules);
    const projectId = await importInto(t, await world(t));
    await t.run(async (ctx) => {
      const page = await ctx.db
        .query("pages")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .first();
      await ctx.db.insert("presence", {
        docId: page!.docId,
        sessionId: "s1",
        clientId: 1,
        userId: MEMBER.subject,
        user: { name: "Member", color: "#000" },
        state: new ArrayBuffer(0),
        updatedAt: Date.now(),
      });
    });
    await expect(
      t.withIdentity(CREATOR).mutation(api.projects.discardFresh, { projectId }),
    ).rejects.toThrow("Someone else");
  });

  test("once someone else has written in one of its pages", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await world(t);
    const projectId = await importInto(t, workspaceId);
    await t.run(async (ctx) => {
      const page = await ctx.db
        .query("pages")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .first();
      await ctx.db.insert("workspaceAuditEvents", {
        workspaceId,
        actorId: MEMBER.subject,
        actorKind: "user",
        action: "page.edit",
        category: "edit",
        subjectKind: "page",
        subjectId: page!._id,
        at: Date.now(),
        count: 1,
      });
    });
    await expect(
      t.withIdentity(CREATOR).mutation(api.projects.discardFresh, { projectId }),
    ).rejects.toThrow("Someone else");
  });

  test("once someone else has commented in it", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await world(t);
    const projectId = await importInto(t, workspaceId);
    await t.run((ctx) =>
      ctx.db.insert("auditEvents", {
        workspaceId,
        projectId,
        actorId: MEMBER.subject,
        actorKind: "user",
        action: "comment.create",
        at: Date.now(),
      }),
    );
    await expect(
      t.withIdentity(CREATOR).mutation(api.projects.discardFresh, { projectId }),
    ).rejects.toThrow("Someone else");
  });

  test("once someone has claimed a link to it", async () => {
    const t = convexTest(schema, modules);
    const projectId = await importInto(t, await world(t));
    await t.run((ctx) =>
      ctx.db.insert("shareClaims", {
        projectId,
        granteeId: "user_outsider",
        role: "viewer",
        createdAt: Date.now(),
      }),
    );
    await expect(
      t.withIdentity(CREATOR).mutation(api.projects.discardFresh, { projectId }),
    ).rejects.toThrow("Someone else");
  });

  test("an operator standing in for its maker", async () => {
    const t = convexTest(schema, modules);
    const projectId = await importInto(t, await world(t));
    await expect(
      t.withIdentity(STAND_IN).mutation(api.projects.discardFresh, { projectId }),
    ).rejects.toThrow("Read-only");
    expect(await trashed(t, projectId)).toBe(false);
  });

  test("its maker once their seat is gone", async () => {
    const t = convexTest(schema, modules);
    const workspaceId = await world(t);
    const projectId = await importInto(t, workspaceId);
    await t.run(async (ctx) => {
      const seat = await ctx.db
        .query("memberships")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", workspaceId).eq("userId", CREATOR.subject),
        )
        .unique();
      await ctx.db.patch(seat!._id, { status: "removed", removedAt: Date.now() });
    });
    await expect(
      t.withIdentity(CREATOR).mutation(api.projects.discardFresh, { projectId }),
    ).rejects.toThrow("Not found");
  });
});

describe("a personal import", () => {
  test("is its owner's to remove, as it always was", async () => {
    const t = convexTest(schema, modules);
    const projectId = await importInto(t);
    const project = await t.run((ctx) => ctx.db.get(projectId));
    expect(project?.workspaceId).toBeUndefined();
    vi.advanceTimersByTime(DISCARD_WINDOW_MS * 4);
    await t.withIdentity(CREATOR).mutation(api.projects.remove, { projectId });
    expect(await trashed(t, projectId)).toBe(true);
  });
});
