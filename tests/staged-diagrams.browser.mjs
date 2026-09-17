/**
 * Renders every canned demo diagram in real Chromium and photographs it.
 *
 * The staged calls' canvases are hand-written markup. Unit tests prove they
 * parse, round-trip, name only shapes that exist and sit inside their frames —
 * none of which is the same as looking right, and a diagram that looks wrong in
 * front of a room is the failure this demo cannot afford.
 *
 * So this mounts each one through `tests/canvas-harness.browser.tsx` — the real
 * `CanvasSurface`, the real renderer, the real CSS — and writes a PNG per
 * diagram for a human (or a model that can see) to judge. It also reports what
 * the DOM says came out, because "nine shapes and eight connectors rendered" is
 * checkable where "it looks good" is not.
 *
 * No dev server, no Convex, no API keys: the shared harness aborts every
 * non-origin request and stubs the page's own fetch, so this cannot reach a
 * model even by accident.
 *
 *   node tests/staged-diagrams.browser.mjs
 *
 * Artifacts land in `.ntcheck/diagrams/`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { buildHarness, repo } from "./canvas-harness.mjs";

/**
 * Puppeteer, not the harness's Playwright.
 *
 * `canvas-harness.mjs` launches Playwright, which is declared in package.json
 * but is not installed on this machine — the browser drivers here are operator-
 * installed, exactly as `tests/nml-view.browser.mjs` assumes. So this borrows
 * only `buildHarness` (esbuild + Tailwind + the static server, no driver) and
 * drives the page itself, reusing the same cached module `nml-view` does.
 */
const { default: puppeteer } = await import(
  process.env.NML_PUPPETEER_MODULE ||
    "/Users/aryansingh/.npm/_npx/ab5cd9f6d13a2312/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js"
);

/**
 * The scripts are TypeScript behind the `@/*` alias, and several build their
 * payload from a resolver rather than a literal — so they are bundled for node
 * and imported, exactly as `canvas-picking.browser.mjs` does with its fixtures.
 */
async function loadDiagrams() {
  const out = path.join(repo, ".ntcheck", "staged-scripts.mjs");
  await mkdir(path.dirname(out), { recursive: true });
  await build({
    absWorkingDir: repo,
    entryPoints: ["tests/staged-diagrams.entry.ts"],
    bundle: true,
    format: "esm",
    outfile: out,
    platform: "node",
    tsconfig: "tsconfig.json",
    logLevel: "warning",
  });
  const { diagrams } = await import(`${out}?t=${Date.now()}`);
  return diagrams();
}

const VIEWPORT = { width: 1440, height: 1000 };

async function main() {
  const shots = path.join(repo, ".ntcheck", "diagrams");
  await mkdir(shots, { recursive: true });

  const found = await loadDiagrams();
  console.log(`${found.length} diagrams to render\n`);

  console.log("bundling the canvas harness (slow the first time)...");
  const built = await buildHarness();
  console.log(`  served at ${built.origin}`);

  const browser = await puppeteer.launch({
    headless: true,
    ...(process.env.NML_CHROME_PATH ? { executablePath: process.env.NML_CHROME_PATH } : {}),
  });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  const errors = [];
  const escaped = [];
  page.on("pageerror", (error) => errors.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    const type = message.type();
    if (type === "error" || type === "warning") errors.push(`console ${type}: ${message.text()}`);
  });
  // The same guarantee the shared harness gives: nothing leaves the fixture, so
  // this cannot reach a model even by accident.
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith(built.origin) || url.startsWith("data:")) return request.continue();
    escaped.push(url);
    return request.abort();
  });

  await page.goto(built.origin, { waitUntil: "networkidle0" });
  const guards = { requests: () => escaped, errors: () => errors };

  const report = [];
  for (const { id, title, html } of found) {
    // The frame the markup declares, so the shot is the diagram's own size
    // rather than a viewport crop that might hide what runs off the edge.
    const w = Number(/<nt-diagram[^>]*\bw="(\d+(?:\.\d+)?)"/.exec(html)?.[1] ?? 1200);
    const h = Number(/<nt-diagram[^>]*\bh="(\d+(?:\.\d+)?)"/.exec(html)?.[1] ?? 800);

    await page.evaluate(
      ([source, width, height]) =>
        window.canvasHarness.mount({ html: source }, { readOnly: true, width, height }),
      [html, Math.ceil(w), Math.ceil(h)],
    );
    await page.evaluate(() => window.canvasHarness.nextFrame());
    await page.evaluate(() => window.canvasHarness.nextFrame());

    // What actually reached the DOM — the checkable half of "it rendered".
    const seen = await page.evaluate(() => {
      const layer = document.querySelector(".nt-canvas-scene");
      if (!layer) return null;
      const count = (sel) => layer.querySelectorAll(sel).length;
      const texts = [...layer.querySelectorAll("[data-node-id]")]
        .map((el) => (el.textContent ?? "").trim().replace(/\s+/g, " "))
        .filter(Boolean);
      return {
        nodes: count("[data-node-id]"),
        edges: count("[data-edge-id]"),
        paths: count("path"),
        empty: texts.filter((t) => !t).length,
        labels: texts.slice(0, 40),
      };
    });

    const file = path.join(shots, `${id}.png`);
    const el = await page.$("#app");
    await (el ?? page).screenshot({ path: file });

    report.push({ id, title, w, h, ...seen });
    console.log(
      `${id.padEnd(6)} ${String(seen?.nodes ?? 0).padStart(3)} nodes  ` +
        `${String(seen?.edges ?? 0).padStart(2)} edges  ${w}×${h}  → ${path.relative(repo, file)}`,
    );
  }

  const left = guards.requests();
  if (left.length) {
    console.log(`\n!! ${left.length} request(s) tried to leave the fixture:`, left.slice(0, 5));
  }
  const errs = guards.errors();
  if (errs.length) {
    console.log(`\n!! ${errs.length} page error(s):`);
    for (const e of errs.slice(0, 12)) console.log("   ", e);
  }

  await writeFile(
    path.join(shots, "report.json"),
    JSON.stringify({ report, errors: errs, requests: left }, null, 2),
  );

  await page.close();
  await browser.close();
  await built.close();

  if (errs.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
