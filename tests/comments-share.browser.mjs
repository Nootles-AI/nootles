/**
 * The commenter role's share surface, driven through real Chromium clicks and
 * keys (docs/commenting-plan.md §5, PR 3).
 *
 * The owner's share popover: the third tab, turning the comment link on and
 * copying it, the collaborator list naming a commenter, and turning links off
 * demoting and then removing people exactly as the server's `claimRole` does.
 * The share route: a signed-out visitor on a comment link reads the page, is
 * handed no comment access, and told what signing in gives; a comment
 * affordance reaching for `CommentAccess.signIn` opens the sign-in door on
 * behalf of commenting — while the editor and viewer faces are unchanged, and
 * a signed-in visitor is claimed and carried to the workspace.
 *
 * `convex/react`, `@clerk/nextjs`, `next/navigation` and `@sentry/nextjs` are
 * swapped at bundle time for fixtures over an in-memory stand-in; the share
 * route's editor is swapped for a probe that reports the comment access it
 * was handed. No app server, no Convex, no API keys; every off-origin request
 * fails the run, and the WebSocket is inert.
 *
 *   node tests/comments-share.browser.mjs
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
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { launchBrowser } from "./comments-launch.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "comments-share-"));

for (const key of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "MISTRAL_API_KEY", "RECRAFT_API_KEY"]) {
  delete process.env[key];
}

const FIXTURES = {
  "convex-react": `
    import { useCallback, useSyncExternalStore } from "react";
    import { getFunctionName } from "convex/server";
    const backend = () => window.shareHarness.backend;
    export function useQuery(ref, args = {}) {
      const name = getFunctionName(ref);
      return useSyncExternalStore(backend().subscribe, () => (args === "skip" ? undefined : backend().read(name, args)));
    }
    export function useMutation(ref) {
      const name = getFunctionName(ref);
      return useCallback((args) => backend().mutate(name, args), [name]);
    }
    // Held by the page's comments provider, which must never use it for a
    // signed-out visitor: any touch fails the run.
    const inertClient = new Proxy({}, { get(_, key) { throw new Error("the share fixture's Convex client was used: " + String(key)); } });
    export function useConvex() { return inertClient; }
  `,
  clerk: `
    const user = { fullName: "Olive Owner", primaryEmailAddress: { emailAddress: "olive@example.test" } };
    export function useUser() { return { isLoaded: true, isSignedIn: true, user }; }
    export function useAuth() { return window.shareHarness.auth; }
    export function useClerk() {
      return { client: { signIn: { authenticateWithRedirect() { throw new Error("sign-in must not start in the fixture"); } } } };
    }
  `,
  navigation: `
    const router = {
      replace: (to) => window.shareHarness.replaced.push(to),
      push: (to) => window.shareHarness.replaced.push(to),
      prefetch() {}, back() {}, forward() {}, refresh() {},
    };
    export function useRouter() { return router; }
    export function usePathname() { return "/share/fixture"; }
    export function useSearchParams() { return new URLSearchParams(); }
  `,
  sentry: `
    export function captureException() {}
    export function captureMessage() {}
    export function addBreadcrumb() {}
  `,
  "shared-editor": `
    import { createElement } from "react";
    import { useCommentAccess } from "./app/components/comments/access";
    // A comment affordance as a later wave will draw one: where commenting is
    // not allowed but signing in would allow it, it asks for the sign-in.
    export function SharedEditor({ docId }) {
      const access = useCommentAccess();
      return createElement("div", { id: "probe", "data-doc": docId, "data-access": JSON.stringify(access) },
        createElement("p", null, "The page reads here."),
        access.canComment || access.signIn
          ? createElement("button", { id: "comment", onClick: access.canComment ? undefined : access.signIn }, "Comment")
          : null);
    }
  `,
};
const SHARED_PROJECT = path.join("app", "components", "share", "SharedProject.tsx");

await build({
  absWorkingDir: repo, entryPoints: ["tests/comments-share.browser.tsx"], bundle: true, splitting: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [{ name: "fixture", setup(builder) {
    const to = (name) => () => ({ path: name, namespace: "fixture" });
    builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, to("server-only"));
    builder.onResolve({ filter: /^convex\/react$/ }, to("convex-react"));
    builder.onResolve({ filter: /^@clerk\/nextjs$/ }, to("clerk"));
    builder.onResolve({ filter: /^next\/navigation$/ }, to("navigation"));
    builder.onResolve({ filter: /^@sentry\/nextjs$/ }, to("sentry"));
    builder.onResolve({ filter: /^\.\/SharedEditor$/ }, (args) =>
      args.importer.endsWith(SHARED_PROJECT) ? { path: "shared-editor", namespace: "fixture" } : undefined);
    builder.onLoad({ filter: /^server-only$/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };' }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: FIXTURES[args.path], loader: "js", resolveDir: repo }));
  } }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
});
// The app's own stylesheet, through its own Tailwind pipeline: the popover's
// three tabs have to fit its width, which only real CSS can answer.
const appCss = path.join(repo, "app/globals.css");
const styles = await postcss([tailwind({ base: repo })]).process(await readFile(appCss, "utf8"), { from: appCss });
await writeFile(path.join(output, "app.css"), styles.css);
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/comments-share.browser.css"></head><body><div id="app"></div><script type="module" src="/comments-share.browser.js"></script></body></html>`);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") { response.writeHead(204); return void response.end(); }
    const name = pathname === "/" ? "index.html" : path.basename(pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream");
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

let browser;
try {
  browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = await context.newPage();
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
  await page.waitForFunction(() => !!window.shareHarness);
  const mutations = (name) => page.evaluate((n) => window.shareHarness.calls().filter((c) => c.kind === "mutation" && c.name === n).map((c) => c.args), name);
  const people = () => page.$$eval('[aria-label="People with access"] li', (rows) =>
    rows.map((row) => [...row.querySelectorAll("span")].filter((s) => !s.getAttribute("aria-hidden")).map((s) => s.textContent.trim())));
  const note = () => page.textContent('[role="dialog"] .nt-note');

  console.log("\nthe owner's share popover");
  await page.evaluate(() => {
    window.shareHarness.setLinks({ viewer: "tok-viewer-seed", editor: "tok-editor-seed" });
    window.shareHarness.seedClaim("user_ada", "commenter", "Ada");
    window.shareHarness.seedClaim("user_bob", "viewer", "Bob");
    window.shareHarness.seedClaim("user_cy", "editor", "Cy");
    window.shareHarness.mountPopover();
  });
  await page.click('button[aria-label="Share project"]');
  await page.waitForSelector('[role="dialog"][aria-label="Share project"]');
  check("three tabs, in rank order", await page.$$eval('[role="group"][aria-label="Share links"] button', (b) => b.map((x) => x.firstChild.textContent)),
    ["Editor link", "Commenter link", "Viewer link"]);
  check("the editor tab opens first", await page.getAttribute('button:has-text("Editor link")', "aria-pressed"), "true");
  const fit = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="Share project"]');
    const group = dialog.querySelector('[role="group"][aria-label="Share links"]');
    const inner = dialog.getBoundingClientRect().right - parseFloat(getComputedStyle(dialog).paddingRight);
    return {
      groupInside: group.getBoundingClientRect().right <= inner + 0.5,
      labels: [...group.querySelectorAll("button")].map((button) => {
        const range = document.createRange();
        range.selectNodeContents(button.firstChild);
        const text = range.getBoundingClientRect();
        const box = button.getBoundingClientRect();
        return { lines: range.getClientRects().length, inside: text.left >= box.left && text.right <= box.right + 0.5, width: Math.round(box.width), label: Math.round(text.width) };
      }),
    };
  });
  check("the three tabs sit inside the popover", fit.groupInside, true);
  check("each tab's label fits its segment on one line", fit.labels.map((l) => l.lines === 1 && l.inside), [true, true, true]);
  if (!fit.labels.every((l) => l.lines === 1 && l.inside)) console.log("    measured", JSON.stringify(fit.labels));
  check("the comment link is off: its claimant reads as a viewer", await people(), [["You", "Owner"], ["Ada", "Viewer"], ["Bob", "Viewer"], ["Cy", "Editor"]]);

  await page.click('button:has-text("Commenter link")');
  check("the commenter tab is pressed", await page.getAttribute('button:has-text("Commenter link")', "aria-pressed"), "true");
  check("it says the link is off, in the link's own words", await note(), "Off. Nobody can view or comment through a commenter link.");
  await page.click('button:has-text("Create commenter link")');
  await page.waitForSelector('input[aria-label="Commenter link"]');
  const created = await page.inputValue('input[aria-label="Commenter link"]');
  check("the new link is the share URL of a freshly minted token", created, `${origin}/share/tok-commenter-1`);
  check("setLink was asked for exactly the comment link", await mutations("share:setLink"), [{ projectId: "project_1", role: "commenter", enabled: true }]);
  check("and while on it says what it grants", await note(), "Anyone with this link can view; signing in lets them comment.");
  check("its claimant is a commenter again", await people(), [["You", "Owner"], ["Ada", "Commenter"], ["Bob", "Viewer"], ["Cy", "Editor"]]);

  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.click('[role="dialog"] button:has-text("Copy")');
  await page.waitForSelector('[role="dialog"] button[data-done]');
  check("Copy puts the comment link on the clipboard", await page.evaluate(() => navigator.clipboard.readText()), created);
  check("and says so", (await page.textContent('[role="dialog"] button[data-done]')).trim(), "Copied");

  // Each tab keeps its own link: the editor's is untouched by the comment link.
  await page.click('button:has-text("Editor link")');
  check("the editor tab still shows its own link", await page.inputValue('input[aria-label="Editor link"]'), `${origin}/share/tok-editor-seed`);
  await page.click('button:has-text("Viewer link")');
  check("and the viewer tab its own", await page.inputValue('input[aria-label="Viewer link"]'), `${origin}/share/tok-viewer-seed`);

  // By keyboard: focus the commenter tab and press Enter.
  await page.focus('button:has-text("Commenter link")');
  await page.keyboard.press("Enter");
  check("the keyboard reaches the commenter tab", await page.getAttribute('button:has-text("Commenter link")', "aria-pressed"), "true");

  await page.click('[role="dialog"] button:has-text("Turn off link")');
  await page.waitForSelector('button:has-text("Create commenter link")');
  check("turning it off revokes it", (await mutations("share:setLink")).at(-1), { projectId: "project_1", role: "commenter", enabled: false });
  check("its claimant is demoted to viewer while other links live", await people(), [["You", "Owner"], ["Ada", "Viewer"], ["Bob", "Viewer"], ["Cy", "Editor"]]);

  for (const tab of ["Editor link", "Viewer link"]) {
    await page.click(`button:has-text("${tab}")`);
    await page.click('[role="dialog"] button:has-text("Turn off link")');
    await page.waitForSelector(`button:has-text("Create ${tab.split(" ")[0].toLowerCase()} link")`);
  }
  check("with every link off, only the owner has access", await people(), [["You", "Owner"]]);
  check("and the count says one", (await page.textContent('[role="dialog"] .nt-field-label .nt-field-note')).trim(), "1");

  await page.click('button:has-text("Commenter link")');
  await page.click('button:has-text("Create commenter link")');
  await page.waitForSelector('input[aria-label="Commenter link"]');
  check("turning it on again mints a new token; the old URL stays dead",
    await page.inputValue('input[aria-label="Commenter link"]'), `${origin}/share/tok-commenter-2`);
  check("and the comment link alone brings back its commenter — and the others, as viewers",
    await people(), [["You", "Owner"], ["Ada", "Commenter"], ["Bob", "Viewer"], ["Cy", "Viewer"]]);
  await page.waitForTimeout(500); // the list rows animate in
  await page.screenshot({ path: path.join(output, "share-popover.png") });

  await page.keyboard.press("Escape");
  await page.waitForSelector('[role="dialog"][aria-label="Share project"]', { state: "detached" });
  check("Escape closes it", true, true);

  console.log("\nthe share route, signed out, on a comment link");
  await page.evaluate(() => window.shareHarness.mountShare("tok-commenter-2", { isLoaded: true, isSignedIn: false }));
  await page.waitForSelector("#probe");
  check("the page is read — the document it names is the page's", await page.getAttribute("#probe", "data-doc"), "page-doc-1");
  check("and the reader is handed no comment access", JSON.parse(await page.getAttribute("#probe", "data-access")), { canRead: false, canComment: false });
  check("the banner says what signing in gives", await page.textContent(".nt-guest-banner span"), "This project is open for comments.");
  check("with the way in beside it", await page.textContent(".nt-guest-banner button"), "Sign in to comment");
  check("the header offers Sign in, not Request edit access",
    await page.$$eval("header button", (b) => b.map((x) => x.textContent.trim()).filter(Boolean)), ["Sign in"]);
  check("nothing claims for a signed-out visitor", await mutations("share:claim"), []);

  await page.click("#probe p");
  await page.keyboard.press("x");
  await page.waitForTimeout(150);
  check("a press or a keystroke into the page is reading, not a reach for anything", await page.$('[role="dialog"]'), null);
  await page.click("#comment");
  await page.waitForSelector('[role="dialog"]');
  check("the comment affordance opens the sign-in door for commenting",
    await page.textContent('[role="dialog"] p.font-medium'), "Sign in to comment");
  check("in the door's voice", await page.textContent('[role="dialog"] p.text-muted'),
    "Anyone with the link can comment on this project. Signing in is what puts your name on your comments.");
  check("the probe's page is unchanged", await page.textContent("#probe p"), "The page reads here.");
  await page.keyboard.press("Escape");
  await page.waitForSelector('[role="dialog"]', { state: "detached" });
  await page.click(".nt-guest-banner button");
  await page.waitForSelector('[role="dialog"]');
  check("the banner opens the same door", await page.textContent('[role="dialog"] p.font-medium'), "Sign in to comment");
  await page.screenshot({ path: path.join(output, "share-comment-link.png") });
  await page.keyboard.press("Escape");
  await page.waitForSelector('[role="dialog"]', { state: "detached" });

  console.log("\nthe other faces are unchanged");
  await page.evaluate(() => window.shareHarness.setLinks({ viewer: "tok-v", commenter: "tok-c", editor: "tok-e" }));
  await page.evaluate(() => window.shareHarness.mountShare("tok-v", { isLoaded: true, isSignedIn: false }));
  await page.waitForSelector("#probe");
  check("viewer link: read-only, with the ask", await page.$$eval("header span, header button", (b) =>
    b.map((x) => x.textContent.trim()).filter((t) => t === "Read-only" || t === "Request edit access")), ["Read-only", "Request edit access"]);
  check("viewer link: no banner", await page.$(".nt-guest-banner"), null);
  check("viewer link: no comment access either, and no door to it", [
    JSON.parse(await page.getAttribute("#probe", "data-access")), await page.$("#comment")], [{ canRead: false, canComment: false }, null]);
  await page.click("#probe p");
  await page.keyboard.press("x");
  await page.waitForTimeout(150);
  check("viewer link: a keystroke opens nothing", await page.$('[role="dialog"]'), null);

  await page.evaluate(() => window.shareHarness.mountShare("tok-e", { isLoaded: true, isSignedIn: false }));
  await page.waitForSelector("#probe");
  check("editor link: its banner", await page.textContent(".nt-guest-banner span"), "This project is editable.");
  check("editor link: no comment door — the sign-in it offers is the pen's", await page.$("#comment"), null);
  await page.click("#probe p");
  await page.waitForSelector('[role="dialog"]');
  check("editor link: a press is a reach for the pen", await page.textContent('[role="dialog"] p.font-medium'), "Sign in to edit");
  await page.keyboard.press("Escape");

  console.log("\nsigned in, on a comment link");
  await page.evaluate(() => window.shareHarness.mountShare("tok-c", { isLoaded: true, isSignedIn: true }));
  await page.waitForFunction(() => window.shareHarness.replaced.length > 0, null, { timeout: 5000 });
  check("the link is claimed", await mutations("share:claim"), [{ token: "tok-c" }]);
  check("and the visitor is carried to the workspace", await page.evaluate(() => window.shareHarness.replaced), ["/p/project_1"]);
  check("with no edit request made on their behalf", await mutations("share:requestEdit"), []);

  const reads = await page.evaluate(() => [...new Set(window.shareHarness.calls().filter((c) => c.kind === "query").map((c) => c.name))].sort());
  check("the surface asked only share and presence questions", reads,
    ["presence:list", "share:collaborators", "share:incomingRequests", "share:links", "share:view"]);
  console.log(`\nscreenshots: ${output}`);
} finally {
  await browser?.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} failure(s):\n${failures.join("\n")}` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
