// Step 13 end-to-end: the NML authority gate driven by a real signed-in browser
// against a throwaway local Convex backend. No paid API is touched.
//
// Prerequisites (the operator, or scripts/nml-authority-e2e.sh, sets these up):
//   • a local convex-local-backend running at CONVEX_URL (default :3210)
//   • this repo's functions pushed to it (npx convex dev --once, self-hosted)
//   • its CLERK_JWT_ISSUER_DOMAIN env var == http://127.0.0.1:<ISSUER_PORT>
//
// The harness mints its own RSA keypair, serves the matching OIDC discovery +
// JWKS at that issuer (the backend fetches it to verify tokens), signs an owner
// token, seeds a project + three pages, then drives the browser client.
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import * as Y from "yjs";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONVEX_URL = process.env.CONVEX_URL || "http://127.0.0.1:3210";
const ISSUER_PORT = Number(process.env.NML_ISSUER_PORT || 3230);
const ISSUER = `http://127.0.0.1:${ISSUER_PORT}`;

// ── Fake OIDC issuer (what the backend fetches to verify our tokens) ──────────
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
const kid = createHash("sha256").update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest("base64url");
const jwks = { keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] };
const issuerServer = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url.startsWith("/.well-known/openid-configuration")) {
    res.end(JSON.stringify({
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      authorization_endpoint: `${ISSUER}/authorize`,
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    }));
  } else if (req.url.startsWith("/.well-known/jwks.json")) {
    res.end(JSON.stringify(jwks));
  } else {
    res.statusCode = 404;
    res.end("{}");
  }
});
await new Promise((resolve) => issuerServer.listen(ISSUER_PORT, "127.0.0.1", resolve));

const b64url = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function mint(subject) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64url({ alg: "RS256", typ: "JWT", kid })}.${b64url({
    iss: ISSUER, aud: "convex", sub: subject, iat: now, exp: now + 3600,
    name: subject, email: `${subject}@e2e.test`,
  })}`;
  return `${data}.${Buffer.from(sign("RSA-SHA256", Buffer.from(data), privateKey)).toString("base64url")}`;
}
const OWNER = "user_owner_e2e";
const ownerJwt = mint(OWNER);

// ── A legacy page Y.Doc (a ProseMirror root), like a real pre-migration doc ──
function encodedBase() {
  const doc = new Y.Doc();
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText("legacy body")]);
  doc.getXmlFragment("prosemirror").insert(0, [p]);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}
const base = encodedBase();
const baseB64 = Buffer.from(base).toString("base64");
const BLOCKS = [{ id: "p1", type: "paragraph", content: [{ type: "text", text: "hello", styles: {} }] }];

// ── Seed the world as the owner (over the real wire, real auth) ───────────────
const seed = new ConvexHttpClient(CONVEX_URL);
seed.setAuth(ownerJwt);
const existing = await seed.query(anyApi.projects.list, {});
const projectId = existing?.[0]?._id ?? (await seed.mutation(anyApi.projects.create, { title: "nml-authority-e2e" }));
async function newDoc() {
  const pageId = await seed.mutation(anyApi.pages.create, { projectId });
  const page = await seed.query(anyApi.pages.get, { pageId });
  const docId = page.docId;
  await seed.mutation(anyApi.ydoc.init, { docId, update: base.buffer.slice(base.byteOffset, base.byteOffset + base.byteLength) });
  return docId;
}
const [docGood, docLying, docDrop] = await Promise.all([newDoc(), newDoc(), newDoc()]);

// ── Bundle the browser client + serve it ──────────────────────────────────────
const output = await mkdtemp(path.join(tmpdir(), "nml-authority-browser-"));
await build({
  absWorkingDir: repo,
  entryPoints: ["tests/nml-authority.browser.tsx"],
  bundle: true,
  format: "esm",
  outfile: path.join(output, "nml-authority.browser.js"),
  platform: "browser",
  conditions: ["browser", "import"],
  tsconfig: "tsconfig.json",
  loader: { ".json": "json" },
  define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  logLevel: "warning",
});
await writeFile(
  path.join(output, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app">loading</div><script type="module" src="/nml-authority.browser.js"></script></body></html>`,
);
const pageServer = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const name = pathname === "/" ? "index.html" : path.basename(pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : "text/html");
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => pageServer.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${pageServer.address().port}`;

let browser;
try {
  const { default: puppeteer } = await import(process.env.NML_PUPPETEER_MODULE || "puppeteer");
  browser = await puppeteer.launch({ headless: true, ...(process.env.NML_CHROME_PATH ? { executablePath: process.env.NML_CHROME_PATH } : {}) });
  const page = await browser.newPage();
  const errors = [];
  const paidRequests = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error("Browser error:", error.message); });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    if (/\/api\/(complete|diagram|chat|reformat|album\/index|places)/.test(url)) paidRequests.push(url);
    // The page bundle and the local backend (WS handshake) are allowed; the
    // convex WebSocket itself is not an interceptable HTTP request.
    if (url.startsWith(origin) || url.startsWith(CONVEX_URL) || url.startsWith("http://127.0.0.1:3211")) {
      return void request.continue();
    }
    return void request.respond({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto(origin, { waitUntil: "load" });
  await page.waitForSelector('#app[data-ready="true"]');

  const results = await page.evaluate(
    (cfg) => window.__nmlAuthority.run(cfg),
    { url: CONVEX_URL, jwt: ownerJwt, baseB64, blocks: BLOCKS, docGood, docLying, docDrop },
  );

  // 1. Well-formed root: withheld until verified, then served, then rolled back.
  assert.equal(results.goodBeforeElect, null, "no authority row before migration");
  assert.equal(results.goodServed.serve, true, "verified good root is served");
  assert.equal(results.goodServed.reason, "verified");
  assert.equal(results.goodServed.schemaVersion, 1, "served schema version");
  assert.equal(results.goodServed.encodingVersion, 1, "served encoding version");
  assert.equal(results.goodAfterRollback.serve, false, "rollback withdraws authority");
  assert.equal(results.goodAfterRollback.reason, "rolled-back");

  // 2. Dishonest client: over-limit root shipped with limitOk is refused server-side.
  assert.equal(results.lyingVerdict.serve, false, "lying over-limit root is never served");
  assert.equal(results.lyingVerdict.reason, "limit-exceeded", "server re-checked the limit");

  // 3. A verified doc dropped from the cohort stops being served.
  assert.equal(results.afterCohortDrop.serve, false, "cohort drop stops serving");
  assert.equal(results.afterCohortDrop.reason, "not-in-cohort");

  await page.screenshot({ path: path.join(output, "authority.png"), fullPage: true });
  assert.deepEqual(errors, [], "no browser errors");
  assert.deepEqual(paidRequests, [], "no paid requests");
  console.log(JSON.stringify({
    result: "passed",
    checks: ["served-after-verify", "rollback", "lying-client-refused", "cohort-drop"],
    docs: { docGood, docLying, docDrop },
    browserErrors: errors.length,
    paidRequests: paidRequests.length,
    screenshots: output,
  }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => pageServer.close(resolve));
  await new Promise((resolve) => issuerServer.close(resolve));
}
