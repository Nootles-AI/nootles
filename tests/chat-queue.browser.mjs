/**
 * NT-21: asking while the agent is answering, and Escape to stop.
 *
 * The real composer over the real `useProjectChat`; only `/api/chat` is a
 * harness stream, held open so each turn ends exactly when this file says so.
 * Chromium types and clicks — nothing is driven through React internals.
 *
 * node tests/chat-queue.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "chat-queue-"));

// The thread's history and the project's pages come through the same hook; the
// args say which is being asked for. The page list is real so that "@" opens a
// real mention menu, which is what Escape has to be taken away from.
const CONVEX = `
export function useQuery(_query, args) {
  if (args === "skip" || !args) return undefined;
  if (args.threadId) return [];
  if (args.projectId) return [{ _id: "page1", title: "Plan" }];
  return [];
}
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
  entryPoints: ["tests/chat-queue.browser.tsx"],
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
      name: "chat-queue-fixture",
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
        const stub = (name, contents) =>
          builder.onLoad({ filter: new RegExp(`^${name}$`), namespace: "fixture" }, () => ({
            contents,
            loader: "js",
          }));
        stub("convex-react", CONVEX);
        stub("server-only", SERVER_ONLY);
        stub("open-page", OPEN_PAGE);
        stub("review", REVIEW);
        stub("editors", EDITORS);
        stub("telemetry", TELEMETRY);
      },
    },
  ],
  logLevel: "warning",
});

// Layout enough to click: the rail's own stylesheet is Tailwind-built and not
// what is under test, but a zero-size element is not clickable.
const CSS = `
  body { margin: 0; font: 13px system-ui; }
  #rail { width: 320px; }
  .nt-composer { position: relative; border: 1px solid #ddd; }
  .nt-composer-input { display: block; width: 100%; min-height: 24px; resize: none; }
  .nt-composer-actions { display: flex; justify-content: space-between; padding: 4px; }
  .nt-composer-queue { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 4px; list-style: none; }
  .nt-queued { display: flex; gap: 6px; }
  .nt-chip-remove { width: 16px; height: 16px; }
  .nt-mention-menu { position: absolute; bottom: 100%; left: 0; right: 0; background: #fff; }
  .nt-mention-item { display: block; width: 100%; }
`;

await writeFile(
  path.join(output, "index.html"),
  `<!doctype html><html><head><style>${CSS}</style></head><body><div id="app"></div><script type="module" src="/chat-queue.browser.js"></script></body></html>`,
);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") {
      response.writeHead(204);
      return void response.end();
    }
    const name = pathname === "/" ? "index.html" : path.basename(pathname);
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
  failures.push(
    `${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`,
  );
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
  await page.goto(origin, { waitUntil: "load" });

  /** A whole frame and a macrotask: the store batches its emits into a frame. */
  const settle = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 60))),
    );

  const state = () => page.textContent("#state");
  const chips = async () => {
    await settle();
    return page.$$eval(".nt-queued-label", (nodes) => nodes.map((n) => n.textContent));
  };
  const box = () => page.inputValue(".nt-composer-input");
  const requests = () => page.evaluate(() => globalThis.chatQueueHarness.turns.length);
  const asked = () => page.evaluate(() => globalThis.chatQueueHarness.asked());
  const aborted = () => page.evaluate(() => globalThis.chatQueueHarness.aborted());
  const finish = (index) =>
    page.evaluate((i) => globalThis.chatQueueHarness.finish(i), index);
  const type = async (text) => {
    await page.click(".nt-composer-input");
    await page.keyboard.type(text);
  };
  /** Asks, and waits for the ask to have landed somewhere — sent, or waiting. */
  const ask = async (text) => {
    const before = await page.evaluate(() => ({
      turns: globalThis.chatQueueHarness.turns.length,
      queued: document.querySelectorAll(".nt-queued").length,
    }));
    await type(text);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelector(".nt-composer-input").value === "",
    );
    await page.waitForFunction(
      (b) =>
        globalThis.chatQueueHarness.turns.length > b.turns ||
        document.querySelectorAll(".nt-queued").length > b.queued,
      before,
    );
  };

  await page.waitForFunction(() => document.querySelector("#state")?.textContent === "idle");

  console.log("\nAsking while it answers");
  await ask("one");
  await page.waitForFunction(() => globalThis.chatQueueHarness.turns.length === 1);
  await page.waitForFunction(() => document.querySelector("#state")?.textContent === "busy");
  check("the first question goes straight out", await asked(), ["one"]);
  check("Stop is offered while it answers", await page.isVisible(".nt-composer-stop"), true);
  check("Send waits on words, not on the answer", await page.isEnabled(".nt-composer-send"), false);

  await ask("two");
  check("a question asked mid-answer waits", await chips(), ["two"]);
  check("and the box is clear for the next one", await box(), "");
  await settle();
  check("nothing is sent while the answer runs", await requests(), 1);

  await ask("three");
  check("they queue in order", await chips(), ["two", "three"]);

  console.log("\nTaking one back");
  await page.click('[aria-label=\'Don\\\'t send "three"\']');
  await page.waitForFunction(() => document.querySelectorAll(".nt-queued").length === 1);
  check("removing a waiting question leaves the rest", await chips(), ["two"]);

  console.log("\nDraining");
  await finish(0);
  await page.waitForFunction(() => globalThis.chatQueueHarness.turns.length === 2);
  check("the answer ending sends the next question", await asked(), ["one", "two"]);
  check("and it leaves the queue", await chips(), []);
  await settle();
  check("one at a time", await requests(), 2);
  check("it is answering again", await state(), "busy");

  await ask("four");
  await ask("five");
  check("two more wait", await chips(), ["four", "five"]);
  await finish(1);
  await page.waitForFunction(() => globalThis.chatQueueHarness.turns.length === 3);
  check("the head of the queue goes first", (await asked())[2], "four");
  check("the rest keeps waiting", await chips(), ["five"]);
  await finish(2);
  await page.waitForFunction(() => globalThis.chatQueueHarness.turns.length === 4);
  check("then the one behind it", (await asked())[3], "five");
  check("the queue is empty", await chips(), []);

  console.log("\nEscape");
  await ask("six");
  check("one waiting", await chips(), ["six"]);
  await type("@Pl");
  await page.waitForSelector('[aria-label="Mention"]');
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector('[aria-label="Mention"]'));
  check("Escape closes the mention menu first", await state(), "busy");
  check("and stops nothing", await aborted(), 0);
  check("the waiting question is still waiting", await chips(), ["six"]);

  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#state")?.textContent === "idle");
  check("Escape again stops the answer", await aborted(), 1);
  check("and drops what was waiting behind it", await chips(), []);
  await settle();
  check("a stopped turn sends nothing more", await requests(), 4);
  check("Stop is gone", await page.isVisible(".nt-composer-stop"), false);
  check("the box still holds what was typed", await box(), "@Pl");

  console.log("\nStop, with the mouse, and asking again after");
  await page.fill(".nt-composer-input", "");
  await ask("seven");
  await page.waitForFunction(() => globalThis.chatQueueHarness.turns.length === 5);
  await ask("eight");
  check("queued behind the new answer", await chips(), ["eight"]);
  await page.click(".nt-composer-stop");
  await page.waitForFunction(() => document.querySelector("#state")?.textContent === "idle");
  check("the Stop button stops it too", await aborted(), 2);
  check("and clears the queue", await chips(), []);

  await ask("nine");
  await page.waitForFunction(() => globalThis.chatQueueHarness.turns.length === 6);
  check("the chat works after a stop", (await asked())[5], "nine");

  console.log("\nA mention written into a waiting question");
  await type("@Pl");
  await page.waitForSelector('[aria-label="Mention"]');
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.querySelector('[aria-label="Mention"]'));
  await ask("and summarise it");
  // The row reads "Current page"; what it writes is the page's own title.
  check("it waits with its mention", await chips(), ["@Plan and summarise it"]);

  await finish(5);
  await page.waitForFunction(() => globalThis.chatQueueHarness.turns.length === 7);
  // Resolved when the queue reached it, not when it was written: the answer it
  // waited for is exactly what changed the page it points at.
  check(
    "the mention is read and sent with it",
    await page.evaluate(() => {
      const body = globalThis.chatQueueHarness.turns[6].body;
      const last = body.messages[body.messages.length - 1];
      return last.parts
        .filter((part) => part.type === "data-mention")
        .map((part) => ({ kind: part.data.kind, pageId: part.data.pageId }));
    }),
    [{ kind: "page", pageId: "page1" }],
  );

  check("no browser errors", errors, []);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

if (failures.length) {
  throw new Error(`chat queue failures:\n${failures.join("\n")}`);
}
console.log("\nall chat queue checks passed");
