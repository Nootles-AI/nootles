/**
 * NT-101: what inline completion is shown of the page, driven through a real
 * BlockNote editor and the real `useTabCompletion`, with `/api/complete`
 * answered by this file — nothing reaches a model.
 *
 * A person types; the request the editor sends is read for what the model
 * would see, a scripted completion is streamed back, and Tab takes it. The
 * cases are the ticket's: a list longer than four items, a long page (the
 * window must fill to the wire's caps and keep the title), and the Complete
 * end's grounding gate, which must accept words from blocks further than four
 * away and from after the caret — and must still turn down an invention.
 * A structural completion is also accepted over the wider window, so a block
 * shown to the model is never compiled as one it deleted.
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
const output = await mkdtemp(path.join(tmpdir(), "completion-window-"));
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

/** What the next `/api/complete` answers with, and every request's body. */
let answer = "";
const requests = [];
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/api/complete") {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(answer);
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
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let browser;
const checks = [];
const errors = [];
const outbound = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.NML_CHROME_PATH ? { executablePath: process.env.NML_CHROME_PATH } : {}),
  });

  const open = async (scenario, reach) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith("data:")) return route.continue();
      outbound.push(url);
      return route.abort();
    });
    // The fixture's Convex client has nowhere to connect; keep it quiet.
    await page.addInitScript(() => {
      window.WebSocket = class extends EventTarget {
        readyState = 0;
        send() {}
        close() {}
      };
    });
    await page.goto(`${origin}/?scenario=${scenario}&reach=${reach}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".bn-editor");
    return page;
  };

  /** Puts the caret at the end of a block and types, the way a person does. */
  const typeAt = async (page, id, typed, completion) => {
    answer = completion;
    const before = requests.length;
    await page.evaluate((id) => window.completionWindow.caretAtEnd(id), id);
    await sleep(100);
    await page.keyboard.type(typed, { delay: 25 });
    const deadline = Date.now() + 8000;
    while (requests.length === before) {
      if (Date.now() > deadline) throw new Error(`no completion request after typing in ${id}`);
      await sleep(50);
    }
    // The answer is streamed back in one piece; give the hook a moment to
    // settle it (parse, gate, compile, draw).
    await sleep(700);
    return requests.at(-1);
  };

  const doc = (page) => page.evaluate(() => window.completionWindow.doc());
  const ghost = (page) => page.evaluate(() => window.completionWindow.ghost());

  // 1. A twelve-item list: the model sees the whole list and its heading, and a
  //    new item taken with Tab lands after item 12 with every item intact.
  {
    const page = await open("list", 1);
    const original = await doc(page);
    const req = await typeAt(page, "li12", ".", "</li>\n<li>Step 13: verify widget13");
    assert.ok(req.before.startsWith("<title>Release checklist</title>"), "title leads the prompt");
    assert.ok(req.before.includes("Launch steps"), "the heading above the list is shown");
    for (let i = 1; i <= 11; i++) {
      assert.ok(req.before.includes(`verify widget${i}<`), `list item ${i} is shown`);
    }
    checks.push("twelve-item-list-shown-whole");
    await page.keyboard.press("Tab");
    await sleep(400);
    const after = await doc(page);
    const items = after.filter((b) => b.type === "numberedListItem");
    assert.equal(items.length, 13, "Tab adds exactly one list item");
    assert.equal(items.at(-1).text, "Step 13: verify widget13");
    for (const o of original) {
      const now = after.find((b) => b.id === o.id);
      assert.ok(now, `block ${o.id} survives the accept`);
      assert.equal(now.text, o.id === "li12" ? `${o.text}.` : o.text, `block ${o.id} is unchanged`);
    }
    checks.push("list-item-accepted-without-touching-the-rest");
    await page.context().close();
  }

  // 2. A 300-paragraph page: the window fills to the wire's caps, keeps the
  //    title, and a prose completion taken with Tab touches only its paragraph.
  {
    const page = await open("long", 1);
    const original = await doc(page);
    const req = await typeAt(page, "p150", " and", " more words");
    assert.ok(req.before.startsWith("<title>Field notes</title>"), "title survives on a long page");
    assert.ok(req.before.length <= 4000, `before fits the wire (${req.before.length})`);
    assert.ok(req.before.length > 3000, `before uses the budget (${req.before.length})`);
    assert.ok(req.after.length <= 1000, `after fits the wire (${req.after.length})`);
    assert.ok(req.after.includes("Paragraph 151 "), "the next paragraph is shown");
    checks.push("long-page-fills-window-and-keeps-title");
    await page.keyboard.press("Tab");
    await sleep(400);
    const after = await doc(page);
    assert.equal(after.length, original.length, "no block added or removed");
    for (const o of original) {
      const now = after.find((b) => b.id === o.id);
      assert.equal(
        now.text,
        o.id === "p150" ? `${o.text} and more words` : o.text,
        `paragraph ${o.id} is as expected`,
      );
    }
    checks.push("long-page-prose-accepted-in-place");
    await page.context().close();
  }

  // 3. Complete end: words from nine blocks up are grounded.
  {
    const page = await open("far", 0);
    const req = await typeAt(page, "caret", " ", "Terraform modules");
    assert.ok(req.before.includes("Kubernetes with Terraform"), "the far paragraph is shown");
    assert.match(await ghost(page), /Terraform modules/, "a grounded completion is offered");
    await page.keyboard.press("Tab");
    await sleep(300);
    const caret = (await doc(page)).find((b) => b.id === "caret");
    assert.equal(caret.text, "Next quarter we migrate the Terraform modules");
    checks.push("complete-grounded-far-above");
    await page.context().close();
  }

  // 4. Complete end: an invention is still turned down.
  {
    const page = await open("far", 0);
    await typeAt(page, "caret", " ", "purple elephants");
    assert.equal(await ghost(page), "", "an ungrounded completion is not offered");
    checks.push("complete-still-refuses-inventions");
    await page.context().close();
  }

  // 5. Complete end: words the page says after the caret are grounded too.
  {
    const page = await open("below", 0);
    const req = await typeAt(page, "caret", " ", "rollout staffing");
    assert.ok(req.after.includes("Rollout checklist and staffing"), "the later paragraph is shown");
    assert.match(await ghost(page), /rollout staffing/, "a completion grounded below is offered");
    checks.push("complete-grounded-below");
    await page.context().close();
  }

  assert.deepEqual(errors, [], "browser emitted no errors");
  assert.deepEqual(outbound, [], "fixture made no external requests");
  console.log(JSON.stringify({ result: "passed", checks, completionRequests: requests.length, paidRequests: 0 }, null, 2));
} catch (error) {
  console.log(JSON.stringify({ result: "failed", passed: checks, error: String(error?.message ?? error) }, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
