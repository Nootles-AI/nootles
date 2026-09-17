import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "nml-parity-mirror-"));
await build({
  absWorkingDir: repo,
  entryPoints: ["tests/nml-parity-mirror.browser.tsx"],
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
    name: "browser-stubs",
    setup(builder) {
      builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({ path: "empty", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const sync = () => 0; export default { sync };" }));
    },
  }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
  logLevel: "warning",
});
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/nml-parity-mirror.browser.css"><style>body{margin:40px;font-family:Arial,sans-serif}</style></head><body><div id="app"></div><script type="module" src="/nml-parity-mirror.browser.js"></script></body></html>`);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") { response.writeHead(204); return void response.end(); }
    const name = pathname === "/" ? "index.html" : path.basename(pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

let browser;
try {
  const { default: puppeteer } = await import(process.env.NML_PUPPETEER_MODULE || "puppeteer");
  browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.NML_CHROME_PATH ? { executablePath: process.env.NML_CHROME_PATH } : {}) });
  const page = await browser.newPage();
  const errors = [];
  const outbound = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().startsWith(origin)) return void request.continue();
    outbound.push(request.url());
    request.abort();
  });
  await page.goto(origin, { waitUntil: "networkidle0" });
  await page.waitForSelector(".bn-editor");
  assert.match(await page.$eval(".bn-editor", (element) => element.textContent), /Ready/);

  // Human typing → canonical NML.
  await page.click('[data-id="paragraph"] .bn-inline-content');
  await page.keyboard.press("End");
  await page.keyboard.type(" human");
  await page.evaluate(() => window.nmlParity.settle());
  let canonical = await page.evaluate(() => window.nmlParity.canonical());
  assert.match(JSON.stringify(canonical.blocks[0]), /Ready human/);

  // The compatibility projection retains the mature collaborative undo path.
  await page.evaluate(() => window.nmlParity.undo());
  await page.evaluate(() => window.nmlParity.settle());
  canonical = await page.evaluate(() => window.nmlParity.canonical());
  assert.doesNotMatch(JSON.stringify(canonical.blocks[0]), /Ready human/);
  await page.evaluate(() => window.nmlParity.redo());
  await page.evaluate(() => window.nmlParity.settle());
  canonical = await page.evaluate(() => window.nmlParity.canonical());
  assert.match(JSON.stringify(canonical.blocks[0]), /Ready human/);

  // Markdown input rules are BlockNote's production rules, mirrored to NML.
  await page.evaluate(() => window.nmlParity.mount());
  await page.waitForSelector(".bn-editor");
  await page.click('[data-id="paragraph"] .bn-inline-content');
  await page.keyboard.press("Home");
  await page.keyboard.type("## ");
  await page.evaluate(() => window.nmlParity.settle());
  canonical = await page.evaluate(() => window.nmlParity.canonical());
  assert.equal(canonical.blocks[0].type, "heading");
  assert.equal(canonical.blocks[0].props.level, 2);

  // Inline atoms, code language, and image source/caption all round-trip.
  await page.evaluate(() => window.nmlParity.mount());
  await page.waitForFunction(() => window.nmlParity.legacy()[0]?.id === "paragraph");
  await page.evaluate(() => { window.nmlParity.insertAtoms(); window.nmlParity.updateDomains(); });
  await page.evaluate(() => window.nmlParity.settle());
  canonical = await page.evaluate(() => window.nmlParity.canonical());
  assert.match(JSON.stringify(canonical.blocks[0]), /"type":"math"/);
  assert.match(JSON.stringify(canonical.blocks[0]), /"type":"pageRef"/);
  assert.equal(canonical.blocks[1].props.language, "python");
  assert.deepEqual(canonical.blocks[2].props, {
    source: { kind: "url", url: "#new.png" },
    caption: "New caption",
  });

  // Rich HTML paste produces structured canonical blocks.
  await page.evaluate(() => window.nmlParity.mount());
  await page.waitForSelector(".bn-editor");
  await page.click('[data-id="paragraph"] .bn-inline-content');
  await page.keyboard.press("End");
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/html", "<h2>Pasted heading</h2><ul><li>Pasted item</li></ul>");
    data.setData("text/plain", "Pasted heading\nPasted item");
    document.activeElement?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.evaluate(() => window.nmlParity.settle());
  canonical = await page.evaluate(() => window.nmlParity.canonical());
  assert.match(JSON.stringify(canonical), /Pasted heading/);
  assert.match(JSON.stringify(canonical), /Pasted item/);
  assert.ok(canonical.blocks.length > 3, "HTML paste created multiple blocks");

  // Canonical/model edit → the live BlockNote compatibility view.
  await page.evaluate(() => window.nmlParity.directCanonical());
  await page.waitForFunction(() => document.querySelector('[data-id="paragraph"]')?.textContent?.includes("Direct"));
  const legacy = await page.evaluate(() => window.nmlParity.legacy());
  assert.match(JSON.stringify(legacy[0]), /Direct/);

  await page.screenshot({ path: path.join(output, "nml-parity-mirror.png"), fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(outbound, []);
  console.log(JSON.stringify({
    result: "passed",
    checks: ["human-to-nml", "undo-redo", "markdown", "inline-atoms", "code-and-image", "rich-paste", "nml-to-live-view"],
    paidRequests: 0,
    screenshot: path.join(output, "nml-parity-mirror.png"),
  }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
