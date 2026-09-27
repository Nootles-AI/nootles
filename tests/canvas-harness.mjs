/**
 * The shared node-side half of the canvas browser harness — one esbuild
 * build, one static server, one Playwright launch, one set of network
 * guards, and the `check`/`xfail`/`todo` accounting every runner
 * (`canvas-picking.browser.mjs` and every later slice's own `.browser.mjs`)
 * builds on. Nothing here drives a scenario — that is each runner's own job.
 *
 * Uses the existing esbuild dependency, `@tailwindcss/postcss` (already a
 * devDependency, used the same way `tests/nml-view.browser.mjs` uses it) and
 * Playwright. No app server, no Convex, no API keys — see §2.6 of
 * HARNESS.md: every non-origin request is aborted and fails the run, the
 * page's own `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource`/
 * `sendBeacon` throw, and the esbuild `metafile` is compared against a
 * committed allowlist of `app/lib/ai/**` modules the canvas bundle may
 * reach — a *new* edge into a lane module is a visible diff in a PR, never a
 * surprise in production.
 */
import { build, transform } from "esbuild";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function contentTypeFor(name) {
  if (name.endsWith(".js") || name.endsWith(".mjs")) return "text/javascript";
  if (name.endsWith(".css")) return "text/css";
  if (name.endsWith(".html")) return "text/html";
  if (name.endsWith(".woff2")) return "font/woff2";
  if (name.endsWith(".woff")) return "font/woff";
  if (name.endsWith(".ttf")) return "font/ttf";
  if (name.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

/** The plugin every existing `*.browser.mjs` build already carries, copied
 *  in shape from `tests/editor-scroll.browser.mjs`: Next's server-only gzip
 *  diagnostics module has no browser build and must never be reached. */
function rejectNextServerDiagnosticsPlugin() {
  return {
    name: "reject-next-server-diagnostics",
    setup(builder) {
      builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({
        path: "server-only",
        namespace: "fixture",
      }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };',
      }));
    },
  };
}

/**
 * Writes `app/globals.css`, compiled by the app's own Tailwind pipeline, into
 * `output` as `app.css` — the only supported way a fixture gets the app's
 * `:root`. Hand-written stand-ins were the alternative, and they are how the
 * block-drag harness came to assert against tokens no fixture declared: the
 * dropdown's `--bn-colors-menu-background` resolves through `--elevated`, so a
 * missing token makes a themed surface compute `transparent` and reads as a
 * product regression (NT-72). A fixture that loads this one file cannot drift
 * from the app again, whatever `:root` grows next.
 *
 * The column's measures are not in the stylesheet — the root layout sets them
 * on `<html>` from `COLUMN_VARS` — so they are appended here from the same
 * module.
 */
export async function writeAppStylesheet(output) {
  const appCssPath = path.join(repo, "app/globals.css");
  const styles = await postcss([tailwind({ base: repo })]).process(
    await readFile(appCssPath, "utf8"),
    { from: appCssPath },
  );
  const column = await transform(await readFile(path.join(repo, "app/lib/column.ts"), "utf8"), {
    loader: "ts",
    format: "esm",
  });
  const { COLUMN_VARS } = await import(`data:text/javascript,${encodeURIComponent(column.code)}`);
  const vars = Object.entries(COLUMN_VARS)
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");
  await writeFile(path.join(output, "app.css"), `${styles.css}\n:root { ${vars} }\n`);
}

/** Builds the harness page once and serves it from a temp dir on 127.0.0.1. */
export async function buildHarness() {
  const output = await mkdtemp(path.join(tmpdir(), "canvas-harness-"));

  const result = await build({
    absWorkingDir: repo,
    entryPoints: ["tests/canvas-harness.browser.tsx"],
    bundle: true,
    splitting: true,
    format: "esm",
    outdir: output,
    platform: "browser",
    conditions: ["browser", "import", "style"],
    tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"development"' },
    banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
    plugins: [rejectNextServerDiagnosticsPlugin()],
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
    logLevel: "warning",
    metafile: true,
  });

  // The canvas CSS consumes `--radius-lg`, `--border`, `--muted`, `--dur`,
  // `--ease`, `--z-modal`, `--selected`… from `:root`, declared by Tailwind's
  // base layer — exactly the `tests/nml-view.browser.mjs` pattern.
  await writeAppStylesheet(output);

  await writeFile(
    path.join(output, "index.html"),
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
      '<link rel="stylesheet" href="/app.css">' +
      '<link rel="stylesheet" href="/canvas-harness.browser.css">' +
      '</head><body><div id="app"></div><script type="module" src="/canvas-harness.browser.js"></script></body></html>',
  );

  const aiReach = Object.keys(result.metafile.inputs)
    .filter((p) => p.startsWith("app/lib/ai/"))
    .sort();

  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      const name = pathname === "/" ? "index.html" : path.basename(pathname);
      const data = await readFile(path.join(output, name));
      response.setHeader("Content-Type", contentTypeFor(name));
      response.end(data);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    output,
    aiReach,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Launches headless Chromium — the bundled build, or `CANVAS_CHROME_PATH`. */
export async function launch() {
  const { chromium } = await import("playwright");
  const channel = process.env.CANVAS_BROWSER_CHANNEL === "headless-shell" ? undefined : "chromium";
  const executablePath = process.env.CANVAS_CHROME_PATH || undefined;
  const browser = await chromium.launch({ headless: true, channel, executablePath });
  return { browser };
}

/**
 * Makes the page read as macOS, so `isApplePlatform()` resolves `Mod` to ⌘ and
 * a harness can press `Meta` for deep-select, the layer menu and every chord
 * the probe tables are written in. Must run before the bundle loads:
 * `shortcuts.ts` memoises the answer on first call.
 *
 * The canvas gate pins one platform rather than following the host's. A
 * developer's Mac and CI's Linux runner otherwise exercise different bindings
 * from the same table — which is what kept 21 `picking.*.cmd` probes failing
 * on every CI run and passing on every laptop (NT-72). The off-Apple bindings
 * are `app/components/editor/canvas/engine/shortcuts.test.ts`'s job, and it
 * covers both tables directly.
 */
export const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export async function pretendApplePlatform(page) {
  await page.addInitScript((ua) => {
    Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
  }, MAC_UA);
}

/**
 * A fresh page on the fixture's origin, every non-origin request aborted and
 * recorded as a failure, and the runtime API stubs of §2.6 installed before
 * any page script runs.
 */
export async function openPage(browser, origin, opts = {}) {
  const page = await browser.newPage({ viewport: opts.viewport ?? { width: 1280, height: 900 } });
  const errors = [];
  const requests = [];

  page.on("pageerror", (error) => errors.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    const type = message.type();
    if (type !== "error" && type !== "warning") return;
    errors.push(`console ${type}: ${message.text()}`);
  });

  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`)) return route.continue();
    requests.push(url);
    return route.abort();
  });

  await page.addInitScript((aiReach) => {
    window.__aiReach = aiReach;
    window.__blocked = [];
    const block = (name, urlOf) => (...args) => {
      window.__blocked.push(`${name}:${urlOf(args)}`);
      throw new Error("fixture: network is off");
    };
    window.fetch = block("fetch", (args) => (typeof args[0] === "string" ? args[0] : args[0]?.url ?? ""));
    XMLHttpRequest.prototype.open = block("xhr", (args) => String(args[1] ?? ""));
    window.WebSocket = function (...args) {
      block("websocket", (a) => String(a[0] ?? ""))(...args);
    };
    window.EventSource = function (...args) {
      block("eventsource", (a) => String(a[0] ?? ""))(...args);
    };
    if (navigator.sendBeacon) {
      navigator.sendBeacon = block("sendBeacon", (args) => String(args[0] ?? ""));
    }
  }, opts.aiReach ?? []);

  return { page, guards: { requests: () => [...requests], errors: () => [...errors] } };
}

/** `JSON.stringify` comparison, printing `ok`/`FAIL` — the same idiom every
 *  existing `*.browser.mjs` runner already uses, plus `xfail`/`todo`. */
export function checker() {
  const failures = [];
  let failed = 0;
  let xfailed = 0;
  let xpassed = 0;
  let todoCount = 0;

  const fmt = (value) => JSON.stringify(value);

  return {
    check(name, actual, expected) {
      const a = fmt(actual);
      const e = fmt(expected);
      if (a === e) {
        console.log(`  ok   ${name}`);
        return;
      }
      failed++;
      failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
      console.log(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`);
    },
    xfail(slice, name, actual, expected) {
      const a = fmt(actual);
      const e = fmt(expected);
      if (a === e) {
        xpassed++;
        failed++;
        failures.push(`${name}: XPASS (${slice}) — remove the xfail mark\n    both  ${e}`);
        console.log(`  XPASS ${name} (${slice}) — remove the xfail mark`);
        return;
      }
      xfailed++;
      console.log(`  xfail (${slice}) ${name}`);
    },
    todo(name) {
      todoCount++;
      console.log(`  todo ${name}`);
    },
    summary: () => ({ failed, xfailed, xpassed, todo: todoCount }),
    failures,
  };
}

/** `tests/.artifacts/<name>.<iso>.json`, pass or fail. */
export async function writeArtifact(name, data) {
  const dir = path.join(repo, "tests/.artifacts");
  await mkdir(dir, { recursive: true });
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${name}.${iso}.json`);
  await writeFile(file, JSON.stringify(data, null, 2));
  return file;
}
