/**
 * Enter inside a list item, driven through real Chromium mouse and keyboard
 * input.
 *
 * NT-65: pressing Enter on an empty list item one level in turned the item into
 * a paragraph where it stood — still nested under its parent. Leaving a
 * two-deep list took two Enters, and an empty item in the middle of a run left
 * a paragraph between its siblings, which broke the run in two and restarted
 * the numbering after it. BlockNote's own Enter has always outdented an empty
 * indented block (which is why a nested paragraph or heading already came back
 * out a level); the list items' own Enter ran first and never let it.
 * `app/components/editor/blocks/listSafe.ts` makes that shortcut decline
 * exactly the case BlockNote answers.
 *
 * Uses the existing esbuild dependency and an operator-installed Puppeteer. No
 * app server, no Convex, no API keys — and every non-local request fails the
 * run, so no AI lane can be spent by typing in here.
 *
 *   NML_PUPPETEER_MODULE=/absolute/path/to/puppeteer/lib/esm/puppeteer/puppeteer.js \
 *     node tests/editor-list-enter.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "editor-list-enter-"));
const { default: puppeteer } = await import(process.env.NML_PUPPETEER_MODULE || "puppeteer");

await build({
  absWorkingDir: repo, entryPoints: ["tests/editor-list-enter.browser.tsx"], bundle: true, splitting: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [{ name: "reject-next-server-diagnostics", setup(builder) {
    builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({ path: "server-only", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };' }));
  } }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
});
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/editor-list-enter.browser.css"><style>body{margin:24px;font-family:Arial,sans-serif}</style></head><body><div id="app"></div><script type="module" src="/editor-list-enter.browser.js"></script></body></html>`);

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

const LIST_TYPES = ["bulletListItem", "numberedListItem", "checkListItem", "toggleListItem"];
/** prosemirror-history groups transactions this close together into one step. */
const HISTORY_GROUP_MS = 600;

let browser;
try {
  browser = await puppeteer.launch({ headless: true, ...(process.env.NML_CHROME_PATH ? { executablePath: process.env.NML_CHROME_PATH } : {}) });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
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
  await page.goto(origin, { waitUntil: "networkidle0" });
  await page.waitForSelector(".bn-editor");

  const frame = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const rows = () => page.evaluate(() => window.listEnter.rows());
  const caret = () => page.evaluate(() => window.listEnter.caret());
  const enter = () => page.keyboard.press("Enter");
  const shiftTab = async () => {
    await page.keyboard.down("Shift");
    await page.keyboard.press("Tab");
    await page.keyboard.up("Shift");
  };
  /**
   * Arrow keys, waited out. The browser moves its own selection and
   * ProseMirror reads it back a beat later, so pressing and asserting in the
   * same breath asks about the selection one key ago.
   */
  const right = async (times) => {
    const from = await page.evaluate(() => window.listEnter.caretOffset());
    for (let step = 0; step < times; step++) await page.keyboard.press("ArrowRight");
    await page.waitForFunction((offset) => window.listEnter.caretOffset() === offset, {}, from + times);
  };
  const selectLeft = async (times) => {
    await page.keyboard.down("Shift");
    for (let step = 0; step < times; step++) await page.keyboard.press("ArrowLeft");
    await page.keyboard.up("Shift");
    await page.waitForFunction((size) => window.listEnter.selectionSize() === size, {}, times);
  };
  /**
   * The ordinals the reader sees. BlockNote marks a renumbering block with
   * `data-prev-type` while it animates, and that attribute selects a different
   * ::before, so the markers are read once the animation has let go.
   */
  const markers = async () => {
    await page.waitForFunction(() => !document.querySelector(".bn-block-outer[data-prev-type]"));
    return page.evaluate(() => window.listEnter.markers().map((row) => row.marker.replaceAll('"', "")));
  };

  const count = (blocks) => blocks.reduce((total, block) => total + 1 + count(block.children ?? []), 0);
  /** What `count` becomes once `trailingParagraphExtension` has had its say. */
  const mounted = (blocks) => {
    const last = blocks.at(-1);
    const alreadyTrailing =
      last?.type === "paragraph" && !last.content && !(last.children ?? []).length;
    return count(blocks) + (alreadyTrailing ? 0 : 1);
  };

  /**
   * Mount a document and put the caret at one end of block `index` (in reading
   * order, nesting included) by clicking it.
   *
   * The landing is verified down to the offset rather than assumed: Home and
   * End are inert in a contenteditable on macOS, so a click that lands one
   * character short would silently make every Enter after it a split.
   */
  const open = async (blocks, index, where = "end") => {
    await page.evaluate((content) => window.listEnter.mount(content), blocks);
    await page.waitForFunction((total) => window.listEnter.ids().length === total, {}, mounted(blocks));
    const id = await page.evaluate((i) => window.listEnter.ids()[i], index);
    // A collapsed toggle renders its children with no box to aim at.
    for (const ancestor of await page.evaluate(() => window.listEnter.ids())) {
      const chevron = await page.evaluate((target) => window.listEnter.togglePoint(target), ancestor);
      if (chevron) await page.mouse.click(chevron.x, chevron.y);
    }
    let landed = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      // A fresh mount settles its own selection a frame or two after the nodes
      // exist, and it wins any click that lands first.
      await frame();
      const point = await page.evaluate(([target, end]) => window.listEnter.point(target, end), [id, where]);
      if (!point) continue;
      await page.mouse.click(point.x, point.y);
      landed = await page.evaluate(() => [window.listEnter.caretId(), window.listEnter.caretOffset()]);
      const aim = where === "start" ? 0 : ((await rows())[index].text ?? "").length;
      if (landed[0] === id && landed[1] === aim) return;
    }
    throw new Error(`caret landed at ${JSON.stringify(landed)}, wanted block ${index} ${where}`);
  };

  /** `type@depth: text` — the shape the ticket is written in. */
  const shape = async () => (await rows()).map((row) => `${row.type}@${row.depth}: ${row.text}`);
  const item = (type, depth, text) => `${type}@${depth}: ${text}`;
  const TRAILING = "paragraph@0: ";

  // ---------------------------------------------------------------- NT-65 ---
  console.log("\nNT-65 — Enter on an empty nested item steps the item out");
  for (const type of LIST_TYPES) {
    await open([{ type, content: "test1", children: [{ type, content: "test2" }] }], 1);
    await enter();
    check(`${type}: Enter at the end of a nested item makes another nested item`,
      await shape(), [item(type, 0, "test1"), item(type, 1, "test2"), item(type, 1, ""), TRAILING]);
    await enter();
    check(`${type}: Enter on the empty one brings the item back a level`,
      await shape(), [item(type, 0, "test1"), item(type, 1, "test2"), item(type, 0, ""), TRAILING]);
    check(`${type}: the caret is in the item that stepped out`, await caret(), { type, text: "", depth: 0 });
    await page.keyboard.type("test3");
    check(`${type}: typing continues the list there`,
      await shape(), [item(type, 0, "test1"), item(type, 1, "test2"), item(type, 0, "test3"), TRAILING]);
  }

  console.log("\nOne level per Enter, and the list is left only from the top");
  await open([{ type: "bulletListItem", content: "a", children: [
    { type: "bulletListItem", content: "b", children: [{ type: "bulletListItem", content: "c" }] }] }], 2);
  await enter();
  const staircase = [];
  for (let step = 0; step < 4; step++) {
    const at = await caret();
    staircase.push(`${at.type}@${at.depth}`);
    await enter();
  }
  check("three levels deep, Enter walks out one level at a time and then leaves the list",
    staircase, ["bulletListItem@2", "bulletListItem@1", "bulletListItem@0", "paragraph@0"]);

  console.log("\nThe item keeps what is its own and takes what follows — Shift+Tab's answer");
  const run = (type) => [{ type, content: "P", children: [
    { type, content: "x" }, { type, content: "y" }, { type, content: "z" }] }];
  await open(run("bulletListItem"), 2);
  await enter();
  await enter();
  const byEnter = await shape();
  await open(run("bulletListItem"), 2);
  await enter();
  await shiftTab();
  check("Enter on an empty nested item leaves the document Shift+Tab would", byEnter, await shape());
  check("the siblings below follow it out, as an outdent has always done",
    byEnter, ["bulletListItem@0: P", "bulletListItem@1: x", "bulletListItem@1: y",
      "bulletListItem@0: ", "bulletListItem@1: z", TRAILING]);

  await open([{ type: "bulletListItem", content: "P", children: [
    { type: "bulletListItem", content: "kid", children: [{ type: "bulletListItem", content: "grandkid" }] }] }], 1);
  await enter();
  await enter();
  check("an item with children of its own carries them out",
    await shape(), ["bulletListItem@0: P", "bulletListItem@1: kid",
      "bulletListItem@0: ", "bulletListItem@1: grandkid", TRAILING]);

  console.log("\nA numbered run is no longer broken in two");
  await open(run("numberedListItem"), 2);
  await enter();
  check("the fresh empty item counts as 3 of 4", await markers(), ["1.", "1.", "2.", "3.", "4.", ""]);
  await enter();
  check("stepping out leaves 1. 2. under the parent and takes the next number itself",
    await markers(), ["1.", "1.", "2.", "2.", "1.", ""]);
  check("and the run under the parent is still one run",
    await shape(), ["numberedListItem@0: P", "numberedListItem@1: x", "numberedListItem@1: y",
      "numberedListItem@0: ", "numberedListItem@1: z", TRAILING]);

  console.log("\nA check list keeps its own state");
  await open([{ type: "checkListItem", props: { checked: true }, content: "done",
    children: [{ type: "checkListItem", props: { checked: true }, content: "sub" }] }], 1);
  await enter();
  await enter();
  check("the parent stays ticked and the new item starts unticked",
    (await rows()).map((row) => [row.type, row.depth, row.text, row.checked]),
    [["checkListItem", 0, "done", true], ["checkListItem", 1, "sub", true],
      ["checkListItem", 0, "", false], ["paragraph", 0, "", undefined]]);

  console.log("\nA list item under something that is not a list steps out too");
  await open([{ type: "paragraph", content: "Para", children: [{ type: "bulletListItem", content: "under" }] }], 1);
  await enter();
  await enter();
  check("an item nested under a paragraph comes out to the top level as an item",
    await shape(), ["paragraph@0: Para", "bulletListItem@1: under", "bulletListItem@0: ", TRAILING]);

  console.log("\nOne undo takes the step out back");
  await open([{ type: "bulletListItem", content: "test1", children: [{ type: "bulletListItem", content: "test2" }] }], 1);
  await enter();
  await new Promise((done) => setTimeout(done, HISTORY_GROUP_MS));
  await enter();
  await page.evaluate(() => window.listEnter.undo());
  check("the item is back where it was, still an item",
    await shape(), ["bulletListItem@0: test1", "bulletListItem@1: test2", "bulletListItem@1: ", TRAILING]);
  await page.evaluate(() => window.listEnter.redo());
  check("redo steps it out again",
    await shape(), ["bulletListItem@0: test1", "bulletListItem@1: test2", "bulletListItem@0: ", TRAILING]);

  // ------------------------------------------------- everything else stands ---
  console.log("\nThe way out of a list is untouched");
  for (const type of LIST_TYPES) {
    await open([{ type, content: "solo" }], 0);
    await enter();
    await enter();
    check(`${type}: an empty top-level item still leaves the list as a paragraph`,
      await shape(), [item(type, 0, "solo"), "paragraph@0: ", TRAILING]);
  }

  console.log("\nA non-empty item still splits where the caret is");
  await open([{ type: "bulletListItem", content: "P", children: [{ type: "bulletListItem", content: "hello" }] }], 1, "start");
  await right(2);
  await enter();
  check("mid-word, one level in", await shape(),
    ["bulletListItem@0: P", "bulletListItem@1: he", "bulletListItem@1: llo", TRAILING]);
  await open([{ type: "bulletListItem", content: "P", children: [{ type: "bulletListItem", content: "hello" }] }], 1, "start");
  await enter();
  check("at the start, one level in", await shape(),
    ["bulletListItem@0: P", "bulletListItem@1: ", "bulletListItem@1: hello", TRAILING]);
  await open([{ type: "bulletListItem", content: "top" }], 0, "start");
  await enter();
  check("at the start, at the top level", await shape(),
    ["bulletListItem@0: ", "bulletListItem@0: top", TRAILING]);

  console.log("\nA selection that spans characters is still BlockNote's");
  await open([{ type: "bulletListItem", content: "P", children: [{ type: "bulletListItem", content: "hello" }] }], 1);
  await selectLeft(5);
  await enter();
  check("the item's own Enter still answers it, so the item does not step out",
    await shape(), ["bulletListItem@0: P", "bulletListItem@1: ", "paragraph@1: ", TRAILING]);

  console.log("\nBlockNote's own rule for every other block is untouched");
  await open([{ type: "bulletListItem", content: "P", children: [{ type: "paragraph", content: "para" }] }], 1);
  await enter();
  await enter();
  check("an empty nested paragraph still comes out a level",
    await shape(), ["bulletListItem@0: P", "paragraph@1: para", "paragraph@0: ", TRAILING]);
  await open([{ type: "bulletListItem", content: "P", children: [{ type: "heading", props: { level: 2 }, content: "H" }] }], 1);
  await enter();
  await enter();
  check("an empty block after a nested heading still comes out a level",
    await shape(), ["bulletListItem@0: P", "heading@1: H", "paragraph@0: ", TRAILING]);

  console.log("\nTab and Shift+Tab are what they were");
  await open([{ type: "bulletListItem", content: "one" }, { type: "bulletListItem", content: "two" }], 1);
  await page.keyboard.press("Tab");
  check("Tab still nests an item under the one above",
    await shape(), ["bulletListItem@0: one", "bulletListItem@1: two", TRAILING]);
  await shiftTab();
  check("Shift+Tab still brings it back",
    await shape(), ["bulletListItem@0: one", "bulletListItem@0: two", TRAILING]);
} finally {
  await browser?.close();
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
