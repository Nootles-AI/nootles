/// <reference types="vite/client" />
import { createVerify, generateKeyPairSync } from "node:crypto";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { reachableInstallation } from "./github/app";
import { appJwt } from "./github/appAuth";
import { PUSH_DEBOUNCE_MS } from "./github/installations";
import { seal } from "./github/seal";
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
  function github(installations: { id: number }[]) {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") return ok({ access_token: "ghu_user" });
      if (url.startsWith("https://api.github.com/user/installations")) {
        return ok({
          installations: installations.map((i) => ({
            ...i,
            account: { login: "acme", type: "Organization" },
            repository_selection: "all",
          })),
        });
      }
      return new Response("{}", { status: 404 });
    });
  }

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

  test("an id GitHub doesn't list for them is refused", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t);
    github([{ id: 7 }]);
    await expect(
      t
        .withIdentity(ADMIN)
        .action(api.github.app.install, { workspaceId, installationId: INSTALLATION, code: "c0de" }),
    ).rejects.toThrow(/doesn’t list that installation/);
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
    }
  });
});

describe("the GitHub organisation rule", () => {
  async function readsCode(t: T, who: { subject: string }, projectId: Id<"projects">) {
    const rows = await t.withIdentity(who).query(internal.github.repos.access, { projectId });
    return rows.length > 0;
  }

  test("off, every member reads code; on, only a proof under two weeks old does", async () => {
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
    await stampAt(MEMBER, Date.now() - 13 * DAY);
    await stampAt(ADMIN, Date.now() - 15 * DAY);
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

  test("verifying asks GitHub with the member's own connection, and stamps or clears", async () => {
    const t = convexTest(schema, modules);
    const { workspaceId } = await world(t, { requireGithubOrg: "acme" });
    await t.run(async (ctx) =>
      ctx.db.insert("githubAccounts", {
        ownerId: MEMBER.subject,
        sealed: await seal("gho_member"),
        login: "octo",
        hint: "mber",
        kind: "oauth",
        connectedAt: 1,
      }),
    );
    let state = "active";
    fetchMock.mockImplementation(async () => ok({ state, user: { login: "octo" } }));
    const seat = () =>
      t.run(async (ctx) =>
        ctx.db
          .query("memberships")
          .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", MEMBER.subject))
          .unique(),
      );

    expect(await t.withIdentity(MEMBER).action(api.github.orgProof.verify, { workspaceId })).toEqual({
      required: true,
      verified: true,
    });
    expect(calls()).toEqual([
      { method: "GET", url: "https://api.github.com/user/memberships/orgs/acme", auth: "Bearer gho_member" },
    ]);
    expect(await seat()).toMatchObject({ githubOrgVerifiedAt: Date.now(), githubOrgLogin: "octo" });

    state = "pending";
    expect(await t.withIdentity(MEMBER).action(api.github.orgProof.verify, { workspaceId })).toEqual({
      required: true,
      verified: false,
    });
    expect((await seat())?.githubOrgVerifiedAt).toBeUndefined();

    await expect(
      t.withIdentity(ADMIN).action(api.github.orgProof.verify, { workspaceId }),
    ).rejects.toThrow(/No GitHub account is connected/);
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
    expect(member?.blocker).toContain("GITHUB_APP_CLIENT_SECRET");
    expect((await t.withIdentity(ADMIN).query(api.github.app.status, { workspaceId }))?.canManage).toBe(true);
    expect(await t.withIdentity({ subject: "stranger" }).query(api.github.app.status, { workspaceId })).toBeNull();
    expect(await t.withIdentity(GUEST).query(api.github.app.status, { workspaceId })).toBeNull();
  });
});
