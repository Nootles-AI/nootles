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
async function consentKey(t: TestConvex<typeof schema>, clientId: string) {
  const res = await t.fetch(await authorizeUrl(clientId));
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

/** The whole dance for `who`: register, authorize, consent, exchange. */
async function connect(t: TestConvex<typeof schema>, who = ME) {
  const { body: client } = await registerClient(t);
  const request = await consentKey(t, client.client_id);
  const outcome = await t.withIdentity(who).action(api.mcp.oauth.approve, { request });
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
  return { clientId: client.client_id, access: body.access_token as string, refresh: body.refresh_token as string, code: back.searchParams.get("code")! };
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
      expect(prm).toMatchObject({ resource: `${SITE}/mcp`, authorization_servers: [SITE], scopes_supported: ["docs:read"] });
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
      { scope: "docs:write" },
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
      [{ scope: "docs:write" }, "invalid_scope"],
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
      `Bearer resource_metadata="${SITE}/.well-known/oauth-protected-resource/mcp", scope="docs:read"`,
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
    expect(tools.body!.result.tools.map((x: { name: string }) => x.name)).toEqual(["list_docs", "read_doc"]);
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
