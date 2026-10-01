// Phase 2 assembled-mount e2e: the REAL `Editor` component, signed in as an
// internal-owner subject (eligible through the `internalOwners` allowlist),
// auto-migrates a legacy page and remounts the full BlockNote surface with NML
// authority — all against a throwaway local convex-local-backend. No paid API
// is touched.
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

// ── The admin `run` helper (the enrolment itself follows the seed, below) ─────
async function run(fn, args) {
  const inherited = { ...process.env };
  delete inherited.CONVEX_DEPLOYMENT;
  const env = {
    ...inherited,
    // Mask a deployment selected by .env.local. The self-hosted variables below
    // are the only deployment this throwaway harness may address.
    CONVEX_DEPLOYMENT: "",
    CONVEX_SELF_HOSTED_URL: process.env.CONVEX_SELF_HOSTED_URL || CONVEX_URL,
  };
  await execFileP(
    path.join(repo, "node_modules", ".bin", "convex"),
    ["run", fn, JSON.stringify(args)],
    { cwd: process.env.NML_CONVEX_CLI_CWD || repo, env },
  );
}

// ── Seed a legacy page owned by the internal owner (over the real wire) ───────
const seed = new ConvexHttpClient(CONVEX_URL);
seed.setAuth(ownerJwt);
const existing = await seed.query(anyApi.projects.list, {});
const projectId = existing?.[0]?._id ?? (await seed.mutation(anyApi.projects.create, { title: "nml-served-e2e" }));
const pageId = await seed.mutation(anyApi.pages.create, { projectId });
const page = await seed.query(anyApi.pages.get, { pageId });
const docId = page.docId;
await seed.mutation(anyApi.ydoc.init, { docId, update: base.buffer.slice(base.byteOffset, base.byteOffset + base.byteLength) });

// Enrolled only now: a page made while its owner is enrolled and serving is on
// is born on NML (NT-124) and has nothing to migrate. This harness is about the
// migration, so the legacy page exists first.
await run("nmlMigration:addInternalOwner", { subject: OWNER, note: "e2e" });
// Turn on the master serve switch (a Convex row, not a build flag).
await run("nmlMigration:setNmlServe", { enabled: true });

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
  },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [stubPlugin],
  logLevel: "warning",
});
await writeFile(
  path.join(output, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/nml-served-editor.browser.css"><style>#editor-host{margin-left:72px}</style></head><body><div id="app">loading</div><script type="module" src="/nml-served-editor.browser.js"></script></body></html>`,
);
const pageServer = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
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
      if (/\/api\/(complete|diagram|chat|reformat|album\/index|places)/.test(url)) {
        paidRequests.push(url);
        return void request.respond({ status: 200, contentType: "text/plain", body: "" });
      }
      if (url.startsWith(origin) || url.startsWith(CONVEX_URL) || url.startsWith("http://127.0.0.1:3211")) return void request.continue();
      return void request.respond({ status: 200, contentType: "application/json", body: "{}" });
    });
    await p.goto(origin, { waitUntil: "load" });
    await p.waitForSelector('#app[data-ready="true"]');
    return p;
  }

  // ── Phase 1: auto-migrate. Mount the real Editor on the legacy page; it must
  //    render the legacy editor first, then auto-migrate and remount the same
  //    complete editor surface with NML authority once the backend verifies it. ─
  const pg = await openPage();
  await pg.evaluate((cfg) => window.nmlServed.mount(cfg), { url: CONVEX_URL, jwt: ownerJwt, docId, pageId, projectId });
  const sawLegacy = await pg
    .waitForFunction(() => window.nmlServed.probe().legacy, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  await pg.waitForFunction(() => window.nmlServed.probe().served === true, { timeout: 45000 });
  const served = await pg.evaluate(() => window.nmlServed.probe());
  assert.equal(served.served, true, "Editor remounted with canonical NML authority");
  assert.equal(served.legacy, false, "the served surface is no longer on the legacy pipeline");
  assert.equal(served.detail.bnEditors, 1, "the complete BlockNote surface remains mounted");
  assert.match(served.text, /hello/, "the served editor shows the migrated content");

  // ── Phase 2: steady-state edit. A fresh page (a new client) opens the now
  //    already-served doc — exactly how a real user reaches it, migration long
  //    since done — mounts the NML-authoritative compatibility surface and
  //    types. The edit must land on the canonical NML root. ────────────────────
  //    Phase 1's page stays open (a harmless second collaborator); a fresh page
  //    gives Phase 2 an independent client rather than racing a client close.
  const pg2 = await openPage();
  await pg2.evaluate((cfg) => window.nmlServed.mount(cfg), { url: CONVEX_URL, jwt: ownerJwt, docId, pageId, projectId });
  await pg2.waitForFunction(() => window.nmlServed.probe().served === true, { timeout: 30000 });
  const steady = await pg2.evaluate(() => window.nmlServed.probe());
  assert.equal(steady.served, true, "an already-served doc mounts NML authority directly");
  assert.equal(steady.legacy, false, "the served doc is not on the legacy pipeline");
  assert.equal(steady.detail.bnEditors, 1, "served docs retain the complete editor surface");
  assert.match(steady.text, /hello/, "the served editor shows the canonical content");

  await pg2.click('#editor-host [data-nml-served="true"] .bn-inline-content');
  await pg2.keyboard.press("End");
  await pg2.keyboard.type(" WORLD");
  await pg2.waitForFunction(() => window.nmlServed.probe().text.includes("WORLD"), { timeout: 15000 });
  const afterType = await pg2.evaluate(() => window.nmlServed.probe());

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

  // ── Phase 3 (NT-125): turn empty lines into a divider, a table, a math block
  //    and an image through the real `---` rule and slash menu. The editor keeps
  //    each block's ID, and before NT-125 the first of them wedged the mirror:
  //    nothing typed afterwards reached NML, and the next mount erased it. ──────
  const consoleErrors = [];
  pg2.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  const settleFrames = () => pg2.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const caretAtEnd = async (text) => {
    assert.ok(await pg2.evaluate((t) => window.nmlServed.caretAtEnd(t), text), `caret after "${text}"`);
    await settleFrames();
  };
  const slash = async (query, title) => {
    await pg2.keyboard.type(`/${query}`);
    await pg2.waitForFunction(
      (want) => document.querySelector(".nt-slash-item[aria-selected=true] .nt-slash-title")?.textContent === want,
      { timeout: 10000 },
      title,
    );
    await pg2.keyboard.press("Enter");
    await pg2.waitForFunction(() => !document.querySelector(".nt-slash"), { timeout: 10000 });
    await settleFrames();
  };
  const waitTypes = (expected) => pg2.waitForFunction(
    // The trailing-paragraph extension keeps an empty line after a last table.
    (want) => {
      const trim = (types) => types.join(" ").replace(/( paragraph)+$/, "");
      return trim(window.nmlServed.blockTypes()) === trim(want);
    },
    { timeout: 15000 },
    expected,
  ).catch(async () => assert.fail(`surface shows ${JSON.stringify(await pg2.evaluate(() => window.nmlServed.blockTypes()))}, wanted ${JSON.stringify(expected)}; notice ${await pg2.evaluate(() => window.nmlServed.revertNotice())}; errors ${JSON.stringify(consoleErrors)}`));

  await caretAtEnd("hello WORLD");
  await pg2.keyboard.press("Enter");
  await pg2.keyboard.type("---");
  await waitTypes(["paragraph", "divider", "paragraph"]);
  await pg2.keyboard.type("after divider");

  await caretAtEnd("after divider");
  await pg2.keyboard.press("Enter");
  await slash("table", "Table");
  await waitTypes(["paragraph", "divider", "paragraph", "table"]);

  await caretAtEnd("after divider");
  await pg2.keyboard.press("Enter");
  await slash("mathblock", "Math block");
  await waitTypes(["paragraph", "divider", "paragraph", "mathBlock", "table"]);
  await pg2.keyboard.press("Escape");

  await caretAtEnd("after divider");
  await pg2.keyboard.press("Enter");
  await slash("image", "Image");
  await waitTypes(["paragraph", "divider", "paragraph", "image", "mathBlock", "table"]);
  await pg2.keyboard.press("Escape");

  await caretAtEnd("hello WORLD");
  await pg2.keyboard.type(" AGAIN");
  const wanted = [
    { type: "paragraph", text: "hello WORLD AGAIN" },
    { type: "divider", text: "" },
    { type: "paragraph", text: "after divider" },
    { type: "image", text: "" },
    { type: "mathBlock", text: "" },
    { type: "table", text: "" },
  ];
  const persistedBlocks = await pg2.waitForFunction(
    async (want) => {
      const blocks = (await window.nmlServed.persistedNmlBlocks()).filter((b) => b.type !== "paragraph" || b.text);
      return JSON.stringify(blocks) === JSON.stringify(want) ? blocks : false;
    },
    { timeout: 20000, polling: 500 },
    wanted,
  ).then((h) => h.jsonValue()).catch(async () => assert.fail(
    `persisted NML is ${JSON.stringify(await pg2.evaluate(() => window.nmlServed.persistedNmlBlocks()))}`,
  ));
  assert.equal(await pg2.evaluate(() => window.nmlServed.revertNotice()), false, "no edit was refused");
  assert.deepEqual(consoleErrors.filter((t) => t.includes("NML compatibility mirror failed")), [], "the mirror never failed");

  // A fresh client mounts the page: its mirror projects canonical NML over the
  // ProseMirror root, which must now hold everything written above.
  const pg3 = await openPage();
  await pg3.evaluate((cfg) => window.nmlServed.mount(cfg), { url: CONVEX_URL, jwt: ownerJwt, docId, pageId, projectId });
  await pg3.waitForFunction(() => window.nmlServed.probe().text.includes("hello WORLD AGAIN"), { timeout: 30000 });
  await pg3.waitForFunction(() => window.nmlServed.probe().text.includes("after divider"), { timeout: 5000 });
  const remounted = await pg3.evaluate(() => window.nmlServed.blockTypes());
  assert.deepEqual(remounted.filter((t) => t !== "paragraph"), ["divider", "image", "mathBlock", "table"], "a fresh mount keeps every converted block");
  await new Promise((r) => setTimeout(r, 1500));
  const afterRemount = (await pg3.evaluate(() => window.nmlServed.persistedNmlBlocks())).filter((b) => b.type !== "paragraph" || b.text);
  assert.deepEqual(afterRemount, wanted, "the remount erased nothing");
  await pg2.screenshot({ path: path.join(output, "served-type-changes.png"), fullPage: true });

  // ── Phase 4 (NT-126): a list or toggle item holding children turned into a
  //    leaf through every real path — Backspace at its start, ⌘⌥0 and ⌘⌥1, and
  //    the grip's Turn into → Code — plus several blocks outdented at once. NML
  //    has no leaf with children, so the children come out after it, in order;
  //    the surface must then show exactly what canonical NML holds. ───────────
  const p4 = pg3;
  const p4Errors = [];
  p4.on("console", (m) => { if (m.type() === "error") p4Errors.push(m.text()); });
  const frames = () => p4.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const at = async (where, text) => {
    assert.ok(await p4.evaluate((w, t) => window.nmlServed[w](t), where, text), `${where} "${text}"`);
    await frames();
  };
  const chord = async (...keys) => {
    for (const key of keys.slice(0, -1)) await p4.keyboard.down(key);
    await p4.keyboard.press(keys.at(-1));
    for (const key of keys.slice(0, -1).reverse()) await p4.keyboard.up(key);
    await frames();
  };
  const line = async (text) => { await p4.keyboard.type(text); await frames(); };
  const key = async (name) => { await p4.keyboard.press(name); await frames(); };
  // The surface and the persisted canonical tree must agree, and say `want`.
  const agree = async (label, want) => {
    const result = await p4.waitForFunction(async (expected) => {
      const surface = window.nmlServed.surfaceOutline();
      const persisted = await window.nmlServed.persistedNmlOutline();
      return surface === persisted && (!expected || surface.includes(expected)) ? surface : false;
    }, { timeout: 20000, polling: 400 }, want ?? "").then((h) => h.jsonValue()).catch(async () => assert.fail(
      `${label}: surface ${JSON.stringify(await p4.evaluate(() => window.nmlServed.surfaceOutline()))}\n  persisted ${JSON.stringify(await p4.evaluate(() => window.nmlServed.persistedNmlOutline()))}\n  wanted ${JSON.stringify(want)}; notice ${await p4.evaluate(() => window.nmlServed.revertNotice())}; errors ${JSON.stringify(p4Errors)}`,
    ));
    return result;
  };
  await agree("start");

  // A: a bullet with a child; Backspace at its start makes it a paragraph.
  await at("caretAtEnd", "after divider");
  await key("Enter");
  await line("- A item");
  await key("Enter");
  await key("Tab");
  await line("A child");
  await agree("A built");
  await at("caretAtStart", "A item");
  await key("Backspace");
  await agree("A converted", "paragraph:after divider | paragraph:A item | bulletListItem:A child | image:");

  // B: a toggle with a child; ⌘⌥0 makes it a paragraph.
  await at("caretAtEnd", "after divider");
  await key("Enter");
  await line("B toggle");
  await chord("Meta", "Alt", "Digit7");
  await key("Enter");
  await key("Tab");
  await line("B child");
  await agree("B built");
  await at("caretAtEnd", "B toggle");
  await chord("Meta", "Alt", "Digit0");
  await agree("B converted", "paragraph:after divider | paragraph:B toggle | toggleListItem:B child | paragraph:A item");

  // C: a bullet with two children, the first nesting its own; ⌘⌥1 makes it a
  // heading. Before NT-126 the first child landed at the end of the page.
  await at("caretAtEnd", "after divider");
  await key("Enter");
  await line("- C item");
  await key("Enter");
  await key("Tab");
  await line("C one");
  await key("Enter");
  await key("Tab");
  await line("C grand");
  await key("Enter");
  await chord("Shift", "Tab");
  await line("C two");
  await agree("C built");
  await at("caretAtEnd", "C item");
  await chord("Meta", "Alt", "Digit1");
  await agree("C converted", "paragraph:after divider | heading:C item | bulletListItem:C one[bulletListItem:C grand] | bulletListItem:C two | paragraph:B toggle");

  // D: a toggle with a child, through the grip's Turn into → Code.
  await at("caretAtEnd", "after divider");
  await key("Enter");
  await line("D toggle");
  await chord("Meta", "Alt", "Digit7");
  await key("Enter");
  await key("Tab");
  await line("D child");
  await agree("D built");
  const box = await p4.evaluate(() => window.nmlServed.lineBox("D toggle"));
  await p4.mouse.move(box.x + 5, box.y);
  const grip = await p4.waitForSelector('button[aria-label="Block actions"]', { visible: true, timeout: 5000 });
  const gripBox = await grip.boundingBox();
  await p4.mouse.click(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await p4.waitForSelector(".bn-drag-handle-menu", { timeout: 5000 }).catch(async (error) => {
    await p4.screenshot({ path: path.join(output, "grip.png"), fullPage: true });
    throw error;
  });
  const menuItem = async (label) => {
    const handle = await p4.waitForFunction((want) => [...document.querySelectorAll(".mantine-Menu-item")]
      .find((el) => el.textContent.trim() === want), { timeout: 5000 }, label);
    return handle.asElement();
  };
  await (await menuItem("Turn into")).hover();
  await p4.waitForSelector(".nt-turn-into-menu");
  await new Promise((r) => setTimeout(r, 200));
  await (await menuItem("Code")).click();
  await p4.waitForFunction(() => !document.querySelector(".bn-drag-handle-menu"), { timeout: 5000 }).catch(() => {});
  await key("Escape");
  await agree("D converted", "paragraph:after divider | codeBlock:D toggle | toggleListItem:D child | heading:C item");

  // E: two children outdented at once with a selection and Shift+Tab.
  await at("caretAtEnd", "after divider");
  await key("Enter");
  await line("- E parent");
  await key("Enter");
  await key("Tab");
  await line("E one");
  await key("Enter");
  await line("E two");
  await agree("E built");
  assert.ok(await p4.evaluate(() => window.nmlServed.selectLines("E one", "E two")), "select E one..E two");
  await frames();
  await chord("Shift", "Tab");
  await agree("E outdented", "paragraph:after divider | bulletListItem:E parent | bulletListItem:E one | bulletListItem:E two | codeBlock:D toggle");

  // Typing after all of it still reaches NML, nothing was refused, and a
  // fresh client's mount projects the same tree back.
  await at("caretAtEnd", "A child");
  await line("!");
  const p4Wanted = [
    "paragraph:hello WORLD AGAIN", "divider:", "paragraph:after divider",
    "bulletListItem:E parent", "bulletListItem:E one", "bulletListItem:E two",
    "codeBlock:D toggle", "toggleListItem:D child",
    "heading:C item", "bulletListItem:C one[bulletListItem:C grand]", "bulletListItem:C two",
    "paragraph:B toggle", "toggleListItem:B child",
    "paragraph:A item", "bulletListItem:A child!",
    "image:", "mathBlock:", "table:",
  ].join(" | ");
  assert.equal(await agree("typed after", "A child!"), p4Wanted, "the page holds every conversion, in order");
  assert.equal(await p4.evaluate(() => window.nmlServed.revertNotice()), false, "no conversion was refused");
  assert.deepEqual(p4Errors.filter((t) => t.includes("NML compatibility mirror")), [], "the mirror never failed");
  const p5 = await openPage();
  await p5.evaluate((cfg) => window.nmlServed.mount(cfg), { url: CONVEX_URL, jwt: ownerJwt, docId, pageId, projectId });
  await p5.waitForFunction((want) => window.nmlServed.surfaceOutline() === want, { timeout: 30000 }, p4Wanted)
    .catch(async () => assert.fail(`remount shows ${JSON.stringify(await p5.evaluate(() => window.nmlServed.surfaceOutline()))}`));
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await p5.evaluate(() => window.nmlServed.persistedNmlOutline()), p4Wanted, "the remount erased nothing");
  await p4.screenshot({ path: path.join(output, "served-leaf-conversions.png"), fullPage: true });

  // ── Phase 5 (NT-127): NML holds four levels of blocks. Tab past them, or a
  //    paste that would land a list deeper, must not hand the mirror a tree it
  //    refuses — before NT-127 the indent showed, then was undone with the
  //    "couldn't be saved" notice. p5 stays open as a collaborator throughout. ─
  //    A background tab gets no animation frames, so p4 comes back to the front.
  await p4.bringToFront();
  await at("caretAtEnd", "after divider");
  await key("Enter");
  await line("- F1");
  await key("Enter");
  await key("Tab");
  await line("F2");
  await key("Enter");
  await key("Tab");
  await line("F3");
  await key("Enter");
  await key("Tab");
  await line("F4");
  await key("Enter");
  await line("F5");
  const fourDeep = "bulletListItem:F1[bulletListItem:F2[bulletListItem:F3[bulletListItem:F4 | bulletListItem:F5]]]";
  await agree("F built", `paragraph:after divider | ${fourDeep} | bulletListItem:E parent`);

  // F: Tab on a fourth-level item has nowhere to go, and stays put.
  await key("Tab");
  await line("!");
  await agree("F tab refused", `paragraph:after divider | ${fourDeep.replace("F5", "F5!")} | bulletListItem:E parent`);

  // G: a third-level item holding a child can't nest either — the child would
  //    be fifth — while a second-level item beside it still can.
  await at("caretAtEnd", "after divider");
  await key("Enter");
  await line("- G1");
  await key("Enter");
  await key("Tab");
  await line("G2");
  await key("Enter");
  await key("Tab");
  await line("G3");
  await key("Enter");
  await line("G3b");
  await key("Enter");
  await key("Tab");
  await line("G4");
  await agree("G built", "bulletListItem:G1[bulletListItem:G2[bulletListItem:G3 | bulletListItem:G3b[bulletListItem:G4]]]");
  await at("caretAtStart", "G3b");
  await key("Tab");
  await line("?");
  await agree("G tab refused", "bulletListItem:G1[bulletListItem:G2[bulletListItem:G3 | bulletListItem:?G3b[bulletListItem:G4]]]");

  // H: a nested list pasted into a fourth-level item comes in flat at that
  //    level, in order, and one ⌘Z takes the whole paste back.
  await at("caretAtEnd", "F5!");
  await key("Enter");
  assert.ok(await p4.evaluate(() => window.nmlServed.pasteHtml(
    "<ul><li>H1<ul><li>H2<ul><li>H3</li></ul></li><li>H2b</li></ul></li></ul>",
    "H1\n  H2\n    H3\n  H2b",
  )), "paste H");
  await frames();
  const pastedFlat = "bulletListItem:F1[bulletListItem:F2[bulletListItem:F3[bulletListItem:F4 | bulletListItem:F5! | bulletListItem:H1 | bulletListItem:H2 | bulletListItem:H3 | bulletListItem:H2b]]]";
  await agree("H pasted", pastedFlat);
  // The empty item the Enter made stays: it was its own step.
  const unpasted = fourDeep.replace("F5", "F5! | bulletListItem:");
  await chord("Meta", "KeyZ");
  await agree("H undone", unpasted);

  // Typing afterwards still lands, nothing was refused, and a fresh client
  // projects the same tree back.
  await at("caretAtEnd", "G4");
  await line(" end");
  const p5Wanted = await agree("typed after depth", "G4 end");
  assert.ok(p5Wanted.includes(unpasted), `the four-deep list held: ${p5Wanted}`);
  assert.equal(await p4.evaluate(() => window.nmlServed.revertNotice()), false, "no deep edit was refused");
  assert.deepEqual(p4Errors.filter((t) => t.includes("NML compatibility mirror")), [], "the mirror never failed on depth");
  await p5.waitForFunction((want) => window.nmlServed.surfaceOutline() === want, { timeout: 30000 }, p5Wanted)
    .catch(async () => assert.fail(`collaborator shows ${JSON.stringify(await p5.evaluate(() => window.nmlServed.surfaceOutline()))}`));
  const p6 = await openPage();
  await p6.evaluate((cfg) => window.nmlServed.mount(cfg), { url: CONVEX_URL, jwt: ownerJwt, docId, pageId, projectId });
  await p6.waitForFunction((want) => window.nmlServed.surfaceOutline() === want, { timeout: 30000 }, p5Wanted)
    .catch(async () => assert.fail(`remount shows ${JSON.stringify(await p6.evaluate(() => window.nmlServed.surfaceOutline()))}`));
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await p6.evaluate(() => window.nmlServed.persistedNmlOutline()), p5Wanted, "the remount erased nothing");
  await p4.screenshot({ path: path.join(output, "served-depth-limit.png"), fullPage: true });


  await pg2.screenshot({ path: path.join(output, "served-editor.png"), fullPage: true });
  assert.deepEqual(errors, [], "no browser errors");
  // Completion and reformat fire on debounces, so whether typing reached them
  // is timing; what matters is that only those lanes were attempted, stubbed.
  assert.ok(
    paidRequests.every((url) => ["/api/complete", "/api/reformat"].includes(new URL(url).pathname)),
    `typing attempts only the legacy-equivalent typing lanes, which the harness stubs: ${paidRequests}`,
  );
  console.log(JSON.stringify({
    result: "passed",
    checks: [
      "legacy-mounted-first",
      "auto-migrated-and-served",
      "legacy-pipeline-replaced",
      "full-blocknote-surface-retained",
      "served-shows-content",
      "steady-state-mounts-served-directly",
      "edit-lands-on-canonical-nml-root",
      "divider-table-math-image-conversions-reach-nml",
      "edits-after-conversions-reach-nml",
      "fresh-mount-erases-nothing",
      "backspace-bullet-with-child-to-paragraph",
      "mod-alt-0-toggle-with-child-to-paragraph",
      "mod-alt-1-nested-children-to-heading-in-order",
      "turn-into-code-toggle-with-child",
      "multi-block-shift-tab-in-order",
      "leaf-conversions-survive-fresh-mount",
      "tab-past-four-levels-stays-put",
      "tab-of-a-subtree-past-four-levels-stays-put",
      "deep-paste-flattens-at-four-levels-and-undoes-whole",
      "depth-edits-survive-collaborator-and-fresh-mount",
    ],
    persistedBlocks,
    sawLegacy,
    docId,
    steadyText: steady.text.slice(0, 60),
    afterTypeText: afterType.text.slice(0, 60),
    persistedNmlText: persisted.slice(0, 60),
    browserErrors: errors.length,
    interceptedPaidRoutes: paidRequests.map((url) => new URL(url).pathname),
    paidRequests: 0,
    screenshots: output,
  }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => pageServer.close(resolve));
  await new Promise((resolve) => issuerServer.close(resolve));
}
