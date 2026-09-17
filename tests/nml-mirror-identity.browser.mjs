/**
 * Regression for identity hydration across the canonical-NML compatibility
 * mirror. A real Chromium page types into BlockNote, receives a deliberately
 * unfinished completion, hydrates identity, and proves the editor, selection,
 * ghost and request all survive. It then checks late-bound human/model
 * attribution, non-served Yjs, and teardown on a true document replacement.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "nml-mirror-identity-"));
await build({
  absWorkingDir: repo,
  entryPoints: ["tests/nml-mirror-identity.browser.tsx"],
  bundle: true,
  splitting: true,
  format: "esm",
  outdir: output,
  platform: "browser",
  conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json",
  define: {
    "process.env.NODE_ENV": '"development"',
    "process.env.NEXT_PUBLIC_YJS": '"1"',
  },
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
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/nml-mirror-identity.browser.css"><style>body{margin:40px;font-family:Arial,sans-serif}.nt-editor{max-width:760px}</style></head><body><div id="app"></div><script type="module" src="/nml-mirror-identity.browser.js"></script></body></html>',
);

const completions = [];
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      return void response.end();
    }
    if (url.pathname === "/api/complete") {
      const completion = {
        response,
        finished: false,
        closed: false,
        aborted: false,
      };
      completions.push(completion);
      response.on("close", () => {
        completion.closed = true;
        completion.aborted = !completion.finished;
      });
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.write(" continued");
      return;
    }
    const name = url.pathname === "/" ? "index.html" : path.basename(url.pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader(
      "content-type",
      name.endsWith(".js")
        ? "text/javascript"
        : name.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const finish = (completion) => {
  completion.finished = true;
  completion.response.end();
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let browser;
try {
  const { default: puppeteer } = await import(
    process.env.NML_PUPPETEER_MODULE || "puppeteer"
  );
  browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(process.env.NML_CHROME_PATH
      ? { executablePath: process.env.NML_CHROME_PATH }
      : {}),
  });
  const errors = [];
  const outbound = [];

  const openFixture = async (enabled) => {
    const page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.url().startsWith(origin) || req.url().startsWith("data:")) {
        return void req.continue();
      }
      outbound.push(req.url());
      req.abort();
    });
    await page.evaluateOnNewDocument(() => {
      window.WebSocket = class extends EventTarget {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        readyState = 0;
        send() {
          throw new Error("Fixture socket must never send");
        }
        close() {
          this.readyState = 3;
        }
      };
    });
    await page.goto(`${origin}/?enabled=${enabled ? "1" : "0"}`, {
      waitUntil: "networkidle0",
    });
    await page.waitForSelector(".bn-editor");
    return page;
  };

  const typeForCompletion = async (page, text = "!") => {
    await page.click(".bn-inline-content");
    await page.keyboard.press("End");
    await page.keyboard.type(text, { delay: 20 });
  };

  // Served canonical NML: the open stream and all local editor state survive
  // the anonymous -> signed-in transition.
  const served = await openFixture(true);
  assert.equal(
    (await served.evaluate(() => window.nmlMirrorIdentity.probe())).lifecycle
      .mirrorStarts,
    1,
    "served mount starts one compatibility mirror",
  );
  await typeForCompletion(served);
  await served.waitForSelector(".nt-ghost");
  await served.waitForFunction(
    () => document.querySelector(".nt-ghost")?.textContent?.includes("continued"),
  );
  assert.equal(completions.length, 1, "typing starts one completion request");
  const first = completions[0];
  const beforeIdentity = await served.evaluate(() =>
    window.nmlMirrorIdentity.capture(),
  );
  assert.equal(beforeIdentity.lifecycle.surfaceMounts, 1);
  assert.equal(beforeIdentity.lifecycle.surfaceUnmounts, 0);
  assert.equal(first.closed, false, "the streamed response is deliberately open");

  await served.evaluate(() =>
    window.nmlMirrorIdentity.updateIdentity("real-user"),
  );
  await served.waitForFunction(
    () => window.nmlMirrorIdentity.probe().userId === "real-user",
  );
  await sleep(150);
  const afterIdentity = await served.evaluate(() =>
    window.nmlMirrorIdentity.probe(),
  );
  assert.equal(afterIdentity.editorSame, true, "identity keeps the editor object");
  assert.equal(afterIdentity.domSame, true, "identity keeps the editor DOM node");
  assert.equal(afterIdentity.selectionSame, true, "identity keeps the selection");
  assert.equal(afterIdentity.lifecycle.surfaceMounts, 1, "surface does not remount");
  assert.equal(afterIdentity.lifecycle.surfaceUnmounts, 0, "surface does not unmount");
  assert.equal(afterIdentity.lifecycle.mirrorStarts, 1, "mirror is not recreated");
  assert.equal(afterIdentity.lifecycle.mirrorStops, 0, "mirror is not stopped");
  assert.deepEqual(afterIdentity.lifecycle.ready, [false, true]);
  assert.match(afterIdentity.ghost, /continued/, "the visible completion survives");
  assert.equal(first.closed, false, "the completion request remains open");

  finish(first);
  await served.waitForFunction(
    () => document.querySelector(".nt-ghost")?.textContent?.includes("continued"),
  );
  await sleep(500);
  assert.equal(first.aborted, false, "the stream finishes normally after hydration");

  // The stable mirror still reads identity at the transaction boundary.
  await served.evaluate(() => window.nmlMirrorIdentity.clearActors());
  await served.click(".bn-inline-content");
  await served.keyboard.press("End");
  await served.keyboard.type(" human", { delay: 15 });
  await served.waitForFunction(
    () => window.nmlMirrorIdentity.probe().actors.length > 0,
  );
  let actors = await served.evaluate(
    () => window.nmlMirrorIdentity.probe().actors,
  );
  assert.equal(actors.at(-1).kind, "human");
  assert.equal(actors.at(-1).userId, "real-user");

  await served.evaluate(() => window.nmlMirrorIdentity.clearActors());
  await served.evaluate(() => window.nmlMirrorIdentity.aiEdit(" model"));
  await served.waitForFunction(
    () => window.nmlMirrorIdentity.probe().actors.length > 0,
  );
  actors = await served.evaluate(() => window.nmlMirrorIdentity.probe().actors);
  assert.equal(actors.at(-1).kind, "model");
  assert.equal(actors.at(-1).userId, "real-user");
  assert.equal(
    (await served.evaluate(() => window.nmlMirrorIdentity.probe())).lifecycle
      .mirrorStarts,
    1,
    "attribution advances without constructing another mirror",
  );

  // A true owner change remains destructive: its request is aborted, the old
  // surface leaves, and a fresh mirror/readiness cycle owns the new document.
  await served.waitForFunction(() => document.querySelector(".nt-ghost"));
  await served.waitForFunction(() => window.nmlMirrorIdentity.probe().ghost.includes("continued"));
  assert.equal(completions.length, 2, "a later edit starts the teardown control request");
  const second = completions[1];
  const oldDocument = (
    await served.evaluate(() => window.nmlMirrorIdentity.capture())
  ).documentId;
  await served.evaluate(() => window.nmlMirrorIdentity.replaceDocument());
  await served.waitForFunction(
    (documentId) => {
      const state = window.nmlMirrorIdentity.probe();
      return state.documentId !== documentId && state.ready;
    },
    {},
    oldDocument,
  );
  await served.waitForSelector(".bn-editor");
  await sleep(100);
  const replaced = await served.evaluate(() => window.nmlMirrorIdentity.probe());
  assert.equal(second.aborted, true, "real document replacement aborts old completion");
  assert.equal(replaced.editorSame, false, "replacement owns a new editor");
  assert.equal(replaced.domSame, false, "replacement owns new editor DOM");
  assert.equal(replaced.lifecycle.mirrorStarts, 2, "replacement starts a fresh mirror");
  assert.equal(replaced.lifecycle.mirrorStops, 1, "replacement stops the old mirror");
  assert.equal(replaced.lifecycle.surfaceMounts, 2, "replacement mounts a fresh surface");
  assert.equal(replaced.lifecycle.surfaceUnmounts, 1, "replacement unmounts the old surface");
  assert.deepEqual(
    replaced.lifecycle.ready,
    [false, true, false, true],
    "replacement gets its own readiness cycle",
  );
  assert.match(replaced.text, /identity-document-2/);

  // Ordinary, non-served Yjs is a separate browser instance: the hook is
  // disabled and identity remains an in-place metadata update.
  const unserved = await openFixture(false);
  await typeForCompletion(unserved, "?");
  await unserved.waitForFunction(
    () => window.nmlMirrorIdentity.probe().ghost.includes("continued"),
  );
  assert.equal(completions.length, 3, "non-served Yjs also starts completion");
  const third = completions[2];
  await unserved.evaluate(() => window.nmlMirrorIdentity.capture());
  await unserved.evaluate(() =>
    window.nmlMirrorIdentity.updateIdentity("ordinary-user"),
  );
  await unserved.waitForFunction(
    () => window.nmlMirrorIdentity.probe().userId === "ordinary-user",
  );
  await sleep(150);
  const unservedHydrated = await unserved.evaluate(() =>
    window.nmlMirrorIdentity.probe(),
  );
  assert.equal(unservedHydrated.editorSame, true);
  assert.equal(unservedHydrated.domSame, true);
  assert.equal(unservedHydrated.selectionSame, true);
  assert.equal(unservedHydrated.lifecycle.surfaceMounts, 1);
  assert.equal(unservedHydrated.lifecycle.surfaceUnmounts, 0);
  assert.equal(unservedHydrated.lifecycle.mirrorStarts, 0);
  assert.equal(unservedHydrated.lifecycle.mirrorStops, 0);
  assert.match(unservedHydrated.ghost, /continued/);
  assert.equal(third.closed, false);
  finish(third);
  await sleep(500);
  assert.equal(third.aborted, false);

  assert.deepEqual(errors, [], "browser emitted no errors");
  assert.deepEqual(outbound, [], "fixture made no external requests");
  console.log(
    JSON.stringify(
      {
        result: "passed",
        checks: [
          "served-stream-survives-identity-hydration",
          "editor-dom-selection-and-readiness-stay-stable",
          "human-attribution-uses-hydrated-user",
          "ai-attribution-remains-model",
          "real-document-change-tears-down-and-aborts",
          "non-served-yjs-control-stays-stable",
        ],
        completionRequests: completions.length,
        paidRequests: 0,
      },
      null,
      2,
    ),
  );
} finally {
  for (const completion of completions) {
    if (!completion.closed) finish(completion);
  }
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
