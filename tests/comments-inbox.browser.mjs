/**
 * The comment inbox, driven the way its recipient uses it: real Chromium
 * clicks and keys on the real `Correspondence` corner and `useLinkedPage`
 * (docs/commenting-plan.md §9 — "the unread affordance").
 *
 * Notices arrive while the page is open; the corner shows one card per
 * thread, three at a time, beside a pending access request without either
 * covering the other. Dismissing a card marks its thread seen and uncovers
 * the next; opening one marks it seen, moves the address to the thread's link,
 * and the workspace's link reader opens the page and leaves `thread` for the
 * comments surface. "Mark all read" clears the rest.
 *
 * No app server, no Convex, no API keys; every off-origin request fails the
 * run, and the WebSocket is inert.
 *
 *   node tests/comments-inbox.browser.mjs
 *
 * Uses system Chrome (`channel: "chrome"`); `COMMENTS_BROWSER_CHANNEL=chromium`
 * or `COMMENTS_CHROME_PATH` picks another.
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "comments-inbox-"));
const { chromium } = await import("playwright");

for (const key of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "MISTRAL_API_KEY", "RECRAFT_API_KEY"]) {
  delete process.env[key];
}

await build({
  absWorkingDir: repo, entryPoints: ["tests/comments-inbox.browser.tsx"], bundle: true, splitting: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import"],
  tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  jsx: "automatic", logLevel: "warning",
});
const stylesheets = (await readdir(output)).filter((name) => name.endsWith(".css"));
// The tokens the corner draws with, as `globals.css` declares them (that file
// is Tailwind source, which esbuild does not compile).
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8">
<style>
  :root {
    --background: oklch(1 0 90); --elevated: oklch(1 0 90); --sunken: oklch(0.958 0.003 90);
    --border: oklch(0.93 0.003 90); --border-strong: oklch(0.875 0.004 90);
    --foreground: oklch(0.25 0.005 90); --muted: oklch(0.535 0.004 90);
    --text-ui: 13px; --text-meta: 12px; --ease: cubic-bezier(0.16, 1, 0.3, 1); --dur-fast: 110ms; --z-toast: 60;
  }
  body { margin: 0; font-family: Arial, sans-serif; color: var(--foreground); background: var(--background); }
  main { padding: 24px; }
  button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
  .font-medium { font-weight: 500; }
  .nt-monogram { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%;
    background: var(--sunken); box-shadow: inset 0 0 0 1px var(--border); font-size: var(--text-meta); color: var(--muted); }
</style>
${stylesheets.map((name) => `<link rel="stylesheet" href="/${name}">`).join("\n")}
</head><body><div id="root"></div>
  <script type="module" src="/comments-inbox.browser.js"></script>
</body></html>`);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") { response.writeHead(204); return void response.end(); }
    const name = pathname === "/" ? "index.html" : path.basename(pathname);
    const data = await readFile(path.join(output, name));
    const type = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream";
    response.setHeader("Content-Type", type);
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

// A face drawn from a data URI, so an avatar costs no request.
const FACE = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22"><circle cx="11" cy="11" r="11" fill="#bbb"/></svg>');
const notice = (over) => ({
  noticeId: "n", kind: "reply", projectId: "proj_a", projectTitle: "Launch", pageId: "page_plan", pageTitle: "Plan",
  threadId: "t_1", actorName: "Bram Editor", actorImageUrl: null, createdAt: 1000, ...over,
});

let browser;
try {
  const channel = process.env.COMMENTS_BROWSER_CHANNEL || "chrome";
  browser = await chromium.launch({
    headless: true,
    ...(process.env.COMMENTS_CHROME_PATH ? { executablePath: process.env.COMMENTS_CHROME_PATH } : { channel }),
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
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
  await page.waitForFunction(() => !!window.ntInbox);
  await page.evaluate(() => window.ntInbox.mount());
  const cards = () => page.$$eval(".nt-notice .nt-ask-said", (els) => els.map((el) => el.textContent));

  // --- an empty inbox draws nothing ------------------------------------------
  await page.waitForTimeout(100);
  check("with nothing unseen, the corner is empty", await page.$$eval(".nt-asks > *", (els) => els.length), 0);

  // --- news arrives while the page is open -----------------------------------
  await page.evaluate((rows) => { for (const row of rows) window.ntInbox.deliver(row); }, [
    notice({ noticeId: "n1", kind: "mention", threadId: "t_1", actorName: "Bram Editor", actorImageUrl: FACE, createdAt: 1000 }),
    notice({ noticeId: "n2", kind: "reply", threadId: "t_1", actorName: "Cleo Viewer", createdAt: 5000 }),
    notice({ noticeId: "n3", kind: "reply", threadId: "t_2", pageId: "page_budget", pageTitle: "Budget", actorName: "Cleo Viewer", createdAt: 3000 }),
    notice({ noticeId: "n4", kind: "resolved", threadId: "t_3", projectId: "proj_b", projectTitle: "Hiring", pageId: "page_road", pageTitle: "Roadmap", actorName: null, createdAt: 6000 }),
    notice({ noticeId: "n5", kind: "mention", threadId: "t_4", projectId: "proj_b", projectTitle: "Hiring", pageId: "page_road", pageTitle: "", actorName: "Ada Owner", createdAt: 500 }),
  ]);
  await page.evaluate(() => window.ntInbox.ask({ requestId: "req_1", projectId: "proj_a", projectTitle: "Launch", name: "Cleo Viewer", email: null, imageUrl: null, createdAt: 1 }));
  await page.waitForSelector(".nt-notice");
  check("one card per thread, newest thread first, three at a time", await cards(), [
    "Someone resolved a thread on Roadmap in Hiring",
    "Bram Editor mentioned you on Plan · 2 new",
    "Cleo Viewer replied on Budget",
  ]);
  check("the rest are counted, not dropped", await page.textContent(".nt-notice-more .nt-ask-said"), "1 more thread with news");
  check("a card leads with its face, drawn from the notice", await page.$$eval(".nt-notice", (els) => els.map((el) => el.querySelector("img") ? "img" : el.querySelector(".nt-monogram")?.textContent)), ["?", "img", "C"]);

  // --- one corner, one stack: the access request and the notices never overlap
  const boxes = await page.$$eval(".nt-asks > *", (els) => els.map((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, cls: el.className }; }));
  const overlaps = boxes.some((a, i) => boxes.some((b, j) => i !== j && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5));
  check("the access request and the notices share one stack without overlapping", { count: boxes.length, overlaps }, { count: 5, overlaps: false });
  check("the access request sits nearest the corner", boxes.reduce((low, box) => (box.bottom > low.bottom ? box : low)).cls.includes("is-decision"), true);
  await page.waitForTimeout(500); // past the entrance animation
  await page.screenshot({ path: path.join(output, "comments-inbox.png") });
  console.log(`  screenshot: ${path.join(output, "comments-inbox.png")}`);

  // --- dismissing a card marks its thread seen and uncovers the next -----------
  const firstCard = page.locator(".nt-notice").first();
  await firstCard.locator('button[aria-label="Mark as read"]').click();
  check("the dismissed card leaves at once", (await cards())[0], "Bram Editor mentioned you on Plan · 2 new");
  check("and the thread it stood for is marked seen", await page.evaluate(() => window.ntInbox.calls().filter((c) => c.kind === "mutation").map((c) => [c.name, c.args.ids])), [["commentNotices:markSeen", ["n4"]]]);
  await page.waitForTimeout(250);
  check("the next thread is uncovered, and the count is gone", { cards: await cards(), more: await page.$(".nt-notice-more") }, {
    cards: ["Bram Editor mentioned you on Plan · 2 new", "Cleo Viewer replied on Budget", "Ada Owner mentioned you on Untitled in Hiring"],
    more: null,
  });
  check("nothing was navigated to", await page.evaluate(() => window.ntInbox.pushes()), []);

  // --- opening a card goes to the thread ---------------------------------------
  await page.click("text=Bram Editor mentioned you on Plan");
  await page.waitForFunction(() => document.getElementById("opened")?.textContent === "page_plan");
  check("the whole thread is marked seen — the mention and the reply after it", await page.evaluate(() => window.ntInbox.calls().filter((c) => c.kind === "mutation").at(-1).args.ids), ["n2", "n1"]);
  check("the address moves to the thread's link", await page.evaluate(() => window.ntInbox.pushes()), ["/p/proj_a?page=page_plan&thread=t_1"]);
  check("the workspace opens the page it names", await page.evaluate(() => window.ntInbox.opened()), ["page_plan"]);
  check("and gives up `page`, leaving `thread` for the comments surface", await page.evaluate(() => location.pathname + location.search), "/p/proj_a?thread=t_1");

  // --- the keyboard reaches a card too -----------------------------------------
  await page.waitForTimeout(250);
  // From the top of the page: the request's two answers, then the first card.
  await page.click("main p");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
  check("Tab reaches the Budget card after the request's answers", await page.evaluate(() =>
    document.activeElement?.closest(".nt-notice")?.querySelector(".nt-ask-said")?.textContent), "Cleo Viewer replied on Budget");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("opened")?.textContent === "page_budget");
  check("Enter opens it, in this project", await page.evaluate(() => location.pathname + location.search), "/p/proj_a?thread=t_2");

  // --- a notice from another project goes there --------------------------------
  await page.waitForTimeout(250);
  await page.click("text=Ada Owner mentioned you on Untitled");
  await page.waitForFunction(() => window.ntInbox.pushes().length === 3);
  check("a notice from elsewhere links to its own project", await page.evaluate(() => window.ntInbox.pushes().at(-1)), "/p/proj_b?page=page_road&thread=t_4");
  await page.waitForTimeout(250);
  check("the notices are all read", { cards: await cards(), unseen: await page.evaluate(() => window.ntInbox.unseen()) }, { cards: [], unseen: [] });
  check("and the corner holds only the request", await page.$$eval(".nt-asks > *", (els) => els.map((el) => el.className)), ["nt-ask is-decision"]);

  // --- "Mark all read" clears a backlog ----------------------------------------
  await page.evaluate((rows) => { for (const row of rows) window.ntInbox.deliver(row); },
    ["a", "b", "c", "d", "e"].map((id, i) => notice({ noticeId: `m_${id}`, threadId: `t_${id}`, createdAt: 9000 + i })));
  await page.waitForSelector(".nt-notice-more");
  check("a backlog shows three and counts the rest", await page.textContent(".nt-notice-more .nt-ask-said"), "2 more threads with news");
  await page.click("text=Mark all read");
  check("Mark all read marks every unseen thread at once", await page.evaluate(() => [...window.ntInbox.calls().filter((c) => c.kind === "mutation").at(-1).args.ids].sort()), ["m_a", "m_b", "m_c", "m_d", "m_e"]);
  check("and the cards go with it", await cards(), []);
  await page.waitForTimeout(250);
  check("nothing comes back once the server agrees", await cards(), []);

  // --- only the inbox and access-request queries were ever asked ---------------
  check("the corner watched exactly its three queries", await page.evaluate(() => [...new Set(window.ntInbox.calls().filter((c) => c.kind === "watch").map((c) => c.name))].sort()),
    ["commentNotices:inbox", "share:grantedForMe", "share:incomingRequests"]);
} finally {
  await browser?.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} failure(s):\n${failures.join("\n")}` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
