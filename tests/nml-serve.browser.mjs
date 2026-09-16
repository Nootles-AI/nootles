// Step 13 assembled-mount e2e: the REAL Editor component serving NML for a
// cohort doc, in Chromium, against a throwaway local Convex backend. Boots the
// backend, pushes the current functions, seeds a cohort doc, mounts the real
// editor under its production provider tree, and drives the full flow:
// legacy mount -> useNmlMigration auto-elects -> server verifies -> remount onto
// NmlServedEditor -> type NML commands (legacy root untouched) -> undo/redo.
//
// No paid API: all AI keys unset, the static server 404s /api/*, and the served
// editor has no AI extensions. Requires Node 22 + an operator-installed
// Puppeteer (NML_PUPPETEER_MODULE / NML_CHROME_PATH).
import { build } from "esbuild";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, copyFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import * as Y from "yjs";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND_PORT = 3210;
const SITE_PORT = 3211;
const ISSUER_PORT = 3230;
const ISSUER = `http://127.0.0.1:${ISSUER_PORT}`;
const CONVEX_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const OWNER = "user_owner_e2e";
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: repo, encoding: "utf8", ...opts });

// ── Fake OIDC issuer (the backend fetches this to verify our tokens) ──────────
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
const kid = createHash("sha256").update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n })).digest("base64url");
const jwks = { keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] };
const issuerServer = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url.startsWith("/.well-known/openid-configuration")) {
    res.end(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json`, authorization_endpoint: `${ISSUER}/a`, response_types_supported: ["id_token"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] }));
  } else if (req.url.startsWith("/.well-known/jwks.json")) {
    res.end(JSON.stringify(jwks));
  } else { res.statusCode = 404; res.end("{}"); }
});
await new Promise((r) => issuerServer.listen(ISSUER_PORT, "127.0.0.1", r));
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function mint(subject) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: "RS256", typ: "JWT", kid })}.${b64({ iss: ISSUER, aud: "convex", sub: subject, iat: now, exp: now + 3600, name: subject, email: `${subject}@e2e.test` })}`;
  return `${data}.${Buffer.from(sign("RSA-SHA256", Buffer.from(data), privateKey)).toString("base64url")}`;
}
const ownerJwt = mint(OWNER);

// ── Locate cached convex-local-backend + mint instance keys ───────────────────
const binariesDir = path.join(homedir(), ".cache/convex/binaries");
const precompiled = (await readdir(binariesDir)).filter((d) => d.startsWith("precompiled")).sort();
const BIN = path.join(binariesDir, precompiled.at(-1), "convex-local-backend");
assert.ok(existsSync(BIN), "convex-local-backend binary not found in cache");
const INSTANCE = "nootles-serve-e2e";
const SECRET = run("openssl", ["rand", "-hex", "32"]).stdout.trim();
const ADMIN_KEY = run(BIN, ["keygen", "admin-key", "--instance-name", INSTANCE, "--instance-secret", SECRET]).stdout.trim();

const scratch = await mkdtemp(path.join(tmpdir(), "nml-serve-e2e-"));
const envBak = path.join(scratch, ".env.bak");
const envLocalBak = path.join(scratch, ".env.local.bak");
const hadEnv = existsSync(path.join(repo, ".env"));
if (hadEnv) await copyFile(path.join(repo, ".env"), envBak);
await copyFile(path.join(repo, ".env.local"), envLocalBak);
const selfHostedEnv = `CONVEX_SELF_HOSTED_URL=${CONVEX_URL}\nCONVEX_SELF_HOSTED_ADMIN_KEY=${ADMIN_KEY}\n`;
async function restoreEnv() {
  if (hadEnv) await copyFile(envBak, path.join(repo, ".env"));
  await copyFile(envLocalBak, path.join(repo, ".env.local"));
}
// Run a convex CLI command against the self-hosted backend, with .env/.env.local
// swapped aside (the CLI reads CONVEX_DEPLOYMENT from both and rewrites .env.local).
async function convex(args) {
  await rm(path.join(repo, ".env"), { force: true });
  await writeFile(path.join(repo, ".env.local"), selfHostedEnv);
  try {
    return run("npx", ["convex", ...args], { env: { ...process.env, PATH: process.env.PATH } });
  } finally {
    await restoreEnv();
  }
}

let backend;
let server;
let browser;
let failed = null;
try {
  // ── Start the throwaway backend ─────────────────────────────────────────────
  backend = spawn(BIN, [
    "--port", String(BACKEND_PORT), "--site-proxy-port", String(SITE_PORT),
    "--instance-name", INSTANCE, "--instance-secret", SECRET, "--do-not-require-ssl",
    "--disable-beacon", path.join(scratch, "db.sqlite3"), "--local-storage", path.join(scratch, "storage"),
  ], { cwd: scratch, stdio: ["ignore", "ignore", "ignore"] });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${CONVEX_URL}/version`)).ok || true) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 500));

  // ── Set the issuer env var first (the push validates auth.config), then push ─
  const envSet = await convex(["env", "set", "CLERK_JWT_ISSUER_DOMAIN", ISSUER]);
  assert.equal(envSet.status, 0, `convex env set failed: ${envSet.stderr || envSet.stdout}`);
  const push = await convex(["dev", "--once", "--typecheck", "disable", "--codegen", "disable"]);
  assert.equal(push.status, 0, `convex push failed: ${push.stderr || push.stdout}`);

  // ── Seed a cohort doc as the owner (real auth over the wire) ────────────────
  const seed = new ConvexHttpClient(CONVEX_URL);
  seed.setAuth(ownerJwt);
  const projectId = await seed.mutation(anyApi.projects.create, { title: "serve-e2e" });
  const pageId = await seed.mutation(anyApi.pages.create, { projectId });
  const page = await seed.query(anyApi.pages.get, { pageId });
  const docId = page.docId;
  const empty = new Y.Doc();
  const emptyUpdate = Y.encodeStateAsUpdate(empty);
  await seed.mutation(anyApi.ydoc.init, { docId, update: emptyUpdate.buffer.slice(emptyUpdate.byteOffset, emptyUpdate.byteOffset + emptyUpdate.byteLength) });
  empty.destroy();
  await seed.mutation(anyApi.nmlMigration.addToCohort, { scope: "doc", key: docId });
  const config = { url: CONVEX_URL, jwt: ownerJwt, docId, pageId, projectId };

  // ── Bundle the fixture (real Editor + provider tree, next/clerk/sentry stubbed) ─
  const STUBS = {
    "@clerk/nextjs": `export const useUser=()=>({user:{id:"${OWNER}",fullName:"Owner",primaryEmailAddress:{emailAddress:"owner@e2e.test"},imageUrl:""},isSignedIn:true,isLoaded:true});export const useAuth=()=>({isSignedIn:true,isLoaded:true,userId:"${OWNER}",getToken:async()=>null});export const useClerk=()=>({openSignIn(){},signOut(){}});export const ClerkProvider=({children})=>children;export const SignedIn=({children})=>children;export const SignedOut=()=>null;export const UserButton=()=>null;export const SignInButton=({children})=>children;`,
    "next/navigation": `export const useRouter=()=>({push(){},replace(){},refresh(){},back(){},forward(){},prefetch(){}});export const usePathname=()=>"/";export const useSearchParams=()=>new URLSearchParams();export const useParams=()=>({});export const redirect=()=>{};export const notFound=()=>{};`,
    "next/link": `import {createElement} from "react";export default function Link({href,children,...rest}){return createElement("a",{href:typeof href==="string"?href:"#",...rest},children);}`,
    "next/dynamic": `export default function dynamic(){return function Dyn(){return null;};}`,
    "@sentry/nextjs": `export const captureException=()=>{};export const captureMessage=()=>{};export const addBreadcrumb=()=>{};export const setUser=()=>{};export const setTag=()=>{};export const withScope=(f)=>f({setTag(){},setContext(){},setLevel(){}});export const startSpan=(_o,f)=>f({});`,
  };
  const stubPlugin = {
    name: "stubs",
    setup(builder) {
      const filter = new RegExp(`^(${Object.keys(STUBS).map((s) => s.replace(/[/@]/g, "\\$&")).join("|")})$`);
      builder.onResolve({ filter }, (a) => ({ path: a.path, namespace: "stub" }));
      builder.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: STUBS[a.path], loader: "js", resolveDir: repo }));
      // Next's server-only gzip diagnostics must never reach the browser bundle.
      builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({ path: "x", namespace: "gz" }));
      builder.onLoad({ filter: /.*/, namespace: "gz" }, () => ({ contents: 'export const sync=()=>{throw new Error("gzip-size in browser")};' }));
    },
  };
  await build({
    absWorkingDir: repo, entryPoints: ["tests/nml-serve.browser.tsx"], bundle: true, splitting: true, format: "esm", outdir: scratch,
    platform: "browser", conditions: ["browser", "import", "style"], tsconfig: "tsconfig.json",
    define: {
      "process.env.NODE_ENV": '"production"',
      "process.env.NEXT_PUBLIC_YJS": '"1"',
      "process.env.NEXT_PUBLIC_NML_SERVE": '"1"',
      "process.env.NML_E2E": JSON.stringify(JSON.stringify(config)),
    },
    banner: { js: 'globalThis.process ??= { env: {}, browser: true };' },
    plugins: [stubPlugin], loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
  });
  const appCss = path.join(repo, "app/globals.css");
  const styles = await postcss([tailwind({ base: repo })]).process(await readFile(appCss, "utf8"), { from: appCss });
  await writeFile(path.join(scratch, "app.css"), styles.css);
  await writeFile(path.join(scratch, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script type="module" src="/nml-serve.browser.js"></script></body></html>`);

  // ── Serve statically (so /api/* 404s → no paid calls) ───────────────────────
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      const name = pathname === "/" ? "index.html" : path.basename(pathname);
      const data = await readFile(path.join(scratch, name));
      response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream");
      response.end(data);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  // ── Drive the real browser ──────────────────────────────────────────────────
  const { default: puppeteer } = await import(process.env.NML_PUPPETEER_MODULE || "puppeteer");
  browser = await puppeteer.launch({ headless: true, ...(process.env.NML_CHROME_PATH ? { executablePath: process.env.NML_CHROME_PATH } : {}) });
  const pageB = await browser.newPage();
  await pageB.setViewport({ width: 1280, height: 900 });
  const errors = [];
  const paidRequests = [];
  pageB.on("pageerror", (e) => { errors.push(e.message); console.error("Browser error:", e.message); });
  await pageB.setRequestInterception(true);
  pageB.on("request", (req) => {
    const url = req.url();
    if (/\/api\/(complete|diagram|chat|reformat|album\/index|places)/.test(url)) paidRequests.push(url);
    if (url.startsWith(origin) || url.startsWith(CONVEX_URL) || url.startsWith(`http://127.0.0.1:${SITE_PORT}`)) return void req.continue();
    if (req.resourceType() === "image") return void req.respond({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' });
    return void req.respond({ status: 404, contentType: "application/json", body: "{}" });
  });
  await pageB.goto(origin, { waitUntil: "load" });

  // 1-2. The doc migrates + verifies on its own, then the real Editor remounts
  //      onto the served NML view — no typing, no manual trigger.
  await pageB.waitForFunction(() => window.__serve.servedMounted(), { timeout: 40000 });
  assert.equal(await pageB.evaluate(() => window.__serve.nmlPresent()), true, "NML root present");

  // 3. A served edit commits NML commands; the legacy prosemirror root stays put.
  const pmBefore = await pageB.evaluate(() => window.__serve.proseMirror());
  await pageB.evaluate(() => window.__serve.focusFirstBlock());
  await pageB.keyboard.type("hello world");
  await pageB.waitForFunction(() => (window.__serve.nmlText() ?? "").includes("hello world"), { timeout: 10000 });
  const pmAfter = await pageB.evaluate(() => window.__serve.proseMirror());
  assert.equal(pmAfter, pmBefore, "legacy ProseMirror root is byte-stable across an NML edit");

  // 4. Undo/redo through the workspace spine (real ⌘Z keystroke).
  await pageB.keyboard.down("Meta");
  await pageB.keyboard.press("z");
  await pageB.keyboard.up("Meta");
  await pageB.waitForFunction(() => !(window.__serve.nmlText() ?? "").includes("hello world"), { timeout: 10000 });
  await pageB.keyboard.down("Meta");
  await pageB.keyboard.down("Shift");
  await pageB.keyboard.press("z");
  await pageB.keyboard.up("Shift");
  await pageB.keyboard.up("Meta");
  await pageB.waitForFunction(() => (window.__serve.nmlText() ?? "").includes("hello world"), { timeout: 10000 });

  await pageB.screenshot({ path: path.join(scratch, "served.png"), fullPage: true });
  assert.deepEqual(errors, [], "no browser errors");
  assert.deepEqual(paidRequests, [], "no paid requests");
  console.log(JSON.stringify({ result: "passed", checks: ["auto-migrate+verify+serve", "nml-edit-syncs", "legacy-root-byte-stable", "undo", "redo"], docId, browserErrors: errors.length, paidRequests: paidRequests.length }, null, 2));
} catch (e) {
  failed = e;
  console.error("E2E FAILED:", e?.message ?? e);
} finally {
  await browser?.close().catch(() => {});
  if (server) await new Promise((r) => server.close(r));
  await new Promise((r) => issuerServer.close(r));
  if (backend) backend.kill("SIGKILL");
  await restoreEnv();
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}
if (failed) process.exit(1);
