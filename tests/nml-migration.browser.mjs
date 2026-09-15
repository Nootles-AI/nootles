// Uses the existing esbuild dependency and an operator-installed Puppeteer; no app server or API keys.
// Runs the step-12 migration machinery in real Chromium: native DOMParser canvas
// conversion, a genuine two-Y.Doc collaboration, a reload, downgrade, and rollback.
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "nml-migration-browser-"));
const { default: puppeteer } = await import(process.env.NML_PUPPETEER_MODULE || "puppeteer");
await build({
  absWorkingDir: repo,
  entryPoints: ["tests/nml-migration.browser.tsx"],
  bundle: true,
  format: "esm",
  outfile: path.join(output, "nml-migration.browser.js"),
  platform: "browser",
  conditions: ["browser", "import"],
  tsconfig: "tsconfig.json",
  loader: { ".json": "json" },
  define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  logLevel: "warning",
});
await writeFile(
  path.join(output, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app">loading</div><script type="module" src="/nml-migration.browser.js"></script></body></html>`,
);
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const name = pathname === "/" ? "index.html" : path.basename(pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : "text/html");
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await puppeteer.launch({ headless: true, ...(process.env.NML_CHROME_PATH ? { executablePath: process.env.NML_CHROME_PATH } : {}) });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  const errors = [];
  const paidRequests = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("Browser error:", error.message);
  });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    if (/\/api\/(complete|diagram|chat|reformat|album\/index|places)/.test(url)) paidRequests.push(url);
    if (url.startsWith(origin)) return void request.continue();
    // Nothing should reach the network; fulfil anything else inertly.
    return void request.respond({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.goto(origin, { waitUntil: "load" });
  await page.waitForSelector('#app[data-ready="true"]');

  const text = await page.evaluate(() => window.nmlMigration.migrateText());
  assert.equal(text.status, "migrated", "text migration");
  assert.equal(text.ok, true, "text report ok");
  assert.equal(text.pmIntact, true, "ProseMirror root byte-stable");
  assert.equal(text.nmlPresent, true, "NML root present");
  assert.equal(text.firstBlockId, "h1", "decoded first block id");
  assert.equal(text.blockCount, 2, "decoded block count");
  assert.deepEqual(text.versions, { encodingVersion: 1, schemaVersion: 1 }, "declared versions");

  const canvas = await page.evaluate(() => window.nmlMigration.migrateCanvas());
  assert.equal(canvas.status, "migrated", "canvas migration");
  assert.equal(canvas.ok, true, "canvas report ok (native DOMParser)");
  assert.equal(canvas.canvasMismatches, 0, "canvas map/scene parity under real DOMParser");

  const collab = await page.evaluate(() => window.nmlMigration.collaborateReload());
  assert.equal(collab.migrated, true, "collab migration");
  assert.equal(collab.converged, true, "two clients converge");
  assert.equal(collab.hasA, true, "client A edit survives");
  assert.equal(collab.hasB, true, "client B edit survives");
  assert.equal(collab.nmlPresent, true, "NML root survives collaboration + reload");
  assert.equal(collab.decodeOk, true, "NML decodes after reload");

  const downgrade = await page.evaluate(() => window.nmlMigration.downgrade());
  assert.equal(downgrade.read, "unsupported", "newer encoding reads as read-only");

  const rollback = await page.evaluate(() => window.nmlMigration.rollback());
  assert.equal(rollback.ok, true, "rollback probe ran");
  assert.equal(rollback.inSync.diverged, false, "in-sync root is safe to roll back");
  assert.equal(rollback.inSync.reason, "in-sync");
  assert.equal(rollback.diverged.diverged, true, "NML-only edits are detected");
  assert.equal(rollback.diverged.reason, "nml-only-edits");

  await page.screenshot({ path: path.join(output, "migration.png"), fullPage: true });
  assert.deepEqual(errors, [], "no browser errors");
  assert.deepEqual(paidRequests, [], "no paid requests");
  console.log(JSON.stringify({ result: "passed", checks: ["migrateText", "migrateCanvas", "collaborateReload", "downgrade", "rollback"], browserErrors: errors.length, paidRequests: paidRequests.length, screenshots: output }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
