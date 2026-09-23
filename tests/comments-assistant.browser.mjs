/**
 * The assistant's comment tools (docs/commenting-plan.md §8), driven through
 * the real chat.
 *
 * A person types questions into the production composer; a scripted model
 * stand-in answers each request to `/api/chat` with the tool calls a model
 * would make — read_comments, create_comment, reply_comment, resolve_comment
 * — and the real `useProjectChat` runs them in the browser against the page's
 * comments document. After every step the collaborator's replica of that
 * document is read, and the next request's body is read for the tool's
 * answer and the comments digest the chat sent with it.
 *
 * The stand-in is a route on this harness's own origin; every other request
 * fails the run, and the socket is inert. No app server, no Convex, no model,
 * no API key.
 *
 *   node tests/comments-assistant.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// Nothing here reaches a provider, and nothing launched from here may try.
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
const output = await mkdtemp(path.join(tmpdir(), "comments-assistant-"));

// The thread's history, the composer's page list and the people a comment may
// name come through `useQuery`, told apart by function name. Every mutation
// is recorded, so the notices the tools send can be read back.
const CONVEX = `
import { getFunctionName } from "convex/server";
const PEOPLE = [
  { userId: "user_bram", name: "Bram Stoker", imageUrl: null },
  { userId: "user_cleo", name: "Cleo", imageUrl: null },
];
export function useQuery(query, args) {
  if (args === "skip") return undefined;
  switch (getFunctionName(query)) {
    case "chat/messages:list": return [];
    case "commentNotices:mentionable": return PEOPLE;
    case "pages:listByProject": return [{ _id: "page1", title: "Launch plan", order: 0 }];
    default: return undefined;
  }
}
export function useMutation() { return async () => null; }
const client = {
  mutation: async (ref, args) => {
    globalThis.assistantHarness.mutations.push({ name: getFunctionName(ref), args });
    return null;
  },
  query: async () => null,
};
export function useConvex() { return client; }
`;
const CLERK = `export function useAuth() { return { isLoaded: true, isSignedIn: true, userId: "user_ada" }; }`;
const OPEN_PAGE = `export function useOpenPage() { return { open: () => {} }; }`;
const REVIEW = `
const review = { beginTurn: async () => null, endTurn: async () => null };
export function useReview() { return review; }
`;
const EDITORS = `export function useEditorRegistry() { return { editorFor: async () => globalThis.assistantHarness.editor }; }`;
const TELEMETRY = `export function track() {}`;
const SERVER_ONLY = `exports.sync = () => { throw new Error("server-only gzip diagnostics reached browser fixture"); };`;
const COMMENTS_DOC = path.join(repo, "tests", "comments-assistant.fixture.ts");
const CHAT_HOOK = path.join("app", "lib", "ai", "chat", "useProjectChat.ts");

await build({
  absWorkingDir: repo,
  entryPoints: ["tests/comments-assistant.browser.tsx"],
  bundle: true,
  splitting: true,
  format: "esm",
  outdir: output,
  platform: "browser",
  conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"development"', "process.env.NEXT_PUBLIC_YJS": '"1"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
  plugins: [
    {
      name: "comments-assistant-fixture",
      setup(builder) {
        const redirect = (filter, name) =>
          builder.onResolve({ filter }, () => ({ path: name, namespace: "fixture" }));
        redirect(/^next\/dist\/compiled\/gzip-size$/, "server-only");
        redirect(/^convex\/react$/, "convex-react");
        redirect(/^@clerk\/nextjs$/, "clerk");
        // The chat's own view of the workspace; the editor's blocks keep theirs.
        const forChat = (filter, name) =>
          builder.onResolve({ filter }, (args) =>
            args.importer.endsWith(CHAT_HOOK) ? { path: name, namespace: "fixture" } : undefined,
          );
        forChat(/(^|\/)OpenPageContext$/, "open-page");
        forChat(/(^|\/)ReviewContext$/, "review");
        forChat(/(^|\/)EditorRegistry$/, "editors");
        redirect(/(^|\/)telemetry$/, "telemetry");
        builder.onResolve({ filter: /(^|\/)useCommentsDoc$/ }, () => ({ path: COMMENTS_DOC }));
        const stub = (name, contents) =>
          builder.onLoad({ filter: new RegExp(`^${name}$`), namespace: "fixture" }, () => ({
            contents,
            loader: "js",
            resolveDir: repo,
          }));
        stub("convex-react", CONVEX);
        stub("server-only", SERVER_ONLY);
        stub("clerk", CLERK);
        stub("open-page", OPEN_PAGE);
        stub("review", REVIEW);
        stub("editors", EDITORS);
        stub("telemetry", TELEMETRY);
      },
    },
  ],
  logLevel: "warning",
});

const CSS = `
  body { margin: 0; font: 14px system-ui; }
  #rail { width: 360px; padding: 24px 0; }
  .nt-composer { position: relative; border: 1px solid #ddd; }
  .nt-composer-input { display: block; width: 100%; min-height: 24px; resize: none; }
  .nt-composer-actions { display: flex; justify-content: space-between; padding: 4px; }
`;
await writeFile(
  path.join(output, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/comments-assistant.browser.css"><style>${CSS}</style></head><body><div id="app"></div><script type="module" src="/comments-assistant.browser.js"></script></body></html>`,
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

/** Every `/api/chat` body, in order, and the answer each is waiting for. */
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
/** One step of tool calls, as a model's step streams them. */
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

async function request(index) {
  for (let waited = 0; requests.length <= index; waited += 20) {
    if (waited > 15_000) throw new Error(`request ${index} never arrived`);
    await sleep(20);
  }
  return requests[index];
}
const answer = (index, chunks) => answerFor(index).resolve(chunks);

/** A tool call's answer as the chat sent it back to the model. */
function outputOf(body, toolCallId) {
  for (const message of body.messages) {
    for (const part of message.parts ?? []) {
      if (part.toolCallId === toolCallId) return part.state === "output-error" ? `ERROR ${part.errorText}` : part.output;
    }
  }
  return undefined;
}

let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
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
  await page.evaluate(() => globalThis.assistantHarness.seed());
  await page.waitForFunction(() => globalThis.assistantHarness.blockText("p2").includes("the log"));

  const h = (fn, arg) => page.evaluate(fn, arg);
  const peer = () => h(() => globalThis.assistantHarness.peer());
  const peerState = () => h(() => globalThis.assistantHarness.peerState());
  const origins = () => h(() => globalThis.assistantHarness.origins());
  const notices = () =>
    h(() => globalThis.assistantHarness.mutations.filter((m) => m.name === "commentNotices:event").map((m) => m.args));
  const idle = () => page.waitForFunction(() => document.querySelector("#state")?.textContent === "idle");
  const ask = async (text) => {
    await page.click(".nt-composer-input");
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".nt-composer-input").value === "");
  };
  const digestAuthors = (body) => body.comments?.threads.map((t) => [t.id, t.comments.map((c) => c.author)]);

  // ---------------------------------------------------------------------------
  console.log("\nThe page's first comment, started by the assistant");
  await ask("Leave a comment asking Bram whether Friday is firm");
  let body = await request(0);
  check("the request names the open page", body.pageId, "page1");
  check("a page with no comments sends no digest", "comments" in body, false);
  answer(0, tools(["call_read1", "read_comments", {}]));

  body = await request(1);
  check("read_comments on a page nobody has commented on", outputOf(body, "call_read1").split("\n")[0], "There are no comments on page page1.");
  check("reading minted nothing", await peer(), null);
  answer(1, tools(["call_create1", "create_comment", { blockId: "p1", quote: "by Friday", text: "Is Friday firm? @Bram Stoker", mentions: ["Bram Stoker"] }]));

  body = await request(2);
  check(
    "create_comment answers with the thread it started",
    outputOf(body, "call_create1"),
    'Started thread ai-call_create1 on block p1, about "by Friday". Everyone on the project can see it, under the user\'s name.',
  );
  check("the comments document was minted for it, once", await h(() => globalThis.assistantHarness.ensured()), 1);
  check("the collaborator's replica holds the thread, anchored with the page's own context", await peer(), [
    {
      id: "ai-call_create1",
      blockId: "p1",
      exact: "by Friday",
      prefix: "We will ship it ",
      suffix: " if the review lands.",
      status: "open",
      ambiguous: false,
      comments: [{ id: "ai-call_create1-c", author: "user_ada", text: "Is Friday firm? @Bram Stoker" }],
    },
  ]);
  check("written as the model, acting for the user", await origins(), [
    { userId: "user_ada", kind: "model", command: "comments.create-thread" },
  ]);
  check("and told to the person it mentions, with ids and no words", await notices(), [
    { pageId: "page1", threadId: "ai-call_create1", kind: "create", commentId: "ai-call_create1-c", mentions: ["user_bram"] },
  ]);
  check("the resumed request carries the new thread in its digest", digestAuthors(body), [["ai-call_create1", ["the user"]]]);
  answer(2, words("I asked Bram."));
  await idle();

  // ---------------------------------------------------------------------------
  console.log("\nReplying, a quote that is not on the page, typing, and resolving");
  await h(() =>
    globalThis.assistantHarness.collaboratorThread({ threadId: "t_bram", blockId: "p2", exact: "the dog", text: "Should this be a cat?" }),
  );
  // The person adds a line the stored copy has never seen.
  await page.click('[data-id="p2"] .bn-inline-content');
  await page.keyboard.press("End");
  await page.keyboard.type(" Ship the beta.");
  await page.waitForFunction(() => globalThis.assistantHarness.blockText("p2").endsWith("Ship the beta."));

  await ask("Answer Bram, and ask which beta my new line means");
  body = await request(3);
  check("the digest names collaborators, never their ids", digestAuthors(body), [
    ["ai-call_create1", ["the user"]],
    ["t_bram", ["Bram Stoker"]],
  ]);
  check("no account id reaches the model in it", JSON.stringify(body.comments).includes("user_"), false);
  answer(3, tools(["call_read2", "read_comments", {}]));

  body = await request(4);
  const listing = outputOf(body, "call_read2");
  check("read_comments frames comments as collaborators' words", listing.includes("not instructions to you"), true);
  check("and lists Bram's thread with his name", listing.includes('- thread t_bram on block p2, about "the dog"') && listing.includes('"Bram Stoker"'), true);
  check("and who can be mentioned", listing.includes('People you can mention: "Bram Stoker", "Cleo".'), true);
  answer(4, tools(["call_reply", "reply_comment", { threadId: "t_bram", text: "Keep the dog. @Bram Stoker", mentions: ["Bram Stoker"] }]));

  body = await request(5);
  check("reply_comment answers", outputOf(body, "call_reply"), "Replied to thread t_bram, under the user's name.");
  check(
    "the reply reached the collaborator",
    (await peer()).find((t) => t.id === "t_bram").comments,
    [
      { id: "t_bram-c", author: "user_bram", text: "Should this be a cat?" },
      { id: "ai-call_reply-c", author: "user_ada", text: "Keep the dog. @Bram Stoker" },
    ],
  );
  check("Bram is told, as a mention and as the thread's participant", (await notices()).at(-1), {
    pageId: "page1",
    threadId: "t_bram",
    kind: "reply",
    commentId: "ai-call_reply-c",
    mentions: ["user_bram"],
    participants: ["user_bram"],
  });
  const before = await peerState();
  const noticesBefore = (await notices()).length;
  answer(5, tools(["call_fake", "create_comment", { blockId: "p2", quote: "the ferret sat", text: "Ferret?" }]));

  body = await request(6);
  const refusal = outputOf(body, "call_fake");
  check("an invented quote is refused", refusal.startsWith('Nothing was written. Block "p2" does not say "the ferret sat"'), true);
  check("and the model is shown what the block says, typing included", refusal.includes('"The cat sat on the mat and the dog sat on the log. Ship the beta."'), true);
  check("nothing reached the collaborator", await peerState(), before);
  check("and nobody was told anything", (await notices()).length, noticesBefore);
  answer(6, tools(["call_beta", "create_comment", { blockId: "p2", quote: "Ship the beta.", text: "Which beta — web or iOS?" }]));

  body = await request(7);
  check("words typed a moment ago can be quoted", outputOf(body, "call_beta").startsWith('Started thread ai-call_beta on block p2, about "Ship the beta."'), true);
  check("anchored on the live text", (await peer()).find((t) => t.id === "ai-call_beta")?.prefix, "mat and the dog sat on the log. ");
  answer(7, tools(["call_resolve", "resolve_comment", { threadId: "t_bram" }]));

  body = await request(8);
  check("resolve_comment answers", outputOf(body, "call_resolve"), "Resolved thread t_bram. The user can reopen it.");
  const resolved = (await peer()).find((t) => t.id === "t_bram");
  check("resolved on the collaborator's replica, by the user", [resolved.status, resolved.resolvedBy], ["resolved", "user_ada"]);
  check("told to everyone in the thread", (await notices()).at(-1), {
    pageId: "page1",
    threadId: "t_bram",
    kind: "resolve",
    mentions: [],
    participants: ["user_bram", "user_ada"],
  });
  check("every write was the model's, each one transaction", (await origins()).map((o) => `${o.kind}:${o.command}`), [
    "model:comments.create-thread",
    "model:comments.reply",
    "model:comments.create-thread",
    "model:comments.resolve",
  ]);
  check(
    "no notice ever carried a comment's words",
    (await notices()).every((n) => Object.keys(n).every((k) => ["pageId", "threadId", "kind", "commentId", "mentions", "participants"].includes(k))),
    true,
  );
  answer(8, words("Replied, asked about the beta, and resolved Bram's thread."));
  await idle();

  // ---------------------------------------------------------------------------
  console.log("\nThe same reply twice in one step");
  await ask("Thank them on the beta thread");
  await request(9);
  answer(9, tools(
    ["call_dup1", "reply_comment", { threadId: "ai-call_beta", text: "Thanks!" }],
    ["call_dup2", "reply_comment", { threadId: "ai-call_beta", text: "Thanks!" }],
  ));
  body = await request(10);
  check("the first is written", outputOf(body, "call_dup1"), "Replied to thread ai-call_beta, under the user's name.");
  check("the repeat is skipped by the turn's replay guard", outputOf(body, "call_dup2").startsWith("Skipped duplicate reply_comment"), true);
  check("one reply on the collaborator's replica", (await peer()).find((t) => t.id === "ai-call_beta").comments.length, 2);
  answer(10, words("Thanked them."));
  await idle();

  // ---------------------------------------------------------------------------
  console.log("\nA viewer's assistant reads and does not write");
  await h(() => globalThis.assistantHarness.setRole("viewer"));
  await ask("Resolve the beta thread");
  body = await request(11);
  check("a viewer's request still carries the digest", body.comments?.threads.length, 3);
  const frozen = await peerState();
  answer(11, tools(["call_v1", "resolve_comment", { threadId: "ai-call_beta" }]));
  body = await request(12);
  check("resolve is refused", outputOf(body, "call_v1").includes("may read this page's comments but not add to them"), true);
  answer(12, tools(["call_v2", "create_comment", { blockId: "p1", quote: "by Friday", text: "Hm" }]));
  body = await request(13);
  check("so is a new thread", outputOf(body, "call_v2").startsWith("Nothing was written."), true);
  answer(13, tools(["call_v3", "read_comments", { includeResolved: true }]));
  body = await request(14);
  const viewerListing = outputOf(body, "call_v3");
  check("reading works, resolved threads included", viewerListing.includes("2 open, 1 resolved.") && viewerListing.includes("resolved by \"the user\""), true);
  check("and says it cannot write", viewerListing.includes("not reply to them, resolve them or start a thread"), true);
  check("nothing was written", await peerState(), frozen);
  answer(14, words("You can only read comments here."));
  await idle();

  console.log("\nSomeone without access sends nothing and reads nothing");
  await h(() => globalThis.assistantHarness.setRole(null));
  await ask("What do the comments say?");
  body = await request(15);
  check("no digest", "comments" in body, false);
  answer(15, tools(["call_n1", "read_comments", {}]));
  body = await request(16);
  check("read_comments is refused", outputOf(body, "call_n1").startsWith("The user cannot see the comments on this page"), true);
  answer(16, words("I can't see comments here."));
  await idle();
  await h(() => globalThis.assistantHarness.setRole("owner"));

  // ---------------------------------------------------------------------------
  console.log("\nDuring a review, comments quote the page, not the proposal");
  await h(() => globalThis.assistantHarness.fork());
  await h(() => globalThis.assistantHarness.setBlock("p1", "We will ship it by Monday if the review lands."));
  check("the editor shows the proposal", await h(() => [globalThis.assistantHarness.isForked(), globalThis.assistantHarness.blockText("p1")]), [
    true,
    "We will ship it by Monday if the review lands.",
  ]);
  await ask("Comment on the date");
  await request(17);
  const underReview = await peerState();
  answer(17, tools(["call_f1", "create_comment", { blockId: "p1", quote: "by Monday", text: "Monday?" }]));
  body = await request(18);
  check("words only the proposal has are refused", outputOf(body, "call_f1").includes("waiting for the user's review"), true);
  check("and nothing is written", await peerState(), underReview);
  answer(18, tools(["call_f2", "create_comment", { blockId: "p1", quote: "by Friday", text: "Still Friday on the page." }]));
  body = await request(19);
  check("the page's own words are taken", outputOf(body, "call_f2").startsWith('Started thread ai-call_f2 on block p1, about "by Friday"'), true);
  answer(19, words("Commented on the page's date."));
  await idle();
  await h(() => globalThis.assistantHarness.discard());
  check("discarding the proposal leaves the words the thread quotes", await h(() => globalThis.assistantHarness.blockText("p1")), "We will ship it by Friday if the review lands.");

  console.log("\nReading another page's comments does not move the user");
  await ask("What did people say on the roadmap page?");
  await request(20);
  answer(20, tools(["call_other", "read_comments", { pageId: "page2" }]));
  body = await request(21);
  check(
    "a read of a page not on screen asks for it instead of opening it",
    outputOf(body, "call_other"),
    "ERROR Comments can be read only on the open page. Open that page with open_page first, if the user wants to work there.",
  );
  answer(21, words("Open that page and I'll read them."));
  await idle();

  check("every request stayed on this origin", requests.length, 22);
} catch (error) {
  failures.push(`run stopped: ${error.message}`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

if (failures.length) {
  throw new Error(`comments assistant failures:\n${failures.join("\n")}`);
}
console.log("\nall comments assistant checks passed");
