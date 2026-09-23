/**
 * The comments store through the hook a surface will use, driven by real
 * Chromium keyboard and mouse input.
 *
 * Ada opens a page nobody has commented on: nothing is minted until she
 * writes, and her first comment mints the comments document, syncs it, and
 * lands in it. Bram, a second replica with his own real `YConvexProvider`,
 * sees each of her actions on his Y.Doc — thread, edit, resolve, undo, redo —
 * and she sees his reply through the hook. His anchor maintenance survives
 * her undo. Vera holds the page without the right to comment: her hook reads,
 * refuses to write, and never calls `comments:ensureDoc`.
 *
 * No app server, no Convex, no API keys; every off-origin request fails the
 * run, and the WebSocket is inert.
 *
 *   node tests/comments-store.browser.mjs
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
const output = await mkdtemp(path.join(tmpdir(), "comments-store-"));

for (const key of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "MISTRAL_API_KEY", "RECRAFT_API_KEY"]) {
  delete process.env[key];
}

await build({
  absWorkingDir: repo, entryPoints: ["tests/comments-store.browser.tsx"], bundle: true, splitting: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import"], jsx: "automatic",
  tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  logLevel: "warning",
});
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;font-family:Arial,sans-serif;display:flex;gap:16px;padding:16px}
  body>div,body>section{flex:1;border:1px solid #ddd;padding:12px}
  textarea{width:100%;height:48px}
</style></head><body>
  <div id="ada"></div>
  <section id="bram"><h2>bram</h2><textarea id="bram-body"></textarea><button id="bram-reply">Reply</button><ul id="bram-threads"></ul></section>
  <div id="vera"></div>
  <script type="module" src="/comments-store.browser.js"></script>
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

const FORBIDDEN = ["presence:heartbeat", "presence:list", "presence:roster", "presence:leave", "previews:set", "context/pages:digest", "ydoc:init"];

let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1300, height: 800 } });
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

  const ensureCalls = async () => (await page.evaluate(() => window.ntStore.calls()))
    .filter((call) => call.name === "comments:ensureDoc").map((call) => `${call.who} ${call.args.pageId}`);
  const bramThreads = () => page.evaluate(() => window.ntStore.bramThreads().map((t) => ({
    id: t.id, status: t.status, resolvedBy: t.resolvedBy ?? null, block: t.anchor.blockId,
    comments: t.comments.map((c) => `${c.authorId}: ${c.content.map((r) => r.text).join("")}${c.editedAt ? " (edited)" : ""}`),
  })));

  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.ntStore);
  await page.evaluate(() => window.ntStore.mount());

  // --- nobody has commented: opening the page mints nothing ------------------
  await page.waitForFunction(() => document.getElementById("ada-status")?.textContent === "absent"
    && document.getElementById("vera-status")?.textContent === "absent");
  await page.waitForTimeout(300);
  check("both pages read as having no comments", [await page.textContent("#ada-status"), await page.textContent("#vera-status")], ["absent", "absent"]);
  check("and opening them minted nothing", await ensureCalls(), []);

  // --- Vera may read but not write --------------------------------------------
  await page.click("#vera-body");
  await page.keyboard.type("Can I comment?", { delay: 5 });
  await page.click("#vera-comment");
  await page.waitForSelector("#vera-error");
  check("Vera's attempt is refused in words", await page.textContent("#vera-error"), "You can read these comments but not add to them.");
  check("and still nothing was minted", await ensureCalls(), []);
  check("her page still has no comments document", await page.evaluate(() => window.ntStore.pages()["page-2"]), null);

  // --- Ada's first comment mints the document and lands in it ----------------
  await page.click("#ada-body");
  await page.keyboard.type("Is Friday realistic?", { delay: 8 });
  await page.click("#ada-comment");
  await page.waitForFunction(() => document.querySelectorAll("[data-testid=ada-threads] li").length === 1, null, { timeout: 5000 });
  check("Ada's first write minted exactly once, for her page", await ensureCalls(), ["ada page-1"]);
  check("her hook reports the document ready", await page.textContent("#ada-status"), "ready");
  check("and draws her thread", await page.textContent("[data-testid=ada-threads] li"), "“by Friday” [open] — user_ada: Is Friday realistic?");
  check("the composer cleared", await page.inputValue("#ada-body"), "");

  // --- Bram joins as a second replica ----------------------------------------
  await page.evaluate(() => window.ntStore.joinBram());
  const [created] = await bramThreads();
  check("Bram's replica holds Ada's thread", { status: created.status, comments: created.comments }, { status: "open", comments: ["user_ada: Is Friday realistic?"] });

  // --- Bram replies; Ada sees it through the hook -----------------------------
  await page.click("#bram-body");
  await page.keyboard.type("Only if design signs off Thursday.", { delay: 5 });
  await page.click("#bram-reply");
  await page.waitForFunction(() => document.querySelector("[data-testid=ada-threads] li")?.textContent?.includes("user_bram"), null, { timeout: 5000 });
  check("Ada's list shows Bram's reply, in order", await page.textContent("[data-testid=ada-threads] li"),
    "“by Friday” [open] — user_ada: Is Friday realistic? / user_bram: Only if design signs off Thursday.");

  // --- Ada edits her comment ---------------------------------------------------
  await page.click("#ada-body");
  await page.keyboard.type("Is Friday realistic for QA?", { delay: 5 });
  await page.click("#ada-edit");
  await page.waitForFunction(() => window.ntStore.bramThreads()[0]?.comments[0]?.editedAt !== undefined, null, { timeout: 5000 });
  check("Bram sees the edit, marked edited", (await bramThreads())[0].comments[0], "user_ada: Is Friday realistic for QA? (edited)");

  // --- Ada resolves ------------------------------------------------------------
  await page.click("#ada-resolve");
  await page.waitForFunction(() => window.ntStore.bramThreads()[0]?.status === "resolved", null, { timeout: 5000 });
  check("Bram sees it resolved by Ada", (await bramThreads()).map((t) => [t.status, t.resolvedBy]), [["resolved", "user_ada"]]);
  check("Ada's button now offers to reopen", await page.textContent("#ada-resolve"), "Reopen");

  // --- Bram's client re-homes the anchor: maintenance, not an action ----------
  await page.evaluate(() => window.ntStore.bramRehome("p_pasted"));
  await page.waitForFunction(() => document.querySelector("[data-testid=ada-threads] li")?.getAttribute("data-block") === "p_pasted", null, { timeout: 5000 });
  check("the re-home reached Ada", await page.getAttribute("[data-testid=ada-threads] li", "data-block"), "p_pasted");

  // --- Ada undoes her resolve: the re-home and the reply stay ------------------
  await page.click("#ada-undo");
  await page.waitForFunction(() => window.ntStore.bramThreads()[0]?.status === "open", null, { timeout: 5000 });
  check("Bram sees it open again, re-home and reply intact", (await bramThreads()).map((t) => ({ status: t.status, resolvedBy: t.resolvedBy, block: t.block, n: t.comments.length })),
    [{ status: "open", resolvedBy: null, block: "p_pasted", n: 2 }]);

  // --- a second thread, undone and redone ---------------------------------------
  await page.click("#ada-body");
  await page.keyboard.type("Who owns QA?", { delay: 5 });
  await page.click("#ada-comment");
  await page.waitForFunction(() => window.ntStore.bramThreads().length === 2, null, { timeout: 5000 });
  check("Bram holds both threads", (await bramThreads()).map((t) => t.comments[0]), ["user_ada: Is Friday realistic for QA? (edited)", "user_ada: Who owns QA?"]);
  check("the second write minted nothing more", await ensureCalls(), ["ada page-1"]);
  await page.click("#ada-undo");
  await page.waitForFunction(() => window.ntStore.bramThreads().length === 1, null, { timeout: 5000 });
  check("undo takes Ada's new thread back on Bram's replica", (await bramThreads()).length, 1);
  check("redo is offered", await page.isEnabled("#ada-redo"), true);
  await page.click("#ada-redo");
  await page.waitForFunction(() => window.ntStore.bramThreads().length === 2, null, { timeout: 5000 });
  check("redo puts it back", (await bramThreads()).map((t) => t.comments[0]).at(-1), "user_ada: Who owns QA?");

  // --- undo walks back only Ada's own actions -----------------------------------
  for (let i = 0; i < 10 && await page.isEnabled("#ada-undo"); i++) await page.click("#ada-undo");
  await page.waitForFunction(() => window.ntStore.bramThreads().length === 0, null, { timeout: 5000 });
  check("with all of Ada's actions undone, her threads are gone everywhere", await page.$$eval("[data-testid=ada-threads] li", (items) => items.length), 0);
  for (let i = 0; i < 10 && await page.isEnabled("#ada-redo"); i++) await page.click("#ada-redo");
  await page.waitForFunction(() => window.ntStore.bramThreads().length === 2, null, { timeout: 5000 });
  const restored = await bramThreads();
  check("and redoing them all restores both threads, edit and all", restored.map((t) => t.comments[0]),
    ["user_ada: Is Friday realistic for QA? (edited)", "user_ada: Who owns QA?"]);
  check("Bram's reply rides along with its thread, and the re-home is never undone",
    { reply: restored[0].comments.includes("user_bram: Only if design signs off Thursday."), block: restored[0].block }, { reply: true, block: "p_pasted" });

  // --- the stored log is the document -------------------------------------------
  await page.waitForTimeout(800);
  const docId = await page.evaluate(() => window.ntStore.pages()["page-1"]);
  check("a fresh load of the stored log reads what both replicas hold",
    await page.evaluate((id) => window.ntStore.reload(id).map((t) => [t.id, t.status, t.comments.length, t.anchor.blockId]), docId),
    restored.map((t) => [t.id, t.status, t.comments.length, t.block]));

  // --- Ada leaves: her provider lets go --------------------------------------------
  const watchingBefore = await page.evaluate((id) => window.ntStore.watchers("ydoc:meta", id), docId);
  await page.evaluate(() => window.ntStore.unmountAda());
  await page.waitForTimeout(200);
  check("unmounting releases Ada's subscription (Bram's remains)", [watchingBefore, await page.evaluate((id) => window.ntStore.watchers("ydoc:meta", id), docId)], [2, 1]);

  // --- a viewer opens the commented page: she reads, and mints nothing -------------
  await page.evaluate(() => window.ntStore.mountViewer());
  await page.waitForFunction(() => document.getElementById("viewer-status")?.textContent === "ready", null, { timeout: 5000 });
  check("the viewer's hook loads the existing document and lists its threads",
    await page.$$eval("[data-testid=viewer-threads] li", (items) => items.map((item) => item.getAttribute("data-thread"))), restored.map((t) => t.id));
  await page.click("#viewer-body");
  await page.keyboard.type("Me too", { delay: 5 });
  await page.click("#viewer-reply");
  await page.waitForSelector("#viewer-error");
  check("her reply is refused before anything is written", await page.textContent("#viewer-error"), "You can read these comments but not add to them.");
  check("the viewer never asked to mint", (await ensureCalls()).filter((call) => call.startsWith("viewer")), []);
  check("and never appended", (await page.evaluate(() => window.ntStore.calls())).filter((call) => call.who === "viewer" && call.kind === "mutation").length, 0);

  // --- Cara moves to another page while her first comment is being minted --------
  await page.evaluate(() => window.ntStore.mountSwitcher());
  await page.waitForFunction(() => document.getElementById("cara-status")?.textContent === "absent");
  await page.evaluate(() => window.ntStore.holdEnsure());
  await page.click("#cara-body");
  await page.keyboard.type("Before I go", { delay: 5 });
  await page.click("#cara-comment");
  await page.waitForFunction(() => window.ntStore.calls().some((call) => call.who === "cara" && call.name === "comments:ensureDoc"));
  await page.click("#cara-switch");
  await page.waitForFunction(() => document.getElementById("cara-page")?.textContent === "page-4");
  await page.evaluate(() => window.ntStore.releaseEnsure());
  await page.waitForSelector("#cara-error", { timeout: 5000 });
  check("a first comment overtaken by a page change is refused, not left hanging",
    await page.textContent("#cara-error"), "The page changed before the comment was written.");
  const caraPages = await page.evaluate(() => window.ntStore.pages());
  check("it landed on neither page", {
    page3: caraPages["page-3"] ? await page.evaluate((id) => window.ntStore.reload(id).length, caraPages["page-3"]) : 0,
    page4: caraPages["page-4"],
  }, { page3: 0, page4: null });
  check("and the page she moved to still reads as having no comments", await page.textContent("#cara-status"), "absent");

  const calls = await page.evaluate(() => window.ntStore.calls());
  const onComments = calls.filter((call) => call.args.docId === docId);
  check("the comments doc reached no presence, preview, digest or init function",
    onComments.filter((call) => FORBIDDEN.includes(call.name)).map((call) => `${call.who} ${call.name}`), []);
  check("its writes were appends", [...new Set(onComments.filter((call) => call.kind === "mutation").map((call) => call.name))], ["ydoc:append"]);
  check("Vera only ever read", [...new Set(calls.filter((call) => call.who === "vera").map((call) => `${call.kind} ${call.name}`))], ["watch comments:docFor"]);

  await page.screenshot({ path: path.join(output, "comments-store.png") });
  console.log(`\nscreenshot: ${path.join(output, "comments-store.png")}`);
} finally {
  await browser?.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} failure(s):\n${failures.join("\n")}` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
