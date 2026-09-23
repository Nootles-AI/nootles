/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";
import { teamsEnabledFor } from "./teamsRollout";
import { normalizeSlug, slugProblem, typingSlug } from "./slugs";

/**
 * Making, finding, naming, configuring and deleting a workspace. The rules
 * worth pinning: nobody makes one while the rollout says no, an address is
 * never handed to a second workspace, a workspace is invisible to everyone
 * without a seat, and deleting one takes its projects and seats with it in
 * one step.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

type Identity = { subject: string; email?: string; emailVerified?: boolean; act?: string };

const OWNER = { subject: "user_ws_owner", email: "olive@acme.com" };
const ADMIN = { subject: "user_ws_admin", email: "ada@acme.com" };
/** A member, and the one who made every project in the world. */
const CREATOR = { subject: "user_creator", email: "cy@acme.com" };
const MEMBER = { subject: "user_member", email: "max@acme.com" };
const GUEST = { subject: "user_guest", email: "gus@partner.io" };
const REMOVED = { subject: "user_removed", email: "rex@acme.com" };
const STRANGER = { subject: "user_stranger", email: "sal@elsewhere.org" };
const STAND_IN = { ...OWNER, act: "ops_session_1" };

type T = TestConvex<typeof schema>;
type Caller = Pick<T, "query" | "mutation">;

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  return t;
}

const as = (t: T, who: Identity | null): Caller => (who ? t.withIdentity(who) : t);

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    await ctx.db.insert("workspaceSlugs", { slug: "acme", workspaceId });
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
    await seat(CREATOR, "member");
    await seat(MEMBER, "member");
    await seat(GUEST, "guest");
    await seat(REMOVED, "admin", true);

    const project = async (title: string, extra: Partial<Doc<"projects">> = {}) => {
      const projectId = await ctx.db.insert("projects", {
        ownerId: CREATOR.subject,
        title,
        workspaceId,
        createdAt: 1,
        ...extra,
      });
      const docId = crypto.randomUUID();
      await ctx.db.insert("pages", {
        ownerId: CREATOR.subject,
        createdBy: CREATOR.subject,
        projectId,
        title: "Plan",
        order: 0,
        docId,
        createdAt: 1,
      });
      return { projectId, docId };
    };
    const open = await project("Roadmap", { shareToken: "view", editShareToken: "edit" });
    const secret = await project("Offsite", { visibility: "private" });
    const binned = await project("Old plans", { deletedAt: 5 });
    const personal = await ctx.db.insert("projects", {
      ownerId: CREATOR.subject,
      title: "Diary",
      createdAt: 1,
    });
    return { workspaceId, open, secret, binned, personal };
  });
}

describe("the rollout flag", () => {
  test("is off unless the deployment says otherwise", () => {
    expect(teamsEnabledFor(OWNER.subject)).toBe(false);
    vi.stubEnv("TEAMS_ROLLOUT", "off");
    expect(teamsEnabledFor(OWNER.subject)).toBe(false);
    vi.stubEnv("TEAMS_ROLLOUT", "maybe");
    expect(teamsEnabledFor(OWNER.subject)).toBe(false);
  });

  test("an allowlist admits exactly the subjects on it", () => {
    vi.stubEnv("TEAMS_ROLLOUT", "allowlist");
    vi.stubEnv("TEAMS_ALLOWLIST", ` ${OWNER.subject} ,user_other`);
    expect(teamsEnabledFor(OWNER.subject)).toBe(true);
    expect(teamsEnabledFor("user_other")).toBe(true);
    expect(teamsEnabledFor(STRANGER.subject)).toBe(false);
    expect(teamsEnabledFor(null)).toBe(false);
  });

  test("on admits anyone signed in", () => {
    vi.stubEnv("TEAMS_ROLLOUT", " ON ");
    expect(teamsEnabledFor(STRANGER.subject)).toBe(true);
    expect(teamsEnabledFor(null)).toBe(false);
  });

  test("gates making a workspace, and canCreate says so", async () => {
    const t = harness();
    const owner = t.withIdentity(OWNER);
    expect(await owner.query(api.workspaces.canCreate, {})).toBe(false);
    await expect(owner.mutation(api.workspaces.create, { name: "Acme" })).rejects.toThrow(
      "Workspaces aren’t open to your account yet.",
    );

    vi.stubEnv("TEAMS_ROLLOUT", "allowlist");
    vi.stubEnv("TEAMS_ALLOWLIST", OWNER.subject);
    expect(await owner.query(api.workspaces.canCreate, {})).toBe(true);
    expect(await t.withIdentity(STRANGER).query(api.workspaces.canCreate, {})).toBe(false);
    expect(await t.query(api.workspaces.canCreate, {})).toBe(false);
    await expect(
      t.withIdentity(STRANGER).mutation(api.workspaces.create, { name: "Elsewhere" }),
    ).rejects.toThrow("aren’t open");
    await expect(owner.mutation(api.workspaces.create, { name: "Acme" })).resolves.toMatchObject({
      slug: "acme",
    });
  });

  test("refuses the signed-out and an operator's stand-in even when on", async () => {
    vi.stubEnv("TEAMS_ROLLOUT", "on");
    const t = harness();
    await expect(t.mutation(api.workspaces.create, { name: "Acme" })).rejects.toThrow(
      "Not signed in",
    );
    await expect(
      t.withIdentity(STAND_IN).mutation(api.workspaces.create, { name: "Acme" }),
    ).rejects.toThrow("Read-only");
    expect(await t.withIdentity(STAND_IN).query(api.workspaces.canCreate, {})).toBe(false);
  });

  test("leaves a workspace that exists working when it is turned off", async () => {
    vi.stubEnv("TEAMS_ROLLOUT", "on");
    const t = harness();
    const { workspaceId } = await t
      .withIdentity(OWNER)
      .mutation(api.workspaces.create, { name: "Acme" });
    vi.stubEnv("TEAMS_ROLLOUT", "off");
    const owner = t.withIdentity(OWNER);
    expect(await owner.query(api.workspaces.bySlug, { slug: "acme" })).toMatchObject({
      role: "owner",
    });
    await owner.mutation(api.workspaces.rename, { workspaceId, name: "Acme Inc" });
    await expect(
      owner.mutation(api.members.invite, { workspaceId, email: "new@acme.com", role: "member" }),
    ).resolves.toMatchObject({ token: expect.any(String) });
  });
});

describe("making a workspace", () => {
  test("puts its maker in as owner, at the address its name gives", async () => {
    vi.stubEnv("TEAMS_ROLLOUT", "on");
    const t = harness();
    const made = await t
      .withIdentity(OWNER)
      .mutation(api.workspaces.create, { name: "  Acme Robotics  " });
    expect(made.slug).toBe("acme-robotics");
    const rows = await t.run(async (ctx) => ({
      workspace: await ctx.db.get(made.workspaceId),
      slugs: await ctx.db.query("workspaceSlugs").collect(),
      seats: await ctx.db.query("memberships").collect(),
    }));
    expect(rows.workspace).toMatchObject({
      name: "Acme Robotics",
      slug: "acme-robotics",
      createdBy: OWNER.subject,
      plan: "team",
      settings: { linkSharing: true, guestCodeAccess: false, joinDomains: [], autoJoin: false },
    });
    expect(rows.slugs).toMatchObject([{ slug: "acme-robotics", workspaceId: made.workspaceId }]);
    expect(rows.slugs[0].retiredAt).toBeUndefined();
    expect(rows.seats).toMatchObject([
      { workspaceId: made.workspaceId, userId: OWNER.subject, role: "owner", status: "active" },
    ]);
    expect(await t.withIdentity(OWNER).query(api.workspaces.listMine, {})).toEqual([
      { workspaceId: made.workspaceId, slug: "acme-robotics", name: "Acme Robotics", role: "owner" },
    ]);
  });

  test("normalizes the address it is given", async () => {
    vi.stubEnv("TEAMS_ROLLOUT", "on");
    const t = harness();
    const made = await t
      .withIdentity(OWNER)
      .mutation(api.workspaces.create, { name: "Acme", slug: "--Café  Crème!!--" });
    expect(made.slug).toBe("cafe-creme");
  });

  test("refuses a missing name, a reserved address and one too short", async () => {
    vi.stubEnv("TEAMS_ROLLOUT", "on");
    const owner = harness().withIdentity(OWNER);
    await expect(owner.mutation(api.workspaces.create, { name: "   " })).rejects.toThrow(
      "Give the workspace a name.",
    );
    await expect(
      owner.mutation(api.workspaces.create, { name: "x".repeat(65) }),
    ).rejects.toThrow("at most 64");
    for (const slug of ["new", "join", "invite", "settings", "api", "Nootles"]) {
      await expect(owner.mutation(api.workspaces.create, { name: "Acme", slug })).rejects.toThrow(
        "is reserved",
      );
    }
    await expect(owner.mutation(api.workspaces.create, { name: "AI" })).rejects.toThrow(
      "at least 3",
    );
    await expect(
      owner.mutation(api.workspaces.create, { name: "Acme", slug: "!!" }),
    ).rejects.toThrow("at least 3");
  });

  test("never hands an address to a second workspace, retired or not", async () => {
    vi.stubEnv("TEAMS_ROLLOUT", "on");
    const t = harness();
    const first = await t.withIdentity(OWNER).mutation(api.workspaces.create, { name: "Acme" });
    const other = t.withIdentity(STRANGER);
    await expect(other.mutation(api.workspaces.create, { name: "ACME" })).rejects.toThrow(
      "That address is taken.",
    );

    await t
      .withIdentity(OWNER)
      .mutation(api.workspaces.setSlug, { workspaceId: first.workspaceId, slug: "acme-hq" });
    await expect(other.mutation(api.workspaces.create, { name: "Acme" })).rejects.toThrow(
      "That address is taken.",
    );
    await expect(
      other.mutation(api.workspaces.create, { name: "Mine", slug: "acme-hq" }),
    ).rejects.toThrow("That address is taken.");

    // Nor by moving another workspace onto it.
    const mine = await other.mutation(api.workspaces.create, { name: "Mine" });
    const move = (slug: string) =>
      other.mutation(api.workspaces.setSlug, { workspaceId: mine.workspaceId, slug });
    await expect(move("acme")).rejects.toThrow("That address is taken.");
    await expect(move("acme-hq")).rejects.toThrow("That address is taken.");
    await expect(move("billing")).rejects.toThrow("is reserved");
    await expect(move("ab")).rejects.toThrow("at least 3");
    const slugs = await t.run(async (ctx) => ({
      first: (await ctx.db.get(first.workspaceId))!.slug,
      mine: (await ctx.db.get(mine.workspaceId))!.slug,
      rows: (await ctx.db.query("workspaceSlugs").collect()).map((row) => [
        row.slug,
        row.workspaceId,
        row.retiredAt === undefined,
      ]),
    }));
    expect(slugs.first).toBe("acme-hq");
    expect(slugs.mine).toBe("mine");
    expect(slugs.rows).toEqual([
      ["acme", first.workspaceId, false],
      ["acme-hq", first.workspaceId, true],
      ["mine", mine.workspaceId, true],
    ]);
  });
});

describe("slug helpers", () => {
  test.each([
    ["Acme Corp", "acme-corp"],
    ["acme--corp", "acme-corp"],
    ["  -Acme- ", "acme"],
    ["Zürich Ünited", "zurich-united"],
    ["日本", ""],
    ["a".repeat(31) + " b", "a".repeat(31)],
    ["b".repeat(40), "b".repeat(32)],
  ])("%s → %s", (raw, slug) => {
    expect(normalizeSlug(raw)).toBe(slug);
  });

  test("a problem only for short or reserved addresses", () => {
    expect(slugProblem("acme")).toBeNull();
    expect(slugProblem("ab")).toMatch("at least 3");
    expect(slugProblem("billing")).toMatch("reserved");
  });

  test("while typing, a separator waits for the next word", () => {
    expect(typingSlug("Acme ")).toBe("acme-");
    expect(typingSlug("acme-c")).toBe("acme-c");
    expect(typingSlug(" -Zürich")).toBe("zurich");
    expect(normalizeSlug(typingSlug("Acme "))).toBe("acme");
  });
});

describe("checking an address before it is used", () => {
  test("says what create would, to someone who may create", async () => {
    vi.stubEnv("TEAMS_ROLLOUT", "on");
    const t = harness();
    await world(t);
    const stranger = t.withIdentity(STRANGER);
    expect(await stranger.query(api.workspaces.checkSlug, { slug: "Acme Two" })).toEqual({
      slug: "acme-two",
      problem: null,
    });
    expect(await stranger.query(api.workspaces.checkSlug, { slug: "acme" })).toEqual({
      slug: "acme",
      problem: "That address is taken. Try another.",
    });
    expect((await stranger.query(api.workspaces.checkSlug, { slug: "ab" }))?.problem).toMatch(
      "at least 3",
    );
  });

  test("tells nobody anything while the rollout says no, nor a stand-in", async () => {
    const t = harness();
    await world(t);
    expect(await t.withIdentity(STRANGER).query(api.workspaces.checkSlug, { slug: "acme" })).toBeNull();
    vi.stubEnv("TEAMS_ROLLOUT", "on");
    expect(await t.withIdentity(STAND_IN).query(api.workspaces.checkSlug, { slug: "acme" })).toBeNull();
    expect(await t.query(api.workspaces.checkSlug, { slug: "acme" })).toBeNull();
  });

  test("for a workspace's own new address, its admins alone, and its old ones are free", async () => {
    const t = harness();
    const { workspaceId } = await world(t);
    await t.withIdentity(ADMIN).mutation(api.workspaces.setSlug, { workspaceId, slug: "acme-hq" });
    const check = (who: Identity, slug: string) =>
      t.withIdentity(who).query(api.workspaces.checkSlug, { slug, workspaceId });
    expect(await check(ADMIN, "acme")).toEqual({ slug: "acme", problem: null });
    expect(await check(OWNER, "acme-hq")).toEqual({ slug: "acme-hq", problem: null });
    expect(await check(MEMBER, "acme")).toBeNull();
    expect(await check(STRANGER, "acme")).toBeNull();
  });
});

describe("finding a workspace", () => {
  test("by its address, for every seat, guests included", async () => {
    const t = harness();
    const w = await world(t);
    for (const [who, role] of [
      [OWNER, "owner"],
      [ADMIN, "admin"],
      [MEMBER, "member"],
      [GUEST, "guest"],
    ] as const) {
      expect(await t.withIdentity(who).query(api.workspaces.bySlug, { slug: "acme" })).toMatchObject(
        {
          workspace: { _id: w.workspaceId, name: "Acme", slug: "acme" },
          role,
          canonicalSlug: "acme",
        },
      );
    }
    expect(
      await t.withIdentity(STAND_IN).query(api.workspaces.bySlug, { slug: "ACME" }),
    ).toMatchObject({ role: "owner" });
  });

  test("is null to anyone without a seat, as if it did not exist", async () => {
    const t = harness();
    await world(t);
    for (const who of [REMOVED, STRANGER, null]) {
      expect(await as(t, who).query(api.workspaces.bySlug, { slug: "acme" })).toBeNull();
      expect(await as(t, who).query(api.workspaces.bySlug, { slug: "nowhere" })).toBeNull();
    }
    expect(await t.withIdentity(STRANGER).query(api.workspaces.listMine, {})).toEqual([]);
    expect(await t.withIdentity(REMOVED).query(api.workspaces.listMine, {})).toEqual([]);
    expect(await t.query(api.workspaces.listMine, {})).toEqual([]);
  });

  test("an old address answers with the current one", async () => {
    const t = harness();
    const w = await world(t);
    const admin = t.withIdentity(ADMIN);
    await admin.mutation(api.workspaces.setSlug, { workspaceId: w.workspaceId, slug: "Acme HQ" });
    expect(await admin.query(api.workspaces.bySlug, { slug: "acme" })).toMatchObject({
      canonicalSlug: "acme-hq",
    });
    expect(await admin.query(api.workspaces.bySlug, { slug: "acme-hq" })).toMatchObject({
      canonicalSlug: "acme-hq",
    });
    expect(await t.withIdentity(STRANGER).query(api.workspaces.bySlug, { slug: "acme" })).toBeNull();

    // Taking an old address back un-retires it rather than adding a row.
    await admin.mutation(api.workspaces.setSlug, { workspaceId: w.workspaceId, slug: "acme" });
    const slugs = await t.run((ctx) => ctx.db.query("workspaceSlugs").collect());
    expect(
      slugs.map((s) => [s.slug, s.retiredAt === undefined ? "current" : "retired"]).sort(),
    ).toEqual([
      ["acme", "current"],
      ["acme-hq", "retired"],
    ]);
    expect(await admin.query(api.workspaces.bySlug, { slug: "acme-hq" })).toMatchObject({
      canonicalSlug: "acme",
    });
  });

  test("listMine names every live seat, by name", async () => {
    vi.stubEnv("TEAMS_ROLLOUT", "on");
    const t = harness();
    const w = await world(t);
    const beta = await t.withIdentity(MEMBER).mutation(api.workspaces.create, { name: "Beta" });
    const alpha = await t.withIdentity(MEMBER).mutation(api.workspaces.create, { name: "Alpha" });
    await t.withIdentity(MEMBER).mutation(api.workspaces.remove, { workspaceId: beta.workspaceId });
    expect(await t.withIdentity(MEMBER).query(api.workspaces.listMine, {})).toEqual([
      { workspaceId: w.workspaceId, slug: "acme", name: "Acme", role: "member" },
      { workspaceId: alpha.workspaceId, slug: "alpha", name: "Alpha", role: "owner" },
    ]);
  });
});

describe("running a workspace", () => {
  const writes: [string, (c: Caller, id: Id<"workspaces">) => Promise<unknown>][] = [
    ["rename", (c, id) => c.mutation(api.workspaces.rename, { workspaceId: id, name: "Acme Inc" })],
    ["setSlug", (c, id) => c.mutation(api.workspaces.setSlug, { workspaceId: id, slug: "acme-inc" })],
    [
      "updateSettings",
      (c, id) =>
        c.mutation(api.workspaces.updateSettings, { workspaceId: id, patch: { linkSharing: false } }),
    ],
  ];

  test.each(writes)("%s is an admin's", async (_, write) => {
    const t = harness();
    const w = await world(t);
    await expect(write(t.withIdentity(ADMIN), w.workspaceId)).resolves.not.toThrow();
    await expect(write(t.withIdentity(OWNER), w.workspaceId)).resolves.not.toThrow();
    for (const who of [CREATOR, GUEST]) {
      await expect(write(t.withIdentity(who), w.workspaceId)).rejects.toThrow(
        /Only a workspace admin|A guest/,
      );
    }
    for (const who of [REMOVED, STRANGER]) {
      await expect(write(t.withIdentity(who), w.workspaceId)).rejects.toThrow("Not found");
    }
    await expect(write(t, w.workspaceId)).rejects.toThrow("Not found");
    await expect(write(t.withIdentity(STAND_IN), w.workspaceId)).rejects.toThrow("Read-only");
  });

  test("settings change only what the patch names", async () => {
    const t = harness();
    const w = await world(t);
    const admin = t.withIdentity(ADMIN);
    await admin.mutation(api.workspaces.updateSettings, {
      workspaceId: w.workspaceId,
      patch: { guestCodeAccess: true, linkTtlDays: 30 },
    });
    await admin.mutation(api.workspaces.updateSettings, {
      workspaceId: w.workspaceId,
      patch: { linkSharing: false },
    });
    const settings = async () => (await t.run((ctx) => ctx.db.get(w.workspaceId)))!.settings;
    expect(await settings()).toEqual({
      linkSharing: false,
      guestCodeAccess: true,
      joinDomains: [],
      autoJoin: false,
      linkTtlDays: 30,
    });
    await admin.mutation(api.workspaces.updateSettings, {
      workspaceId: w.workspaceId,
      patch: { linkTtlDays: null },
    });
    expect((await settings()).linkTtlDays).toBeUndefined();
    for (const linkTtlDays of [0, 1.5, 366]) {
      await expect(
        admin.mutation(api.workspaces.updateSettings, {
          workspaceId: w.workspaceId,
          patch: { linkTtlDays },
        }),
      ).rejects.toThrow("1 to 365 days");
    }
  });

  test("a join domain needs the acting admin to hold it", async () => {
    const t = harness();
    const w = await world(t);
    const domains = () =>
      t.run(async (ctx) => ({
        settings: (await ctx.db.get(w.workspaceId))!.settings.joinDomains,
        rows: (await ctx.db.query("workspaceDomains").collect()).map((r) => r.domain).sort(),
      }));
    const set = (who: Identity, joinDomains: string[]) =>
      t.withIdentity(who).mutation(api.workspaces.updateSettings, {
        workspaceId: w.workspaceId,
        patch: { joinDomains },
      });

    await set(ADMIN, [" @ACME.com", "acme.com"]);
    expect(await domains()).toEqual({ settings: ["acme.com"], rows: ["acme.com"] });

    await expect(set(ADMIN, ["acme.com", "partner.io"])).rejects.toThrow(
      "You can only add your own email’s domain (acme.com).",
    );
    // Another admin, on partner.io: the domain already listed stays without
    // their proof of it.
    await t.run(async (ctx) => {
      const seat = await ctx.db
        .query("memberships")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", w.workspaceId).eq("userId", GUEST.subject),
        )
        .unique();
      await ctx.db.patch(seat!._id, { role: "admin" });
    });
    await expect(set(GUEST, ["acme.com", "partner.io"])).resolves.toBeNull();
    expect(await domains()).toEqual({
      settings: ["acme.com", "partner.io"],
      rows: ["acme.com", "partner.io"],
    });

    await set(ADMIN, ["partner.io"]);
    expect(await domains()).toEqual({ settings: ["partner.io"], rows: ["partner.io"] });

    const gmailAdmin = { subject: ADMIN.subject, email: "ada@gmail.com" };
    await expect(set(gmailAdmin, ["partner.io", "gmail.com"])).rejects.toThrow(
      "gmail.com is a personal email domain",
    );
    const unverified = { ...ADMIN, emailVerified: false };
    await expect(set(unverified, ["partner.io", "acme.com"])).rejects.toThrow(
      "You can only add your own email’s domain.",
    );
  });
});

describe("deleting a workspace", () => {
  test("is its owners' alone", async () => {
    const t = harness();
    const w = await world(t);
    for (const who of [ADMIN, MEMBER, GUEST]) {
      await expect(
        t.withIdentity(who).mutation(api.workspaces.remove, { workspaceId: w.workspaceId }),
      ).rejects.toThrow(/Only a workspace owner|A guest/);
    }
    await expect(
      t.withIdentity(STRANGER).mutation(api.workspaces.remove, { workspaceId: w.workspaceId }),
    ).rejects.toThrow("Not found");
    await expect(
      t.withIdentity(STAND_IN).mutation(api.workspaces.remove, { workspaceId: w.workspaceId }),
    ).rejects.toThrow("Read-only");
  });

  test("trashes its projects and retires every seat and invitation at once", async () => {
    const t = harness();
    const w = await world(t);
    const { token } = await t.withIdentity(ADMIN).mutation(api.members.invite, {
      workspaceId: w.workspaceId,
      email: "new@acme.com",
      role: "member",
    });
    await t.withIdentity(ADMIN).mutation(api.workspaces.updateSettings, {
      workspaceId: w.workspaceId,
      patch: { joinDomains: ["acme.com"], autoJoin: true },
    });
    await t.withIdentity(OWNER).mutation(api.workspaces.remove, { workspaceId: w.workspaceId });

    const after = await t.run(async (ctx) => ({
      workspace: (await ctx.db.get(w.workspaceId))!,
      projects: await Promise.all(
        [w.open, w.secret, w.binned].map(async (p) => (await ctx.db.get(p.projectId))!),
      ),
      personal: (await ctx.db.get(w.personal))!,
      seats: await ctx.db.query("memberships").collect(),
      invitations: await ctx.db.query("invitations").collect(),
      domains: await ctx.db.query("workspaceDomains").collect(),
    }));
    const at = after.workspace.deletedAt!;
    expect(at).toBeGreaterThan(5);
    expect(after.projects.map((p) => p.deletedAt)).toEqual([at, at, 5]);
    expect(after.personal.deletedAt).toBeUndefined();
    expect(after.seats.every((s) => s.status === "removed")).toBe(true);
    expect(after.invitations.every((i) => i.revokedAt === at)).toBe(true);
    expect(after.domains).toEqual([]);

    for (const who of [OWNER, ADMIN, MEMBER]) {
      const me = t.withIdentity(who);
      expect(await me.query(api.workspaces.bySlug, { slug: "acme" })).toBeNull();
      expect(await me.query(api.workspaces.listMine, {})).toEqual([]);
      expect(await me.query(api.workspaces.projectsFor, { workspaceId: w.workspaceId })).toEqual(
        [],
      );
      expect(await me.query(api.projects.myRole, { projectId: w.open.projectId })).toBeNull();
      await expect(me.query(api.ydoc.state, { docId: w.secret.docId })).rejects.toThrow(
        "Not found",
      );
    }
    // Nobody is left to run it, so nobody can bring its projects back.
    await expect(
      t.withIdentity(OWNER).mutation(api.trash.restore, { projects: [w.open.projectId] }),
    ).rejects.toThrow("Not found");
    // Nor walk back in, by the domain it still names or the invitation that
    // still has days to run.
    for (const who of [{ subject: "user_new", email: "new@acme.com" }, MEMBER, OWNER]) {
      await expect(
        t.withIdentity(who).mutation(api.members.joinByDomain, { workspaceId: w.workspaceId }),
      ).rejects.toThrow("Not found");
      await expect(
        t.withIdentity(who).mutation(api.members.acceptInvite, { token }),
      ).rejects.toThrow("Not found");
    }
    const seats = await t.run((ctx) => ctx.db.query("memberships").collect());
    expect(seats.filter((s) => s.status === "active")).toEqual([]);
    // Its address stays spoken for.
    vi.stubEnv("TEAMS_ROLLOUT", "on");
    await expect(
      t.withIdentity(STRANGER).mutation(api.workspaces.create, { name: "Acme" }),
    ).rejects.toThrow("That address is taken.");
  });
});

describe("the workspace home", () => {
  const titles = async (caller: Caller, workspaceId: Id<"workspaces">) =>
    (await caller.query(api.workspaces.projectsFor, { workspaceId }))
      .map((p) => `${p.title}:${p.role}`)
      .sort();

  test("lists what each seat can open", async () => {
    const t = harness();
    const w = await world(t);
    expect(await titles(t.withIdentity(OWNER), w.workspaceId)).toEqual([
      "Offsite:owner",
      "Roadmap:owner",
    ]);
    expect(await titles(t.withIdentity(ADMIN), w.workspaceId)).toEqual([
      "Offsite:owner",
      "Roadmap:owner",
    ]);
    expect(await titles(t.withIdentity(CREATOR), w.workspaceId)).toEqual([
      "Offsite:editor",
      "Roadmap:editor",
    ]);
    expect(await titles(t.withIdentity(MEMBER), w.workspaceId)).toEqual(["Roadmap:editor"]);
    expect(await titles(t.withIdentity(GUEST), w.workspaceId)).toEqual([]);
    for (const who of [REMOVED, STRANGER, null]) {
      expect(await titles(as(t, who), w.workspaceId)).toEqual([]);
    }
    expect(await titles(t.withIdentity(STAND_IN), w.workspaceId)).toEqual([
      "Offsite:viewer",
      "Roadmap:viewer",
    ]);
  });

  test("a guest sees the projects a link let them into", async () => {
    const t = harness();
    const w = await world(t);
    await t.withIdentity(GUEST).mutation(api.share.claim, { token: "view" });
    expect(await titles(t.withIdentity(GUEST), w.workspaceId)).toEqual(["Roadmap:viewer"]);
  });

  test("draws the screen's row, without the share links", async () => {
    const t = harness();
    const w = await world(t);
    const [row] = (
      await t.withIdentity(ADMIN).query(api.workspaces.projectsFor, { workspaceId: w.workspaceId })
    ).filter((p) => p._id === w.open.projectId);
    expect(row).toMatchObject({
      _id: w.open.projectId,
      title: "Roadmap",
      workspaceId: w.workspaceId,
      pageCount: 1,
      firstPageDocId: w.open.docId,
      role: "owner",
    });
    expect(row).not.toHaveProperty("shareToken");
    expect(row).not.toHaveProperty("editShareToken");
  });
});
