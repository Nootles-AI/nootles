/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { parseHTML } from "linkedom";
import rateLimiterSchema from "../node_modules/@convex-dev/rate-limiter/src/component/schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { agentOwnsPage } from "./auth";
import { readStoredUpdates } from "./ydoc";
import { executeNmlCommands, type NmlBlock } from "@/app/lib/nml";
import { decodeNmlDocument, writeNmlDocument } from "@/app/lib/nml/yjs";
import { parseScene } from "@/app/components/editor/canvas/scene/parse";

/**
 * MCP end to end against the real functions: the OAuth dance a client such as
 * Claude performs (discovery, registration, authorize, consent, token,
 * refresh), then the `/mcp` endpoint over HTTP against documents that are
 * really served — an NML root written into a real Y.Doc, appended through
 * `ydoc.init`, and verified by the real Node verifier. Every refusal the design
 * promises is driven here, not asserted from reading code.
 */

const modules = import.meta.glob("./**/*.ts");
const limiterModules = import.meta.glob("../node_modules/@convex-dev/rate-limiter/src/component/**/*.ts");

const SITE = "https://site.test";
const APP = "https://app.test";
const ME = { subject: "user_aryan" };
const STRANGER = { subject: "user_stranger" };
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

beforeEach(() => {
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubEnv("APP_URL", APP);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("rateLimiter", rateLimiterSchema, limiterModules);
  return t;
}

const text = (t: string) => ({ type: "text" as const, text: t, marks: [] });
const para = (id: string, t: string): NmlBlock => ({ id, type: "paragraph", props: {}, content: [text(t)], children: [] });
const parseHtml = (html: string) => parseHTML(html).document as unknown as Document;

const PLAN: NmlBlock[] = [
  { id: "h1", type: "heading", props: { level: 1 }, content: [text("Launch plan")], children: [] },
  { id: "p1", type: "paragraph", props: {}, content: [{ type: "text", text: "Ship it", marks: ["bold"] }, text(" on Friday.")], children: [] },
  {
    id: "l1",
    type: "bulletListItem",
    props: {},
    content: [text("Beta")],
    children: [{ id: "c1", type: "checkListItem", props: { checked: true }, content: [text("Invite testers")], children: [] }],
  },
  { id: "code1", type: "codeBlock", props: { language: "ts" }, code: "launch()", children: [] },
  {
    id: "d1",
    type: "canvas",
    props: {},
    scene: parseScene(`<nt-diagram h="200"><nt-rect id="s1" x="10" y="10" w="120" h="60"></nt-rect></nt-diagram>`, parseHtml),
    children: [],
  },
];

type World = { projectId: Id<"projects">; pageId: Id<"pages">; docId: string; replica: Y.Doc };

/** A page with an NML root, stored through the ordinary Yjs path and independently verified. */
async function servedDoc(t: TestConvex<typeof schema>, owner: { subject: string }, title: string, blocks: NmlBlock[], projectId?: Id<"projects">): Promise<World> {
  const docId = crypto.randomUUID();
  const ids = await t.run(async (ctx) => {
    const project = projectId ?? (await ctx.db.insert("projects", { ownerId: owner.subject, title: `${title} project`, createdAt: 1 }));
    const pageId = await ctx.db.insert("pages", { ownerId: owner.subject, projectId: project, title, order: 0, docId, createdAt: 1, updatedAt: Date.now() });
    return { projectId: project, pageId };
  });
  const replica = new Y.Doc();
  writeNmlDocument(replica, { schemaVersion: 1, documentId: docId, blocks });
  await t.withIdentity(owner).mutation(api.ydoc.init, { docId, update: bytes(Y.encodeStateAsUpdate(replica)) });
  await t.run(async (ctx) => {
    await ctx.db.insert("nmlDocState", {
      docId,
      status: "migrated",
      nmlSchemaVersion: 1,
      nmlEncodingVersion: 1,
      nmlSeq: 1,
      equivalenceOk: true,
      mismatchClasses: [],
      limitOk: true,
      migratedAt: 1,
      migratedBy: owner.subject,
    });
  });
  await t.action(internal.nmlVerify.run, { docId });
  return { ...ids, docId, replica };
}

/** A legacy page of the same owner: a ProseMirror root and no NML state. */
async function legacyDoc(t: TestConvex<typeof schema>, owner: { subject: string }, title: string) {
  const docId = crypto.randomUUID();
  const pageId = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { ownerId: owner.subject, title: "Old", createdAt: 1 });
    return await ctx.db.insert("pages", { ownerId: owner.subject, projectId, title, order: 0, docId, createdAt: 1 });
  });
  const y = new Y.Doc();
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText("legacy secret")]);
  y.getXmlFragment("prosemirror").insert(0, [p]);
  await t.withIdentity(owner).mutation(api.ydoc.init, { docId, update: bytes(Y.encodeStateAsUpdate(y)) });
  return { docId, pageId };
}

function bytes(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

async function enable(t: TestConvex<typeof schema>, subject = ME.subject) {
  await t.mutation(internal.nmlMigration.setNmlServe, { enabled: true });
  await t.mutation(internal.nmlMigration.addInternalOwner, { subject, note: "test" });
  await t.mutation(internal.mcp.oauth.setMcpEnabled, { enabled: true });
}

// ---- The client's side of OAuth ------------------------------------------------------

const VERIFIER = "verifier-" + "x".repeat(50);
async function s256(verifier: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function registerClient(t: TestConvex<typeof schema>, extra: Record<string, unknown> = {}) {
  const res = await t.fetch("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", ...extra }),
  });
  return { res, body: (await res.json()) as Record<string, string> };
}

async function authorizeUrl(clientId: string, overrides: Record<string, string | null> = {}) {
  const params: Record<string, string | null> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: await s256(VERIFIER),
    code_challenge_method: "S256",
    state: "st-1",
    scope: "docs:read",
    resource: `${SITE}/mcp`,
    ...overrides,
  };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null) qs.set(k, v);
  return `/oauth/authorize?${qs}`;
}

/** Authorize → the consent page's key, as the browser would land with it. */
async function consentKey(t: TestConvex<typeof schema>, clientId: string, overrides: Record<string, string | null> = {}) {
  const res = await t.fetch(await authorizeUrl(clientId, overrides));
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!);
  expect(location.origin + location.pathname).toBe(`${APP}/mcp/authorize`);
  return location.searchParams.get("request")!;
}

async function exchange(t: TestConvex<typeof schema>, form: Record<string, string>) {
  const res = await t.fetch("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  return { res, body: (await res.json()) as Record<string, string | number> };
}

/**
 * The whole dance for `who`: register, authorize, consent, exchange. Read-only
 * unless `scope` asks to write, and the person leaves edits allowed.
 */
async function connect(t: TestConvex<typeof schema>, who = ME, opts: { scope?: string | null; allowEdits?: boolean } = {}) {
  const { body: client } = await registerClient(t);
  const request = await consentKey(t, client.client_id, opts.scope === undefined ? {} : { scope: opts.scope });
  const outcome = await t.withIdentity(who).action(api.mcp.oauth.approve, { request, allowEdits: opts.allowEdits });
  if (outcome.status !== "redirect") throw new Error(`consent refused: ${outcome.reason}`);
  const back = new URL(outcome.redirectTo);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe("st-1");
  expect(back.searchParams.get("iss")).toBe(SITE);
  const { res, body } = await exchange(t, {
    grant_type: "authorization_code",
    code: back.searchParams.get("code")!,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: VERIFIER,
    resource: `${SITE}/mcp`,
  });
  expect(res.status).toBe(200);
  return {
    clientId: client.client_id,
    access: body.access_token as string,
    refresh: body.refresh_token as string,
    code: back.searchParams.get("code")!,
    scope: body.scope as string,
  };
}

let nextId = 1;
async function rpc(t: TestConvex<typeof schema>, token: string | null, method: string, params?: Record<string, unknown>) {
  const res = await t.fetch("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  const raw = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON-RPC bodies are read by shape in each test
  return { res, body: raw ? (JSON.parse(raw) as Record<string, any>) : null };
}

const callTool = (t: TestConvex<typeof schema>, token: string, name: string, args: Record<string, unknown> = {}) =>
  rpc(t, token, "tools/call", { name, arguments: args });

// ---- Discovery + registration -----------------------------------------------------------

describe("discovery", () => {
  test("the resource names its authorization server, which describes a PKCE-only code flow", async () => {
    const t = harness();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const prm = (await (await t.fetch(path)).json()) as Record<string, unknown>;
      expect(prm).toMatchObject({ resource: `${SITE}/mcp`, authorization_servers: [SITE], scopes_supported: ["docs:read", "docs:write"] });
    }
    const as = (await (await t.fetch("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: SITE,
      authorization_endpoint: `${SITE}/oauth/authorize`,
      token_endpoint: `${SITE}/oauth/token`,
      registration_endpoint: `${SITE}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      response_types_supported: ["code"],
    });
  });

  test("CORS preflight is answered for browser-based clients", async () => {
    const t = harness();
    const res = await t.fetch("/mcp", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  test("the stand-in OIDC discovery still verifies the same way", async () => {
    const t = harness();
    const oidc = (await (await t.fetch("/.well-known/openid-configuration")).json()) as Record<string, unknown>;
    expect(oidc.jwks_uri).toBe(`${SITE}/.well-known/jwks.json`);
  });
});

describe("registration", () => {
  test("a public client gets an id and no secret; a confidential one gets a secret once", async () => {
    const t = harness();
    const pub = await registerClient(t);
    expect(pub.res.status).toBe(201);
    expect(pub.body.client_id).toMatch(/^ntcl_/);
    expect(pub.body.client_secret).toBeUndefined();
    const conf = await registerClient(t, { token_endpoint_auth_method: "client_secret_post" });
    expect(conf.body.client_secret).toMatch(/^nts_/);
    const stored = await t.run(async (ctx) => await ctx.db.query("mcpClients").collect());
    expect(JSON.stringify(stored)).not.toContain(conf.body.client_secret);
  });

  test("unsafe or unsupported metadata is refused", async () => {
    const t = harness();
    for (const bad of [
      { redirect_uris: ["http://evil.example/cb"] },
      { redirect_uris: ["myapp://cb"] },
      { redirect_uris: [] },
      { token_endpoint_auth_method: "private_key_jwt" },
      { grant_types: ["client_credentials"] },
      { response_types: ["token"] },
      { scope: "docs:admin" },
    ]) {
      const { res } = await registerClient(t, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await t.fetch("/oauth/register", { method: "POST", body: "nope" })).status).toBe(400);
  });
});

describe("the open door is bounded", () => {
  test("registration past the hourly window is refused with 429, and recovers", async () => {
    vi.useFakeTimers();
    const t = harness();
    for (let i = 0; i < 200; i++) expect((await registerClient(t)).res.status).toBe(201);
    const refused = await registerClient(t);
    expect(refused.res.status).toBe(429);
    expect(refused.body.error).toBe("temporarily_unavailable");
    vi.advanceTimersByTime(61 * 60 * 1000);
    expect((await registerClient(t)).res.status).toBe(201);
  });
});

// ---- Authorize + consent --------------------------------------------------------------------

describe("authorize and consent", () => {
  test("an unknown client or a foreign redirect is never redirected to", async () => {
    const t = harness();
    const unknown = await t.fetch(await authorizeUrl("ntcl_nope"));
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("location")).toBeNull();
    const { body } = await registerClient(t);
    const foreign = await t.fetch(await authorizeUrl(body.client_id, { redirect_uri: "https://evil.example/cb" }));
    expect(foreign.status).toBe(400);
    expect(foreign.headers.get("location")).toBeNull();
  });

  test("protocol errors go back to the client's registered redirect", async () => {
    const t = harness();
    const { body } = await registerClient(t);
    const cases: Array<[Record<string, string | null>, string]> = [
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ code_challenge: null }, "invalid_request"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ scope: "docs:admin" }, "invalid_scope"],
      [{ resource: "https://other.example/mcp" }, "invalid_target"],
    ];
    for (const [override, error] of cases) {
      const res = await t.fetch(await authorizeUrl(body.client_id, override));
      expect(res.status).toBe(302);
      const to = new URL(res.headers.get("location")!);
      expect(to.origin + to.pathname).toBe(REDIRECT);
      expect(to.searchParams.get("error"), JSON.stringify(override)).toBe(error);
      expect(to.searchParams.get("state")).toBe("st-1");
    }
  });

  test("the consent page sees the client and where it will send you, and who may say yes", async () => {
    const t = harness();
    await enable(t);
    const { body } = await registerClient(t);
    const request = await consentKey(t, body.client_id);
    expect(await t.query(api.mcp.oauth.pendingRequest, { request })).toBeNull();
    expect(await t.withIdentity(ME).query(api.mcp.oauth.pendingRequest, { request })).toMatchObject({
      status: "pending",
      clientName: "Claude",
      redirectOrigin: "https://claude.ai",
      scope: "docs:read",
      refusal: null,
    });
    expect(await t.withIdentity(STRANGER).query(api.mcp.oauth.pendingRequest, { request })).toMatchObject({ refusal: "not-internal" });
    expect(await t.withIdentity({ ...ME, act: "ops" }).query(api.mcp.oauth.pendingRequest, { request })).toMatchObject({ refusal: "stand-in" });
    expect(await t.withIdentity(ME).query(api.mcp.oauth.pendingRequest, { request: "ntq_bogus" })).toEqual({ status: "missing" });
  });

  test("someone not on the internal list, an operator standing in, and a switched-off MCP cannot consent", async () => {
    const t = harness();
    await enable(t);
    const { body } = await registerClient(t);
    const request = await consentKey(t, body.client_id);
    expect(await t.withIdentity(STRANGER).action(api.mcp.oauth.approve, { request })).toEqual({ status: "refused", reason: "not-internal" });
    await expect(t.withIdentity({ ...ME, act: "ops" }).action(api.mcp.oauth.approve, { request })).rejects.toThrow(/Read-only/);
    await t.mutation(internal.mcp.oauth.setMcpEnabled, { enabled: false });
    expect(await t.withIdentity(ME).action(api.mcp.oauth.approve, { request })).toEqual({ status: "refused", reason: "mcp-off" });
  });

  test("deny sends access_denied and spends the request", async () => {
    const t = harness();
    await enable(t);
    const { body } = await registerClient(t);
    const request = await consentKey(t, body.client_id);
    const denied = await t.withIdentity(ME).mutation(api.mcp.oauth.deny, { request });
    expect(new URL(denied!.redirectTo).searchParams.get("error")).toBe("access_denied");
    expect(await t.withIdentity(ME).action(api.mcp.oauth.approve, { request })).toEqual({ status: "refused", reason: "expired" });
  });

  test("a consent request lapses after ten minutes", async () => {
    vi.useFakeTimers();
    const t = harness();
    await enable(t);
    const { body } = await registerClient(t);
    const request = await consentKey(t, body.client_id);
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(await t.withIdentity(ME).action(api.mcp.oauth.approve, { request })).toEqual({ status: "refused", reason: "expired" });
  });
});

// ---- Token endpoint ------------------------------------------------------------------------

describe("token endpoint", () => {
  async function codeFor(t: TestConvex<typeof schema>, extra: Record<string, unknown> = {}) {
    const { body: client } = await registerClient(t, extra);
    const request = await consentKey(t, client.client_id);
    const outcome = await t.withIdentity(ME).action(api.mcp.oauth.approve, { request });
    if (outcome.status !== "redirect") throw new Error("refused");
    return { client, code: new URL(outcome.redirectTo).searchParams.get("code")! };
  }

  test("wrong verifier, redirect, client or an unknown grant type are refused", async () => {
    const t = harness();
    await enable(t);
    const { client, code } = await codeFor(t);
    const base = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: VERIFIER };
    expect((await exchange(t, { ...base, code_verifier: "wrong-" + "y".repeat(50) })).body.error).toBe("invalid_grant");
    // The failed PKCE attempt did not spend the code…
    expect((await exchange(t, { ...base, redirect_uri: "https://claude.ai/other" })).body.error).toBe("invalid_grant");
    expect((await exchange(t, { ...base, client_id: "ntcl_other" })).body.error).toBe("invalid_grant");
    expect((await exchange(t, { ...base, grant_type: "password" })).body.error).toBe("unsupported_grant_type");
    // …so the rightful holder can still redeem it.
    expect((await exchange(t, base)).res.status).toBe(200);
  });

  test("a code is single-use, and replaying it revokes what it minted", async () => {
    const t = harness();
    await enable(t);
    await servedDoc(t, ME, "Launch", PLAN);
    const { client, code } = await codeFor(t);
    const form = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: VERIFIER };
    const first = await exchange(t, form);
    expect(first.res.headers.get("cache-control")).toBe("no-store");
    const token = first.body.access_token as string;
    expect((await rpc(t, token, "ping")).res.status).toBe(200);
    expect((await exchange(t, form)).body.error).toBe("invalid_grant");
    expect((await rpc(t, token, "ping")).res.status).toBe(401);
  });

  test("a code expires after five minutes", async () => {
    vi.useFakeTimers();
    const t = harness();
    await enable(t);
    const { client, code } = await codeFor(t);
    vi.advanceTimersByTime(6 * 60 * 1000);
    const { body } = await exchange(t, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: VERIFIER });
    expect(body).toMatchObject({ error: "invalid_grant", error_description: "Authorization code expired." });
  });

  test("a confidential client must authenticate, by post or basic", async () => {
    const t = harness();
    await enable(t);
    const { client, code } = await codeFor(t, { token_endpoint_auth_method: "client_secret_basic" });
    const form = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: VERIFIER };
    const bad = await exchange(t, { ...form, client_secret: "nts_wrong" });
    expect(bad.res.status).toBe(401);
    expect(bad.body.error).toBe("invalid_client");
    const res = await t.fetch("/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${client.client_id}:${client.client_secret}`)}`,
      },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER }).toString(),
    });
    expect(res.status).toBe(200);
  });

  test("refresh rotates both tokens; the old pair stops working; replaying a rotated refresh ends the grant", async () => {
    const t = harness();
    await enable(t);
    const first = await connect(t);
    const rotated = await exchange(t, { grant_type: "refresh_token", refresh_token: first.refresh, client_id: first.clientId });
    expect(rotated.res.status).toBe(200);
    const second = { access: rotated.body.access_token as string, refresh: rotated.body.refresh_token as string };
    expect(second.access).not.toBe(first.access);
    expect(second.refresh).not.toBe(first.refresh);
    expect((await rpc(t, first.access, "ping")).res.status).toBe(401);
    expect((await rpc(t, second.access, "ping")).res.status).toBe(200);
    // The rotated-away refresh token comes back: someone else has a copy.
    expect((await exchange(t, { grant_type: "refresh_token", refresh_token: first.refresh, client_id: first.clientId })).body.error).toBe("invalid_grant");
    expect((await rpc(t, second.access, "ping")).res.status).toBe(401);
    expect((await exchange(t, { grant_type: "refresh_token", refresh_token: second.refresh, client_id: first.clientId })).body.error).toBe("invalid_grant");
  });

  test("refresh cannot widen the scope or move to another client", async () => {
    const t = harness();
    await enable(t);
    const first = await connect(t);
    expect((await exchange(t, { grant_type: "refresh_token", refresh_token: first.refresh, client_id: first.clientId, scope: "docs:write" })).body.error).toBe("invalid_scope");
    expect((await exchange(t, { grant_type: "refresh_token", refresh_token: first.refresh, client_id: "ntcl_x" })).body.error).toBe("invalid_grant");
  });

  test("an access token lasts an hour", async () => {
    vi.useFakeTimers();
    const t = harness();
    await enable(t);
    const { access } = await connect(t);
    vi.advanceTimersByTime(61 * 60 * 1000);
    const { res } = await rpc(t, access, "ping");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  test("revocation ends the grant and is quiet about unknown tokens", async () => {
    const t = harness();
    await enable(t);
    const { access, refresh } = await connect(t);
    const res = await t.fetch("/oauth/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${refresh}` });
    expect(res.status).toBe(200);
    expect((await rpc(t, access, "ping")).res.status).toBe(401);
    expect((await t.fetch("/oauth/revoke", { method: "POST", body: "token=nta_unknown" })).status).toBe(200);
  });

  test("no secret is stored in a readable form", async () => {
    const t = harness();
    await enable(t);
    const { access, refresh, code } = await connect(t);
    const dump = await t.run(async (ctx) =>
      JSON.stringify([
        await ctx.db.query("mcpGrants").collect(),
        await ctx.db.query("mcpAuthCodes").collect(),
        await ctx.db.query("mcpAuthRequests").collect(),
      ]),
    );
    for (const secret of [access, refresh, code, VERIFIER]) expect(dump).not.toContain(secret);
  });
});

// ---- The MCP endpoint -------------------------------------------------------------------------

describe("/mcp", () => {
  test("without a token the client is sent to discover the authorization server", async () => {
    const t = harness();
    const { res } = await rpc(t, null, "initialize", { protocolVersion: "2025-06-18" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp", scope="docs:read docs:write"`,
    );
    expect((await rpc(t, "nta_forged", "ping")).res.status).toBe(401);
  });

  test("initialize, tools/list and the app resource over the wire", async () => {
    const t = harness();
    await enable(t);
    const { access } = await connect(t);
    const init = await rpc(t, access, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.body!.result.protocolVersion).toBe("2025-06-18");
    const initialized = await t.fetch("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(initialized.status).toBe(202);
    const tools = await rpc(t, access, "tools/list");
    expect(tools.body!.result.tools.map((x: { name: string }) => x.name)).toEqual([
      "list_docs", "read_doc", "search_docs", "list_projects", "edit_doc", "undo_edit", "create_project", "create_page", "rename", "trash_page",
    ]);
    const app = await rpc(t, access, "resources/read", { uri: "ui://nootles/documents.html" });
    expect(app.body!.result.contents[0].text).toMatch(/^<!doctype html>/);
    expect((await t.fetch("/mcp", { method: "GET", headers: { authorization: `Bearer ${access}` } })).status).toBe(405);
    const junk = await t.fetch("/mcp", { method: "POST", headers: { authorization: `Bearer ${access}` }, body: "{not json" });
    expect(junk.status).toBe(400);
  });

  test("list_docs shows exactly my served documents — never legacy, never anyone else's, never trashed or in a workspace", async () => {
    const t = harness();
    await enable(t);
    await enable(t, STRANGER.subject);
    const mine = await servedDoc(t, ME, "Launch plan", PLAN);
    const other = await servedDoc(t, ME, "Retro notes", [para("r1", "What went well")]);
    await legacyDoc(t, ME, "Legacy page");
    await servedDoc(t, STRANGER, "Their plan", [para("x1", "not yours")]);
    const trashed = await servedDoc(t, ME, "Binned", [para("b1", "gone")]);
    await t.run(async (ctx) => ctx.db.patch(trashed.pageId, { deletedAt: 1 }));
    const inWorkspace = await servedDoc(t, ME, "Team page", [para("w1", "team")]);
    await t.run(async (ctx) => {
      const workspaceId = await ctx.db.insert("workspaces", {
        slug: "acme",
        name: "Acme",
        createdBy: ME.subject,
        plan: "team",
        settings: { linkSharing: true, guestCodeAccess: false, joinDomains: [], autoJoin: false },
        createdAt: 1,
      });
      await ctx.db.patch(inWorkspace.projectId, { workspaceId });
    });

    const { access } = await connect(t);
    const { body } = await callTool(t, access, "list_docs");
    const listed = body!.result.structuredContent.docs as Array<{ docId: string; title: string; snippet?: string; url: string; blockCount?: number }>;
    expect(listed.map((d) => d.docId).sort()).toEqual([mine.docId, other.docId].sort());
    const plan = listed.find((d) => d.docId === mine.docId)!;
    expect(plan.snippet).toBe("Ship it on Friday.");
    expect(plan.blockCount).toBe(6);
    expect(plan.url).toBe(`${APP}/p/${mine.projectId}?page=${mine.pageId}`);
    const text = body!.result.content[0].text as string;
    expect(text).not.toContain("Legacy page");
    expect(text).not.toContain("Their plan");

    const filtered = await callTool(t, access, "list_docs", { query: "RETRO" });
    expect(filtered.body!.result.structuredContent.docs.map((d: { docId: string }) => d.docId)).toEqual([other.docId]);
  });

  test("read_doc returns live canonical NML with stable ids, by docId, page id or page URL", async () => {
    const t = harness();
    await enable(t);
    const doc = await servedDoc(t, ME, "Launch plan", PLAN);
    const { access } = await connect(t);
    for (const ref of [doc.docId, doc.pageId, `${APP}/p/${doc.projectId}?page=${doc.pageId}`]) {
      const { body } = await callTool(t, access, "read_doc", { doc: ref });
      const result = body!.result;
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text as string;
      expect(text).toMatch(/^# Launch plan\n/);
      for (const id of ["h1", "p1", "l1", "c1", "code1", "d1"]) expect(text).toContain(`⟦${id}⟧`);
      expect(text).toContain("**Ship it** on Friday.");
      expect(text).toContain("Invite testers");
      expect(text).toContain("launch()");
      expect(text).toContain("⟦s1⟧");
      expect(result.structuredContent.outline.blocks.map((b: { id: string }) => b.id)).toEqual(["h1", "p1", "l1", "c1", "code1", "d1"]);
    }
  });

  test("a read reflects a command applied since, and ids of untouched blocks do not move", async () => {
    const t = harness();
    await enable(t);
    const doc = await servedDoc(t, ME, "Launch plan", PLAN);
    const { access } = await connect(t);
    const before = (await callTool(t, access, "read_doc", { doc: doc.docId })).body!.result.content[0].text as string;

    const updates: Uint8Array[] = [];
    doc.replica.on("update", (u: Uint8Array) => updates.push(u));
    await executeNmlCommands({
      doc: doc.replica,
      documentId: doc.docId,
      commands: [
        { type: "replaceInline", nodeId: "p1", range: { from: 0, to: 7 }, content: [text("Launch")] },
        { type: "insertNodes", parentId: null, anchor: { afterId: "code1" }, nodes: [para("p2", "Added by a collaborator")] },
      ],
      origin: { version: 1, transactionId: "tx-1", actor: { userId: ME.subject, kind: "human" }, command: "test" },
      idempotencyKey: "k-1",
      authorize: () => true,
    });
    for (const update of updates) await t.withIdentity(ME).mutation(api.ydoc.append, { docId: doc.docId, update: bytes(update) });

    const after = (await callTool(t, access, "read_doc", { doc: doc.docId })).body!.result.content[0].text as string;
    expect(after).toContain("Launch on Friday.");
    expect(after).not.toContain("Ship it");
    expect(after).toContain("⟦p2⟧ Added by a collaborator");
    const tags = (s: string) => [...s.matchAll(/⟦([^⟧]+)⟧/g)].map((m) => m[1]);
    expect(tags(after).filter((id) => id !== "p2")).toEqual(tags(before));
    // Deterministic: an unchanged document reads identically twice.
    expect((await callTool(t, access, "read_doc", { doc: doc.docId })).body!.result.content[0].text).toBe(after);
  });

  test("focus_block_id reads only the region around a block", async () => {
    const t = harness();
    await enable(t);
    const blocks = Array.from({ length: 30 }, (_, i) => para(`b${i}`, `Block ${i}`));
    const doc = await servedDoc(t, ME, "Long", blocks);
    const { access } = await connect(t);
    const text = (await callTool(t, access, "read_doc", { doc: doc.docId, focus_block_id: "b15", window: 1 })).body!.result.content[0].text as string;
    expect(text).toContain("⟦b14⟧");
    expect(text).toContain("⟦b15⟧");
    expect(text).toContain("⟦b16⟧");
    expect(text).not.toContain("⟦b10⟧");
    expect(text).not.toContain("CURSOR");
  });

  test("a legacy document, someone else's and a made-up id are all refused, and legacy content never leaks", async () => {
    const t = harness();
    await enable(t);
    await enable(t, STRANGER.subject);
    const legacy = await legacyDoc(t, ME, "Legacy page");
    const theirs = await servedDoc(t, STRANGER, "Their plan", [para("x1", "their secret")]);
    const { access } = await connect(t);

    const refusedLegacy = (await callTool(t, access, "read_doc", { doc: legacy.docId })).body!.result;
    expect(refusedLegacy.isError).toBe(true);
    expect(refusedLegacy.content[0].text).toMatch(/not served/);
    expect(JSON.stringify(refusedLegacy)).not.toContain("legacy secret");

    for (const ref of [theirs.docId, theirs.pageId, "nonexistent", crypto.randomUUID()]) {
      const refused = (await callTool(t, access, "read_doc", { doc: ref })).body!.result;
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toMatch(/No document you own/);
      expect(JSON.stringify(refused)).not.toContain("their secret");
    }
  });

  test("a document mid-migration, rolled back, or failed verification is not served", async () => {
    const t = harness();
    await enable(t);
    const pending = await servedDoc(t, ME, "Pending", [para("p", "x")]);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("nmlDocState").withIndex("by_doc", (q) => q.eq("docId", pending.docId)).unique();
      await ctx.db.patch(row!._id, { serverVerified: undefined });
    });
    const rolled = await servedDoc(t, ME, "Rolled", [para("r", "y")]);
    await t.withIdentity(ME).mutation(api.nmlMigration.rollback, { docId: rolled.docId, reason: "test", diverged: false });
    const { access } = await connect(t);
    expect((await callTool(t, access, "list_docs")).body!.result.structuredContent.total).toBe(0);
    for (const doc of [pending, rolled]) {
      expect((await callTool(t, access, "read_doc", { doc: doc.docId })).body!.result.content[0].text).toMatch(/not served/);
    }
  });

  test("the NML serve switch off hides everything; the MCP switch off refuses the token outright", async () => {
    const t = harness();
    await enable(t);
    const doc = await servedDoc(t, ME, "Launch plan", PLAN);
    const { access } = await connect(t);
    await t.mutation(internal.nmlMigration.setNmlServe, { enabled: false });
    expect((await callTool(t, access, "list_docs")).body!.result.structuredContent.total).toBe(0);
    expect((await callTool(t, access, "read_doc", { doc: doc.docId })).body!.result.isError).toBe(true);
    await t.mutation(internal.nmlMigration.setNmlServe, { enabled: true });
    await t.mutation(internal.mcp.oauth.setMcpEnabled, { enabled: false });
    const off = await rpc(t, access, "ping");
    expect(off.res.status).toBe(403);
    expect(off.res.headers.get("www-authenticate")).toBeNull();
    await t.mutation(internal.mcp.oauth.setMcpEnabled, { enabled: true });
    expect((await rpc(t, access, "ping")).res.status).toBe(200);
  });

  test("leaving the internal-owner list cuts the agent off on its next call, and refresh too", async () => {
    const t = harness();
    await enable(t);
    const { access, refresh, clientId } = await connect(t);
    await t.mutation(internal.nmlMigration.removeInternalOwner, { subject: ME.subject });
    expect((await rpc(t, access, "ping")).res.status).toBe(403);
    expect((await exchange(t, { grant_type: "refresh_token", refresh_token: refresh, client_id: clientId })).body.error).toBe("invalid_grant");
  });

  test("disconnecting from Settings ends the grant; nobody else can disconnect it", async () => {
    const t = harness();
    await enable(t);
    const { access } = await connect(t);
    const mine = await t.withIdentity(ME).query(api.mcp.oauth.myConnections, {});
    expect(mine).toMatchObject({ enabled: true, eligible: true, connections: [{ clientName: "Claude" }] });
    const grantId = mine!.connections[0].grantId;
    await expect(t.withIdentity(STRANGER).mutation(api.mcp.oauth.disconnect, { grantId })).rejects.toThrow(/Not found/);
    expect((await rpc(t, access, "ping")).res.status).toBe(200);
    await t.withIdentity(ME).mutation(api.mcp.oauth.disconnect, { grantId });
    expect((await rpc(t, access, "ping")).res.status).toBe(401);
    expect((await t.withIdentity(ME).query(api.mcp.oauth.myConnections, {}))!.connections).toEqual([]);
  });

  test("a burst past the budget is answered 429 with Retry-After, even while other lanes only observe", async () => {
    const t = harness();
    await enable(t);
    const { access } = await connect(t);
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await rpc(t, access, "ping")).res.status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    const limited = await rpc(t, access, "ping");
    expect(Number(limited.res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  test("RATE_LIMIT_MODE=off turns the MCP limit off too", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "off");
    const t = harness();
    await enable(t);
    const { access } = await connect(t);
    for (let i = 0; i < 40; i++) expect((await rpc(t, access, "ping")).res.status).toBe(200);
  });

  test("every read leaves a content-free line in the owner's project log", async () => {
    const t = harness();
    await enable(t);
    const doc = await servedDoc(t, ME, "Launch plan", PLAN);
    const { access } = await connect(t);
    await callTool(t, access, "read_doc", { doc: doc.docId });
    const rows = await t.run(async (ctx) =>
      await ctx.db.query("auditEvents").withIndex("by_project_at", (q) => q.eq("projectId", doc.projectId)).collect(),
    );
    const read = rows.find((r) => r.action === "mcp.read")!;
    expect(read).toMatchObject({ actorId: ME.subject, subjectKind: "page", subjectId: doc.pageId });
    expect(read.meta).toMatchObject({ counts: { blocks: 6 } });
    expect(JSON.stringify(read)).not.toContain("Ship it");
  });
});

// ---- Writing (NT-123) -----------------------------------------------------------------------

/** The backend's stored document, rebuilt: both roots. */
async function stored(t: TestConvex<typeof schema>, docId: string) {
  const updates = await t.run(async (ctx) => {
    const read = await readStoredUpdates(ctx, docId);
    if (!read || "tooLarge" in read) throw new Error("unreadable");
    return read.updates;
  });
  const doc = new Y.Doc();
  for (const u of updates) Y.applyUpdate(doc, new Uint8Array(u));
  const out = { nml: decodeNmlDocument(doc), legacy: doc.getXmlFragment("prosemirror").toString(), receipts: [...doc.getMap("nmlCommandReceipts").keys()] };
  doc.destroy();
  return out;
}

const seqOf = (t: TestConvex<typeof schema>, docId: string) =>
  t.run(async (ctx) => (await ctx.db.query("ydocs").withIndex("by_doc", (q) => q.eq("docId", docId)).unique())!.seq);

/** The owner typing in an open served editor: an executor batch appended as their flush. */
async function humanEdit(t: TestConvex<typeof schema>, docId: string, commands: Parameters<typeof executeNmlCommands>[0]["commands"]) {
  const updates = await t.run(async (ctx) => {
    const read = await readStoredUpdates(ctx, docId);
    if (!read || "tooLarge" in read) throw new Error("unreadable");
    return read.updates;
  });
  const doc = new Y.Doc();
  for (const u of updates) Y.applyUpdate(doc, new Uint8Array(u));
  const start = Y.encodeStateVector(doc);
  await executeNmlCommands({
    doc,
    documentId: docId,
    commands,
    origin: { version: 1, transactionId: crypto.randomUUID(), actor: { kind: "human", userId: ME.subject }, command: "type" },
    idempotencyKey: crypto.randomUUID(),
    authorize: () => true,
  });
  await t.withIdentity(ME).mutation(api.ydoc.append, { docId, update: bytes(Y.encodeStateAsUpdate(doc, start)) });
  doc.destroy();
}

const topTexts = (nml: { blocks: NmlBlock[] }) =>
  nml.blocks.map((b) => ("content" in b ? b.content.map((c) => (c.type === "text" ? c.text : "")).join("") : b.type));

describe("edit_doc and undo_edit", () => {
  test("consent grants edits only when asked for and left on", async () => {
    const t = harness();
    await enable(t);
    expect((await connect(t)).scope).toBe("docs:read");
    expect((await connect(t, ME, { scope: "docs:read docs:write" })).scope).toBe("docs:read docs:write");
    expect((await connect(t, ME, { scope: null })).scope).toBe("docs:read docs:write");
    expect((await connect(t, ME, { scope: "docs:read docs:write", allowEdits: false })).scope).toBe("docs:read");
    const connections = await t.withIdentity(ME).query(api.mcp.oauth.myConnections, {});
    expect(connections!.connections.map((c) => c.canEdit)).toEqual([false, true, true, false]);
  });

  test("an edit lands live on canonical NML and the compatibility root, one attributed batch, and reads back", async () => {
    const t = harness();
    await enable(t);
    const doc = await servedDoc(t, ME, "Launch plan", PLAN);
    const { access } = await connect(t, ME, { scope: null });
    const before = await seqOf(t, doc.docId);
    const { body } = await callTool(t, access, "edit_doc", {
      doc: doc.docId,
      operations: [
        { kind: "setBlockContent", blockId: "p1", content: [{ type: "text", text: "Ship it ", marks: [] }, { type: "text", text: "today", marks: ["bold"] }] },
        { kind: "insertBlocks", at: { at: "after", ref: "p1" }, blocks: [{ tempId: "risk", type: "checkListItem", content: "Write the MCP docs" }] },
        { kind: "updateBlockProps", blockId: "c1", props: { checked: false } },
      ],
    });
    const result = body!.result;
    expect(result.isError).toBeUndefined();
    const newId = result.structuredContent.created.risk as string;
    expect(newId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.content[0].text).toContain(`Added ⟦${newId}⟧ checkListItem: Write the MCP docs`);
    expect(result.structuredContent.changes.map((c: { kind: string; id: string }) => [c.kind, c.id])).toEqual([
      ["changed", "p1"],
      ["added", newId],
      ["changed", "c1"],
    ]);
    expect(await seqOf(t, doc.docId)).toBe(before + 1);

    const after = await stored(t, doc.docId);
    expect(topTexts(after.nml)).toEqual(["Launch plan", "Ship it today", "Write the MCP docs", "Beta", "codeBlock", "canvas"]);
    expect(after.nml.blocks[2].id).toBe(newId);
    expect(after.legacy).toContain("Write the MCP docs");
    expect(after.legacy).toContain("today");
    expect(after.receipts.filter((k) => k.startsWith("mcp:"))).toHaveLength(1);

    const reread = await callTool(t, access, "read_doc", { doc: doc.docId });
    expect(reread.body!.result.content[0].text).toContain(`⟦${newId}⟧ - [ ] Write the MCP docs`);
    expect(reread.body!.result.content[0].text).toContain("⟦p1⟧ Ship it **today**");

    const [edit] = await t.run(async (ctx) => await ctx.db.query("mcpEdits").collect());
    expect(edit).toMatchObject({ subject: ME.subject, clientName: "Claude", docId: doc.docId, counts: { added: 1, changed: 2, removed: 0, moved: 0 } });
    expect(JSON.stringify(edit)).not.toMatch(/Ship|MCP docs|today/);
    const audit = await t.run(async (ctx) => await ctx.db.query("auditEvents").withIndex("by_project_at", (q) => q.eq("projectId", doc.projectId)).collect());
    const line = audit.find((a) => a.action === "mcp.edit")!;
    expect(line).toMatchObject({ actorId: ME.subject, subjectKind: "page", subjectId: doc.pageId, meta: { counts: { added: 1, changed: 2 } } });
    expect(JSON.stringify(line)).not.toMatch(/Ship|MCP docs/);
  });

  test("undo_edit restores exactly, once; the person's Undo works from the page; strangers cannot", async () => {
    const t = harness();
    await enable(t);
    const doc = await servedDoc(t, ME, "Launch plan", PLAN);
    const original = (await stored(t, doc.docId)).nml;
    const { access } = await connect(t, ME, { scope: null });
    const edit = async (ops: unknown[]) => (await callTool(t, access, "edit_doc", { doc: doc.docId, operations: ops })).body!.result;
    const first = await edit([{ kind: "removeBlock", blockId: "l1" }, { kind: "moveBlock", blockId: "code1", to: { at: "docStart" } }]);
    const undone = await callTool(t, access, "undo_edit", { edit_id: first.structuredContent.editId });
    expect(undone.body!.result.content[0].text).toMatch(/^Undone\./);
    const restored = await stored(t, doc.docId);
    expect(restored.nml).toEqual(original);
    expect(restored.legacy).toContain("Invite testers");
    const again = await callTool(t, access, "undo_edit", { edit_id: first.structuredContent.editId });
    expect(again.body!.result).toMatchObject({ isError: true, content: [{ text: "That edit was already undone." }] });

    const second = await edit([{ kind: "setBlockContent", blockId: "p1", content: "Agent words" }]);
    const pending = await t.withIdentity(ME).query(api.mcp.docs.pendingOnPage, { docId: doc.docId });
    expect(pending).toMatchObject({ editId: second.structuredContent.editId, clientName: "Claude", counts: { changed: 1 } });
    expect(await t.withIdentity(STRANGER).query(api.mcp.docs.pendingOnPage, { docId: doc.docId })).toBeNull();
    expect(await t.withIdentity(STRANGER).action(api.mcp.edit.undoMine, { editId: second.structuredContent.editId })).toMatchObject({
      status: "refused",
      reason: "not-found",
    });
    expect(await t.withIdentity(ME).action(api.mcp.edit.undoMine, { editId: second.structuredContent.editId })).toMatchObject({ status: "undone" });
    expect(topTexts((await stored(t, doc.docId)).nml)[1]).toBe("Ship it on Friday.");
    expect(await t.withIdentity(ME).query(api.mcp.docs.pendingOnPage, { docId: doc.docId })).toBeNull();
    const undos = await t.run(async (ctx) => (await ctx.db.query("auditEvents").collect()).filter((a) => a.action === "mcp.undo"));
    expect(undos.map((u) => (u.meta?.ids as Record<string, string>).by)).toEqual(["agent", "person"]);
    expect(await t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length)).toBe(0);
  });

  test("an undo that would take a person's later work is refused, and theirs elsewhere is kept", async () => {
    const t = harness();
    await enable(t);
    const doc = await servedDoc(t, ME, "Launch plan", PLAN);
    const { access } = await connect(t, ME, { scope: null });
    const a = (await callTool(t, access, "edit_doc", { doc: doc.docId, operations: [{ kind: "setBlockContent", blockId: "p1", content: "Agent A" }] })).body!.result;
    const b = (await callTool(t, access, "edit_doc", { doc: doc.docId, operations: [{ kind: "setBlockContent", blockId: "h1", content: "Agent title" }] })).body!.result;
    await humanEdit(t, doc.docId, [{ type: "replaceInline", nodeId: "p1", range: { from: 0, to: 5 }, content: [text("Human")] }]);
    const refused = await callTool(t, access, "undo_edit", { edit_id: a.structuredContent.editId });
    expect(refused.body!.result.isError).toBe(true);
    expect(refused.body!.result.content[0].text).toMatch(/edited since.*⟦p1⟧/);
    expect(topTexts((await stored(t, doc.docId)).nml)[1]).toBe("Human A");
    const ok = await callTool(t, access, "undo_edit", { edit_id: b.structuredContent.editId });
    expect(ok.body!.result.isError).toBeUndefined();
    expect(topTexts((await stored(t, doc.docId)).nml).slice(0, 2)).toEqual(["Launch plan", "Human A"]);
  });

  test("read-only grants, legacy pages, other people's pages and bad operations change nothing", async () => {
    const t = harness();
    await enable(t);
    await enable(t, STRANGER.subject);
    const doc = await servedDoc(t, ME, "Launch plan", PLAN);
    const legacy = await legacyDoc(t, ME, "Scratch");
    const theirs = await servedDoc(t, STRANGER, "Secret", [para("s1", "stranger's secret")]);
    const readOnly = (await connect(t)).access;
    const writer = (await connect(t, ME, { scope: null })).access;
    const seqs = async () => [await seqOf(t, doc.docId), await seqOf(t, legacy.docId), await seqOf(t, theirs.docId)];
    const before = await seqs();
    const op = [{ kind: "setBlockContent", blockId: "p1", content: "x" }];

    const ro = await callTool(t, readOnly, "edit_doc", { doc: doc.docId, operations: op });
    expect(ro.body!.result.content[0].text).toMatch(/can only read/);
    const onLegacy = await callTool(t, writer, "edit_doc", { doc: legacy.docId, operations: op });
    expect(onLegacy.body!.result.content[0].text).toMatch(/not served/);
    const onTheirs = await callTool(t, writer, "edit_doc", { doc: theirs.docId, operations: [{ kind: "removeBlock", blockId: "s1" }] });
    expect(onTheirs.body!.result.content[0].text).toMatch(/No document you own/);
    const missing = await callTool(t, writer, "edit_doc", { doc: doc.docId, operations: [op[0], { kind: "removeBlock", blockId: "nope" }] });
    expect(missing.body!.result).toMatchObject({ isError: true });
    expect(missing.body!.result.content[0].text).toMatch(/^Nothing was changed: .*\(operation 1\)/);
    const malformed = await callTool(t, writer, "edit_doc", { doc: doc.docId, operations: [{ kind: "setBlockContent" }] });
    expect(malformed.body!.result.content[0].text).toMatch(/operations\.0\.blockId/);
    const diagram = await callTool(t, writer, "edit_doc", { doc: doc.docId, operations: [{ kind: "setBlockContent", blockId: "d1", content: "x" }] });
    expect(diagram.body!.result.isError).toBe(true);

    expect(await seqs()).toEqual(before);
    expect(await t.run(async (ctx) => (await ctx.db.query("mcpEdits").collect()).length)).toBe(0);
    expect(await t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length)).toBe(0);
  });

  test("a retried edit with the same key is made once; the key cannot be reused for different operations", async () => {
    const t = harness();
    await enable(t);
    const doc = await servedDoc(t, ME, "Launch plan", PLAN);
    const { access } = await connect(t, ME, { scope: null });
    const ops = [{ kind: "insertBlocks", at: { at: "docEnd" }, blocks: [{ tempId: "n", type: "paragraph", content: "Once" }] }];
    const first = (await callTool(t, access, "edit_doc", { doc: doc.docId, operations: ops, idempotency_key: "k-1" })).body!.result;
    const retry = (await callTool(t, access, "edit_doc", { doc: doc.docId, operations: ops, idempotency_key: "k-1" })).body!.result;
    expect(retry.content[0].text).toContain(`already made (editId: ${first.structuredContent.editId})`);
    expect(topTexts((await stored(t, doc.docId)).nml).filter((x) => x === "Once")).toHaveLength(1);
    const reused = (await callTool(t, access, "edit_doc", { doc: doc.docId, operations: [{ kind: "removeBlock", blockId: "p1" }], idempotency_key: "k-1" })).body!.result;
    expect(reused.content[0].text).toMatch(/idempotency_key was already used/);
  });

  test("a commit computed against an old log position is refused as stale", async () => {
    const t = harness();
    await enable(t);
    const doc = await servedDoc(t, ME, "Launch plan", PLAN);
    const { access } = await connect(t, ME, { scope: null });
    await callTool(t, access, "list_docs");
    const grantId = (await t.run(async (ctx) => await ctx.db.query("mcpGrants").first()))!._id;
    const inverse = await t.run(async (ctx) => await ctx.storage.store(new Blob([new Uint8Array([0])])));
    const seq = await seqOf(t, doc.docId);
    const commit = (at: number) =>
      t.mutation(internal.mcp.docs.commitEdit, {
        subject: ME.subject, grantId, clientName: "Claude", docId: doc.docId, seq: at, chunks: [bytes(new Uint8Array([0, 0]))], inverse,
        batchId: "b", idempotencyKey: "k", opsHash: "h", counts: { added: 0, changed: 0, removed: 0, moved: 0 }, changedIds: [], touched: [],
      });
    expect(await commit(seq - 1)).toEqual({ status: "stale" });
    await t.mutation(internal.mcp.oauth.revokeGrants, { grantId });
    expect(await commit(seq)).toEqual({ status: "refused", reason: "no-write" });
  });

  test("edits are rate-limited apart from reads, and the undo window ends", async () => {
    vi.stubEnv("RATE_LIMIT_MODE", "enforce");
    const t = harness();
    await enable(t);
    const doc = await servedDoc(t, ME, "Launch plan", PLAN);
    const { access } = await connect(t, ME, { scope: null });
    const results = [];
    for (let i = 0; i < 11; i++) {
      results.push((await callTool(t, access, "edit_doc", { doc: doc.docId, operations: [{ kind: "setBlockContent", blockId: "p1", content: `v${i}` }] })).body!.result);
    }
    expect(results.slice(0, 10).every((r) => !r.isError)).toBe(true);
    expect(results[10].content[0].text).toMatch(/Too many edits/);
    expect((await callTool(t, access, "read_doc", { doc: doc.docId })).body!.result.isError).toBeUndefined();

    vi.useFakeTimers({ now: Date.now() + 8 * 24 * 60 * 60 * 1000, toFake: ["Date"] });
    await t.mutation(internal.mcp.docs.expireInverses, {});
    const edits = await t.run(async (ctx) => await ctx.db.query("mcpEdits").collect());
    expect(edits.every((e) => e.inverse === undefined)).toBe(true);
    expect(await t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length)).toBe(0);
    vi.useRealTimers();
    vi.stubEnv("RATE_LIMIT_MODE", "off");
    const expired = await callTool(t, access, "undo_edit", { edit_id: edits[0]._id });
    expect(expired.body!.result.content[0].text).toMatch(/too old to undo/);
  });
});

// ---- Born on NML, and the workspace verbs (NT-124) ---------------------------------------------

const docOf = (t: TestConvex<typeof schema>, pageId: Id<"pages">) => t.run(async (ctx) => (await ctx.db.get(pageId))!.docId);

describe("pages born on NML", () => {
  test("an internal owner's new project and new pages are served from their first moment, verified by the server", async () => {
    const t = harness();
    await enable(t);
    const projectId = await t.withIdentity(ME).mutation(api.projects.create, { title: "Fresh" });
    const first = await t.run(async (ctx) => (await ctx.db.query("pages").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect())[0]);
    const second = await t.withIdentity(ME).mutation(api.pages.create, { projectId, title: "Second" });
    for (const docId of [first.docId, await docOf(t, second)]) {
      expect(await t.withIdentity(ME).query(api.nmlMigration.nmlAuthority, { docId })).toMatchObject({ serve: true, reason: "verified" });
      const state = await t.run(async (ctx) => await ctx.db.query("nmlDocState").withIndex("by_doc", (q) => q.eq("docId", docId)).unique());
      expect(state).toMatchObject({ status: "migrated", bornNml: true, serverVerified: true, migratedBy: ME.subject, nmlSeq: 1 });
      const nml = (await stored(t, docId)).nml;
      expect(nml.documentId).toBe(docId);
      expect(nml.blocks).toEqual([expect.objectContaining({ type: "paragraph", content: [] })]);
      // The ordinary re-assertion agrees, and a client that tries to migrate it stands down.
      await t.action(internal.nmlVerify.run, { docId });
      expect(await t.withIdentity(ME).query(api.nmlMigration.nmlAuthority, { docId })).toMatchObject({ serve: true });
      expect(
        await t.withIdentity(ME).mutation(api.nmlMigration.electMigration, {
          docId, update: bytes(new Uint8Array([0, 0])), nmlSchemaVersion: 1, nmlEncodingVersion: 1, equivalenceOk: true, mismatchClasses: [], limitOk: true,
        }),
      ).toEqual({ elected: false, reason: "already-elected" });
    }
  });

  test("a Notion import's pages wait unwritten for ydoc.init, and nothing beats it to the first write (NT-131)", async () => {
    const t = harness();
    await enable(t);
    const legacy = new Y.Doc();
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText("imported words")]);
    legacy.getXmlFragment("prosemirror").insert(0, [p]);
    const filling = bytes(Y.encodeStateAsUpdate(legacy));
    const elect = (docId: string) =>
      t.withIdentity(ME).mutation(api.nmlMigration.electMigration, {
        docId, update: bytes(new Uint8Array([0, 0])), nmlSchemaVersion: 1, nmlEncodingVersion: 1, equivalenceOk: true, mismatchClasses: [], limitOk: true,
      });
    const log = async (docId: string) => {
      const read = await t.run(async (ctx) => await readStoredUpdates(ctx, docId));
      if (read === null) return { seq: 0, text: false, nml: 0 };
      if ("tooLarge" in read) throw new Error("unreadable");
      const doc = new Y.Doc();
      for (const u of read.updates) Y.applyUpdate(doc, new Uint8Array(u));
      return { seq: read.seq, text: doc.getXmlFragment("prosemirror").toString().includes("imported words"), nml: doc.getMap("nml").size };
    };
    const state = (docId: string) => t.run(async (ctx) => await ctx.db.query("nmlDocState").withIndex("by_doc", (q) => q.eq("docId", docId)).unique());

    // A new project's blank page, and pages made into it, both awaiting content.
    const projectId = await t.withIdentity(ME).mutation(api.projects.create, { title: "Imported", awaitingContent: true });
    const seeded = await t.run(async (ctx) => (await ctx.db.query("pages").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect())[0]);
    const made = await docOf(t, await t.withIdentity(ME).mutation(api.pages.create, { projectId, title: "From Notion", awaitingContent: true }));
    for (const docId of [seeded.docId, made]) {
      expect(await state(docId)).toBeNull();
      expect(await t.run(async (ctx) => (await ctx.db.query("ydocs").withIndex("by_doc", (q) => q.eq("docId", docId)).unique())?.seq)).toBe(0);
      // An editor opened on it meanwhile does not migrate it into the way.
      expect(await elect(docId)).toEqual({ elected: false, reason: "unwritten" });
      expect(await state(docId)).toBeNull();
      expect(await t.withIdentity(ME).mutation(api.ydoc.init, { docId, update: filling })).toEqual({ migrated: true });
      expect(await log(docId)).toEqual({ seq: 1, text: true, nml: 0 });
      expect(await t.withIdentity(ME).query(api.nmlMigration.nmlAuthority, { docId })).toMatchObject({ serve: false, reason: "not-migrated" });
    }

    // Filled, it migrates on its next open as any imported page does.
    expect(await elect(made)).toMatchObject({ elected: true, seq: 2 });

    // A page born on NML is never rewritten under its readers: `init` loses to the birth.
    const born = await docOf(t, await t.withIdentity(ME).mutation(api.pages.create, { projectId }));
    expect(await t.withIdentity(ME).mutation(api.ydoc.init, { docId: born, update: filling })).toEqual({ migrated: false });
    expect(await log(born)).toMatchObject({ seq: 1, text: false });
    expect(await state(born)).toMatchObject({ bornNml: true });
    expect(await t.withIdentity(ME).query(api.nmlMigration.nmlAuthority, { docId: born })).toMatchObject({ serve: true });
  });

  test("everyone else's pages, and anyone's while serving is off, are born exactly as before", async () => {
    const t = harness();
    await enable(t);
    const theirs = await t.withIdentity(STRANGER).mutation(api.projects.create, { title: "Not internal" });
    const theirPage = await t.withIdentity(STRANGER).mutation(api.pages.create, { projectId: theirs });
    await t.mutation(internal.nmlMigration.setNmlServe, { enabled: false });
    const mine = await t.withIdentity(ME).mutation(api.projects.create, { title: "Switch off" });
    const minePage = await t.withIdentity(ME).mutation(api.pages.create, { projectId: mine });
    for (const docId of [await docOf(t, theirPage), await docOf(t, minePage)]) {
      expect(await t.run(async (ctx) => await ctx.db.query("nmlDocState").withIndex("by_doc", (q) => q.eq("docId", docId)).unique())).toBeNull();
      expect(await t.run(async (ctx) => (await ctx.db.query("ydocs").withIndex("by_doc", (q) => q.eq("docId", docId)).unique())!.seq)).toBe(0);
    }
  });
});

describe("workspace verbs", () => {
  test("create_project and create_page make pages the agent can read and edit at once", async () => {
    const t = harness();
    await enable(t);
    const { access } = await connect(t, ME, { scope: null });
    const made = (await callTool(t, access, "create_project", { title: "Offsite", description: "Team offsite in March", page_title: "Agenda" })).body!.result;
    expect(made.isError).toBeUndefined();
    const { docId, projectId } = made.structuredContent.doc;
    expect(made.content[0].text).toContain(`Created project "Offsite" with a blank page. docId: ${docId}`);
    expect((await callTool(t, access, "read_doc", { doc: docId })).body!.result.content[0].text).toMatch(/^# Agenda\n/);
    const sheet = await t.run(async (ctx) => await ctx.db.query("contextSheet").collect());
    expect(sheet.map((r) => r.answer)).toContain("Team offsite in March");

    const page = (await callTool(t, access, "create_page", {
      project: "offsite",
      title: "Travel",
      operations: [{ kind: "insertBlocks", at: { at: "docStart" }, blocks: [{ tempId: "h", type: "heading", props: { level: 2 }, content: "Flights" }, { tempId: "c", type: "checkListItem", content: "Book flights" }] }],
    })).body!.result;
    expect(page.isError).toBeUndefined();
    expect(page.content[0].text).toContain('Created page "Travel" in "Offsite"');
    expect(page.content[0].text).toContain("Filled it in (editId:");
    const text = (await callTool(t, access, "read_doc", { doc: page.structuredContent.doc.docId })).body!.result.content[0].text;
    expect(text).toMatch(/## Flights[\s\S]*- \[ \] Book flights/);
    const listed = (await callTool(t, access, "list_docs")).body!.result.structuredContent.docs.map((d: { title: string }) => d.title);
    expect(listed.sort()).toEqual(["Agenda", "Travel"]);
    const projects = (await callTool(t, access, "list_projects")).body!.result;
    expect(projects.content[0].text).toContain(`1. Offsite — 2 pages (2 readable here) · projectId: ${projectId}`);
  });

  test("rename, trash_page and search_docs", async () => {
    const t = harness();
    await enable(t);
    const doc = await servedDoc(t, ME, "Launch plan", PLAN);
    const { access } = await connect(t, ME, { scope: null });
    const renamed = (await callTool(t, access, "rename", { target: "page", ref: doc.docId, title: "Launch" })).body!.result;
    expect(renamed.content[0].text).toBe('Renamed the page "Launch plan" to "Launch".');
    expect(await t.run(async (ctx) => (await ctx.db.get(doc.pageId))!.title)).toBe("Launch");
    const project = (await callTool(t, access, "rename", { target: "project", ref: doc.projectId, title: "Q4" })).body!.result;
    expect(project.content[0].text).toBe('Renamed the project "Launch plan project" to "Q4".');

    const found = (await callTool(t, access, "search_docs", { query: "invite TESTERS" })).body!.result;
    expect(found.content[0].text).toContain('"invite TESTERS" is on 1 page:');
    expect(found.content[0].text).toContain("⟦c1⟧ Invite testers");
    expect((await callTool(t, access, "search_docs", { query: "nowhere to be found" })).body!.result.content[0].text).toMatch(/on none of your pages/);

    const trashed = (await callTool(t, access, "trash_page", { doc: doc.docId })).body!.result;
    expect(trashed.content[0].text).toMatch(/Moved "Launch" .*to the Trash/);
    expect(await t.run(async (ctx) => (await ctx.db.get(doc.pageId))!.deletedAt)).toBeTypeOf("number");
    expect((await callTool(t, access, "list_docs")).body!.result.structuredContent.total).toBe(0);
    expect((await callTool(t, access, "read_doc", { doc: doc.docId })).body!.result.isError).toBe(true);

    const audit = await t.run(async (ctx) => (await ctx.db.query("auditEvents").collect()).map((a) => a.action).filter((a) => a.startsWith("mcp.") && a !== "mcp.read"));
    expect(audit).toEqual(["mcp.renamePage", "mcp.renameProject", "mcp.trashPage"]);
  });

  test("read-only grants, other people's projects and pages, and legacy pages are refused, changing nothing", async () => {
    const t = harness();
    await enable(t);
    await enable(t, STRANGER.subject);
    const legacy = await legacyDoc(t, ME, "Scratch");
    const theirs = await servedDoc(t, STRANGER, "Secret", [para("s1", "secret")]);
    const readOnly = (await connect(t)).access;
    const writer = (await connect(t, ME, { scope: null })).access;
    const counts = async () => t.run(async (ctx) => [(await ctx.db.query("projects").collect()).length, (await ctx.db.query("pages").collect()).length]);
    const before = await counts();
    expect((await callTool(t, readOnly, "create_project", { title: "x" })).body!.result.content[0].text).toMatch(/can only read/);
    expect((await callTool(t, writer, "create_page", { project: theirs.projectId })).body!.result.content[0].text).toMatch(/No project or page of yours/);
    expect((await callTool(t, writer, "rename", { target: "project", ref: theirs.projectId, title: "mine now" })).body!.result.isError).toBe(true);
    expect((await callTool(t, writer, "trash_page", { doc: theirs.docId })).body!.result.isError).toBe(true);
    expect((await callTool(t, writer, "trash_page", { doc: legacy.docId })).body!.result.content[0].text).toMatch(/not served/);
    expect((await callTool(t, writer, "rename", { target: "page", ref: legacy.docId, title: "x" })).body!.result.isError).toBe(true);
    expect(await counts()).toEqual(before);
    expect(await t.run(async (ctx) => [(await ctx.db.get(theirs.pageId))!.title, (await ctx.db.get(theirs.pageId))!.deletedAt ?? null])).toEqual(["Secret", null]);
    await t.mutation(internal.nmlMigration.setNmlServe, { enabled: false });
    expect((await callTool(t, writer, "create_project", { title: "Off" })).body!.result.content[0].text).toMatch(/turned off/);
    expect(await counts()).toEqual(before);
  });
});

// ---- Authorization helper + housekeeping -----------------------------------------------------

describe("agentOwnsPage", () => {
  test("owned, personal and live only", async () => {
    const t = harness();
    const doc = await servedDoc(t, ME, "Mine", [para("m", "x")]);
    await t.run(async (ctx) => {
      const page = (await ctx.db.get(doc.pageId))!;
      expect(await agentOwnsPage(ctx, ME.subject, page)).not.toBeNull();
      expect(await agentOwnsPage(ctx, STRANGER.subject, page)).toBeNull();
      await ctx.db.patch(doc.projectId, { deletedAt: 1 });
      expect(await agentOwnsPage(ctx, ME.subject, page)).toBeNull();
    });
  });
});

describe("sweep", () => {
  test("lapsed requests, codes, dead grants and never-used clients go; live ones stay", async () => {
    vi.useFakeTimers();
    const t = harness();
    await enable(t);
    const live = await connect(t);
    const { body: idle } = await registerClient(t);
    await consentKey(t, idle.client_id);
    vi.advanceTimersByTime(2 * 24 * 60 * 60 * 1000);
    await t.mutation(internal.mcp.oauth.sweep, {});
    const left = await t.run(async (ctx) => ({
      clients: (await ctx.db.query("mcpClients").collect()).map((c) => c.clientId),
      requests: (await ctx.db.query("mcpAuthRequests").collect()).length,
      codes: (await ctx.db.query("mcpAuthCodes").collect()).length,
      grants: (await ctx.db.query("mcpGrants").collect()).length,
    }));
    expect(left).toEqual({ clients: [live.clientId], requests: 0, codes: 0, grants: 1 });
    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000);
    await t.mutation(internal.mcp.oauth.sweep, {});
    expect(await t.run(async (ctx) => (await ctx.db.query("mcpGrants").collect()).length)).toBe(0);
  });
});

test("decodeNmlDocument sanity: the fixture really carries an NML root", () => {
  const y = new Y.Doc();
  writeNmlDocument(y, { schemaVersion: 1, documentId: "x", blocks: PLAN });
  expect(decodeNmlDocument(y).blocks).toHaveLength(5);
});
