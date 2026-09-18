/**
 * The document always owns one real empty paragraph after its authored
 * content. Exercises initial repair, every way the row can be consumed,
 * undo/redo, AI document-end placement, remote Yjs changes, and coexistence
 * with the page-below-last-block marquee gesture in real Chromium.
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "editor-trailing-paragraph-"));

await build({
  absWorkingDir: repo,
  entryPoints: ["tests/editor-trailing-paragraph.browser.tsx"],
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

await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/editor-trailing-paragraph.browser.css"><style>html,body{margin:0;height:100%;overflow:hidden;font-family:Arial,sans-serif}</style></head><body><div id="app"></div><script type="module" src="/editor-trailing-paragraph.browser.js"></script></body></html>`);

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
  const summary = () => h(() => window.trailingHarness.summary());
  const waitForTail = () => page.waitForFunction(() => window.trailingHarness.summary().realTail);

  console.log("\nTrailing paragraph — initial repair and direct editing");
  await h(() => window.trailingHarness.mountStatic([{ type: "heading", props: { level: 2 }, content: "Title" }]));
  await page.waitForSelector(".bn-editor");
  await waitForTail();
  let s = await summary();
  check("a materialized paragraph repairs an old document", [s.types, s.texts, s.realTail], [["heading", "paragraph"], ["Title", ""], true]);
  check("the fake BlockNote widget is unnecessary", [s.widgetCount, s.blockCount], [0, 2]);

  const point = await h(() => window.trailingHarness.tailPoint());
  await page.mouse.click(point.x, point.y);
  await page.keyboard.type("Typed by click");
  await sleep();
  s = await summary();
  check("clicking and typing consumes the row and creates its successor", [s.texts, s.realTail, s.band], [["Title", "Typed by click", ""], true, false]);

  await h(() => window.trailingHarness.undo());
  await sleep();
  s = await summary();
  check("one undo restores the prior row", [s.texts, s.realTail], [["Title", ""], true]);
  await h(() => window.trailingHarness.redo());
  await sleep();
  s = await summary();
  check("redo restores both content and its successor", [s.texts, s.realTail], [["Title", "Typed by click", ""], true]);

  const deleted = await h(() => window.trailingHarness.deleteTail());
  await sleep();
  s = await summary();
  check("deleting the row immediately replaces it", [s.realTail, s.ids.includes(deleted)], [true, false]);
  await h(() => window.trailingHarness.convertTail());
  await sleep();
  s = await summary();
  check("converting the row leaves another normal paragraph", [s.types.slice(-2), s.texts.slice(-2), s.realTail], [["heading", "paragraph"], ["Converted", ""], true]);
  await h(() => window.trailingHarness.turnTailIntoDivider());
  await sleep();
  s = await summary();
  check("an atomic divider also receives a normal paragraph below it", [s.types.slice(-2), s.realTail], [["divider", "paragraph"], true]);
  await h(() => window.trailingHarness.turnTailIntoListItem());
  await sleep();
  s = await summary();
  check("a list item at the end also receives a normal paragraph", [s.types.slice(-2), s.texts.slice(-2), s.realTail], [["bulletListItem", "paragraph"], ["List item", ""], true]);
  await h(() => window.trailingHarness.replaceAll());
  await sleep();
  s = await summary();
  check("whole-document replacement also preserves the invariant", [s.types, s.texts, s.realTail], [["quote", "paragraph"], ["Replacement", ""], true]);

  console.log("\nTrailing paragraph — AI placement and collaboration");
  const stableTail = await h(() => window.trailingHarness.insertAtEnd());
  await sleep();
  s = await summary();
  check("document-end operations land before the row", [s.texts, s.ids.at(-1), s.realTail], [["Replacement", "At end", "After tail", ""], stableTail, true]);

  await h(() => window.trailingHarness.mountCollaborative());
  await page.waitForSelector(".bn-editor");
  await h(() => window.trailingHarness.seedCollaborative([{ type: "paragraph", content: "Shared" }]));
  await waitForTail();
  s = await summary();
  check("the collaborating editor starts from its shared content", [s.texts, s.realTail], [["Shared", ""], true]);
  const peerBefore = await h(() => window.trailingHarness.remoteFill());
  check("the peer starts from the same shared content", peerBefore, ["Shared", ""]);
  await sleep(150);
  s = await summary();
  check("a remote peer consuming the row creates a synchronized successor", [s.texts, s.realTail], [["Shared", "Remote", ""], true]);

  console.log("\nTrailing paragraph — marquee coexistence");
  const rect = await h(() => window.trailingHarness.tailRect());
  await page.mouse.move(rect.left + 30, rect.bottom + 70);
  await page.mouse.down();
  await page.mouse.move(rect.left + 30, (rect.top + rect.bottom) / 2, { steps: 8 });
  await page.mouse.up();
  await sleep();
  check("the page below the real row still starts block selection", (await h(() => window.trailingHarness.selectedIds())).includes(s.ids.at(-1)), true);

  if (failures.length) throw new Error(`\n${failures.join("\n\n")}`);
  console.log("\nAll trailing-paragraph browser checks passed.");
} finally {
  await browser?.close();
  server.close();
}
