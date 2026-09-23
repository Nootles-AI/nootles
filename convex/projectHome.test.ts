/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import schema from "./schema";

/**
 * `projects.home` decides which address a project's editor lives at, so a
 * route can move someone to it: a workspace project answers to its
 * workspace's address for anyone with a seat there, and to `/p/` for anyone
 * who came in by a link from outside. Someone with no role learns nothing —
 * not even that the project sits in a workspace.
 */

const modules = import.meta.glob("./**/*.ts");

const OWNER = { subject: "user_ws_owner" };
const MEMBER = { subject: "user_member" };
const OTHER = { subject: "user_other_member" };
const GUEST = { subject: "user_guest" };
const REMOVED = { subject: "user_removed" };
const OUTSIDER = { subject: "user_outsider" };
const STRANGER = { subject: "user_stranger" };

type Identity = { subject: string };
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
    await seat(MEMBER, "member");
    await seat(OTHER, "member");
    await seat(GUEST, "guest");
    await seat(REMOVED, "member", true);

    const shared = await ctx.db.insert("projects", {
      ownerId: MEMBER.subject,
      title: "Roadmap",
      createdAt: 1,
      workspaceId,
      visibility: "workspace",
      shareToken: "view-token",
    });
    const secret = await ctx.db.insert("projects", {
      ownerId: MEMBER.subject,
      title: "Notes",
      createdAt: 1,
      workspaceId,
      visibility: "private",
    });
    const personal = await ctx.db.insert("projects", {
      ownerId: STRANGER.subject,
      title: "Mine",
      createdAt: 1,
    });
    // One link from inside the workspace, one from outside it.
    for (const who of [GUEST, OUTSIDER]) {
      await ctx.db.insert("shareClaims", {
        projectId: shared,
        granteeId: who.subject,
        role: "viewer",
        createdAt: 1,
      });
    }
    return { workspaceId, shared, secret, personal };
  });
}

const homeOf = (t: T, who: Identity, projectId: string) =>
  t.withIdentity(who).query(api.projects.home, { projectId });

describe("projects.home", () => {
  test("a workspace project answers to the workspace’s address for anyone with a seat", async () => {
    const t = convexTest(schema, modules);
    const { shared } = await world(t);
    for (const who of [OWNER, MEMBER, OTHER, GUEST]) {
      expect(await homeOf(t, who, shared)).toEqual({ slug: "acme" });
    }
  });

  test("someone who came in by link from outside the workspace stays on /p/", async () => {
    const t = convexTest(schema, modules);
    const { shared } = await world(t);
    expect(await homeOf(t, OUTSIDER, shared)).toEqual({ slug: null });
  });

  test("a personal project answers to /p/", async () => {
    const t = convexTest(schema, modules);
    const { personal } = await world(t);
    expect(await homeOf(t, STRANGER, personal)).toEqual({ slug: null });
  });

  test("the address follows the workspace’s current slug", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, shared } = await world(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(workspaceId, { slug: "acme-inc" });
    });
    expect(await homeOf(t, MEMBER, shared)).toEqual({ slug: "acme-inc" });
  });

  test("no role is nowhere, whatever the project is", async () => {
    const t = convexTest(schema, modules);
    const { shared, secret, personal } = await world(t);
    // A private project a member did not make.
    expect(await homeOf(t, OTHER, secret)).toBeNull();
    // A seat taken away, a stranger, someone else's personal project.
    expect(await homeOf(t, REMOVED, shared)).toBeNull();
    expect(await homeOf(t, STRANGER, shared)).toBeNull();
    expect(await homeOf(t, MEMBER, personal)).toBeNull();
    // Signed out.
    expect(await t.query(api.projects.home, { projectId: shared })).toBeNull();
  });

  test("a trashed project is nowhere, even to its managers", async () => {
    const t = convexTest(schema, modules);
    const { shared } = await world(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(shared, { deletedAt: 5 });
    });
    expect(await homeOf(t, OWNER, shared)).toBeNull();
  });

  test("an id that names no project reads as nowhere rather than throwing", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    expect(await homeOf(t, MEMBER, "not-an-id")).toBeNull();
    expect(await homeOf(t, MEMBER, workspaceId)).toBeNull();
  });
});
