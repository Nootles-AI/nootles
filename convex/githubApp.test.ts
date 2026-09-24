/// <reference types="vite/client" />
import { createVerify, generateKeyPairSync } from "node:crypto";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { controlsAccount, reachableInstallation, REPOSITORY_PAGES } from "./github/app";
import { appJwt } from "./github/appAuth";
import { APP_TOKEN_REFUSED } from "./github/credential";
import { PUSH_DEBOUNCE_MS, PUSH_MAX_WAITS } from "./github/installations";
import { RECHECK_BATCH } from "./github/orgProof";
import { json } from "./github/rest";
import { open, seal } from "./github/seal";
import { signatureValid } from "./github/webhook";

/**
 * The GitHub App, workspace-owned: its JWT and token cache, the verified
 * install, the webhook, which credential reads a repository, personal
 * connections turned off, and the GitHub organisation rule. No request leaves
 * the process — `fetch` is stubbed for every test, and anything unexpected
 * answers 404.
 */

const modules = import.meta.glob("./**/*.ts");

const OWNER = { subject: "user_owner" };
const ADMIN = { subject: "user_admin" };
const MEMBER = { subject: "user_member" };
const GUEST = { subject: "user_guest" };

const FULL = "acme/rover";
const INSTALLATION = 42;
const SECRET = "whsec_test";
const DAY = 24 * 60 * 60_000;

type T = TestConvex<typeof schema>;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_DER = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-09-01T00:00:00Z") });
  vi.stubEnv("GITHUB_TOKEN_KEY", btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
  vi.stubEnv("GITHUB_APP_ID", "1234");
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", PRIVATE_DER);
  vi.stubEnv("GITHUB_APP_WEBHOOK_SECRET", SECRET);
  vi.stubEnv("GITHUB_APP_CLIENT_ID", "Iv1.client");
  vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "client-secret");
  vi.stubEnv("GITHUB_APP_SLUG", "nootles");
  fetchMock = vi.fn(async () => new Response("{}", { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** Each request `fetch` saw, as method, URL and bearer token. */
function calls() {
  return fetchMock.mock.calls.map(([input, init]) => ({
    method: (init as RequestInit | undefined)?.method ?? "GET",
    url: String(input),
    auth: new Headers((init as RequestInit | undefined)?.headers).get("authorization"),
  }));
}

/** A workspace with an owner, an admin, a member and a guest, and one project in it. */
async function world(t: T, settings: Partial<Doc<"workspaces">["settings"]> = {}) {
  return await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      slug: "acme",
      name: "Acme",
      createdBy: OWNER.subject,
      plan: "team",
      settings: { linkSharing: true, guestCodeAccess: false, joinDomains: [], autoJoin: false, ...settings },
      createdAt: 1,
    });
    for (const [who, role] of [
      [OWNER, "owner"],
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
    const projectId = await ctx.db.insert("projects", {
      ownerId: MEMBER.subject,
      title: "Rover",
      createdAt: 1,
      workspaceId,
      visibility: "workspace",
    });
    return { workspaceId, projectId };
  });
}

async function installation(
  t: T,
  workspaceId: Id<"workspaces">,
  extra: Partial<Doc<"githubInstallations">> = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("githubInstallations", {
      workspaceId,
      installationId: INSTALLATION,
      accountLogin: "acme",
      accountType: "Organization",
      repositorySelection: "selected",
      installedBy: ADMIN.subject,
      createdAt: 1,
      ...extra,
    }),
  );
}

async function repo(t: T, projectId: Id<"projects">, extra: Partial<Doc<"projectRepos">> = {}) {
  return await t.run(async (ctx) =>
    ctx.db.insert("projectRepos", {
      ownerId: MEMBER.subject,
      projectId,
      fullName: FULL,
      defaultBranch: "main",
      private: true,
      index: { state: "ready" },
      addedAt: 1,
      ...extra,
    }),
  );
}

describe("the App's JWT", () => {
  test("is RS256, issued by the App, back-dated a minute and good for nine", () => {
    const now = Date.parse("2026-09-01T00:00:00Z");
    const jwt = appJwt("1234", privateKey, now);
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(atob(header.replace(/-/g, "+").replace(/_/g, "/")))).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")))).toEqual({
      iat: now / 1000 - 60,
      exp: now / 1000 + 540,
      iss: "1234",
    });
    const verified = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .end()
      .verify(publicKey, signature, "base64url");
    expect(verified).toBe(true);
  });
});

describe("installation tokens", () => {
  test("a cached token with time left is used as it is", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const id = await installation(t, workspaceId, {
      token: { sealed: await seal("ghs_cached"), expiresAt: Date.now() + 30 * 60_000 },
    });
    expect(await t.action(internal.github.appAuth.token, { installation: id })).toBe("ghs_cached");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("one with under five minutes left is minted again, with the App's JWT, and cached", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const id = await installation(t, workspaceId, {
      token: { sealed: await seal("ghs_old"), expiresAt: Date.now() + 4 * 60_000 },
    });
    const expires = new Date(Date.now() + 60 * 60_000).toISOString();
    fetchMock.mockImplementation(async () => ok({ token: "ghs_new", expires_at: expires }));

    expect(await t.action(internal.github.appAuth.token, { installation: id })).toBe("ghs_new");
    const [call] = calls();
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`https://api.github.com/app/installations/${INSTALLATION}/access_tokens`);
    expect(call.auth?.split(".")).toHaveLength(3);

    fetchMock.mockClear();
    expect(await t.action(internal.github.appAuth.token, { installation: id })).toBe("ghs_new");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an uninstalled installation mints nothing and says why", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const id = await installation(t, workspaceId, { removedAt: 5 });
    await expect(t.action(internal.github.appAuth.token, { installation: id })).rejects.toThrow(
      /uninstalled from acme/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("GitHub refusing to mint, before its webhook lands, is said as the installation's state", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const id = await installation(t, workspaceId);
    const mint = () => t.action(internal.github.appAuth.token, { installation: id });

    fetchMock.mockImplementation(async () => new Response("{}", { status: 404 }));
    await expect(mint()).rejects.toThrow(/^The GitHub App was uninstalled from acme\. Install it again/);
    fetchMock.mockImplementation(async () => new Response("{}", { status: 403 }));
    await expect(mint()).rejects.toThrow(/^The GitHub App is suspended on acme\. Unsuspend it/);
    fetchMock.mockImplementation(
      async () =>
        new Response("{}", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1788220800" },
        }),
    );
    await expect(mint()).rejects.toThrow(/rate limit is spent/);
    fetchMock.mockImplementation(async () => new Response("{}", { status: 401 }));
    await expect(mint()).rejects.toThrow(/App’s own credentials/);
  });
});

describe("which credential reads a repository", () => {
  test("a repository linked through the App reads with the installation's token", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t);
    await installation(t, workspaceId, {
      token: { sealed: await seal("ghs_app"), expiresAt: Date.now() + 30 * 60_000 },
    });
    const repoId = await repo(t, projectId, { installationId: INSTALLATION });
    await t.action(internal.github.repos.sync, { repoId, ownerId: MEMBER.subject });
    const auths = new Set(calls().map((c) => c.auth));
    expect(auths).toEqual(new Set(["Bearer ghs_app"]));
  });

  test("anything else reads with its linker's own connection", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await world(t);
    await t.run(async (ctx) =>
      ctx.db.insert("githubAccounts", {
        ownerId: MEMBER.subject,
        sealed: await seal("gho_member"),
        login: "member",
        hint: "mber",
        kind: "oauth",
        connectedAt: 1,
      }),
    );
    const repoId = await repo(t, projectId);
    await t.action(internal.github.repos.sync, { repoId, ownerId: MEMBER.subject });
    expect(new Set(calls().map((c) => c.auth))).toEqual(new Set(["Bearer gho_member"]));
  });

  test("a token GitHub refuses is minted afresh and the call made once more", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t);
    await installation(t, workspaceId, {
      token: { sealed: await seal("ghs_stale"), expiresAt: Date.now() + 30 * 60_000 },
    });
    const repoId = await repo(t, projectId, { installationId: INSTALLATION });
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (String(input).endsWith("/access_tokens")) {
        return ok({ token: "ghs_fresh", expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      if (auth === "Bearer ghs_stale") return new Response("{}", { status: 401 });
      if (!String(input).endsWith(FULL)) return new Response("{}", { status: 404 });
      return ok({ full_name: FULL, default_branch: "main", description: null, private: true });
    });
    await t.action(internal.github.repos.sync, { repoId, ownerId: MEMBER.subject });
    const row = await t.run(async (ctx) => ctx.db.get(repoId));
    expect(row?.syncError).toBeUndefined();
    expect(row?.summary).toContain(FULL);
    expect(calls().filter((c) => c.method === "POST")).toHaveLength(1);
  });

  test("a fresh token refused too is minted once, not again, and the read fails", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t);
    const id = await installation(t, workspaceId, {
      token: { sealed: await seal("ghs_stale"), expiresAt: Date.now() + 30 * 60_000 },
    });
    const repoId = await repo(t, projectId, { installationId: INSTALLATION });
    fetchMock.mockImplementation(async (input: unknown) =>
      String(input).endsWith("/access_tokens")
        ? ok({ token: "ghs_fresh", expires_at: new Date(Date.now() + 3600_000).toISOString() })
        : new Response("{}", { status: 401 }),
    );
    await t.action(internal.github.repos.sync, { repoId, ownerId: MEMBER.subject });
    expect(calls().filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls().filter((c) => c.auth === "Bearer ghs_fresh").length).toBeGreaterThan(0);
    expect((await t.run(async (ctx) => ctx.db.get(repoId)))?.syncError).toBe(APP_TOKEN_REFUSED);
    const cached = (await t.run(async (ctx) => ctx.db.get(id)))?.token;
    expect(cached && (await open(cached.sealed))).toBe("ghs_fresh");
  });

  test("a suspended installation fails the read with a plain reason", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t);
    await installation(t, workspaceId, { suspendedAt: 5 });
    const repoId = await repo(t, projectId, { installationId: INSTALLATION });
    await t.action(internal.github.repos.sync, { repoId, ownerId: MEMBER.subject });
    expect((await t.run(async (ctx) => ctx.db.get(repoId)))?.syncError).toMatch(/suspended on acme/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a personal connection is refused once the workspace turns them off", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await world(t, { allowPersonalTokens: false });
    const repoId = await repo(t, projectId);
    await t.action(internal.github.repos.sync, { repoId, ownerId: MEMBER.subject });
    expect((await t.run(async (ctx) => ctx.db.get(repoId)))?.syncError).toMatch(/only through its GitHub App/);
  });

  describe("the indexer, as a re-index or a push schedules it", () => {
    async function indexed(t: T, repoId: Id<"projectRepos">) {
      await t.action(internal.github.indexer.run, { repoId });
      return (await t.run(async (ctx) => ctx.db.get(repoId)))?.index;
    }

    test("a suspended installation fails the run with its reason, asking GitHub nothing", async () => {
      const t = convexTest(schema, modules);
      const { workspaceId, projectId } = await world(t);
      await installation(t, workspaceId, { suspendedAt: 5 });
      const repoId = await repo(t, projectId, { installationId: INSTALLATION, index: { state: "queued" } });
      expect(await indexed(t, repoId)).toMatchObject({ state: "failed", error: expect.stringMatching(/suspended on acme/) });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("so does an uninstalled one", async () => {
      const t = convexTest(schema, modules);
      const { workspaceId, projectId } = await world(t);
      await installation(t, workspaceId, { removedAt: 5 });
      const repoId = await repo(t, projectId, { installationId: INSTALLATION, index: { state: "queued" } });
      expect(await indexed(t, repoId)).toMatchObject({ state: "failed", error: expect.stringMatching(/uninstalled from acme/) });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test("and one GitHub says is gone before its webhook has", async () => {
      const t = convexTest(schema, modules);
      const { workspaceId, projectId } = await world(t);
      await installation(t, workspaceId);
      const repoId = await repo(t, projectId, { installationId: INSTALLATION, index: { state: "queued" } });
      expect(await indexed(t, repoId)).toMatchObject({ state: "failed", error: expect.stringMatching(/^The GitHub App was uninstalled from acme/) });
      expect(calls().map((c) => c.method)).toEqual(["POST"]);
    });

    test("a personal connection, once the workspace turns them off", async () => {
      const t = convexTest(schema, modules);
      const { projectId } = await world(t, { allowPersonalTokens: false });
      const repoId = await repo(t, projectId, { index: { state: "queued" } });
      expect(await indexed(t, repoId)).toMatchObject({ state: "failed", error: expect.stringMatching(/only through its GitHub App/) });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe("linking", () => {
  const ref = { fullName: FULL, defaultBranch: "main", private: true };

  test("with personal connections off, a repository needs the workspace's installation", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t, { allowPersonalTokens: false });
    await expect(
      t.withIdentity(ADMIN).mutation(api.github.repos.link, { projectId, repos: [ref] }),
    ).rejects.toThrow(/only through its GitHub App/);

    await installation(t, workspaceId);
    await t
      .withIdentity(ADMIN)
      .mutation(api.github.repos.link, { projectId, repos: [{ ...ref, installationId: INSTALLATION }] });
    const rows = await t.run(async (ctx) => ctx.db.query("projectRepos").collect());
    expect(rows.map((r) => r.installationId)).toEqual([INSTALLATION]);
  });

  test("by default a personal connection still links", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await world(t);
    await t.withIdentity(ADMIN).mutation(api.github.repos.link, { projectId, repos: [ref] });
    expect(await t.run(async (ctx) => ctx.db.query("projectRepos").collect())).toHaveLength(1);
  });

  test("an installation from another workspace, or on a personal project, is refused", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await world(t);
    const other = await world(t);
    await installation(t, other.workspaceId);
    await expect(
      t
        .withIdentity(ADMIN)
        .mutation(api.github.repos.link, { projectId, repos: [{ ...ref, installationId: INSTALLATION }] }),
    ).rejects.toThrow(/isn’t part of this workspace/);

    const personal = await t.run(async (ctx) =>
      ctx.db.insert("projects", { ownerId: OWNER.subject, title: "Mine", createdAt: 1 }),
    );
    await expect(
      t.withIdentity(OWNER).mutation(api.github.repos.link, {
        projectId: personal,
        repos: [{ ...ref, installationId: INSTALLATION }],
      }),
    ).rejects.toThrow(/personal project/);
  });

  test("the workspace's own installation, uninstalled or suspended, links nothing", async () => {
    for (const [extra, why] of [
      [{ removedAt: 5 }, /uninstalled from acme/],
      [{ suspendedAt: 5 }, /suspended on acme/],
    ] as const) {
      const t = convexTest(schema, modules);
      const { workspaceId, projectId } = await world(t);
      await installation(t, workspaceId, extra);
      await expect(
        t
          .withIdentity(ADMIN)
          .mutation(api.github.repos.link, { projectId, repos: [{ ...ref, installationId: INSTALLATION }] }),
      ).rejects.toThrow(why);
      expect(await t.run(async (ctx) => ctx.db.query("projectRepos").collect())).toHaveLength(0);
    }
  });

  test("a manager re-indexes a repository read through the App, whoever linked it", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t);
    await installation(t, workspaceId);
    const repoId = await repo(t, projectId, { installationId: INSTALLATION });
    await t.withIdentity(ADMIN).mutation(api.github.repos.reindex, { repoId });
    expect((await t.run(async (ctx) => ctx.db.get(repoId)))?.index?.state).toBe("queued");
  });

  test("removing the member who linked it leaves a repository read through the App", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t);
    await installation(t, workspaceId);
    const appRepo = await repo(t, projectId, { installationId: INSTALLATION });
    const ownRepo = await repo(t, projectId, { fullName: "acme/own" });
    await t.withIdentity(ADMIN).mutation(api.members.remove, { workspaceId, userId: MEMBER.subject });
    expect(await t.run(async (ctx) => ctx.db.get(appRepo))).not.toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(ownRepo))).toBeNull();
  });
});

describe("installing", () => {
  /**
   * GitHub for one user: the installations they can reach, their login, and
   * their standing in the organisation `acme` (none answers 404).
   */
  function github(
    installations: { id: number; account?: { login: string; type: string } }[],
    {
      login = "octo",
      membership = { state: "active", role: "admin" } as { state: string; role: string } | null,
    } = {},
  ) {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") return ok({ access_token: "ghu_user" });
      if (url.startsWith("https://api.github.com/user/installations")) {
        return ok({
          installations: installations.map((i) => ({
            account: { login: "acme", type: "Organization" },
            ...i,
            repository_selection: "all",
          })),
        });
      }
      if (url === "https://api.github.com/user/memberships/orgs/acme" && membership) return ok(membership);
      if (url === "https://api.github.com/user") return ok({ login });
      return new Response("{}", { status: 404 });
    });
  }

  test("holding an account is its own login, or an active owner of its organisation", async () => {
    const org = { login: "acme", type: "Organization" };
    const person = { login: "Octo", type: "User" };
    github([]);
    expect(await controlsAccount("ghu_user", org)).toBe(true);
    expect(await controlsAccount("ghu_user", person)).toBe(true);
    expect(calls().every((c) => c.auth === "Bearer ghu_user")).toBe(true);
    github([], { login: "someone-else", membership: { state: "active", role: "member" } });
    expect(await controlsAccount("ghu_user", org)).toBe(false);
    expect(await controlsAccount("ghu_user", person)).toBe(false);
    github([], { membership: { state: "pending", role: "admin" } });
    expect(await controlsAccount("ghu_user", org)).toBe(false);
    github([], { membership: null });
    expect(await controlsAccount("ghu_user", org)).toBe(false);
  });

  test("an organisation's plain member, who can reach its installation, can't attach it", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    github([{ id: INSTALLATION }], { membership: { state: "active", role: "member" } });
    await expect(
      t
        .withIdentity(ADMIN)
        .action(api.github.app.install, { workspaceId, installationId: INSTALLATION, code: "c0de" }),
    ).rejects.toMatchObject({ data: { refused: "not_owner" } });
    expect(await t.run(async (ctx) => ctx.db.query("githubInstallations").collect())).toHaveLength(0);
  });

  test("a person's installation is theirs alone to attach", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const account = { login: "octo", type: "User" };
    github([{ id: INSTALLATION, account }], { login: "not-octo" });
    await expect(
      t
        .withIdentity(ADMIN)
        .action(api.github.app.install, { workspaceId, installationId: INSTALLATION, code: "c0de" }),
    ).rejects.toMatchObject({ data: { refused: "not_holder" } });
    expect(await t.run(async (ctx) => ctx.db.query("githubInstallations").collect())).toHaveLength(0);

    github([{ id: INSTALLATION, account }], { login: "Octo" });
    await t
      .withIdentity(ADMIN)
      .action(api.github.app.install, { workspaceId, installationId: INSTALLATION, code: "c0de" });
    expect(await t.run(async (ctx) => ctx.db.query("githubInstallations").collect())).toMatchObject([
      { accountLogin: "octo", accountType: "User" },
    ]);
  });

  test("the verification helper finds only installations GitHub lists for the user", async () => {
    github([{ id: 7 }, { id: INSTALLATION }]);
    expect((await reachableInstallation("ghu_user", INSTALLATION))?.id).toBe(INSTALLATION);
    expect(await reachableInstallation("ghu_user", 99)).toBeNull();
    expect(calls().every((c) => c.auth === "Bearer ghu_user")).toBe(true);
  });

  test("an admin records an installation GitHub says they can reach", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    github([{ id: INSTALLATION }]);
    await t
      .withIdentity(ADMIN)
      .action(api.github.app.install, { workspaceId, installationId: INSTALLATION, code: "c0de" });
    const rows = await t.run(async (ctx) => ctx.db.query("githubInstallations").collect());
    expect(rows).toMatchObject([
      {
        workspaceId,
        installationId: INSTALLATION,
        accountLogin: "acme",
        accountType: "Organization",
        repositorySelection: "all",
        installedBy: ADMIN.subject,
      },
    ]);
  });

  test("installing again after an uninstall brings the one row back into use", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t);
    await installation(t, workspaceId, {
      removedAt: 5,
      suspendedAt: 5,
      token: { sealed: "x", expiresAt: Date.now() + 3600_000 },
      installedBy: OWNER.subject,
    });
    const link = () =>
      t.withIdentity(ADMIN).mutation(api.github.repos.link, {
        projectId,
        repos: [{ fullName: FULL, defaultBranch: "main", private: true, installationId: INSTALLATION }],
      });
    await expect(link()).rejects.toThrow(/uninstalled/);

    github([{ id: INSTALLATION }]);
    await t
      .withIdentity(ADMIN)
      .action(api.github.app.install, { workspaceId, installationId: INSTALLATION, code: "c0de" });
    const rows = await t.run(async (ctx) => ctx.db.query("githubInstallations").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repositorySelection: "all", installedBy: OWNER.subject });
    expect(rows[0].removedAt).toBeUndefined();
    expect(rows[0].suspendedAt).toBeUndefined();
    expect(rows[0].token).toBeUndefined();

    await link();
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query("projectRepos")
          .withIndex("by_installation_and_fullName", (q) =>
            q.eq("installationId", INSTALLATION).eq("fullName", FULL),
          )
          .collect(),
      ),
    ).toHaveLength(1);
  });

  test("an id GitHub doesn't list for them is refused", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    github([{ id: 7 }]);
    await expect(
      t
        .withIdentity(ADMIN)
        .action(api.github.app.install, { workspaceId, installationId: INSTALLATION, code: "c0de" }),
    ).rejects.toMatchObject({ data: { refused: "unreachable" } });
    expect(await t.run(async (ctx) => ctx.db.query("githubInstallations").collect())).toHaveLength(0);
  });

  test("only an admin may, and a member's attempt never reaches GitHub", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    github([{ id: INSTALLATION }]);
    await expect(
      t
        .withIdentity(MEMBER)
        .action(api.github.app.install, { workspaceId, installationId: INSTALLATION, code: "c0de" }),
    ).rejects.toThrow(/Only a workspace admin/);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      t.withIdentity(MEMBER).mutation(internal.github.installations.record, {
        workspaceId,
        installationId: INSTALLATION,
        accountLogin: "acme",
        accountType: "Organization",
        repositorySelection: "all",
        suspended: false,
      }),
    ).rejects.toThrow(/Only a workspace admin/);
  });
});

describe("the webhook", () => {
  async function signed(body: string, secret = SECRET) {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
    return `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  }

  /** The repositories whose code graph is scheduled to be forgotten. */
  async function forgotten(t: T) {
    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    return scheduled
      .filter((s) => s.name.includes("graphStore") && s.name.includes("forget"))
      .map((s) => (s.args[0] as { repoId: Id<"projectRepos"> }).repoId);
  }

  async function deliver(t: T, event: string, payload: object) {
    const body = JSON.stringify(payload);
    return await t.fetch("/github/webhook", {
      method: "POST",
      headers: { "x-github-event": event, "x-hub-signature-256": await signed(body) },
      body,
    });
  }

  test("a signature is checked over the exact bytes", async () => {
    const body = new TextEncoder().encode('{"zen":"hi"}').buffer as ArrayBuffer;
    const good = await signed('{"zen":"hi"}');
    expect(await signatureValid(SECRET, body, good)).toBe(true);
    expect(await signatureValid(SECRET, body, await signed('{"zen":"hi"} '))).toBe(false);
    expect(await signatureValid(SECRET, body, await signed('{"zen":"hi"}', "other"))).toBe(false);
    expect(await signatureValid(SECRET, body, good.replace("sha256=", "sha1="))).toBe(false);
    expect(await signatureValid(SECRET, body, null)).toBe(false);
  });

  test("valid is 200, invalid and missing are 401, an unknown event is acknowledged", async () => {
    const t = convexTest(schema, modules);
    const body = JSON.stringify({ zen: "hi", installation: { id: INSTALLATION } });
    const post = (headers: Record<string, string>) =>
      t.fetch("/github/webhook", { method: "POST", headers: { "x-github-event": "ping", ...headers }, body });
    expect((await post({ "x-hub-signature-256": await signed(body) })).status).toBe(200);
    expect((await post({ "x-hub-signature-256": await signed(body, "wrong") })).status).toBe(401);
    expect((await post({})).status).toBe(401);
  });

  test("with no secret set, nothing is accepted and nothing changes", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t);
    const id = await installation(t, workspaceId);
    const appRepo = await repo(t, projectId, { installationId: INSTALLATION });
    vi.stubEnv("GITHUB_APP_WEBHOOK_SECRET", "");
    const body = JSON.stringify({ action: "deleted", installation: { id: INSTALLATION } });
    for (const secret of ["", SECRET]) {
      const res = await t.fetch("/github/webhook", {
        method: "POST",
        headers: { "x-github-event": "installation", "x-hub-signature-256": await signed(body, secret || "x") },
        body,
      });
      expect(res.status).toBe(503);
    }
    expect((await t.run(async (ctx) => ctx.db.get(id)))?.removedAt).toBeUndefined();
    expect(await t.run(async (ctx) => ctx.db.get(appRepo))).not.toBeNull();
  });

  test("a push to the default branch re-indexes once per window", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t);
    await installation(t, workspaceId);
    const repoId = await repo(t, projectId, { installationId: INSTALLATION });
    const push = (ref: string) =>
      deliver(t, "push", { ref, repository: { full_name: FULL }, installation: { id: INSTALLATION } });

    await push("refs/heads/feature");
    expect((await t.run(async (ctx) => ctx.db.get(repoId)))?.pushReindexAt).toBeUndefined();

    await push("refs/heads/main");
    await push("refs/heads/main");
    const row = await t.run(async (ctx) => ctx.db.get(repoId));
    expect(row?.pushReindexAt).toBe(Date.now() + PUSH_DEBOUNCE_MS);
    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((s) => s.name.includes("pushReindex"))).toHaveLength(1);

    await t.mutation(internal.github.installations.pushReindex, { repoId });
    const after = await t.run(async (ctx) => ctx.db.get(repoId));
    expect(after?.index?.state).toBe("queued");
    expect(after?.pushReindexAt).toBeUndefined();
  });

  test("a push waits out a run under way, but not one that died without saying so", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t);
    await installation(t, workspaceId);
    const repoId = await repo(t, projectId, { installationId: INSTALLATION, index: { state: "indexing" } });
    const waits = async () =>
      (await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect()))
        .filter((s) => s.name.includes("pushReindex") && s.state.kind === "pending")
        .map((s) => (s.args[0] as { waited?: number }).waited);
    const runs = async () =>
      (await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter(
        (s) => s.name.includes("indexer") && s.name.includes("run"),
      );

    await t.mutation(internal.github.installations.pushReindex, { repoId });
    expect(await waits()).toEqual([1]);
    expect((await t.run(async (ctx) => ctx.db.get(repoId)))?.index?.state).toBe("indexing");

    for (let waited = 1; waited < PUSH_MAX_WAITS; waited += 1) {
      await t.mutation(internal.github.installations.pushReindex, { repoId, waited });
    }
    expect(await runs()).toHaveLength(0);

    // An hour of "indexing" is a run killed before its catch could run.
    await t.run(async (ctx) => {
      for (const s of await ctx.db.system.query("_scheduled_functions").collect()) {
        await ctx.scheduler.cancel(s._id);
      }
    });
    await t.mutation(internal.github.installations.pushReindex, { repoId, waited: PUSH_MAX_WAITS });
    const after = await t.run(async (ctx) => ctx.db.get(repoId));
    expect(after?.index?.state).toBe("queued");
    expect(after?.pushReindexAt).toBeUndefined();
    expect(await waits()).toEqual([]);
    expect(await runs()).toHaveLength(1);
  });

  test("an uninstall marks the installation removed and unlinks its repositories", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t);
    const id = await installation(t, workspaceId, {
      token: { sealed: "x", expiresAt: Date.now() + 3600_000 },
    });
    const appRepo = await repo(t, projectId, { installationId: INSTALLATION });
    const ownRepo = await repo(t, projectId, { fullName: "acme/own" });
    for (let i = 0; i < 2; i += 1) {
      const res = await deliver(t, "installation", { action: "deleted", installation: { id: INSTALLATION } });
      expect(res.status).toBe(200);
    }
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.removedAt).toBeDefined();
    expect(row?.token).toBeUndefined();
    expect(await t.run(async (ctx) => ctx.db.get(appRepo))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(ownRepo))).not.toBeNull();
    expect(await forgotten(t)).toEqual([appRepo]);
  });

  test("suspend and unsuspend mark and clear", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const id = await installation(t, workspaceId);
    await deliver(t, "installation", { action: "suspend", installation: { id: INSTALLATION } });
    expect((await t.run(async (ctx) => ctx.db.get(id)))?.suspendedAt).toBeDefined();
    await deliver(t, "installation", { action: "unsuspend", installation: { id: INSTALLATION } });
    expect((await t.run(async (ctx) => ctx.db.get(id)))?.suspendedAt).toBeUndefined();
  });

  test("repositories taken out of the installation are unlinked", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t);
    const id = await installation(t, workspaceId);
    const rover = await repo(t, projectId, { installationId: INSTALLATION });
    const other = await repo(t, projectId, { installationId: INSTALLATION, fullName: "acme/other" });
    await deliver(t, "installation_repositories", {
      action: "removed",
      installation: { id: INSTALLATION, repository_selection: "selected" },
      repositories_removed: [{ full_name: FULL }],
    });
    expect(await t.run(async (ctx) => ctx.db.get(rover))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(other))).not.toBeNull();
    expect(await forgotten(t)).toEqual([rover]);
    expect((await t.run(async (ctx) => ctx.db.get(id)))?.repositorySelection).toBe("selected");
  });

  test("a member leaving the organisation loses their proof of the rule", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t, { requireGithubOrg: "acme" });
    await installation(t, workspaceId);
    await t.run(async (ctx) => {
      for (const seat of await ctx.db.query("memberships").collect()) {
        await ctx.db.patch(seat._id, {
          githubOrgVerifiedAt: Date.now(),
          githubOrgLogin: seat.userId === MEMBER.subject ? "Octo-Member" : "someone-else",
        });
      }
    });
    await deliver(t, "organization", {
      action: "member_removed",
      organization: { login: "ACME" },
      membership: { user: { login: "octo-member" } },
      installation: { id: INSTALLATION },
    });
    const seats = await t.run(async (ctx) => ctx.db.query("memberships").collect());
    for (const seat of seats) {
      expect(seat.githubOrgVerifiedAt === undefined).toBe(seat.userId === MEMBER.subject);
      // Who they are stays, so the nightly check lets them back in if they rejoin.
      expect(seat.githubOrgLogin).toBeDefined();
    }
  });

  test("a member who left is known by their account id, whatever their login is now", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t, { requireGithubOrg: "acme" });
    await installation(t, workspaceId);
    await t.run(async (ctx) => {
      for (const seat of await ctx.db.query("memberships").collect()) {
        const member = seat.userId === MEMBER.subject;
        await ctx.db.patch(seat._id, {
          githubOrgVerifiedAt: Date.now(),
          githubOrgLogin: member ? "old-name" : "new-name",
          githubUserId: member ? 7 : 8,
        });
      }
    });
    await deliver(t, "organization", {
      action: "member_removed",
      organization: { login: "acme" },
      membership: { user: { login: "new-name", id: 7 } },
      installation: { id: INSTALLATION },
    });
    const seats = await t.run(async (ctx) => ctx.db.query("memberships").collect());
    for (const seat of seats) {
      expect(seat.githubOrgVerifiedAt === undefined).toBe(seat.userId === MEMBER.subject);
    }
  });
});

describe("the GitHub organisation rule", () => {
  async function readsCode(t: T, who: { subject: string }, projectId: Id<"projects">) {
    const rows = await t.withIdentity(who).query(internal.github.repos.access, { projectId });
    return rows.length > 0;
  }

  test("off, every member reads code; on, only a proof under three days old does", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t);
    await repo(t, projectId);
    expect(await readsCode(t, MEMBER, projectId)).toBe(true);
    expect(await readsCode(t, ADMIN, projectId)).toBe(true);

    await t.run(async (ctx) => {
      const workspace = (await ctx.db.get(workspaceId))!;
      await ctx.db.patch(workspaceId, { settings: { ...workspace.settings, requireGithubOrg: "acme" } });
    });
    expect(await readsCode(t, MEMBER, projectId)).toBe(false);
    expect(await readsCode(t, ADMIN, projectId)).toBe(false);

    const stampAt = async (who: { subject: string }, at: number) =>
      t.run(async (ctx) => {
        const seat = (await ctx.db
          .query("memberships")
          .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", who.subject))
          .unique())!;
        await ctx.db.patch(seat._id, { githubOrgVerifiedAt: at, githubOrgLogin: who.subject });
      });
    await stampAt(MEMBER, Date.now() - 2 * DAY);
    await stampAt(ADMIN, Date.now() - 4 * DAY);
    expect(await readsCode(t, MEMBER, projectId)).toBe(true);
    expect(await readsCode(t, ADMIN, projectId)).toBe(false);
    expect(await readsCode(t, GUEST, projectId)).toBe(false);
    // The integrations screen and the context panel say the same, from the status.
    const passes = async (who: { subject: string }) =>
      (await t.withIdentity(who).query(api.github.app.status, { workspaceId }))?.orgProof.passes;
    expect(await passes(MEMBER)).toBe(true);
    expect(await passes(ADMIN)).toBe(false);
  });

  test("the rule names an organisation the App is installed on, and moving it starts proofs over", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await expect(
      t.withIdentity(ADMIN).mutation(api.github.app.setOrgRule, { workspaceId, org: "acme" }),
    ).rejects.toThrow(/installed on/);
    await installation(t, workspaceId);
    await installation(t, workspaceId, { installationId: 43, accountLogin: "Beta" });
    await expect(
      t.withIdentity(MEMBER).mutation(api.github.app.setOrgRule, { workspaceId, org: "acme" }),
    ).rejects.toThrow(/Only a workspace admin/);

    await t.withIdentity(ADMIN).mutation(api.github.app.setOrgRule, { workspaceId, org: "ACME" });
    const settings = async () => (await t.run(async (ctx) => ctx.db.get(workspaceId)))!.settings;
    expect((await settings()).requireGithubOrg).toBe("acme");

    await t.run(async (ctx) => {
      for (const seat of await ctx.db.query("memberships").collect()) {
        await ctx.db.patch(seat._id, { githubOrgVerifiedAt: Date.now(), githubOrgLogin: "x" });
      }
    });
    await t.withIdentity(ADMIN).mutation(api.github.app.setOrgRule, { workspaceId, org: "beta" });
    expect((await settings()).requireGithubOrg).toBe("Beta");
    const seats = await t.run(async (ctx) => ctx.db.query("memberships").collect());
    expect(seats.every((s) => s.githubOrgVerifiedAt === undefined)).toBe(true);

    await t.withIdentity(ADMIN).mutation(api.github.app.setOrgRule, { workspaceId, org: null });
    expect((await settings()).requireGithubOrg).toBeUndefined();
  });

  const APP_TOKEN = "ghs_app";
  const USER = "https://api.github.com/user";
  const MEMBERS = "https://api.github.com/orgs/acme/members/";

  /** A rule on acme, the App installed there with a live token, and the member connected. */
  async function ruled(t: T, extra: Partial<Doc<"githubInstallations">> = {}) {
    const { workspaceId, projectId } = await world(t, { requireGithubOrg: "acme" });
    const id = await installation(t, workspaceId, {
      token: { sealed: await seal(APP_TOKEN), expiresAt: Date.now() + 30 * 60_000 },
      ...extra,
    });
    await t.run(async (ctx) =>
      ctx.db.insert("githubAccounts", {
        ownerId: MEMBER.subject,
        sealed: await seal("gho_member"),
        // What was true at connect; `GET /user` is asked again every check.
        login: "octo-before-rename",
        hint: "mber",
        kind: "oauth",
        connectedAt: 1,
      }),
    );
    return { workspaceId, projectId, installation: id };
  }

  /** GitHub as the stubs have it: who the token is, and who is in acme. */
  function github(members: Set<string>, user: object | Response = { login: "octo", id: 7 }) {
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization");
      if (url === USER) return user instanceof Response ? user : ok(user);
      if (url.endsWith(`/app/installations/${INSTALLATION}/access_tokens`)) {
        return ok({ token: APP_TOKEN, expires_at: new Date(Date.now() + 60 * 60_000).toISOString() });
      }
      if (url.startsWith(MEMBERS) && auth === `Bearer ${APP_TOKEN}`) {
        return new Response(null, { status: members.has(url.slice(MEMBERS.length)) ? 204 : 404 });
      }
      return new Response("{}", { status: 404 });
    });
  }

  const seatOf = (t: T, workspaceId: Id<"workspaces">, who: { subject: string }) =>
    t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", who.subject))
        .unique(),
    );

  test("who they are comes from their own connection; whether they're in it, from the App", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await ruled(t);
    await repo(t, projectId);
    github(new Set(["octo"]));

    expect(await t.withIdentity(MEMBER).action(api.github.orgProof.verify, { workspaceId })).toEqual({
      required: true,
      verified: true,
      login: "octo",
    });
    // The login is GitHub's answer to `GET /user` — not the stored one, and not the client's.
    expect(calls()).toEqual([
      { method: "GET", url: USER, auth: "Bearer gho_member" },
      { method: "GET", url: `${MEMBERS}octo`, auth: `Bearer ${APP_TOKEN}` },
    ]);
    expect(await seatOf(t, workspaceId, MEMBER)).toMatchObject({
      githubOrgVerifiedAt: Date.now(),
      githubOrgLogin: "octo",
      githubUserId: 7,
    });
    expect(await readsCode(t, MEMBER, projectId)).toBe(true);
  });

  test("someone the organisation doesn't have is told so, and keeps no pass", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await ruled(t);
    await t.run(async (ctx) => {
      const seat = (await ctx.db
        .query("memberships")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", MEMBER.subject))
        .unique())!;
      await ctx.db.patch(seat._id, { githubOrgVerifiedAt: Date.now() - DAY, githubOrgLogin: "octo" });
    });
    github(new Set());
    expect(await t.withIdentity(MEMBER).action(api.github.orgProof.verify, { workspaceId })).toEqual({
      required: true,
      verified: false,
      login: "octo",
    });
    const seat = await seatOf(t, workspaceId, MEMBER);
    expect(seat?.githubOrgVerifiedAt).toBeUndefined();
    // Known, so the nightly check can let them in once the organisation does.
    expect(seat?.githubOrgLogin).toBe("octo");

    // A redirect to the public list is not a yes either, and isn't followed.
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) =>
      String(input) === USER
        ? ok({ login: "octo", id: 7 })
        : (init as RequestInit).redirect === "manual"
          ? new Response(null, { status: 302, headers: { location: "https://api.github.com/orgs/acme/public_members/octo" } })
          : new Response(null, { status: 204 }),
    );
    expect((await t.withIdentity(MEMBER).action(api.github.orgProof.verify, { workspaceId })).verified).toBe(false);
  });

  test("a connection GitHub won't answer for asks them to reconnect — no token lecture", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await ruled(t);
    github(new Set(["octo"]), new Response("{}", { status: 401 }));
    await expect(t.withIdentity(MEMBER).action(api.github.orgProof.verify, { workspaceId })).rejects.toThrow(
      /Reconnect GitHub/,
    );
    github(new Set(["octo"]), new Response("{}", { status: 403 }));
    const refused = t.withIdentity(MEMBER).action(api.github.orgProof.verify, { workspaceId });
    await expect(refused).rejects.toThrow(/Reconnect GitHub/);
    await expect(refused).rejects.not.toThrow(/fine-grained/);
    // The App was never asked about someone we couldn't identify.
    expect(calls().some((c) => c.url.startsWith(MEMBERS))).toBe(false);
    expect((await seatOf(t, workspaceId, MEMBER))?.githubOrgLogin).toBeUndefined();

    await expect(
      t.withIdentity(ADMIN).action(api.github.orgProof.verify, { workspaceId }),
    ).rejects.toThrow(/No GitHub account is connected/);
  });

  test("an App suspended, uninstalled or short of Members: read says so plainly", async () => {
    for (const [extra, said] of [
      [{ suspendedAt: 5 }, /GitHub App is suspended on acme/],
      [{ removedAt: 5 }, /no longer installed on acme/],
    ] as const) {
      const t = convexTest(schema, modules);
      const { workspaceId } = await ruled(t, extra);
      fetchMock.mockClear();
      await expect(t.withIdentity(MEMBER).action(api.github.orgProof.verify, { workspaceId })).rejects.toThrow(said);
      expect(fetchMock).not.toHaveBeenCalled();
    }

    const t = convexTest(schema, modules);
    const { workspaceId } = await ruled(t);
    fetchMock.mockImplementation(async (input: unknown) =>
      String(input) === USER ? ok({ login: "octo", id: 7 }) : new Response("{}", { status: 403 }),
    );
    await expect(t.withIdentity(MEMBER).action(api.github.orgProof.verify, { workspaceId })).rejects.toThrow(
      /can’t read acme’s members/,
    );
  });

  test("connecting GitHub checks the rule unasked", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await ruled(t);
    github(new Set(["octo"]));
    await t.mutation(internal.github.account.save, {
      ownerId: MEMBER.subject,
      sealed: await seal("gho_member"),
      login: "octo",
      hint: "mber",
      kind: "oauth",
      connectedAt: Date.now(),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await seatOf(t, workspaceId, MEMBER)).toMatchObject({
      githubOrgVerifiedAt: Date.now(),
      githubOrgLogin: "octo",
    });
  });

  test("each night the App renews members' proofs and clears the rest, with no one's own token", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await ruled(t);
    await repo(t, projectId);
    const at = Date.now() - 2 * DAY;
    await t.run(async (ctx) => {
      for (const seat of await ctx.db.query("memberships").collect()) {
        if (seat.userId === MEMBER.subject) await ctx.db.patch(seat._id, { githubOrgVerifiedAt: at, githubOrgLogin: "octo" });
        if (seat.userId === ADMIN.subject) await ctx.db.patch(seat._id, { githubOrgVerifiedAt: at, githubOrgLogin: "gone" });
        // OWNER: never connected, so there is nobody to ask about.
      }
    });
    github(new Set(["octo"]));
    vi.setSystemTime(Date.now() + 2 * DAY);
    await t.mutation(internal.github.orgProof.sweep, { cursor: null });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // The cached token has run out by now, so the App mints one; nobody's own is used.
    expect(calls().some((c) => c.auth === "Bearer gho_member")).toBe(false);
    expect(
      calls()
        .filter((c) => c.url.startsWith(MEMBERS))
        .map((c) => [c.url, c.auth])
        .sort(),
    ).toEqual([
      [`${MEMBERS}gone`, `Bearer ${APP_TOKEN}`],
      [`${MEMBERS}octo`, `Bearer ${APP_TOKEN}`],
    ]);
    // Four days after the last press, and still in: the night renewed it.
    expect((await seatOf(t, workspaceId, MEMBER))?.githubOrgVerifiedAt).toBe(Date.now());
    expect(await readsCode(t, MEMBER, projectId)).toBe(true);
    const admin = await seatOf(t, workspaceId, ADMIN);
    expect(admin?.githubOrgVerifiedAt).toBeUndefined();
    expect(admin?.githubOrgLogin).toBe("gone");

    // Run again, it lands the same.
    await t.mutation(internal.github.orgProof.sweep, { cursor: null });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await seatOf(t, workspaceId, MEMBER))?.githubOrgVerifiedAt).toBe(Date.now());
    expect((await seatOf(t, workspaceId, ADMIN))?.githubOrgVerifiedAt).toBeUndefined();
  });

  test("the nightly check pages through a workspace's seats", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await ruled(t);
    const logins: string[] = [];
    await t.run(async (ctx) => {
      for (let i = 0; i < RECHECK_BATCH + 10; i += 1) {
        logins.push(`dev-${i}`);
        await ctx.db.insert("memberships", {
          workspaceId,
          userId: `user_${i}`,
          role: "member",
          status: "active",
          joinedAt: 1,
          githubOrgLogin: `dev-${i}`,
        });
      }
    });
    github(new Set(logins));
    await t.mutation(internal.github.orgProof.sweep, { cursor: null });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const seats = await t.run(async (ctx) => ctx.db.query("memberships").collect());
    expect(seats.filter((s) => s.githubOrgVerifiedAt === Date.now())).toHaveLength(RECHECK_BATCH + 10);
  });

  test("an App that can't be asked leaves proofs to run out on their own", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await ruled(t, { suspendedAt: 5 });
    const at = Date.now() - DAY;
    await t.run(async (ctx) => {
      const seat = (await ctx.db
        .query("memberships")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", MEMBER.subject))
        .unique())!;
      await ctx.db.patch(seat._id, { githubOrgVerifiedAt: at, githubOrgLogin: "octo" });
    });
    await t.mutation(internal.github.orgProof.sweep, { cursor: null });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await seatOf(t, workspaceId, MEMBER))?.githubOrgVerifiedAt).toBe(at);
  });

  test("a personal connection's refusal isn't explained as a fine-grained token's", async () => {
    fetchMock.mockImplementation(async () => new Response("{}", { status: 403 }));
    await expect(json("gho_x", "/user")).rejects.toThrow(/restrict third-party apps/);
    await expect(json("gho_x", "/user")).rejects.not.toThrow(/fine-grained/);
    await expect(json("ghs_x", "/user")).rejects.toThrow(/GitHub App/);
    await expect(json("github_pat_x", "/user")).rejects.toThrow(/fine-grained/);
  });
});

describe("the App's repositories", () => {
  const listing = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => ({
      full_name: `acme/r${from + i}`,
      default_branch: "main",
      description: null,
      private: true,
      pushed_at: `2026-08-01T00:00:${String((from + i) % 60).padStart(2, "0")}Z`,
    }));

  test("a member sees every usable installation's repositories, each naming its installation", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    const token = { sealed: await seal("ghs_live"), expiresAt: Date.now() + 30 * 60_000 };
    await installation(t, workspaceId, { token });
    await installation(t, workspaceId, { installationId: 43, removedAt: 5, token });
    await installation(t, workspaceId, { installationId: 44, suspendedAt: 5, token });
    fetchMock.mockImplementation(async (input: unknown) =>
      String(input).startsWith("https://api.github.com/installation/repositories")
        ? ok({
            total_count: 1,
            repositories: [
              { full_name: FULL, default_branch: "main", description: null, private: true, pushed_at: "2026-08-01T00:00:00Z" },
            ],
          })
        : new Response("{}", { status: 404 }),
    );
    expect(await t.withIdentity(MEMBER).action(api.github.app.available, { workspaceId })).toEqual([
      {
        installationId: INSTALLATION,
        fullName: FULL,
        defaultBranch: "main",
        private: true,
        pushedAt: "2026-08-01T00:00:00Z",
      },
    ]);
    expect(calls().filter((c) => c.url.includes("/installation/repositories"))).toHaveLength(1);

    fetchMock.mockClear();
    await expect(t.withIdentity(GUEST).action(api.github.app.available, { workspaceId })).rejects.toThrow();
    await expect(
      t.withIdentity({ subject: "stranger" }).action(api.github.app.available, { workspaceId }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("past a hundred, every page is read, up to the cap", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await installation(t, workspaceId, {
      token: { sealed: await seal("ghs_live"), expiresAt: Date.now() + 30 * 60_000 },
    });
    let total = 250;
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname !== "/installation/repositories") return new Response("{}", { status: 404 });
      const page = Number(url.searchParams.get("page"));
      const from = (page - 1) * 100;
      return ok({ total_count: total, repositories: listing(Math.max(0, Math.min(100, total - from)), from) });
    });
    const listed = await t.withIdentity(MEMBER).action(api.github.app.available, { workspaceId });
    expect(listed).toHaveLength(250);
    expect(new Set(listed.map((r) => r.fullName)).size).toBe(250);
    expect(listed.map((r) => r.pushedAt)).toEqual(
      [...listed.map((r) => r.pushedAt)].sort().reverse(),
    );
    expect(calls().map((c) => new URL(c.url).searchParams.get("page")).sort()).toEqual(["1", "2", "3"]);

    fetchMock.mockClear();
    total = 100_000;
    expect(await t.withIdentity(MEMBER).action(api.github.app.available, { workspaceId })).toHaveLength(
      REPOSITORY_PAGES * 100,
    );
    expect(fetchMock).toHaveBeenCalledTimes(REPOSITORY_PAGES);
  });

  test("under the organisation rule, only a member with fresh proof may list them", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t, { requireGithubOrg: "acme" });
    await installation(t, workspaceId, {
      token: { sealed: await seal("ghs_live"), expiresAt: Date.now() + 30 * 60_000 },
    });
    fetchMock.mockImplementation(async () => ok({ total_count: 1, repositories: listing(1) }));
    const list = (who: { subject: string }) => t.withIdentity(who).action(api.github.app.available, { workspaceId });
    const stamp = (who: { subject: string }, at: number | undefined) =>
      t.run(async (ctx) => {
        const seat = (await ctx.db
          .query("memberships")
          .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", who.subject))
          .unique())!;
        await ctx.db.patch(seat._id, { githubOrgVerifiedAt: at });
      });

    await expect(list(MEMBER)).rejects.toThrow(/Verify your GitHub membership in acme/);
    await expect(list(OWNER)).rejects.toThrow(/Verify your GitHub membership in acme/);
    await stamp(MEMBER, Date.now() - 4 * DAY);
    await expect(list(MEMBER)).rejects.toThrow(/Verify your GitHub membership/);
    expect(fetchMock).not.toHaveBeenCalled();

    await stamp(MEMBER, Date.now() - DAY);
    expect(await list(MEMBER)).toHaveLength(1);
    // What the member_removed webhook does to a proof.
    await stamp(MEMBER, undefined);
    await expect(list(MEMBER)).rejects.toThrow(/Verify your GitHub membership/);
  });

  test("one installation GitHub refuses leaves the others listed; all refused says why", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await installation(t, workspaceId, {
      token: { sealed: await seal("ghs_live"), expiresAt: Date.now() + 30 * 60_000 },
    });
    await installation(t, workspaceId, { installationId: 43, accountLogin: "octo", accountType: "User" });
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/app/installations/43/access_tokens")) return new Response("{}", { status: 404 });
      if (url.startsWith("https://api.github.com/installation/repositories")) {
        return ok({ total_count: 1, repositories: listing(1) });
      }
      return new Response("{}", { status: 404 });
    });
    const listed = await t.withIdentity(MEMBER).action(api.github.app.available, { workspaceId });
    expect(listed.map((r) => [r.fullName, r.installationId])).toEqual([["acme/r0", INSTALLATION]]);

    fetchMock.mockImplementation(async () => new Response("{}", { status: 404 }));
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("githubInstallations").collect()) {
        await ctx.db.patch(row._id, { token: undefined });
      }
    });
    await expect(t.withIdentity(MEMBER).action(api.github.app.available, { workspaceId })).rejects.toThrow(
      /^The GitHub App was uninstalled from (acme|octo)/,
    );
  });
});

describe("searching a project's code", () => {
  test("a refused credential leaves the rest searchable, and says what it left out", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId, projectId } = await world(t, { allowPersonalTokens: false });
    await installation(t, workspaceId, {
      token: { sealed: await seal("ghs_app"), expiresAt: Date.now() + 30 * 60_000 },
    });
    await repo(t, projectId, { installationId: INSTALLATION });
    await repo(t, projectId, { fullName: "acme/own" });
    fetchMock.mockImplementation(async (input: unknown) =>
      String(input).startsWith("https://api.github.com/search/code")
        ? ok({
            total_count: 1,
            items: [{ path: "src/a.ts", repository: { full_name: FULL }, text_matches: [{ fragment: "watchdog" }] }],
          })
        : new Response("{}", { status: 404 }),
    );
    const found = await t
      .withIdentity(MEMBER)
      .action(api.github.read.search, { projectId, query: "watchdog" });
    expect(found).toMatchObject({
      total: 1,
      searched: [`${FULL}@main`],
      skipped: [{ repo: "acme/own", reason: expect.stringMatching(/only through its GitHub App/) }],
      results: [{ repo: FULL, path: "src/a.ts" }],
    });
    expect(calls().map((c) => c.auth)).toEqual(["Bearer ghs_app"]);
  });

  test("when every credential is refused, the search fails with the reason", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await world(t, { allowPersonalTokens: false });
    await repo(t, projectId, { fullName: "acme/own" });
    await expect(
      t.withIdentity(MEMBER).action(api.github.read.search, { projectId, query: "watchdog" }),
    ).rejects.toThrow(/only through its GitHub App/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the integrations status", () => {
  test("says what is missing, and who may manage", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    await installation(t, workspaceId);
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "");
    const member = await t.withIdentity(MEMBER).query(api.github.app.status, { workspaceId });
    expect(member).toMatchObject({
      ready: false,
      canManage: false,
      allowPersonalTokens: true,
      requireGithubOrg: null,
      installations: [
        {
          accountLogin: "acme",
          manageUrl: `https://github.com/organizations/acme/settings/installations/${INSTALLATION}`,
        },
      ],
    });
    expect(member?.missing).toEqual(["GITHUB_APP_CLIENT_SECRET"]);
    expect(member?.appSlug).toBe("nootles");
    expect((await t.withIdentity(ADMIN).query(api.github.app.status, { workspaceId }))?.canManage).toBe(true);
    expect(await t.withIdentity({ subject: "stranger" }).query(api.github.app.status, { workspaceId })).toBeNull();
    expect(await t.withIdentity(GUEST).query(api.github.app.status, { workspaceId })).toBeNull();
  });
});
