/**
 * Comment highlights as live ranges (design §3, §12 "The anchor" and "The
 * review"), driven through real Chromium keyboard and mouse input on three
 * replicas of one page.
 *
 * Ada and Bram may edit and comment; Vera may only read. Each page is the
 * production editor over its own page Y.Doc and comments Y.Doc; this runner is
 * their server — it keeps both documents, answers each page's load with them
 * (so a reload is a real reload), and relays every local update to the other
 * replicas. Every check reads each replica's own editor and own documents.
 *
 * No app server, no Convex, no API keys; every off-origin request fails the
 * run, and the WebSocket is inert. No model is called: the review's turn is a
 * scripted batch resolved exactly as `edit_page` resolves one.
 *
 *   node tests/comments-anchor.browser.mjs
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
import * as Y from "yjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "comments-anchor-"));

for (const key of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "MISTRAL_API_KEY", "RECRAFT_API_KEY"]) {
  delete process.env[key];
}

// `ReviewProvider` builds its session from Convex; the page builds the same
// session over memory, and the overlay reads it through these hooks.
const REVIEW_CONTEXT = `
import { useMemo, useSyncExternalStore } from "react";
const current = () => globalThis.reviewHarnessSession;
export function useReview() { return current(); }
export function useReviewTurns() {
  const session = current();
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}
export function useOpenReviews() {
  const session = current();
  const turns = useReviewTurns();
  return useMemo(() => turns.filter((turn) => session.isOpen(turn)), [turns, session]);
}
export function useReviewFailure() {
  const session = current();
  return useSyncExternalStore(session.subscribe, session.getFailure, session.getFailure);
}
`;

await build({
  absWorkingDir: repo, entryPoints: ["tests/comments-anchor.browser.tsx"], bundle: true, splitting: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"development"', "process.env.NEXT_PUBLIC_YJS": '"1"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [{ name: "fixture", setup(builder) {
    builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({ path: "server-only", namespace: "fixture" }));
    builder.onResolve({ filter: /(^|\/)ReviewContext$/ }, () => ({ path: "review-context", namespace: "fixture" }));
    builder.onLoad({ filter: /^server-only$/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };' }));
    builder.onLoad({ filter: /^review-context$/, namespace: "fixture" }, () => ({ contents: REVIEW_CONTEXT, loader: "js", resolveDir: repo }));
  } }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
});

// The palette from `globals.css` (Tailwind is not in the bundle): the one-line
// custom properties, so the highlight paints in the colours the app uses.
const globals = await readFile(path.join(repo, "app", "globals.css"), "utf8");
const tokens = [...globals.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;\n]+);/gm)].map(([, name, value]) => `${name}:${value}`).join(";");
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/comments-anchor.browser.css"><style>html,body{margin:0;height:100%;overflow:hidden;font-family:Arial,sans-serif}:root{${tokens}}</style></head><body><div id="app"></div><script type="module" src="/comments-anchor.browser.js"></script></body></html>`);

const http = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") { response.writeHead(204); return void response.end(); }
    const name = pathname === "/" ? "index.html" : path.basename(pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream");
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${http.address().port}`;

const failures = [];
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return void console.log(`  ok   ${name}`);
  failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
  console.log(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MOD = process.platform === "darwin" ? "Meta" : "Control";
/** `SETTLE_MS` in commentDecorations.ts, plus room for the relay. */
const SETTLE = 600 + 400;
const WHO = ["ada", "bram", "vera"];

// ---- The server -------------------------------------------------------------

let server;
/** Updates each replica sent, per document, since the last `fresh`. */
let sent;
/** Comments-document updates Vera ever sent. She may never write one. */
let veraWrites = 0;
const resetServer = () => {
  server = { page: new Y.Doc(), comments: new Y.Doc() };
  sent = Object.fromEntries(WHO.map((who) => [who, { page: 0, comments: 0 }]));
};
resetServer();
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

const pages = {};
const whoOf = new Map();

let browser;
try {
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith("data:") || url === "about:blank") return route.continue();
    failures.push(`request left the fixture: ${url}`);
    return route.abort();
  });
  await context.addInitScript(() => {
    window.WebSocket = class extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0;
      send() { throw new Error("Fixture socket must never send"); }
      close() { this.readyState = 3; }
    };
  });
  await context.exposeBinding("ntRelay", ({ page }, name, update) => {
    const who = whoOf.get(page);
    sent[who][name]++;
    if (who === "vera" && name === "comments") veraWrites++;
    Y.applyUpdate(server[name], Buffer.from(update, "base64"), who);
    for (const [other, target] of Object.entries(pages)) {
      if (other === who) continue;
      target.evaluate(([n, u]) => window.ntAnchor?.receive(n, u), [name, update]).catch(() => {});
    }
  });
  await context.exposeBinding("ntFetch", () => ({ page: b64(Y.encodeStateAsUpdate(server.page)), comments: b64(Y.encodeStateAsUpdate(server.comments)) }));

  for (const who of WHO) {
    const page = await context.newPage();
    page.on("pageerror", (error) => failures.push(`${who} page error: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") failures.push(`${who} console ${message.type()}: ${message.text()}`);
    });
    pages[who] = page;
    whoOf.set(page, who);
  }

  const h = (who, fn, ...args) => pages[who].evaluate(fn, args);
  const load = async (who) => {
    await pages[who].goto(`${origin}/?who=${who}`);
    await pages[who].waitForFunction(() => document.body.dataset.ready === "true" && document.querySelector(".bn-editor [data-id]"));
    await sleep(150);
  };
  const vectorsEqual = (a, b) => {
    const x = Y.decodeStateVector(Buffer.from(a, "base64"));
    if (x.size !== b.size) return false;
    for (const [client, clock] of b) if (x.get(client) !== clock) return false;
    return true;
  };
  /** Every replica holds exactly what the server holds. */
  const synced = async (timeout = 5000) => {
    const until = Date.now() + timeout;
    for (;;) {
      let all = true;
      for (const who of WHO) {
        const vectors = await h(who, () => window.ntAnchor?.vectors() ?? null).catch(() => null);
        const held = (name) => Y.decodeStateVector(Y.encodeStateVector(server[name]));
        if (!vectors || !vectorsEqual(vectors.page, held("page")) || !vectorsEqual(vectors.comments, held("comments"))) {
          all = false;
          break;
        }
      }
      if (all) return;
      if (Date.now() > until) throw new Error("replicas did not converge");
      await sleep(40);
    }
  };
  /** A fresh page: every replica away, a new server, Ada writes it, the others open it. */
  const fresh = async (blocks) => {
    for (const who of WHO) await pages[who].goto("about:blank");
    resetServer();
    await load("ada");
    await h("ada", ([b]) => window.ntAnchor.seed(b), blocks);
    await sleep(200);
    await load("bram");
    await load("vera");
    await synced();
    // Counted from here: Ada's seeding is the server's doing, not a comment write.
    sent = Object.fromEntries(WHO.map((who) => [who, { page: 0, comments: 0 }]));
  };

  const blockText = (who, id) => h(who, ([i]) => window.ntAnchor.blockText(i), id);
  const highlights = (who) => h(who, () => Object.fromEntries(Object.entries(window.ntAnchor.highlights()).map(([id, v]) => [id, v.text])));
  const everyone = async (fn) => Object.fromEntries(await Promise.all(WHO.map(async (who) => [who, await fn(who)])));
  const same = (value) => Object.fromEntries(WHO.map((who) => [who, value]));
  const resolves = (who) => h(who, () => window.ntAnchor.resolves());
  const threads = (who) => h(who, () => window.ntAnchor.threads());
  const anchors = (id) => everyone(async (who) => (await threads(who)).find((t) => t.id === id)?.anchor ?? null);
  const sentComments = () => Object.fromEntries(WHO.map((who) => [who, sent[who].comments]));

  /** The caret into a block's words, as a person puts it: a click, then the arrow keys. */
  const caretTo = async (who, blockId, offset) => {
    const page = pages[who];
    const point = await h(who, ([id]) => window.ntAnchor.textPoint(id, 0), blockId);
    await page.mouse.click(point.x + 1, point.y);
    await page.waitForFunction(([id]) => {
      const caret = window.ntAnchor.caret();
      return caret?.blockId === id && caret.offset === 0;
    }, [blockId], { timeout: 2000 }).catch(async () => {
      await page.screenshot({ path: path.join(output, `caret-${who}.png`) });
      throw new Error(`caret landed at ${JSON.stringify(await h(who, () => window.ntAnchor.caret()))}, clicked ${JSON.stringify(point)}`);
    });
    await arrows(who, offset, () => h(who, () => window.ntAnchor.caret()?.offset ?? -1));
  };
  /**
   * `n` presses of the right arrow, then — as a person watching the caret
   * would — the few more it takes when headless Chrome drops one at a node
   * boundary (it does, highlights or none; `drops` counts them for the log).
   * The editor reads a moved caret on selectionchange, a beat after the key.
   */
  const arrows = async (who, n, where, shift = false) => {
    const page = pages[who];
    if (shift) await page.keyboard.down("Shift");
    for (let i = 0; i < n; i++) await page.keyboard.press("ArrowRight", { delay: 10 });
    for (let attempt = 0; ; attempt++) {
      let now = -1;
      for (let wait = 0; wait < 10 && now !== n; wait++) {
        await sleep(30);
        now = await where();
      }
      if (now === n) break;
      if (attempt === 3 || now > n || now < 0) {
        if (shift) await page.keyboard.up("Shift");
        throw new Error(`${who}: arrowed to ${now}, wanted ${n}`);
      }
      drops += n - now;
      for (let i = now; i < n; i++) await page.keyboard.press("ArrowRight", { delay: 10 });
    }
    if (shift) await page.keyboard.up("Shift");
  };
  let drops = 0;
  const select = async (who, blockId, from, to) => {
    await caretTo(who, blockId, from);
    await arrows(who, to - from, () => h(who, () => window.ntAnchor.selection().length), true);
  };
  const chord = async (who, ...keys) => {
    for (const key of keys) await pages[who].keyboard.down(key);
    for (const key of [...keys].reverse()) await pages[who].keyboard.up(key);
    await sleep(120);
  };
  /** Select a phrase and comment on it, as the comment affordance will. */
  const comment = async (who, blockId, phrase, occurrence = 0) => {
    const text = await blockText(who, blockId);
    let at = -1;
    for (let i = 0; i <= occurrence; i++) at = text.indexOf(phrase, at + 1);
    await select(who, blockId, at, at + phrase.length);
    check(`${who} selected "${phrase}"`, await h(who, () => window.ntAnchor.selection()), phrase);
    const id = await h(who, ([body]) => window.ntAnchor.commentOnSelection(body), "Is this right?");
    await synced();
    await sleep(100);
    return id;
  };
  const type = async (who, text) => {
    await pages[who].keyboard.type(text, { delay: 20 });
    await sleep(80);
  };

  const PAGE = [
    { id: "title", type: "heading", props: { level: 1 }, content: "Launch plan" },
    { id: "p1", type: "paragraph", content: "We ship it by Friday if the review passes." },
    { id: "p2", type: "paragraph", content: "Design signs off on Thursday, then we freeze." },
    { id: "p3", type: "paragraph", content: "" },
    { id: "p4", type: "paragraph", content: "Notes for later." },
  ];
  const SHIP = "We ship it ";

  // ==== A thread is drawn on every replica ===================================
  console.log("a thread on a phrase");
  await fresh(PAGE);
  const t1 = await comment("ada", "p1", "by Friday");
  check("every replica draws it", await everyone(highlights), same({ [t1]: "by Friday" }));
  check("each resolved its selector once", await everyone(resolves), same(1));
  check("only the author wrote to the comments document", sentComments(), { ada: 1, bram: 0, vera: 0 });
  const paint = await h("ada", () => {
    const el = document.querySelector(".nt-comment-hl");
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, shadow: style.boxShadow, cursor: style.cursor };
  });
  check("the highlight paints a wash", paint.background !== "rgba(0, 0, 0, 0)" && paint.background !== "", true);
  check("with an underline", paint.shadow.includes("inset"), true);
  await pages.ada.screenshot({ path: path.join(output, "highlight.png") });

  // ==== Typing inside the phrase ==============================================
  console.log("typing inside the phrase");
  await caretTo("ada", "p1", `${SHIP}by`.length);
  await type("ada", " next");
  await synced();
  check("the highlight tracks the characters on every replica", await everyone(highlights), same({ [t1]: "by next Friday" }));
  check("no replica consulted the selector", await everyone(resolves), same(1));
  check("and nobody wrote while the typing went on", sentComments(), { ada: 1, bram: 0, vera: 0 });
  await sleep(SETTLE);
  await synced();
  check("once it paused, the typist made the new words the quotation — once", sentComments(), { ada: 2, bram: 0, vera: 0 });
  check("every replica holds that anchor", Object.values(await anchors(t1)).map((a) => a.exact), ["by next Friday", "by next Friday", "by next Friday"]);
  check("still without a resolve anywhere", await everyone(resolves), same(1));

  // ==== Typing at each edge ====================================================
  console.log("typing at each edge");
  await caretTo("ada", "p1", SHIP.length);
  await type("ada", "X");
  await caretTo("ada", "p1", `${SHIP}Xby next Friday`.length);
  await type("ada", "Y");
  await synced();
  check("the range grew at neither edge", await everyone(highlights), same({ [t1]: "by next Friday" }));
  // Bram types at the end edge too: a remote edge for Ada and Vera.
  await caretTo("bram", "p1", `${SHIP}Xby next Friday`.length);
  await type("bram", "Z");
  await synced();
  check("nor at the edge a collaborator typed on", await everyone(highlights), same({ [t1]: "by next Friday" }));
  check("the words", await blockText("vera", "p1"), "We ship it Xby next FridayZY if the review passes.");
  await sleep(SETTLE);
  check("edge typing is not an edit of the quotation: nothing written", sentComments(), { ada: 2, bram: 0, vera: 0 });

  // ==== Reload mid-edit ========================================================
  console.log("reload mid-edit");
  await load("ada");
  await load("vera");
  await synced();
  check("after a reload the selector finds the range the mapping had", await everyone(highlights), same({ [t1]: "by next Friday" }));
  check("each reloaded replica resolved once", [await resolves("ada"), await resolves("vera")], [1, 1]);
  await sleep(SETTLE);
  check("and wrote nothing", sentComments(), { ada: 2, bram: 0, vera: 0 });

  // ==== Edit until `exact` no longer matches, then reload ======================
  console.log("an edit the anchor never heard of, then reload");
  const bramResolves = await resolves("bram");
  await caretTo("ada", "p1", `${SHIP}Xby next Fri`.length);
  await type("ada", "-");
  await synced(); // the keystroke reached the server; Ada's settle pass has not run
  await load("ada");
  await synced();
  check("stage 2 finds the edited words", await highlights("ada"), { [t1]: "by next Fri-day" });
  check("and rewrites `exact` for everyone", Object.values(await anchors(t1)).map((a) => a.exact), ["by next Fri-day", "by next Fri-day", "by next Fri-day"]);
  check("the replicas that stayed open agree without resolving", [await highlights("bram"), await highlights("vera"), await resolves("bram")], [{ [t1]: "by next Fri-day" }, { [t1]: "by next Fri-day" }, bramResolves]);
  await load("bram");
  await sleep(SETTLE);
  check("Bram's reload hits stage 1 on the rewritten anchor", [await highlights("bram"), await resolves("bram")], [{ [t1]: "by next Fri-day" }, 1]);
  check("one write for the rewrite, none from the reload", sentComments(), { ada: 3, bram: 0, vera: 0 });

  // ==== Click to focus; resolved threads are not drawn =========================
  console.log("focus and resolution");
  const mid = await h("ada", ([id, at]) => window.ntAnchor.textPoint(id, at), "p1", `${SHIP}Xby ne`.length);
  await pages.ada.mouse.click(mid.x, mid.y);
  await sleep(80);
  check("clicking a highlight focuses its thread", [await h("ada", () => window.ntAnchor.active()), (await h("ada", () => window.ntAnchor.highlights()))[t1].active], [t1, true]);
  const vmid = await h("vera", ([id, at]) => window.ntAnchor.textPoint(id, at), "p1", `${SHIP}Xby ne`.length);
  await pages.vera.mouse.click(vmid.x, vmid.y);
  await sleep(80);
  check("a reader's click focuses it too", await h("vera", () => window.ntAnchor.active()), t1);
  await caretTo("ada", "p4", 2);
  check("clicking elsewhere lets it go", await h("ada", () => window.ntAnchor.active()), null);
  await h("ada", ([id]) => window.ntAnchor.resolveThread(id), t1);
  await synced();
  await sleep(100);
  check("a resolved thread is drawn nowhere", await everyone(highlights), same({}));
  check("but keeps its live range", Object.keys(await h("ada", () => window.ntAnchor.ranges())), [t1]);
  await h("bram", ([id]) => window.ntAnchor.reopenThread(id), t1);
  await synced();
  await sleep(100);
  check("reopened, it is drawn again", await everyone(highlights), same({ [t1]: "by next Fri-day" }));

  // ==== Cut the paragraph, paste it elsewhere ==================================
  console.log("cut and paste");
  await fresh(PAGE);
  const t2 = await comment("ada", "p1", "by Friday");
  const before = sentComments();
  const sentence = await blockText("ada", "p1");
  await select("ada", "p1", 0, sentence.length);
  await chord("ada", MOD, "x");
  await caretTo("ada", "p3", 0);
  await chord("ada", MOD, "v");
  await synced();
  const ids = await h("ada", () => window.ntAnchor.blockIds());
  const texts = await h("ada", () => window.ntAnchor.texts());
  const pasted = ids[texts.indexOf(sentence)];
  check("the sentence moved out of its block", [texts[ids.indexOf("p1")] ?? "", pasted !== undefined && pasted !== "p1"], ["", true]);
  await sleep(SETTLE);
  await synced();
  check("stage 3 re-homed the anchor on every replica", Object.values(await anchors(t2)).map((a) => a.blockId), [pasted, pasted, pasted]);
  check("and every replica draws it there", await everyone(highlights), same({ [t2]: "by Friday" }));
  check("no orphan mark was left behind", (await everyone(threads)).ada.find((t) => t.id === t2).orphanedAt, null);
  const moved = { ada: sent.ada.comments - before.ada, bram: sent.bram.comments - before.bram, vera: sent.vera.comments - before.vera };
  console.log(`       re-home writes: ${JSON.stringify(moved)}`);
  check("both commenting replicas resolved it concurrently, a bounded number of writes", moved.ada <= 2 && moved.bram <= 2 && moved.vera === 0, true);
  const afterMove = sentComments();
  for (const who of WHO) await load(who);
  await synced();
  await sleep(SETTLE);
  check("after reloading everyone, stage 1 finds it in its new block", await everyone(async (who) => (await h(who, () => window.ntAnchor.rangeOffsets()))[t2]?.blockId), same(pasted));
  check("with no further writes", sentComments(), afterMove);

  // ==== Delete the phrase, then undo ===========================================
  console.log("delete, then undo");
  await fresh(PAGE);
  const t3 = await comment("ada", "p1", "by Friday");
  const beforeDelete = sentComments();
  await select("ada", "p1", SHIP.length, `${SHIP}by Friday`.length);
  await pages.ada.keyboard.press("Backspace");
  await synced();
  check("the words are gone", await blockText("bram", "p1"), "We ship it  if the review passes.");
  check("no replica draws the thread", await everyone(highlights), same({}));
  await sleep(SETTLE);
  await synced();
  const stamps = await everyone(async (who) => (await threads(who)).find((t) => t.id === t3).orphanedAt);
  check("orphaned on every replica, with one stamp", new Set(Object.values(stamps)).size === 1 && typeof stamps.ada === "number", true);
  const orphanWrites = sent.ada.comments - beforeDelete.ada + sent.bram.comments - beforeDelete.bram;
  console.log(`       orphan writes: ada ${sent.ada.comments - beforeDelete.ada}, bram ${sent.bram.comments - beforeDelete.bram}`);
  check("written at most once per commenting replica", orphanWrites >= 1 && orphanWrites <= 2, true);
  await caretTo("ada", "p1", 3);
  await chord("ada", MOD, "z");
  await synced();
  check("⌘Z brings the words back", await blockText("vera", "p1"), "We ship it by Friday if the review passes.");
  await sleep(SETTLE);
  await synced();
  check("re-anchored on every replica", await everyone(highlights), same({ [t3]: "by Friday" }));
  check("and the orphan mark is cleared everywhere", Object.values(await everyone(async (who) => (await threads(who)).find((t) => t.id === t3).orphanedAt)), [null, null, null]);

  // ==== The same phrase twice in one block =====================================
  console.log("the same phrase twice");
  await fresh([
    { id: "q", type: "paragraph", content: "note: alpha beta; note: gamma" },
    { id: "r", type: "paragraph", content: "ok then ok then ok" },
    { id: "s", type: "paragraph", content: "" },
  ]);
  const t4 = await comment("ada", "q", "note", 1);
  const offsets = (id) => everyone(async (who) => (await h(who, () => window.ntAnchor.rangeOffsets()))[id]);
  check("its context picks the second one on every replica", await offsets(t4), same({ blockId: "q", from: 18, to: 22 }));
  const hinted = async (hint) => {
    const id = await h("ada", ([anchor]) => window.ntAnchor.createThread(anchor, "which one?"), { blockId: "r", exact: "ok", prefix: "", suffix: "", offsetHint: hint });
    await synced();
    await sleep(200);
    await synced();
    return id;
  };
  const t5 = await hinted(9);
  check("identical context falls to the nearest offset hint, the same on every replica", await offsets(t5), same({ blockId: "r", from: 8, to: 10 }));
  check("and the thread says it is ambiguous", Object.values(await everyone(async (who) => (await threads(who)).find((t) => t.id === t5).ambiguous)), [true, true, true]);
  const t6 = await hinted(12);
  check("an even hint falls to the lowest offset", await offsets(t6), same({ blockId: "r", from: 8, to: 10 }));
  for (const who of WHO) await load(who);
  await synced();
  check("after a reload everyone still picks the same", [await offsets(t4), await offsets(t5), await offsets(t6)], [same({ blockId: "q", from: 18, to: 22 }), same({ blockId: "r", from: 8, to: 10 }), same({ blockId: "r", from: 8, to: 10 })]);

  // ==== A review forks the page ================================================
  console.log("a review");
  await fresh(PAGE);
  const t7 = await comment("ada", "p1", "by Friday");
  const quiet = sentComments();
  const REWRITE = "We ship it by friday if the review passes, we hope.";
  await h("ada", ([text]) => window.ntAnchor.stageRewrite("p1", text), REWRITE);
  await h("ada", () => window.ntAnchor.idle());
  check("Ada's editor is showing the fork", [await h("ada", () => window.ntAnchor.forked()), await blockText("ada", "p1")], [true, REWRITE]);
  check("the proposal has nowhere to put the thread: unanchored in the fork", [await highlights("ada"), (await h("ada", () => window.ntAnchor.ranges()))[t7]], [{}, null]);
  check("the collaborators never saw the proposal, and still draw it", [await highlights("bram"), await highlights("vera")], [{ [t7]: "by Friday" }, { [t7]: "by Friday" }]);
  await sleep(SETTLE + 400);
  check("and no orphan — no write of any kind — was made", sentComments(), quiet);
  check("the stored anchor is untouched", (await anchors(t7)).ada.exact, "by Friday");
  await pages.ada.click(".nt-diff-btn.is-discard");
  await h("ada", () => window.ntAnchor.idle());
  await sleep(200);
  check("Discard puts the words back and the highlight with them", [await h("ada", () => window.ntAnchor.forked()), await highlights("ada")], [false, { [t7]: "by Friday" }]);
  await sleep(SETTLE);
  check("still nothing written", sentComments(), quiet);

  await h("ada", ([text]) => window.ntAnchor.stageRewrite("p1", text), REWRITE);
  await h("ada", () => window.ntAnchor.idle());
  check("a second proposal: unanchored again", await highlights("ada"), {});
  await pages.ada.click(".nt-diff-btn.is-keep");
  await h("ada", () => window.ntAnchor.idle());
  await synced();
  await sleep(SETTLE);
  await synced();
  check("Keep resolves it against the kept text through stage 2", await highlights("ada"), { [t7]: "by friday" });
  check("the rewritten anchor reaches everyone", Object.values(await anchors(t7)).map((a) => a.exact), ["by friday", "by friday", "by friday"]);
  check("and every replica draws the kept words", await everyone(highlights), same({ [t7]: "by friday" }));
  const kept = { ada: sent.ada.comments - quiet.ada, bram: sent.bram.comments - quiet.bram };
  console.log(`       stage-2 writes after Keep: ${JSON.stringify(kept)}`);
  check("at most one write per commenting replica", kept.ada <= 1 && kept.bram <= 1 && kept.ada + kept.bram >= 1, true);

  // ==== Fifty threads, two hundred characters ==================================
  console.log("fifty threads");
  const busy = Array.from({ length: 50 }, (_, i) => ({ id: `b${i}`, type: "paragraph", content: `Item ${i}: the milestone ${i} is due soon, says the plan.` }));
  const typeAndTime = async () => {
    await caretTo("ada", "b0", 0);
    await h("ada", () => window.ntAnchor.startTiming());
    for (let i = 0; i < 200; i++) await pages.ada.keyboard.type(i % 10 === 9 ? " " : "w");
    const timings = await h("ada", () => window.ntAnchor.stopTiming());
    timings.sort((a, b) => a - b);
    const mean = timings.reduce((sum, t) => sum + t, 0) / timings.length;
    return { n: timings.length, mean: +mean.toFixed(2), p95: +timings[Math.floor(timings.length * 0.95)].toFixed(2), max: +timings.at(-1).toFixed(2) };
  };
  await fresh(busy);
  const bare = await typeAndTime();
  await fresh(busy);
  await h("ada", () => window.ntAnchor.threadEvery("the milestone"));
  await synced();
  await sleep(200);
  check("fifty threads, all drawn", Object.keys(await highlights("ada")).length, 50);
  const loaded = await typeAndTime();
  console.log(`       per keystroke transaction, no threads:  ${JSON.stringify(bare)}`);
  console.log(`       per keystroke transaction, 50 threads: ${JSON.stringify(loaded)}`);
  check("two hundred keystrokes, two hundred transactions", loaded.n >= 200, true);
  check("typing stays inside a frame at p95 with fifty threads", loaded.p95 < 16, true);
  check("the highlights overhead is small (mean within 3ms of none)", loaded.mean - bare.mean < 3, true);
  await synced();
  check("still fifty, and not one resolved again", [Object.keys(await highlights("bram")).length, await resolves("ada"), await resolves("bram")], [50, 50, 50]);
  check("each still covers its phrase", new Set(Object.values(await highlights("vera"))).size === 1 && Object.values(await highlights("vera"))[0] === "the milestone", true);

  check("Vera never wrote to the comments document", veraWrites, 0);
  console.log(`       arrow presses headless Chrome dropped and the runner made again: ${drops}`);
} catch (error) {
  failures.push(`runner: ${error.stack ?? error}`);
} finally {
  await browser?.close();
  http.close();
}

console.log(`\nartifacts: ${output}`);
if (failures.length) {
  console.log(`\n${failures.length} failure(s):\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\nall comment-anchor checks passed");
