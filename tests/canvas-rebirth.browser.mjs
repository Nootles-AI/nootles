/**
 * A diagram made, taken away, and another made where it was
 * (`canvas-rebirth.browser.tsx`): the new one starts empty and narrow, however
 * the old one went — taken back with ⌘Z or deleted with its last shape — and
 * undoing back to the old one brings it back wide, with its shapes.
 *
 *   node tests/canvas-rebirth.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checker, launch, openPage, repo, writeAppStylesheet } from "./canvas-harness.mjs";

const output = await mkdtemp(path.join(tmpdir(), "canvas-rebirth-"));

await build({
  absWorkingDir: repo,
  entryPoints: ["tests/canvas-rebirth.browser.tsx"],
  bundle: true,
  splitting: true,
  format: "esm",
  outdir: output,
  platform: "browser",
  conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [
    {
      name: "browser-stubs",
      setup(builder) {
        builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({
          path: "server-only",
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents:
            'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached the browser fixture") };',
        }));
      },
    },
  ],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
  logLevel: "warning",
});
await writeAppStylesheet(output);
await writeFile(
  path.join(output, "index.html"),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/canvas-rebirth.browser.css"><style>html,body{height:100%;margin:0}</style></head><body><div id="app"></div><script type="module" src="/canvas-rebirth.browser.js"></script></body></html>',
);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") {
      response.writeHead(204);
      return void response.end();
    }
    const name = pathname === "/" ? "index.html" : path.basename(pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader(
      "Content-Type",
      name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html",
    );
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const { check, summary, failures } = checker();
const { browser } = await launch();

let guards = null;
let page = null;
try {
  ({ page, guards } = await openPage(browser, origin, { viewport: { width: 1100, height: 900 } }));
  // Convex's client opens its socket on the first subscription: one that
  // never connects, as in the other page harnesses.
  await page.addInitScript(() => {
    window.WebSocket = class extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      send() {
        throw new Error("fixture socket must never send");
      }
      close() {
        this.readyState = 3;
      }
    };
  });
  await page.goto(origin);
  await page.waitForFunction(() => window.canvasRebirth?.ready());
  const at = (fn, ...args) => page.evaluate(({ fn, args }) => window.canvasRebirth[fn](...args), { fn, args });
  const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const mounted = (id) => page.waitForFunction((id) => window.canvasRebirth.mounted(id), id, { timeout: 5000 });
  /** Undoes until the page holds these block kinds, or gives up. */
  const undoTo = async (kinds) => {
    for (let i = 0; i < 8 && JSON.stringify(await at("blocks")) !== JSON.stringify(kinds); i++) {
      await at("undo");
      await frame();
    }
    return at("blocks");
  };
  /** Undoes until this block is on the page again; whether it came back. */
  const undoUntilBack = async (id) => {
    for (let i = 0; i < 8 && !(await at("ids")).includes(id); i++) {
      await at("undo");
      await frame();
    }
    return (await at("ids")).includes(id);
  };

  // ---- Taken back with ⌘Z -------------------------------------------------
  let [intro, line] = await at("seed");
  await frame();
  const wide = await at("slash", "wide", line);
  await mounted(wide);
  await at("put", wide, "w1");
  await frame();
  check("a wide diagram is born wide", await at("scene", wide), { wide: "pinned", nodes: ["w1"] });
  check("under an id of its own, not the line's", wide !== line, true);

  check("⌘Z takes it back to the line", await undoTo(["paragraph", "paragraph"]), ["paragraph", "paragraph"]);
  await at("redo");
  await frame();
  await mounted(wide);
  await at("redo");
  await frame();
  check("redo brings it back whole", await at("scene", wide), { wide: "pinned", nodes: ["w1"] });
  await undoTo(["paragraph", "paragraph"]);

  line = (await at("ids"))[1];
  const plain = await at("slash", "diagram", line);
  await mounted(plain);
  check("a diagram made on the same line is a new one", plain !== wide, true);
  check("and starts narrow and empty", await at("scene", plain), { wide: false, nodes: [] });
  check("undoing it brings back the line", await undoTo(["paragraph", "paragraph"]), ["paragraph", "paragraph"]);
  await at("redo");
  await frame();
  await mounted(plain);
  check("and redoing it brings back the same new diagram", await at("scene", plain), { wide: false, nodes: [] });

  // ---- Deleted with its last shape ----------------------------------------
  [intro, line] = await at("seed");
  await frame();
  const first = await at("slash", "wide", line);
  await mounted(first);
  await at("put", first, "w2");
  await frame();
  await at("remove", first);
  await frame();
  check("deleted, the diagram is gone", await at("blocks"), ["paragraph"]);
  const next = await at("addLine", intro);
  const second = await at("slash", "diagram", next);
  await mounted(second);
  check("a diagram made where it was starts narrow and empty", await at("scene", second), { wide: false, nodes: [] });

  check("undoing back to the deleted diagram", await undoUntilBack(first), true);
  check("takes the new one away", (await at("ids")).includes(second), false);
  await mounted(first);
  check("brings it back wide, with its shapes", await at("scene", first), { wide: "pinned", nodes: ["w2"] });

  check("no page errors", guards.errors(), []);
  check("no requests off the fixture", guards.requests(), []);
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.log(`  FAIL ${error?.message ?? error}`);
  for (const line of guards?.errors() ?? []) console.log(`    ${line}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const { failed } = summary();
if (failed || failures.length) {
  console.log(`\n${Math.max(failed, failures.length)} canvas rebirth check(s) failed.`);
  process.exit(1);
}
console.log("\nAll canvas rebirth checks passed.");
