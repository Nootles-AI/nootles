/**
 * A page's comments document syncing between two people, driven through real
 * Chromium keyboard and mouse input (docs/commenting-plan.md, PR 1: "a
 * comments Y.Doc that persists and syncs with no UI at all").
 *
 * Two real `YConvexProvider`s on the comments doc (derived writes and presence
 * off) and two on the page doc (defaults), over one stand-in Convex backend.
 * Ada starts a thread; Bram sees it on his replica and replies; Ada sees the
 * reply and resolves; a fresh load of the stored log reads the same thread.
 * Throughout, the comments doc must reach no presence, preview or digest
 * function — while the page doc beside it still does, so the harness would
 * notice if the opt-out swallowed everything.
 *
 * No app server, no Convex, no API keys; every off-origin request fails the
 * run, and the WebSocket is inert.
 *
 *   node tests/comments-channel.browser.mjs
 *
 * Uses system Chrome (`channel: "chrome"`); `COMMENTS_BROWSER_CHANNEL=chromium`
 * or `COMMENTS_CHROME_PATH` picks another.
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./comments-launch.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "comments-channel-"));

for (const key of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "MISTRAL_API_KEY", "RECRAFT_API_KEY"]) {
  delete process.env[key];
}

await build({
  absWorkingDir: repo, entryPoints: ["tests/comments-channel.browser.tsx"], bundle: true, splitting: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import"],
  tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  logLevel: "warning",
});
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;font-family:Arial,sans-serif;display:flex;gap:16px;padding:16px}
  section{flex:1;border:1px solid #ddd;padding:12px}
  textarea{width:100%;height:48px}
</style></head><body>
  <section id="a"><h2>Ada</h2><textarea id="a-body"></textarea>
    <button id="a-start">Comment</button><button id="a-reply">Reply</button><button id="a-resolve">Resolve</button>
    <ul id="a-threads"></ul></section>
  <section id="b"><h2>Bram</h2><textarea id="b-body"></textarea>
    <button id="b-start">Comment</button><button id="b-reply">Reply</button><button id="b-resolve">Resolve</button>
    <ul id="b-threads"></ul></section>
  <script type="module" src="/comments-channel.browser.js"></script>
</body></html>`);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") { response.writeHead(204); return void response.end(); }
    const name = pathname === "/" ? "index.html" : path.basename(pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".html") ? "text/html" : "application/octet-stream");
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return void console.log(`  ok   ${name}`);
  failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
  console.log(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`);
};

const COMMENTS_DOC = "comments-doc-1";
const PAGE_DOC = "page-doc-1";
const FORBIDDEN = ["presence:heartbeat", "presence:list", "presence:roster", "presence:leave", "previews:set", "previews:get", "context/pages:digest", "ydoc:init"];

let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") failures.push(`console ${message.type()}: ${message.text()}`);
  });
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith("data:")) return route.continue();
    failures.push(`request left the fixture: ${url}`);
    return route.abort();
  });
  await page.addInitScript(() => {
    window.WebSocket = class extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0;
      send() { throw new Error("Fixture socket must never send"); }
      close() { this.readyState = 3; }
    };
  });

  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.ntComments);
  await page.evaluate(() => window.ntComments.mount());

  // --- Ada starts a thread -------------------------------------------------
  await page.click("#a-body");
  await page.keyboard.type("Is Friday realistic?", { delay: 8 });
  await page.click("#a-start");
  await page.waitForFunction(() => window.ntComments.threads("b").length === 1, null, { timeout: 5000 });
  check("Bram's replica receives Ada's thread", await page.evaluate(() => window.ntComments.threads("b").map((t) => ({
    id: t.id, exact: t.anchor.exact, blockId: t.anchor.blockId, status: t.status,
    comments: t.comments.map((c) => [c.authorId, c.content.map((r) => r.text).join("")]),
  }))), [{ id: "t1-a", exact: "by Friday", blockId: "p_7f3a", status: "open", comments: [["user_ada", "Is Friday realistic?"]] }]);
  check("and draws it", await page.textContent("#b-threads li"), "“by Friday” — user_ada: Is Friday realistic?");

  // --- Bram replies --------------------------------------------------------
  await page.click("#b-body");
  await page.keyboard.type("Only if design signs off Thursday.", { delay: 8 });
  await page.click("#b-reply");
  await page.waitForFunction(() => window.ntComments.threads("a")[0]?.comments.length === 2, null, { timeout: 5000 });
  check("Ada's replica receives Bram's reply, in order", await page.evaluate(() =>
    window.ntComments.threads("a")[0].comments.map((c) => c.authorId)), ["user_ada", "user_bram"]);

  // --- Ada resolves ---------------------------------------------------------
  await page.click("#a-resolve");
  await page.waitForFunction(() => window.ntComments.threads("b")[0]?.status === "resolved", null, { timeout: 5000 });
  check("Bram sees it resolved, by Ada", await page.evaluate(() => {
    const [t] = window.ntComments.threads("b");
    return { status: t.status, resolvedBy: t.resolvedBy, stamped: typeof t.resolvedAt === "number" };
  }), { status: "resolved", resolvedBy: "user_ada", stamped: true });

  // --- both start threads of their own --------------------------------------
  await page.click("#a-body");
  await page.keyboard.type("Also: who owns QA?", { delay: 4 });
  await page.click("#a-start");
  await page.click("#b-body");
  await page.keyboard.type("Budget line is stale.", { delay: 4 });
  await page.click("#b-start");
  await page.waitForFunction(() => window.ntComments.threads("a").length === 3 && window.ntComments.threads("b").length === 3, null, { timeout: 5000 });
  check("both replicas hold all three threads", await page.evaluate(() => window.ntComments.threads("b").map((t) => t.comments[0].content[0].text)),
    ["Is Friday realistic?", "Also: who owns QA?", "Budget line is stale."]);

  // --- and two written in the same instant, before either has synced --------
  await page.evaluate(() => window.ntComments.concurrent());
  await page.waitForFunction(() => window.ntComments.threads("a").length === 5 && window.ntComments.threads("b").length === 5, null, { timeout: 5000 });
  const idsA = await page.evaluate(() => window.ntComments.threads("a").map((t) => t.id));
  const idsB = await page.evaluate(() => window.ntComments.threads("b").map((t) => t.id));
  check("concurrent threads converge to one order on both replicas", idsA, idsB);

  // --- the stored log is the document ---------------------------------------
  await page.waitForTimeout(800);
  check("a fresh load of the stored log reads the same threads", await page.evaluate((id) =>
    window.ntComments.reload(id).map((t) => [t.id, t.status, t.comments.length]), COMMENTS_DOC),
    await page.evaluate(() => window.ntComments.threads("a").map((t) => [t.id, t.status, t.comments.length])));

  // --- the page doc beside it behaves as a page -----------------------------
  await page.evaluate(() => window.ntComments.pageEdit("page text"));
  await page.waitForTimeout(11_000); // past one presence keepalive
  await page.evaluate(() => window.ntComments.leave());
  await page.waitForTimeout(300);

  const calls = await page.evaluate(() => window.ntComments.calls());
  const onComments = calls.filter((c) => c.docId === COMMENTS_DOC);
  const onPage = calls.filter((c) => c.docId === PAGE_DOC);
  check("the comments doc reached no presence, preview, digest or init function",
    onComments.filter((c) => FORBIDDEN.includes(c.name)).map((c) => `${c.kind} ${c.name}`), []);
  check("the comments doc watched only its version channel",
    [...new Set(onComments.filter((c) => c.kind === "watch").map((c) => c.name))], ["ydoc:meta"]);
  check("its writes were appends", [...new Set(onComments.filter((c) => c.kind === "mutation").map((c) => c.name))], ["ydoc:append"]);
  check("while the page doc still watched and announced presence",
    ["presence:list", "presence:heartbeat", "presence:leave"].every((name) => onPage.some((c) => c.name === name)), true);

  await page.screenshot({ path: path.join(output, "comments-channel.png") });
  console.log(`\nscreenshot: ${path.join(output, "comments-channel.png")}`);
} finally {
  await browser?.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} failure(s):\n${failures.join("\n")}` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
