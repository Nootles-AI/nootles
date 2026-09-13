// Isolated real-engine acceptance: no app server, accounts, API keys, or provider traffic.
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { execFileSync } from "node:child_process";

const repo = process.cwd();
const output = await mkdtemp(path.join(tmpdir(), "canvas-workbench-"));
const baseline = process.env.CANVAS_BASELINE_REF;
const { chromium } = await import(process.env.CANVAS_PLAYWRIGHT_MODULE || "playwright");
await build({ entryPoints: ["tests/canvas-workbench.browser.tsx"], bundle: true, splitting: true, format: "esm", outdir: output,
  platform: "browser", conditions: ["browser", "import", "style"], tsconfig: "tsconfig.json",
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "production" }, browser: true };' },
  plugins: [{ name: "reject-server-diagnostics", setup(builder) {
    builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({ path: "server-only", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Server-only diagnostics reached browser fixture") };' }));
  } }, ...(baseline ? [{ name: "baseline-app-source", setup(builder) {
    builder.onLoad({ filter: /\/app\/.*\.(tsx?|css)$/ }, ({ path: filename }) => {
      const relative = path.relative(repo, filename);
      if (!relative.startsWith("app/")) return;
      try { return { contents: execFileSync("git", ["show", `${baseline}:${relative}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), loader: filename.endsWith("css") ? "css" : filename.endsWith("tsx") ? "tsx" : "ts", resolveDir: path.dirname(filename) }; }
      catch { return; }
    });
  } }] : [])],
  define: { "process.env.NODE_ENV": '"production"' }, loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning" });
const css = path.join(repo, "app/globals.css");
await writeFile(path.join(output, "app.css"), (await postcss([tailwind({ base: repo })]).process(await readFile(css, "utf8"), { from: css })).css);
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/canvas-workbench.browser.css"><style>
body { margin:0; padding:24px; color:var(--foreground); background:var(--background); font-family:Arial,sans-serif; } h1 { font-size:20px; } header p { color:var(--muted); font-size:13px; margin:8px 0 24px; } main { max-width:1100px; } #sampling { width:280px; margin-top:16px; } @media(max-width:700px) { body { padding:12px; } }
</style></head><body><div id="app"></div><script type="module" src="/canvas-workbench.browser.js"></script></body></html>`);
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const name = url.pathname === "/" ? "index.html" : path.basename(url.pathname);
    res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
    res.end(await readFile(path.join(output, name)));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CANVAS_CHROME_PATH ? { executablePath: process.env.CANVAS_CHROME_PATH } : { channel: process.env.CANVAS_BROWSER_CHANNEL || "chrome" }) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], blocked = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`) && !url.includes("/api/")) return route.continue();
    blocked.push(url);
    return route.abort();
  });
  await page.goto(origin);
  await page.waitForFunction(() => window.canvasHarness?.api());
  const reset = () => page.evaluate(() => window.canvasHarness.api().viewport.set({ x: 0, y: 0, zoom: 1 }));
  const click = async (x, y, options) => {
    const box = await page.locator(".nt-canvas-viewport").boundingBox();
    await page.mouse.click(box.x + x, box.y + y, options);
  };
  const selected = () => page.evaluate(() => window.canvasHarness.inspect().ids);
  if (!baseline) {
  await reset();
  await click(130, 130);
  assert.deepEqual(await selected(), ["below"], "hollow front rectangle must not steal the click");
  await click(700, 60);
  await click(81, 120);
  assert.deepEqual(await selected(), ["outline"]);
  await page.keyboard.down("Meta"); await click(485, 305); await page.keyboard.up("Meta");
  assert.deepEqual(await selected(), ["child"], "command-click reaches a nested child");
  await click(81, 120, { button: "right" });
  await page.getByRole("menuitem", { name: /Select .*below/ }).click();
  assert.deepEqual(await selected(), ["below"]);
  // A real pointer drag changes the scene once and undo restores it.
  const beforeDrag = await page.evaluate(() => window.canvasHarness.api().store.getScene());
  const box = await page.locator(".nt-canvas-viewport").boundingBox();
  await page.mouse.move(box.x + 130, box.y + 130); await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 180, { steps: 10 }); await page.mouse.up();
  assert.notDeepEqual(await page.evaluate(() => window.canvasHarness.api().store.getScene()), beforeDrag);
  await page.evaluate(() => window.canvasHarness.api().store.undo());
  assert.deepEqual(await page.evaluate(() => window.canvasHarness.api().store.getScene()), beforeDrag);
  await page.getByRole("button", { name: "Expand canvas", exact: true }).click();
  await page.waitForFunction(() => window.canvasHarness.api().presentation.get());
  assert.deepEqual(await page.evaluate(() => window.canvasHarness.api().store.getScene()), beforeDrag);
  assert.equal(await page.getByRole("button", { name: "Return to document" }).isVisible(), true);
  await page.getByRole("button", { name: "Return to document" }).click();
  assert.equal(await page.evaluate(() => window.canvasHarness.api().presentation.get()), false);
  const layout = await page.evaluate(() => {
    const resolved = window.canvasHarness.inspect().layout.nodes.find((node) => node.id === "stack");
    const parent = document.querySelector('[data-id="stack"]');
    const zoom = window.canvasHarness.api().viewport.get().zoom;
    const origin = parent.getBoundingClientRect();
    return resolved.children.map((node) => {
      const box = parent.querySelector(`[data-id="${node.id}"]`).getBoundingClientRect();
      return { id: node.id, expected: { x: node.x, y: node.y, w: node.w, h: node.h }, actual: { x: (box.x - origin.x) / zoom, y: (box.y - origin.y) / zoom, w: box.width / zoom, h: box.height / zoom } };
    });
  });
  for (const node of layout) for (const axis of ["x", "y", "w", "h"]) assert.ok(Math.abs(node.actual[axis] - node.expected[axis]) < 0.5, `layout ${node.id}.${axis}: ${JSON.stringify(node)}`);
  await page.getByRole("button", { name: "Export canvas", exact: true }).click();
  const sourceDownload = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "NML source · editable" }).click();
  const source = await sourceDownload;
  assert.equal(source.suggestedFilename(), "canvas.nml");
  await source.saveAs(path.join(output, "canvas.nml"));
  assert.match(await readFile(path.join(output, "canvas.nml"), "utf8"), /<nt-diagram/);
  await page.getByRole("button", { name: "Export canvas", exact: true }).click();
  const pngDownload = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "PNG image · 1×" }).click();
  const png = await pngDownload;
  await png.saveAs(path.join(output, "canvas-export.png"));
  const pngBytes = await readFile(path.join(output, "canvas-export.png"));
  assert.equal(pngBytes.subarray(1, 4).toString(), "PNG");
  const pixel = await page.evaluate(async (data) => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
    return [...context.getImageData(82, 82, 1, 1).data];
  }, pngBytes.toString("base64"));
  assert.deepEqual(pixel, [216, 224, 209, 255], "PNG must contain the actual lower rectangle, not a blank or camera-shifted image");
  assert.deepEqual(await page.evaluate(() => window.canvasHarness.api().store.getScene()), beforeDrag);

  // Sampling contract; screen permissions are mocked, the real control and lifecycle are not.
  await page.evaluate(() => { window.EyeDropper = class { async open() { return { sRGBHex: "#123456" }; } }; });
  await page.reload(); await page.waitForFunction(() => window.canvasHarness?.api());
  await page.evaluate(() => { window.EyeDropper = class { async open() { return { sRGBHex: "#123456" }; } }; window.canvasHarness.mount(); });
  await page.getByRole("button", { name: "Sample screen colour" }).click();
  await page.waitForFunction(() => document.querySelector("output").textContent === "#123456");
  await page.evaluate(() => { window.EyeDropper = class { async open() { throw new DOMException("Cancelled", "AbortError"); } }; });
  await page.getByRole("button", { name: "Sample screen colour" }).click();
  assert.equal(await page.locator("output").textContent(), "#123456");
  await page.getByRole("button", { name: "Enter fullscreen" }).click();
  await page.waitForFunction(() => !!document.fullscreenElement);
  assert.equal(await page.getByRole("toolbar", { name: "Canvas" }).isVisible(), true);
  await page.getByRole("button", { name: "Exit fullscreen" }).click();
  await page.waitForFunction(() => !document.fullscreenElement);
  await reset();
  await page.screenshot({ path: path.join(output, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 700, height: 900 });
  await page.screenshot({ path: path.join(output, "compact.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  }

  // Camera workload: 1,000 DOM shapes, imperative pan/zoom, no document or shape DOM mutation.
  await page.evaluate(() => window.canvasHarness.mount(1000));
  await page.waitForFunction(() => window.canvasHarness.api()?.store.getScene().nodes.length === 1000);
  const metrics = await page.evaluate(async () => {
    const api = window.canvasHarness.api();
    const before = api.store.getScene();
    const beforeHtml = document.querySelector(".nt-canvas-scene").innerHTML;
    const shapeMarkup = () => [...document.querySelectorAll(".nt-canvas-scene > [data-id]")].map((node) => node.outerHTML).join("");
    const beforeShapes = shapeMarkup();
    let changes = 0;
    const unsubscribe = api.store.subscribe(() => changes++);
    const frames = [], input = [];
    let previous = performance.now();
    for (let i = 0; i < 120; i++) {
      await new Promise(requestAnimationFrame);
      const now = performance.now(); frames.push(now - previous); previous = now;
      const start = performance.now();
      api.viewport.set({ x: -i * 2, y: -i, zoom: 1 + i / 500 });
      input.push(performance.now() - start);
    }
    await new Promise(requestAnimationFrame);
    unsubscribe();
    const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
    return { shapes: before.nodes.length, changes, sameScene: before === api.store.getScene(),
      sameShapeDom: beforeShapes === shapeMarkup(),
      frameP50: percentile(frames, 0.5), frameP95: percentile(frames, 0.95), frameP99: percentile(frames, 0.99), inputP95: percentile(input, 0.95),
      // Overlay counter-scaling is allowed; the scene data identity is the authoritative no-edit check.
      sceneDomLengthBefore: beforeHtml.length, sceneDomLengthAfter: document.querySelector(".nt-canvas-scene").innerHTML.length };
  });
  assert.equal(metrics.sameScene, true); assert.equal(metrics.changes, 0);
  assert.equal(metrics.sameShapeDom, true);
  assert.ok(metrics.inputP95 < 5, `camera handler p95 ${metrics.inputP95} ms`);
  assert.deepEqual(errors, []); assert.deepEqual(blocked, [], "fixture must not request remote services");
  await writeFile(path.join(output, "results.json"), JSON.stringify({ baseline: baseline ?? null, engine: await browser.version(), input: "synthetic Chromium mouse and camera commands; not physical trackpad evidence", metrics, errors, blocked }, null, 2));
  console.log(JSON.stringify({ output, metrics }, null, 2));
} finally { await browser?.close(); server.close(); }
