/**
 * The markdown block-type shortcuts, driven through real Chromium mouse and
 * keyboard input.
 *
 * NT-38: `# ` typed at the start of a numbered list item used to convert the
 * item to an `<h1>`. That broke the list in two and restarted the numbering of
 * everything after it, so writing "# of attendees" as item 2 of 5 silently
 * renumbered items 3-5. BlockNote already declines the reverse (`- ` and `1. `
 * inside a heading stay as text); `app/components/editor/blocks/HeadingBlock.ts`
 * gives the `#` rules the mirror of that check.
 *
 * Uses the existing esbuild dependency and an operator-installed Puppeteer. No
 * app server, no Convex, no API keys — and every non-local request fails the
 * run, so no AI lane can be spent by typing in here.
 *
 *   NML_PUPPETEER_MODULE=/absolute/path/to/puppeteer/lib/esm/puppeteer/puppeteer.js \
 *     node tests/editor-markdown.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "editor-markdown-"));
const { default: puppeteer } = await import(process.env.NML_PUPPETEER_MODULE || "puppeteer");

await build({
  absWorkingDir: repo, entryPoints: ["tests/editor-markdown.browser.tsx"], bundle: true, splitting: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [{ name: "reject-next-server-diagnostics", setup(builder) {
    builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({ path: "server-only", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };' }));
  } }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
});
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/editor-markdown.browser.css"><style>body{margin:24px;font-family:Arial,sans-serif}</style></head><body><div id="app"></div><script type="module" src="/editor-markdown.browser.js"></script></body></html>`);

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

const LIST_TYPES = ["numberedListItem", "bulletListItem", "checkListItem", "toggleListItem"];
// Every markdown prefix that converts a block to one a list item cannot be.
const GUARDED = [
  { prefix: "# ", becomes: "heading", level: 1 },
  { prefix: "## ", becomes: "heading", level: 2 },
  { prefix: "### ", becomes: "heading", level: 3 },
  { prefix: "#### ", becomes: "heading", level: 4 },
  { prefix: "##### ", becomes: "heading", level: 5 },
  { prefix: "###### ", becomes: "heading", level: 6 },
  { prefix: "> ", becomes: "quote" },
  { prefix: '" ', becomes: "quote" },
];

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

  /**
   * Mount a document, then click into block `index` and put the caret at one end.
   *
   * The caret is verified rather than assumed: a click that misses leaves the
   * selection at the top of the document, and every assertion after it would
   * quietly be about the wrong block.
   */
  const open = async (blocks, index, where = "start") => {
    await page.evaluate((content) => window.h.mount(content), blocks);
    await page.waitForFunction((count) => window.h.document().length === count, {}, blocks.length);
    await page.waitForFunction((i) => window.h.textPoint(i) !== null, {}, index);
    // A fresh mount settles its own selection a frame or two after the nodes
    // exist, and it wins any click that lands first.
    let landed = -1;
    for (let attempt = 0; attempt < 5 && landed !== index; attempt++) {
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      const point = await page.evaluate((i) => window.h.textPoint(i), index);
      await page.mouse.click(point.x, point.y);
      await page.keyboard.press(where === "start" ? "Home" : "End");
      landed = await page.evaluate(() => window.h.caretIndex());
    }
    if (landed !== index) throw new Error(`caret landed in block ${landed}, wanted ${index}`);
  };
  const doc = () => page.evaluate(() => window.h.document());
  const typeOf = async (index) => (await doc())[index].type;
  const textOf = async (index) => (await doc())[index].text;

  const threeItems = (type) => [
    { type, content: "First" },
    { type, content: "Second" },
    { type, content: "Third" },
  ];

  // ---------------------------------------------------------------- NT-38 ---
  console.log("\nNT-38 — a block-type prefix must not eat a list item");
  for (const type of LIST_TYPES) {
    for (const { prefix } of GUARDED) {
      await open(threeItems(type), 1);
      await page.keyboard.type(prefix);
      check(`${type} + ${JSON.stringify(prefix)} keeps the item`, await typeOf(1), type);
      check(`${type} + ${JSON.stringify(prefix)} keeps the characters`, await textOf(1), `${prefix}Second`);
    }
  }

  for (const prefix of ["# ", "> "]) {
    await open(threeItems("numberedListItem"), 1);
    await page.keyboard.type(prefix);
    check(`the list still reads 1. 2. 3. after ${JSON.stringify(prefix)}`,
      (await page.evaluate(() => window.h.ordinals())).map((row) => row.marker),
      ['"1."', '"2."', '"3."']);
  }

  await open(threeItems("numberedListItem"), 1);
  await page.keyboard.type("# ");
  check("the caret stays in the list item", await page.evaluate(() => window.h.caretBlockType()), "numberedListItem");

  await page.evaluate(() => window.h.undo());
  check("one undo takes the typed prefix back off", await doc(), [
    { id: (await doc())[0].id, type: "numberedListItem", text: "First" },
    { id: (await doc())[1].id, type: "numberedListItem", text: "Second" },
    { id: (await doc())[2].id, type: "numberedListItem", text: "Third" },
  ]);

  await open(
    [
      { type: "numberedListItem", content: "Parent", children: [{ type: "numberedListItem", content: "Kid" }] },
      { type: "numberedListItem", content: "After" },
    ],
    0,
  );
  await page.keyboard.type("# ");
  check("a parent item keeps its children", (await doc())[0].children?.map((child) => child.type), ["numberedListItem"]);

  await open(threeItems("numberedListItem"), 2, "end");
  await page.keyboard.press("Enter");
  await page.keyboard.type("# ");
  check("a fresh empty item is a list item too", await typeOf(3), "numberedListItem");

  // -------------------------------------------------- still a shortcut ---
  console.log("\nThe shortcuts themselves are untouched everywhere else");
  for (const { prefix, becomes, level } of GUARDED) {
    await open([{ type: "paragraph", content: "Plain" }], 0);
    await page.keyboard.type(prefix);
    check(`paragraph + ${JSON.stringify(prefix)} is a ${becomes}`, (await doc())[0], {
      id: (await doc())[0].id, type: becomes, ...(level ? { level } : {}), text: "Plain",
    });
  }

  await open([{ type: "quote", content: "Quoted" }], 0);
  await page.keyboard.type("# ");
  check("quote + '# ' is still a heading", await typeOf(0), "heading");

  await open([{ type: "heading", props: { level: 1 }, content: "Title" }], 0);
  await page.keyboard.type("> ");
  check("heading + '> ' is still a quote", await typeOf(0), "quote");

  await open(threeItems("numberedListItem"), 1, "end");
  await page.keyboard.type(" # x");
  check("a '#' mid-line was never a shortcut", await textOf(1), "Second # x");

  await open(threeItems("numberedListItem"), 1, "end");
  await page.keyboard.type(" > x");
  check("a '>' mid-line was never a shortcut", await textOf(1), "Second > x");

  // -------------------------------------------------- the way in stays ---
  console.log("\nThe deliberate routes from a list item to a heading still work");
  await open([{ type: "paragraph", content: "Plain" }], 0);
  await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
  await page.keyboard.down("Alt");
  await page.keyboard.press("1");
  await page.keyboard.up("Alt");
  await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
  check("Mod-Alt-1 converts a paragraph", await typeOf(0), "heading");

  await open(threeItems("numberedListItem"), 1);
  await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
  await page.keyboard.down("Alt");
  await page.keyboard.press("1");
  await page.keyboard.up("Alt");
  await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
  check("Mod-Alt-1 converts the item", await typeOf(1), "heading");

  await open(threeItems("numberedListItem"), 1);
  check("the block-type menu converts the item", await page.evaluate(() => window.h.convertToHeading(1)), ["numberedListItem", "heading", "numberedListItem"]);

  // ------------------------------------------- BlockNote's own guards ---
  console.log("\nBlockNote's own guards are unchanged");
  for (const prefix of ["- ", "1. ", "* ", "+ "]) {
    await open([{ type: "heading", props: { level: 1 }, content: "Title" }], 0);
    await page.keyboard.type(prefix);
    check(`heading + ${JSON.stringify(prefix)} stays a heading`, await typeOf(0), "heading");
    check(`heading + ${JSON.stringify(prefix)} keeps the characters`, await textOf(0), `${prefix}Title`);
  }

  await open([{ type: "paragraph", content: "Plain" }], 0);
  await page.keyboard.type("- ");
  check("paragraph + '- ' is still a bullet", await typeOf(0), "bulletListItem");
} finally {
  await browser?.close();
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
