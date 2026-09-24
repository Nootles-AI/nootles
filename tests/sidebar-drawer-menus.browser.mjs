/**
 * NT-76: below 1024px the sidebar and the chat are drawers at `--z-modal`, and
 * every menu they open is portalled to the body. At `--z-dropdown` those menus
 * painted under the drawer that opened them (and dimmed under its scrim), so a
 * pointer could not reach a single item; the storyboard's full-size shot, also
 * at `--z-modal`, hid its own bar's menus the same way.
 *
 * Drives the real `Sidebar` in the real `LeftDrawer` at 800×700: the row and
 * empty-list right-click menus, the account menu and the share popover must
 * each take the pointer at their centre and four corners, and a real click on
 * an item must do what it says — Rename opens the field with the drawer still
 * open. The same for the chat drawer's Rewind menu and thread picker, and the
 * full-size shot's frame-ratio menu. The wide rail at 1280px is the control.
 * Change icon and the delete confirm, which open over a closed menu, still take
 * the pointer.
 *
 * `convex/react`, `@clerk/nextjs` and `next/navigation` are swapped at bundle
 * time for an in-memory stand-in. No app server, no Convex, no API keys; every
 * off-origin request fails the run. Runs in CI as part of the canvas browser
 * gate (`tests/canvas-browser.mjs`), on Playwright's Chromium like the rest.
 *
 *   node tests/sidebar-drawer-menus.browser.mjs
 *   CANVAS_CHROME_PATH=/path/to/chrome CANVAS_BROWSER_CHANNEL=headless-shell node tests/sidebar-drawer-menus.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "sidebar-drawer-menus-"));

for (const key of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "MISTRAL_API_KEY", "RECRAFT_API_KEY"]) {
  delete process.env[key];
}

const FIXTURES = {
  "convex-react": `
    import { useCallback, useMemo } from "react";
    import { getFunctionName } from "convex/server";
    const backend = () => window.drawerHarness.backend;
    export function useQuery(ref, args = {}) {
      return args === "skip" ? undefined : backend().read(getFunctionName(ref), args);
    }
    export function useMutation(ref) {
      const name = getFunctionName(ref);
      return useMemo(() => {
        const mutate = (args) => backend().mutate(name, args);
        mutate.withOptimisticUpdate = () => mutate;
        return mutate;
      }, [name]);
    }
    // Nothing under test acts or reads through the client directly: a touch
    // fails the run rather than answering with something made up.
    export function useAction(ref) {
      const name = getFunctionName(ref);
      return useCallback(() => { throw new Error("the drawer fixture ran an action: " + name); }, [name]);
    }
    export function useConvexAuth() { return { isLoading: false, isAuthenticated: true }; }
    const inert = new Proxy({}, { get(_, key) { throw new Error("the drawer fixture's Convex client was used: " + String(key)); } });
    export function useConvex() { return inert; }
  `,
  clerk: `
    const user = { fullName: "Olive Owner", primaryEmailAddress: { emailAddress: "olive@example.test" } };
    export function useUser() { return { isLoaded: true, isSignedIn: true, user }; }
    export function useAuth() { return { isLoaded: true, isSignedIn: true, userId: "user_owner" }; }
    export function useClerk() { return { signOut() { throw new Error("sign-out must not run in the fixture"); } }; }
  `,
  navigation: `
    const router = { replace() {}, push() {}, prefetch() {}, back() {}, forward() {}, refresh() {} };
    export function useRouter() { return router; }
    export function usePathname() { return "/p/project_1"; }
    export function useSearchParams() { return new URLSearchParams(); }
  `,
  sentry: `
    export function captureException() {}
    export function captureMessage() {}
    export function addBreadcrumb() {}
  `,
};

await build({
  absWorkingDir: repo, entryPoints: ["tests/sidebar-drawer-menus.browser.tsx"], bundle: true, splitting: true,
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
    builder.onLoad({ filter: /^server-only$/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };' }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: FIXTURES[args.path], loader: "js", resolveDir: repo }));
  } }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
});
// The app's own stylesheet through its own Tailwind pipeline: the z-scale, the
// drawer's utilities and `.nt-menu` are exactly what is under test.
const appCss = path.join(repo, "app/globals.css");
const css = await postcss([tailwind({ base: repo })]).process(await readFile(appCss, "utf8"), { from: appCss });
await writeFile(path.join(output, "app.css"), css.css);
await writeFile(path.join(output, "index.html"),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/sidebar-drawer-menus.browser.css"></head>' +
  '<body><div id="app"></div><script type="module" src="/sidebar-drawer-menus.browser.js"></script></body></html>');

const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const name = pathname === "/" ? "index.html" : pathname.slice(1);
    const data = await readFile(path.join(output, name));
    response.setHeader("Content-Type", TYPES[path.extname(name)] ?? "application/octet-stream");
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const check = (name, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return void console.log(`  ok   ${name}`);
  failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
  console.log(`  FAIL ${name}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`);
};

/**
 * Where a pointer lands on `selector`'s box: its centre and four corners, 4px
 * in. Each point says whether the topmost element there belongs to the
 * surface, and names it when it does not.
 */
async function hits(page, selector) {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const points = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 4, r.top + 4],
      [r.right - 4, r.top + 4],
      [r.left + 4, r.bottom - 4],
      [r.right - 4, r.bottom - 4],
    ];
    const missed = [];
    let inside = 0;
    for (const [x, y] of points) {
      const top = document.elementFromPoint(x, y);
      if (top && el.contains(top)) inside++;
      else missed.push(top ? `${top.tagName.toLowerCase()}${top.id ? `#${top.id}` : ""}.${String(top.className).split(" ")[0]}` : "nothing");
    }
    return { found: true, inside, of: points.length, missed, z: getComputedStyle(el).zIndex, parent: el.parentElement?.tagName };
  }, selector);
}
const allIn = (h) => ({ found: h.found, inside: h.inside, of: h.of });

/**
 * A press where a person would make it — the item's centre, by the mouse —
 * whatever is painted there. Playwright's own `click` refuses an item another
 * element covers, which is the very failure under test; this lets the covering
 * element take the press, as it would for a person, and the check after it say
 * what happened.
 */
async function press(locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`nothing to press: ${locator}`);
  await locator.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
/** Waits for `selector` to appear, and says whether it did. */
const appears = (page, selector, state = "attached") =>
  page.waitForSelector(selector, { state, timeout: 2000 }).then(() => true, () => false);
const ALL = { found: true, inside: 5, of: 5 };

let browser;
try {
  const { chromium } = await import("playwright");
  browser = await chromium.launch({
    headless: true,
    channel: process.env.CANVAS_BROWSER_CHANNEL === "headless-shell" ? undefined : "chromium",
    executablePath: process.env.CANVAS_CHROME_PATH || undefined,
  });

  const open = async ({ width, height }, mount) => {
    const context = await browser.newContext({ viewport: { width, height } });
    await context.route(/^(?!http:\/\/127\.0\.0\.1:)/, (route) => {
      failures.push(`off-origin request: ${route.request().url()}`);
      return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(origin);
    await page.waitForFunction(() => !!globalThis.drawerHarness);
    await page.evaluate(mount);
    return { context, page, errors };
  };

  const sidebarScenario = async (mode, size) => {
    console.log(`\n${mode} at ${size.width}×${size.height}`);
    const { context, page, errors } = await open(size, `globalThis.drawerHarness.mount(${JSON.stringify(mode)})`);
    const row = page.locator("nav").getByText("Meeting notes", { exact: true });
    await row.waitFor({ timeout: 10_000 }).catch(async (error) => {
      const unknown = await page.evaluate(() => [...globalThis.drawerHarness.backend.unknown]);
      throw new Error(`${mode}: the sidebar never listed its pages (unanswered queries ${JSON.stringify(unknown)}; errors ${JSON.stringify(errors)})`, { cause: error });
    });

    const takesPointer = async (name, selector) => {
      const h = await hits(page, selector);
      check(`${mode}: ${name} takes the pointer at its centre and corners`, allIn(h), ALL);
      if (h.inside !== h.of) console.log(`         missed → ${(h.missed ?? []).join(", ")} (z ${h.z})`);
      return h;
    };
    // Whatever a failed press left open goes, so the next surface starts clean.
    const settle = async () => {
      for (let i = 0; i < 3 && (await page.locator('.nt-menu:not(.is-closing), [role="dialog"]').count()); i++) {
        await page.keyboard.press("Escape");
        await page.waitForTimeout(250);
      }
    };

    // The row's right-click menu.
    const rowMenu = '[role="menu"][aria-label="Page actions"]';
    await row.click({ button: "right" });
    await page.waitForSelector(rowMenu);
    await page.waitForTimeout(400); // past the entrance spring
    const rowHits = await takesPointer("row menu", rowMenu);
    check(`${mode}: row menu is portalled to the body`, rowHits.parent, "BODY");
    await press(page.getByRole("menuitem", { name: /^Rename/ }));
    const renaming = await page.waitForFunction(() => {
      const el = document.activeElement;
      return el instanceof HTMLElement && el.isContentEditable && el.closest("nav") ? el.textContent : null;
    }, null, { timeout: 2000 }).then((h) => h.jsonValue(), () => null);
    check(`${mode}: clicking Rename opens the rename field`, renaming, "Meeting notes");
    check(`${mode}: the row menu closed`, await page.locator(rowMenu).count(), 0);
    if (mode === "drawer") {
      check("drawer: the drawer is still open", await page.locator('button[aria-label="Close panel"]').count(), 1);
    }
    await page.keyboard.press("Escape");
    await settle();

    // A press beside an open menu, on the panel that opened it, only closes
    // the menu: the catcher under it is at the menu's rank, not the drawer's.
    await row.click({ button: "right" });
    await page.waitForSelector(rowMenu);
    await page.waitForTimeout(400);
    // On the next row, left of the menu, which opened at the pointer over it.
    const next = await page.locator("nav").getByText("Roadmap", { exact: true }).boundingBox();
    const menuLeft = (await page.locator(rowMenu).boundingBox()).x;
    check(`${mode}: the press is beside the menu, on a row`, next.x + 4 < menuLeft - 4, true);
    await page.mouse.click(next.x + 4, next.y + next.height / 2);
    check(`${mode}: a press beside the menu closes it`, await appears(page, rowMenu, "detached"), true);
    check(`${mode}: and reaches nothing under it`, await page.evaluate(() => globalThis.drawerHarness.selected), []);
    await settle();

    // The empty list's right-click menu.
    const listMenu = '[role="menu"][aria-label="Pages"]';
    const nav = await page.locator("nav").boundingBox();
    await page.mouse.click(nav.x + nav.width / 2, nav.y + nav.height - 12, { button: "right" });
    await page.waitForSelector(listMenu);
    await page.waitForTimeout(400);
    await takesPointer("empty-list menu", listMenu);
    const creates = () => page.evaluate(() => globalThis.drawerHarness.backend.calls.filter((c) => c.name === "pages:create").length);
    const before = await creates();
    await press(page.getByRole("menuitem", { name: /^New page/ }));
    await page.waitForTimeout(150);
    check(`${mode}: New page reaches the backend`, (await creates()) - before, 1);
    await settle();

    // The account menu.
    const account = '[role="menu"][aria-label="Account"]';
    await page.getByRole("button", { name: /^Account — / }).click();
    await page.waitForSelector(account);
    await page.waitForTimeout(400);
    await takesPointer("account menu", account);
    await press(page.getByRole("menuitem", { name: /Keyboard shortcuts/ }));
    check(`${mode}: an account item runs`, await page.evaluate(() => globalThis.drawerHarness.keysShown), 1);
    await settle();

    // The share popover.
    const share = '[role="dialog"][aria-label="Share project"]';
    await page.getByRole("button", { name: "Share project" }).click();
    await page.waitForSelector(share);
    await page.waitForTimeout(400);
    await takesPointer("share popover", share);
    const segments = page.locator(share).getByRole("group", { name: "Share links" }).locator("button");
    const other = segments.and(page.locator('[aria-pressed="false"]')).first();
    const index = await other.evaluate((b) => [...b.parentElement.children].indexOf(b));
    await press(other);
    check(`${mode}: a share link tab takes a click`, await segments.nth(index).getAttribute("aria-pressed", { timeout: 1000 }).catch(() => "the popover went"), "true");
    await settle();

    // What a row item opens once its menu has gone: at `--z-modal`, and above
    // the drawer by being portalled after it, as before.
    await row.click({ button: "right" });
    await page.waitForSelector(rowMenu);
    await page.waitForTimeout(400);
    await press(page.getByRole("menuitem", { name: /^Change icon/ }));
    if (await appears(page, ".nt-iconpicker")) {
      await page.waitForTimeout(400);
      check(`${mode}: the row menu has gone under Change icon`, await page.locator(rowMenu).count(), 0);
      await takesPointer("icon picker", ".nt-iconpicker");
    } else check(`${mode}: Change icon opens the picker`, false, true);
    await settle();

    await row.click({ button: "right" });
    await page.waitForSelector(rowMenu);
    await page.waitForTimeout(400);
    await press(page.getByRole("menuitem", { name: /^Delete/ }));
    const confirm = '[role="dialog"][aria-label^="Delete"]';
    if (await appears(page, confirm)) {
      await page.waitForTimeout(400);
      check(`${mode}: the row menu has gone under the delete confirm`, await page.locator(rowMenu).count(), 0);
      await takesPointer("delete confirm", confirm);
      await press(page.locator(confirm).getByRole("button", { name: "Cancel" }));
      check(`${mode}: the confirm's Cancel takes a click`, await appears(page, confirm, "detached"), true);
    } else check(`${mode}: Delete opens the confirm`, false, true);
    if (mode === "drawer") {
      check("drawer: no press fell through to the scrim", await page.evaluate(() => globalThis.drawerHarness.picked), []);
    }

    const unknown = await page.evaluate(() => [...globalThis.drawerHarness.backend.unknown]);
    check(`${mode}: every query the sidebar asked was answered`, unknown, []);
    check(`${mode}: no browser errors`, errors, []);
    await context.close();
  };

  await sidebarScenario("drawer", { width: 800, height: 700 });
  await sidebarScenario("rail", { width: 1280, height: 800 });

  {
    console.log("\nchat drawer at 800×700");
    const { context, page, errors } = await open({ width: 800, height: 700 }, "globalThis.drawerHarness.mountChat()");
    await page.locator("#rewind").click();
    const rewind = '[role="menu"][aria-label="Rewind to before this message"]';
    await page.waitForSelector(rewind);
    await page.waitForTimeout(400);
    const rewindHits = await hits(page, rewind);
    check("chat: Rewind menu takes the pointer", allIn(rewindHits), ALL);
    if (rewindHits.inside !== 5) console.log(`         missed → ${rewindHits.missed.join(", ")} (menu z ${rewindHits.z})`);
    await press(page.getByRole("menuitem", { name: "Conversation only" }));
    check("chat: a Rewind item runs, and the scrim is untouched", await page.evaluate(() => globalThis.drawerHarness.picked), ["rewind:conversation"]);

    await page.locator("#threads").click();
    const threads = '[role="menu"][aria-label="Chats"]';
    await page.waitForSelector(threads);
    await page.waitForTimeout(400);
    check("chat: thread picker takes the pointer", allIn(await hits(page, threads)), ALL);
    await press(page.getByRole("menuitem", { name: /Draft the brief/ }));
    check("chat: a thread is picked", await page.evaluate(() => globalThis.drawerHarness.picked.at(-1)), "thread:thread_2");
    check("chat: no browser errors", errors, []);
    await context.close();
  }

  {
    console.log("\nstoryboard full-size shot at 1280×800");
    const { context, page, errors } = await open({ width: 1280, height: 800 }, "globalThis.drawerHarness.mountShot()");
    await page.locator(".nt-sb-full .nt-sb-ratio").click();
    const ratio = '[role="menu"][aria-label="Frame ratio"]';
    await page.waitForSelector(ratio);
    await page.waitForTimeout(400);
    const ratioHits = await hits(page, ratio);
    check("shot: frame-ratio menu takes the pointer", allIn(ratioHits), ALL);
    if (ratioHits.inside !== 5) console.log(`         missed → ${ratioHits.missed.join(", ")} (menu z ${ratioHits.z})`);
    await press(page.getByRole("menuitem", { name: /^1:1/ }));
    check("shot: a ratio is chosen, and the view stays open", await page.evaluate(() => [globalThis.drawerHarness.ratio, globalThis.drawerHarness.picked]), ["1:1", []]);

    // The bar's settings, which stay open on a click so the toggle is seen to flip.
    await page.locator(".nt-sb-full").getByRole("button", { name: "Settings" }).click();
    const settings = '[role="menu"][aria-label="Canvas settings"]';
    await page.waitForSelector(settings);
    await page.waitForTimeout(400);
    const settingsHits = await hits(page, settings);
    check("shot: settings menu takes the pointer", allIn(settingsHits), ALL);
    if (settingsHits.inside !== 5) console.log(`         missed → ${settingsHits.missed.join(", ")} (menu z ${settingsHits.z})`);
    const grid = page.getByRole("menuitem", { name: "Dot grid" });
    const box = () => grid.locator("span").first().getAttribute("class", { timeout: 1000 }).catch(() => null);
    const was = await box();
    await press(grid);
    const now = await box();
    check("shot: a settings toggle flips", was !== null && now !== null && was !== now, true);
    check("shot: no browser errors", errors, []);
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

if (failures.length) {
  console.error(`\n${failures.length} sidebar drawer menu failure(s):\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("\nall sidebar drawer menu checks passed");
}
