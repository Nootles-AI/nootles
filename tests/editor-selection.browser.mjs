/**
 * Selecting in the document, driven through real Chromium mouse and keyboard
 * input.
 *
 * NT-18: a drag through text that crossed into the next block was taken away
 * from the person making it. On mouseup the editor promoted any text selection
 * spanning two blocks into a whole-block selection, so the words they had
 * dragged over became plates over entire blocks — and typing, deleting,
 * bolding or copying then acted on every block touched, not on the text.
 *
 * Removing that exposed what it had been covering: a band pressed in the room
 * right of a short line ran alongside the browser's own text selection from the
 * same press, and the gesture ended as whichever wrote last. A block of text
 * now owns every press across its width (`useBlockMarquee`'s `inTextBlock`).
 *
 * The editor is composed the way `useYjsEditor` composes it, inside the
 * wrapper `EditorSurface` renders, with the band gesture mounted.
 *
 * Uses the existing esbuild dependency and an operator-installed Puppeteer. No
 * app server, no Convex, no API keys — and every non-local request fails the
 * run, so no AI lane can be spent in here.
 *
 *   NML_PUPPETEER_MODULE=/absolute/path/to/puppeteer/lib/esm/puppeteer/puppeteer.js \
 *     node tests/editor-selection.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "editor-selection-"));
const { default: puppeteer } = await import(process.env.NML_PUPPETEER_MODULE || "puppeteer");

await build({
  absWorkingDir: repo, entryPoints: ["tests/editor-selection.browser.tsx"], bundle: true, splitting: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [{ name: "reject-next-server-diagnostics", setup(builder) {
    builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({ path: "server-only", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };' }));
  } }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
});
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/editor-selection.browser.css"><style>html,body{margin:0;height:100%;overflow:hidden;font-family:Arial,sans-serif}</style></head><body><div id="app"></div><script type="module" src="/editor-selection.browser.js"></script></body></html>`);

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

// The reporter's window.
const VIEWPORT = { width: 1470, height: 835 };
const MOD = process.platform === "darwin" ? "Meta" : "Control";

// Shaped like the reported page: numbered steps with bold lead-ins and a link,
// a nested item, an italic note, a divider, then plain paragraphs.
const DOC = [
  { type: "heading", props: { level: 2 }, content: "Claiming the SR&ED tax incentive" },
  { type: "paragraph", content: "The incentive is not available merely because a business spends money on product development." },
  { type: "numberedListItem", content: [
    { type: "text", text: "Link the benefit to eligible work.", styles: { bold: true } },
    { type: "text", text: " The claimant must establish that its work meets the definition.", styles: {} },
  ] },
  { type: "numberedListItem", content: [
    { type: "text", text: "Consider pre-claim approval.", styles: { bold: true } },
    { type: "text", text: " A business may ask CRA to assess up to ", styles: {} },
    { type: "link", href: "https://example.invalid/", content: "three proposed projects" },
    { type: "text", text: " before it starts.", styles: {} },
  ] },
  { type: "numberedListItem", content: "Account for other government assistance.", children: [
    { type: "bulletListItem", content: "Funding such as NRC IRAP reduces allowable expenditures." },
  ] },
  { type: "paragraph", content: [{ type: "text", text: "Note: other funding will not prevent your work from being eligible.", styles: { italic: true } }] },
  { type: "divider" },
  { type: "paragraph", content: "Source: CRA, What are SR&ED tax incentives?" },
  { type: "paragraph", content: "Short last line." },
];
// Indexes into the page in reading order, children after their parent; 7 is the
// divider, which nothing needs by name.
const HEADING = 0, INTRO = 1, STEP1 = 2, STEP2 = 3, STEP3 = 4, NESTED = 5, NOTE = 6, SOURCE = 8, LAST = 9;
const BLOCKS = 10;
const TOP_LEVEL = 9;

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

  await page.goto(origin, { waitUntil: "networkidle0" });
  const h = (fn, ...args) => page.evaluate(fn, ...args);
  const selection = () => h(() => window.selectionHarness.selection());
  const plates = () => h(() => window.selectionHarness.plates());
  const selectedIds = () => h(() => window.selectionHarness.selectedIds());
  const texts = () => h(() => window.selectionHarness.texts());

  let T = [];
  const fresh = async () => {
    await h(() => window.selectionHarness.mount());
    await page.waitForSelector(".bn-editor");
    await h((blocks) => window.selectionHarness.seed(blocks), DOC);
    await page.waitForFunction((count) => window.selectionHarness.count() === count && window.selectionHarness.textPoint(count - 1, 0) !== null, {}, BLOCKS);
    await sleep(100);
    T = await texts();
  };
  const point = (index, offset) => h((i, o) => window.selectionHarness.textPoint(i, o), index, offset);
  /**
   * Press, travel, release — then wait well past the frame after mouseup,
   * which is when anything that rewrites a finished selection would act.
   */
  const dragBetween = async (a, b) => {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 12 });
    await page.mouse.up();
    await sleep(250);
  };
  const drag = async ([fromBlock, fromOffset], [toBlock, toOffset]) =>
    dragBetween(await point(fromBlock, fromOffset), await point(toBlock, toOffset));
  const clickText = async (index, offset) => {
    const p = await point(index, offset);
    await page.mouse.click(p.x, p.y);
    await sleep(150);
  };
  const chord = async (key, options) => {
    await page.keyboard.down(MOD);
    await page.keyboard.press(key, options);
    await page.keyboard.up(MOD);
    await sleep(150);
  };

  // ---------------------------------------------------------------- NT-18 ---
  console.log("\nNT-18 — a drag through text that crosses blocks selects text");

  await fresh();
  await drag([INTRO, 4], [STEP1, 20]);
  let s = await selection();
  check("a drag from a paragraph into a list item is a text selection", [s.kind, s.blockRange], ["text", false]);
  check("…of exactly the characters dragged over", s.text, `${T[INTRO].slice(4)}\n${T[STEP1].slice(0, 20)}`);
  check("…drawn by the browser's own highlight", [s.hidden, (await h(() => window.selectionHarness.nativeText())).includes(T[INTRO].slice(4, 40))], [false, true]);
  check("…with no block plated", await plates(), 0);
  check("…and nothing in the block-selection store", await selectedIds(), []);
  check("…and the formatting toolbar offered for it", await h(() => window.selectionHarness.toolbarShown()), true);

  await fresh();
  await drag([STEP3, 12], [STEP1, 6]);
  s = await selection();
  check("a drag upwards across three blocks is a text selection", [s.kind, s.anchor > s.head], ["text", true]);
  check("…of exactly the characters dragged over, through a link", s.text, `${T[STEP1].slice(6)}\n${T[STEP2]}\n${T[STEP3].slice(0, 12)}`);
  check("…with no block plated", await plates(), 0);

  await fresh();
  await drag([STEP3, 8], [NESTED, 10]);
  s = await selection();
  check("a drag from a list item into its nested child is a text selection", s.kind, "text");
  check("…of exactly the characters dragged over", s.text, `${T[STEP3].slice(8)}\n${T[NESTED].slice(0, 10)}`);

  await fresh();
  await drag([NOTE, 5], [SOURCE, 10]);
  s = await selection();
  check("a drag across a divider is a text selection", s.kind, "text");
  check("…of exactly the characters dragged over", s.text, `${T[NOTE].slice(5)}\n${T[SOURCE].slice(0, 10)}`);
  check("…with no block plated", await plates(), 0);

  await fresh();
  {
    const from = await point(SOURCE, 7);
    const below = await h((i) => window.selectionHarness.blockRect(i), LAST);
    await dragBetween(from, { x: from.x + 40, y: below.bottom + 60 });
  }
  s = await selection();
  check("a drag from text into the empty page below is a text selection", s.kind, "text");
  check("…running to the end of the last line", s.text, `${T[SOURCE].slice(7)}\n${T[LAST]}`);

  await fresh();
  await clickText(INTRO, 10);
  {
    const p = await point(STEP2, 15);
    await page.keyboard.down("Shift");
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up("Shift");
    await sleep(250);
  }
  s = await selection();
  check("shift-click into a later block extends a text selection", s.kind, "text");
  check("…of exactly the characters between", s.text, `${T[INTRO].slice(10)}\n${T[STEP1]}\n${T[STEP2].slice(0, 15)}`);
  check("…with no block plated", await plates(), 0);

  /**
   * From the empty room right of block `index`'s last line to the height of
   * `to` — where a selection "from the end of this line" starts. A band used to
   * start there too and fight it, so the pointer is sampled halfway.
   */
  const fromLineEnd = async (index, to) => {
    const start = await h((i) => window.selectionHarness.pastLineEnd(i, 120), index);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, (start.y + to.y) / 2, { steps: 6 });
    const banded = await h(() => window.selectionHarness.bandShown());
    await page.mouse.move(start.x, to.y, { steps: 6 });
    await page.mouse.up();
    await sleep(250);
    return banded;
  };

  await fresh();
  let banded = await fromLineEnd(STEP3, await point(NOTE, 0));
  s = await selection();
  check("a drag down from the room right of a short line draws no band", banded, false);
  check("…and is a text selection from the end of that line", [s.kind, s.text.startsWith(`\n${T[NESTED]}\n`)], ["text", true]);
  check("…with no block plated", await plates(), 0);

  await fresh();
  banded = await fromLineEnd(LAST, await point(SOURCE, 0));
  s = await selection();
  check("a drag up from the room right of the last line draws no band", banded, false);
  check("…and is a text selection to the end of that line", [s.kind, s.text.endsWith(`\n${T[LAST]}`)], ["text", true]);
  check("…with no block plated", await plates(), 0);

  console.log("\nWhat comes next acts on that text, not on the blocks around it");

  await fresh();
  await drag([INTRO, 4], [STEP1, 20]);
  await page.keyboard.type("X");
  await sleep(150);
  check("typing replaces just the selected text, joining the two blocks",
    [(await texts())[INTRO], await h(() => window.selectionHarness.count())],
    [`${T[INTRO].slice(0, 4)}X${T[STEP1].slice(20)}`, BLOCKS - 1]);
  check("…and the heading above is untouched", (await texts())[HEADING], T[HEADING]);

  await fresh();
  await drag([INTRO, 4], [STEP1, 20]);
  await page.keyboard.press("Backspace");
  await sleep(150);
  check("Backspace deletes just the selected text",
    [(await texts())[INTRO], await h(() => window.selectionHarness.count())],
    [`${T[INTRO].slice(0, 4)}${T[STEP1].slice(20)}`, BLOCKS - 1]);

  await fresh();
  await drag([SOURCE, 8], [LAST, 5]);
  await chord("KeyB");
  check("bold covers just the selected text in the first block",
    await h((i) => window.selectionHarness.boldRuns(i), SOURCE),
    [{ text: T[SOURCE].slice(0, 8), bold: false }, { text: T[SOURCE].slice(8), bold: true }]);
  check("…and in the second",
    await h((i) => window.selectionHarness.boldRuns(i), LAST),
    [{ text: T[LAST].slice(0, 5), bold: true }, { text: T[LAST].slice(5), bold: false }]);

  await fresh();
  await drag([INTRO, 4], [STEP1, 20]);
  await h(() => window.selectionHarness.takeCopied());
  await chord("KeyC", { commands: ["Copy"] });
  {
    const copied = await h(() => window.selectionHarness.takeCopied());
    check("copy carries the selected text", copied !== null && copied.includes(T[INTRO].slice(5, 40)), true);
    check("…and not the start of the block it began in", copied !== null && !copied.includes(T[INTRO].slice(0, 12)), true);
    check("…nor the end of the block it ended in", copied !== null && !copied.includes(T[STEP1].slice(25)), true);
  }

  // ------------------------------------------------- what stays the same ---
  console.log("\nText selection that must keep working");

  await fresh();
  await drag([INTRO, 4], [INTRO, 40]);
  s = await selection();
  check("a drag inside one block selects text", [s.kind, s.text], ["text", T[INTRO].slice(4, 40)]);

  await fresh();
  await clickText(INTRO, 5);
  await page.keyboard.down("Shift");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.up("Shift");
  await sleep(250);
  s = await selection();
  check("Shift+ArrowDown across blocks selects text", [s.kind, s.empty, await plates()], ["text", false, 0]);

  console.log("\nBlock selection is still its own gesture");

  await fresh();
  let ids = await h(() => window.selectionHarness.ids());
  await dragBetween(await h((i) => window.selectionHarness.gutterPoint(i), INTRO), await h((i) => window.selectionHarness.gutterPoint(i), STEP2));
  s = await selection();
  check("a band drawn down the gutter selects whole blocks", [s.blockRange, await selectedIds()], [true, [ids[INTRO], ids[STEP1], ids[STEP2]]]);
  check("…and plates each of them", await plates(), 3);
  await page.keyboard.press("Backspace");
  await sleep(150);
  check("Backspace deletes those whole blocks", [await h(() => window.selectionHarness.count()), (await texts())[INTRO]], [BLOCKS - 3, T[STEP3]]);

  await fresh();
  ids = await h(() => window.selectionHarness.ids());
  {
    const last = await h((i) => window.selectionHarness.blockRect(i), LAST);
    const source = await h((i) => window.selectionHarness.blockRect(i), SOURCE);
    await dragBetween({ x: last.left + 40, y: last.bottom + 80 }, { x: last.left + 40, y: (source.top + source.bottom) / 2 });
  }
  s = await selection();
  check("a band from the empty page below the last block selects whole blocks", [s.blockRange, await selectedIds()], [true, [ids[SOURCE], ids[LAST]]]);
  await page.keyboard.press("Escape");
  await sleep(150);
  s = await selection();
  check("Escape lets go of it", [s.blockRange, await plates()], [false, 0]);

  await fresh();
  await dragBetween(await h((i) => window.selectionHarness.gutterPoint(i), INTRO), await h((i) => window.selectionHarness.gutterPoint(i), STEP2));
  await clickText(SOURCE, 3);
  s = await selection();
  check("a click on text after a band puts the caret there", [s.kind, s.empty, await plates()], ["text", true, 0]);

  await fresh();
  await clickText(INTRO, 5);
  await chord("KeyA");
  s = await selection();
  check("the first Mod-A takes the block's text", [s.kind, s.text], ["text", T[INTRO]]);
  await chord("KeyA");
  check("the second takes every block", [(await selection()).blockRange, (await selectedIds()).length], [true, TOP_LEVEL]);

  await fresh();
  await drag([INTRO, 4], [STEP1, 20]);
  await chord("KeyA");
  check("Mod-A on a text selection across blocks takes every block at once", [(await selection()).blockRange, (await selectedIds()).length], [true, TOP_LEVEL]);
} finally {
  await browser?.close();
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
