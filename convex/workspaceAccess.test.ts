/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";
import { requireWorkspaceRole, workspaceRole, type ProjectRole } from "./auth";
import { seal } from "./github/seal";

/**
 * Who may do what to a workspace project, decided in `auth.ts` alone.
 *
 * The world is one workspace with a seat of every kind, and two projects made
 * by a member: one every member sees, one private. The properties worth
 * pinning are the ones the old owner-equality gates got wrong: the creator of
 * a workspace project edits it but does not manage it — even the rows that
 * carry their name — its admins manage it without having made it, and a seat
 * taken away takes everything made under it along.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

const OWNER = { subject: "user_ws_owner" };
const ADMIN = { subject: "user_ws_admin" };
/** A member, and the one who made every project in the world. */
const CREATOR = { subject: "user_creator" };
const MEMBER = { subject: "user_member" };
const GUEST = { subject: "user_guest" };
const REMOVED = { subject: "user_removed" };
const STRANGER = { subject: "user_stranger" };
const STAND_IN = { ...ADMIN, act: "ops_session_1" };

type Identity = { subject: string; act?: string };
type T = TestConvex<typeof schema>;
type Caller = Pick<T, "query" | "mutation" | "action">;

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
      const pageId = await ctx.db.insert("pages", {
        ownerId: CREATOR.subject,
        createdBy: CREATOR.subject,
        projectId,
        title: "Plan",
        order: 0,
        docId,
        createdAt: 1,
      });
      return { projectId, pageId, docId };
    };
    const open = await project("Roadmap");
    const secret = await project("Offsite", { visibility: "private" });
    const binned = await project("Old plans", { deletedAt: 5 });

    // Context the creator attached back when it was theirs to attach: every
    // row carries their name, and none of them is theirs to manage.
    const projectId = open.projectId;
    const repoId = await ctx.db.insert("projectRepos", {
      ownerId: CREATOR.subject,
      projectId,
      fullName: "acme/api",
      defaultBranch: "main",
      private: true,
      index: { state: "naming" },
      addedAt: 1,
    });
    const fileId = await ctx.db.insert("projectFiles", {
      ownerId: CREATOR.subject,
      projectId,
      storageId: await ctx.storage.store(new Blob(["# Spec"])),
      filename: "spec.md",
      mediaType: "text/markdown",
      size: 6,
      addedAt: 1,
    });
    const notionId = await ctx.db.insert("projectNotion", {
      ownerId: CREATOR.subject,
      projectId,
      pageId: "brief",
      title: "Brief",
      index: { state: "ready" },
      addedAt: 1,
    });
    const noteId = await ctx.db.insert("contextSheet", {
      ownerId: CREATOR.subject,
      projectId,
      question: "Who is it for?",
      source: "human",
      createdAt: 1,
    });
    const requestId = await ctx.db.insert("accessRequests", {
      projectId,
      requesterId: GUEST.subject,
      projectOwnerId: CREATOR.subject,
      workspaceId,
      status: "pending",
      createdAt: 1,
    });
    const upload = await ctx.storage.store(new Blob(["# Notes"]));

    return { workspaceId, open, secret, binned, repoId, fileId, notionId, noteId, requestId, upload };
  });
}

type World = Awaited<ReturnType<typeof world>>;

// Scheduled reads (a repository's summary, a Notion page) stay queued under
// fake timers, and anything that did reach for the network would fail loudly.
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
  vi.unstubAllEnvs();
});

describe("the role a seat gives", () => {
  const matrix: [string, Identity | null, ProjectRole | null, ProjectRole | null][] = [
    ["the workspace's owner", OWNER, "owner", "owner"],
    ["an admin", ADMIN, "owner", "owner"],
    ["the member who made it", CREATOR, "editor", "editor"],
    ["another member", MEMBER, "editor", null],
    ["a guest", GUEST, null, null],
    ["a removed member", REMOVED, null, null],
    ["a stranger", STRANGER, null, null],
    ["nobody signed in", null, null, null],
  ];

  test.each(matrix)("%s", async (_, who, open, secret) => {
    const t = harness();
    const w = await world(t);
    const caller = as(t, who);
    for (const [p, role] of [
      [w.open, open],
      [w.secret, secret],
    ] as const) {
      expect(await caller.query(api.projects.myRole, { projectId: p.projectId })).toBe(role);

      const project = await caller.query(api.projects.get, { projectId: p.projectId });
      expect(project?._id ?? null).toBe(role ? p.projectId : null);
      const pages = await caller.query(api.pages.listByProject, { projectId: p.projectId });
      expect(pages.map((page) => page._id)).toEqual(role ? [p.pageId] : []);

      const document = caller.query(api.ydoc.state, { docId: p.docId });
      if (role) await expect(document).resolves.toBe("empty");
      else await expect(document).rejects.toThrow("Not found");

      const write = caller.mutation(api.pages.create, { projectId: p.projectId });
      if (role === "owner" || role === "editor") await expect(write).resolves.toBeTruthy();
      else await expect(write).rejects.toThrow();
    }
  });

  test("an operator standing in for an admin reads as a viewer and writes nothing", async () => {
    const t = harness();
    const w = await world(t);
    const standIn = t.withIdentity(STAND_IN);
    expect(await standIn.query(api.projects.myRole, { projectId: w.open.projectId })).toBe(
      "viewer",
    );
    expect(await standIn.query(api.projects.get, { projectId: w.open.projectId })).not.toBeNull();
    await expect(
      standIn.mutation(api.pages.create, { projectId: w.open.projectId }),
    ).rejects.toThrow("Read-only");
    await expect(
      standIn.mutation(api.projects.rename, { projectId: w.open.projectId, title: "X" }),
    ).rejects.toThrow("Read-only");
  });

  test("a seat with no role of its own falls through to the link it came by", async () => {
    const t = harness();
    const w = await world(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(w.open.projectId, { shareToken: "view" });
      await ctx.db.patch(w.secret.projectId, { shareToken: "view-secret" });
      for (const [projectId, who] of [
        [w.open.projectId, GUEST],
        [w.secret.projectId, MEMBER],
      ] as const) {
        await ctx.db.insert("shareClaims", {
          projectId,
          granteeId: who.subject,
          role: "viewer",
          createdAt: 1,
        });
      }
    });
    expect(
      await t.withIdentity(GUEST).query(api.projects.myRole, { projectId: w.open.projectId }),
    ).toBe("viewer");
    expect(
      await t.withIdentity(MEMBER).query(api.projects.myRole, { projectId: w.secret.projectId }),
    ).toBe("viewer");
  });

  test("making a project confers nothing once the seat is gone", async () => {
    const t = harness();
    const w = await world(t);
    const projectId = await t.run((ctx) =>
      ctx.db.insert("projects", {
        ownerId: REMOVED.subject,
        title: "Theirs once",
        workspaceId: w.workspaceId,
        visibility: "private",
        createdAt: 1,
      }),
    );
    const removed = t.withIdentity(REMOVED);
    expect(await removed.query(api.projects.myRole, { projectId })).toBeNull();
    await expect(
      removed.mutation(api.projects.rename, { projectId, title: "Mine" }),
    ).rejects.toThrow("Not found");
    await expect(removed.query(api.share.links, { projectId })).rejects.toThrow("Not found");
    // Private, and still theirs to run: its admins' reach never depended on who made it.
    expect(await t.withIdentity(ADMIN).query(api.projects.myRole, { projectId })).toBe("owner");
  });

  test("a seat reaches nothing outside its workspace", async () => {
    const t = harness();
    await world(t);
    const projectId = await t.run((ctx) =>
      ctx.db.insert("projects", { ownerId: CREATOR.subject, title: "Diary", createdAt: 1 }),
    );
    expect(await t.withIdentity(CREATOR).query(api.projects.myRole, { projectId })).toBe("owner");
    for (const who of [OWNER, ADMIN, MEMBER]) {
      expect(await t.withIdentity(who).query(api.projects.myRole, { projectId })).toBeNull();
    }
  });

  test("a trashed project is nobody's to act in", async () => {
    const t = harness();
    const w = await world(t);
    const personal = await t.run((ctx) =>
      ctx.db.insert("projects", {
        ownerId: CREATOR.subject,
        title: "Binned diary",
        createdAt: 1,
        deletedAt: 5,
      }),
    );
    expect(
      await t.withIdentity(CREATOR).query(api.projects.myRole, { projectId: personal }),
    ).toBeNull();
    expect(
      await t.withIdentity(ADMIN).query(api.projects.myRole, { projectId: w.binned.projectId }),
    ).toBeNull();

    // Nor to manage, the rows hanging off it included: only `trash.restore` reaches in.
    await t.run((ctx) => ctx.db.patch(w.open.projectId, { deletedAt: 9 }));
    const admin = t.withIdentity(ADMIN);
    const projectId = w.open.projectId;
    await expect(admin.mutation(api.projects.rename, { projectId, title: "V2" })).rejects.toThrow(
      "Not found",
    );
    await expect(admin.query(api.share.links, { projectId })).rejects.toThrow("Not found");
    await expect(
      admin.mutation(api.share.setLink, { projectId, role: "viewer", enabled: true }),
    ).rejects.toThrow("Not found");
    await expect(admin.mutation(api.files.context.remove, { fileId: w.fileId })).rejects.toThrow(
      "Not found",
    );
    await expect(admin.mutation(api.github.repos.unlink, { repoId: w.repoId })).rejects.toThrow(
      "Not found",
    );
    expect(await admin.query(api.files.context.listForProject, { projectId })).toEqual([]);
    expect(await admin.query(api.github.repos.listForProject, { projectId })).toEqual([]);
  });
});

/**
 * Every manage gate that used to compare `ownerId`, one row each. Allowed
 * means the workspace's owner and admins; the member who made the project is
 * refused with everyone else — even for rows that carry their own name. The
 * repository tools, which editors use too, have their own tests below.
 */
type Gate = {
  name: string;
  /** Reads let an operator's stand-in through; writes never do. */
  kind: "read" | "write";
  /** A refused read either throws or answers empty; a refused write throws. */
  refusedEmpty?: boolean;
  /** What a refused caller is told, when it is not "Not found". */
  refusal?: RegExp;
  run: (caller: Caller, w: World) => Promise<unknown>;
};

const gates: Gate[] = [
  {
    name: "projects.rename",
    kind: "write",
    run: (c, w) => c.mutation(api.projects.rename, { projectId: w.open.projectId, title: "V2" }),
  },
  {
    name: "projects.remove",
    kind: "write",
    run: (c, w) => c.mutation(api.projects.remove, { projectId: w.open.projectId }),
  },
  {
    name: "trash.restore (a project)",
    kind: "write",
    run: (c, w) => c.mutation(api.trash.restore, { projects: [w.binned.projectId] }),
  },
  {
    name: "share.links",
    kind: "read",
    run: (c, w) => c.query(api.share.links, { projectId: w.open.projectId }),
  },
  {
    name: "share.setLink",
    kind: "write",
    run: (c, w) =>
      c.mutation(api.share.setLink, { projectId: w.open.projectId, role: "viewer", enabled: true }),
  },
  {
    name: "share.collaborators",
    kind: "read",
    run: (c, w) => c.query(api.share.collaborators, { projectId: w.open.projectId }),
  },
  {
    name: "share.incomingRequests",
    kind: "read",
    refusedEmpty: true,
    run: (c) => c.query(api.share.incomingRequests, {}),
  },
  {
    name: "share.decideRequest",
    kind: "write",
    run: (c, w) => c.mutation(api.share.decideRequest, { requestId: w.requestId, grant: false }),
  },
  {
    name: "nmlMigration.addToCohort (a project)",
    kind: "write",
    run: (c, w) =>
      c.mutation(api.nmlMigration.addToCohort, { scope: "project", key: w.open.projectId }),
  },
  {
    name: "nmlMigration.removeFromCohort (a project)",
    kind: "write",
    run: (c, w) =>
      c.mutation(api.nmlMigration.removeFromCohort, { scope: "project", key: w.open.projectId }),
  },
  {
    name: "github.repos.listForProject",
    kind: "read",
    refusedEmpty: true,
    run: (c, w) => c.query(api.github.repos.listForProject, { projectId: w.open.projectId }),
  },
  {
    name: "github.repos.link",
    kind: "write",
    run: (c, w) =>
      c.mutation(api.github.repos.link, {
        projectId: w.open.projectId,
        repos: [{ fullName: "acme/web", defaultBranch: "main", private: true }],
      }),
  },
  {
    name: "github.repos.unlink",
    kind: "write",
    run: (c, w) => c.mutation(api.github.repos.unlink, { repoId: w.repoId }),
  },
  {
    name: "github.repos.reindex",
    kind: "write",
    run: (c, w) => c.mutation(api.github.repos.reindex, { repoId: w.repoId }),
  },
  {
    name: "github.repos.refresh",
    kind: "write",
    refusal: /That repository is no longer linked\.|Not signed in/,
    run: (c, w) => c.action(api.github.repos.refresh, { repoId: w.repoId }),
  },
  {
    name: "github.naming.claim",
    kind: "write",
    run: (c, w) => c.mutation(api.github.naming.claim, { repoId: w.repoId }),
  },
  {
    name: "github.naming.apply",
    kind: "write",
    run: (c, w) => c.mutation(api.github.naming.apply, { repoId: w.repoId, names: [] }),
  },
  {
    name: "github.naming.skip",
    kind: "write",
    run: (c, w) => c.mutation(api.github.naming.skip, { repoId: w.repoId }),
  },
  {
    name: "files.context.listForProject",
    kind: "read",
    refusedEmpty: true,
    run: (c, w) => c.query(api.files.context.listForProject, { projectId: w.open.projectId }),
  },
  {
    name: "files.context.add",
    kind: "write",
    run: (c, w) =>
      c.mutation(api.files.context.add, {
        projectId: w.open.projectId,
        storageId: w.upload,
        filename: "notes.md",
        mediaType: "text/markdown",
      }),
  },
  {
    name: "files.context.remove",
    kind: "write",
    run: (c, w) => c.mutation(api.files.context.remove, { fileId: w.fileId }),
  },
  {
    name: "files.context.refresh",
    kind: "write",
    run: (c, w) => c.mutation(api.files.context.refresh, { fileId: w.fileId }),
  },
  {
    name: "notion.context.listForProject",
    kind: "read",
    refusedEmpty: true,
    run: (c, w) => c.query(api.notion.context.listForProject, { projectId: w.open.projectId }),
  },
  {
    name: "notion.context.link",
    kind: "write",
    run: (c, w) =>
      c.mutation(api.notion.context.link, {
        projectId: w.open.projectId,
        pages: [{ pageId: "handbook", title: "Handbook" }],
      }),
  },
  {
    name: "notion.context.unlink",
    kind: "write",
    run: (c, w) => c.mutation(api.notion.context.unlink, { rowId: w.notionId }),
  },
  {
    name: "notion.context.reindex",
    kind: "write",
    run: (c, w) => c.mutation(api.notion.context.reindex, { rowId: w.notionId }),
  },
  {
    name: "ai.context.list",
    kind: "read",
    refusedEmpty: true,
    run: (c, w) => c.query(api.ai.context.list, { projectId: w.open.projectId }),
  },
  {
    name: "ai.context.answer",
    kind: "write",
    run: (c, w) => c.mutation(api.ai.context.answer, { id: w.noteId, answer: "Operators" }),
  },
  {
    name: "ai.context.remove",
    kind: "write",
    run: (c, w) => c.mutation(api.ai.context.remove, { id: w.noteId }),
  },
];

describe.each(gates)("$name", (gate) => {
  test.each([
    ["the workspace's owner", OWNER],
    ["an admin", ADMIN],
  ])("is %s's", async (_, who) => {
    const t = harness();
    const w = await world(t);
    const result = await gate.run(t.withIdentity(who), w);
    if (gate.refusedEmpty) expect(result).not.toEqual([]);
  });

  test("is no one else's — not even the member who made the project", async () => {
    const t = harness();
    const w = await world(t);
    const refused: (Identity | null)[] = [CREATOR, MEMBER, GUEST, REMOVED, STRANGER, null];
    for (const who of refused) {
      const attempt = gate.run(as(t, who), w);
      if (gate.refusedEmpty) await expect(attempt).resolves.toEqual([]);
      else await expect(attempt).rejects.toThrow(gate.refusal ?? /Not found|Not signed in/);
    }
  });

  test(
    gate.kind === "read"
      ? "lets an operator's stand-in read"
      : "refuses an operator's stand-in",
    async () => {
      const t = harness();
      const w = await world(t);
      const attempt = gate.run(t.withIdentity(STAND_IN), w);
      // An empty answer is how five of these reads refuse, so it is no answer here.
      if (gate.kind === "read" && gate.refusedEmpty) await expect(attempt).resolves.not.toEqual([]);
      else if (gate.kind === "read") await expect(attempt).resolves.toBeDefined();
      else await expect(attempt).rejects.toThrow("Read-only");
    },
  );
});

describe("the manage gates' effects", () => {
  test("an admin's inbox holds a workspace project's requests; its creator's does not", async () => {
    const t = harness();
    const w = await world(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(w.secret.projectId, { shareToken: "view" });
      await ctx.db.insert("shareClaims", {
        projectId: w.secret.projectId,
        granteeId: STRANGER.subject,
        role: "viewer",
        createdAt: 1,
      });
    });
    await t.withIdentity(STRANGER).mutation(api.share.requestEdit, {
      projectId: w.secret.projectId,
    });

    for (const who of [OWNER, ADMIN]) {
      const inbox = await t.withIdentity(who).query(api.share.incomingRequests, {});
      expect(inbox.map((r) => r.projectId).sort()).toEqual(
        [w.open.projectId, w.secret.projectId].sort(),
      );
    }
    expect(await t.withIdentity(CREATOR).query(api.share.incomingRequests, {})).toEqual([]);

    const ask = (await t.withIdentity(ADMIN).query(api.share.incomingRequests, {})).find(
      (r) => r.projectId === w.secret.projectId,
    )!;
    await t
      .withIdentity(ADMIN)
      .mutation(api.share.decideRequest, { requestId: ask.requestId, grant: true });
    expect(
      await t.withIdentity(STRANGER).query(api.projects.myRole, { projectId: w.secret.projectId }),
    ).toBe("editor");
  });

  test("an admin passes through a share link unrecorded", async () => {
    const t = harness();
    const w = await world(t);
    await t.run((ctx) => ctx.db.patch(w.open.projectId, { shareToken: "view" }));
    await t.withIdentity(ADMIN).mutation(api.share.claim, { token: "view" });
    const claims = await t.run((ctx) => ctx.db.query("shareClaims").collect());
    expect(claims).toEqual([]);
  });

  test("an admin restores a project the creator put in the trash", async () => {
    const t = harness();
    const w = await world(t);
    await t.withIdentity(ADMIN).mutation(api.trash.restore, { projects: [w.binned.projectId] });
    expect(
      await t.withIdentity(CREATOR).query(api.projects.myRole, { projectId: w.binned.projectId }),
    ).toBe("editor");
  });

  test("the member who made a workspace project finds neither it nor its links on their own list", async () => {
    const t = harness();
    const w = await world(t);
    const diary = await t.run(async (ctx) => {
      await ctx.db.patch(w.secret.projectId, { shareToken: "view", editShareToken: "edit" });
      return await ctx.db.insert("projects", {
        ownerId: CREATOR.subject,
        title: "Diary",
        createdAt: 1,
      });
    });
    const listed = await t.withIdentity(CREATOR).query(api.projects.list, {});
    expect(listed.map((p) => p._id)).toEqual([diary]);
  });

  test("what an admin links is read with the admin's connection", async () => {
    const t = harness();
    const w = await world(t);
    await t.withIdentity(ADMIN).mutation(api.github.repos.link, {
      projectId: w.open.projectId,
      repos: [{ fullName: "acme/web", defaultBranch: "main", private: true }],
    });
    await t.withIdentity(ADMIN).mutation(api.notion.context.link, {
      projectId: w.open.projectId,
      pages: [{ pageId: "handbook", title: "Handbook" }],
    });
    const rows = await t.run(async (ctx) => ({
      repo: await ctx.db
        .query("projectRepos")
        .withIndex("by_project_and_fullName", (q) =>
          q.eq("projectId", w.open.projectId).eq("fullName", "acme/web"),
        )
        .unique(),
      page: await ctx.db
        .query("projectNotion")
        .withIndex("by_project_and_pageId", (q) =>
          q.eq("projectId", w.open.projectId).eq("pageId", "handbook"),
        )
        .unique(),
    }));
    expect(rows.repo?.ownerId).toBe(ADMIN.subject);
    expect(rows.page?.ownerId).toBe(ADMIN.subject);
  });
});

describe("the repository tools", () => {
  const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

  /** GitHub, played by a recorder: who asked, with which token, for what. */
  function github(searched: { total_count: number; items: unknown[] } = { total_count: 1, items: [] }) {
    const asked: { url: string; token: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        const token = new Headers(init?.headers).get("Authorization");
        asked.push({ url: String(url), token });
        return String(url).includes("/search/code")
          ? Response.json(searched)
          : new Response("export const ok = true;", { status: 200 });
      }),
    );
    return asked;
  }

  async function connect(t: T, who: Identity, token: string) {
    const sealed = await seal(token);
    await t.run((ctx) =>
      ctx.db.insert("githubAccounts", {
        ownerId: who.subject,
        sealed,
        login: who.subject,
        hint: "…",
        kind: "oauth",
        connectedAt: 1,
      }),
    );
  }

  test("a member reads a repository with its linker's connection", async () => {
    vi.stubEnv("GITHUB_TOKEN_KEY", KEY);
    const t = harness();
    const w = await world(t);
    await connect(t, CREATOR, "creator-token");
    await connect(t, MEMBER, "member-token");
    const asked = github();

    const read = await t.withIdentity(MEMBER).action(api.github.read.file, {
      projectId: w.open.projectId,
      repo: "acme/api",
      path: "src/index.ts",
    });
    expect(read).toMatchObject({ repo: "acme/api", content: "export const ok = true;" });
    expect(asked).toEqual([
      {
        url: expect.stringContaining("/repos/acme/api/contents/src/index.ts"),
        token: "Bearer creator-token",
      },
    ]);
  });

  test("a summary is refreshed by the project's managers, with its linker's connection", async () => {
    vi.stubEnv("GITHUB_TOKEN_KEY", KEY);
    const t = harness();
    const w = await world(t);
    await connect(t, CREATOR, "creator-token");
    await connect(t, ADMIN, "admin-token");
    const asked = github();
    const refresh = (who: Identity) =>
      t.withIdentity(who).action(api.github.repos.refresh, { repoId: w.repoId });

    for (const who of [CREATOR, MEMBER, GUEST, REMOVED, STRANGER]) {
      await expect(refresh(who)).rejects.toThrow("That repository is no longer linked.");
    }
    await expect(refresh(STAND_IN)).rejects.toThrow("Read-only");
    expect(asked).toEqual([]);

    // The admin who asks lends nothing of their own: it is the linker's GitHub read.
    await refresh(ADMIN);
    expect(asked).toEqual(
      ["", "/contents", "/readme"].map((path) => ({
        url: `https://api.github.com/repos/acme/api${path}`,
        token: "Bearer creator-token",
      })),
    );
  });

  test("a search spans linkers, one connection per repository it linked", async () => {
    vi.stubEnv("GITHUB_TOKEN_KEY", KEY);
    const t = harness();
    const w = await world(t);
    await t.run((ctx) =>
      ctx.db.insert("projectRepos", {
        ownerId: ADMIN.subject,
        projectId: w.open.projectId,
        fullName: "acme/web",
        defaultBranch: "main",
        private: true,
        addedAt: 1,
      }),
    );
    await connect(t, CREATOR, "creator-token");
    await connect(t, ADMIN, "admin-token");
    const asked = github();

    const found = await t.withIdentity(MEMBER).action(api.github.read.search, {
      projectId: w.open.projectId,
      query: "watchdog",
    });
    expect(found.total).toBe(2);
    expect(
      asked.map((a) => [new URL(a.url).searchParams.get("q"), a.token]).sort(),
    ).toEqual([
      ["watchdog repo:acme/api", "Bearer creator-token"],
      ["watchdog repo:acme/web", "Bearer admin-token"],
    ]);
  });

  test("a path never leads out of the repository it names", async () => {
    vi.stubEnv("GITHUB_TOKEN_KEY", KEY);
    const t = harness();
    const w = await world(t);
    await connect(t, CREATOR, "creator-token");
    const asked = github();
    const member = t.withIdentity(MEMBER);
    const at = (path: string) => ({ projectId: w.open.projectId, repo: "acme/api", path });

    for (const path of [
      "../../../victim/secret/contents/.env",
      "../../../../user/emails",
      "%2e%2e/%2e%2e/%2e%2e/%2e%2e/user/emails",
      "src/../../../../user",
      "src/./index.ts",
      "src//index.ts",
    ]) {
      await expect(member.action(api.github.read.file, at(path))).rejects.toThrow(
        "is not a path inside the repository",
      );
      await expect(member.action(api.github.read.tree, at(path))).rejects.toThrow(
        "is not a path inside the repository",
      );
    }
    expect(asked).toEqual([]);

    // Whatever else a name holds is sent as part of the name.
    for (const path of ["/docs/a b#c?.md/", "docs/100%.md", "docs\\..\\..\\user"]) {
      await member.action(api.github.read.file, { ...at(path), ref: "main" });
    }
    expect(asked.map((a) => a.url)).toEqual([
      "https://api.github.com/repos/acme/api/contents/docs/a%20b%23c%3F.md?ref=main",
      "https://api.github.com/repos/acme/api/contents/docs/100%25.md?ref=main",
      "https://api.github.com/repos/acme/api/contents/docs%5C..%5C..%5Cuser?ref=main",
    ]);
  });

  test("a search brings no scope of its own, and keeps nothing past the linked repositories", async () => {
    vi.stubEnv("GITHUB_TOKEN_KEY", KEY);
    const t = harness();
    const w = await world(t);
    await connect(t, CREATOR, "creator-token");
    const hit = (repo: string, path: string) => ({
      path,
      repository: { full_name: repo },
      text_matches: [{ fragment: `password in ${repo}` }],
    });
    const asked = github({
      total_count: 40,
      items: [hit("Acme/API", "src/db.ts"), hit("victim/infra", ".env")],
    });
    const member = t.withIdentity(MEMBER);
    const search = (query: string) =>
      member.action(api.github.read.search, { projectId: w.open.projectId, query });

    for (const query of [
      "password repo:victim/infra",
      "password org:victim",
      "password -user:someone",
      "password (REPO:victim/infra)",
    ]) {
      await expect(search(query)).rejects.toThrow("Leave out repo:, org: and user:");
    }
    expect(asked).toEqual([]);

    // However a search reached past its qualifiers, nothing it found there —
    // not a fragment, not the count — comes back.
    expect(await search("password")).toMatchObject({
      total: 1,
      results: [{ repo: "Acme/API", path: "src/db.ts", matches: ["password in Acme/API"] }],
    });
  });

  test("a share link reads no repository live, on a personal project or a workspace's", async () => {
    vi.stubEnv("GITHUB_TOKEN_KEY", KEY);
    const t = harness();
    const w = await world(t);
    await connect(t, CREATOR, "creator-token");
    const asked = github();
    // Each project's editor link, claimed by someone its container gives
    // nothing: a stranger on a personal project, a guest, and a member on a
    // private project someone else made.
    const side = await t.run(async (ctx) => {
      const side = await ctx.db.insert("projects", {
        ownerId: CREATOR.subject,
        title: "Side project",
        editShareToken: "edit-side",
        createdAt: 1,
      });
      await ctx.db.insert("projectRepos", {
        ownerId: CREATOR.subject,
        projectId: side,
        fullName: "cy/side",
        defaultBranch: "main",
        private: true,
        addedAt: 1,
      });
      await ctx.db.insert("projectRepos", {
        ownerId: CREATOR.subject,
        projectId: w.secret.projectId,
        fullName: "acme/offsite",
        defaultBranch: "main",
        private: true,
        addedAt: 1,
      });
      await ctx.db.patch(w.open.projectId, { editShareToken: "edit-open" });
      await ctx.db.patch(w.secret.projectId, { editShareToken: "edit-secret" });
      for (const [projectId, who] of [
        [side, STRANGER],
        [w.open.projectId, GUEST],
        [w.secret.projectId, MEMBER],
      ] as const) {
        await ctx.db.insert("shareClaims", {
          projectId,
          granteeId: who.subject,
          role: "editor",
          createdAt: 1,
        });
      }
      return side;
    });

    for (const [who, projectId, repo] of [
      [STRANGER, side, "cy/side"],
      [GUEST, w.open.projectId, "acme/api"],
      [MEMBER, w.secret.projectId, "acme/offsite"],
    ] as const) {
      const caller = t.withIdentity(who);
      // The link makes them an editor of the project, not a user of its
      // linker's GitHub.
      expect(await caller.query(api.projects.myRole, { projectId })).toBe("editor");
      await expect(
        caller.action(api.github.read.file, { projectId, repo, path: ".env", ref: "unreleased" }),
      ).rejects.toThrow("not one of this project's linked repositories");
      await expect(caller.action(api.github.read.tree, { projectId, repo })).rejects.toThrow(
        "not one of this project's linked repositories",
      );
      await expect(
        caller.action(api.github.read.search, { projectId, query: "password" }),
      ).rejects.toThrow("This project has no linked repositories.");
    }
    expect(asked).toEqual([]);

    // A personal project's owner reads their own, as they always have.
    await t.withIdentity(CREATOR).action(api.github.read.file, {
      projectId: side,
      repo: "cy/side",
      path: ".env",
    });
    expect(asked).toEqual([
      {
        url: expect.stringContaining("/repos/cy/side/contents/.env"),
        token: "Bearer creator-token",
      },
    ]);
  });

  test("anyone who cannot edit the project is told it is not linked", async () => {
    const t = harness();
    const w = await world(t);
    for (const who of [GUEST, REMOVED, STRANGER]) {
      await expect(
        t.withIdentity(who).action(api.github.read.file, {
          projectId: w.open.projectId,
          repo: "acme/api",
          path: "README.md",
        }),
      ).rejects.toThrow("not one of this project's linked repositories");
    }
    await expect(
      t.withIdentity(MEMBER).action(api.github.read.file, {
        projectId: w.secret.projectId,
        repo: "acme/api",
        path: "README.md",
      }),
    ).rejects.toThrow("not one of this project's linked repositories");
  });
});

describe("a personal row made in a project", () => {
  /** What REMOVED left behind while they still had a seat. */
  async function history(t: T, w: World) {
    return await t.run(async (ctx) => {
      await ctx.db.patch(
        (await ctx.db
          .query("memberships")
          .withIndex("by_workspace_user", (q) =>
            q.eq("workspaceId", w.workspaceId).eq("userId", REMOVED.subject),
          )
          .unique())!._id,
        { status: "active", removedAt: undefined },
      );
      const threadId = await ctx.db.insert("chatThreads", {
        ownerId: REMOVED.subject,
        projectId: w.open.projectId,
        title: "Pricing",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("chatMessages", {
        ownerId: REMOVED.subject,
        threadId,
        uiId: "m1",
        role: "assistant",
        seq: 0,
        parts: [{ type: "text", text: "The plan says…" }],
        createdAt: 1,
      });
      const checkpointId = await ctx.db.insert("checkpoints", {
        ownerId: REMOVED.subject,
        pageId: w.open.pageId,
        chatPromptId: "turn-1",
        docSnapshot: [],
        createdAt: 1,
      });
      await ctx.db.insert("chatTurns", {
        ownerId: REMOVED.subject,
        threadId,
        projectId: w.open.projectId,
        chatPromptId: "turn-1",
        pageIds: [w.open.pageId],
        checkpointIds: [checkpointId],
        trace: {},
        hunks: {},
        status: "accepted",
        createdAt: 1,
      });
      return { threadId, checkpointId };
    });
  }

  async function reads(t: T, ids: { threadId: Id<"chatThreads">; checkpointId: Id<"checkpoints"> }) {
    const me = t.withIdentity(REMOVED);
    return {
      thread: await me.query(api.chat.threads.get, { threadId: ids.threadId }),
      messages: await me.query(api.chat.messages.list, { threadId: ids.threadId }),
      checkpoint: await me.query(api.ai.checkpoints.get, { id: ids.checkpointId }),
      turn: await me.query(api.chat.turns.byPrompt, { chatPromptId: "turn-1" }),
    };
  }

  test("goes with the seat it was made under, at once", async () => {
    const t = harness();
    const w = await world(t);
    const ids = await history(t, w);

    const before = await reads(t, ids);
    expect(before.thread?._id).toBe(ids.threadId);
    expect(before.messages).toHaveLength(1);
    expect(before.checkpoint?._id).toBe(ids.checkpointId);
    expect(before.turn?.chatPromptId).toBe("turn-1");

    await t.run(async (ctx) => {
      const seat = await ctx.db
        .query("memberships")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", w.workspaceId).eq("userId", REMOVED.subject),
        )
        .unique();
      await ctx.db.patch(seat!._id, { status: "removed", removedAt: 3 });
    });

    expect(await reads(t, ids)).toEqual({
      thread: null,
      messages: [],
      checkpoint: null,
      turn: null,
    });
    await expect(
      t.withIdentity(REMOVED).mutation(api.chat.messages.put, {
        threadId: ids.threadId,
        uiId: "m2",
        role: "user",
        parts: [],
      }),
    ).rejects.toThrow("Not found");
    await expect(
      t.withIdentity(REMOVED).mutation(api.chat.turns.markRewound, { chatPromptId: "turn-1" }),
    ).rejects.toThrow("Not found");
  });

  test("reads as missing while its project is in the trash", async () => {
    const t = harness();
    const w = await world(t);
    const ids = await history(t, w);
    await t.run((ctx) => ctx.db.patch(w.open.projectId, { deletedAt: 9 }));
    expect(await reads(t, ids)).toEqual({
      thread: null,
      messages: [],
      checkpoint: null,
      turn: null,
    });
  });
});

describe("a seat, asked about directly", () => {
  const ranks = ["guest", "member", "admin", "owner"] as const;

  test("each seat passes its own rank and nothing above it", async () => {
    const t = harness();
    const w = await world(t);
    for (const [who, held] of [
      [OWNER, "owner"],
      [ADMIN, "admin"],
      [MEMBER, "member"],
      [GUEST, "guest"],
    ] as const) {
      const me = t.withIdentity(who);
      expect(await me.run((ctx) => workspaceRole(ctx, w.workspaceId))).toBe(held);
      for (const min of ranks) {
        const attempt = me.run((ctx) => requireWorkspaceRole(ctx, w.workspaceId, min));
        if (ranks.indexOf(min) <= ranks.indexOf(held)) {
          await expect(attempt).resolves.toMatchObject({ membership: { role: held } });
        } else {
          await expect(attempt).rejects.toThrow(
            min === "member" ? "A guest can’t do that here." : `Only a workspace ${min}`,
          );
        }
      }
    }
  });

  test("no seat, a removed seat and a deleted workspace all read as no workspace", async () => {
    const t = harness();
    const w = await world(t);
    for (const who of [REMOVED, STRANGER]) {
      const me = t.withIdentity(who);
      expect(await me.run((ctx) => workspaceRole(ctx, w.workspaceId))).toBeNull();
      await expect(
        me.run((ctx) => requireWorkspaceRole(ctx, w.workspaceId, "guest")),
      ).rejects.toThrow("Not found");
    }
    expect(await t.run((ctx) => workspaceRole(ctx, w.workspaceId))).toBeNull();

    await t.run((ctx) => ctx.db.patch(w.workspaceId, { deletedAt: 9 }));
    const owner = t.withIdentity(OWNER);
    expect(await owner.run((ctx) => workspaceRole(ctx, w.workspaceId))).toBeNull();
    await expect(
      owner.run((ctx) => requireWorkspaceRole(ctx, w.workspaceId, "owner")),
    ).rejects.toThrow("Not found");
  });

  test("an operator's stand-in acts on no workspace", async () => {
    const t = harness();
    const w = await world(t);
    await expect(
      t.withIdentity(STAND_IN).run((ctx) => requireWorkspaceRole(ctx, w.workspaceId, "guest")),
    ).rejects.toThrow("Read-only");
  });
});
