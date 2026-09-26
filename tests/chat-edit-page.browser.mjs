/**
 * NT-95: `edit_page` and the HTML a page cannot hold, driven through the real
 * chat.
 *
 * A person types requests into the production composer; a scripted model
 * stand-in answers each `/api/chat` request with the `edit_page` call a model
 * makes when it writes loose words, a `<span>`, a `<figure>` or an id on the
 * wrong element. The real `useProjectChat` runs it against the page, staging
 * through the real review; the next request's body is read for what the tool
 * told the model, and the page for what the person was shown.
 *
 * Before the fix all of these were skipped without a word, and an edit made
 * wholly of them was answered "the page already reads that way" — so the model
 * told the person about a change that never happened.
 *
 * The stand-in is a route on this harness's own origin; every other request
 * fails the run, and the socket is inert. No app server, no Convex, no model,
 * no API key. Screenshots land in tests/.artifacts/chat-edit-page/.
 *
 *   node tests/chat-edit-page.browser.mjs
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
const output = await mkdtemp(path.join(tmpdir(), "chat-edit-page-"));
const shots = path.join(repo, "tests", ".artifacts", "chat-edit-page");
await mkdir(shots, { recursive: true });

const CONVEX = `
import { getFunctionName } from "convex/server";
export function useQuery(query, args) {
  if (args === "skip") return undefined;
  switch (getFunctionName(query)) {
    case "chat/messages:list": return [];
    case "commentNotices:mentionable": return [];
    case "pages:listByProject": return [{ _id: "page1", title: "Launch plan", order: 0 }];
    default: return undefined;
  }
}
export function useMutation() { return async () => null; }
export function useConvex() { return globalThis.editPageHarness.convex; }
`;
const REVIEW = `
import { useMemo, useSyncExternalStore } from "react";
const current = () => globalThis.editPageHarness.session;
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
const EDITORS = `export function useEditorRegistry() { return { editorFor: async () => globalThis.editPageHarness.editor }; }`;
const TELEMETRY = `export function track() {}`;
const SERVER_ONLY = `exports.sync = () => { throw new Error("server-only gzip diagnostics reached browser fixture"); };`;
const CHAT_HOOK = path.join("app", "lib", "ai", "chat", "useProjectChat.ts");

await build({
  absWorkingDir: repo,
  entryPoints: ["tests/chat-edit-page.browser.tsx"],
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
      name: "chat-edit-page-fixture",
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
  `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/chat-edit-page.browser.css"><style>${CSS}</style></head><body><div id="app"></div><script type="module" src="/chat-edit-page.browser.js"></script></body></html>`,
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
const edit = (id, html) => tools([id, "edit_page", { pageId: "page1", html }]);

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
/** A tool answer up to the page it echoes — the part that says what happened. */
const head = (output) => String(output).split("\n\n")[0];

const SEEDED = [
  { id: "h1", type: "heading", text: "Launch plan" },
  { id: "p1", type: "paragraph", text: "We will ship it by Friday." },
  { id: "p2", type: "paragraph", text: "Budget is tight." },
];

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
  await page.evaluate(() => globalThis.editPageHarness.seed());
  await page.waitForFunction(() => globalThis.editPageHarness.blocks().length === 3);

  const h = (fn, arg) => page.evaluate(fn, arg);
  const blocks = () => h(() => globalThis.editPageHarness.blocks());
  const pending = () => h(() => globalThis.editPageHarness.pending());
  const idle = () => page.waitForFunction(() => document.querySelector("#state")?.textContent === "idle");
  const ask = async (text) => {
    await page.click(".nt-composer-input");
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".nt-composer-input").value === "");
  };
  const keepAll = async () => {
    await page.getByRole("button", { name: "Keep all" }).click();
    await page.waitForFunction(() => globalThis.editPageHarness.pending() === 0);
  };
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
  let next = 0;

  // ---------------------------------------------------------------------------
  console.log("\nA line of loose words is written as a paragraph");
  await ask("Add a next-steps line");
  await request(next);
  answer(next++, edit("call_loose", "Next steps: ship <strong>Friday</strong>, then tell the team."));
  let body = await request(next);
  check("the tool says it added the block", head(outputOf(body, "call_loose")), "Done: 1 block added. The user reviews this and may discard any of it.");
  check("the person sees it on the page, waiting for review", await blocks(), [
    ...SEEDED,
    { id: (await blocks())[3]?.id, type: "paragraph", text: "Next steps: ship Friday, then tell the team." },
  ]);
  check("one change on the review bar", await pending(), 1);
  await page.waitForSelector(".nt-review-bar");
  check("the bar counts it", await page.textContent(".nt-review-bar .nt-review-count"), "1 change");
  await shot("1-loose-words-staged");
  answer(next++, words("Added the next-steps line."));
  await idle();
  await keepAll();

  // ---------------------------------------------------------------------------
  console.log("\nA paragraph wrapped in <span> is that paragraph");
  const before = await blocks();
  await ask("Add the owner");
  await request(next);
  answer(next++, edit("call_span", '<span>Owner: <a href="https://example.com/ana">Ana</a></span>'));
  body = await request(next);
  check("added, not skipped", head(outputOf(body, "call_span")), "Done: 1 block added. The user reviews this and may discard any of it.");
  check("its words are on the page", (await blocks()).slice(before.length).map((b) => b.text), ["Owner: Ana"]);
  answer(next++, words("Added the owner."));
  await idle();
  await keepAll();

  // ---------------------------------------------------------------------------
  console.log("\nAn edit made wholly of what the page cannot hold");
  const settled = await blocks();
  await ask("Add a team photo");
  await request(next);
  const FIGURE = '<figure><img alt="team"><figcaption>Team photo at the offsite</figcaption></figure>';
  answer(next++, edit("call_figure", FIGURE));
  body = await request(next);
  const refused = outputOf(body, "call_figure");
  check("is not answered as a match", refused.includes("already reads that way"), false);
  check("says nothing was written, with the marker a retry is admitted by", refused.split("\n")[0], "Nothing was written.");
  check("and names what it left out, with what would work", refused.split("\n").slice(1), [
    "Nothing on the page changed: the page cannot hold what this edit wrote.",
    '- a <figure> ("Team photo at the offsite"): not a block — write the picture as <img src="…" alt="caption"> on its own.',
    "Write those parts as blocks and call edit_page again.",
  ]);
  check("the page is untouched", await blocks(), settled);
  check("nothing waits for review", await pending(), 0);
  await shot("2-figure-refused");

  // The model, told the same thing, sends the same call again: the replay
  // guard admits it (a no-write result), and it is told the same thing again
  // rather than "not changed again".
  answer(next++, edit("call_figure_again", FIGURE));
  body = await request(next);
  check("an identical retry runs again and is told the same", outputOf(body, "call_figure_again"), refused);
  answer(next++, edit("call_figure_fixed", "<p>Team photo at the offsite goes here.</p>"));
  body = await request(next);
  check("the fixed edit lands", head(outputOf(body, "call_figure_fixed")), "Done: 1 block added. The user reviews this and may discard any of it.");
  answer(next++, words("I added a line for the photo."));
  await idle();
  await keepAll();

  // ---------------------------------------------------------------------------
  console.log("\nPart of an edit is left out");
  const partBefore = await blocks();
  await ask("Add a risks section");
  await request(next);
  answer(next++, edit("call_partial", "<h3>Risks</h3><aside>Vendor may slip a week</aside><p>Hiring is on track.</p>"));
  body = await request(next);
  const partial = head(outputOf(body, "call_partial")).split("\n");
  check("the rest is written and said so", partial[0], "Done: 2 blocks added. The user reviews this and may discard any of it.");
  check("and what was left out is named", partial.slice(1), [
    "Not everything was written — the page cannot hold these, so they were left out:",
    '- an <aside> ("Vendor may slip a week"): not something a page can hold — write it as <p>, a heading, a list or a table.',
    "The rest is on the page. Send only those parts again, written as blocks.",
  ]);
  check("the page holds exactly the rest", (await blocks()).slice(partBefore.length).map((b) => [b.type, b.text]), [
    ["heading", "Risks"],
    ["paragraph", "Hiring is on track."],
  ]);
  check("two changes to review", await pending(), 2);
  await shot("3-partial");
  answer(next++, words("Added risks; the vendor note needs another go."));
  await idle();
  await keepAll();

  // ---------------------------------------------------------------------------
  console.log("\nA block's id on an element that is not a block");
  const idBefore = await blocks();
  await ask("Change the ship date to Monday");
  await request(next);
  answer(next++, edit("call_span_id", '<span id="p1">We will ship it by Monday.</span>'));
  body = await request(next);
  const spanId = outputOf(body, "call_span_id").split("\n");
  check("nothing written, and the id's right home named", spanId, [
    "Nothing was written.",
    "Nothing on the page changed: the page cannot hold what this edit wrote.",
    '- a <span id="p1"> ("We will ship it by Monday."): an id belongs on the block itself — write it as <p id="p1">, <h2 id="p1">… whichever it is.',
    "Write those parts as blocks and call edit_page again.",
  ]);
  check("no copy of p1 was added beside it", await blocks(), idBefore);
  answer(next++, edit("call_p_id", '<p id="p1">We will ship it by Monday.</p>'));
  body = await request(next);
  check("written as the block, it rewrites p1", head(outputOf(body, "call_p_id")), "Done: 1 rewritten. The user reviews this and may discard any of it.");
  check("p1 reads Monday", (await blocks()).find((b) => b.id === "p1")?.text, "We will ship it by Monday.");
  answer(next++, words("Moved the date to Monday."));
  await idle();
  await keepAll();

  // ---------------------------------------------------------------------------
  console.log("\nAn echo of what the page already says is still a match");
  const echoBefore = await blocks();
  await ask("Make sure the title is right");
  await request(next);
  answer(next++, edit("call_echo", '<title>Launch plan</title>\n<h2 id="h1">Launch plan</h2>'));
  body = await request(next);
  check("the page's own title line is not reported", outputOf(body, "call_echo"), "Nothing to do — the page already reads that way.");
  answer(next++, edit("call_rename", '<title>Launch plan v2</title>'));
  body = await request(next);
  check("a different title is pointed at rename_page", outputOf(body, "call_rename").split("\n")[2], '- a <title> ("Launch plan v2"): edit_page does not rename the page — call rename_page for that.');
  check("and the page is as it was", await blocks(), echoBefore);
  answer(next++, words("The title already reads that way."));
  await idle();
  await shot("4-final");
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
