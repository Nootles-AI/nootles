/**
 * MCP for internal docs (NT-121), end to end the way it is used: Aryan connects
 * Claude to Nootles and Claude reads his pages.
 *
 * Everything that decides is real:
 * - a throwaway convex-local-backend with this repo's functions
 *   (tests/fullstack-backend.mjs), its scheduled Node verifier included;
 * - the pages are served the production way — created through `pages.create`,
 *   migrated by the headless engine a browser runs, elected with
 *   `electMigration`, and verified by the backend on its own;
 * - "Claude" is the official MCP TypeScript SDK client
 *   (`@modelcontextprotocol/sdk`), doing its own discovery, dynamic client
 *   registration, PKCE authorization and refresh — nothing about our server is
 *   told to it;
 * - Aryan answers in a real browser, on the app's real consent page and
 *   Settings (tests/mcp.fullstack.tsx), signed in by a token from an issuer the
 *   backend trusts, as Clerk's is;
 * - the MCP App card is the HTML the server serves, framed in a page that
 *   speaks the host's half of the MCP Apps protocol, its `tools/call` proxied
 *   to the real client.
 *
 * The story:
 *   a. Claude connects: 401 → discovery → registration → consent → token.
 *   b. It lists and reads: only Aryan's served pages; stable ids; a page URL.
 *   c. A collaborator edits; the next read has it, and every id held.
 *   d. What stays out: a legacy page, a stranger's page.
 *   e. The card: list and doc views, a row opening a doc through the host,
 *      links out, light and dark from the host's theme, a refusal.
 *   f. An hour later: the SDK refreshes on its own and carries on.
 *   g. Aryan disconnects it from Settings; it is out, refresh included.
 *   h. Another agent is cancelled on the consent page; a stranger is refused
 *      there; the master switch turns every token away.
 *
 * Nothing leaves the machine: the AI keys are unset, the backend's outbound
 * fetches are refused (and fail the run), and every browser request outside
 * the fixture, the backend and the callback fails the run. No model is ever
 * reached — MCP has none behind it. Screenshots land in tests/.artifacts/mcp/.
 *
 *   npm run test:mcp:fullstack
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { anyApi, makeFunctionReference } from "convex/server";
import { ConvexHttpClient } from "convex/browser";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { bundleSurfaces, guardedTab, ledger, serveBundle, wait } from "./comments-surfaces.shared.mjs";
import { launchBrowser } from "./comments-launch.mjs";
import { startBackend } from "./fullstack-backend.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = path.join(repo, "tests", ".artifacts", "mcp");

const ARYAN = { userId: "user_aryan", name: "Aryan Singh" };
const STRANGER = { userId: "user_stranger", name: "Sam Stranger" };

const text = (t, styles = {}) => ({ type: "text", text: t, styles });
const block = (id, type, content, props = {}, children = []) => ({ id, type, props, content: typeof content === "string" ? [text(content)] : content, children });
const LAUNCH = [
  block("h-launch", "heading", "Launch plan", { level: 1 }),
  block("p-goal", "paragraph", [text("Ship the MCP connector ", {}), text("this week", { bold: true }), text(".", {})]),
  block("b-beta", "bulletListItem", "Private beta with the team", {}, [block("c-invite", "checkListItem", "Invite testers", { checked: true })]),
  block("n-one", "numberedListItem", "Write the docs"),
  block("n-two", "numberedListItem", "Dogfood for a week"),
  { id: "code-cmd", type: "codeBlock", props: { language: "sh", code: "claude mcp add --transport http nootles <url>" }, content: [], children: [] },
  block("q-note", "quote", "Read-only first; writes come with review."),
];
const RETRO = [block("h-retro", "heading", "Sprint retro", { level: 2 }), block("p-well", "paragraph", "What went well: the NML rollout.")];
const READING = [block("p-book", "paragraph", "The Design of Everyday Things")];
const SECRET = [block("p-secret", "paragraph", "stranger's secret plans")];

/** What Claude's host passes for style (SEP-1865's standard names, the Figma kit's values). */
const HOST_VARIABLES = {
  "--color-background-primary": "light-dark(#ffffff, #30302e)",
  "--color-background-secondary": "light-dark(#f5f4ed, #262624)",
  "--color-background-tertiary": "light-dark(#faf9f5, #141413)",
  "--color-text-primary": "light-dark(#141413, #faf9f5)",
  "--color-text-secondary": "light-dark(#3d3d3a, #c2c0b6)",
  "--color-text-tertiary": "light-dark(#73726c, #9c9a92)",
  "--color-text-info": "light-dark(#3266ad, #80aadd)",
  "--color-border-secondary": "light-dark(rgba(31,30,29,0.3), rgba(222,220,209,0.3))",
  "--color-border-tertiary": "light-dark(rgba(31,30,29,0.15), rgba(222,220,209,0.15))",
  "--font-sans": "system-ui, sans-serif",
  "--border-radius-lg": "10px",
};

/** Clerk, signed in as the tab's person, with the fake issuer's token (as affiliates.fullstack.mjs). */
const CLERK = `
  const who = () => window.__aff.identity;
  const user = () => { const w = who(); return w && { id: w.userId, fullName: w.name, primaryEmailAddress: { emailAddress: w.userId + "@e2e.test" }, imageUrl: "" }; };
  export function useUser() { const u = user(); return { isLoaded: true, isSignedIn: Boolean(u), user: u }; }
  export function useAuth() {
    const w = who();
    return {
      isLoaded: true, isSignedIn: Boolean(w), userId: w ? w.userId : null, sessionId: w ? "sess_" + w.userId : null,
      orgId: null, orgRole: null, sessionClaims: w ? { aud: "convex" } : null,
      getToken: async () => window.__aff.jwt,
    };
  }
  export function useClerk() {
    return { isSignedIn: Boolean(who()), user: user(), addListener() { return () => {}; }, openSignIn() {}, signOut: async () => {}, client: { signIn: { authenticateWithRedirect() {} } } };
  }
`;

const { failures, check, finish } = ledger();
let deployment, browser, fixture, callback;
const watchdog = setTimeout(async () => {
  console.error("\nwatchdog: no verdict after 8 minutes; tearing down");
  await Promise.race([Promise.all([browser?.close().catch(() => {}), deployment?.close().catch(() => {})]), wait(10_000)]);
  process.exit(2);
}, 8 * 60_000);
watchdog.unref();

/** An OAuth client as the SDK expects one: it keeps its tokens in memory, as a desktop app would on disk. */
class Agent {
  constructor(name, redirectUrl) {
    this.name = name;
    this.redirectUrl = redirectUrl;
    this.authorizationUrl = null;
    this._client = undefined;
    this._tokens = undefined;
    this._verifier = undefined;
  }
  get clientMetadata() {
    return {
      client_name: this.name,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  /** Claude sends a state and checks it comes back; so does this. */
  state() { return (this.sentState = `state-${Math.random().toString(36).slice(2)}`); }
  clientInformation() { return this._client; }
  saveClientInformation(info) { this._client = info; }
  tokens() { return this._tokens; }
  saveTokens(tokens) { this._tokens = tokens; }
  redirectToAuthorization(url) { this.authorizationUrl = url; }
  saveCodeVerifier(verifier) { this._verifier = verifier; }
  codeVerifier() { return this._verifier; }
}

try {
  await mkdir(shots, { recursive: true });
  const work = await mkdtemp(path.join(tmpdir(), "mcp-e2e-"));

  // ── The OAuth callback an agent listens on (a loopback redirect, RFC 8252) ──
  const arrivals = [];
  callback = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    arrivals.push(Object.fromEntries(url.searchParams));
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Agent</title><p>You can close this window.</p>");
  });
  await new Promise((resolve) => callback.listen(0, "127.0.0.1", resolve));
  const CALLBACK = `http://127.0.0.1:${callback.address().port}/callback`;

  // ── The app's pages, bundled from app/ ─────────────────────────────────────
  const output = path.join(work, "bundle");
  await bundleSurfaces("tests/mcp.fullstack.tsx", output, { probe: false, fixtures: { clerk: CLERK } });
  fixture = await serveBundle(output);
  const APP = fixture.origin;

  // ── The backend, told where its app lives ──────────────────────────────────
  deployment = await startBackend({ name: "mcp", env: { APP_URL: APP } });
  const { url: CONVEX_URL, siteUrl: SITE } = deployment;
  const MCP_URL = new URL(`${SITE}/mcp`);
  const jwt = { aryan: deployment.mint(ARYAN.userId, ARYAN.name), stranger: deployment.mint(STRANGER.userId, STRANGER.name) };
  const as = (who) => deployment.client(jwt[who]);
  const admin = new ConvexHttpClient(CONVEX_URL);
  admin.setAdminAuth(deployment.adminKey);
  const run = (name, args = {}) => admin.mutation(makeFunctionReference(name), args);
  const table = async (name) =>
    (await admin.query(makeFunctionReference("_system/cli/tableData"), { table: name, order: "asc", paginationOpts: { numItems: 1000, cursor: null } })).page;

  // ── The seed engine, bundled for Node ──────────────────────────────────────
  const seedFile = path.join(work, "seed.mjs");
  await build({
    absWorkingDir: repo, entryPoints: ["tests/mcp.fullstack.seed.ts"], bundle: true, format: "esm", platform: "node",
    outfile: seedFile, tsconfig: "tsconfig.json", logLevel: "warning",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  const seed = await import(pathToFileURL(seedFile).href);

  // ── The world: switches as an operator sets them, pages as people make them ─
  await run("nmlMigration:setNmlServe", { enabled: true });
  await run("nmlMigration:addInternalOwner", { subject: ARYAN.userId, note: "e2e" });
  await run("mcp/oauth:setMcpEnabled", { enabled: true });

  async function page(who, projectId, title) {
    const pageId = await as(who).mutation(anyApi.pages.create, { projectId, title });
    const row = await as(who).query(anyApi.pages.get, { pageId });
    return { pageId, projectId, docId: row.docId, title };
  }
  async function serve(who, doc, blocks) {
    await as(who).mutation(anyApi.nmlMigration.electMigration, { docId: doc.docId, ...seed.migration(doc.docId, blocks) });
    for (let i = 0; ; i++) {
      const authority = await as(who).query(anyApi.nmlMigration.nmlAuthority, { docId: doc.docId });
      if (authority.serve) return;
      if (i > 100) throw new Error(`${doc.title} never served: ${authority.reason}`);
      await wait(100);
    }
  }
  /** The stored history of a document, read as its owner reads it. */
  async function stored(who, docId) {
    const client = as(who);
    const meta = await client.query(anyApi.ydoc.meta, { docId });
    const updates = [];
    if (meta.snapshotParts > 0) {
      const parts = [];
      for (let part = 0; part < meta.snapshotParts; part++) parts.push(await client.query(anyApi.ydoc.snapshot, { docId, gen: meta.snapshotSeq, part }));
      updates.push(Buffer.concat(parts.map((p) => Buffer.from(p))).buffer);
    }
    let cursor = meta.snapshotSeq;
    for (;;) {
      const rows = await client.query(anyApi.ydoc.updatesSince, { docId, afterSeq: cursor });
      if (!rows.length) break;
      for (const row of rows) { updates.push(row.update); cursor = Math.max(cursor, row.seq); }
    }
    return updates;
  }

  const roadmap = await as("aryan").mutation(anyApi.projects.create, { title: "Roadmap" });
  const personal = await as("aryan").mutation(anyApi.projects.create, { title: "Personal" });
  const launch = await page("aryan", roadmap, "Launch plan");
  const retro = await page("aryan", roadmap, "Retro");
  const scratch = await page("aryan", roadmap, "Scratch (legacy)");
  const reading = await page("aryan", personal, "Reading list");
  for (const [doc, blocks] of [[launch, LAUNCH], [retro, RETRO], [reading, READING]]) await serve("aryan", doc, blocks);
  const theirs = await as("stranger").mutation(anyApi.projects.create, { title: "Stranger's" });
  const secret = await page("stranger", theirs, "Secret plans");
  await as("stranger").mutation(anyApi.nmlMigration.addToCohort, { scope: "project", key: theirs });
  await serve("stranger", secret, SECRET);
  console.log("world: 3 served pages for Aryan, 1 legacy, 1 served for a stranger");

  browser = await launchBrowser();
  /** A signed-in browser tab on the fixture, allowed to reach the backend and the agent's callback. */
  async function tab(who, label, at, viewport) {
    return guardedTab(browser, {
      origin: APP, allow: [CONVEX_URL, SITE, CALLBACK.replace("/callback", "")], label, failures, path: at, viewport,
      setup: async (context, page) => {
        context.setDefaultTimeout(20_000);
        page.on("response", (answer) => {
          if (answer.status() >= 400) failures.push(`[${label}] ${answer.status()} for ${answer.url()}`);
        });
        await page.addInitScript((cfg) => {
          window.__aff = { identity: cfg.identity, jwt: cfg.jwt };
          globalThis.process = { env: { NODE_ENV: "development", NEXT_PUBLIC_CONVEX_URL: cfg.url }, browser: true };
        }, { identity: who ? { userId: who.userId, name: who.name } : null, jwt: who ? jwt[who === ARYAN ? "aryan" : "stranger"] : null, url: CONVEX_URL });
      },
    });
  }

  /** The SDK's own connect: the first attempt stops at consent; the browser answers; the second attempt connects. */
  async function connectAgent(agent, who, answer = "allow") {
    const client = new Client({ name: agent.name, version: "1.0.0" });
    let transport = new StreamableHTTPClientTransport(MCP_URL, { authProvider: agent });
    try {
      await client.connect(transport);
      throw new Error("connected without consent");
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
    }
    const authorization = agent.authorizationUrl;
    const before = arrivals.length;
    const consent = await tab(who, `${agent.name} consent`, "/", { width: 1100, height: 780 });
    await consent.page.goto(authorization.href, { waitUntil: "domcontentloaded" });
    await consent.page.waitForSelector("h1.nt-set-title");
    const shown = {
      title: await consent.page.textContent("h1.nt-set-title"),
      where: await consent.page.textContent(".nt-mcp-where").catch(() => null),
      refusal: await consent.page.textContent(".nt-set-problem").catch(() => null),
      allow: await consent.page.$("button.nt-solid"),
    };
    await consent.page.screenshot({ path: path.join(shots, `consent-${agent.name.toLowerCase().replace(/[^a-z]+/g, "-").replace(/-+$/, "")}.png`) });
    if (answer === "look") return { client, shown, consent, authorization };
    await consent.page.click(answer === "allow" ? "button.nt-solid" : "button:has-text('Cancel')");
    for (let i = 0; arrivals.length === before; i++) {
      if (i > 100) throw new Error("the browser never came back to the agent");
      await wait(100);
    }
    const back = arrivals.at(-1);
    await consent.context.close();
    if (answer !== "allow") return { client, shown, back, authorization };
    await transport.finishAuth(back.code);
    transport = new StreamableHTTPClientTransport(MCP_URL, { authProvider: agent });
    await client.connect(transport);
    return { client, shown, back, authorization };
  }

  // ── a. Claude connects ─────────────────────────────────────────────────────
  console.log("\na. Claude connects");
  const claude = new Agent("Claude (e2e)", CALLBACK);
  const { client, shown, back, authorization } = await connectAgent(claude, ARYAN);
  check("the SDK found the authorization server by itself and registered", claude.clientInformation()?.client_id?.startsWith("ntcl_"), true);
  check("authorization asks for S256 PKCE, the docs scope and this resource", [
    authorization.searchParams.get("code_challenge_method"),
    authorization.searchParams.get("resource"),
    authorization.origin,
  ], ["S256", MCP_URL.href, SITE]);
  check("the consent page names the agent", shown.title, "Connect Claude (e2e)?");
  check("…and where the answer goes", shown.where, `Answers go to ${new URL(CALLBACK).origin}`);
  check("…and offers Allow to an internal owner", Boolean(shown.allow) && shown.refusal === null, true);
  check("Allow comes back with a code, the client's own state and our issuer", [Boolean(back.code), back.state, back.iss], [true, claude.sentState, SITE]);
  check("the agent holds a bearer token and a refresh token", [claude.tokens()?.token_type?.toLowerCase(), Boolean(claude.tokens()?.refresh_token)], ["bearer", true]);
  check("the server introduces itself", client.getServerVersion()?.name, "nootles");

  // ── b. It lists and reads ──────────────────────────────────────────────────
  console.log("\nb. Claude lists and reads");
  const tools = await client.listTools();
  check("two read-only tools", tools.tools.map((t) => [t.name, t.annotations?.readOnlyHint]), [["list_docs", true], ["read_doc", true]]);
  const resources = await client.listResources();
  check("the card is a listed MCP App resource", resources.resources.map((r) => [r.uri, r.mimeType]), [["ui://nootles/documents.html", "text/html;profile=mcp-app"]]);
  const appHtml = (await client.readResource({ uri: "ui://nootles/documents.html" })).contents[0].text;

  const listed = await client.callTool({ name: "list_docs", arguments: {} });
  const titles = listed.structuredContent.docs.map((d) => d.title);
  check("list_docs shows exactly Aryan's served pages", [...titles].sort(), ["Launch plan", "Reading list", "Retro"]);
  check("…never the legacy page or the stranger's", [listed.content[0].text.includes("Scratch"), listed.content[0].text.includes("Secret")], [false, false]);
  const launchEntry = listed.structuredContent.docs.find((d) => d.title === "Launch plan");
  check("each entry carries its first words (past a heading that repeats the title), block count and a link into the app", [launchEntry.snippet, launchEntry.blockCount, launchEntry.url], [
    "Ship the MCP connector this week.", 8, `${APP}/p/${roadmap}?page=${launch.pageId}`,
  ]);
  const filtered = await client.callTool({ name: "list_docs", arguments: { query: "personal" } });
  check("list_docs filters by project too", filtered.structuredContent.docs.map((d) => d.title), ["Reading list"]);

  const read = await client.callTool({ name: "read_doc", arguments: { doc: launch.docId } });
  const readText = read.content[0].text;
  check("read_doc heads the text with the title", readText.split("\n")[0], "# Launch plan");
  check("…tags every block with its stable id", ["h-launch", "p-goal", "b-beta", "c-invite", "n-one", "n-two", "code-cmd", "q-note"].every((id) => readText.includes(`⟦${id}⟧`)), true);
  check("…keeps marks, lists, checks and code", [
    readText.includes("**this week**"), readText.includes("Invite testers"), readText.includes("claude mcp add"), readText.includes("Dogfood for a week"),
  ], [true, true, true, true]);
  const byUrl = await client.callTool({ name: "read_doc", arguments: { doc: launchEntry.url } });
  check("a page URL reads the same page", byUrl.content[0].text, readText);

  // ── c. A collaborator edits ────────────────────────────────────────────────
  console.log("\nc. A collaborator edits; the next read has it");
  const update = await seed.edit(launch.docId, await stored("aryan", launch.docId), [
    { type: "replaceInline", nodeId: "p-goal", range: { from: 0, to: 22 }, content: [{ type: "text", text: "Ship MCP reads", marks: [] }] },
    { type: "insertNodes", parentId: null, anchor: { afterId: "q-note" }, nodes: [{ id: "p-new", type: "paragraph", props: {}, content: [{ type: "text", text: "Added while Claude was away.", marks: [] }], children: [] }] },
  ], ARYAN.userId);
  await as("aryan").mutation(anyApi.ydoc.append, { docId: launch.docId, update });
  const reread = (await client.callTool({ name: "read_doc", arguments: { doc: launch.docId } })).content[0].text;
  check("the next read has the edit", [reread.includes("Ship MCP reads"), reread.includes("⟦p-new⟧ Added while Claude was away.")], [true, true]);
  const ids = (s) => [...s.matchAll(/⟦([^⟧]+)⟧/g)].map((m) => m[1]);
  check("every id Claude already held is where it was", ids(reread).filter((id) => id !== "p-new"), ids(readText));
  check("the backend's canonical tree agrees", seed.decode(await stored("aryan", launch.docId)).blocks.map((b) => b.id), ["h-launch", "p-goal", "b-beta", "n-one", "n-two", "code-cmd", "q-note", "p-new"]);

  // ── d. What stays out ──────────────────────────────────────────────────────
  console.log("\nd. What stays out");
  const legacyRead = await client.callTool({ name: "read_doc", arguments: { doc: scratch.docId } });
  check("a legacy page is refused as not served", [legacyRead.isError, /not served/.test(legacyRead.content[0].text)], [true, true]);
  const strangerRead = await client.callTool({ name: "read_doc", arguments: { doc: secret.docId } });
  check("a stranger's served page is not found, and nothing of it leaks", [strangerRead.isError, JSON.stringify(strangerRead).includes("secret plans")], [true, false]);

  // ── e. The card ────────────────────────────────────────────────────────────
  console.log("\ne. The MCP App card");
  async function host(label, result, input, theme = "light") {
    const hostTab = await tab(null, label, "/", { width: 800, height: 900 });
    await hostTab.page.exposeFunction("__mcpCall", async (name, args) => await client.callTool({ name, arguments: args }));
    await hostTab.page.addInitScript((cfg) => { window.__mcpHost = cfg; }, { html: appHtml, theme, input, result, variables: HOST_VARIABLES });
    await hostTab.page.goto(`${APP}/host`, { waitUntil: "domcontentloaded" });
    const frame = await (await hostTab.page.waitForSelector("iframe")).contentFrame();
    return { ...hostTab, frame, log: () => hostTab.page.evaluate(() => window.__hostLog) };
  }
  const listCard = await host("card: list", listed, {});
  await listCard.frame.waitForSelector("button.item");
  check("the list card shows one row per document", await listCard.frame.$$eval("button.item .title", (els) => els.map((e) => e.textContent)), titles);
  check("…with its project and first words", await listCard.frame.$eval(`button.item[data-doc="${launch.docId}"]`, (el) => [el.querySelector(".tag").textContent, el.querySelector(".snippet").textContent]), ["Roadmap", "Ship the MCP connector this week."]);
  check("…and the footer count", await listCard.frame.textContent(".footer .count"), "Showing 3 of 3 documents");
  await wait(200);
  const sized = await listCard.log();
  check("the card completed the handshake and told the host its height", [sized.initialized, sized.sizes.at(-1)?.height > 200], [true, true]);
  check("the card takes the host's surface colour", await listCard.frame.$eval(".card", (el) => getComputedStyle(el).backgroundColor), "rgb(255, 255, 255)");
  await listCard.page.screenshot({ path: path.join(shots, "card-list-light.png"), fullPage: true });

  await listCard.frame.click(`button.item[data-doc="${launch.docId}"]`);
  await listCard.frame.waitForSelector(".doc-title");
  check("a row opens the doc through the host's tools/call", (await listCard.log()).calls, ["read_doc"]);
  check("the doc card shows the live title and blocks", [
    await listCard.frame.textContent(".doc-title"),
    await listCard.frame.$$eval(".body .b", (els) => els.map((e) => e.textContent).join(" | ").includes("Added while Claude was away.")),
  ], ["Launch plan", true]);
  check("…checked items read as done", await listCard.frame.$eval(".b.li.done .text", (el) => el.textContent), "Invite testers");
  check("…and the title is not repeated as the first block", await listCard.frame.$eval(".body .b", (el) => el.textContent), "Ship MCP reads this week.");
  await listCard.page.screenshot({ path: path.join(shots, "card-doc-light.png"), fullPage: true });
  await listCard.frame.click(".footer [data-act=open]");
  await listCard.frame.click("[data-act=expand]");
  await listCard.frame.click("[data-act=back]");
  await listCard.frame.waitForSelector("button.item");
  const hostLog = await listCard.log();
  check("links leave through the host, to the page in Nootles", hostLog.opened, [`${APP}/p/${roadmap}?page=${launch.pageId}`]);
  check("expand asks the host for fullscreen", hostLog.modes, ["fullscreen"]);
  check("back returns to the list", await listCard.frame.$$eval("button.item", (els) => els.length), 3);
  await listCard.page.evaluate(() => window.__hostTheme("dark"));
  await wait(150);
  check("the host switching to dark turns the card dark", await listCard.frame.$eval(".card", (el) => getComputedStyle(el).backgroundColor), "rgb(48, 48, 46)");
  await listCard.page.screenshot({ path: path.join(shots, "card-list-dark.png"), fullPage: true });
  await listCard.context.close();

  const docCard = await host("card: doc dark", read, { doc: launch.docId }, "dark");
  await docCard.frame.waitForSelector(".doc-title");
  check("a doc card straight from read_doc, in dark", await docCard.frame.$eval(".card", (el) => getComputedStyle(el).backgroundColor), "rgb(48, 48, 46)");
  check("…with no back button, since there is no list behind it", await docCard.frame.$("[data-act=back]"), null);
  await docCard.page.screenshot({ path: path.join(shots, "card-doc-dark.png"), fullPage: true });
  await docCard.context.close();

  const refusedCard = await host("card: refused", legacyRead, { doc: scratch.docId });
  await refusedCard.frame.waitForSelector(".note.warn");
  check("a refusal reads as a note, not a broken card", /not served/.test(await refusedCard.frame.textContent(".note.warn")), true);
  await refusedCard.page.screenshot({ path: path.join(shots, "card-refused.png"), fullPage: true });
  await refusedCard.context.close();

  // ── f. An hour later ───────────────────────────────────────────────────────
  console.log("\nf. The access token expires; the SDK refreshes on its own");
  const grants = (await table("mcpGrants")).filter((g) => g.revokedAt === undefined);
  await admin.mutation(makeFunctionReference("_system/frontend/patchDocumentsFields"), {
    table: "mcpGrants", ids: grants.map((g) => g._id), fields: { accessExpiresAt: Date.now() - 1000 },
  });
  const oldAccess = claude.tokens().access_token;
  const afterExpiry = await client.callTool({ name: "list_docs", arguments: { limit: 1 } });
  check("the call after expiry still answers", afterExpiry.structuredContent.docs.length, 1);
  check("…because the SDK refreshed to a new token", claude.tokens().access_token !== oldAccess, true);

  // ── g. Disconnect from Settings ────────────────────────────────────────────
  console.log("\ng. Aryan disconnects Claude from Settings");
  const settings = await tab(ARYAN, "settings", "/settings", { width: 1100, height: 900 });
  await settings.page.waitForSelector("#nt-set-agents");
  check("Settings shows the MCP server URL to paste", await settings.page.textContent(".nt-mcp-url code"), MCP_URL.href);
  check("…and Claude as a connection", await settings.page.$$eval("section[aria-labelledby=nt-set-agents] .nt-set-name", (els) => els.map((e) => e.textContent)), ["MCP server", "Claude (e2e)"]);
  await settings.page.screenshot({ path: path.join(shots, "settings-agents.png"), fullPage: true });
  await settings.page.click("section[aria-labelledby=nt-set-agents] button:has-text('Disconnect')");
  await settings.page.click("[role=dialog] button:has-text('Disconnect')");
  await settings.page.waitForFunction(() => document.querySelectorAll("section[aria-labelledby=nt-set-agents] .nt-set-name").length === 1);
  check("the connection is gone from Settings", await settings.page.$$eval("section[aria-labelledby=nt-set-agents] .nt-set-name", (els) => els.map((e) => e.textContent)), ["MCP server"]);
  await settings.context.close();
  const cutOff = await client.callTool({ name: "list_docs", arguments: {} }).then(() => "answered", (error) => error.constructor.name);
  // 401 on the call, then `invalid_grant` on the refresh the SDK tries next.
  check("Claude is out, refresh included", cutOff, "InvalidGrantError");
  const stillOut = await client.callTool({ name: "list_docs", arguments: {} }).then(() => "answered", () => "refused");
  check("…and stays out", stillOut, "refused");

  // ── h. Cancel, a stranger, the switch ──────────────────────────────────────
  console.log("\nh. Cancel, a stranger, and the master switch");
  const cursor = new Agent("Cursor (e2e)", CALLBACK);
  const cancelled = await connectAgent(cursor, ARYAN, "cancel");
  check("Cancel sends the agent access_denied with its state", [cancelled.back.error, cancelled.back.state], ["access_denied", cursor.sentState]);
  check("…and it holds no token", cursor.tokens(), undefined);

  const intruder = new Agent("Claude for Sam (e2e)", CALLBACK);
  const strangerConsent = await connectAgent(intruder, STRANGER, "look");
  check("someone not on the internal list is told so, with no Allow", [/internal accounts/.test(strangerConsent.shown.refusal ?? ""), strangerConsent.shown.allow], [true, null]);
  await strangerConsent.consent.context.close();

  const again = new Agent("Claude again (e2e)", CALLBACK);
  const reconnected = await connectAgent(again, ARYAN);
  check("Aryan can connect again after disconnecting", (await reconnected.client.callTool({ name: "list_docs", arguments: {} })).structuredContent.total, 3);
  await run("mcp/oauth:setMcpEnabled", { enabled: false });
  const switchedOff = await reconnected.client.callTool({ name: "list_docs", arguments: {} }).then(() => "answered", (error) => String(error.message));
  check("the master switch turns a live token away", /403|turned off/.test(switchedOff), true);
  await run("mcp/oauth:setMcpEnabled", { enabled: true });
  check("…and back on, it answers again", (await reconnected.client.callTool({ name: "list_docs", arguments: {} })).structuredContent.total, 3);

  // ── The record ─────────────────────────────────────────────────────────────
  console.log("\nThe record");
  const reads = (await table("auditEvents")).filter((e) => e.action === "mcp.read");
  check("every document read left a content-free line in its project's log", [
    reads.length >= 4, reads.every((e) => e.actorId === ARYAN.userId), JSON.stringify(reads).includes("this week"),
  ], [true, true, false]);
  const secretsAt = JSON.stringify([await table("mcpGrants"), await table("mcpAuthCodes"), await table("mcpClients")]);
  check("no token is stored readable", [again.tokens().access_token, again.tokens().refresh_token].some((t) => secretsAt.includes(t)), false);
  check("the backend fetched nothing from outside", deployment.outbound, []);
} catch (error) {
  failures.push(`harness: ${error?.stack ?? error}`);
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  fixture?.server.close();
  callback?.close();
  await deployment?.close().catch(() => {});
}
finish();
