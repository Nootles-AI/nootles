/**
 * NT-94: `read_page` on a long page, expanding one block, driven through the
 * real chat.
 *
 * A person asks about a long page of field notes holding two large diagrams
 * and an album; a scripted model stand-in answers each `/api/chat` request with
 * the `read_page` call a model makes to look at one of them whole. The real
 * `useProjectChat` runs it against the live editor, and the next request's body
 * is read for what the tool handed the model.
 *
 * Before the fix, naming any block in `expand` lifted the 24K cap off the whole
 * page, so each of these reads came back as the entire ~110K page.
 *
 * The stand-in is a route on this harness's own origin; every other request
 * fails the run, and the socket is inert. No app server, no Convex, no model,
 * no API key. Screenshots land in tests/.artifacts/chat-read-page/.
 *
 *   node tests/chat-read-page.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./comments-launch.mjs";

for (const key of [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "MISTRAL_API_KEY",
  "RECRAFT_API_KEY",
]) {
  delete process.env[key];
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "chat-read-page-"));
const shots = path.join(repo, "tests", ".artifacts", "chat-read-page");
await mkdir(shots, { recursive: true });

const CONVEX = `
import { getFunctionName } from "convex/server";
export function useQuery(query, args) {
  if (args === "skip") return undefined;
  switch (getFunctionName(query)) {
    case "chat/messages:list": return [];
    case "commentNotices:mentionable": return [];
    case "pages:listByProject": return [{ _id: "page1", title: "Field notes", order: 0 }];
    default: return undefined;
  }
}
export function useMutation() {
  const mutate = async () => null;
  mutate.withOptimisticUpdate = () => mutate;
  return mutate;
}
export function useAction() { return async () => null; }
export function useConvexAuth() { return { isLoading: false, isAuthenticated: true }; }
export function useConvex() { return globalThis.readPageHarness.convex; }
`;
const REVIEW = `
import { useMemo, useSyncExternalStore } from "react";
const current = () => globalThis.readPageHarness.session;
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
const CLERK = `export function useAuth() { return { isLoaded: true, isSignedIn: true, userId: "user_ada" }; }`;
const OPEN_PAGE = `export function useOpenPage() { return { open: () => {} }; }`;
const EDITORS = `export function useEditorRegistry() { return { editorFor: async () => globalThis.readPageHarness.editor }; }`;
const TELEMETRY = `export function track() {}`;
const SERVER_ONLY = `exports.sync = () => { throw new Error("server-only gzip diagnostics reached browser fixture"); };`;
const CHAT_HOOK = path.join("app", "lib", "ai", "chat", "useProjectChat.ts");

await build({
  absWorkingDir: repo,
  entryPoints: ["tests/chat-read-page.browser.tsx"],
  bundle: true,
  splitting: true,
  format: "esm",
  outdir: output,
  platform: "browser",
  conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
  plugins: [
    {
      name: "chat-read-page-fixture",
      setup(builder) {
        const redirect = (filter, name) =>
          builder.onResolve({ filter }, () => ({ path: name, namespace: "fixture" }));
        redirect(/^next\/dist\/compiled\/gzip-size$/, "server-only");
        redirect(/^convex\/react$/, "convex-react");
        redirect(/^@clerk\/nextjs$/, "clerk");
        redirect(/(^|\/)ReviewContext$/, "review");
        redirect(/(^|\/)telemetry$/, "telemetry");
        const forChat = (filter, name) =>
          builder.onResolve({ filter }, (args) =>
            args.importer.endsWith(CHAT_HOOK) ? { path: name, namespace: "fixture" } : undefined,
          );
        forChat(/(^|\/)OpenPageContext$/, "open-page");
        forChat(/(^|\/)EditorRegistry$/, "editors");
        const stub = (name, contents) =>
          builder.onLoad({ filter: new RegExp(`^${name}$`), namespace: "fixture" }, () => ({
            contents,
            loader: "js",
            resolveDir: repo,
          }));
        stub("convex-react", CONVEX);
        stub("server-only", SERVER_ONLY);
        stub("clerk", CLERK);
        stub("review", REVIEW);
        stub("open-page", OPEN_PAGE);
        stub("editors", EDITORS);
        stub("telemetry", TELEMETRY);
      },
    },
  ],
  logLevel: "warning",
});

// The review's diff colours live in globals.css, which imports Tailwind; the
// two a hunk paints with are copied here so the screenshots show them.
const CSS = `
  body { margin: 0; font: 14px system-ui; }
  :root { --diff-add-bg: oklch(0.962 0.024 148); --diff-add-line: oklch(0.63 0.105 148); --diff-del: oklch(0.548 0.115 25); --diff-del-bg: oklch(0.958 0.019 25); --border-strong: oklch(0.875 0.004 90); }
  #rail { width: 420px; padding: 24px 0; }
  #tools { font-size: 12px; }
  .nt-composer { position: relative; border: 1px solid #ddd; }
  .nt-composer-input { display: block; width: 100%; min-height: 24px; resize: none; }
  .nt-composer-actions { display: flex; justify-content: space-between; padding: 4px; }
  .nt-review-bar { display: flex; gap: 8px; align-items: center; margin-top: 16px; }
`;
await writeFile(
  path.join(output, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/chat-read-page.browser.css"><style>${CSS}</style></head><body><div id="app"></div><script type="module" src="/chat-read-page.browser.js"></script></body></html>`,
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
      name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream",
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
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return void console.log(`  ok   ${name}`);
  failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
  console.log(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- The model stand-in -------------------------------------------------------

const requests = [];
const answers = new Map();
const answerFor = (index) => {
  if (!answers.has(index)) {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    answers.set(index, { promise, resolve });
  }
  return answers.get(index);
};
const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const stream = (chunks) => chunks.map(frame).join("") + "data: [DONE]\n\n";
const tools = (...calls) => [
  { type: "start" },
  { type: "start-step" },
  ...calls.map(([toolCallId, toolName, input]) => ({ type: "tool-input-available", toolCallId, toolName, input })),
  { type: "finish-step" },
  { type: "finish" },
];
const words = (text) => [
  { type: "start" },
  { type: "start-step" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" },
  { type: "finish-step" },
  { type: "finish" },
];
const read = (id, input) => tools([id, "read_page", input]);

async function request(index) {
  for (let waited = 0; requests.length <= index; waited += 20) {
    if (waited > 15_000) throw new Error(`request ${index} never arrived`);
    await sleep(20);
  }
  return requests[index];
}
const answer = (index, chunks) => answerFor(index).resolve(chunks);

function outputOf(body, toolCallId) {
  for (const message of body.messages) {
    for (const part of message.parts ?? []) {
      if (part.toolCallId === toolCallId) return part.state === "output-error" ? `ERROR ${part.errorText}` : part.output;
    }
  }
  return undefined;
}

const CAP = 24_000;
/** The page's own notes are ~620 characters each; one board read whole is ~20K. */
const BOARD = 18_000;
const whole = (output, name) => output.includes(`<nt-rect id="${name}149"`);
const stub = (output, id) => new RegExp(`<nt-diagram id="${id}" at="${id}" holds="150 shapes"`).test(output);
const ids = (output) => [...output.matchAll(/<p id="(n\d+)"/g)].map((m) => m[1]);

let browser;
try {
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console error: ${message.text()}`);
  });
  await page.addInitScript(() => {
    window.WebSocket = class extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      send() {
        throw new Error("Fixture socket must never send");
      }
      close() {
        this.readyState = 3;
      }
    };
  });
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
    failures.push(`request left the fixture: ${url}`);
    return route.abort();
  });
  await page.route(`${origin}/api/chat`, async (route) => {
    const index = requests.push(JSON.parse(route.request().postData() ?? "{}")) - 1;
    const chunks = await answerFor(index).promise;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" },
      body: stream(chunks),
    });
  });

  await page.goto(origin, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("#state")?.textContent === "idle");
  await page.evaluate(() => globalThis.readPageHarness.seed());
  await page.waitForFunction(() => globalThis.readPageHarness.blocks().length >= 125);
  const seeded = await page.evaluate(() => globalThis.readPageHarness.blocks());
  check("the page holds the notes, both boards and the album", ["d1", "a1", "d9"].map((id) => seeded.find((b) => b.id === id)?.type), ["canvas", "album", "canvas"]);

  const idle = () => page.waitForFunction(() => document.querySelector("#state")?.textContent === "idle");
  const ask = async (text) => {
    await page.click(".nt-composer-input");
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".nt-composer-input").value === "");
  };
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
  let next = 0;

  // ---------------------------------------------------------------------------
  console.log("\nThe whole page, unexpanded, for scale");
  await ask("What is on this page?");
  await request(next);
  answer(next++, read("call_plain", {}));
  let body = await request(next);
  const plain = String(outputOf(body, "call_plain"));
  console.log(`       plain read: ${plain.length} chars`);
  check("an unexpanded read is capped", plain.length < CAP + 1_000, true);
  check("and shows the top board as a stub", stub(plain, "d1"), true);
  answer(next++, words("Field notes, a board and an album."));
  await idle();

  // ---------------------------------------------------------------------------
  console.log("\nExpanding the top board uncaps the board, not the page");
  await ask("Match the style of the top board");
  await request(next);
  answer(next++, read("call_top", { expand: ["d1"] }));
  body = await request(next);
  const top = String(outputOf(body, "call_top"));
  console.log(`       expanded read: ${top.length} chars`);
  check("the top board reads whole", whole(top, "Top"), true);
  check("the read is the capped read plus the board, not the page", top.length < CAP + BOARD + 4_000, true);
  check("the lower board, past the cut, is not in it", top.includes('id="d9"'), false);
  check("it stops where the plain read stops", ids(top).at(-1), ids(plain).at(-1));
  check("and says where to read on", /Read on with after: "n\d+"/.test(top), true);
  await shot("1-top-board-expanded");
  answer(next++, words("Matched."));
  await idle();

  // ---------------------------------------------------------------------------
  console.log("\nExpanding the album appends its index and leaves the cap alone");
  await ask("What is in the album?");
  await request(next);
  answer(next++, read("call_album", { expand: ["a1"] }));
  body = await request(next);
  const album = String(outputOf(body, "call_album"));
  console.log(`       album read: ${album.length} chars`);
  check("the index is appended", album.includes("<!-- album a1: empty -->"), true);
  check("and the page read is the plain one", album.startsWith(plain), true);
  answer(next++, words("The album is empty."));
  await idle();

  // ---------------------------------------------------------------------------
  console.log("\nExpanding the lower board, past the cut, points the model at it");
  await ask("Add a box to the lower board");
  await request(next);
  answer(next++, read("call_lower", { expand: ["d9"] }));
  body = await request(next);
  const lower = String(outputOf(body, "call_lower"));
  const hint = /d9 is not in this part of the page, so it was not expanded\. Read it with after: "(n\d+)" and expand: \["d9"\]/.exec(lower);
  check("the read says the board is further down, and how to read it", hint?.[1], "n90");
  check("and is still capped", lower.length < CAP + 1_000, true);
  answer(next++, read("call_lower_there", { expand: ["d9"], after: hint?.[1] ?? "n90" }));
  body = await request(next);
  const there = String(outputOf(body, "call_lower_there"));
  console.log(`       read from n90: ${there.length} chars`);
  check("reading from there, the lower board reads whole", whole(there, "Lower"), true);
  check("with no pointer left", there.includes("not in this part of the page"), false);
  check("and the rest of the page, capped", there.length < CAP + BOARD + 4_000, true);
  await shot("2-lower-board-found");
  answer(next++, words("Found it."));
  await idle();
} catch (error) {
  failures.push(`harness: ${error.stack ?? error}`);
} finally {
  await browser?.close();
  server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} failure(s):\n${failures.map((f) => `- ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("\nall checks passed");
