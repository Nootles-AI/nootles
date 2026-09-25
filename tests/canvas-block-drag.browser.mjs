import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { repo, writeAppStylesheet } from "./canvas-harness.mjs";

const output = await mkdtemp(path.join(tmpdir(), "canvas-block-drag-"));
const { chromium } = await import("playwright");

await build({
  absWorkingDir: repo,
  entryPoints: ["tests/canvas-block-drag.browser.tsx"],
  bundle: true,
  splitting: true,
  format: "esm",
  outdir: output,
  platform: "browser",
  conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json",
  define: {
    "process.env.NODE_ENV": '"development"',
  },
  banner: {
    js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };',
  },
  plugins: [
    {
      name: "browser-stubs",
      setup(builder) {
        builder.onResolve(
          { filter: /^next\/dist\/compiled\/gzip-size$/ },
          () => ({ path: "server-only", namespace: "fixture" }),
        );
        builder.onLoad(
          { filter: /.*/, namespace: "fixture" },
          () => ({
            contents:
              'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached the browser fixture") };',
          }),
        );
      },
    },
  ],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
  logLevel: "warning",
});

// The app's own `:root`, not a stand-in. `editor.css` points BlockNote's menu
// surface at `--elevated` and its ink at `--foreground`, so a fixture that
// declares neither makes the themed dropdown compute `transparent` — which is
// what the NT-52 check below read as a regression for five days (NT-72).
await writeAppStylesheet(output);

await writeFile(
  path.join(output, "index.html"),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/canvas-block-drag.browser.css"><style>html,body{height:100%}</style></head><body><div id="app"></div><script type="module" src="/canvas-block-drag.browser.js"></script></body></html>',
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
      name.endsWith(".js")
        ? "text/javascript"
        : name.endsWith(".css")
          ? "text/css"
          : name.endsWith(".html")
            ? "text/html"
            : "application/octet-stream",
    );
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const expectedInitial = [
  "heading:heading",
  "canvas:canvas",
  "paragraph:paragraph",
];
const expectedMoved = [
  "heading:heading",
  "paragraph:paragraph",
  "canvas:canvas",
];
const expectedCanvasMaps = [{ name: "canvas:canvas", populated: true }];
const errors = [];
const outbound = [];
let browser;

async function hoverCanvas(page) {
  const canvas = await page.evaluate(() => window.canvasBlockDrag.rectOf("canvas"));
  assert.ok(canvas, "the real canvas block is mounted");
  await page.mouse.move(canvas.left + 20, canvas.top + 30);
  await page.waitForFunction(() => window.canvasBlockDrag.handleRect() !== null);
}

async function dragCanvas(page, position) {
  await hoverCanvas(page);
  const handle = await page.evaluate(() => window.canvasBlockDrag.handleRect());
  const paragraph = await page.evaluate(() =>
    window.canvasBlockDrag.rectOf("paragraph"),
  );
  assert.ok(handle && paragraph, "the gutter grip and paragraph are measurable");
  const from = {
    x: handle.left + handle.width / 2,
    y: handle.top + handle.height / 2,
  };
  const to = {
    x: paragraph.left + Math.min(80, paragraph.width / 2),
    y:
      position === "after"
        ? paragraph.bottom + 12
        : paragraph.top + Math.min(6, paragraph.height / 4),
  };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 18 });
  await page.mouse.up();
  const expected = position === "after" ? expectedMoved : expectedInitial;
  try {
    await page.waitForFunction(
      (order) =>
        JSON.stringify(window.canvasBlockDrag.snapshot().ids) ===
        JSON.stringify(order),
      expected,
      { timeout: 5_000 },
    );
  } catch (error) {
    const observed = await page.evaluate(() => window.canvasBlockDrag.snapshot());
    throw new Error(
      `canvas drag ${position} did not reorder: ${JSON.stringify(observed)}`,
      { cause: error },
    );
  }
  await page.evaluate(() => window.canvasBlockDrag.settle());
}

try {
  browser = await chromium.launch({
    headless: true,
    channel:
      process.env.CANVAS_BROWSER_CHANNEL === "headless-shell"
        ? undefined
        : "chromium",
    executablePath: process.env.CANVAS_CHROME_PATH || undefined,
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.on("pageerror", (error) =>
    errors.push(`pageerror: ${error.stack || error.message}`),
  );
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      errors.push(`console ${message.type()}: ${message.text()}`);
    }
  });
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith("data:")) {
      return route.continue();
    }
    outbound.push(url);
    return route.abort();
  });
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
  await page.goto(origin, { waitUntil: "networkidle0" });
  await page.waitForSelector(".bn-editor");
  await page.waitForFunction(() => window.canvasBlockDrag.snapshot().alive);

  const before = await page.evaluate(() => window.canvasBlockDrag.snapshot());
  assert.deepEqual(before.ids, expectedInitial);
  assert.deepEqual(before.canonicalIds, expectedInitial);
  assert.deepEqual(before.canvasMaps, expectedCanvasMaps);
  assert.deepEqual(before.sceneNodes, ["shape-a@40,40"]);

  // NT-52 remains fixed: the handle is in a body-level, z-index 20 portal and
  // beats a z-index 10 sibling of the isolated document column.
  await hoverCanvas(page);
  const portal = await page.evaluate(() => window.canvasBlockDrag.portalState());
  assert.equal(portal.portalParent, "BODY");
  assert.ok(portal.portalClasses.includes("bn-root"));
  assert.ok(portal.portalClasses.includes("bn-mantine"));
  assert.equal(portal.colorScheme, "light");
  assert.equal(portal.mantineColorScheme, "light");
  assert.equal(portal.handleInEditorPortal, true);
  assert.equal(portal.handleWithinEditor, true);
  assert.equal(
    await page.evaluate(() => window.canvasBlockDrag.installStackingObstacle()),
    "Block actions",
  );
  await page.evaluate(() => window.canvasBlockDrag.removeStackingObstacle());

  // The escaped dropdown keeps the Mantine/BlockNote theme scope that the
  // original NT-52 body portal lost: `editor.css`'s `.bn-root.bn-mantine`
  // block still reaches it, so its paper, ink and hairline are the app's own
  // and not BlockNote's defaults. Asserting the app's values rather than
  // "some background" is the point — the weaker check passed against
  // BlockNote's own white for as long as a fixture happened to load it.
  const handleSelector = 'button[aria-label="Block actions"]';
  await page.click(handleSelector);
  await page.waitForSelector(".bn-drag-handle-menu");
  const menuTheme = await page.evaluate(() => window.canvasBlockDrag.menuTheme());
  assert.ok(menuTheme, "the block-actions dropdown opened");
  for (const [property, value] of Object.entries(menuTheme.app)) {
    assert.notEqual(value, "rgba(0, 0, 0, 0)", `the app declares ${property}`);
  }
  assert.deepEqual(
    {
      backgroundColor: menuTheme.backgroundColor,
      borderColor: menuTheme.borderColor,
      color: menuTheme.color,
    },
    menuTheme.app,
  );
  await page.keyboard.press("Escape");
  await page.waitForSelector(".bn-drag-handle-menu", { state: "hidden" });

  // A person drags the actual gutter grip below the paragraph. Identity must
  // survive through BlockNote, canonical NML, the CRDT map and the live store.
  await dragCanvas(page, "after");
  const afterDown = await page.evaluate(() => window.canvasBlockDrag.snapshot());
  assert.deepEqual(afterDown.ids, expectedMoved);
  assert.deepEqual(afterDown.canonicalIds, expectedMoved);
  assert.deepEqual(afterDown.canvasMaps, expectedCanvasMaps);
  assert.deepEqual(afterDown.sceneNodes, ["shape-a@40,40"]);
  assert.equal(afterDown.alive, true);

  // Move the same populated canvas back again. Repeated internal reorders must
  // remain moves, never accumulate identity-keyed state.
  await dragCanvas(page, "before");
  const afterUp = await page.evaluate(() => window.canvasBlockDrag.snapshot());
  assert.deepEqual(afterUp.ids, expectedInitial);
  assert.deepEqual(afterUp.canonicalIds, expectedInitial);
  assert.deepEqual(afterUp.canvasMaps, expectedCanvasMaps);
  assert.deepEqual(afterUp.sceneNodes, ["shape-a@40,40"]);
  assert.equal(afterUp.alive, true);

  const screenshot = path.join(output, "canvas-block-drag.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(outbound, []);
  console.log(
    JSON.stringify(
      {
        result: "passed",
        checks: [
          "real-pointer-drag-down-and-back",
          "stable-blocknote-id",
          "stable-canonical-nml-id",
          "single-populated-canvas-map",
          "preserved-live-scene",
          "escaped-stacking-context",
          "themed-menu",
          "no-browser-errors",
          "no-external-requests",
        ],
        screenshot,
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
