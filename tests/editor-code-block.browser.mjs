/**
 * The code block's keyboard, driven through real Chromium input: the ways in
 * (the slash menu, a typed fence, ⌘⌥8) put the caret in the code, and the ways
 * out (the arrows at its edges, Escape, Backspace when empty) hand it back to
 * the page — Notion's behaviour for each.
 *
 * Undo is pressed as ⌘Z on the page the app builds for a Yjs document: the
 * editor bound to a Y.Doc, its text domain on the workspace spine. And the
 * ways in are also typed straight after a cold load, with the editor's chunks
 * held back by the server, so the keys arrive before CodeMirror does.
 *
 * No app server, no Convex, no API keys — and every non-local request fails the
 * run, so no AI lane can be spent by typing in here.
 *
 *   npm run test:editor:code
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "editor-code-block-"));

await build({
  absWorkingDir: repo,
  entryPoints: ["tests/editor-code-block.browser.tsx"],
  bundle: true,
  splitting: true,
  format: "esm",
  outdir: output,
  platform: "browser",
  conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [{
    name: "reject-next-server-diagnostics",
    setup(builder) {
      builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({
        path: "server-only",
        namespace: "fixture",
      }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };',
      }));
    },
  }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
  logLevel: "warning",
});

await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/editor-code-block.browser.css"><style>body{margin:24px;font-family:Arial,sans-serif}</style></head><body><div id="app"></div><script type="module" src="/editor-code-block.browser.js"></script></body></html>`);

/** Held back on every script but the entry, to load the page cold on a slow line. */
let chunkDelay = 0;
const ENTRY = "editor-code-block.browser.js";

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (chunkDelay && pathname.endsWith(".js") && !pathname.endsWith(ENTRY)) {
      await new Promise((resolve) => setTimeout(resolve, chunkDelay));
    }
    if (pathname === "/favicon.ico") { response.writeHead(204); return void response.end(); }
    const name = pathname === "/" ? "index.html" : path.basename(pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream");
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end();
  }
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
const sleep = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.NML_CHROME_PATH ? { executablePath: process.env.NML_CHROME_PATH } : {}),
  });
  /** A fresh page in a fresh context, so nothing the last one fetched is cached. */
  const newPage = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        failures.push(`console ${message.type()}: ${message.text()}`);
      }
    });
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      // The code block asks for completions of its own; answer with nothing.
      if (url.startsWith(`${origin}/api/`)) return route.fulfill({ status: 204 });
      if (url.startsWith(origin)) return route.continue();
      failures.push(`request left the fixture: ${url}`);
      return route.abort();
    });
    await page.goto(origin);
    await page.waitForSelector(".bn-editor");
    return page;
  };

  // ------------------------------------------------------- a cold load ---
  console.log("\nCold — typed before the editor has arrived");
  chunkDelay = 2000;
  {
    const cold = await newPage();
    await cold.evaluate(() => window.codeHarness.mount([{ type: "paragraph" }]));
    await sleep();
    const id = await cold.evaluate(() => window.codeHarness.document()[0].id);
    await cold.evaluate((i) => window.codeHarness.caretTo(i, "start"), id);
    await cold.keyboard.type("/code", { delay: 100 });
    await cold.waitForSelector(".bn-suggestion-menu");
    await cold.keyboard.press("Enter");
    await cold.keyboard.type("abc", { delay: 100 });
    const early = await cold.evaluate(() => document.querySelectorAll(".cm-editor").length);
    check("the keys were typed before CodeMirror arrived", early, 0);
    await cold.waitForSelector(".cm-editor", { timeout: 20_000 });
    await sleep(600);
    const d = await cold.evaluate(() => window.codeHarness.document());
    const f = await cold.evaluate(() => window.codeHarness.focus());
    check("the slash menu's block keeps what was typed while it loaded",
      [d.map((b) => b.type), d[0].code, d[1].text], [["codeBlock", "paragraph"], "abc", ""]);
    check("and has the caret, after it", [f.in, f.block, f.text], ["code", d[0].id, "abc"]);
    await cold.keyboard.type("d");
    await sleep(500);
    check("so typing carries on in the code", (await cold.evaluate(() => window.codeHarness.document()))[0].code, "abcd");
    await cold.context().close();
  }
  {
    const cold = await newPage();
    await cold.evaluate(() => window.codeHarness.mount([{ type: "paragraph" }]));
    await sleep();
    const id = await cold.evaluate(() => window.codeHarness.document()[0].id);
    await cold.evaluate((i) => window.codeHarness.caretTo(i, "start"), id);
    await cold.keyboard.type("```abc", { delay: 100 });
    await cold.keyboard.press("Enter");
    await cold.keyboard.type("x", { delay: 100 });
    const early = await cold.evaluate(() => document.querySelectorAll(".cm-editor").length);
    check("the fence was typed before CodeMirror arrived", early, 0);
    await cold.waitForSelector(".cm-editor", { timeout: 20_000 });
    await sleep(600);
    const d = await cold.evaluate(() => window.codeHarness.document());
    check("three backticks keep what followed, new line and all",
      [d.map((b) => b.type), d[0].code, d[1].text], [["codeBlock", "paragraph"], "abc\nx", ""]);
    await cold.context().close();
  }
  chunkDelay = 0;

  const page = await newPage();

  const h = (fn, ...args) => page.evaluate(fn, ...args);
  const doc = () => h(() => window.codeHarness.document());
  const focus = () => h(() => window.codeHarness.focus());
  const types = async () => (await doc()).map((b) => b.type);
  /** Mount, then wait for every code block's editor to exist. */
  const codeCount = (blocks) =>
    blocks.reduce((n, b) => n + (b.type === "codeBlock" ? 1 : 0) + codeCount(b.children ?? []), 0);
  const open = async (blocks, trailing = true) => {
    await h(([b, t]) => window.codeHarness.mount(b, t), [blocks, trailing]);
    await page.waitForFunction((n) => document.querySelectorAll(".cm-editor").length === n,
      codeCount(blocks));
    await sleep();
  };
  const caret = async (index, at) => {
    const id = (await doc())[index].id;
    await h(([i, a]) => window.codeHarness.caretTo(i, a), [id, at]);
    await sleep();
  };
  const enter = async (index, at) => {
    const id = (await doc())[index].id;
    await h(([i, a]) => window.codeHarness.enter(i, a), [id, at]);
    await sleep();
    return id;
  };
  const idAt = async (index) => (await doc())[index].id;

  // ------------------------------------------------------------ ways in ---
  console.log("\nWays in — the caret lands in the code");

  await open([{ type: "paragraph" }]);
  await caret(0, "start");
  await page.keyboard.type("/code");
  await page.waitForSelector(".bn-suggestion-menu");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".cm-editor");
  await sleep(150);
  let f = await focus();
  check("the slash menu's code block takes the caret", [f.in, f.block], ["code", await idAt(0)]);
  await page.keyboard.type("abc");
  await sleep(500);
  let d = await doc();
  check("typing lands in the code, not below it", [d.map((b) => b.type), d[0].code, d[1].text], [["codeBlock", "paragraph"], "abc", ""]);

  await open([{ type: "paragraph", content: "Intro" }]);
  await caret(0, "end");
  await page.keyboard.type("/code");
  await page.waitForSelector(".bn-suggestion-menu");
  await page.keyboard.press("Enter");
  await sleep(200);
  f = await focus();
  d = await doc();
  check("from a line with text, the new block below takes the caret",
    [d.map((b) => b.type), f.in, f.block], [["paragraph", "codeBlock", "paragraph"], "code", d[1].id]);

  await open([{ type: "paragraph" }]);
  await caret(0, "start");
  await page.keyboard.type("```");
  await page.waitForSelector(".cm-editor");
  await sleep(150);
  f = await focus();
  check("three backticks make a code block at once", await types(), ["codeBlock", "paragraph"]);
  check("and the caret is in it", [f.in, f.block], ["code", await idAt(0)]);
  await page.keyboard.type("x");
  await sleep(500);
  check("what follows is code", (await doc())[0].code, "x");

  await open([{ type: "paragraph", content: "hello" }]);
  await caret(0, "start");
  await page.keyboard.type("```");
  await page.waitForSelector(".cm-editor");
  await sleep(150);
  await page.keyboard.type("y");
  await sleep(500);
  d = await doc();
  check("the rest of the line comes along as the code, caret at its start", [d[0].type, d[0].code], ["codeBlock", "yhello"]);

  await open([{ type: "paragraph", content: "```py" }]);
  await caret(0, "end");
  await page.keyboard.type(" ");
  await page.waitForSelector(".cm-editor");
  await sleep(150);
  d = await doc();
  check("a fence naming its language sets it", [d[0].type, d[0].language, d[0].code], ["codeBlock", "python", ""]);
  f = await focus();
  check("and takes the caret", f.in, "code");

  await open([{ type: "paragraph", content: "```rs" }]);
  await caret(0, "end");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".cm-editor");
  await sleep(150);
  d = await doc();
  check("the fence also closes on Enter", [d[0].type, d[0].language], ["codeBlock", "rust"]);

  await open([{ type: "paragraph", content: "let x" }]);
  await caret(0, "end");
  await page.keyboard.press("Meta+Alt+8");
  await page.waitForSelector(".cm-editor");
  await sleep(150);
  d = await doc();
  f = await focus();
  check("⌘⌥8 turns the line into code", [d[0].type, d[0].code], ["codeBlock", "let x"]);
  check("with the caret at the end of it", [f.in, f.block], ["code", d[0].id]);
  await page.keyboard.type(";");
  await sleep(500);
  check("so typing carries on", (await doc())[0].code, "let x;");

  await open([{ type: "heading", props: { level: 2 }, content: "Title" }]);
  await caret(0, "end");
  await page.keyboard.press("Meta+Alt+8");
  await page.waitForSelector(".cm-editor");
  await sleep(150);
  d = await doc();
  check("⌘⌥8 turns a heading too", [d[0].type, d[0].code], ["codeBlock", "Title"]);

  await open([{ type: "paragraph", content: [{ type: "text", text: "See ", styles: {} }, { type: "pageMention", props: { pageId: "p1", title: "Roadmap" } }] }]);
  await caret(0, "end");
  await page.keyboard.press("Meta+Alt+8");
  await page.waitForSelector(".cm-editor");
  await sleep(150);
  check("⌘⌥8 keeps a mention, as its title", (await doc())[0].code, "See Roadmap");

  const three = [
    { type: "paragraph", content: "one" },
    { type: "heading", props: { level: 3 }, content: "two" },
    { type: "divider" },
    { type: "paragraph", content: "three" },
  ];
  await open(three);
  d = await doc();
  await h((ids) => window.codeHarness.selectBlocks(ids), d.map((b) => b.id).slice(0, 4));
  await sleep();
  await page.keyboard.press("Meta+Alt+8");
  await page.waitForFunction(() => document.querySelectorAll(".cm-editor").length === 3);
  await sleep(150);
  d = await doc();
  f = await focus();
  check("⌘⌥8 on selected blocks turns each one with text",
    d.slice(0, 4).map((b) => [b.type, b.code ?? null]),
    [["codeBlock", "one"], ["codeBlock", "two"], ["divider", null], ["codeBlock", "three"]]);
  check("and they stay selected", f, { in: "blocks", ids: d.slice(0, 4).map((b) => b.id) });

  await open(three);
  d = await doc();
  await h(([a, b]) => window.codeHarness.selectText(a, b), [d[0].id, d[1].id]);
  await sleep();
  await page.keyboard.press("Meta+Alt+8");
  await page.waitForFunction(() => document.querySelectorAll(".cm-editor").length === 2);
  await sleep(150);
  d = await doc();
  check("⌘⌥8 on text running across blocks turns every one",
    d.slice(0, 2).map((b) => [b.type, b.code]), [["codeBlock", "one"], ["codeBlock", "two"]]);

  // NT-38's rule: a typed prefix never converts a list item away from its list.
  await open([{ type: "numberedListItem", content: "one" }, { type: "numberedListItem", content: "two" }]);
  await caret(1, "start");
  await page.keyboard.type("```");
  await sleep();
  d = await doc();
  check("three backticks leave a list item as it is", [d[1].type, d[1].text], ["numberedListItem", "```two"]);

  // ----------------------------------------------------------- ways out ---
  console.log("\nWays out — the caret goes back to the page");
  const sandwich = [
    { type: "paragraph", content: "Above" },
    { type: "codeBlock", props: { code: "one\ntwo" } },
    { type: "paragraph", content: "Below" },
  ];

  const caretX = () => h(() => window.codeHarness.caretX());
  /** Within about a character of each other. */
  const sameColumn = (a, b) => Math.abs(a - b) < 9;
  const wide = [
    { type: "paragraph", content: "A paragraph above, long enough to reach past the code" },
    { type: "codeBlock", props: { code: "one two three\nfour five six" } },
    { type: "paragraph", content: "A paragraph below, also long enough to reach past it" },
  ];

  await open(sandwich);
  let code = await enter(1, "start");
  f = await focus();
  check("the way in lands at the start", [f.in, f.block], ["code", code]);

  await open(wide);
  await enter(1, "start");
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowRight");
  let x = await caretX();
  await page.keyboard.press("ArrowUp");
  await sleep();
  f = await focus();
  let landed = await caretX();
  check("↑ on the first line goes to the block above", [f.in, f.block], ["doc", await idAt(0)]);
  check("at the same column", [sameColumn(x, landed), f.offset > 0 && f.offset < 30], [true, true]);

  await open(wide);
  await enter(1, "end");
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  x = await caretX();
  await page.keyboard.press("ArrowDown");
  await sleep();
  f = await focus();
  landed = await caretX();
  check("↓ on the last line goes to the block below, at the same column",
    [f.in, f.block, sameColumn(x, landed), f.offset > 0], ["doc", await idAt(2), true, true]);

  await open(wide);
  await enter(1, "end");
  await page.keyboard.press("ArrowDown");
  await sleep();
  await page.keyboard.press("ArrowUp");
  await sleep();
  f = await focus();
  check("and ↑ from there goes back into the code", [f.in, f.block], ["code", await idAt(1)]);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await sleep();
  f = await focus();
  check("and on up, out of it, to the text above", [f.in, f.block], ["doc", await idAt(0)]);
  await page.keyboard.press("ArrowDown");
  await sleep();
  f = await focus();
  check("↓ from the text above goes into the code too", [f.in, f.block], ["code", await idAt(1)]);

  await open(sandwich);
  await enter(1, "start");
  await page.keyboard.press("ArrowLeft");
  await sleep();
  f = await focus();
  check("← at the very start goes to the block above", f, { in: "doc", block: await idAt(0), offset: 5 });

  await open(sandwich);
  await enter(1, "start");
  await page.keyboard.press("ArrowDown");
  await sleep();
  f = await focus();
  check("↓ off the first of two lines stays in the code", f.in, "code");
  await page.keyboard.press("ArrowDown");
  await sleep();
  f = await focus();
  check("↓ on the last line of short code goes to the block below", [f.in, f.block], ["doc", await idAt(2)]);

  await open(sandwich);
  await enter(1, "end");
  await page.keyboard.press("ArrowRight");
  await sleep();
  f = await focus();
  check("→ at the very end goes to the block below", f, { in: "doc", block: await idAt(2), offset: 0 });
  await page.keyboard.type("!");
  await sleep();
  check("and typing lands there", (await doc())[2].text, "!Below");

  await open(sandwich);
  code = await enter(1, "end");
  await page.keyboard.press("Escape");
  await sleep();
  f = await focus();
  check("Escape selects the block", f, { in: "blocks", ids: [code] });
  await page.keyboard.press("Backspace");
  await sleep();
  check("which Backspace then deletes", await types(), ["paragraph", "paragraph", "paragraph"]);

  await open(sandwich);
  await enter(1, "end");
  await page.keyboard.type("z");
  await sleep(500);
  check("typed code persists before leaving", (await doc())[1].code, "one\ntwoz");
  await page.keyboard.press("ArrowRight");
  await sleep();
  check("and is still there after", (await doc())[1].code, "one\ntwoz");

  await open([{ type: "paragraph", content: "Above" }, { type: "codeBlock", props: { code: "" } }]);
  code = await enter(1, "start");
  await page.keyboard.press("Backspace");
  await sleep();
  d = await doc();
  f = await focus();
  check("Backspace in an empty code block gives back an empty paragraph", [d[1].id, d[1].type, d[1].text], [code, "paragraph", ""]);
  check("with the caret in it", f, { in: "doc", block: code, offset: 0 });

  await open([{ type: "codeBlock", props: { code: "k" } }]);
  await enter(0, "start");
  await page.keyboard.press("Backspace");
  await sleep();
  check("Backspace in code that has text stays code", (await doc())[0].type, "codeBlock");

  console.log("\nNeighbours — the next block is taken the way a click would take it");
  await open([
    { type: "codeBlock", props: { code: "first" } },
    { type: "codeBlock", props: { code: "second" } },
  ]);
  await enter(0, "end");
  await page.keyboard.press("ArrowDown");
  await sleep();
  f = await focus();
  check("↓ into another code block puts the caret in its editor", [f.in, f.block], ["code", await idAt(1)]);
  await page.keyboard.press("ArrowUp");
  await sleep();
  f = await focus();
  check("and ↑ comes back into the first", [f.in, f.block], ["code", await idAt(0)]);

  await open([
    { type: "paragraph", content: "Above" },
    { type: "codeBlock", props: { code: "x" } },
    { type: "divider" },
    { type: "paragraph", content: "Below" },
  ]);
  await enter(1, "end");
  await page.keyboard.press("ArrowDown");
  await sleep();
  f = await focus();
  check("↓ onto a block with no text selects it whole", f, { in: "blocks", ids: [await idAt(2)] });

  await open([
    { type: "paragraph", content: "Parent", children: [{ type: "codeBlock", props: { code: "nested" } }] },
    { type: "paragraph", content: "After" },
  ]);
  const childId = await h(() => document.querySelector(".cm-editor")?.closest("[data-id]")?.getAttribute("data-id"));
  await h((id) => window.codeHarness.enter(id, "start"), childId);
  await sleep();
  await page.keyboard.press("ArrowUp");
  await sleep();
  f = await focus();
  check("↑ from a nested code block goes to its parent's text", [f.in, f.block], ["doc", await idAt(0)]);
  await h((id) => window.codeHarness.enter(id, "end"), childId);
  await sleep();
  await page.keyboard.press("ArrowDown");
  await sleep();
  f = await focus();
  check("↓ from it goes to the block after its parent", [f.in, f.block], ["doc", await idAt(1)]);

  await open([{ type: "codeBlock", props: { code: "last" } }], false);
  await enter(0, "end");
  await page.keyboard.press("ArrowDown");
  await sleep();
  d = await doc();
  f = await focus();
  check("↓ with nothing below makes a line to write on", [d.map((b) => b.type), f.in, f.block], [["codeBlock", "paragraph"], "doc", d[1]?.id]);

  await open([{ type: "codeBlock", props: { code: "top" } }]);
  await enter(0, "start");
  await page.keyboard.press("ArrowUp");
  await sleep();
  f = await focus();
  check("↑ with nothing above stays in the code", f.in, "code");

  // -------------------------------------------------------------- undo ---
  console.log("\nUndo — ⌘Z on the workspace timeline, as the app runs it");
  const shared = async (blocks) => {
    await h(() => window.codeHarness.mountShared());
    await page.waitForSelector(".bn-editor");
    await sleep(300);
    // With the empty line the page keeps last, so nothing is appended on the timeline.
    await h((b) => window.codeHarness.seed(b), [...blocks, { type: "paragraph" }]);
    await page.waitForFunction((n) => document.querySelectorAll(".cm-editor").length === n, codeCount(blocks));
    await sleep(200);
  };
  const undo = async () => {
    await page.keyboard.press("Meta+z");
    await sleep(300);
  };

  await shared([{ type: "heading", props: { level: 2 }, content: "Title" }]);
  await caret(0, "end");
  await page.keyboard.press("Meta+Alt+8");
  await page.waitForSelector(".cm-editor");
  await sleep(300);
  check("⌘⌥8 turns the heading", (await doc())[0].type, "codeBlock");
  await undo();
  d = await doc();
  check("and one ⌘Z gives it back", [d[0].type, d[0].text], ["heading", "Title"]);

  await shared([{ type: "paragraph", content: "Above" }, { type: "codeBlock", props: { code: "" } }]);
  code = await enter(1, "start");
  await page.keyboard.press("Backspace");
  await sleep(300);
  check("Backspace unwraps the empty code block", (await doc())[1].type, "paragraph");
  await undo();
  d = await doc();
  check("and one ⌘Z gives the code block back", [d[1].id, d[1].type], [code, "codeBlock"]);

  await shared([{ type: "paragraph", content: "Before" }, { type: "paragraph" }]);
  await caret(1, "start");
  await page.keyboard.type("```");
  await page.waitForSelector(".cm-editor");
  await sleep(300);
  check("three backticks make the block", (await doc())[1].type, "codeBlock");
  await undo();
  d = await doc();
  // Notion leaves the backticks; whether they stay is the typing run's to say (see app/lib/history).
  check("and one ⌘Z takes the block away again", [d[0].text, d[1].type], ["Before", "paragraph"]);
  console.log(`       (left the line reading ${JSON.stringify(d[1].text)})`);
} finally {
  await browser?.close();
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nall green");
