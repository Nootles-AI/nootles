/**
 * What the two comment-surface runners share — the stand-in run
 * (comments-surfaces.browser.mjs) and the full-stack one
 * (comments-surfaces.fullstack.mjs):
 *
 * - the bundle: an entry built with the app's own Tailwind CSS,
 *   `@clerk/nextjs` / `next/*` / `@sentry/nextjs` swapped for fixtures, and
 *   each page's editor import swapped for the real editor plus the probe card
 *   (tests/comments-surfaces.probe.tsx). The Clerk fixture reads
 *   `window.surfaces.identity` — null is signed out;
 * - a guarded tab: every request outside the allowed origins fails the run,
 *   and a writer's ambient AI lanes are aborted in the tab and reported;
 * - a person's hands on the page: selecting words by double-click or drag,
 *   placing a caret, and reading back the probe card.
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FIXTURES = {
  clerk: `
    const id = () => window.surfaces.identity;
    export function useUser() {
      const who = id();
      return who
        ? { isLoaded: true, isSignedIn: true, user: { id: who.userId, fullName: who.name, primaryEmailAddress: { emailAddress: who.userId + "@example.test" }, imageUrl: "" } }
        : { isLoaded: true, isSignedIn: false, user: null };
    }
    export function useAuth() {
      const who = id();
      return { isLoaded: true, isSignedIn: Boolean(who), userId: who ? who.userId : null, getToken: async () => null };
    }
    export function useClerk() {
      return {
        openSignIn() { window.surfaces.signIns.push("openSignIn"); },
        signOut: async () => {},
        client: { signIn: { authenticateWithRedirect() { window.surfaces.signIns.push("redirect"); } } },
      };
    }
  `,
  navigation: `
    const router = { replace() {}, push() {}, prefetch() {}, back() {}, forward() {}, refresh() {} };
    export function useRouter() { return router; }
    export function usePathname() { return "/"; }
    export function useSearchParams() { return new URLSearchParams(window.location.search); }
    export function useParams() { return {}; }
    export function redirect() {}
    export function notFound() {}
  `,
  link: `import { createElement } from "react"; export default function Link({ href, children, prefetch, ...rest }) { return createElement("a", { href: typeof href === "string" ? href : "#", ...rest }, children); }`,
  dynamic: `export default function dynamic() { return function Dynamic() { return null; }; }`,
  image: `import { createElement } from "react"; export default function Image({ src, alt, fill, priority, ...rest }) { return createElement("img", { src: typeof src === "string" ? src : "", alt: alt ?? "", ...rest }); }`,
  sentry: `
    export function captureException() {}
    export function captureMessage() {}
    export function addBreadcrumb() {}
    export function setUser() {}
    export function setTag() {}
    export function withScope(fn) { fn({ setTag() {}, setExtra() {}, setContext() {} }); }
  `,
};
const PAGE_SURFACE = path.join("app", "components", "PageSurface.tsx");
const SHARED_PROJECT = path.join("app", "components", "share", "SharedProject.tsx");
const PROBE = path.join(repo, "tests", "comments-surfaces.probe.tsx");

/**
 * Build `entry` (repo-relative .tsx) into `output`, with `index.html` loading it.
 * `probe: false` keeps each page's real editor; `rewrite` maps a repo-relative
 * source path to a function over its text, for a harness that counts inside a
 * component without the component knowing.
 */
export async function bundleSurfaces(entry, output, { probe = true, rewrite = {} } = {}) {
  const name = path.basename(entry, ".tsx");
  await build({
    absWorkingDir: repo, entryPoints: [entry], bundle: true, splitting: true,
    format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import", "style"],
    tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"development"', "process.env.NEXT_PUBLIC_YJS": '"1"' },
    banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
    plugins: [{ name: "fixture", setup(builder) {
      const to = (fixture) => () => ({ path: fixture, namespace: "fixture" });
      builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, to("server-only"));
      builder.onResolve({ filter: /^@clerk\/nextjs$/ }, to("clerk"));
      builder.onResolve({ filter: /^next\/navigation$/ }, to("navigation"));
      builder.onResolve({ filter: /^next\/link$/ }, to("link"));
      builder.onResolve({ filter: /^next\/dynamic$/ }, to("dynamic"));
      builder.onResolve({ filter: /^next\/image$/ }, to("image"));
      builder.onResolve({ filter: /^@sentry\/nextjs$/ }, to("sentry"));
      if (probe) {
        builder.onResolve({ filter: /^\.\/editor\/Editor$/ }, (args) => (args.importer.endsWith(PAGE_SURFACE) ? { path: PROBE } : undefined));
        builder.onResolve({ filter: /^\.\/SharedEditor$/ }, (args) => (args.importer.endsWith(SHARED_PROJECT) ? { path: PROBE } : undefined));
      }
      for (const [file, change] of Object.entries(rewrite)) {
        const absolute = path.join(repo, file);
        const filter = new RegExp(`${absolute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
        builder.onLoad({ filter }, async () => ({ contents: change(await readFile(absolute, "utf8")), loader: "tsx", resolveDir: path.dirname(absolute) }));
      }
      builder.onLoad({ filter: /^server-only$/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };' }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: FIXTURES[args.path], loader: "js", resolveDir: repo }));
    } }],
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".svg": "dataurl", ".png": "dataurl" }, logLevel: "warning",
  });
  const appCss = path.join(repo, "app/globals.css");
  const styles = await postcss([tailwind({ base: repo })]).process(await readFile(appCss, "utf8"), { from: appCss });
  await writeFile(path.join(output, "app.css"), styles.css);
  await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/${name}.css"></head><body><div id="app"></div><script type="module" src="/${name}.js"></script></body></html>`);
}

/** Serve `output` on a free port; resolves the origin and the server. */
export async function serveBundle(output) {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (pathname === "/favicon.ico") { response.writeHead(204); return void response.end(); }
      const file = pathname === "/" ? "index.html" : path.basename(pathname);
      const data = await readFile(path.join(output, file));
      response.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".html") ? "text/html" : "application/octet-stream");
      response.end(data);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, server };
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A run's ledger: `check` prints and records; `failures` is what fails it. */
export function ledger() {
  const failures = [];
  const check = (name, actual, expected) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) return void console.log(`  ok   ${name}`);
    failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
    console.log(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`);
  };
  const finish = () => {
    if (failures.length) {
      console.error(`\n${failures.length} failure(s):\n${failures.map((f) => `  - ${f}`).join("\n")}`);
      process.exit(1);
    }
    console.log("\nall checks passed");
    // A backend's keep-alive sockets must not hold a finished run open.
    process.exit(0);
  };
  return { failures, check, finish };
}

/** The ambient lanes a writer's typing wakes: tab completion and reformat. */
export const AI_LANE = /\/api\/(complete|reformat)(\?|$)/;

/** Noise a mounted workspace makes with no app server behind it. */
const BENIGN = [/Download the React DevTools/, /\[Fast Refresh\]/];

/**
 * A fresh tab on `origin`, guarded: any request that is neither the bundle nor
 * one of `allow` fails the run; the ambient AI lanes are aborted and collected
 * in `lanes`, so a run can assert which woke (a reader's none). `inert` swaps
 * the WebSocket for one that never connects. A console error matching
 * `expected` is collected in `expectedErrors` for the run to count, not failed.
 */
export async function guardedTab(browser, { origin, allow = [], inert, label, failures, expected }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  const lanes = [];
  const expectedErrors = [];
  page.on("pageerror", (error) => failures.push(`[${label}] page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // The browser's own line for a lane request aborted below.
    if (AI_LANE.test(message.location().url ?? "")) return;
    const text = message.text();
    if (expected?.test(text)) expectedErrors.push(text);
    else if (!BENIGN.some((pattern) => pattern.test(text))) failures.push(`[${label}] console error: ${text}`);
  });
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith("data:") || allow.some((allowed) => url.startsWith(allowed))) return route.continue();
    const local = url.startsWith(origin);
    if (local && !new URL(url).pathname.startsWith("/api/")) return route.continue();
    if (local && AI_LANE.test(url)) lanes.push(new URL(url).pathname);
    else failures.push(`[${label}] request left the fixture: ${url}`);
    return route.abort();
  });
  await page.addInitScript((inertSocket) => {
    if (inertSocket) {
      window.WebSocket = class extends EventTarget {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        readyState = 0;
        send() { throw new Error("Fixture socket must never send"); }
        close() { this.readyState = 3; }
      };
    }
    // The last undo-shaped keydown, to read afterwards whether anything claimed it.
    window.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") window.__lastUndoKey = event;
    }, true);
  }, Boolean(inert));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  return { page, context, lanes, expectedErrors };
}

/** A writer may wake only the ambient lanes; a reader wakes none, as read-only has no AI. */
export function lanesCheck(check, label, lanes, { writes }) {
  const woke = [...new Set(lanes)].sort();
  check(`[${label}] ${writes ? "wakes only the ambient lanes (aborted in the tab)" : "wakes no AI lane"}`,
    writes ? woke.every((lane) => AI_LANE.test(lane)) : woke, writes ? true : []);
}

/** The probe card's report: comment access, threads, and the offered selection. */
export const probe = (page) => page.$eval("#probe", (el) => ({
  status: el.dataset.status,
  canRead: el.dataset.canRead === "true",
  canComment: el.dataset.canComment === "true",
  signIn: el.dataset.signIn === "true",
  store: el.dataset.hasStore === "true",
  history: el.dataset.hasHistory === "true",
  threads: JSON.parse(el.dataset.threads),
  selection: JSON.parse(el.dataset.selection),
  error: el.dataset.error,
}));
export const threadCount = async (page) => (await probe(page)).threads.length;
export const docText = (page) => page.$eval(".bn-editor", (el) => el.textContent);
export const domSelection = (page) => page.evaluate(() => String(document.getSelection()));
/** Whether anything claimed the last ⌘Z/⌘⇧Z (`true`) or left it to the browser. */
export const lastKeyClaimed = (page) => page.evaluate(() => window.__lastUndoKey?.defaultPrevented ?? null);
export const waitFor = (page, fn, arg, timeout = 5000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

/** The screen rectangle of `word` inside block `blockId`. */
export const wordBox = (page, blockId, word) => page.evaluate(([id, w]) => {
  const block = document.querySelector(`.bn-editor [data-id='${id}'] .bn-inline-content`);
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.data.indexOf(w);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + w.length);
    const r = range.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }
  return null;
}, [blockId, word]);

export async function doubleClickWord(page, blockId, word) {
  const box = await wordBox(page, blockId, word);
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await wait(80);
}

/** Press on the first word's start, drag to the last word's end — a hand selecting a phrase. */
export async function dragSelect(page, blockId, fromWord, toWord) {
  const a = await wordBox(page, blockId, fromWord);
  const b = await wordBox(page, blockId, toWord);
  await page.mouse.move(a.x + 1, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, a.y + a.height / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();
  await wait(80);
}

/** A caret at the end of block `blockId`, placed by a click as a person would. */
export async function clickEndOf(page, blockId) {
  const box = await page.$eval(`.bn-editor [data-id='${blockId}'] .bn-inline-content`, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.right - 2, y: r.y + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  await page.keyboard.press("End");
  await wait(50);
}

/** A click on the comment card's words: focus to the card, the page's words let go. */
export async function clickCard(page) {
  await page.click("#card-label");
  await wait(80);
}

/**
 * Start a thread on `word` through the card: write the comment, select the
 * word, press Comment. The word is dragged across rather than double-clicked:
 * in an editable page BlockNote's formatting toolbar rises over the line as
 * the second click's selection lands, and takes the release — the toolbar's
 * business (and the comment wave's), not this card's. For the same reason a
 * caret goes down in the last line first: the toolbar of an older selection
 * stays up over the first line while focus is away from the page.
 */
export async function startThread(page, { blockId, word, body, lastBlockId }) {
  await page.click("#comment-body");
  await page.fill("#comment-body", body);
  await clickEndOf(page, lastBlockId);
  await wait(300);
  await dragSelect(page, blockId, word, word);
  await page.click("#comment-start");
}

export const UNDO = "ControlOrMeta+z";
export const REDO = "ControlOrMeta+Shift+z";

