// Phase 2 assembled-mount e2e: the REAL `Editor` component, signed in as an
// internal-owner subject (eligible through the `internalOwners` allowlist),
// auto-migrates a legacy page and remounts onto `NmlServedEditor` — all against
// a throwaway local convex-local-backend. No paid API is touched.
//
// Prerequisites (the operator sets these up; see the Phase-2 runbook):
//   • a convex-local-backend running at CONVEX_URL (default :3210)
//   • this repo's functions pushed to it (self-hosted `convex dev --once`)
//   • CONVEX_SELF_HOSTED_URL + CONVEX_SELF_HOSTED_ADMIN_KEY exported (for the
//     internal `addInternalOwner` enrolment via `convex run`)
//   • the backend's CLERK_JWT_ISSUER_DOMAIN == http://127.0.0.1:<ISSUER_PORT>
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import * as Y from "yjs";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const execFileP = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONVEX_URL = process.env.CONVEX_URL || "http://127.0.0.1:3210";
const ISSUER_PORT = Number(process.env.NML_ISSUER_PORT || 3230);
const ISSUER = `http://127.0.0.1:${ISSUER_PORT}`;
const OWNER = "user_internal_e2e";

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
    name: "E2E Owner", email: `${subject}@e2e.test`,
  })}`;
  return `${data}.${Buffer.from(sign("RSA-SHA256", Buffer.from(data), privateKey)).toString("base64url")}`;
}
const ownerJwt = mint(OWNER);

// ── A legacy page Y.Doc (a ProseMirror root with a paragraph), pre-migration ──
function encodedBase(text) {
  const doc = new Y.Doc();
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment("prosemirror").insert(0, [p]);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}
const base = encodedBase("hello");

// ── Enrol the owner on the internal allowlist (internal fn, via admin `run`) ──
async function run(fn, args) {
  const env = {
    ...process.env,
    CONVEX_SELF_HOSTED_URL: process.env.CONVEX_SELF_HOSTED_URL || CONVEX_URL,
    CONVEX_DEPLOYMENT: "",
  };
  await execFileP("npx", ["convex", "run", fn, JSON.stringify(args)], { cwd: repo, env });
}
await run("nmlMigration:addInternalOwner", { subject: OWNER, note: "e2e" });
// Turn on the master serve switch (a Convex row, not a build flag).
await run("nmlMigration:setNmlServe", { enabled: true });

// ── Seed a legacy page owned by the internal owner (over the real wire) ───────
const seed = new ConvexHttpClient(CONVEX_URL);
seed.setAuth(ownerJwt);
const existing = await seed.query(anyApi.projects.list, {});
const projectId = existing?.[0]?._id ?? (await seed.mutation(anyApi.projects.create, { title: "nml-served-e2e" }));
const pageId = await seed.mutation(anyApi.pages.create, { projectId });
const page = await seed.query(anyApi.pages.get, { pageId });
const docId = page.docId;
await seed.mutation(anyApi.ydoc.init, { docId, update: base.buffer.slice(base.byteOffset, base.byteOffset + base.byteLength) });

// ── Bundle the browser fixture (real Editor, flags on, Clerk/next stubbed) ────
const stubs = {
  "@clerk/nextjs": `
    const user = { id: ${JSON.stringify(OWNER)}, fullName: "E2E Owner", primaryEmailAddress: { emailAddress: "e2e@test" }, imageUrl: "" };
    export const useUser = () => ({ isLoaded: true, isSignedIn: true, user });
    export const useAuth = () => ({ isLoaded: true, isSignedIn: true, userId: user.id, getToken: async () => null });
    export const useClerk = () => ({ openSignIn(){}, signOut: async () => {} });
    export const useSession = () => ({ isLoaded: true, session: null });
    export const ClerkProvider = ({ children }) => children;
    export const SignedIn = ({ children }) => children;
    export const SignedOut = () => null;
    export const UserButton = () => null;`,
  "next/dynamic": `export default function dynamic(){ return function Dynamic(){ return null; }; }`,
  "next/navigation": `
    export const useRouter = () => ({ push(){}, replace(){}, prefetch(){}, back(){}, forward(){}, refresh(){} });
    export const usePathname = () => "/";
    export const useSearchParams = () => new URLSearchParams();
    export const useParams = () => ({});
    export const redirect = () => {};
    export const notFound = () => {};`,
  "next/link": `import { createElement } from "react"; export default function Link({ href, children, ...rest }){ return createElement("a", { href: typeof href === "string" ? href : "#", ...rest }, children); }`,
  "next/image": `import { createElement } from "react"; export default function Image({ src, alt, ...rest }){ return createElement("img", { src: typeof src === "string" ? src : "", alt: alt ?? "", ...rest }); }`,
};
// Node builtins that leak in through a compiled Next helper (gzip-size, used for
// dev bundle-size reporting) — dead code at mount, so empty modules are safe.
const NODE_BUILTINS = /^(node:)?(fs|stream|zlib|path|os|crypto|util|http|https|net|tls|events|buffer|url|assert|querystring|child_process|worker_threads)$/;
const stubPlugin = {
  name: "e2e-stubs",
  setup(b) {
    const names = Object.keys(stubs);
    const filter = new RegExp("^(" + names.map((n) => n.replace(/[/\\.]/g, "\\$&")).join("|") + ")$");
    b.onResolve({ filter }, (args) => ({ path: args.path, namespace: "e2e-stub" }));
    b.onLoad({ filter: /.*/, namespace: "e2e-stub" }, (args) => ({ contents: stubs[args.path], loader: "js", resolveDir: repo }));
    b.onResolve({ filter: NODE_BUILTINS }, () => ({ path: "node-builtin", namespace: "e2e-empty" }));
    b.onLoad({ filter: /.*/, namespace: "e2e-empty" }, () => ({ contents: "export default {}; export const __empty = true;", loader: "js" }));
  },
};

const output = await mkdtemp(path.join(tmpdir(), "nml-served-browser-"));
await build({
  absWorkingDir: repo,
  entryPoints: ["tests/nml-served-editor.browser.tsx"],
  bundle: true,
  format: "esm",
  outfile: path.join(output, "nml-served-editor.browser.js"),
  platform: "browser",
  conditions: ["browser", "import"],
  tsconfig: "tsconfig.json",
  loader: {
    ".json": "json", ".css": "css", ".svg": "dataurl",
    ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl", ".eot": "dataurl",
    ".png": "dataurl", ".jpg": "dataurl", ".jpeg": "dataurl", ".gif": "dataurl",
  },
  define: {
    "process.env.NODE_ENV": '"development"',
    "process.env.NEXT_PUBLIC_YJS": '"1"',
  },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [stubPlugin],
  logLevel: "warning",
});
await writeFile(
  path.join(output, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/nml-served-editor.browser.css"></head><body><div id="app">loading</div><script type="module" src="/nml-served-editor.browser.js"></script></body></html>`,
);
const pageServer = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const name = pathname === "/" ? "index.html" : path.basename(pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
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
  browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.NML_CHROME_PATH ? { executablePath: process.env.NML_CHROME_PATH } : {}) });
  const errors = [];
  const paidRequests = [];
  // A fresh, instrumented page per phase — a second page (not a re-navigation)
  // gives Phase 2 a clean client without waiting on Phase 1's open WebSocket.
  async function openPage() {
    const p = await browser.newPage();
    p.on("pageerror", (e) => { errors.push(e.message); console.error("Browser error:", e.message); });
    p.on("console", (m) => { if (m.type() === "error") console.error("console.error:", m.text()); });
    await p.setRequestInterception(true);
    p.on("request", (request) => {
      const url = request.url();
      if (/\/api\/(complete|diagram|chat|reformat|album\/index|places)/.test(url)) paidRequests.push(url);
      if (url.startsWith(origin) || url.startsWith(CONVEX_URL) || url.startsWith("http://127.0.0.1:3211")) return void request.continue();
      return void request.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await p.goto(origin, { waitUntil: "load" });
    await p.waitForSelector('#app[data-ready="true"]');
    return p;
  }

  // ── Phase 1: auto-migrate. Mount the real Editor on the legacy page; it must
  //    render the legacy editor first, then auto-migrate and remount the served
  //    NML editor once the backend verifies the root and nmlAuthority flips. ────
  const pg = await openPage();
  await pg.evaluate((cfg) => window.nmlServed.mount(cfg), { url: CONVEX_URL, jwt: ownerJwt, docId, pageId, projectId });
  const sawLegacy = await pg
    .waitForFunction(() => window.nmlServed.probe().legacy, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  await pg.waitForFunction(() => window.nmlServed.probe().served === true, { timeout: 45000 });
  const served = await pg.evaluate(() => window.nmlServed.probe());
  assert.equal(served.served, true, "Editor remounted onto NmlServedEditor");
  assert.equal(served.legacy, false, "the legacy BlockNote editor is gone once served");
  assert.match(served.text, /hello/, "the served editor shows the migrated content");

  // ── Phase 2: steady-state edit. A fresh page (a new client) opens the now
  //    already-served doc — exactly how a real user reaches it, migration long
  //    since done — mounts NmlServedEditor straight to served, and types. The
  //    edit must land on the canonical NML root with NO recovery panel. ─────────
  //    Phase 1's page stays open (a harmless second collaborator); a fresh page
  //    gives Phase 2 an independent client rather than racing a client close.
  const pg2 = await openPage();
  await pg2.evaluate((cfg) => window.nmlServed.mount(cfg), { url: CONVEX_URL, jwt: ownerJwt, docId, pageId, projectId });
  await pg2.waitForFunction(() => window.nmlServed.probe().served === true, { timeout: 30000 });
  const steady = await pg2.evaluate(() => window.nmlServed.probe());
  assert.equal(steady.served, true, "an already-served doc mounts NmlServedEditor directly");
  assert.equal(steady.legacy, false, "no legacy editor for an already-served doc");
  assert.match(steady.text, /hello/, "the served editor shows the canonical content");

  await pg2.click("#editor-host .nt-nml-view");
  await pg2.keyboard.press("End");
  await pg2.keyboard.type(" WORLD");
  await pg2.waitForFunction(() => window.nmlServed.probe().text.includes("WORLD"), { timeout: 15000 });
  const afterType = await pg2.evaluate(() => window.nmlServed.probe());
  assert.equal(afterType.recoveryShown, false, "an ordinary edit shows no composition-recovery panel");

  // The provider flushes; poll the PERSISTED NML root until the edit is there — a
  // fresh decode of the stored Yjs updates, independent of the DOM.
  const persisted = await pg2.waitForFunction(
    async () => {
      const text = await window.nmlServed.persistedNmlText();
      return text.includes("hello WORLD") ? text : false;
    },
    { timeout: 20000, polling: 500 },
  ).then((h) => h.jsonValue());
  assert.match(persisted, /hello WORLD/, "the typed edit persisted on the canonical NML root");

  await pg2.screenshot({ path: path.join(output, "served-editor.png"), fullPage: true });
  assert.deepEqual(errors, [], "no browser errors");
  assert.deepEqual(paidRequests, [], "no paid requests");
  console.log(JSON.stringify({
    result: "passed",
    checks: [
      "legacy-mounted-first",
      "auto-migrated-and-served",
      "legacy-gone",
      "served-shows-content",
      "steady-state-mounts-served-directly",
      "edit-clean-no-recovery-panel",
      "edit-lands-on-canonical-nml-root",
    ],
    sawLegacy,
    docId,
    steadyText: steady.text.slice(0, 60),
    afterTypeText: afterType.text.slice(0, 60),
    persistedNmlText: persisted.slice(0, 60),
    browserErrors: errors.length,
    paidRequests: paidRequests.length,
    screenshots: output,
  }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => pageServer.close(resolve));
  await new Promise((resolve) => issuerServer.close(resolve));
}
