/**
 * The canvas toolbar's active tool, driven through real Chromium mouse and
 * keyboard input.
 *
 * NT-23: drawing a shape, opening a label from a solo chip's "Edit text", and
 * finishing the pen all put the surface back on the move tool — but through
 * React state alone, so the toolbar, which reads the tool as an external store,
 * kept the old button pressed. The keymap reads the same store, so the next
 * Escape spent itself switching to a tool that was already active instead of
 * dropping the selection.
 *
 * The page is the real `CanvasSurface` with the real `Toolbar` mounted against
 * the api it publishes, as `Workspace` mounts it. Every check compares what the
 * toolbar shows with what the surface is doing (`data-tool` on its viewport).
 *
 * Uses the existing esbuild dependency and an operator-installed Puppeteer. No
 * app server, no Convex, no API keys — and every non-local request fails the
 * run, so no AI lane can be spent in here.
 *
 *   NML_PUPPETEER_MODULE=/absolute/path/to/puppeteer/lib/esm/puppeteer/puppeteer.js \
 *     node tests/canvas-toolbar-tool.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "canvas-toolbar-tool-"));
const { default: puppeteer } = await import(process.env.NML_PUPPETEER_MODULE || "puppeteer");

await build({
  absWorkingDir: repo, entryPoints: ["tests/canvas-toolbar-tool.browser.tsx"], bundle: true, splitting: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [{ name: "fixture", setup(builder) {
    builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({ path: "server-only", namespace: "fixture" }));
    builder.onLoad({ filter: /^server-only$/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };' }));
  } }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
});
// Tailwind is not in the bundle; these are the utilities the surface's chrome leans on.
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/canvas-toolbar-tool.browser.css"><style>html,body{margin:0;height:100%;overflow:hidden;font-family:Arial,sans-serif}.relative{position:relative}.w-full{width:100%}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style></head><body><div id="app"></div><script type="module" src="/canvas-toolbar-tool.browser.js"></script></body></html>`);

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

let browser;
try {
  browser = await puppeteer.launch({ headless: true, ...(process.env.NML_CHROME_PATH ? { executablePath: process.env.NML_CHROME_PATH } : {}) });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  page.on("error", (error) => console.log(`page crashed: ${error.message}`));
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

  await page.goto(origin, { waitUntil: "networkidle0" });
  const h = (fn, ...args) => page.evaluate(fn, ...args);
  const pressed = () => h(() => window.toolbarHarness.pressed());
  const surfaceTool = () => h(() => window.toolbarHarness.surfaceTool());
  const shapes = () => h(() => window.toolbarHarness.shapes());
  const selected = () => h(() => window.toolbarHarness.selected());
  const editingLabel = () => h(() => window.toolbarHarness.editingLabel());
  /** The toolbar and the surface, read together: the thing NT-23 is about. */
  const tools = async () => ({ toolbar: await pressed(), surface: await surfaceTool() });

  const fresh = async () => {
    await h(() => window.toolbarHarness.mount());
    await page.waitForFunction(() => window.toolbarHarness.ready() && window.toolbarHarness.chip() !== null);
    await sleep(250);
  };
  const clickAt = async ({ x, y }) => {
    await page.mouse.click(x, y);
    await sleep(150);
  };
  const pickTool = async (label) => clickAt(await h((l) => window.toolbarHarness.button(l), label));
  const canvasPoint = (fx, fy) => h((x, y) => window.toolbarHarness.canvasPoint(x, y), fx, fy);
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
    await page.mouse.up();
    await sleep(200);
  };
  const key = async (name) => {
    await page.keyboard.press(name);
    await sleep(200);
  };
  const added = (before, after) => after.filter((s) => !before.includes(s));
  /** A press on empty canvas, clear of the shape and the docked toolbar; true once it holds focus. */
  const focusCanvas = async () => {
    const at = await canvasPoint(0.92, 0.12);
    await clickAt(at);
    return (await h(() => window.toolbarHarness.canvasFocused())) || h((p) => window.toolbarHarness.describe(p.x, p.y), at);
  };

  const labels = await (async () => { await fresh(); return h(() => window.toolbarHarness.labels()); })();
  const PEN = labels.find((label) => /pen/i.test(label));
  console.log(`toolbar: ${labels.join(", ")}`);
  check("the toolbar starts on the move tool, as the surface does", await tools(), { toolbar: ["Move"], surface: "move" });

  console.log("NT-23: Rectangle from the toolbar, then a drag draws one");
  await fresh();
  await pickTool("Rectangle");
  check("picking Rectangle presses it and arms the surface", await tools(), { toolbar: ["Rectangle"], surface: "rect" });
  let before = await shapes();
  await drag(await canvasPoint(0.55, 0.35), await canvasPoint(0.75, 0.6));
  let made = added(before, await shapes());
  check("the drag drew one rectangle, selected", [made.map((s) => s.split(":")[1]), await selected()], [["rect"], made.map((s) => s.split(":")[0])]);
  check("the surface is back on the move tool, and the toolbar says so", await tools(), { toolbar: ["Move"], surface: "move" });
  await key("Escape");
  check("the first Escape drops the new shape's selection", await selected(), []);
  before = await shapes();
  await drag(await canvasPoint(0.3, 0.4), await canvasPoint(0.45, 0.55));
  check("a second drag draws nothing: the move tool marquees", added(before, await shapes()), []);

  console.log("NT-23: R from the keyboard, then a drag");
  await fresh();
  check("a press on empty canvas focuses it", await focusCanvas(), true);
  await key("r");
  check("R presses Rectangle and arms the surface", await tools(), { toolbar: ["Rectangle"], surface: "rect" });
  await drag(await canvasPoint(0.55, 0.35), await canvasPoint(0.75, 0.6));
  check("after the drag the toolbar and the surface agree on Move", await tools(), { toolbar: ["Move"], surface: "move" });

  console.log("NT-23: Text from the toolbar, then a click places one with its caret");
  await fresh();
  await pickTool("Text");
  check("picking Text presses it and arms the surface", await tools(), { toolbar: ["Text"], surface: "text" });
  before = await shapes();
  await clickAt(await canvasPoint(0.6, 0.7));
  made = added(before, await shapes());
  check("the click placed a text, open for typing", [made.map((s) => s.split(":")[1]), await editingLabel()], [["text"], true]);
  check("the surface is back on the move tool, and the toolbar says so", await tools(), { toolbar: ["Move"], surface: "move" });

  console.log("NT-23: Edit text from a solo chip while the scale tool is up");
  await fresh();
  await pickTool("Scale");
  check("picking Scale presses it", await tools(), { toolbar: ["Scale"], surface: "scale" });
  await clickAt(await h(() => window.toolbarHarness.chip()));
  const edit = await h(() => window.toolbarHarness.menuItem("Edit text"));
  check("the chip offers Edit text", edit !== null, true);
  if (edit) await clickAt(edit);
  check("Edit text opened the label and selected its shape", [await editingLabel(), await selected()], [true, ["a"]]);
  check("the surface is on the move tool, and the toolbar says so", await tools(), { toolbar: ["Move"], surface: "move" });

  console.log("NT-23: the pen, three clicks and Enter");
  await fresh();
  check("the toolbar has a pen", typeof PEN, "string");
  await pickTool(PEN);
  check("picking the pen presses it and arms the surface", await tools(), { toolbar: [PEN], surface: "pen" });
  before = await shapes();
  for (const [fx, fy] of [[0.5, 0.3], [0.7, 0.5], [0.55, 0.8]]) await clickAt(await canvasPoint(fx, fy));
  await key("Enter");
  made = added(before, await shapes());
  check("Enter finished one path, selected", [made.map((s) => s.split(":")[1]), (await selected()).length], [["path"], 1]);
  check("the surface is back on the move tool, and the toolbar says so", await tools(), { toolbar: ["Move"], surface: "move" });
  await key("Escape");
  check("the first Escape drops the path's selection", await selected(), []);

  console.log("NT-23: a path's points opened with Enter and left with Escape");
  await fresh();
  await pickTool(PEN);
  for (const [fx, fy] of [[0.5, 0.3], [0.7, 0.5], [0.55, 0.8]]) await clickAt(await canvasPoint(fx, fy));
  await key("Enter");
  const path = await selected();
  await key("Enter");
  check("Enter on the selected path opens its points, on the move tool", [await h(() => window.toolbarHarness.pointsOpen()), await tools()], [true, { toolbar: ["Move"], surface: "move" }]);
  await key("Escape");
  check("Escape closes the points and keeps the path selected", [await h(() => window.toolbarHarness.pointsOpen()), await selected(), await tools()], [false, path, { toolbar: ["Move"], surface: "move" }]);
  await key("Escape");
  check("…and the next Escape drops it", await selected(), []);

  console.log("Unchanged: a tool picked and left by hand");
  await fresh();
  check("the bar has no hand: the page scrolls", labels.includes("Hand"), false);
  check("a press on empty canvas focuses it", await focusCanvas(), true);
  await key("h");
  check("H still takes the hand", await surfaceTool(), "hand");
  await key("Escape");
  check("Escape returns both to Move", await tools(), { toolbar: ["Move"], surface: "move" });
  await pickTool("Rectangle");
  await pickTool("Move");
  check("Move from the toolbar disarms a picked tool", await tools(), { toolbar: ["Move"], surface: "move" });

  console.log("A double-click keeps a tool in hand");
  await fresh();
  const rectangle = await h(() => window.toolbarHarness.button("Rectangle"));
  await page.mouse.click(rectangle.x, rectangle.y, { clickCount: 2 });
  await sleep(150);
  check("double-clicking Rectangle locks it, with a dot", [await tools(), await h(() => window.toolbarHarness.locked())], [{ toolbar: ["Rectangle"], surface: "rect" }, ["Rectangle"]]);
  before = await shapes();
  await drag(await canvasPoint(0.55, 0.3), await canvasPoint(0.7, 0.45));
  await drag(await canvasPoint(0.55, 0.6), await canvasPoint(0.7, 0.75));
  check("two drags draw two rectangles, still on the rectangle", [added(before, await shapes()).length, await tools()], [2, { toolbar: ["Rectangle"], surface: "rect" }]);
  await key("Escape");
  check("Escape lets the lock go, on Move", [await tools(), await h(() => window.toolbarHarness.locked())], [{ toolbar: ["Move"], surface: "move" }, []]);
  const move = await h(() => window.toolbarHarness.button("Move"));
  await page.mouse.click(move.x, move.y, { clickCount: 2 });
  await sleep(150);
  check("Move never locks", await h(() => window.toolbarHarness.locked()), []);
  await page.mouse.click(rectangle.x, rectangle.y, { clickCount: 2 });
  await sleep(150);
  await pickTool("Rectangle");
  check("a single pick lets a lock go", await h(() => window.toolbarHarness.locked()), []);
} finally {
  await browser?.close();
  server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} failure(s)`);
  for (const failure of failures) console.log(`- ${failure}`);
  process.exit(1);
}
console.log("\nall checks passed");
