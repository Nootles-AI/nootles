/**
 * Two diagrams on one page (`canvas-page.browser.tsx`), driven with a real
 * pointer: a Shift-click selects across them, one drag moves both, the band
 * grows under it and the top holds it, one undo takes the whole move back,
 * and a marquee from one band reaches into the next. At 150% document zoom
 * a click and a drag still land in the diagram's own px.
 *
 *   node tests/canvas-page.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checker, launch, openPage, repo, writeAppStylesheet } from "./canvas-harness.mjs";

const output = await mkdtemp(path.join(tmpdir(), "canvas-page-"));

await build({
  absWorkingDir: repo,
  entryPoints: ["tests/canvas-page.browser.tsx"],
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
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/canvas-page.browser.css"><style>html,body{height:100%;margin:0}</style></head><body><div id="app"></div><script type="module" src="/canvas-page.browser.js"></script></body></html>',
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

const centre = (box) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });

let guards = null;
let page = null;
try {
  ({ page, guards } = await openPage(browser, origin, { viewport: { width: 1100, height: 900 } }));
  // Convex's client opens its socket on the first subscription; here it is
  // a socket that never connects, as in the block-drag harness, rather than
  // the guard's throwing one.
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
  await page.waitForFunction(() => window.canvasPage?.ready());
  const at = (fn, ...args) => page.evaluate(({ fn, args }) => window.canvasPage[fn](...args), { fn, args });
  const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  const drag = async (from, dx, dy, { hold } = {}) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
    await frame();
    const during = hold ? await hold() : null;
    await page.mouse.up();
    await frame();
    return during;
  };

  // A Shift-click selects across diagrams; the frame is drawn once, in the
  // diagram last pressed, and each diagram outlines its own members.
  await page.mouse.click(...Object.values(centre(await at("shape", "top", "a1"))));
  check("a click selects in its diagram", await at("selection"), { top: ["a1"] });
  await page.keyboard.down("Shift");
  await page.mouse.click(...Object.values(centre(await at("shape", "bottom", "b1"))));
  await page.keyboard.up("Shift");
  await frame();
  check("a Shift-click in the next diagram keeps the first", await at("selection"), {
    bottom: ["b1"],
    top: ["a1"],
  });
  check("focus follows the Shift-click", await at("focused"), "bottom");
  check("one frame, in the focused band", [await at("framed", "top"), await at("framed", "bottom")], [false, true]);
  check("every band outlines its own", [await at("members", "top"), await at("members", "bottom")], [1, 1]);

  // One drag moves both, by the same amount on screen.
  await drag(centre(await at("shape", "bottom", "b1")), 60, 20);
  check("the drag moved both diagrams' shapes", [await at("model", "top", "a1"), await at("model", "bottom", "b1")], [
    { x: 140, y: 60 },
    { x: 360, y: 60 },
  ]);
  check("the selection is still both", await at("selection"), { bottom: ["b1"], top: ["a1"] });

  await at("undo");
  await frame();
  check("one undo takes the whole move back", [await at("model", "top", "a1"), await at("model", "bottom", "b1")], [
    { x: 80, y: 40 },
    { x: 300, y: 40 },
  ]);

  // The top of every band holds the gesture together.
  await drag(centre(await at("shape", "bottom", "b1")), 0, -200);
  check("the top holds both", [(await at("model", "top", "a1")).y, (await at("model", "bottom", "b1")).y], [0, 0]);
  await at("undo");
  await frame();

  // Down past the bottom: each band grows under the drag, and keeps it.
  const heights = await drag(centre(await at("shape", "bottom", "b1")), 0, 150, {
    hold: async () => [(await at("band", "top")).height, (await at("band", "bottom")).height],
  });
  check("both bands grow during the drag", heights.map((h) => h > 180), [true, true]);
  check("and keep the height it reached", [(await at("height", "top")) > 180, (await at("height", "bottom")) > 180], [
    true,
    true,
  ]);
  await at("undo");
  await frame();
  check("one undo puts both heights back", [await at("height", "top"), await at("height", "bottom")], [180, 180]);

  // A plain click on empty canvas clears the page.
  const top = await at("band", "top");
  await page.mouse.click(top.left + 20, top.top + 150);
  check("a click on empty canvas clears every diagram", await at("selection"), {});

  // A marquee from empty space in one band reaches into the next.
  const a1 = await at("shape", "top", "a1");
  const b1 = await at("shape", "bottom", "b1");
  await page.mouse.move(a1.left - 20, a1.top - 16);
  await page.mouse.down();
  await page.mouse.move(b1.left + 20, b1.top + 20, { steps: 16 });
  await frame();
  await page.mouse.up();
  check("a marquee across two bands selects in both", await at("selection"), { top: ["a1"], bottom: ["b1"] });
  check("focus is where it started", await at("focused"), "top");

  // The document's zoom: ⌘= steps the page, the bar reads it, and a diagram
  // at 150% still takes a click and a drag in its own px.
  await page.mouse.click(...Object.values(centre(await at("shape", "top", "a2"))));
  const grip = await at("grip", "top");
  check("a selected shape shows its grips", grip > 0, true);
  await at("clear");
  const mod = (await at("apple")) ? "Meta" : "Control";
  check("the page opens at 100%", await at("zoomReadout"), "100%");
  await page.keyboard.press(`${mod}+Equal`);
  await frame();
  check("⌘= zooms the page a step", await at("zoomReadout"), "125%");
  await page.keyboard.press(`${mod}+Equal`);
  await frame();
  check("and another", await at("zoomReadout"), "150%");
  check("the band is drawn at the page's zoom", Math.round((await at("bandScale", "top")) * 100) / 100, 1.5);
  await at("reveal", "top", "a2");
  await frame();
  await page.mouse.click(...Object.values(centre(await at("shape", "top", "a2"))));
  check("at 150%, a click selects the shape under it", await at("selection"), { top: ["a2"] });
  check("its grips keep their size on screen", await at("grip", "top"), grip);
  await drag(centre(await at("shape", "top", "a2")), 90, 30);
  check("a drag moves it by the pointer's distance in the diagram's px", await at("model", "top", "a2"), {
    x: 480,
    y: 60,
  });
  await at("undo");
  await frame();
  await page.keyboard.press(`${mod}+Digit0`);
  await frame();
  check("⌘0 puts the page back at 100%", await at("zoomReadout"), "100%");
  check("and the band at its own size", await at("bandScale", "top"), 1);

  // A pane narrowed under a held pointer — a rail opening on the selection
  // the press made — leaves the band's scale alone until the pointer lets go.
  const held = centre(await at("shape", "top", "a2"));
  await page.mouse.move(held.x, held.y);
  await page.mouse.down();
  await at("paneWidth", 700);
  await frame();
  await frame();
  check("a band under a held pointer keeps its scale", await at("bandScale", "top"), 1);
  await page.mouse.up();
  await frame();
  await frame();
  check("and takes the narrower pane's once it is let go", (await at("bandScale", "top")) < 1, true);
  check("its selection's grips still keep their size on screen", await at("grip", "top"), grip);
  await at("paneWidth", null);
  await frame();
  await frame();
  check("a pane given its width back gives the band its size", await at("bandScale", "top"), 1);
  await at("clear");

  check("no page errors", guards.errors(), []);
  check("no requests off the fixture", guards.requests(), []);
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.log(`  FAIL ${error?.message ?? error}`);
  for (const line of guards?.errors() ?? []) console.log(`    ${line}`);
  const shown = await page?.evaluate(() => ({
    bands: document.querySelectorAll(".nt-canvas").length,
    blocks: document.querySelectorAll(".bn-block-content").length,
  })).catch(() => null);
  if (shown) console.log(`    on the page: ${JSON.stringify(shown)}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const { failed } = summary();
if (failed || failures.length) {
  console.log(`\n${Math.max(failed, failures.length)} canvas page check(s) failed.`);
  process.exit(1);
}
console.log("\nAll canvas page checks passed.");
