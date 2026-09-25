/**
 * The seam between a page's title and its document, the table keys, and the
 * page-link menus, driven through real Chromium keyboard and mouse input — the
 * Notion behaviours `titleBoundary.ts`, `tableKeys.ts` and `pageLinkTrigger.ts`
 * exist for.
 *
 * No app server, no Convex, no API keys: every non-local request fails the
 * run, so no AI lane can be spent by typing in here.
 *
 *   node tests/editor-title-table-menus.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "editor-title-table-menus-"));

await build({
  absWorkingDir: repo,
  entryPoints: ["tests/editor-title-table-menus.browser.tsx"],
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

await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/editor-title-table-menus.browser.css"><style>html,body{margin:0;height:100%;overflow:hidden;font-family:Arial,sans-serif}</style></head><body><div id="app"></div><script type="module" src="/editor-title-table-menus.browser.js"></script></body></html>`);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      failures.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  await page.route("**/*", async (route) => {
    if (route.request().url().startsWith(origin)) return route.continue();
    failures.push(`request left the fixture: ${route.request().url()}`);
    return route.abort();
  });
  await page.goto(origin, { waitUntil: "networkidle" });
  const h = (fn, ...args) => page.evaluate(fn, ...args);
  const frame = () => h(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const settle = async () => { await frame(); await sleep(60); };
  const mount = async (blocks, title = "") => {
    await h(([b, t]) => window.seam.mount(b, t), [blocks, title]);
    await page.waitForSelector(".bn-editor");
    await settle();
  };
  const blocks = () => h(() => window.seam.blocks());
  const focus = () => h(() => window.seam.focus());
  const menu = () => h(() => window.seam.menu());
  const clickTitle = async (offset) => {
    const p = await h((o) => window.seam.titlePoint(o), offset);
    await page.mouse.click(p.x, p.y);
    await settle();
  };
  const clickBlock = async (index, where) => {
    const p = await h(([i, w]) => window.seam.blockPoint(i, w), [index, where]);
    await page.mouse.click(p.x, p.y);
    await settle();
  };
  const press = async (key) => { await page.keyboard.press(key); await settle(); };

  console.log("\nTitle — Enter");
  await mount([{ type: "heading", props: { level: 2 }, content: "Existing" }], "Launch plan");
  await clickTitle(11);
  check("the caret starts at the end of the title", await focus(), { where: "title", offset: 11 });
  await press("Enter");
  check("Enter at the end opens a new first paragraph", (await blocks()).map((b) => [b.type, b.content]), [["paragraph", ""], ["heading", "Existing"], ["paragraph", ""]]);
  check("and the caret is in it", await focus(), { where: "editor", block: 0, offset: 0, text: "" });
  check("the title is untouched", [await h(() => window.seam.titleText()), await h(() => window.seam.persisted())], ["Launch plan", []]);

  await mount([{ type: "paragraph", content: "Body" }], "Launch plan");
  await clickTitle(7);
  await press("Enter");
  check("Enter mid-title carries the rest into the new first block", (await blocks()).map((b) => b.content), ["plan", "Body", ""]);
  check("the title keeps what came before the caret", [await h(() => window.seam.titleText()), await h(() => window.seam.persisted())], ["Launch ", ["Launch "]]);
  check("the caret starts the carried text", await focus(), { where: "editor", block: 0, offset: 0, text: "plan" });

  await mount([{ type: "paragraph" }], "Fresh");
  await clickTitle(5);
  await press("Enter");
  check("on an empty page Enter lands in the page's one line", [(await blocks()).length, await focus()], [1, { where: "editor", block: 0, offset: 0, text: "" }]);

  console.log("\nTitle — arrows");
  await mount([{ type: "paragraph", content: "First line of the body" }, { type: "paragraph", content: "Second" }], "Title");
  await clickTitle(2);
  await press("ArrowDown");
  const down = await focus();
  check("ArrowDown from the title reaches the first block", [down.where, down.block], ["editor", 0]);
  check("near the same column", down.offset >= 1 && down.offset <= 4, true);
  await clickBlock(0, "end");
  await press("ArrowUp");
  check("ArrowUp from the first block's first line reaches the title", (await focus()).where, "title");
  await clickBlock(0, "end");
  await page.keyboard.type(" /");
  await settle();
  await press("ArrowUp");
  check("an open menu keeps ArrowUp", [(await focus()).where, (await menu()).length > 0], ["editor", true]);
  await press("Escape");
  await clickBlock(1, "end");
  await press("ArrowUp");
  const up = await focus();
  check("ArrowUp from a lower block stays in the document", [up.where, up.block], ["editor", 0]);

  console.log("\nTitle — Backspace");
  await mount([{ type: "paragraph" }, { type: "paragraph", content: "Body" }], "Title");
  await clickBlock(0, "start");
  await press("Backspace");
  check("Backspace in an empty first block removes it", (await blocks()).map((b) => b.content), ["Body", ""]);
  check("and the caret goes to the end of the title", await focus(), { where: "title", offset: 5 });
  await mount([{ type: "paragraph", content: "Body" }], "Title");
  await clickBlock(0, "start");
  await press("Backspace");
  check("a written first block is left alone", [(await blocks()).map((b) => b.content), (await focus()).where], [["Body", ""], "editor"]);

  console.log("\nTables");
  const table = { type: "table", content: { type: "tableContent", rows: [{ cells: ["a", "b"] }, { cells: ["c", "d"] }] } };
  await mount([table, { type: "paragraph", content: "After" }], "T");
  await h(() => window.seam.caretInCell("d"));
  await settle();
  await press("Tab");
  check("Tab in the last cell appends a row", (await blocks())[0].content, [["a", "b"], ["c", "d"], ["", ""]]);
  check("and starts it", await h(() => window.seam.cell()), { row: 2, col: 0, text: "", offset: 0 });
  await page.keyboard.type("e");
  await settle();
  check("typing lands in the new row", (await blocks())[0].content[2], ["e", ""]);
  await clickBlock(1, "start");
  await press("Backspace");
  check("Backspace at the start of the line below a table enters its last cell", await h(() => window.seam.cell()), { row: 2, col: 1, text: "", offset: 0 });
  check("without changing the document", (await blocks())[1].content, "After");

  console.log("\nMenus");
  await mount([{ type: "paragraph", content: "See" }], "M");
  await clickBlock(0, "end");
  await page.keyboard.type(" [[");
  await settle();
  check("[[ mid-line opens the page menu", await menu(), ["Roadmap", "Hiring plan"]);
  await page.keyboard.type("hir");
  await settle();
  check("and filters it as you type", await menu(), ["Hiring plan"]);
  await press("Enter");
  check("picking a page swaps [[ and the query for a page chip", (await blocks())[0].content, "See <pageMention:page-hiring> ");

  await mount([{ type: "paragraph" }], "M");
  await clickBlock(0, "start");
  await page.keyboard.type("/heading 4");
  await settle();
  check("the slash menu offers Heading 4", (await menu()).includes("Heading 4"), true);
  await press("Enter");
  const h4 = (await blocks())[0];
  check("which makes a level-4 heading", [h4.type, h4.level], ["heading", 4]);

  await mount([{ type: "paragraph" }], "M");
  await clickBlock(0, "start");
  await page.keyboard.type("/link to");
  await settle();
  check("the slash menu offers Link to page", await menu(), ["Link to page"]);
  await press("Enter");
  // The slash menu fades out as the page menu opens; what is asked is what
  // stays once it has gone.
  await page.waitForFunction(() => window.seam.menu().length === 2, null, { timeout: 1000 }).catch(() => {});
  check("which opens the page list", await menu(), ["Roadmap", "Hiring plan"]);
  await press("Enter");
  check("and inserts the chip, leaving no trigger text behind", (await blocks())[0].content, "<pageMention:page-roadmap> ");

  if (failures.length) throw new Error(`\n${failures.join("\n\n")}`);
  console.log("\nAll title, table and menu browser checks passed.");
} finally {
  await browser?.close();
  server.close();
}
