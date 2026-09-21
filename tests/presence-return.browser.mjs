/**
 * A collaborator who goes away and comes back, driven through real Chromium
 * keyboard input.
 *
 * NT-26: presence is time-based, so a tab that suspends stops rewriting its
 * row and everyone drops it after `PRESENCE_STALE_MS`. `removeAwarenessStates`
 * takes their state out of y-protocols but LEAVES their clock behind, and
 * `applyAwarenessUpdate` applies only a strictly higher one. The heartbeat that
 * brought them back carried the clock they fell asleep on — nothing about them
 * had changed — so it was dropped, and they stayed off the carets and the
 * canvas until their own renewal timer outran it, up to ~25s later.
 *
 * Two people, two real `YConvexProvider`s and two real collaborative editors
 * over one stand-in Convex backend (the `ydocs` log and the `presence` table).
 * A is the observer and every check reads A's screen; B is the one who leaves.
 * Only B is ever focused, because y-prosemirror clears a blurred editor's
 * cursor from awareness and A needs no caret of its own to draw B's.
 *
 * Uses the existing esbuild dependency and an operator-installed Puppeteer. No
 * app server, no Convex, no API keys — and every non-local request fails the
 * run, so no AI lane can be spent in here.
 *
 *   NML_PUPPETEER_MODULE=/absolute/path/to/puppeteer/lib/esm/puppeteer/puppeteer.js \
 *     node tests/presence-return.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "presence-return-"));
const { default: puppeteer } = await import(process.env.NML_PUPPETEER_MODULE || "puppeteer");

await build({
  absWorkingDir: repo, entryPoints: ["tests/presence-return.browser.tsx"], bundle: true, splitting: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [{ name: "reject-next-server-diagnostics", setup(builder) {
    builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({ path: "server-only", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };' }));
  } }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
});
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/presence-return.browser.css"><style>html,body{margin:0;font-family:Arial,sans-serif}#a,#b{border:1px solid #ddd;margin:8px;min-height:180px}</style></head><body><div id="a"></div><div id="b"></div><script type="module" src="/presence-return.browser.js"></script></body></html>`);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") { response.writeHead(204); return void response.end(); }
    const name = pathname === "/" ? "index.html" : path.basename(pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream");
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return void console.log(`  ok   ${name}`);
  failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
  console.log(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let browser;
try {
  browser = await puppeteer.launch({ headless: true, ...(process.env.NML_CHROME_PATH ? { executablePath: process.env.NML_CHROME_PATH } : {}) });
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setViewport({ width: 1100, height: 900 });
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    failures.push(`console ${message.type()}: ${message.text()}`);
  });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().startsWith(origin) || request.url().startsWith("data:")) return void request.continue();
    failures.push(`request left the fixture: ${request.url()}`);
    return void request.abort();
  });
  await page.evaluateOnNewDocument(() => {
    window.WebSocket = class extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0;
      send() { throw new Error("Fixture socket must never send"); }
      close() { this.readyState = 3; }
    };
  });

  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.nt);
  await page.evaluate(() => window.nt.mount());
  await page.waitForFunction(() => document.querySelectorAll("#a .bn-block-content, #b .bn-block-content").length >= 2);

  // B types, as the person they are. Their caret rides to A on awareness.
  await page.click("#b .bn-block-content");
  await page.keyboard.type("Bram is drafting the shot list", { delay: 12 });
  await page.waitForFunction(() => window.nt.seen().length === 1, { timeout: 5000 });
  await sleep(2200); // past the caret's 2s dwell, so the flag has furled again

  check("A sees Bram's caret while he is here", await page.evaluate(() => window.nt.seen()),
    [{ name: "Bram", color: "#cc3366", unfurled: false }]);
  check("A's awareness holds Bram", await page.evaluate(() => window.nt.known()), ["Bram"]);
  check("B's text reached A", await page.evaluate(() => window.nt.text().includes("shot list")), true);

  const clockAsleep = await page.evaluate(() => window.nt.clock());

  // --- B's tab suspends ---------------------------------------------------
  await page.evaluate(() => window.nt.away());
  await page.waitForFunction(() => window.nt.known().length === 0, { timeout: 5000 });
  check("Bram's caret comes down once his row goes stale", await page.evaluate(() => window.nt.seen()), []);
  check("and A's awareness lets him go", await page.evaluate(() => window.nt.known()), []);

  // --- B's tab wakes, at the clock it fell asleep on -----------------------
  await page.evaluate(() => window.nt.back());
  await sleep(300);
  check("B's clock did not move while he was away (this is the NT-26 case)",
    await page.evaluate(() => window.nt.clock()), clockAsleep);
  check("Bram is back in A's awareness on his very first heartbeat",
    await page.evaluate(() => window.nt.known()), ["Bram"]);
  check("and his caret is back on A's screen, unfurled as an arrival",
    await page.evaluate(() => window.nt.seen()),
    [{ name: "Bram", color: "#cc3366", unfurled: true }]);

  // The channel is genuinely live again, not a one-off repaint.
  await page.click("#b .bn-block-content");
  await page.keyboard.type(" and the credits", { delay: 12 });
  await page.waitForFunction(() => window.nt.text().includes("credits"), { timeout: 5000 });
  // The sharp edge of the bug: a cursor resting at the end of a line resolves
  // to the same relative position however much is typed, so an active writer's
  // awareness clock barely moves. Their words arrive; they do not.
  check("B's later typing still reaches A", await page.evaluate(() => window.nt.text().includes("credits")), true);
  check("and B, who wrote them, is on screen with them",
    await page.evaluate(() => window.nt.seen().map((c) => c.name)), ["Bram"]);

  // --- a second cycle, to prove nothing was consumed ----------------------
  await page.evaluate(() => window.nt.away());
  await page.waitForFunction(() => window.nt.known().length === 0, { timeout: 5000 });
  await page.evaluate(() => window.nt.back());
  await sleep(300);
  check("a second leave and return works the same", await page.evaluate(() => window.nt.known()), ["Bram"]);

  // --- the peer whose clock DID move must still come back -----------------
  await page.evaluate(() => window.nt.away());
  await page.waitForFunction(() => window.nt.known().length === 0, { timeout: 5000 });
  await page.evaluate(() => { window.nt.renew(); window.nt.back(); });
  await sleep(300);
  check("a peer whose renewal timer did run comes back too",
    await page.evaluate(() => window.nt.known()), ["Bram"]);

  // --- a heartbeat from someone already on screen changes nothing ---------
  const before = await page.evaluate(() => window.nt.known());
  await page.evaluate(() => window.nt.beat());
  await sleep(200);
  check("a redundant heartbeat leaves a present peer alone",
    await page.evaluate(() => window.nt.known()), before);

  await page.screenshot({ path: path.join(output, "returned.png") });
  console.log(`\nscreenshot: ${path.join(output, "returned.png")}`);
} finally {
  await browser?.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} failure(s):\n${failures.join("\n")}` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
