/**
 * NT-79: the header's New project control is one surface that is a button when
 * closed and its menu when open, and the whole menu stays laid out, clipped
 * down to the button. Its holder had no clip of its own and took the pointer
 * over the full open-menu box, 288px wide and as tall as the menu, under the
 * header's right edge. That box sat over the lead card's ⋯ (which then faded
 * out, the lead no longer hovered, and could not be pressed), over part of the
 * lead's open-project link, over the first list rows' ⋯ (two, or four with
 * the Notion import's taller menu), and over the board's top-right card.
 *
 * Drives the real `ProjectsScreen` in grid, list and board view, at 1440, 1024
 * and 600px wide, with the Notion import on offer and not (a third item makes
 * the menu taller). In every one, each control on the screen outside New
 * project must be the topmost element at its own centre. In grid view the lead
 * ⋯ must stay shown with the pointer on it and open its menu, whose Open opens
 * the project; a press on the lead where the box used to be must open the
 * project too. In list view the first row's ⋯ must open its menu. New project
 * itself must still work: its button, its caret, each of its items, and a
 * press away that closes it.
 *
 * `convex/react`, `@clerk/nextjs`, `next/navigation` and `next/link` are
 * swapped at bundle time for an in-memory stand-in. No app server, no Convex,
 * no API keys; every off-origin request fails the run. Runs in CI as part of
 * the canvas browser gate (`tests/canvas-browser.mjs`), on Playwright's
 * Chromium like the rest.
 *
 *   node tests/projects-screen-hit.browser.mjs
 *   CANVAS_CHROME_PATH=/path/to/chrome CANVAS_BROWSER_CHANNEL=headless-shell node tests/projects-screen-hit.browser.mjs
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
const output = await mkdtemp(path.join(tmpdir(), "projects-screen-hit-"));

for (const key of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "MISTRAL_API_KEY", "RECRAFT_API_KEY"]) {
  delete process.env[key];
}

const FIXTURES = {
  "convex-react": `
    import { useCallback, useMemo } from "react";
    import { getFunctionName } from "convex/server";
    const backend = () => window.projectsHarness.backend;
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
      return useCallback(() => { throw new Error("the projects fixture ran an action: " + name); }, [name]);
    }
    export function useConvexAuth() { return { isLoading: false, isAuthenticated: true }; }
    const inert = new Proxy({}, { get(_, key) { throw new Error("the projects fixture's Convex client was used: " + String(key)); } });
    export function useConvex() { return inert; }
  `,
  clerk: `
    const user = { id: "user_owner", fullName: "Olive Owner", primaryEmailAddress: { emailAddress: "olive@example.test" } };
    export function useUser() { return { isLoaded: true, isSignedIn: true, user }; }
    export function useAuth() { return { isLoaded: true, isSignedIn: true, userId: "user_owner" }; }
    export function useClerk() { return { signOut() { throw new Error("sign-out must not run in the fixture"); } }; }
  `,
  navigation: `
    const router = {
      push(href) { window.projectsHarness.went.push(href); },
      replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {},
    };
    export function useRouter() { return router; }
    export function usePathname() { return "/"; }
    export function useSearchParams() { return new URLSearchParams(); }
  `,
  // A plain anchor whose click is recorded rather than followed.
  link: `
    import { createElement } from "react";
    export default function Link({ href, prefetch, ...props }) {
      return createElement("a", { ...props, href, onClick: (e) => {
        props.onClick?.(e);
        e.preventDefault();
        window.projectsHarness.went.push(href);
      } });
    }
  `,
  sentry: `
    export function captureException() {}
    export function captureMessage() {}
    export function addBreadcrumb() {}
  `,
};

await build({
  absWorkingDir: repo, entryPoints: ["tests/projects-screen-hit.browser.tsx"], bundle: true, splitting: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [{ name: "fixture", setup(builder) {
    const to = (name) => () => ({ path: name, namespace: "fixture" });
    builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, to("server-only"));
    builder.onResolve({ filter: /^convex\/react$/ }, to("convex-react"));
    builder.onResolve({ filter: /^@clerk\/nextjs$/ }, to("clerk"));
    builder.onResolve({ filter: /^next\/navigation$/ }, to("navigation"));
    builder.onResolve({ filter: /^next\/link$/ }, to("link"));
    builder.onResolve({ filter: /^@sentry\/nextjs$/ }, to("sentry"));
    builder.onLoad({ filter: /^server-only$/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };' }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: FIXTURES[args.path], loader: "js", resolveDir: repo }));
  } }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
});
// The app's own stylesheet through its own Tailwind pipeline: the header, the
// lead card's hover and the New project surface are exactly what is under test.
const appCss = path.join(repo, "app/globals.css");
const css = await postcss([tailwind({ base: repo })]).process(await readFile(appCss, "utf8"), { from: appCss });
await writeFile(path.join(output, "app.css"), css.css);
await writeFile(path.join(output, "index.html"),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/projects-screen-hit.browser.css"></head>' +
  '<body><div id="app"></div><script type="module" src="/projects-screen-hit.browser.js"></script></body></html>');

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
 * Every control on the screen outside New project whose centre is not the
 * topmost element there, named with what is on top instead. A ⋯ hidden until
 * its card is hovered still counts: opacity does not change what a pointer hits.
 */
const covered = (page) => page.evaluate(() => {
  const name = (el) => el
    ? `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""}`
    : "nothing";
  const out = [];
  for (const el of document.querySelectorAll("main button, main a[href], main [role='button']")) {
    if (el.closest(".nt-create")) continue;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    // Scrolled out of view (the board's later columns at a narrow width).
    if (r.width === 0 || r.height === 0 || x < 0 || x > innerWidth || y < 0 || y > innerHeight) continue;
    const top = document.elementFromPoint(x, y);
    if (!top || !el.contains(top)) out.push(`${name(el)} under ${name(top)}`);
  }
  return out;
});

/** Whether the topmost element at `selector`'s centre is inside it. */
const takesPointer = (page, selector) => page.evaluate((selector) => {
  const el = document.querySelector(selector);
  if (!el) return "missing";
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!top && el.contains(top);
}, selector);

const centre = async (locator) => {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`nothing to press: ${locator}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
/**
 * A press where a person would make it, by the mouse, whatever is painted
 * there. Playwright's own `click` refuses an element another covers, which is
 * the very failure under test; this lets the covering element take the press,
 * as it would for a person, and the check after it say what happened.
 */
async function press(locator) {
  const { x, y } = await centre(locator);
  await locator.page().mouse.click(x, y);
}
const appears = (page, selector, state = "attached") =>
  page.waitForSelector(selector, { state, timeout: 2000 }).then(() => true, () => false);
const went = (page) => page.evaluate(() => globalThis.projectsHarness.went);
const settle = async (page) => {
  for (let i = 0; i < 3 && (await page.locator('.nt-menu:not(.is-closing), [role="dialog"], .nt-create[data-open="true"]').count()); i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
};

const LEAD_MENU = 'button[aria-label="Actions for Launch plan"]';

let browser;
try {
  const { chromium } = await import("playwright");
  browser = await chromium.launch({
    headless: true,
    channel: process.env.CANVAS_BROWSER_CHANNEL === "headless-shell" ? undefined : "chromium",
    executablePath: process.env.CANVAS_CHROME_PATH || undefined,
  });

  const open = async ({ width, height }, options) => {
    // A mouse, so the ⋯ hides until hovered as it does on a desktop.
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: false });
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
    await page.waitForFunction(() => !!globalThis.projectsHarness);
    await page.evaluate((options) => globalThis.projectsHarness.mount(options), options);
    await page.getByText("Launch plan", { exact: true }).first().waitFor({ timeout: 10_000 });
    await page.locator(".nt-create").waitFor();
    await page.waitForTimeout(600); // past the list's staggered entrance
    return { context, page, errors };
  };

  const scenario = async (view, size, notion) => {
    const label = `${view} ${size.width}px, Notion ${notion ? "on" : "off"}`;
    console.log(`\n${label}`);
    const { context, page, errors } = await open(size, { view, notion });

    check(`${label}: New project offers ${notion ? 3 : 2} ways`, await page.locator(".nt-create-way").count(), notion ? 3 : 2);
    check(`${label}: every control outside New project takes the pointer`, await covered(page), []);

    if (view === "grid") {
      const lead = page.locator(".nt-lead");
      const dots = page.locator(LEAD_MENU);
      // Onto the ⋯ the way a person gets there: across the card first.
      const { x, y } = await centre(dots);
      const leadBox = await lead.boundingBox();
      await page.mouse.move(leadBox.x + 40, leadBox.y + leadBox.height / 2);
      await page.mouse.move(x, y, { steps: 8 });
      await page.waitForTimeout(400); // past the ⋯'s fade
      const shown = await page.evaluate(({ selector }) => ({
        leadHovered: document.querySelector(".nt-lead").matches(":hover"),
        opacity: getComputedStyle(document.querySelector(selector)).opacity,
      }), { selector: LEAD_MENU });
      check(`${label}: with the pointer on the lead ⋯, it stays shown`, shown, { leadHovered: true, opacity: "1" });

      await page.mouse.click(x, y);
      const menu = '[role="menu"][aria-label="Actions for Launch plan"]';
      check(`${label}: clicking the lead ⋯ opens its menu`, await appears(page, menu), true);
      if (await page.locator(menu).count()) {
        await page.waitForTimeout(300);
        await press(page.getByRole("menuitem", { name: "Open", exact: true }));
        check(`${label}: its Open opens the project`, await went(page), ["/p/project_0"]);
      }
      await settle(page);

      // On the lead, left of its ⋯, where the New project box used to reach.
      await page.evaluate(() => { globalThis.projectsHarness.went = []; });
      const box = await dots.boundingBox();
      const spot = { x: box.x - 48, y: box.y + box.height + 24 };
      const inside = await lead.evaluate((el, spot) => {
        const r = el.getBoundingClientRect();
        return spot.x > r.left && spot.x < r.right && spot.y > r.top && spot.y < r.bottom;
      }, spot);
      check(`${label}: the press is on the lead`, inside, true);
      await page.mouse.click(spot.x, spot.y);
      await page.waitForTimeout(100);
      check(`${label}: a press on the lead under the header's edge opens the project`, await went(page), ["/p/project_0"]);
    }

    if (view === "list") {
      const first = page.locator("main li").filter({ hasText: "Launch plan" }).locator(LEAD_MENU);
      await press(first);
      const menu = '[role="menu"][aria-label="Actions for Launch plan"]';
      check(`${label}: clicking the first row's ⋯ opens its menu`, await appears(page, menu), true);
      await settle(page);
    }

    // New project itself, untouched: its button, its caret and each way.
    await page.evaluate(() => { globalThis.projectsHarness.went = []; });
    check(`${label}: New project takes the pointer`, await takesPointer(page, ".nt-create-main"), true);
    check(`${label}: its caret takes the pointer`, await takesPointer(page, ".nt-create-caret"), true);
    await press(page.locator(".nt-create-main"));
    check(`${label}: New project opens the palette`, await appears(page, '[aria-label="Ways to start"]'), true);
    await settle(page);

    const ways = ["Blank project", "Start from template", ...(notion ? ["Import from Notion"] : [])];
    for (const way of ways) {
      await press(page.locator(".nt-create-caret"));
      const opened = await page.locator('.nt-create[data-open="true"]').count();
      check(`${label}: the caret opens the menu (for ${way})`, opened, 1);
      await page.waitForTimeout(600); // past the spring
      const item = page.getByRole("menuitem", { name: new RegExp(`^${way}`) });
      check(`${label}: ${way} takes the pointer`, await item.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!top && el.contains(top);
      }), true);
      await press(item);
      check(`${label}: ${way} closes the menu`, await appears(page, '.nt-create[data-open="false"]'), true);
      check(`${label}: ${way} opens what it says`, await page.locator('[role="dialog"]').count() > 0, true);
      await settle(page);
    }

    // Open, then a press away closes it and lands on nothing under the menu.
    await press(page.locator(".nt-create-caret"));
    await page.waitForTimeout(600);
    await page.mouse.click(16, size.height - 16);
    check(`${label}: a press away closes the menu`, await appears(page, '.nt-create[data-open="false"]'), true);
    await page.waitForTimeout(400);
    check(`${label}: closed again, every control takes the pointer`, await covered(page), []);

    const unknown = await page.evaluate(() => [...globalThis.projectsHarness.backend.unknown]);
    check(`${label}: every query the screen asked was answered`, unknown, []);
    check(`${label}: no browser errors`, errors, []);
    await context.close();
  };

  for (const view of ["grid", "list", "board"]) {
    for (const size of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 600, height: 900 }]) {
      for (const notion of [true, false]) await scenario(view, size, notion);
    }
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

if (failures.length) {
  console.error(`\n${failures.length} projects screen hit failure(s):\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("\nall projects screen hit checks passed");
}
