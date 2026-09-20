/**
 * A tick box inside a table cell, driven through real Chromium mouse and
 * keyboard input.
 *
 * NT-41: a user asked an agent for a habit tracker and got a table whose cells
 * held `☐` characters. There was no box to put in them — the to-do list is a
 * block and draws its box in the gutter, while a table cell holds inline
 * content and no blocks at all, so nothing in the editor could reach one.
 * `app/components/editor/inline/Checkbox.tsx` is the inline form of that box:
 * the same bare `input[type=checkbox]` the list draws, valid anywhere inline
 * content is.
 *
 * Uses the existing esbuild dependency and an operator-installed Puppeteer. No
 * app server, no Convex, no API keys — and every non-local request fails the
 * run, so no AI lane can be spent by typing in here.
 *
 *   NML_PUPPETEER_MODULE=/absolute/path/to/puppeteer/lib/esm/puppeteer/puppeteer.js \
 *     node tests/editor-inline-checkbox.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "editor-inline-checkbox-"));
const { default: puppeteer } = await import(process.env.NML_PUPPETEER_MODULE || "puppeteer");

/**
 * The fixture reaches the production slash-menu list, which lives in
 * `Editor.tsx` beside the page's Convex/Clerk wiring. Only the item list is
 * under test, so the host framework is stubbed rather than run: a Next or Clerk
 * module that reached the browser here would be a different test.
 */
const STUBS = {
  "next/dynamic": "module.exports = { __esModule: true, default: () => () => null };",
  "@clerk/nextjs":
    "exports.useUser = () => ({ user: null, isLoaded: true }); exports.SignedIn = () => null; exports.SignedOut = () => null; exports.useAuth = () => ({ isSignedIn: false, getToken: async () => null });",
};

await build({
  absWorkingDir: repo, entryPoints: ["tests/editor-inline-checkbox.browser.tsx"], bundle: true, splitting: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [{ name: "fixture-stubs", setup(builder) {
    builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({ path: "server-only", namespace: "fixture" }));
    for (const name of Object.keys(STUBS)) {
      builder.onResolve({ filter: new RegExp(`^${name.replace(/[/@]/g, "\\$&")}$`) }, () => ({ path: name, namespace: "fixture" }));
    }
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
      contents: STUBS[args.path] ?? 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };',
    }));
  } }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
});
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/editor-inline-checkbox.browser.css"><style>body{margin:24px;font-family:Arial,sans-serif}:root{--accent:#8a6a2f;--muted:#6b6b6b;--foreground:#1a1a1a;--hover:#f2f2f2;--selected:#e8e8e8;--border-strong:#bbb;--diff-ins:#e8f3e8;--diff-del:#f6e8e8}</style></head><body><div id="app"></div><script type="module" src="/editor-inline-checkbox.browser.js"></script></body></html>`);

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
const section = (name) => console.log(`\n${name}`);

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
  const settle = async () => { await frame(); await frame(); };
  const grid = () => page.evaluate(() => window.checkbox.grid());
  const boxes = () => page.evaluate(() => window.checkbox.boxes());
  const rows = () => page.evaluate(() => window.checkbox.rows());
  const caret = () => page.evaluate(() => window.checkbox.caret());
  const mountTracker = async (options = {}) => {
    await page.evaluate((o) => window.checkbox.mountTracker(o), options);
    await settle();
    await page.waitForSelector(".bn-editor table");
  };

  const clickAt = async (point, label) => {
    if (!point) { failures.push(`${label}: nothing to aim at`); return false; }
    await page.mouse.click(point.x, point.y);
    await settle();
    return true;
  };
  const clickCell = async (n, where = "end") =>
    clickAt(await page.evaluate((i, w) => window.checkbox.cellPoint(i, w), n, where), `cell ${n}`);
  const clickBox = async (n) =>
    clickAt(await page.evaluate((i) => window.checkbox.boxPoint(i), n), `box ${n}`);

  /**
   * The slash menu, driven the way a person drives it: type the query, wait for
   * the rows to settle, then press the row. `getItems` is async, so the rows
   * arrive a tick after the keystrokes.
   */
  const openSlash = async (query) => {
    await page.keyboard.type(`/${query}`);
    await page.waitForFunction(() => window.checkbox.slashOpen(), { timeout: 4000 });
    await settle();
    return page.evaluate(() => window.checkbox.slashRows());
  };
  const pickSlash = async (title) => {
    const point = await page.evaluate((t) => window.checkbox.clickSlashRow(t), title);
    if (!point) { failures.push(`slash row "${title}" was not offered`); return false; }
    await page.mouse.click(point.x, point.y);
    // Waited out rather than counted in frames: the menu covers the lines under
    // the caret while it is up, and a click aimed at one of them lands on the
    // menu instead — which is also true of a person, who waits for it to go.
    await page.waitForFunction(() => !window.checkbox.slashOpen(), { timeout: 4000 });
    await settle();
    return true;
  };
  const insertViaSlash = async (query, title = "Checkbox") => {
    const offered = await openSlash(query);
    if (!offered.includes(title)) { failures.push(`"/${query}" did not offer "${title}" (offered ${JSON.stringify(offered)})`); return false; }
    return pickSlash(title);
  };

  // =====================================================================
  section("The reporter's tracker: a box a cell can hold");
  // =====================================================================
  check("the tracker starts with no box anywhere", await boxes(), []);
  check("its cells are empty, which is all they could be before", await grid(), [
    ["Day", "Water", "Read"],
    ["1", "", ""],
    ["2", "", ""],
  ]);

  // Day 1's Water cell. Row 1 is the header, so cell 4 is row 2 column 2.
  await clickCell(4);
  check("the caret is in the table", (await caret()).type, "table");
  await insertViaSlash("check");
  check("a real box is now in the table", await boxes(), [{ checked: false, disabled: false, inTable: true }]);
  check("and it is in Day 1's Water cell", await grid(), [
    ["Day", "Water", "Read"],
    ["1", "[ ] ", ""],
    ["2", "", ""],
  ]);

  await clickBox(0);
  check("a press ticks it", (await boxes())[0].checked, true);
  check("and the document records the tick", (await grid())[1][1], "[x] ");
  await clickBox(0);
  check("a second press unticks it", (await boxes())[0].checked, false);
  check("and the document records that too", (await grid())[1][1], "[ ] ");

  // =====================================================================
  section("Every way a person reaches the box");
  // =====================================================================
  await mountTracker();
  await clickCell(4);
  const words = ["checkbox", "check", "tick", "task", "box"];
  for (const word of words) {
    const offered = await openSlash(word);
    check(`"/${word}" offers Checkbox`, offered.includes("Checkbox"), true);
    await page.keyboard.press("Escape");
    for (let i = 0; i < word.length + 1; i++) await page.keyboard.press("Backspace");
    await settle();
  }
  // The tie rule: both answer to "todo", and the earlier item wins.
  const todo = await openSlash("todo");
  check('"/todo" still reaches the To-do list first', todo.indexOf("To-do list") < todo.indexOf("Checkbox"), true);
  check('…and still offers Checkbox below it', todo.includes("Checkbox"), true);
  await page.keyboard.press("Escape");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Backspace");
  await settle();
  check("the query left nothing behind in the cell", (await grid())[1][1], "");

  // =====================================================================
  section("Anywhere inline content lives");
  // =====================================================================
  await page.evaluate(() => window.checkbox.mount([
    { type: "paragraph", content: "Ship " },
    { type: "heading", props: { level: 2 }, content: "Done " },
    { type: "quote", content: "Agreed " },
    { type: "bulletListItem", content: "Item " },
    { type: "checkListItem", content: "Task " },
  ]));
  await settle();
  // The five mounted blocks; the sixth is the trailing paragraph every page
  // ends in, which is not one of the kinds under test.
  const ids = (await page.evaluate(() => window.checkbox.ids())).slice(0, 5);
  for (const [n, id] of ids.entries()) {
    await clickAt(await page.evaluate((i) => window.checkbox.blockPoint(i), id), `block ${id}`);
    check(`the caret reaches block ${n + 1}`, (await caret()).id, id);
    if (!(await insertViaSlash("checkbox"))) break;
    check(`a box goes into block ${n + 1}`, (await boxes()).length, n + 1);
  }
  check("one box per line, and the list item's own marker is untouched", await rows(), [
    "paragraph: Ship [ ] ",
    "heading: Done [ ] ",
    "quote: Agreed [ ] ",
    "bulletListItem: Item [ ] ",
    "checkListItem: Task [ ] ",
    // The trailing paragraph every page ends in.
    "paragraph: ",
  ]);
  check("five inline boxes, one per line", (await boxes()).length, 5);
  // The to-do item's own marker is a separate box drawn in the gutter; the
  // inline one must not have replaced it or been mistaken for it.
  check("and the to-do item still draws its own marker beside them", await page.evaluate(() => window.checkbox.allBoxes()), 6);

  // =====================================================================
  section("One box moves, the others do not");
  // =====================================================================
  await mountTracker();
  for (const n of [4, 5, 7]) {
    await clickCell(n);
    if (!(await insertViaSlash("checkbox"))) break;
  }
  check("three boxes, one per cell", (await boxes()).map((b) => b.checked), [false, false, false]);
  await clickBox(1);
  check("ticking the middle one ticks only it", (await boxes()).map((b) => b.checked), [false, true, false]);
  check("and the grid says the same", await grid(), [
    ["Day", "Water", "Read"],
    ["1", "[ ] ", "[x] "],
    ["2", "[ ] ", ""],
  ]);

  // =====================================================================
  section("The caret keeps working around a box");
  // =====================================================================
  await mountTracker();
  await clickCell(4);
  await insertViaSlash("checkbox");
  await page.keyboard.type("1 gal");
  await settle();
  check("typing after the box lands after it", (await grid())[1][1], "[ ] 1 gal");
  for (let i = 0; i < 6; i++) await page.keyboard.press("Backspace");
  await settle();
  check("Backspace eats the words back to the box", (await grid())[1][1], "[ ]");
  await page.keyboard.press("Backspace");
  await settle();
  check("one more Backspace takes the box itself", (await grid())[1][1], "");
  check("and it is gone from the page", await boxes(), []);

  // =====================================================================
  section("Undo and redo");
  // =====================================================================
  await mountTracker();
  await clickCell(4);
  await insertViaSlash("checkbox");
  await new Promise((r) => setTimeout(r, HISTORY_GROUP_MS));
  await clickBox(0);
  check("the box is ticked", (await grid())[1][1], "[x] ");
  await page.evaluate(() => window.checkbox.undo());
  await settle();
  check("undo takes the tick back, not the box", (await grid())[1][1], "[ ] ");
  await page.evaluate(() => window.checkbox.redo());
  await settle();
  check("redo puts the tick back", (await grid())[1][1], "[x] ");
  await page.evaluate(() => window.checkbox.undo());
  await page.evaluate(() => window.checkbox.undo());
  await settle();
  check("undoing again takes the box out of the cell", (await grid())[1][1], "");

  // =====================================================================
  section("The keyboard, because the box is a real control");
  // =====================================================================
  await mountTracker();
  await clickCell(4);
  await insertViaSlash("checkbox");
  check("the box takes focus", await page.evaluate(() => window.checkbox.focusBox(0)), true);
  await page.keyboard.press("Space");
  await settle();
  check("Space ticks it", (await grid())[1][1], "[x] ");
  await page.keyboard.press("Space");
  await settle();
  check("Space unticks it", (await grid())[1][1], "[ ] ");

  // =====================================================================
  section("A viewer on the share route");
  // =====================================================================
  await mountTracker();
  await clickCell(4);
  await insertViaSlash("checkbox");
  await clickBox(0);
  const ticked = await page.evaluate(() => window.checkbox.blocks());
  await page.evaluate((blocks) => window.checkbox.mount(blocks, { readOnly: true }), ticked);
  await settle();
  check("a viewer sees the box, and its state", (await boxes())[0], { checked: true, disabled: true, inTable: true });
  await clickBox(0);
  check("pressing it changes nothing", (await boxes())[0].checked, true);
  check("and the document is untouched", (await grid())[1][1], "[x] ");

  // =====================================================================
  section("Two people, one document");
  // =====================================================================
  await page.evaluate(() => window.checkbox.mountCollaborative([
    { type: "paragraph", content: "Tracker" },
    { type: "table", content: { type: "tableContent", headerRows: 1, rows: [
      { cells: [{ type: "tableCell", content: [{ type: "text", text: "Day", styles: {} }] }, { type: "tableCell", content: [] }] },
      { cells: [{ type: "tableCell", content: [{ type: "text", text: "1", styles: {} }] }, { type: "tableCell", content: [] }] },
    ] } },
  ]));
  await settle();
  await page.waitForSelector(".bn-editor table");
  await clickCell(3);
  await insertViaSlash("checkbox");
  await page.waitForFunction(() => window.checkbox.peerBoxes().length === 1, { timeout: 4000 }).catch(() => {});
  check("the box reaches the other person", await page.evaluate(() => window.checkbox.peerBoxes()), [false]);
  await clickBox(0);
  await page.waitForFunction(() => window.checkbox.peerBoxes()[0] === true, { timeout: 4000 }).catch(() => {});
  check("so does the tick", await page.evaluate(() => window.checkbox.peerBoxes()), [true]);

  // =====================================================================
  section("An agent's tick, under review");
  // =====================================================================
  await mountTracker();
  await clickCell(4);
  await insertViaSlash("checkbox");
  await clickBox(0);
  await settle();
  // The checkpoint had the box unticked; the page has it ticked. Nothing else
  // in the cell changed, so a text-only diff would draw nothing at all.
  await page.evaluate(() => {
    const table = window.checkbox.blocks().find((b) => b.type === "table");
    window.checkbox.review(table.id, window.checkbox.tableCheckpoint([
      ["Day", "Water", "Read"],
      ["1", "[ ] ", ""],
      ["2", "", ""],
    ]));
  });
  await settle();
  const marks = await page.evaluate(() => window.checkbox.marks());
  check("the box that was there is struck where it stood", marks.removed, ["☐"]);
  check("and the box that replaced it is washed as the addition", marks.boxAdded, true);
  check("the table is not washed whole instead", marks.washed, 0);
  check("and nothing else in the grid is marked", marks.added.length, 1);
  await page.evaluate(() => window.checkbox.review("", null));
  await settle();
  check("clearing the review clears the marks", (await page.evaluate(() => window.checkbox.marks())).removed, []);

  // =====================================================================
  section("How it sits on the line");
  // =====================================================================
  await mountTracker();
  await clickCell(4);
  await insertViaSlash("checkbox");
  check("the box sits inside its cell's line, centred on it", await page.evaluate(() => window.checkbox.boxAlignment(0)), {
    centredWithin: true,
    insideLine: true,
  });
  await page.evaluate(() => window.checkbox.mount([{ type: "paragraph", content: "Read 10 pages " }]));
  await settle();
  await clickAt(await page.evaluate(() => window.checkbox.blockPoint(window.checkbox.ids()[0])), "paragraph");
  await insertViaSlash("checkbox");
  check("and inside a line of prose too", await page.evaluate(() => window.checkbox.boxAlignment(0)), {
    centredWithin: true,
    insideLine: true,
  });

  if (process.env.NT41_SHOT) {
    await mountTracker();
    for (const n of [4, 5, 7, 8]) { await clickCell(n); await insertViaSlash("checkbox"); }
    await clickBox(0);
    await clickBox(1);
    await settle();
    await page.screenshot({ path: process.env.NT41_SHOT });
    console.log(`\n  screenshot → ${process.env.NT41_SHOT}`);
  }
} finally {
  await browser?.close();
  server.close();
}

console.log("");
if (failures.length) {
  console.log(`${failures.length} failure(s):\n`);
  for (const failure of failures) console.log(`  ${failure}\n`);
  process.exit(1);
}
console.log("all checks passed");
