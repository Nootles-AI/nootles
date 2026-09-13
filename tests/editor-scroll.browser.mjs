/**
 * Scrolling a collaborative document, driven through real Chromium wheel,
 * mouse and keyboard input.
 *
 * NT-19: while anyone else was editing the page — a collaborator typing, an
 * agent's turn landing — a selection or caret could not be scrolled out of
 * view. y-prosemirror re-renders each arriving change as a transaction that
 * scrolls to the local selection whenever any part of it still touches the
 * window, so the page snapped back each time its last line reached the edge,
 * and a selection whose head sat below the fold dragged the page down to it.
 * `app/lib/sync/remoteScroll.ts` keeps arriving changes from scrolling.
 *
 * The editor is composed the way `useYjsEditor` composes it, bound to a local
 * Y.Doc that exchanges updates with a peer doc the way the Convex provider
 * does. Every scroll a script performs is recorded, so a check can tell the
 * person's own scrolling from the editor's.
 *
 * Uses the existing esbuild dependency and an operator-installed Puppeteer. No
 * app server, no Convex, no API keys — and every non-local request fails the
 * run, so no AI lane can be spent in here.
 *
 *   NML_PUPPETEER_MODULE=/absolute/path/to/puppeteer/lib/esm/puppeteer/puppeteer.js \
 *     node tests/editor-scroll.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "editor-scroll-"));
const { default: puppeteer } = await import(process.env.NML_PUPPETEER_MODULE || "puppeteer");

await build({
  absWorkingDir: repo, entryPoints: ["tests/editor-scroll.browser.tsx"], bundle: true, splitting: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [{ name: "reject-next-server-diagnostics", setup(builder) {
    builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({ path: "server-only", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };' }));
  } }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
});
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/editor-scroll.browser.css"><style>html,body{margin:0;height:100%;overflow:hidden;font-family:Arial,sans-serif}</style></head><body><div id="app"></div><script type="module" src="/editor-scroll.browser.js"></script></body></html>`);

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

const VIEWPORT = { width: 1470, height: 801 };
const PARAGRAPHS = 60;
// The block the peer types into: below everything the scenarios select, so its
// growing text never shifts what is on screen.
const PEER_BLOCK = 55;
// Smaller than a line, so a scrolled line always spends several steps
// straddling the window's edge — the moment an arriving change used to snap it.
const TRACKPAD_STEP = 10;

let browser;
try {
  browser = await puppeteer.launch({ headless: true, ...(process.env.NML_CHROME_PATH ? { executablePath: process.env.NML_CHROME_PATH } : {}) });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    failures.push(`console ${message.type()}: ${message.text()}`);
  });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().startsWith(origin)) return void request.continue();
    failures.push(`request left the fixture: ${request.url()}`);
    return void request.abort();
  });
  // Scrolls a script performs. A wheel scrolls natively and never reaches
  // these; neither does the browser's scroll anchoring.
  await page.evaluateOnNewDocument(() => {
    const log = (window.__scrolls = []);
    const record = () => log.push(new Error().stack);
    const top = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get() { return top.get.call(this); },
      set(value) { record(); top.set.call(this, value); },
    });
    for (const name of ["scrollBy", "scrollTo", "scroll", "scrollIntoView"]) {
      const original = Element.prototype[name];
      Element.prototype[name] = function (...args) { record(); return original.apply(this, args); };
    }
    for (const name of ["scrollBy", "scrollTo", "scroll"]) {
      const original = window[name];
      window[name] = function (...args) { record(); return original.apply(window, args); };
    }
  });

  await page.goto(origin, { waitUntil: "networkidle0" });
  const h = (fn, ...args) => page.evaluate(fn, ...args);
  const top = () => h(() => window.scrollHarness.scrollTop());
  /** The editor's own scrolls since the last call — the harness's placement excluded. */
  const editorScrolls = () => h(() => window.__scrolls.splice(0).filter((stack) => !stack.includes("setScrollTop")).length);

  const fresh = async () => {
    await h(() => window.scrollHarness.mount());
    await page.waitForSelector(".bn-editor");
    await h((count) => window.scrollHarness.seed(count), PARAGRAPHS);
    await page.waitForFunction((count) => window.scrollHarness.blockCount() === count && window.scrollHarness.textPoint(count - 1, 5) !== null, {}, PARAGRAPHS);
    await sleep(100);
    await h(() => { window.scrollHarness.resetHistory(); window.scrollHarness.setScrollTop(0); });
    await editorScrolls();
  };
  /** Scroll the pane so block `index` starts `y` px below the top of the window. */
  const place = async (index, y) => {
    await h((i, at) => window.scrollHarness.setScrollTop(window.scrollHarness.scrollTop() + window.scrollHarness.blockRect(i).top - at), index, y);
    await sleep(50);
  };
  const shift = async (by) => {
    await h((delta) => window.scrollHarness.setScrollTop(window.scrollHarness.scrollTop() + delta), by);
    await sleep(50);
  };
  const drag = async ([fromBlock, fromOffset], [toBlock, toOffset]) => {
    const a = await h((i, o) => window.scrollHarness.textPoint(i, o), fromBlock, fromOffset);
    const b = await h((i, o) => window.scrollHarness.textPoint(i, o), toBlock, toOffset);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
    await sleep(150);
  };
  const clickText = async (index, offset) => {
    const point = await h((i, o) => window.scrollHarness.textPoint(i, o), index, offset);
    await page.mouse.click(point.x, point.y);
    await sleep(100);
  };
  /**
   * Small wheel steps over the page, the way a trackpad scrolls. With `peer`,
   * the collaborator lands a keystroke between every step — someone typing
   * while this person reads.
   */
  const scrollBy = async (distance, { peer = false, step = TRACKPAD_STEP } = {}) => {
    await page.mouse.move(700, 400);
    const signed = step * Math.sign(distance);
    for (let moved = 0; moved !== distance; moved += signed) {
      await page.mouse.wheel({ deltaY: signed });
      if (peer) await h((block) => window.scrollHarness.peerType(block, "x"), PEER_BLOCK);
      await sleep(50);
    }
    await sleep(300);
  };

  // ------------------------------------------------------------- NT-19 ---
  console.log("\nNT-19 — somebody else's edit must not scroll this page");

  await fresh();
  await place(6, 300);
  await drag([6, 10], [6, 60]);
  const selected = await h(() => window.scrollHarness.selection());
  check("setup: a text selection is held", [selected.empty, selected.focused], [false, true]);
  let before = await top();
  await scrollBy(500, { peer: true });
  check("a selection scrolls off the top while a peer types", (await top()) - before, 500);
  check("…with no scroll from the editor", await editorScrolls(), 0);
  const after = await h(() => window.scrollHarness.selection());
  check("…and the selection is untouched", [after.anchor, after.head], [selected.anchor, selected.head]);
  check("…and every peer keystroke landed", (await h((block) => window.scrollHarness.blockText(block), PEER_BLOCK)).endsWith("x".repeat(50)), true);

  await fresh();
  await place(30, 500);
  await drag([30, 10], [30, 60]);
  before = await top();
  await scrollBy(-500, { peer: true });
  check("a selection scrolls off the bottom while a peer types", (await top()) - before, -500);
  check("…with no scroll from the editor", await editorScrolls(), 0);

  await fresh();
  await place(6, 300);
  await clickText(6, 20);
  check("setup: a caret is held", (await h(() => window.scrollHarness.selection())).empty, true);
  before = await top();
  await scrollBy(500, { peer: true });
  check("a caret scrolls off the top while a peer types", (await top()) - before, 500);
  check("…with no scroll from the editor", await editorScrolls(), 0);

  await fresh();
  await place(6, 300);
  await drag([6, 10], [8, 20]);
  check("setup: a drag across blocks is a block selection", (await h(() => window.scrollHarness.selection())).kind.includes("BlockRangeSelection"), true);
  before = await top();
  await scrollBy(500, { peer: true });
  check("a block selection scrolls away while a peer types", (await top()) - before, 500);
  check("…with no scroll from the editor", await editorScrolls(), 0);

  await fresh();
  await place(10, 120);
  await clickText(10, 0);
  await page.keyboard.down("Shift");
  for (let i = 0; i < 14; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.up("Shift");
  // ProseMirror reads a keyboard selection back from the DOM after the keys
  // land, and scrolls its head into view when it does; place it once it has.
  await sleep(600);
  await shift((await h(() => window.scrollHarness.headRect())).top - (VIEWPORT.height + 40));
  const head = await h(() => window.scrollHarness.headRect());
  const anchor = await h(() => window.scrollHarness.anchorRect());
  check("setup: the selection's head is below the fold, its anchor on screen",
    (head.top > VIEWPORT.height && anchor.top >= 0 && anchor.bottom <= VIEWPORT.height) || { head, anchor }, true);
  await editorScrolls();
  before = await top();
  await h((block) => window.scrollHarness.peerType(block, "x"), PEER_BLOCK);
  await sleep(500);
  check("one peer keystroke does not drag the page down to the head", (await top()) - before, 0);
  check("…with no scroll from the editor", await editorScrolls(), 0);

  // ------------------------------------------------- what stays the same ---
  console.log("\nScrolling that must keep working");

  await fresh();
  await place(6, 300);
  await drag([6, 10], [6, 60]);
  before = await top();
  await scrollBy(800, { step: 20 });
  check("alone, a selection scrolls away", (await top()) - before, 800);
  check("…with no scroll from the editor", await editorScrolls(), 0);

  await fresh();
  await place(10, 300);
  await clickText(10, 0);
  await page.keyboard.down("Shift");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.up("Shift");
  await sleep(600);
  await editorScrolls();
  before = await top();
  await scrollBy(500);
  check("alone, a keyboard selection scrolls away", (await top()) - before, 500);
  check("…with no scroll from the editor", await editorScrolls(), 0);

  await fresh();
  await place(20, 300);
  await clickText(20, 30);
  await scrollBy(1200, { step: 20 });
  check("setup: the caret is scrolled off the top", (await h(() => window.scrollHarness.headRect())).bottom < 0, true);
  await page.keyboard.type("y");
  await sleep(300);
  let caret = await h(() => window.scrollHarness.headRect());
  check("typing brings an off-screen caret back into view", caret.top >= 0 && caret.bottom <= VIEWPORT.height, true);
  check("…and the keystroke landed", (await h(() => window.scrollHarness.blockText(20))).includes("y"), true);

  await fresh();
  await place(20, 300);
  await clickText(20, 30);
  const original = await h(() => window.scrollHarness.blockText(20));
  await page.keyboard.type(" undone");
  await sleep(100);
  await h(() => window.scrollHarness.closeHistoryStep());
  // The caret's line straddles the bottom edge: part of it still touches the
  // window, which is when an undo reveals it.
  await shift((await h(() => window.scrollHarness.headRect())).top - (VIEWPORT.height - 8));
  caret = await h(() => window.scrollHarness.headRect());
  check("setup: the caret straddles the bottom edge", caret.top < VIEWPORT.height && caret.bottom > VIEWPORT.height, true);
  await h(() => window.scrollHarness.undo());
  await sleep(300);
  check("undo takes the typing back out", await h(() => window.scrollHarness.blockText(20)), original);
  caret = await h(() => window.scrollHarness.headRect());
  check("undo still reveals the caret", caret.bottom <= VIEWPORT.height, true);
} finally {
  await browser?.close();
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
