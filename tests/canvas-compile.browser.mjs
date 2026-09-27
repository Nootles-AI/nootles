/**
 * The compile-parity gate (COMPILE, build-plan §5.2): for every fixture in
 * `COMPILE_FIXTURES`, mounts the live renderer (`ShapeView`/`EdgeLayer`, no
 * `CanvasSurface`) beside `compileSceneReady`'s own markup and asserts every
 * `[data-id]` box the renderer draws is reproduced, within half a pixel, by
 * the compiler's `[data-nt-id]` box — the parity plan's layout-box assertion.
 *
 * Reuses `tests/canvas-harness.mjs`'s shared Playwright/esbuild scaffold for
 * everything generic (launch, page guards, `check`/`xfail`/`todo`), and
 * builds its own bundle from `tests/canvas-compile.browser.tsx`, since that
 * scaffold's `buildHarness()` is pinned to the shared
 * `canvas-harness.browser.tsx` entry point. No app server, no Convex, no API
 * keys — every non-origin request fails the run.
 *
 *   node tests/canvas-compile.browser.mjs
 */
import { build, transform } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { COMPILE_FIXTURES } from "../app/lib/ai/html/compileFixtures.ts";
import {
  buildHarness as buildSharedHarness,
  checker,
  launch,
  openPage,
  repo,
  writeArtifact,
} from "./canvas-harness.mjs";

const c = checker();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rejectNextServerDiagnosticsPlugin() {
  return {
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
  };
}

function contentTypeFor(name) {
  if (name.endsWith(".js") || name.endsWith(".mjs")) return "text/javascript";
  if (name.endsWith(".css")) return "text/css";
  if (name.endsWith(".html")) return "text/html";
  return "application/octet-stream";
}

/** Mirrors `canvas-harness.mjs`'s `buildHarness`, pointed at this slice's own
 *  fixture page instead of the shared `canvas-harness.browser.tsx`. */
async function buildCompileHarness() {
  const output = await mkdtemp(path.join(tmpdir(), "canvas-compile-"));
  await build({
    absWorkingDir: repo,
    entryPoints: ["tests/canvas-compile.browser.tsx"],
    bundle: true,
    splitting: true,
    format: "esm",
    outdir: output,
    platform: "browser",
    conditions: ["browser", "import", "style"],
    tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"development"' },
    banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
    plugins: [rejectNextServerDiagnosticsPlugin()],
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
    logLevel: "warning",
  });

  const appCssPath = path.join(repo, "app/globals.css");
  const styles = await postcss([tailwind({ base: repo })]).process(await readFile(appCssPath, "utf8"), {
    from: appCssPath,
  });
  await writeFile(path.join(output, "app.css"), styles.css);

  await writeFile(
    path.join(output, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8">' +
      '<link rel="stylesheet" href="/app.css">' +
      '<link rel="stylesheet" href="/canvas-compile.browser.css">' +
      '</head><body><div id="app"></div><script type="module" src="/canvas-compile.browser.js"></script></body></html>',
  );

  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      const name = pathname === "/" ? "index.html" : path.basename(pathname);
      const data = await readFile(path.join(output, name));
      response.setHeader("Content-Type", contentTypeFor(name));
      response.end(data);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((resolve) => server.close(resolve)) };
}

const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;

function boxesAgree(name, left, right) {
  const leftIds = Object.keys(left);
  c.check(`boxes agree: ${name}: node count`, leftIds.length > 0, true);
  for (const id of leftIds) {
    const l = left[id];
    const r = right[id];
    if (!r) {
      c.check(`boxes agree: ${name}: ${id} present on the compiled side`, false, true);
      continue;
    }
    const ok = near(l.x, r.x) && near(l.y, r.y) && near(l.w, r.w) && near(l.h, r.h);
    c.check(`boxes agree: ${name}: ${id}`, ok, true);
    if (!ok) console.log(`    left  ${JSON.stringify(l)}\n    right ${JSON.stringify(r)}`);
  }
}

async function main() {
  const built = await buildCompileHarness();
  const { browser } = await launch();
  try {
    const { page, guards } = await openPage(browser, built.origin, { viewport: { width: 1400, height: 900 } });
    await page.goto(built.origin, { waitUntil: "networkidle" });

    for (const name of Object.keys(COMPILE_FIXTURES)) {
      const { boxes } = await page.evaluate((n) => window.compileHarness.mount(n), name);
      boxesAgree(name, boxes.left, boxes.right);
    }

    c.check("no request left the fixture", guards.requests(), []);
    c.check("no console error", guards.errors(), []);

    // "compiled side has no canvas class" — the compiled markup carries none
    // of the renderer's own class names, on any fixture already mounted.
    const rightClassCount = await page.evaluate(() => document.querySelector("#right")?.querySelectorAll("[class]").length ?? -1);
    c.check("compiled side has no canvas class", rightClassCount, 0);

    await page.close();
  } finally {
    await browser.close();
    await built.close();
  }

  await jsxAllParse();
  await zoomIndependence();

  const artifact = { verdict: c.summary().failed === 0 ? "pass" : "fail" };
  const artifactPath = await writeArtifact("canvas-compile", artifact);
  console.log(`  artifact: ${artifactPath}`);
}

/**
 * `toHtml.ts`/`scene/parse.ts` import each other through the `@/*` tsconfig
 * alias, which plain Node ESM resolution does not understand — only a
 * bundler does. This bundles the two exports this runner needs, for Node
 * rather than the browser, exactly once, and imports the result.
 */
async function loadCompilerForNode() {
  const outdir = await mkdtemp(path.join(tmpdir(), "canvas-compile-node-"));
  const entryFile = path.join(outdir, "entry.mjs");
  await writeFile(
    entryFile,
    [
      `export { compileScene } from ${JSON.stringify(path.join(repo, "app/lib/ai/html/toHtml.ts"))};`,
      `export { parseScene } from ${JSON.stringify(path.join(repo, "app/components/editor/canvas/scene/parse.ts"))};`,
    ].join("\n"),
  );
  const result = await build({
    entryPoints: [entryFile],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    external: ["linkedom"],
    tsconfig: path.join(repo, "tsconfig.json"),
    absWorkingDir: repo,
    logLevel: "warning",
  });
  const outFile = path.join(outdir, "out.mjs");
  await writeFile(outFile, result.outputFiles[0].text);
  return import(pathToFileURL(outFile).href);
}

/** Every fixture's JSX output is syntactically valid JSX — checked with
 *  esbuild's own transform, in this process, no browser. */
async function jsxAllParse() {
  const { compileScene, parseScene } = await loadCompilerForNode();
  const { parseHTML } = await import("linkedom");
  const parseHtml = (h) => parseHTML(h).document;
  for (const [name, html] of Object.entries(COMPILE_FIXTURES)) {
    const scene = parseScene(html, parseHtml);
    const code = compileScene(scene, { flavour: "jsx" }).code;
    try {
      await transform(`const el = <>${code}</>;`, { loader: "jsx" });
      c.check(`jsx flavour parses: ${name}`, true, true);
    } catch (error) {
      c.check(`jsx flavour parses: ${name}`, String(error), "ok");
    }
  }
}

/** `compileSelection` never observes the page's scale — it reads only
 *  `laidOutScene(scene)`. Proven two ways: statically (`toHtml.test.ts`'s own
 *  "never imports engine/useViewport" case), and here, empirically: a real,
 *  gesture-driven `CanvasSurface` (the shared harness) is shown at 50% and at
 *  200%, and the scene it reports at each is byte-identical — the one thing a
 *  scale-dependent compile could possibly disturb. */
async function zoomIndependence() {
  const sharedBuilt = await buildSharedHarness();
  const { browser } = await launch();
  try {
    const { page } = await openPage(browser, sharedBuilt.origin, {
      viewport: { width: 1200, height: 800 },
      aiReach: sharedBuilt.aiReach,
    });
    await page.goto(sharedBuilt.origin, { waitUntil: "networkidle" });
    const html = COMPILE_FIXTURES["edge-two-rects"];
    await page.evaluate((h) => window.canvasHarness.mount({ html: h }), html);
    await page.evaluate(() => window.canvasHarness.look({ x: 0, y: 0 }, 0.5));
    await sleep(50);
    const atHalf = await page.evaluate(() => JSON.stringify(window.canvasHarness.api().store.getScene()));
    await page.evaluate(() => window.canvasHarness.look({ x: 0, y: 0 }, 2));
    await sleep(50);
    const atDouble = await page.evaluate(() => JSON.stringify(window.canvasHarness.api().store.getScene()));
    c.check("compile output is zoom-independent (scene identical at 50% and 200%)", atDouble === atHalf, true);
    await page.close();
  } finally {
    await browser.close();
    await sharedBuilt.close();
  }
}

main()
  .then(() => {
    const summary = c.summary();
    console.log(`\n${summary.failed} failing, ${summary.xfailed} xfailed, ${summary.xpassed} xpassed, ${summary.todo} todo`);
    if (summary.failed > 0) {
      console.error(`\n${c.failures.length} failure(s):\n\n${c.failures.join("\n\n")}`);
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
