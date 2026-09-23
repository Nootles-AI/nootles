/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";

/**
 * Share links beside a workspace: when they run out, when a workspace turns
 * them off, who they open to signed out, and who may take one person's
 * access away or carry pages out.
 *
 * The world is one workspace project and one personal project, each with
 * both links on. The personal project is the control: everything here that
 * is new must leave it exactly as it was.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

const OWNER = { subject: "user_owner" };
const ADMIN = { subject: "user_ws_admin" };
const MEMBER = { subject: "user_member" };
const GUEST = { subject: "user_guest" };
const STRANGER = { subject: "user_stranger" };
const LATECOMER = { subject: "user_latecomer" };

type Identity = { subject: string };
type T = TestConvex<typeof schema>;
type Caller = Pick<T, "query" | "mutation">;

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 1);

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  return t;
}

const as = (t: T, who: Identity | null): Caller => (who ? t.withIdentity(who) : t);

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
    for (const [who, role] of [
      [ADMIN, "admin"],
      [MEMBER, "member"],
      [GUEST, "guest"],
    ] as const) {
      await ctx.db.insert("memberships", {
        workspaceId,
        userId: who.subject,
        role,
        status: "active",
        joinedAt: 1,
      });
    }
    const project = async (ownerId: string, title: string, extra: Partial<Doc<"projects">>) => {
      const projectId = await ctx.db.insert("projects", { ownerId, title, createdAt: 1, ...extra });
      const docId = crypto.randomUUID();
      const pageId = await ctx.db.insert("pages", {
        ownerId,
        createdBy: ownerId,
        projectId,
        title: "Plan",
        order: 0,
        docId,
        createdAt: 1,
      });
      return { projectId, pageId, docId };
    };
    const team = await project(MEMBER.subject, "Roadmap", {
      workspaceId,
      shareToken: "w-view",
      editShareToken: "w-edit",
    });
    const personal = await project(OWNER.subject, "Diary", {
      shareToken: "p-view",
      editShareToken: "p-edit",
    });
    return { workspaceId, team, personal };
  });
}

async function claimed(
  t: T,
  projectId: Id<"projects">,
  who: Identity,
  extra: Partial<Doc<"shareClaims">> = {},
) {
  await t.run((ctx) =>
    ctx.db.insert("shareClaims", {
      projectId,
      granteeId: who.subject,
      role: "viewer",
      createdAt: 1,
      ...extra,
    }),
  );
}

/** Every endpoint that reads a document by its id, each to be asked in turn. */
function documentReads(caller: Caller, docId: string): (() => Promise<unknown>)[] {
  return [
    () => caller.query(api.ydoc.state, { docId }),
    () => caller.query(api.ydoc.meta, { docId }),
    () => caller.query(api.ydoc.snapshot, { docId, gen: 0, part: 0 }),
    () => caller.query(api.ydoc.updatesSince, { docId, afterSeq: 0 }),
    () => caller.query(api.ydoc.load, { docId, afterSeq: 0 }),
    () => caller.query(api.presence.list, { docId }),
    () => caller.query(api.presence.roster, { docId }),
    () =>
      caller.mutation(api.presence.heartbeat, {
        docId,
        sessionId: "s1",
        clientId: 1,
        user: { name: "Someone", color: "#000" },
        state: new ArrayBuffer(0),
      }),
    () => caller.query(api.previews.get, { docId }),
    () => caller.query(api.nmlMigration.inCohort, { docId }),
    () => caller.query(api.nmlMigration.nmlAuthority, { docId }),
    () => caller.query(api.nmlMigration.nmlState, { docId }),
    () => caller.query(api.prosemirror.getSnapshot, { id: docId }),
    () => caller.query(api.prosemirror.latestVersion, { id: docId }),
    () => caller.query(api.prosemirror.getSteps, { id: docId, version: 0 }),
  ];
}

async function readsAll(caller: Caller, docId: string) {
  for (const read of documentReads(caller, docId)) await read();
}

async function readsNone(caller: Caller, docId: string) {
  for (const read of documentReads(caller, docId)) await expect(read()).rejects.toThrow("Not found");
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("who a link opens to", () => {
  test("a personal project's opens to anyone holding it, signed in or not, as it always has", async () => {
    const t = harness();
    const w = await world(t);
    for (const who of [null, STRANGER]) {
      const shown = await as(t, who).query(api.share.view, { token: "p-view" });
      expect(shown).toMatchObject({ access: "tree", title: "Diary", role: "viewer" });
      expect(shown?.pages.map((p) => p.docId)).toEqual([w.personal.docId]);
      await readsAll(as(t, who), w.personal.docId);
    }
  });

  test("a workspace project's shows nobody signed out anything, and reads them no document", async () => {
    const t = harness();
    const w = await world(t);
    for (const token of ["w-view", "w-edit"]) {
      const shown = await t.query(api.share.view, { token });
      expect(shown).toMatchObject({ access: "sign-in", title: "", pages: [], folders: [] });
    }
    await readsNone(t, w.team.docId);
  });

  test("someone signed in sees only enough to claim it, and its pages once they have", async () => {
    const t = harness();
    const w = await world(t);
    const stranger = t.withIdentity(STRANGER);
    expect(await stranger.query(api.share.view, { token: "w-view" })).toMatchObject({
      access: "claim",
      title: "Roadmap",
      pages: [],
    });
    await readsNone(stranger, w.team.docId);

    await stranger.mutation(api.share.claim, { token: "w-view" });
    const shown = await stranger.query(api.share.view, { token: "w-view" });
    expect(shown?.access).toBe("tree");
    expect(shown?.pages.map((p) => p.docId)).toEqual([w.team.docId]);
    expect(await stranger.query(api.projects.myRole, { projectId: w.team.projectId })).toBe(
      "viewer",
    );
    await readsAll(stranger, w.team.docId);
  });

  test("a member opens it without claiming anything", async () => {
    const t = harness();
    const w = await world(t);
    const shown = await t.withIdentity(MEMBER).query(api.share.view, { token: "w-view" });
    expect(shown?.access).toBe("tree");
    await readsAll(t.withIdentity(MEMBER), w.team.docId);
  });
});

describe("a workspace that allows no links", () => {
  const linkSharing = (t: T, workspaceId: Id<"workspaces">, on: boolean) =>
    t.withIdentity(ADMIN).mutation(api.workspaces.updateSettings, {
      workspaceId,
      patch: { linkSharing: on },
    });

  test("stops every link and claim at once, and restores them when allowed again", async () => {
    const t = harness();
    const w = await world(t);
    await claimed(t, w.team.projectId, STRANGER);
    await claimed(t, w.team.projectId, GUEST, { role: "editor", grantedRole: "editor" });
    const role = (who: Identity) =>
      t.withIdentity(who).query(api.projects.myRole, { projectId: w.team.projectId });

    await linkSharing(t, w.workspaceId, false);
    expect(await role(STRANGER)).toBeNull();
    expect(await role(GUEST)).toBeNull();
    await readsNone(t.withIdentity(STRANGER), w.team.docId);
    expect(await t.query(api.share.view, { token: "w-view" })).toBeNull();
    expect(await t.withIdentity(STRANGER).query(api.share.view, { token: "w-edit" })).toBeNull();
    await expect(
      t.withIdentity(LATECOMER).mutation(api.share.claim, { token: "w-view" }),
    ).rejects.toThrow("Not found");
    expect(
      await t.withIdentity(ADMIN).query(api.share.collaborators, { projectId: w.team.projectId }),
    ).toEqual([]);
    expect(
      await t.withIdentity(ADMIN).query(api.share.links, { projectId: w.team.projectId }),
    ).toMatchObject({ allowed: false });
    // Seats are not links: the member's role never depended on one.
    expect(await role(MEMBER)).toBe("editor");

    await linkSharing(t, w.workspaceId, true);
    expect(await role(STRANGER)).toBe("viewer");
    expect(await role(GUEST)).toBe("editor");
  });

  test("refuses to turn a link on, but not to turn one off", async () => {
    const t = harness();
    const w = await world(t);
    await linkSharing(t, w.workspaceId, false);
    const admin = t.withIdentity(ADMIN);
    const projectId = w.team.projectId;
    await admin.mutation(api.share.setLink, { projectId, role: "editor", enabled: false });
    await expect(
      admin.mutation(api.share.setLink, { projectId, role: "editor", enabled: true }),
    ).rejects.toThrow("Link sharing is turned off in this workspace.");
    expect(await admin.query(api.share.links, { projectId })).toMatchObject({
      viewer: "w-view",
      editor: null,
    });
  });

  test("leaves a personal project's links alone", async () => {
    const t = harness();
    const w = await world(t);
    await claimed(t, w.personal.projectId, MEMBER);
    await linkSharing(t, w.workspaceId, false);
    expect(
      await t.withIdentity(MEMBER).query(api.projects.myRole, { projectId: w.personal.projectId }),
    ).toBe("viewer");
    await readsAll(t, w.personal.docId);
  });
});

describe("a link that runs out", () => {
  const setLink = (
    t: T,
    who: Identity,
    projectId: Id<"projects">,
    role: "viewer" | "editor",
    expiresInDays?: number | null,
  ) =>
    t.withIdentity(who).mutation(api.share.setLink, { projectId, role, enabled: true, expiresInDays });

  test("admits nobody past its date — not through the link, not by a claim, not by docId", async () => {
    const t = harness();
    const w = await world(t);
    const projectId = w.personal.projectId;
    await setLink(t, OWNER, projectId, "viewer", 7);
    await setLink(t, OWNER, projectId, "editor", 7);
    expect(await t.withIdentity(OWNER).query(api.share.links, { projectId })).toMatchObject({
      viewer: "p-view",
      editor: "p-edit",
      expiresAt: { viewer: T0 + 7 * DAY, editor: T0 + 7 * DAY },
    });
    await t.withIdentity(STRANGER).mutation(api.share.claim, { token: "p-view" });

    vi.setSystemTime(T0 + 7 * DAY - 1);
    expect(await t.withIdentity(STRANGER).query(api.projects.myRole, { projectId })).toBe(
      "viewer",
    );
    await readsAll(t, w.personal.docId);

    vi.setSystemTime(T0 + 7 * DAY);
    expect(await t.query(api.share.view, { token: "p-view" })).toBeNull();
    expect(await t.withIdentity(STRANGER).query(api.projects.myRole, { projectId })).toBeNull();
    await readsNone(t, w.personal.docId);
    await expect(
      t.withIdentity(LATECOMER).mutation(api.share.claim, { token: "p-view" }),
    ).rejects.toThrow("Not found");
    expect(await t.withIdentity(OWNER).query(api.share.collaborators, { projectId })).toEqual([]);
  });

  test("a claim runs out with the link it came through, wherever that link's date moves", async () => {
    const t = harness();
    const w = await world(t);
    const projectId = w.personal.projectId;
    await setLink(t, OWNER, projectId, "viewer", 7);
    await t.withIdentity(STRANGER).mutation(api.share.claim, { token: "p-view" });
    const role = () => t.withIdentity(STRANGER).query(api.projects.myRole, { projectId });
    const expiry = async () =>
      (await t.withIdentity(OWNER).query(api.share.collaborators, { projectId }))[0]?.expiresAt;
    expect(await expiry()).toBe(T0 + 7 * DAY);

    vi.setSystemTime(T0 + 3 * DAY);
    await setLink(t, OWNER, projectId, "viewer", 30);
    expect(await expiry()).toBe(T0 + 33 * DAY);
    vi.setSystemTime(T0 + 20 * DAY);
    expect(await role()).toBe("viewer");

    await setLink(t, OWNER, projectId, "viewer", null);
    expect(await expiry()).toBeNull();
    vi.setSystemTime(T0 + 400 * DAY);
    expect(await role()).toBe("viewer");
  });

  test("the editor link running out takes its claimants' pen and their place", async () => {
    const t = harness();
    const w = await world(t);
    const projectId = w.personal.projectId;
    await setLink(t, OWNER, projectId, "editor", 1);
    await t.withIdentity(STRANGER).mutation(api.share.claim, { token: "p-edit" });
    expect(await t.withIdentity(STRANGER).query(api.projects.myRole, { projectId })).toBe(
      "editor",
    );

    vi.setSystemTime(T0 + DAY);
    // The viewer link is still on, but it is not the link they came by.
    expect(await t.withIdentity(STRANGER).query(api.projects.myRole, { projectId })).toBeNull();
    await expect(
      t.withIdentity(STRANGER).mutation(api.pages.create, { projectId }),
    ).rejects.toThrow("Not found");
  });

  test("turning a run-out link on again is a new link; its old claimants come back through it", async () => {
    const t = harness();
    const w = await world(t);
    const projectId = w.personal.projectId;
    await setLink(t, OWNER, projectId, "viewer", 7);
    await t.withIdentity(STRANGER).mutation(api.share.claim, { token: "p-view" });

    vi.setSystemTime(T0 + 8 * DAY);
    const token = await setLink(t, OWNER, projectId, "viewer");
    expect(token).not.toBe("p-view");
    expect(await t.query(api.share.view, { token: "p-view" })).toBeNull();
    expect(await t.withIdentity(STRANGER).query(api.projects.myRole, { projectId })).toBeNull();

    await t.withIdentity(STRANGER).mutation(api.share.claim, { token: token! });
    expect(await t.withIdentity(STRANGER).query(api.projects.myRole, { projectId })).toBe(
      "viewer",
    );
  });

  test("a pen handed over by name outlasts the link its holder came by", async () => {
    const t = harness();
    const w = await world(t);
    const projectId = w.personal.projectId;
    await setLink(t, OWNER, projectId, "viewer", 7);
    await t.withIdentity(STRANGER).mutation(api.share.claim, { token: "p-view" });
    await t.withIdentity(STRANGER).mutation(api.share.requestEdit, { projectId });
    const [ask] = await t.withIdentity(OWNER).query(api.share.incomingRequests, {});
    await t
      .withIdentity(OWNER)
      .mutation(api.share.decideRequest, { requestId: ask.requestId, grant: true });

    vi.setSystemTime(T0 + 30 * DAY);
    expect(await t.withIdentity(STRANGER).query(api.projects.myRole, { projectId })).toBe(
      "editor",
    );
    expect(
      (await t.withIdentity(OWNER).query(api.share.collaborators, { projectId }))[0],
    ).toMatchObject({ role: "editor", expiresAt: null });
  });

  test("a new link starts at its workspace's default, and a personal one at never", async () => {
    const t = harness();
    const w = await world(t);
    await t.withIdentity(ADMIN).mutation(api.workspaces.updateSettings, {
      workspaceId: w.workspaceId,
      patch: { linkTtlDays: 30 },
    });
    const admin = t.withIdentity(ADMIN);
    const team = w.team.projectId;
    await admin.mutation(api.share.setLink, { projectId: team, role: "editor", enabled: false });
    await setLink(t, ADMIN, team, "editor");
    expect(await admin.query(api.share.links, { projectId: team })).toMatchObject({
      defaultDays: 30,
      expiresAt: { viewer: null, editor: T0 + 30 * DAY },
    });
    // A link already on keeps the date it had.
    await setLink(t, ADMIN, team, "viewer");
    expect((await admin.query(api.share.links, { projectId: team })).expiresAt.viewer).toBeNull();

    const owner = t.withIdentity(OWNER);
    const personal = w.personal.projectId;
    await owner.mutation(api.share.setLink, { projectId: personal, role: "viewer", enabled: false });
    await setLink(t, OWNER, personal, "viewer");
    expect(await owner.query(api.share.links, { projectId: personal })).toMatchObject({
      defaultDays: null,
      expiresAt: { viewer: null },
    });
  });

  test("lasts one to 365 whole days", async () => {
    const t = harness();
    const w = await world(t);
    for (const days of [0, 366, 2.5, -1]) {
      await expect(setLink(t, OWNER, w.personal.projectId, "viewer", days)).rejects.toThrow(
        "Links can expire after 1 to 365 days.",
      );
    }
    await setLink(t, OWNER, w.personal.projectId, "viewer", 365);
  });
});

describe("taking one person's access away", () => {
  test("removes them, and what they asked for, and nobody else", async () => {
    const t = harness();
    const w = await world(t);
    const projectId = w.personal.projectId;
    await claimed(t, projectId, STRANGER);
    await claimed(t, projectId, LATECOMER);
    await t.withIdentity(STRANGER).mutation(api.share.requestEdit, { projectId });

    await t
      .withIdentity(OWNER)
      .mutation(api.share.revokeClaim, { projectId, granteeId: STRANGER.subject });
    expect(await t.withIdentity(STRANGER).query(api.projects.myRole, { projectId })).toBeNull();
    expect(await t.withIdentity(LATECOMER).query(api.projects.myRole, { projectId })).toBe(
      "viewer",
    );
    expect(await t.withIdentity(OWNER).query(api.share.incomingRequests, {})).toEqual([]);
    expect(
      (await t.withIdentity(OWNER).query(api.share.collaborators, { projectId })).map(
        (c) => c.granteeId,
      ),
    ).toEqual([LATECOMER.subject]);
    expect(await t.withIdentity(STRANGER).query(api.share.myEditRequest, { projectId })).toBeNull();

    // The link stays on: whoever still holds it can come back by it.
    await t.withIdentity(STRANGER).mutation(api.share.claim, { token: "p-view" });
    expect(await t.withIdentity(STRANGER).query(api.projects.myRole, { projectId })).toBe(
      "viewer",
    );
  });

  test("is a workspace project's managers' to do, and no one else's", async () => {
    const t = harness();
    const w = await world(t);
    const projectId = w.team.projectId;
    await claimed(t, projectId, GUEST);
    await claimed(t, projectId, STRANGER);
    const revoke = (who: Identity) =>
      t.withIdentity(who).mutation(api.share.revokeClaim, { projectId, granteeId: STRANGER.subject });

    for (const who of [MEMBER, GUEST, STRANGER]) {
      await expect(revoke(who)).rejects.toThrow("Not found");
    }
    expect(await t.withIdentity(STRANGER).query(api.projects.myRole, { projectId })).toBe(
      "viewer",
    );
    await revoke(ADMIN);
    expect(await t.withIdentity(STRANGER).query(api.projects.myRole, { projectId })).toBeNull();
    expect(await t.withIdentity(GUEST).query(api.projects.myRole, { projectId })).toBe("viewer");
  });
});
