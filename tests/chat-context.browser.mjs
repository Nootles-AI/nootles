/**
 * NT-98: what a grown thread sends the model, driven through the real chat.
 *
 * One person, four questions, on a thirty-paragraph page. The real composer's
 * @ menu mentions the page; a scripted model stand-in answers each `/api/chat`
 * request with what a model does — a `read_context` of a big repo file, an
 * `edit_page`, an edit to the block that edit just made, a `find_places` and a
 * place card built from it — and each next request's body is read for what the
 * model would be sent:
 *
 *  - an earlier message's mention, cut to its head with a note to read again;
 *  - an earlier turn's `read_context`, folded to what it was;
 *  - `edit_page`'s answer, the blocks it touched and their neighbours, not the page;
 *  - `find_places`' photographs as short names that `edit_page` swaps for their
 *    addresses, so the card the person keeps holds the real pictures.
 *
 * The stand-in is a route on this harness's own origin; every other request
 * fails the run (the place card's map frame is answered blank), and the socket
 * is inert. No app server, no Convex, no model, no API key. Screenshots land in
 * tests/.artifacts/chat-context/.
 *
 *   node tests/chat-context.browser.mjs
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
const output = await mkdtemp(path.join(tmpdir(), "chat-context-"));
const shots = path.join(repo, "tests", ".artifacts", "chat-context");
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
export function useConvex() { return globalThis.contextHarness.convex; }
`;
const REVIEW = `
import { useMemo, useSyncExternalStore } from "react";
const current = () => globalThis.contextHarness.session;
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
const EDITORS = `export function useEditorRegistry() { return { editorFor: async () => globalThis.contextHarness.editor }; }`;
const TELEMETRY = `export function track() {}`;
const SERVER_ONLY = `exports.sync = () => { throw new Error("server-only gzip diagnostics reached browser fixture"); };`;
const CHAT_HOOK = path.join("app", "lib", "ai", "chat", "useProjectChat.ts");

await build({
  absWorkingDir: repo,
  entryPoints: ["tests/chat-context.browser.tsx"],
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
      name: "chat-context-fixture",
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
  `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/chat-context.browser.css"><style>${CSS}</style></head><body><div id="app"></div><script type="module" src="/chat-context.browser.js"></script></body></html>`,
);

const SWATCH = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    // The photo proxy: every Places picture is this one swatch.
    if (pathname === "/api/places/photo") {
      response.setHeader("Content-Type", "image/png");
      return void response.end(SWATCH);
    }
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
const text = (id, words) => [
  { type: "text-start", id },
  { type: "text-delta", id, delta: words },
  { type: "text-end", id },
];
const words = (said) => [{ type: "start" }, { type: "start-step" }, ...text("t", said), { type: "finish-step" }, { type: "finish" }];
/** A server tool the route ran inside the step, then the model's words after it. */
const served = (toolCallId, toolName, input, output, said) => [
  { type: "start" },
  { type: "start-step" },
  { type: "tool-input-available", toolCallId, toolName, input },
  { type: "tool-output-available", toolCallId, output },
  { type: "finish-step" },
  { type: "start-step" },
  ...text("t", said),
  { type: "finish-step" },
  { type: "finish" },
];
const edit = (id, html) => tools([id, "edit_page", { html }]);

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
const mentionsIn = (message) => message.parts.filter((part) => part.type === "data-mention").map((part) => part.data.content);
const ids = (html) => [...html.matchAll(/<(?:p|h\d|nt-location) id="([^"]+)"/g)].map((m) => m[1]);
const size = (body) => JSON.stringify(body).length;

/** A repo file big enough to matter: what `read_context` returned whole. */
const SCHEMA = {
  id: "n1",
  kind: "file",
  title: "convex/schema.ts",
  brief: "Every table and index.",
  content: `export default defineSchema({\n${"  table: defineTable({ ownerId: v.string() }).index(\"by_owner\", [\"ownerId\"]),\n".repeat(700)}});`,
};

/** A search's photographs, as the route wrote them to the pen: `p…` then their places. */
const PHOTO_REF = "p5e1f0c9a3b";
const photo = (n) => `/api/places/photo?ref=${encodeURIComponent(`places/ChIJ7cv00DwsDogRAMDACa2m4K8/photos/AUc7tXW${"xY3kQ9".repeat(40)}${n}`)}`;
const PHOTOS = [photo(0), photo(1), photo(2)];
const PLACES = [
  { place: "ChIJ7cv00DwsDogRAMDACa2m4K8", name: "Sightglass Coffee", address: "270 7th St, San Francisco, CA", rating: 4.6, votes: 2110, photos: [`${PHOTO_REF}.0`, `${PHOTO_REF}.1`, `${PHOTO_REF}.2`] },
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
    // The card's map is Google's embed, framed by name; answered blank here.
    if (url.startsWith("https://maps.google.com/maps?")) {
      return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>map</title>" });
    }
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
  await page.evaluate(() => globalThis.contextHarness.seed());
  await page.waitForFunction(() => globalThis.contextHarness.blocks().length === 31);

  const h = (fn, arg) => page.evaluate(fn, arg);
  const blocks = () => h(() => globalThis.contextHarness.blocks());
  const idle = () => page.waitForFunction(() => document.querySelector("#state")?.textContent === "idle");
  const type = async (words) => {
    await page.click(".nt-composer-input");
    await page.keyboard.type(words);
  };
  const send = async () => {
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".nt-composer-input").value === "");
  };
  const keepAll = async () => {
    await page.getByRole("button", { name: "Keep all" }).click();
    await page.waitForFunction(() => globalThis.contextHarness.pending() === 0);
  };
  const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true });
  let next = 0;

  // ---------------------------------------------------------------------------
  console.log("\nA question that mentions the page, answered from a repo file");
  await type("Summarise @Launch");
  await page.keyboard.press("Enter"); // picks "Current page" from the @ menu
  await type("against the schema");
  await send();
  let body = await request(next);
  const asked = mentionsIn(body.messages.at(-1));
  check("the mention goes whole with the question it came with", asked.length === 1 && asked[0].length > 15_000, true);
  check("and it is the page as it reads", asked[0].startsWith("<title>Launch plan</title>"), true);
  answer(next++, served("call_ctx", "read_context", { id: "n1" }, SCHEMA, "The plan covers every table."));
  await idle();
  const firstTurn = size(body);

  // ---------------------------------------------------------------------------
  console.log("\nThe next question carries none of that again");
  await type("Add a line after step 14 saying QA signs off");
  await send();
  body = await request(next);
  const earlier = mentionsIn(body.messages[0]);
  check("the earlier mention is its head and a note to read it again", [
    earlier[0].startsWith("<title>Launch plan</title>"),
    earlier[0].endsWith("read_page has it as it is now. -->"),
    earlier[0].length < 500,
  ], [true, true, true]);
  const read = outputOf(body, "call_ctx");
  check("the earlier repo read is folded to what it was", read, {
    id: "n1",
    kind: "file",
    title: "convex/schema.ts",
    brief: "Every table and index.",
    folded: "The text is not shown here any more. read_context has it again.",
  });
  check("the whole request is a few KB, where the first was tens", [size(body) < 5_000, firstTurn > 15_000], [true, true]);
  console.log(`    request 1: ${firstTurn} bytes; request 2: ${size(body)} bytes`);

  const p14 = (await blocks()).find((b) => b.id === "p14").text;
  answer(next++, edit("call_add", `<p id="p14">${p14}</p><p>QA signs off before launch.</p>`));
  body = await request(next);
  const added = String(outputOf(body, "call_add"));
  const [done, , ...echo] = added.split("\n");
  check("the edit says what it did", done, "Done: 1 block added. The user reviews this and may discard any of it.");
  const minted = (await blocks()).find((b) => b.text === "QA signs off before launch.")?.id;
  check("its answer is the touched block and its neighbours, by id", ids(echo.join("\n")), ["p14", minted, "p15"]);
  check("and counts the rest instead of repeating it", echo.filter((line) => line.startsWith("<!--")), [
    "<!-- 15 unchanged blocks before these -->",
    "<!-- 14 unchanged blocks after these -->",
  ]);
  check("a couple of KB, not the page", added.length < 3_000, true);
  console.log(`    edit_page answer: ${added.length} characters`);
  await shot("1-line-added");

  // The model works on the block it just made, by the id the echo gave it.
  answer(next++, edit("call_bold", `<p id="${minted}"><strong>QA signs off before launch.</strong></p>`));
  body = await request(next);
  const bolded = String(outputOf(body, "call_bold"));
  // Still "1 block added": the counts are the turn's review, where the block
  // this turn made is one new block however often it is rewritten.
  check("the minted id is one the page answers to", bolded.split("\n")[0], "Done: 1 block added. The user reviews this and may discard any of it.");
  check("and rewrites it rather than adding a copy", (await blocks()).length, 32);
  check("still only that block and its neighbours", ids(bolded), ["p14", minted, "p15"]);
  check("the person sees it bold", await h((id) => !!document.querySelector(`[data-id="${id}"] strong`), minted), true);
  check("and the page still reads in order", (await blocks()).map((b) => b.id).slice(14, 18), ["p13", "p14", minted, "p15"]);
  answer(next++, words("Added the QA line, in bold."));
  await idle();
  await keepAll();

  // ---------------------------------------------------------------------------
  console.log("\nA place card from find_places");
  await h(([ref, data]) => globalThis.contextHarness.pen(ref, data), [PHOTO_REF, JSON.stringify(PHOTOS)]);
  await type("Find a coffee place for the offsite and put it at the end");
  await send();
  body = await request(next);
  const p29 = (await blocks()).find((b) => b.id === "p29").text;
  const CARD = (src0, src1) =>
    `<p id="p29">${p29}</p>` +
    `<nt-location name="Sightglass Coffee" address="270 7th St, San Francisco, CA" place="ChIJ7cv00DwsDogRAMDACa2m4K8" rating="4.6" votes="2110">` +
    `<note>Big tables and good light.</note><img src="${src0}"><img src="${src1}" off></nt-location>`;
  answer(next++, [
    { type: "start" },
    { type: "start-step" },
    { type: "tool-input-available", toolCallId: "call_find", toolName: "find_places", input: { query: "coffee near SoMa, San Francisco" } },
    { type: "tool-output-available", toolCallId: "call_find", output: PLACES },
    { type: "finish-step" },
    { type: "start-step" },
    { type: "tool-input-available", toolCallId: "call_wrong", toolName: "edit_page", input: { html: CARD(`${PHOTO_REF}.0`, `${PHOTO_REF}.9`) } },
    { type: "finish-step" },
    { type: "finish" },
  ]);
  body = await request(next);
  const wrong = String(outputOf(body, "call_wrong"));
  check("a photo name the search never gave is refused by name", wrong.split("\n"), [
    `That edit was not applied, and nothing on the page changed. There is no photograph named "${PHOTO_REF}.9".`,
    "Use the photos find_places returned, exactly as they came back — or call find_places again.",
  ]);
  check("and nothing waits for review", await h(() => globalThis.contextHarness.pending()), 0);
  answer(next++, edit("call_card", CARD(`${PHOTO_REF}.0`, `${PHOTO_REF}.1`)));
  body = await request(next);
  const card = String(outputOf(body, "call_card"));
  check("the card is added", card.split("\n")[0], "Done: 1 block added. The user reviews this and may discard any of it.");
  const cardId = (await h(() => globalThis.contextHarness.editor.document.find((b) => b.type === "location")?.id));
  check("the page keeps the pictures' real addresses", await h((id) => {
    const data = String(globalThis.contextHarness.props(id)?.data ?? "");
    return [...data.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
  }, cardId), [PHOTOS[0], PHOTOS[1]]);
  check("the echo shows the card as the page holds it", card.includes(`<img src="${PHOTOS[0]}">`), true);
  await page.waitForFunction(() => [...document.querySelectorAll(".nt-loc-photo")].some((img) => img.complete && img.naturalWidth > 0));
  check("the person sees its photograph", await h(() => document.querySelectorAll(".nt-loc-photo").length), 1);
  answer(next++, words("Added Sightglass Coffee to the end."));
  await idle();
  await keepAll();
  await page.locator(".nt-loc-photo").first().scrollIntoViewIfNeeded();
  await shot("2-place-card");

  // ---------------------------------------------------------------------------
  console.log("\nA fourth question: the grown thread stays small");
  await type("Thanks, that is all");
  await send();
  body = await request(next);
  check("the first question's mention is still cut", mentionsIn(body.messages[0])[0].length < 500, true);
  check("the search result travels as names", JSON.stringify(outputOf(body, "call_find")).includes("/api/places/photo"), false);
  check("the whole thread is still a few KB", size(body) < 12_000, true);
  console.log(`    request ${next}: ${size(body)} bytes`);
  answer(next++, words("You're welcome."));
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
