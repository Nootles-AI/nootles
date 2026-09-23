/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { NodeInput } from "./github/graphShape";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";

/**
 * The repository half of a project's context, and who reads it (`canReadCode`).
 *
 * A workspace project's code is its members'; a guest's only where the
 * workspace lets guests see code and a manager let this one; someone in by
 * link alone reads none of it. A personal project's is everyone's it is
 * shared with, as before. Whoever is refused still reads the pages and
 * documents, and finds the code simply absent — at every place code is read.
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

type Identity = { subject: string };
type T = TestConvex<typeof schema>;

const FULL = "acme/rover";

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  return t;
}

const node = (n: Partial<NodeInput> & Pick<NodeInput, "kind" | "externalId" | "title">): NodeInput => ({
  tier: n.kind === "repo" ? "source" : n.kind === "file" ? "artifact" : "concern",
  brief: "",
  summary: "",
  terms: n.title,
  ...n,
});

/** A project with a page and a document about the watchdog, and a repository that has one. */
async function project(t: T, ownerId: string, extra: Partial<Doc<"projects">>) {
  const made = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      ownerId,
      title: "Rover",
      shareToken: `view-${ownerId}`,
      createdAt: 1,
      ...extra,
    });
    const pageId = await ctx.db.insert("pages", {
      ownerId,
      createdBy: ownerId,
      projectId,
      title: "Watchdog plan",
      order: 0,
      docId: crypto.randomUUID(),
      createdAt: 1,
    });
    for (const [source, kind, externalId, title] of [
      ["pages", "page", pageId, "Watchdog plan"],
      ["files", "document", "spec.md", "Watchdog spec"],
    ] as const) {
      const nodeId = await ctx.db.insert("contextNodes", {
        projectId,
        source,
        tier: "source",
        kind,
        externalId,
        title,
        brief: "",
        owner: {},
      });
      await ctx.db.insert("contextNodeText", {
        nodeId,
        projectId,
        summary: "",
        summaryOrigin: "template",
        terms: title,
        searchText: title.toLowerCase(),
        contentHash: "",
        syncedAt: 1,
      });
    }
    const repoId = await ctx.db.insert("projectRepos", {
      ownerId,
      projectId,
      fullName: FULL,
      defaultBranch: "main",
      private: true,
      index: { state: "naming", files: 1, concerns: 1, areas: 1 },
      addedAt: 1,
    });
    return { projectId, pageId, repoId };
  });
  const written = await t.mutation(internal.github.graphStore.writeNodes, {
    repoId: made.repoId,
    nodes: [
      node({ kind: "repo", externalId: FULL, title: FULL }),
      node({ kind: "area", externalId: `${FULL}#area:firmware`, parent: FULL, title: "Firmware" }),
      node({
        kind: "concern",
        externalId: `${FULL}#concern:watchdog`,
        parent: `${FULL}#area:firmware`,
        title: "Watchdog",
      }),
      node({
        kind: "concern",
        externalId: `${FULL}#concern:telemetry`,
        parent: `${FULL}#area:firmware`,
        title: "Telemetry",
      }),
      node({
        kind: "file",
        externalId: `${FULL}:src/watchdog.c`,
        parent: `${FULL}#concern:watchdog`,
        title: "src/watchdog.c",
        terms: "src watchdog",
        url: `https://github.com/${FULL}/blob/main/src/watchdog.c`,
      }),
    ],
  });
  const id = new Map(written.map((w) => [w.externalId, w.id]));
  await t.mutation(internal.github.graphStore.writeEdges, {
    repoId: made.repoId,
    edges: [
      {
        from: id.get(`${FULL}#concern:watchdog`)!,
        to: id.get(`${FULL}#concern:telemetry`)!,
        family: "references",
        type: "rollup",
        weight: 1,
      },
    ],
  });
  return {
    ...made,
    concernId: id.get(`${FULL}#concern:watchdog`)!,
    fileId: id.get(`${FULL}:src/watchdog.c`)!,
  };
}

async function world(t: T, settings: { guestCodeAccess: boolean }) {
  const workspaceId = await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      slug: "acme",
      name: "Acme",
      createdBy: ADMIN.subject,
      plan: "team",
      settings: { linkSharing: true, joinDomains: [], autoJoin: false, ...settings },
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
    return workspaceId;
  });
  const team = await project(t, MEMBER.subject, { workspaceId });
  const personal = await project(t, OWNER.subject, {});
  await t.run(async (ctx) => {
    for (const [projectId, who] of [
      [team.projectId, GUEST],
      [team.projectId, STRANGER],
      [personal.projectId, STRANGER],
    ] as const) {
      await ctx.db.insert("shareClaims", {
        projectId,
        granteeId: who.subject,
        role: "viewer",
        createdAt: 1,
      });
    }
  });
  return { workspaceId, team, personal };
}

type Project = Awaited<ReturnType<typeof project>>;

/** Every read of a project's context, as `who` gets it: the code half, and the rest. */
async function reads(t: T, who: Identity, p: Project) {
  const caller = t.withIdentity(who);
  const { projectId } = p;
  const pack = await caller.query(api.context.read.packInputs, { projectId });
  const found = await caller.query(api.context.read.search, { projectId, query: "watchdog" });
  const graph = await caller.query(api.context.read.graph, { projectId });
  const code = {
    pack: pack?.code.map((c) => c.fullName),
    search: found.filter((f) => f.repo).map((f) => f.title).sort(),
    expand: (await caller.query(api.context.read.expand, { projectId, id: FULL }))?.title ?? null,
    read:
      (await caller.query(api.context.read.read, { projectId, id: `${FULL}:src/watchdog.c` }))
        ?.title ?? null,
    concern:
      (await caller.query(api.context.read.concern, { projectId, nodeId: p.concernId }))?.files.map(
        (f) => f.path,
      ) ?? null,
    graph: [graph?.code.repos.length, graph?.code.concerns.length, graph?.code.rollups.length],
    file:
      (await caller.query(internal.github.graphStore.fileForReader, { projectId, nodeId: p.fileId }))
        ?.path ?? null,
  };
  const rest = {
    pack: [pack?.pages.map((page) => page.title), pack?.documents.map((d) => d.title)],
    search: found.filter((f) => !f.repo).map((f) => f.title).sort(),
    graph: [graph?.pages.map((page) => page.title), graph?.documents.map((d) => d.title)],
    page: (await caller.query(api.context.read.read, { projectId, id: p.pageId }))?.title,
  };
  return { code, rest };
}

const ALL_CODE = {
  pack: [FULL],
  search: ["src/watchdog.c", "Watchdog"].sort(),
  expand: FULL,
  read: "src/watchdog.c",
  concern: ["src/watchdog.c"],
  graph: [1, 2, 1],
  file: "src/watchdog.c",
};
const NO_CODE = {
  pack: [],
  search: [],
  expand: null,
  read: null,
  concern: null,
  graph: [0, 0, 0],
  file: null,
};
const THE_REST = {
  pack: [["Watchdog plan"], ["Watchdog spec"]],
  search: ["Watchdog plan", "Watchdog spec"],
  graph: [["Watchdog plan"], ["Watchdog spec"]],
  page: "Watchdog plan",
};

const grant = (t: T, projectId: Id<"projects">, who: Identity, allowed = true) =>
  t
    .withIdentity(ADMIN)
    .mutation(api.share.setCodeAccess, { projectId, granteeId: who.subject, allowed });

describe("who reads a project's code", () => {
  test.each([
    ["an admin", ADMIN, true],
    ["a member", MEMBER, true],
    ["a guest", GUEST, false],
    ["someone in by link alone", STRANGER, false],
  ] as const)("on a workspace project: %s", async (_, who, reads_) => {
    const t = harness();
    const w = await world(t, { guestCodeAccess: false });
    expect(await reads(t, who, w.team)).toEqual({
      code: reads_ ? ALL_CODE : NO_CODE,
      rest: THE_REST,
    });
  });

  test.each([
    ["its owner", OWNER],
    ["someone in by link", STRANGER],
  ] as const)("on a personal project: %s, as always", async (_, who) => {
    const t = harness();
    const w = await world(t, { guestCodeAccess: false });
    expect(await reads(t, who, w.personal)).toEqual({ code: ALL_CODE, rest: THE_REST });
  });

  test("a guest a manager let in, while the workspace allows it — and only then", async () => {
    const t = harness();
    const w = await world(t, { guestCodeAccess: true });
    expect((await reads(t, GUEST, w.team)).code).toEqual(NO_CODE);

    await grant(t, w.team.projectId, GUEST);
    expect(await reads(t, GUEST, w.team)).toEqual({ code: ALL_CODE, rest: THE_REST });

    // Turned off for the workspace, the grant stays on the claim and opens nothing.
    await t.withIdentity(ADMIN).mutation(api.workspaces.updateSettings, {
      workspaceId: w.workspaceId,
      patch: { guestCodeAccess: false },
    });
    expect((await reads(t, GUEST, w.team)).code).toEqual(NO_CODE);
    await t.withIdentity(ADMIN).mutation(api.workspaces.updateSettings, {
      workspaceId: w.workspaceId,
      patch: { guestCodeAccess: true },
    });
    expect((await reads(t, GUEST, w.team)).code).toEqual(ALL_CODE);

    await grant(t, w.team.projectId, GUEST, false);
    expect((await reads(t, GUEST, w.team)).code).toEqual(NO_CODE);
  });

  test("a grant never reaches someone in by link alone, even written straight onto their claim", async () => {
    const t = harness();
    const w = await world(t, { guestCodeAccess: true });
    await t.run(async (ctx) => {
      const claim = await ctx.db
        .query("shareClaims")
        .withIndex("by_project_and_grantee", (q) =>
          q.eq("projectId", w.team.projectId).eq("granteeId", STRANGER.subject),
        )
        .unique();
      await ctx.db.patch(claim!._id, { codeAccess: true });
    });
    expect((await reads(t, STRANGER, w.team)).code).toEqual(NO_CODE);
  });

  test("the manager's own repository list is code too, and managers read it", async () => {
    const t = harness();
    const w = await world(t, { guestCodeAccess: false });
    const listed = (who: Identity, projectId: Id<"projects">) =>
      t.withIdentity(who).query(api.github.repos.listForProject, { projectId });
    expect((await listed(ADMIN, w.team.projectId)).map((r) => r.fullName)).toEqual([FULL]);
    expect((await listed(OWNER, w.personal.projectId)).map((r) => r.fullName)).toEqual([FULL]);
    for (const who of [MEMBER, GUEST, STRANGER]) {
      expect(await listed(who, w.team.projectId)).toEqual([]);
    }
  });

  test("a live repository read stays with the project's container, a granted guest's too", async () => {
    const t = harness();
    const w = await world(t, { guestCodeAccess: true });
    await grant(t, w.team.projectId, GUEST);
    const access = (who: Identity) =>
      t.withIdentity(who).query(internal.github.repos.access, { projectId: w.team.projectId });
    expect((await access(MEMBER)).map((r) => r.fullName)).toEqual([FULL]);
    expect(await access(GUEST)).toEqual([]);
    expect(await access(STRANGER)).toEqual([]);
  });
});

describe("letting a guest into the code", () => {
  test("is a manager's, for a guest, where the workspace allows it", async () => {
    const t = harness();
    const w = await world(t, { guestCodeAccess: true });
    const projectId = w.team.projectId;
    for (const who of [MEMBER, GUEST, STRANGER]) {
      await expect(
        t
          .withIdentity(who)
          .mutation(api.share.setCodeAccess, { projectId, granteeId: GUEST.subject, allowed: true }),
      ).rejects.toThrow("Not found");
    }
    await expect(grant(t, projectId, STRANGER)).rejects.toThrow(
      "Only a guest of the workspace can be given code context.",
    );

    await grant(t, projectId, GUEST);
    const people = await t.withIdentity(ADMIN).query(api.share.collaborators, { projectId });
    expect(people.map((p) => [p.granteeId, p.guest, p.codeAccess])).toEqual([
      [GUEST.subject, true, true],
      [STRANGER.subject, false, false],
    ]);
  });

  test("is refused while the workspace keeps code from guests, but taking it away never is", async () => {
    const t = harness();
    const w = await world(t, { guestCodeAccess: false });
    const projectId = w.team.projectId;
    await expect(grant(t, projectId, GUEST)).rejects.toThrow(
      "This workspace doesn’t let guests see code context.",
    );
    await grant(t, projectId, GUEST, false);
  });

  test("means nothing on a personal project, whose people read its code already", async () => {
    const t = harness();
    const w = await world(t, { guestCodeAccess: true });
    await expect(
      t.withIdentity(OWNER).mutation(api.share.setCodeAccess, {
        projectId: w.personal.projectId,
        granteeId: STRANGER.subject,
        allowed: true,
      }),
    ).rejects.toThrow("Everyone a personal project is shared with reads its code context already.");
  });
});

describe("naming a repository", () => {
  test("shows its outline only to a manager who reads the code", async () => {
    const t = harness();
    const w = await world(t, { guestCodeAccess: false });
    for (const who of [MEMBER, GUEST, STRANGER]) {
      await expect(
        t.withIdentity(who).mutation(api.github.naming.claim, { repoId: w.team.repoId }),
      ).rejects.toThrow("Not found");
    }
    const outline = await t
      .withIdentity(ADMIN)
      .mutation(api.github.naming.claim, { repoId: w.team.repoId });
    expect(outline?.fullName).toBe(FULL);
  });
});
