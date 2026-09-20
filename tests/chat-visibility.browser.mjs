/**
 * NT-61: hiding the chat rail must not cancel an in-flight BrowserChat.
 *
 * Uses the production hook and transport with Convex/context seams held in
 * memory. The stream never completes; then the same panel is first hidden and
 * later actually unmounted, proving the former preserves the request and the
 * latter remains the cleanup boundary.
 *
 * node tests/chat-visibility.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "chat-visibility-"));

const CONVEX = `
export function useQuery(_query, args) { return args === "skip" ? undefined : []; }
export function useMutation() { return async () => null; }
export function useConvex() { return {}; }
`;
const OPEN_PAGE = `export function useOpenPage() { return { open: () => {} }; }`;
const REVIEW = `
const review = {
  beginTurn: async () => null,
  endTurn: async () => null,
  restoreCheckpoint: async () => null,
  previewRestore: async () => [],
  cancelRestore: async () => null,
  settleRestore: async () => null,
};
export function useReview() { return review; }
`;
const EDITORS = `export function useEditorRegistry() { return { editorFor: () => null }; }`;
const TELEMETRY = `export function track() {}`;
const SERVER_ONLY = `exports.sync = () => { throw new Error("server-only gzip diagnostics reached browser fixture"); };`;

await build({
  absWorkingDir: repo,
  entryPoints: ["tests/chat-visibility.browser.tsx"],
  bundle: true,
  format: "esm",
  outdir: output,
  platform: "browser",
  conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"development"' },
  banner: {
    js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };',
  },
  plugins: [
    {
      name: "chat-visibility-fixture",
      setup(builder) {
        builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({
          path: "server-only",
          namespace: "fixture",
        }));
        builder.onResolve({ filter: /^convex\/react$/ }, () => ({
          path: "convex-react",
          namespace: "fixture",
        }));
        builder.onResolve({ filter: /(^|\/)OpenPageContext$/ }, () => ({
          path: "open-page",
          namespace: "fixture",
        }));
        builder.onResolve({ filter: /(^|\/)ReviewContext$/ }, () => ({
          path: "review",
          namespace: "fixture",
        }));
        builder.onResolve({ filter: /(^|\/)EditorRegistry$/ }, () => ({
          path: "editors",
          namespace: "fixture",
        }));
        builder.onResolve({ filter: /(^|\/)telemetry$/ }, () => ({
          path: "telemetry",
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /^convex-react$/, namespace: "fixture" }, () => ({
          contents: CONVEX,
          loader: "js",
        }));
        builder.onLoad({ filter: /^server-only$/, namespace: "fixture" }, () => ({
          contents: SERVER_ONLY,
          loader: "js",
        }));
        builder.onLoad({ filter: /^open-page$/, namespace: "fixture" }, () => ({
          contents: OPEN_PAGE,
          loader: "js",
        }));
        builder.onLoad({ filter: /^review$/, namespace: "fixture" }, () => ({
          contents: REVIEW,
          loader: "js",
        }));
        builder.onLoad({ filter: /^editors$/, namespace: "fixture" }, () => ({
          contents: EDITORS,
          loader: "js",
        }));
        builder.onLoad({ filter: /^telemetry$/, namespace: "fixture" }, () => ({
          contents: TELEMETRY,
          loader: "js",
        }));
      },
    },
  ],
  logLevel: "warning",
});

await writeFile(
  path.join(output, "index.html"),
  '<!doctype html><html><head><style>.nt-panel { display: flex; }.hidden { display: none; }</style></head><body><div id="app"></div><script type="module" src="/chat-visibility.browser.js"></script></body></html>',
);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") {
      response.writeHead(204);
      return void response.end();
    }
    const name = pathname === "/"
      ? "index.html"
      : path.basename(pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader(
      "Content-Type",
      name.endsWith(".js") ? "text/javascript" : "text/html",
    );
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
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
  console.log(`  FAIL ${name}`);
};

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.NML_CHROME_PATH ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(origin, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.querySelector("#chat-rail")?.textContent === "ready");

  await page.evaluate(() => globalThis.chatVisibilityHarness.send());
  await page.waitForFunction(() => globalThis.chatVisibilityHarness.requestStarted);
  check("stream starts", await page.evaluate(() => globalThis.chatVisibilityHarness.requestStarted), true);

  await page.evaluate(() => globalThis.chatVisibilityHarness.setPhase("hidden"));
  await page.waitForFunction(() => document.querySelector("#chat-rail")?.hidden === true);
  check("hidden rail leaves layout", await page.evaluate(() => getComputedStyle(document.querySelector("#chat-rail")).display), "none");
  check("hidden rail does not abort", await page.evaluate(() => globalThis.chatVisibilityHarness.requestAborted), false);

  await page.evaluate(() => globalThis.chatVisibilityHarness.setPhase("shown"));
  await page.waitForFunction(() => document.querySelector("#chat-rail")?.hidden === false);
  check("returning to chat keeps stream live", await page.evaluate(() => globalThis.chatVisibilityHarness.requestAborted), false);

  await page.evaluate(() => globalThis.chatVisibilityHarness.setPhase("gone"));
  await page.waitForFunction(() => globalThis.chatVisibilityHarness.requestAborted);
  check("actual unmount aborts stream", await page.evaluate(() => globalThis.chatVisibilityHarness.requestAborted), true);
  check("no browser errors", errors, []);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

if (failures.length) {
  throw new Error(`chat visibility failures:\n${failures.join("\n")}`);
}
