/**
 * The keys and menu items that act on whole blocks, driven through real
 * Chromium input: Escape into and out of a block selection, the arrows, Shift,
 * Enter and typing on one, ⌘D, the grip menu's Duplicate and Turn into, and a
 * triple-click that must stay inside its block.
 *
 * The editor is composed the way `useYjsEditor` composes it, with the grip
 * mounted. Uses the existing esbuild dependency and Playwright. No app server,
 * no Convex, no API keys — and every non-local request fails the run, so no AI
 * lane can be spent in here.
 *
 *   node tests/editor-block-ops.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "editor-block-ops-"));

await build({
  absWorkingDir: repo, entryPoints: ["tests/editor-block-ops.browser.tsx"], bundle: true, splitting: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [{ name: "reject-next-server-diagnostics", setup(builder) {
    builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({ path: "server-only", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };' }));
  } }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
});
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/editor-block-ops.browser.css"><style>html,body{margin:0;height:100%;overflow:hidden;font-family:Arial,sans-serif}</style></head><body><div id="app"></div><script type="module" src="/editor-block-ops.browser.js"></script></body></html>`);

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
const MOD = process.platform === "darwin" ? "Meta" : "Control";

// Reading order: 0 Alpha, 1 Bravo, 2 its child, 3 Charlie, 4 an empty
// paragraph, 5 its child, 6 Delta.
const DOC = [
  { type: "paragraph", content: "Alpha paragraph" },
  { type: "paragraph", content: "Bravo paragraph", children: [
    { type: "bulletListItem", content: "Child of bravo" },
  ] },
  { type: "paragraph", content: "Charlie paragraph" },
  { type: "paragraph", content: "", children: [
    { type: "paragraph", content: "Nested under the empty one" },
  ] },
  { type: "paragraph", content: "Delta last" },
];
const ALPHA = 0, BRAVO = 1, CHILD = 2, CHARLIE = 3, EMPTY = 4, NESTED = 5, DELTA = 6;
const BLOCKS = 7;

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    failures.push(`console error: ${message.text()}`);
  });
  await page.route("**/*", (route) => {
    if (route.request().url().startsWith(origin)) return route.continue();
    failures.push(`request left the fixture: ${route.request().url()}`);
    return route.abort();
  });

  await page.goto(origin, { waitUntil: "networkidle" });
  const h = (fn, arg) => page.evaluate(fn, arg);
  const selection = () => h(() => window.blockOps.selection());
  const texts = () => h(() => window.blockOps.texts());
  const count = () => h(() => window.blockOps.count());

  let T = [];
  const fresh = async (doc = DOC, blocks = BLOCKS) => {
    await h(() => window.blockOps.mount());
    await page.waitForSelector(".bn-editor");
    await h((seed) => window.blockOps.seed(seed), doc);
    await page.waitForFunction((n) => window.blockOps.count() === n, blocks);
    await sleep(100);
    T = await texts();
  };
  const caret = async (index, offset) => {
    await h(([i, o]) => window.blockOps.caret(i, o), [index, offset]);
    await sleep(50);
  };
  const press = async (key) => {
    await page.keyboard.press(key);
    await sleep(80);
  };
  const chord = async (key) => {
    await page.keyboard.down(MOD);
    await page.keyboard.press(key);
    await page.keyboard.up(MOD);
    await sleep(120);
  };
  const point = (index, offset) => h(([i, o]) => window.blockOps.textPoint(i, o), [index, offset]);

  // ---------------------------------------------------------------- Escape ---
  console.log("\nEscape steps out of writing and back");

  await fresh();
  await caret(CHARLIE, 4);
  await press("Escape");
  let s = await selection();
  check("Escape in text selects the block the caret is in", [s.kind, s.selected], ["block", [CHARLIE]]);
  check("…and the editor keeps the keyboard", [s.focused, await h(() => window.blockOps.activeIsEditor())], [true, true]);
  await press("Escape");
  s = await selection();
  check("a second Escape lets the block go, leaving the caret at its end",
    [s.kind, s.caretBlock, s.caretOffset, s.focused], ["text", CHARLIE, T[CHARLIE].length, true]);
  await page.keyboard.type("!");
  await sleep(80);
  check("…where typing carries on", (await texts())[CHARLIE], `${T[CHARLIE]}!`);

  await fresh();
  await caret(ALPHA, 2);
  await page.keyboard.down("Shift");
  await press("ArrowDown");
  await press("ArrowDown");
  await page.keyboard.up("Shift");
  await press("Escape");
  s = await selection();
  check("Escape on text running across blocks selects every block it touches",
    [s.kind, s.selected], ["block", [ALPHA, BRAVO]]);

  // ---------------------------------------------------------------- arrows ---
  console.log("\nThe arrows move a block selection");

  await fresh();
  await h((i) => window.blockOps.selectBlocks(i), [ALPHA]);
  await press("ArrowDown");
  s = await selection();
  check("↓ moves the selection onto the next block", [s.kind, s.selected, s.focused], ["block", [BRAVO], true]);
  await press("ArrowDown");
  s = await selection();
  check("↓ from a block with children steps past them, which it already covers", s.selected, [CHARLIE]);
  await press("ArrowUp");
  s = await selection();
  check("↑ moves onto the block just above on screen, a child", s.selected, [CHILD]);
  await press("ArrowUp");
  await press("ArrowUp");
  await press("ArrowUp");
  s = await selection();
  check("↑ at the top of the page stays on the first block", [s.kind, s.selected, s.focused], ["block", [ALPHA], true]);
  await h((i) => window.blockOps.selectBlocks(i), [DELTA]);
  await press("ArrowDown");
  s = await selection();
  check("↓ at the bottom stays on the last block", [s.kind, s.selected], ["block", [DELTA]]);

  await fresh();
  await h((i) => window.blockOps.selectBlocks(i), [ALPHA]);
  await page.keyboard.down("Shift");
  await press("ArrowDown");
  s = await selection();
  check("Shift+↓ extends the selection down", s.selected, [ALPHA, BRAVO]);
  await press("ArrowDown");
  s = await selection();
  check("…a block at a time, stepping past children already covered", s.selected, [ALPHA, BRAVO, CHARLIE]);
  await press("ArrowUp");
  s = await selection();
  check("Shift+↑ then shrinks it back from the same end", s.selected, [ALPHA, BRAVO]);
  await press("ArrowUp");
  await press("ArrowUp");
  s = await selection();
  check("…and past its start, grows it the other way", s.selected, [ALPHA]);
  await page.keyboard.up("Shift");

  await fresh();
  await h((i) => window.blockOps.selectBlocks(i), [DELTA]);
  await page.keyboard.down("Shift");
  await press("ArrowUp");
  await page.keyboard.up("Shift");
  s = await selection();
  check("Shift+↑ from a lone block extends it upward", s.selected, [EMPTY, DELTA]);

  // A folded toggle's child is in the document but not on the page.
  await fresh([
    { type: "toggleListItem", content: "Folded toggle", children: [{ type: "paragraph", content: "Hidden inside" }] },
    { type: "paragraph", content: "After the toggle" },
  ], 3);
  await h((i) => window.blockOps.selectBlocks(i), [2]);
  await press("ArrowUp");
  s = await selection();
  check("↑ never lands on a block a folded toggle hides", s.selected, [0]);

  // --------------------------------------------------- Enter, typing, clipboard
  console.log("\nEnter, typing and the clipboard on a block selection");

  await fresh();
  await h((i) => window.blockOps.selectBlocks(i), [ALPHA, BRAVO]);
  await press("Enter");
  s = await selection();
  check("Enter puts the caret at the end of the last selected block's own text",
    [s.kind, s.caretBlock, s.caretOffset, s.focused], ["text", BRAVO, T[BRAVO].length, true]);
  check("…and changes nothing", [await count(), await texts()], [BLOCKS, T]);

  await fresh();
  await h((i) => window.blockOps.selectBlocks(i), [CHILD]);
  await press("Enter");
  s = await selection();
  check("…a list item's own Enter does not take it first",
    [s.kind, s.caretBlock, s.caretOffset, await count()], ["text", CHILD, T[CHILD].length, BLOCKS]);

  await fresh();
  await h((i) => window.blockOps.selectBlocks(i), [CHARLIE]);
  await page.keyboard.type("Q");
  await sleep(100);
  s = await selection();
  check("typing replaces the selected block with a paragraph holding the character",
    [(await texts())[CHARLIE], (await h(() => window.blockOps.types()))[CHARLIE], await count()], ["Q", "paragraph", BLOCKS]);
  check("…with the caret after it", [s.kind, s.caretBlock, s.caretOffset], ["text", CHARLIE, 1]);

  await fresh();
  await h((i) => window.blockOps.selectBlocks(i), [BRAVO]);
  await h(() => window.blockOps.takeCopied());
  await chord("KeyC");
  {
    const copied = await h(() => window.blockOps.takeCopied());
    check("⌘C copies the selected block with its child", !!copied && copied.includes(T[BRAVO]) && copied.includes(T[CHILD]), true);
  }
  await chord("KeyX");
  s = await selection();
  check("⌘X cuts the block and its child", [await count(), (await texts()).includes(T[BRAVO])], [BLOCKS - 2, false]);
  check("…leaving a caret in the editor", [s.kind, s.focused], ["text", true]);

  // -------------------------------------------------------------------- ⌘D ---
  console.log("\n⌘D duplicates");

  await fresh();
  await caret(ALPHA, 3);
  await chord("KeyD");
  s = await selection();
  check("⌘D with a caret duplicates its block, just below", [await count(), (await texts())[ALPHA + 1]], [BLOCKS + 1, T[ALPHA]]);
  check("…and the caret moves to the same place in the copy", [s.kind, s.caretBlock, s.caretOffset, s.focused], ["text", ALPHA + 1, 3, true]);

  await fresh();
  await h((i) => window.blockOps.selectBlocks(i), [BRAVO]);
  await chord("KeyD");
  s = await selection();
  {
    const t = await texts();
    check("⌘D on a selected block duplicates it with its children, after them",
      [await count(), t[CHILD + 1], t[CHILD + 2]], [BLOCKS + 2, T[BRAVO], T[CHILD]]);
  }
  check("…and the copy is what is selected", [s.kind, s.selected], ["block", [CHILD + 1]]);

  await fresh();
  await caret(ALPHA, 2);
  await page.keyboard.down("Shift");
  await press("ArrowDown");
  await press("ArrowDown");
  await press("ArrowDown");
  await page.keyboard.up("Shift");
  await chord("KeyD");
  s = await selection();
  check("⌘D on text running across blocks duplicates every block it touches",
    [await count(), (await texts()).slice(CHARLIE + 1, CHARLIE + 5)], [BLOCKS + 4, [T[ALPHA], T[BRAVO], T[CHILD], T[CHARLIE]]]);
  check("…and selects the copies", [s.kind, s.selected], ["block", [CHARLIE + 1, CHARLIE + 2, CHARLIE + 4]]);

  // --------------------------------------------------------- triple-click ---
  console.log("\nA triple-click stays in its block");

  await fresh();
  {
    const p = await point(CHARLIE, 3);
    // One press the platform counts as the third: what a triple-click slower
    // than ProseMirror's own 500ms window arrives as.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 3 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 3 });
    await sleep(200);
  }
  s = await selection();
  check("a platform triple-click selects just that block's text", [s.kind, s.text], ["text", T[CHARLIE]]);
  await page.keyboard.type("X");
  await sleep(100);
  check("typing then replaces only that text; the empty block and its child stay put",
    [await count(), (await texts())[CHARLIE], (await h(() => window.blockOps.depths()))[NESTED]], [BLOCKS, "X", 1]);

  await fresh();
  {
    const p = await point(CHARLIE, 3);
    await page.mouse.click(p.x, p.y, { clickCount: 3 });
    await sleep(200);
  }
  s = await selection();
  check("a quick triple-click selects just that block's text too", [s.kind, s.text], ["text", T[CHARLIE]]);

  // ------------------------------------------------------------ grip menu ---
  console.log("\nThe grip menu");

  const openGrip = async (index) => {
    const p = await point(index, 1);
    await page.mouse.move(p.x + 5, p.y);
    await sleep(150);
    await page.click('button[aria-label="Block actions"]');
    await page.waitForSelector(".bn-drag-handle-menu");
    await sleep(100);
  };
  const menuItem = (label) => page.locator(".mantine-Menu-item", { hasText: new RegExp(`^${label}$`) }).first();

  await fresh();
  await openGrip(ALPHA);
  await menuItem("Duplicate").click();
  await sleep(200);
  s = await selection();
  check("Duplicate copies the block below it", [await count(), (await texts())[ALPHA + 1]], [BLOCKS + 1, T[ALPHA]]);
  check("…selects the copy, and leaves the keyboard in the editor",
    [s.kind, s.selected, await h(() => window.blockOps.activeIsEditor())], ["block", [ALPHA + 1], true]);
  await chord("KeyD");
  check("…so ⌘D straight after copies the copy", [await count(), (await texts())[ALPHA + 2]], [BLOCKS + 2, T[ALPHA]]);

  await fresh();
  await openGrip(CHARLIE);
  await menuItem("Turn into").hover();
  await page.waitForSelector(".nt-turn-into-menu");
  await sleep(150);
  check("Turn into lists the kinds of writing, marking the current one",
    await page.$$eval(".nt-turn-into-menu .mantine-Menu-item", (items) => items.map((i) => i.textContent.trim())),
    ["Text", "Heading 1", "Heading 2", "Heading 3", "Bullet list", "Numbered list", "To-do list", "Toggle list", "Quote", "Code"]);
  await menuItem("Heading 2").click();
  await sleep(200);
  s = await selection();
  check("Turn into → Heading 2 converts the block and keeps its words",
    [(await h(() => window.blockOps.types()))[CHARLIE], (await h(() => window.blockOps.levels()))[CHARLIE], (await texts())[CHARLIE]],
    ["heading", 2, T[CHARLIE]]);
  check("…and leaves it selected, with the keyboard in the editor",
    [s.kind, s.selected, await h(() => window.blockOps.activeIsEditor())], ["block", [CHARLIE], true]);

  await openGrip(CHARLIE);
  await menuItem("Turn into").hover();
  await page.waitForSelector(".nt-turn-into-menu");
  await sleep(150);
  await menuItem("Code").click();
  await sleep(300);
  check("Turn into → Code carries the words into the code block",
    [(await h(() => window.blockOps.types()))[CHARLIE], (await texts())[CHARLIE]], ["codeBlock", T[CHARLIE]]);

  await fresh();
  await h((i) => window.blockOps.selectBlocks(i), [ALPHA, BRAVO]);
  await openGrip(ALPHA);
  await menuItem("Turn into").hover();
  await page.waitForSelector(".nt-turn-into-menu");
  await sleep(150);
  await menuItem("Bullet list").click();
  await sleep(200);
  check("Turn into on a selection converts every selected block",
    (await h(() => window.blockOps.types())).slice(0, 2), ["bulletListItem", "bulletListItem"]);
} finally {
  await browser?.close();
  server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nall passed");
