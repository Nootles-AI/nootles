/**
 * NT-103: a diagram suggestion whose stream ends early, driven through a real
 * BlockNote editor and the real `useTabCompletion`. `/api/complete` and
 * `/api/diagram` are answered by this file — nothing reaches a model.
 *
 * A person types, the completion asks for a diagram, and the builder's stream
 * is scripted: cut off at the token cap (the stream simply ends, no closing
 * `</nt-diagram>`), dropped mid-stream (the connection dies, as at a
 * `maxDuration` kill), fenced and prefaced, and whole. The preview a person
 * watched build must stay on offer with the shapes that arrived whole, a drop
 * before any shape must take the "Drawing…" chip away rather than leave it
 * standing, and a diagram already taken with Tab keeps what it drew.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "diagram-suggestion-"));
await build({
  absWorkingDir: repo,
  entryPoints: ["tests/completion-window.browser.tsx"],
  bundle: true,
  splitting: true,
  format: "esm",
  outdir: output,
  platform: "browser",
  conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"development"' },
  banner: {
    js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };',
  },
  plugins: [
    {
      name: "browser-stubs",
      setup(builder) {
        builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({
          path: "empty",
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: "export const sync = () => 0; export default { sync };",
        }));
      },
    },
  ],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
  logLevel: "warning",
});
await writeFile(
  path.join(output, "index.html"),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/completion-window.browser.css"><style>body{margin:40px;font-family:Arial,sans-serif}.nt-editor{max-width:760px}</style></head><body><div id="app"></div><script type="module" src="/completion-window.browser.js"></script></body></html>',
);

const BOX = "background: #ffffff; border: 1px solid #d8d8d4; border-radius: 8px";
const OPEN = '<nt-diagram w="600" h="440">';
const S1 = `\n  <nt-rect id="s1" x="200" y="40" w="200" h="56" style="${BOX}">Order received</nt-rect>`;
const S2 = `\n  <nt-polygon id="s2" x="180" y="156" w="240" h="128" sides="4" style="${BOX}">In stock?</nt-polygon>`;
const S3 = `\n  <nt-rect id="s3" x="40" y="344" w="200" h="56" style="${BOX}">Pack and ship</nt-rect>`;
const S4 = `\n  <nt-rect id="s4" x="360" y="344" w="200" h="56" style="${BOX}">Raise backorder</nt-rect>`;
const EDGES = '\n  <nt-edge id="e1" from="s1" to="s2"></nt-edge>\n  <nt-edge id="e2" from="s2" to="s3">yes</nt-edge>';
const CLOSE = "\n</nt-diagram>";
const PLAN = "<!-- plan\nscene: four steps and a decision\nlayout: top to bottom -->\n";

/**
 * How the next `/api/diagram` answers: chunks with a pause before each, then
 * `close` (a clean end, which is what a cap-cut stream is on the wire) or
 * `destroy` (the connection dies).
 */
let script = { chunks: [], end: "close" };
let answer = "";
const completions = [];
const diagrams = [];
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/api/complete" || url.pathname === "/api/diagram") {
      let body = "";
      for await (const chunk of request) body += chunk;
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      if (url.pathname === "/api/complete") {
        completions.push(JSON.parse(body));
        response.end(answer);
        return;
      }
      diagrams.push(JSON.parse(body));
      const mine = script;
      for (const [pause, chunk] of mine.chunks) {
        await sleep(pause);
        if (response.destroyed) return;
        response.write(chunk);
      }
      await sleep(mine.tailMs ?? 0);
      if (mine.end === "destroy") response.destroy();
      else response.end();
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      return void response.end();
    }
    const name = url.pathname === "/" ? "index.html" : path.basename(url.pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader(
      "content-type",
      name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html",
    );
    response.end(data);
  } catch {
    if (!response.headersSent) response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let browser;
const checks = [];
const failures = [];
const errors = [];
const outbound = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.NML_CHROME_PATH ? { executablePath: process.env.NML_CHROME_PATH } : {}),
  });

  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith("data:")) return route.continue();
      outbound.push(url);
      return route.abort();
    });
    await page.addInitScript(() => {
      window.WebSocket = class extends EventTarget {
        readyState = 0;
        send() {}
        close() {}
      };
    });
    await page.goto(`${origin}/?scenario=diagram&reach=1`, { waitUntil: "networkidle" });
    await page.waitForSelector(".bn-editor");
    return page;
  };

  /** What the suggestion looks like on screen right now: the diagram ghost,
   *  loading while it plans or draws, settled once it waits on Tab. */
  const offer = (page) =>
    page.evaluate(() => {
      const el = document.querySelector(".nt-diagram-ghost");
      if (!el) return { shown: false, loading: false, text: "" };
      // The state is said on the caret line; the ghost itself holds only the
      // shapes' own words (the planning label is not a shape).
      const status = document.querySelector(".nt-ghost-status")?.textContent ?? "";
      const words = el.querySelector(".nt-canvas-scene")?.textContent ?? "";
      return { shown: true, loading: el.getAttribute("data-phase") !== "waiting", text: `${status} ${words}`.trim() };
    });
  const canvases = (page) => page.evaluate(() => window.completionWindow.canvases());
  const doc = (page) => page.evaluate(() => window.completionWindow.doc());

  /** Types at the end of the caret paragraph and waits for the builder call. */
  const ask = async (page, diagram) => {
    script = diagram;
    answer = "</p>\n<nt-build-diagram>the order flow with the out-of-stock branch</nt-build-diagram>";
    const before = diagrams.length;
    await page.evaluate(() => window.completionWindow.caretAtEnd("caret"));
    await sleep(100);
    await page.keyboard.type(":", { delay: 25 });
    const deadline = Date.now() + 8000;
    while (diagrams.length === before) {
      if (Date.now() > deadline) throw new Error("no /api/diagram request");
      await sleep(50);
    }
  };
  const until = async (page, test, what, ms = 4000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const now = await offer(page);
      if (test(now)) return now;
      if (Date.now() > deadline) throw new Error(`${what}: ${JSON.stringify(now)}`);
      await sleep(50);
    }
  };
  /**
   * Presses Tab. The caret moves with the accept, which asks for a completion
   * of its own; from here on the page has nothing more to offer.
   */
  const take = async (page) => {
    answer = "";
    await page.keyboard.press("Tab");
  };
  /** The shape ids a canvas holds. */
  const ids = (html) => [...html.matchAll(/<nt-(?:rect|polygon)[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  /** One case; a failure is recorded and the next case still runs. */
  const scenario = async (name, body) => {
    const page = await open();
    try {
      await body(page);
    } catch (error) {
      failures.push({ name, error: String(error?.message ?? error) });
    } finally {
      await page.context().close();
    }
  };

  // 1. Cut off at the token cap: three whole shapes and half a fourth, then
  //    the stream ends. The preview stays on offer with the three, and Tab
  //    places exactly those.
  await scenario("cap-cut", async (page) => {
    await ask(page, {
      chunks: [
        [150, PLAN + OPEN + S1],
        [150, S2],
        [150, S3],
        [150, '\n  <nt-rect id="s4" x="360" y="3'],
      ],
      end: "close",
    });
    await until(page, (o) => o.text.includes("Pack and ship"), "preview builds shape by shape");
    await sleep(800);
    const settled = await offer(page);
    assert.ok(settled.shown, "the cut-off preview is still offered after the stream ends");
    assert.ok(!settled.loading, "and is not left loading");
    assert.match(settled.text, /^Tab\s*to insert/, "the head offers Tab, no longer says it is drawing");
    assert.match(settled.text, /Order received.*In stock\?.*Pack and ship/s);
    checks.push("cap-cut-preview-stays-offered");
    await take(page);
    await sleep(400);
    const [placed] = await canvases(page);
    assert.ok(placed, "Tab placed a diagram");
    assert.deepEqual(ids(placed), ["s1", "s2", "s3"], "the whole shapes, not the severed one");
    await sleep(1500);
    assert.equal((await offer(page)).shown, false, "the offer is gone once taken");
    assert.equal((await doc(page)).find((b) => b.id === "caret").text, "Here is the flow:");
    checks.push("cap-cut-diagram-accepted-with-whole-shapes");
  });

  // 2. The connection drops before any shape arrives: the "Drawing…" chip must
  //    go, not stand on screen for good.
  await scenario("drop-before-shapes", async (page) => {
    await ask(page, { chunks: [[150, PLAN]], tailMs: 300, end: "destroy" });
    await until(page, (o) => o.shown && o.loading, "the loading chip shows while it draws");
    await until(page, (o) => !o.shown, "the loading chip is cleared after the drop", 3000);
    checks.push("drop-before-shapes-clears-chip");
  });

  // 3. The connection drops after shapes arrived: the preview a person watched
  //    build is still an offer, and Tab takes it.
  await scenario("drop-after-shapes", async (page) => {
    await ask(page, {
      chunks: [
        [150, PLAN + OPEN + S1],
        [150, S2],
      ],
      tailMs: 300,
      end: "destroy",
    });
    await until(page, (o) => o.text.includes("In stock?"), "preview builds before the drop");
    await sleep(800);
    const settled = await offer(page);
    assert.ok(settled.shown && !settled.loading, "the preview survives the drop");
    assert.match(settled.text, /^Tab\s*to insert/, "and is offered for Tab");
    await take(page);
    await sleep(400);
    const [placed] = await canvases(page);
    assert.ok(placed, "Tab placed the diagram after the drop");
    assert.deepEqual(ids(placed), ["s1", "s2"]);
    checks.push("drop-after-shapes-still-offered-and-accepted");
  });

  // 4. Taken with Tab mid-stream, then the connection drops: the block keeps
  //    everything it had drawn, and the lane keeps working afterwards.
  await scenario("placed-then-dropped", async (page) => {
    await ask(page, {
      chunks: [
        [150, PLAN + OPEN + S1],
        [900, S2],
        [150, S3],
      ],
      tailMs: 300,
      end: "destroy",
    });
    await until(page, (o) => o.text.includes("Order received"), "first shape previewed");
    await take(page);
    await sleep(1800);
    const [placed] = await canvases(page);
    assert.ok(placed, "Tab placed the diagram mid-stream");
    assert.deepEqual(ids(placed), ["s1", "s2", "s3"], "the placed block filled in until the drop");
    checks.push("placed-then-dropped-keeps-drawn-shapes");
  });

  // 5. A fenced, prefaced reply: previewed while it streams, offered whole.
  await scenario("fenced", async (page) => {
    await ask(page, {
      chunks: [
        [150, "Here is the diagram:\n```html\n" + PLAN + OPEN + S1 + S2],
        [1200, S3 + S4 + EDGES + CLOSE + "\n```\n"],
      ],
      end: "close",
    });
    // Before the second chunk, which is 1.35 s out.
    await until(page, (o) => o.text.includes("In stock?"), "the fenced reply is previewed as it streams", 1000);
    await until(page, (o) => /^Tab\s*to insert.*Raise backorder/s.test(o.text), "then offered whole");
    await sleep(500);
    await take(page);
    await sleep(400);
    const [placed] = await canvases(page);
    assert.deepEqual(ids(placed), ["s1", "s2", "s3", "s4"]);
    assert.match(placed, /<nt-edge[^>]*id="e2"/, "edges come through");
    assert.ok(!placed.includes("```") && !placed.includes("Here is"), "no fence or preface in the block");
    checks.push("fenced-reply-previewed-and-accepted");
  });

  // 6. Control: an ordinary whole reply is offered and accepted.
  await scenario("whole", async (page) => {
    await ask(page, {
      chunks: [
        [150, PLAN + OPEN + S1 + S2],
        [150, S3 + S4 + EDGES + CLOSE],
      ],
      end: "close",
    });
    await until(page, (o) => /^Tab\s*to insert.*Raise backorder/s.test(o.text), "whole reply offered for Tab");
    await sleep(500);
    await take(page);
    await sleep(400);
    const [placed] = await canvases(page);
    assert.deepEqual(ids(placed), ["s1", "s2", "s3", "s4"]);
    assert.match(placed, /<nt-edge[^>]*id="e1"/);
    checks.push("whole-reply-accepted");
  });

  // A dropped connection is a failed fetch, which the browser reports as a
  // console error, not a page error; anything thrown into the page is a bug.
  assert.deepEqual(failures, [], "every case passed");
  assert.deepEqual(errors, [], "browser emitted no page errors");
  assert.deepEqual(outbound, [], "fixture made no external requests");
  console.log(
    JSON.stringify(
      { result: "passed", checks, diagramRequests: diagrams.length, paidRequests: 0 },
      null,
      2,
    ),
  );
} catch (error) {
  console.log(JSON.stringify({ result: "failed", passed: checks, failures, error: String(error?.message ?? error) }, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
