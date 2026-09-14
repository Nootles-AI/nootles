/**
 * The shared node-side half of the canvas browser harness — one esbuild
 * build, one static server, one Playwright launch, one set of network
 * guards, and the `check`/`xfail`/`todo` accounting every runner
 * (`canvas-camera.browser.mjs`, `canvas-picking.browser.mjs`,
 * `canvas-stage.browser.mjs`, and every later slice's own `.browser.mjs`)
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
import { build } from "esbuild";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const execFileAsync = promisify(execFile);

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
 * A/B re-recording (§3.1.6): serves every `app/**` `.ts`/`.tsx`/`.css` file
 * from `git show <ref>:<path>` instead of disk, so bundle A is "the tree at
 * `ref`" and bundle B (built without this plugin) is the working tree —
 * same process, same browser, only the source differs.
 */
function refSourcePlugin(ref) {
  const appRoot = path.join(repo, "app") + path.sep;
  return {
    name: "canvas-baseline-ref",
    setup(builder) {
      builder.onLoad({ filter: /\.(ts|tsx|css)$/ }, async (args) => {
        if (!args.path.startsWith(appRoot)) return null;
        const rel = path.relative(repo, args.path).split(path.sep).join("/");
        try {
          const { stdout } = await execFileAsync("git", ["show", `${ref}:${rel}`], { cwd: repo, maxBuffer: 1024 * 1024 * 32 });
          const loader = rel.endsWith(".css") ? "css" : rel.endsWith(".tsx") ? "tsx" : "ts";
          return { contents: stdout, loader, resolveDir: path.dirname(args.path) };
        } catch {
          // Didn't exist at `ref` (a file added since) — fall through to disk.
          return null;
        }
      });
    },
  };
}

/**
 * Builds the harness page once and serves it from a temp dir on 127.0.0.1.
 * `ref`, when given, builds `app/**` from that git ref instead of the
 * working tree (§3.1.6's A/B re-recording) — everything outside `app/**`
 * (this file, the fixtures, `tests/canvas-harness.browser.tsx` itself)
 * always comes from the working tree, since only the canvas implementation
 * is what a baseline re-record is asking "did THIS change cost anything".
 */
export async function buildHarness({ ref } = {}) {
  const output = await mkdtemp(path.join(tmpdir(), "canvas-harness-"));
  const plugins = [rejectNextServerDiagnosticsPlugin()];
  if (ref) plugins.push(refSourcePlugin(ref));

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
    plugins,
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
    logLevel: "warning",
    metafile: true,
  });

  // The canvas CSS consumes `--radius-lg`, `--border`, `--muted`, `--dur`,
  // `--ease`, `--z-modal`, `--selected`… from `:root`, declared by Tailwind's
  // base layer — exactly the `tests/nml-view.browser.mjs` pattern.
  const appCssPath = path.join(repo, "app/globals.css");
  const styles = await postcss([tailwind({ base: repo })]).process(await readFile(appCssPath, "utf8"), {
    from: appCssPath,
  });
  await writeFile(path.join(output, "app.css"), styles.css);

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

/**
 * Launches Chromium and decides whether rAF is actually unlocked here: at
 * vsync-locked 60Hz a "5% of baseline" gate is meaningless noise (intervals
 * quantise to 16.7/33.3ms), so the gate mode travels with the baseline file
 * rather than being assumed.
 */
export async function launch({ unlockedFrames = true } = {}) {
  const { chromium } = await import("playwright");
  const channel = process.env.CANVAS_BROWSER_CHANNEL === "headless-shell" ? undefined : "chromium";
  const executablePath = process.env.CANVAS_CHROME_PATH || undefined;
  const browser = await chromium.launch({
    headless: true,
    channel,
    executablePath,
    args: unlockedFrames ? ["--disable-frame-rate-limit", "--disable-gpu-vsync"] : [],
  });
  const version = browser.version();

  const probe = await browser.newPage();
  await probe.setContent("<!doctype html><title>canvas-harness rate probe</title>");
  const intervals = await probe.evaluate(
    () =>
      new Promise((resolve) => {
        const out = [];
        let last = 0;
        let n = 0;
        const tick = (now) => {
          if (last !== 0) out.push(now - last);
          last = now;
          if (++n < 61) requestAnimationFrame(tick);
          else resolve(out);
        };
        requestAnimationFrame(tick);
      }),
  );
  await probe.close();
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 16.7;
  const mode = median < 12 ? "unlocked" : "vsync";

  return { browser, mode, version };
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

/** Nearest-rank percentiles on the sorted array — no interpolation, so a
 *  reported number is always one of the actual samples. */
export function percentiles(samples) {
  const n = samples.length;
  if (n === 0) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
  return { n, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[n - 1] };
}

/** Count of frame intervals more than 1.5x the nominal frame time — the
 *  vsync-mode gate's currency, since a p95 envelope means nothing at a
 *  quantised 60Hz. */
export function droppedFrames(intervals, nominal) {
  return intervals.filter((v) => v > 1.5 * nominal).length;
}

/** `${platform}-${arch}-${cpuModelSlug}-chromium${major}` — a mismatch on
 *  any part is a different machine, not a comparable run. */
export async function machineKey(version) {
  const cpuModel = os.cpus()?.[0]?.model ?? "unknown";
  const slug = cpuModel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "");
  const major = /(\d+)\./.exec(version)?.[1] ?? "0";
  return `${process.platform}-${process.arch}-${slug}-chromium${major}`;
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
