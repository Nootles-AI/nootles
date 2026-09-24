/**
 * Commenting, end to end, the way the people on a project would use it
 * (docs/commenting-plan.md §12): a REAL Convex backend (a throwaway
 * convex-local-backend, tests/fullstack-backend.mjs), the REAL app — the
 * projects screen, workspace, share route, share popover, margin cards, panel,
 * inbox and chat, bundled from app/ (tests/comments-e2e.fullstack.tsx) — and
 * one Playwright browser context per person, each signed in with its own token
 * from the fake issuer the backend trusts, all open at once.
 *
 * Olive owns the project; Eddie, Cora and Vic come in through the editor,
 * commenter and viewer links she makes; Sam is a stranger; Gus is signed out
 * with the comment link; Oscar is an operator standing in for Cora, with a
 * token the deployment itself minted (`impersonationMint.start`).
 *
 * Everything a person does is a real click, drag or keystroke. What the suite
 * asserts it reads back from the server over HTTP (decoded in Node by
 * tests/comments-e2e.reader.ts), or from another person's screen. The one
 * thing that stands in for a person is the model: `/api/chat` is answered
 * inside Olive's tab by a scripted stream of tool calls, and never leaves it.
 *
 * Nothing reaches a cloud deployment or a paid API: `CONVEX_DEPLOYMENT` is
 * masked, the backend's outbound fetches are refused (and fail the run), the
 * AI keys are unset, every browser request outside the bundle and the backend
 * fails the run, and the ambient AI lanes typing wakes (`/api/complete`,
 * `/api/reformat`) are aborted in the tab and asserted never to leave it.
 * Screenshots land in tests/.artifacts/comments-e2e/.
 *
 *   npm run test:comments:e2e
 *
 * Needs a convex-local-backend binary (see tests/fullstack-backend.mjs) and
 * system Chrome (`COMMENTS_BROWSER_CHANNEL=chromium` for Playwright's own).
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { build } from "esbuild";
import { anyApi } from "convex/server";
import {
  bundleSurfaces, serveBundle, guardedTab, wait, wordBox, dragSelect, doubleClickWord, clickEndOf, AI_LANE, UNDO,
} from "./comments-surfaces.shared.mjs";
import { launchBrowser } from "./comments-launch.mjs";
import { startBackend, signingPair } from "./fullstack-backend.mjs";

/**
 * Next's App Router, reduced to what the app asks of it: the address is the
 * state, and every history write — the router's, or the app's own
 * `replaceState` — tells each reader, as Next's history integration does.
 */
const NAVIGATION = `
  import { useMemo, useSyncExternalStore } from "react";
  const listeners = new Set();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method].bind(history);
    history[method] = (...args) => { original(...args); queueMicrotask(notify); };
  }
  window.addEventListener("popstate", notify);
  const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  const go = (href, replace) => {
    (window.__navigations ??= []).push({ href, replace });
    history[replace ? "replaceState" : "pushState"](null, "", href);
  };
  const router = { push: (href) => go(href, false), replace: (href) => go(href, true), prefetch() {}, back: () => history.back(), forward: () => history.forward(), refresh() {} };
  export function useRouter() { return router; }
  export function usePathname() { return useSyncExternalStore(subscribe, () => location.pathname); }
  export function useSearchParams() {
    const search = useSyncExternalStore(subscribe, () => location.search);
    return useMemo(() => new URLSearchParams(search), [search]);
  }
  export function useParams() { return {}; }
  export function redirect(href) { go(href, true); }
  export function notFound() { throw new Error("notFound"); }
`;

const frame = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
/** An AI SDK UI message stream, as `/api/chat` answers. */
const stream = (chunks) => chunks.map(frame).join("") + "data: [DONE]\n\n";
/** One model step of tool calls. */
const toolStep = (...calls) => [
  { type: "start" }, { type: "start-step" },
  ...calls.map(([toolCallId, toolName, input]) => ({ type: "tool-input-available", toolCallId, toolName, input })),
  { type: "finish-step" }, { type: "finish" },
];
/** One model step of words. */
const says = (text) => [
  { type: "start" }, { type: "start-step" }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: text },
  { type: "text-end", id: "t" }, { type: "finish-step" }, { type: "finish" },
];

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = path.join(repo, "tests", ".artifacts", "comments-e2e");
await rm(shots, { recursive: true, force: true });
await mkdir(shots, { recursive: true });
const work = await mkdtemp(path.join(tmpdir(), "comments-e2e-"));

// ── The ledger: every check printed, the first failure ends the run ─────────
const failures = [];
let checks = 0;
class Stop extends Error {}
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return void console.log(`  ok   ${name}`);
  failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
  console.log(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`);
  throw new Stop();
}
const section = (title) => console.log(`\n${title}`);

/** Poll `read` until `accept` holds or `timeout` passes; the last value either way. */
async function until(read, accept, timeout = 15000) {
  const end = Date.now() + timeout;
  let value = await read();
  while (!accept(value) && Date.now() < end) {
    await wait(100);
    value = await read();
  }
  return value;
}
const waitFor = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout, polling: 50 }).then(() => true, () => false);

// ── The page everyone reads ──────────────────────────────────────────────────
const PARAGRAPHS = [
  ["p_intro", "Launch plan for the autumn release, written for the whole team."],
  ["p_ship", "Ship it by Friday if the tests pass and the design review signs off."],
  ["p_risk", "The main risk is the migration, which touches every stored document."],
  ["p_budget", "Budget stays flat; the extra hosting cost is covered by the old plan."],
  ["p_owner", "Eddie owns the rollout and Cora owns the written announcement."],
  ["p_after", "After launch we review what the comments taught us."],
];

const PEOPLE = {
  olive: { userId: "user_e2e_olive", name: "Olive Owner" },
  eddie: { userId: "user_e2e_eddie", name: "Eddie Editor" },
  cora: { userId: "user_e2e_cora", name: "Cora Commenter" },
  vic: { userId: "user_e2e_vic", name: "Vic Viewer" },
  sam: { userId: "user_e2e_sam", name: "Sam Stranger" },
};

// Every comment body typed in this run: none may reach the audit export.
const BODIES = [];
const body = (text) => (BODIES.push(text), text);

let browser;
let bundleServer;
let deployment;
const tabs = {};
let threw = null;

// A hung browser or backend must not hold the run (or CI) open: past this, tear
// down (itself bounded) and fail. A whole run takes about 70 s.
const watchdog = setTimeout(async () => {
  console.error("\nwatchdog: the run took longer than 10 minutes; tearing down");
  const teardown = Promise.all([browser?.close().catch(() => {}), deployment?.close().catch(() => {})]);
  await Promise.race([teardown, wait(15_000)]);
  process.exit(2);
}, 10 * 60_000);
watchdog.unref();

try {
  // ── The deployment, with the stand-in issuer configured ────────────────────
  const standInKey = signingPair();
  const operator = { user: "ops-e2e", password: randomBytes(12).toString("hex") };
  deployment = await startBackend({
    name: "comments-e2e",
    env: {
      IMPERSONATION_PRIVATE_KEY: standInKey.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      IMPERSONATION_JWKS: JSON.stringify(standInKey.jwks),
      ADMIN_USER: operator.user,
      ADMIN_PASSWORD: operator.password,
    },
  });
  const CONVEX_URL = deployment.url;
  const jwt = Object.fromEntries(Object.entries(PEOPLE).map(([key, who]) => [key, deployment.mint(who.userId, who.name)]));
  const as = (who) => deployment.client(who === "guest" ? null : jwt[who]);

  // The server-side reader, bundled for Node from the app's own decoders.
  const readerFile = path.join(work, "reader.mjs");
  await build({
    absWorkingDir: repo, entryPoints: ["tests/comments-e2e.reader.ts"], bundle: true, format: "esm", platform: "node",
    outfile: readerFile, tsconfig: "tsconfig.json", logLevel: "warning",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  const reader = await import(pathToFileURL(readerFile).href);

  // ── Accounts and the project, as first run and the owner's editor leave them ─
  for (const who of Object.keys(PEOPLE)) {
    await as(who).mutation(anyApi.profiles.skip, {});
    // Who they are, confirmed as the app confirms it on sign-in: from the
    // token's own email claim, so no Clerk call is made.
    await as(who).action(anyApi.identity.sync, {});
    // Past the first-touch hints, as anyone who has used the app before is.
    for (const id of ["chat", "slash", "write"]) await as(who).mutation(anyApi.profiles.seen, { id });
  }
  const olive = as("olive");
  const projectId = await olive.mutation(anyApi.projects.create, { title: "Autumn launch" });
  const [page] = await olive.query(anyApi.pages.listByProject, { projectId });
  await olive.mutation(anyApi.pages.rename, { pageId: page._id, title: "Launch plan" });
  const notesId = await olive.mutation(anyApi.pages.create, { projectId, title: "Notes" });
  const notes = (await olive.query(anyApi.pages.listByProject, { projectId })).find((p) => p._id === notesId);

  // ── The browser ─────────────────────────────────────────────────────────────
  const output = path.join(work, "bundle");
  await bundleSurfaces("tests/comments-e2e.fullstack.tsx", output, { probe: false, fixtures: { navigation: NAVIGATION } });
  const served = await serveBundle(output);
  bundleServer = served.server;
  const origin = served.origin;
  browser = await launchBrowser();

  /**
   * One person's browser: its own context, its own token, guarded — any
   * console error or uncaught exception fails the run. `chat` answers
   * `/api/chat` in the tab from the script (Olive's only).
   */
  async function open(key, { path: first, identity, token, viewport = { width: 1600, height: 960 }, chat } = {}) {
    const tab = await guardedTab(browser, {
      origin, allow: [CONVEX_URL], label: key, failures, viewport, path: first, inert: false,
      setup: async (context, page) => {
        // No action or wait may hang the run: Playwright's own default is to wait forever.
        context.setDefaultTimeout(20_000);
        context.setDefaultNavigationTimeout(30_000);
        await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
        await page.addInitScript((cfg) => { window.__e2e = cfg; }, { url: CONVEX_URL, jwt: token ?? null, identity: identity ?? null });
        // Every socket frame held this long each way, in order — the latency a
        // runner's loaded loopback adds, which reorders one client's writes
        // against another's the way a quick local run never does.
        const latency = Number(process.env.E2E_LATENCY_MS ?? 0);
        if (latency > 0) {
          await page.addInitScript((ms) => {
            const Native = window.WebSocket;
            window.WebSocket = class extends Native {
              constructor(...args) {
                super(...args);
                const deliver = (listener) => (event) => setTimeout(() => listener.call(this, event), ms);
                const add = this.addEventListener.bind(this);
                this.addEventListener = (type, listener, options) =>
                  add(type, type === "message" ? deliver(listener) : listener, options);
                let onmessage = null;
                Object.defineProperty(this, "onmessage", {
                  get: () => onmessage,
                  set: (listener) => {
                    onmessage = listener;
                    add("message", deliver((event) => onmessage?.(event)));
                  },
                });
              }
              send(data) {
                setTimeout(() => {
                  if (this.readyState === Native.OPEN) super.send(data);
                }, ms);
              }
            };
          }, latency);
        }
        page.on("response", (response) => {
          if (response.status() >= 400 && response.url().startsWith(origin)) failures.push(`[${key}] ${response.status()} for ${response.url()}`);
        });
        if (chat) await page.route(`${origin}/api/chat`, chat);
      },
    });
    // A shared CI runner's timing, on a fast machine: E2E_CPU_THROTTLE=4 slows
    // every tab's CPU fourfold; E2E_LATENCY_MS=300 is set up in `setup` below.
    const throttle = Number(process.env.E2E_CPU_THROTTLE ?? 1);
    if (throttle > 1) {
      const cdp = await tab.page.context().newCDPSession(tab.page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    }
    tabs[key] = tab;
    return tab;
  }
  // The rail's open state is remembered across loads, so only a rail that is out is put away.
  const putChatAway = async (P) => {
    if (await P.locator('[aria-label="Collapse chat"]').isVisible()) await P.click('[aria-label="Collapse chat"]');
  };
  const bringChatOut = async (P) => {
    if (await P.locator('[aria-label="Open chat"]').isVisible()) await P.click('[aria-label="Open chat"]');
  };
  const editorOf = (page, blockId = "p_ship") => page.waitForSelector(`.bn-editor [data-id='${blockId}']`, { timeout: 30000 });
  const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) });

  // ── The chat's model stand-in (Olive's tab only) ───────────────────────────
  const chatBodies = [];
  const chatScript = [];
  const chat = async (route) => {
    chatBodies.push(JSON.parse(route.request().postData() ?? "{}"));
    const step = chatScript.shift();
    if (!step) {
      failures.push("a chat request arrived with nothing scripted for it");
      return route.abort();
    }
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" }, body: stream(step) });
  };

  // Olive's pages are written first, born as the app births a document
  // (through `ydoc.init`), and then she opens the project.
  const O = (await open("olive", { path: "/__seed", identity: PEOPLE.olive, token: jwt.olive, chat })).page;
  await O.waitForFunction(() => !!window.e2e);
  await O.evaluate(([docId, blocks]) => window.e2e.seed(docId, blocks), [page.docId, PARAGRAPHS]);
  await O.evaluate(([docId, blocks]) => window.e2e.seed(docId, blocks), [notes.docId, [["n_first", "Loose notes for later."]]]);
  check("the pages are born on the server", (await reader.storedBlocks(olive, page.docId)).map((b) => b.id), PARAGRAPHS.map(([id]) => id));
  await O.goto(`${origin}/p/${projectId}?page=${page._id}`, { waitUntil: "domcontentloaded" });
  await editorOf(O);

  // =========================================================================
  section("1. Sharing: Olive makes three links by clicking; each person opens theirs");
  await O.click('[aria-label="Share project"]');
  await O.waitForSelector('[role="dialog"][aria-label="Share project"]');
  const makeLink = async (label, role) => {
    await O.click(`[role="group"][aria-label="Share links"] button:has-text("${label}")`);
    await O.click(`button:has-text("Create ${role} link")`);
    await O.waitForSelector(`input[aria-label="${role[0].toUpperCase() + role.slice(1)} link"]`);
    await O.waitForSelector('button[data-done]');
    return O.evaluate(() => navigator.clipboard.readText());
  };
  const links = {
    editor: await makeLink("Editor link", "editor"),
    commenter: await makeLink("Commenter link", "commenter"),
    viewer: await makeLink("Viewer link", "viewer"),
  };
  const stored = await olive.query(anyApi.share.links, { projectId });
  check("[olive] each copied link is the server's token for that role", links,
    { editor: `${origin}/share/${stored.editor}`, commenter: `${origin}/share/${stored.commenter}`, viewer: `${origin}/share/${stored.viewer}` });
  await shot(O, "01-olive-share-links");
  await O.keyboard.press("Escape");

  const claimed = {};
  for (const [key, role] of [["eddie", "editor"], ["cora", "commenter"], ["vic", "viewer"]]) {
    const { page: P } = await open(key, { path: new URL(links[role]).pathname, identity: PEOPLE[key], token: jwt[key] });
    const landed = await waitFor(P, (id) => location.pathname === `/p/${id}`, projectId, 20000);
    await editorOf(P);
    claimed[key] = [landed, await as(key).query(anyApi.projects.myRole, { projectId })];
  }
  check("[eddie, cora, vic] each is claimed and carried from the link to the project, in their link's role", claimed,
    { eddie: [true, "editor"], cora: [true, "commenter"], vic: [true, "viewer"] });
  const E = tabs.eddie.page, C = tabs.cora.page, V = tabs.vic.page;

  await O.click('[aria-label="Share project"]');
  const people = await until(
    () => O.$$eval('[aria-label="People with access"] li', (els) =>
      // A row's name is its truncating span; what they hold is the muted
      // label at its end (a claimant's sits beside its ⋯ menu).
      els.map((el) => {
        const name = el.querySelector("span.truncate")?.textContent.trim();
        const holds = (el.querySelector(".nt-share-hold-text") ?? [...el.querySelectorAll(":scope > span.text-muted")].pop())?.textContent.trim();
        return `${name} · ${holds}`;
      })).catch(() => []),
    (list) => list.length === 4,
  );
  check("[olive] the collaborator list names each person with their role", [...people].sort(),
    ["Cora Commenter · Commenter", "Eddie Editor · Editor", "Vic Viewer · Viewer", "You · Owner"]);
  await shot(O, "02-olive-collaborators");
  await O.keyboard.press("Escape");
  check("[eddie] the page is his to write", await E.$eval(".bn-editor", (el) => el.getAttribute("contenteditable")), "true");
  check("[cora, vic] the page is read-only", [await C.$eval(".bn-editor", (el) => el.getAttribute("contenteditable")), await V.$eval(".bn-editor", (el) => el.getAttribute("contenteditable"))], ["false", "false"]);

  // Cards, not dots: the chat rails go away, as a person reading comments would put them.
  for (const P of [O, E]) {
    await P.click('[aria-label="Collapse chat"]');
    await waitFor(P, () => document.querySelector(".nt-comment-layer")?.dataset.mode !== "dots");
  }

  // =========================================================================
  section("2. Commenting: Cora comments on Olive's words and mentions her; the conversation runs live");
  // The page as the writers' editors left it on opening (they add the trailing
  // empty paragraph an editable page keeps); nothing a comment does may change it.
  const pageText = async () => (await reader.storedBlocks(olive, page.docId)).map((b) => b.text);
  const baseline = await pageText();
  await dragSelect(C, "p_ship", "by", "Friday");
  await C.waitForSelector(".nt-comment-float", { timeout: 5000 });
  check("[cora] a Comment button floats over her selection on the read-only page", (await C.textContent(".nt-comment-float")).trim(), "Comment");
  await shot(C, "03-cora-float");
  await C.click(".nt-comment-float");
  await C.waitForSelector(".nt-comment-draft textarea:focus");
  await C.keyboard.type("Is Friday realistic? @Ol", { delay: 15 });
  await C.waitForSelector(".nt-mention-menu [role=option]");
  check("[cora] @ offers the project's people who may comment", await C.$$eval(".nt-mention-menu [role=option]", (els) => els.map((el) => el.textContent)), ["Olive Owner"]);
  await C.keyboard.press("Enter");
  await C.keyboard.type("please confirm.", { delay: 10 });
  const firstBody = body("Is Friday realistic? @Olive Owner please confirm.");
  check("[cora] the mention is written as @Name", await C.$eval(".nt-comment-draft textarea", (el) => el.value), firstBody);
  await C.keyboard.press("Enter");

  const commentsDocId = await until(() => olive.query(anyApi.comments.docFor, { pageId: page._id }), Boolean);
  const serverThreads = () => reader.storedThreads(olive, commentsDocId);
  let threads = await until(serverThreads, (list) => list.length === 1);
  const friday = threads[0];
  check("[server] the first comment minted the comments document and holds Cora's thread",
    threads.map((t) => ({ blockId: t.blockId, exact: t.exact, status: t.status, comments: t.comments.map((c) => [c.authorId, c.text]) })),
    [{ blockId: "p_ship", exact: "by Friday", status: "open", comments: [[PEOPLE.cora.userId, firstBody]] }]);
  check("[server] the page itself was never written", await pageText(), baseline);

  const card = (id) => `.nt-comment-layer [data-thread-card="${id}"]`;
  const cardShows = (P, id, words) => waitFor(P, ([sel, w]) => document.querySelector(sel)?.textContent.includes(w), [card(id), words]);
  const cardGone = (P, id) => waitFor(P, (sel) => !document.querySelector(sel), card(id));
  // A highlight crossing another decoration (a collaborator's caret, a mark) is several spans: one entry per thread.
  const highlights = (P) => P.$$eval(".bn-editor .nt-comment-hl", (els) => {
    const byThread = new Map();
    for (const el of els) byThread.set(el.dataset.thread, (byThread.get(el.dataset.thread) ?? "") + el.textContent);
    return [...byThread.values()];
  });
  check("[olive] Cora's card arrives in her margin, live, signed by name", await cardShows(O, friday.id, "Cora Commenter"), true);
  check("[olive] and her words are highlighted", await until(() => highlights(O), (h) => h.includes("by Friday")), ["by Friday"]);
  const notice = await O.waitForSelector(".nt-notice .nt-ask-said", { timeout: 15000 }).then((el) => el.textContent(), () => null);
  check("[olive] an inbox notice arrives in the corner", notice, "Cora Commenter mentioned you on Launch plan");
  await shot(O, "04-olive-card-and-notice");
  // She reads it from her other page: the notice brings her back to the thread.
  await O.click(`[data-row="${notesId}"] [role=treeitem]`);
  await editorOf(O, "n_first");
  await O.click(".nt-notice .nt-notice-open");
  check("[olive] the notice lands her on the page, the thread focused", await waitFor(O, (sel) => document.querySelector(sel)?.hasAttribute("data-focused"), card(friday.id)), true);
  check("[olive] and the address no longer names the thread or the page", await until(() => O.evaluate(() => location.search), (q) => q === ""), "");
  check("[olive] the notice is gone, and marked seen on the server",
    [await O.$$eval(".nt-notice", (els) => els.length), (await until(() => olive.query(anyApi.commentNotices.inbox, {}), (n) => n.length === 0)).length], [0, 0]);

  await C.click(`[data-row="${notesId}"] [role=treeitem]`);
  await editorOf(C, "n_first");
  await O.click(`${card(friday.id)} .nt-comment-body`);
  await O.click(`${card(friday.id)} textarea[aria-label="Reply"]`);
  const replyBody = body("Friday holds if QA signs off Thursday.");
  await O.keyboard.type(replyBody, { delay: 8 });
  await O.keyboard.press("Enter");
  threads = await until(serverThreads, (list) => list[0]?.comments.length === 2);
  check("[server] Olive's reply is stored under Cora's comment", threads[0].comments.map((c) => [c.authorId, c.text]),
    [[PEOPLE.cora.userId, firstBody], [PEOPLE.olive.userId, replyBody]]);
  const replyNotice = await C.waitForSelector(".nt-notice .nt-ask-said", { timeout: 15000 }).then((el) => el.textContent(), () => null);
  check("[cora] a reply notice reaches her on her other page", replyNotice, "Olive Owner replied on Launch plan");
  await C.click(".nt-notice .nt-notice-open");
  check("[cora] it brings her to the thread, focused, with the reply in it",
    await waitFor(C, ([sel, w]) => { const el = document.querySelector(sel); return !!el?.hasAttribute("data-focused") && el.textContent.includes(w); }, [card(friday.id), replyBody]), true);
  await shot(C, "05-cora-reply-arrived");

  await E.click(`${card(friday.id)} .nt-comment-body`);
  await E.click(`${card(friday.id)} button[aria-label="Resolve"]`);
  check("[eddie, olive, cora] resolving takes the card out of every margin",
    [await cardGone(E, friday.id), await cardGone(O, friday.id), await cardGone(C, friday.id)], [true, true, true]);
  check("[server] stored as resolved", (await until(serverThreads, (l) => l[0]?.status === "resolved"))[0].status, "resolved");
  await O.click("[data-comments-toggle]");
  await O.waitForSelector(".nt-comments-panel");
  const panelIds = (P, kind) => P.$$eval(`.nt-comments-panel [data-section="${kind}"] [data-thread-card]`, (els) => els.map((el) => el.dataset.threadCard));
  check("[olive] the panel lists it under Resolved, by Eddie", [await panelIds(O, "resolved"),
    await waitFor(O, (id) => document.querySelector(`.nt-comments-panel [data-thread-card="${id}"]`)?.textContent.includes("Resolved by Eddie Editor"), friday.id)], [[friday.id], true]);
  await shot(O, "06-olive-panel-resolved");
  await O.click('[aria-label="Close comments"]');
  check("[cora] she is told her thread was resolved", (await until(() => as("cora").query(anyApi.commentNotices.inbox, {}), (n) => n.some((x) => x.kind === "resolved"))).map((n) => n.kind), ["resolved"]);

  await C.click("[data-comments-toggle]");
  await C.waitForSelector(".nt-comments-panel");
  // As in Docs, replying to a resolved thread reopens it: one write, one reply notice.
  await C.click(`.nt-comments-panel [data-thread-card="${friday.id}"] .nt-comment-body`);
  await C.click(`.nt-comments-panel [data-thread-card="${friday.id}"] textarea[aria-label="Reply"]`);
  const reopenBody = body("Reopening: QA moved to Friday morning.");
  await C.keyboard.type(reopenBody, { delay: 8 });
  await C.keyboard.press("Enter");
  threads = await until(serverThreads, (l) => l[0]?.comments.length === 3);
  check("[server] her reply reopened it", [threads[0].status, threads[0].comments.at(-1).text], ["open", reopenBody]);
  await C.click('[aria-label="Close comments"]');
  check("[cora, olive, eddie] reopened, the card is back in every margin, with her reply",
    [await cardShows(C, friday.id, reopenBody), await cardShows(O, friday.id, reopenBody), await cardShows(E, friday.id, reopenBody)], [true, true, true]);

  // =========================================================================
  section("3. The gate: each role is held to its channel by the server");
  const forged = (who) => reader.forgedUpdate(who);
  // The server's own words: a ConvexError's data, else the thrown message under the request line.
  const reason = (error) => typeof error.data === "string" ? error.data
    : typeof error.data?.message === "string" ? error.data.message
    : (/Uncaught (?:\w*Error): ([^\n]*)/.exec(error.message)?.[1] ?? error.message).trim();
  const attempt = (promise) => promise.then(() => "accepted", (error) => `refused: ${reason(error)}`);
  const seq = async (docId) => (await olive.query(anyApi.ydoc.meta, { docId }))?.seq ?? 0;

  const pageSeq = await seq(page.docId);
  check("[cora] her raw append to the page's document is refused", await attempt(as("cora").mutation(anyApi.ydoc.append, { docId: page.docId, update: forged("cora") })), "refused: Not found");
  await clickEndOf(C, "p_risk");
  await C.keyboard.type(" zq", { delay: 20 });
  // Absence has no event to wait on: longer than the provider's debounce, then read.
  await wait(1500);
  check("[cora] her typing changes nothing on her screen", (await C.textContent(".bn-editor")).includes("zq"), false);
  check("[server] and nothing reached the stored page", [await seq(page.docId), await pageText()], [pageSeq, baseline]);

  check("[vic] reads the thread in his margin, its two replies folded", await cardShows(V, friday.id, "2 replies"), true);
  await dragSelect(V, "p_budget", "hosting", "cost");
  await wait(300);
  check("[vic] his selection is offered no Comment", [await V.evaluate(() => String(document.getSelection())), await V.$$eval(".nt-comment-float", (els) => els.length)], ["hosting cost", 0]);
  const commentsSeq = await seq(commentsDocId);
  check("[vic] his raw append to the comments document is refused", await attempt(as("vic").mutation(anyApi.ydoc.append, { docId: commentsDocId, update: forged("vic") })), "refused: Not found");
  check("[server] the comments document is untouched", await seq(commentsDocId), commentsSeq);

  // Cora may write the comments document, but not in someone else's name: the
  // server reads what a comments append would change and refuses a forgery.
  const forgery = "Olive signs off on Friday.";
  const signedAsOlive = await reader.forgedReply(as("cora"), commentsDocId, friday.id, PEOPLE.olive.userId, forgery);
  check("[cora] her raw append of a reply signed as Olive is refused",
    await attempt(as("cora").mutation(anyApi.ydoc.append, { docId: commentsDocId, update: signedAsOlive })),
    "refused: A comment can only be written in your own name.");
  check("[server] nothing landed", [await seq(commentsDocId), (await serverThreads())[0].comments.some((c) => c.text === forgery)], [commentsSeq, false]);
  await wait(1500);
  check("[olive, eddie, cora, vic] no screen shows it",
    await Promise.all([O, E, C, V].map((P) => P.evaluate((text) => document.body.textContent.includes(text), forgery))),
    [false, false, false, false]);

  const sam = as("sam");
  // A live link still opens the page's document to anyone (the document
  // channel's link fallback, design §5); the comments channel takes none.
  check("[sam] a stranger, while links are live, reads the page but not its comments", [
    await attempt(sam.query(anyApi.ydoc.load, { docId: page.docId, afterSeq: 0 })),
    await attempt(sam.query(anyApi.ydoc.load, { docId: commentsDocId, afterSeq: 0 })),
  ], ["accepted", "refused: Not found"]);
  check("[sam] and writes neither", [
    await attempt(sam.mutation(anyApi.ydoc.append, { docId: page.docId, update: forged("sam") })),
    await attempt(sam.mutation(anyApi.ydoc.append, { docId: commentsDocId, update: forged("sam") })),
  ], ["refused: Not found", "refused: Not found"]);

  const G = (await open("gus", { path: new URL(links.commenter).pathname })).page;
  await editorOf(G);
  check("[gus] signed out, he reads the page", (await G.textContent(".bn-editor")).includes("Ship it by Friday"), true);
  await doubleClickWord(G, "p_ship", "Friday");
  await G.waitForSelector(".nt-comment-float", { timeout: 5000 });
  check("[gus] a selection offers Sign in to comment", (await G.textContent(".nt-comment-float")).trim(), "Sign in to comment");
  check("[gus] no comment surface, no highlight", [await G.$$eval(".nt-comment-layer, [data-comments-toggle]", (els) => els.length), await highlights(G)], [0, []]);
  check("[gus] his tab never asked for the comments", (await G.evaluate(() => window.e2e.called())).filter((name) => name.startsWith("comments:") || name.startsWith("commentNotices:")), []);
  check("[gus] and the server refuses him the comments document", await attempt(as("guest").query(anyApi.ydoc.load, { docId: commentsDocId, afterSeq: 0 })), "refused: Not found");
  await G.click(".nt-comment-float");
  check("[gus] pressing it opens the sign-in door", await waitFor(G, () => [...document.querySelectorAll('[role="dialog"]')].some((d) => d.textContent.includes("Sign in to comment"))), true);
  await shot(G, "07-gus-sign-in");
  await tabs.gus.context.close();

  // Oscar stands in for Cora with a token this deployment minted for him.
  const opsToken = await deployment.client(null).mutation(anyApi.admin.login, { username: operator.user, password: operator.password });
  const { token: standIn } = await deployment.client(null).action(anyApi.impersonationMint.start, { token: opsToken, subject: PEOPLE.cora.userId, reason: "support ticket e2e" });
  const oscar = deployment.client(standIn);
  check("[oscar] standing in, he reads as Cora but with a viewer's role", await oscar.query(anyApi.projects.myRole, { projectId }), "viewer");
  check("[oscar] reads the comments", (await reader.storedThreads(oscar, commentsDocId)).map((t) => t.id), [friday.id]);
  const readOnly = "refused: Read-only: this session is an operator standing in for you.";
  check("[oscar] every comment write is refused as a stand-in's", [
    await attempt(oscar.mutation(anyApi.ydoc.append, { docId: commentsDocId, update: forged("oscar") })),
    await attempt(oscar.mutation(anyApi.comments.ensureDoc, { pageId: page._id })),
    await attempt(oscar.mutation(anyApi.commentNotices.event, { pageId: page._id, threadId: friday.id, kind: "reply", mentions: [] })),
  ], [readOnly, readOnly, readOnly]);
  const S = (await open("oscar", { path: `/p/${projectId}?page=${page._id}`, identity: PEOPLE.cora, token: standIn })).page;
  await editorOf(S);
  check("[oscar] his screen shows the thread, read-only", [await cardShows(S, friday.id, "2 replies"), await S.$eval(".bn-editor", (el) => el.getAttribute("contenteditable"))], [true, "false"]);
  await dragSelect(S, "p_budget", "hosting", "cost");
  await wait(300);
  check("[oscar] and offers him no Comment", await S.$$eval(".nt-comment-float", (els) => els.length), 0);
  await tabs.oscar.context.close();

  // =========================================================================
  section("4. Anchors under real collaboration: Eddie edits the words Cora commented on");
  const ranges = (P) => P.evaluate((id) => window.e2e.ranges(id), page._id);
  const rangeOf = async (P, id) => (await ranges(P))[id] ?? null;
  const storedFriday = async () => (await serverThreads()).find((t) => t.id === friday.id);
  // A caret just after "by": inside the commented words, not at an edge.
  const by = await wordBox(E, "p_ship", "by");
  await E.mouse.click(by.x + by.width, by.y + by.height / 2);
  await E.keyboard.type(" next", { delay: 25 });
  const typedAt = Date.now();
  const beforeSettle = (await storedFriday()).exact;
  const settleWindow = Date.now() - typedAt;
  check(`[server] straight after typing (${settleWindow} ms), the stored quote is untouched`, beforeSettle, "by Friday");
  check("[eddie, olive, cora] the highlight tracks the new words on every client", [
    await until(() => rangeOf(E, friday.id), (r) => r === "by next Friday"),
    await until(() => rangeOf(O, friday.id), (r) => r === "by next Friday"),
    await until(() => rangeOf(C, friday.id), (r) => r === "by next Friday"),
  ], ["by next Friday", "by next Friday", "by next Friday"]);
  check("[server] once the edit settles, the stored quote is rewritten to the words it now covers",
    (await until(storedFriday, (t) => t.exact === "by next Friday")).exact, "by next Friday");
  check("[olive] her screen draws it", await until(() => highlights(O), (h) => h.includes("by next Friday")), ["by next Friday"]);
  await shot(O, "08-olive-tracked-edit");

  // Eddie cuts the whole paragraph and pastes it at the end of the page.
  // A collaborator's caret is drawn inside the text with word joiners; a reader's eye skips them.
  const visible = (text) => text.replace(/\u2060/g, "");
  const blockText = (P, id) => P.evaluate(([pageId, blockId]) => window.e2e.blockText(pageId, blockId), [page._id, id]);
  const blockIds = new Set([(await storedFriday()).blockId]);
  const shipText = "Ship it by next Friday if the tests pass and the design review signs off.";
  await E.click(".bn-editor [data-id='p_ship'] .bn-inline-content", { clickCount: 3 });
  check("[eddie] a triple-click takes the paragraph", visible(await E.evaluate(() => String(document.getSelection()).trim())), shipText);
  await E.keyboard.press("ControlOrMeta+x");
  await clickEndOf(E, "p_after");
  await E.keyboard.press("Enter");
  await E.keyboard.press("ControlOrMeta+v");
  const moved = await until(
    () => E.$$eval(".bn-editor [data-id]", (els, text) => [...new Set(els.filter((el) => el.querySelector(".bn-inline-content")?.textContent.replace(/\u2060/g, "") === text).map((el) => el.dataset.id))], shipText),
    (ids) => ids.length === 1 && ids[0] !== "p_ship",
  );
  check("[eddie] the paragraph now lives in a new block at the end", moved.length === 1 && moved[0] !== "p_ship", true);
  const newBlock = moved[0];
  check("[server] the move is stored: the words in the new block, the old one empty",
    await until(async () => (await reader.storedBlocks(olive, page.docId)).filter((b) => b.id === newBlock || b.id === "p_ship").map((b) => [b.id, b.text]),
      (list) => list.length === 2 && list.some(([id, t]) => id === newBlock && t === shipText) && list.some(([id, t]) => id === "p_ship" && t === "")),
    [["p_ship", ""], [newBlock, shipText]]);
  await O.reload({ waitUntil: "domcontentloaded" });
  await editorOf(O, newBlock);
  const rehomed = await until(async () => {
    const t = await storedFriday();
    blockIds.add(t.blockId);
    return t;
  }, (t) => t.blockId === newBlock && !t.orphaned);
  check("[server] after Olive reloads, stage 3 has re-homed the anchor to the new block", [rehomed.blockId, rehomed.exact, rehomed.orphaned], [newBlock, "by next Friday", false]);
  check("[server] the stored block id changed exactly once", [...blockIds], ["p_ship", newBlock]);
  check("[olive] her highlight is on the moved words", await until(() => rangeOf(O, friday.id), (r) => r === "by next Friday"), "by next Friday");
  check("[olive] the reload keeps her layout: the chat stays put away", await O.locator('[aria-label="Open chat"]').waitFor().then(() => true, () => false), true);

  // Eddie deletes the words; ⌘Z brings them back.
  await dragSelect(E, newBlock, "by", "Friday");
  check("[eddie] he selects the commented words", visible(await E.evaluate(() => String(document.getSelection()))), "by next Friday");
  await E.keyboard.press("Backspace");
  check("[eddie, olive, cora] the card leaves every margin", [await cardGone(E, friday.id), await cardGone(O, friday.id), await cardGone(C, friday.id)], [true, true, true]);
  check("[server] the thread is stored as orphaned", (await until(storedFriday, (t) => t.orphaned)).orphaned, true);
  for (const P of [O, C]) {
    await P.click("[data-comments-toggle]");
    await P.waitForSelector(".nt-comments-panel");
  }
  check("[olive, cora] each panel lists it under No longer in the document",
    [await until(() => panelIds(O, "orphaned"), (ids) => ids.length === 1), await until(() => panelIds(C, "orphaned"), (ids) => ids.length === 1)], [[friday.id], [friday.id]]);
  await C.locator('.nt-comments-panel [data-section="orphaned"]').waitFor({ state: "visible" });
  await wait(300); // the panel's slide-in, for the picture only
  await shot(C, "09-cora-orphaned");
  for (const P of [O, C]) await P.click('[aria-label="Close comments"]');
  await E.keyboard.press(UNDO);
  check("[eddie] ⌘Z puts the words back", await until(() => blockText(E, newBlock), (t) => t === shipText), shipText);
  check("[server] the thread re-anchors, orphanedAt cleared", await until(async () => { const t = await storedFriday(); return [t.orphaned, t.blockId, t.exact]; }, (v) => v[0] === false), [false, newBlock, "by next Friday"]);
  check("[olive, cora] the card is back in both margins", [await cardShows(O, friday.id, "Is Friday realistic"), await cardShows(C, friday.id, "Is Friday realistic")], [true, true]);

  // =========================================================================
  section("5. The review: an AI proposal rewrites Cora's words; comments carry on, nothing is orphaned");
  const bodyAt = async (index) => { await until(() => chatBodies.length, (n) => n > index, 20000); return chatBodies[index]; };
  const ask = async (text) => {
    await O.click(".nt-composer-input");
    await O.keyboard.type(text, { delay: 5 });
    await O.keyboard.press("Enter");
  };
  const idle = () => waitFor(O, () => !document.querySelector(".nt-review-count.is-writing") && !document.querySelector('[aria-label="Stop"]'), undefined, 20000);
  const reviewBar = (label) => O.locator(`.nt-review-action:has-text("${label}")`);
  const hasOrphan = async () => (await storedFriday()).orphaned;
  await bringChatOut(O);
  await O.waitForSelector(".nt-composer-input");

  const rewritten = "Ship it once QA signs off and the design review passes.";
  chatScript.push(
    toolStep(["call_edit1", "edit_page", { pageId: page._id, html: `<p id="${newBlock}">${rewritten}</p>` }]),
    says("I tightened the shipping sentence."),
  );
  await ask("Tighten the shipping sentence");
  const firstChat = await bodyAt(0);
  check("[olive] the chat's request is answered in her tab, and carries the page's comments digest",
    [firstChat.pageId, (firstChat.comments?.threads ?? []).map((t) => t.id)], [page._id, [friday.id]]);
  check("[olive] the proposal lands in her editor as a review", await until(() => blockText(O, newBlock), (t) => t === rewritten), rewritten);
  await reviewBar("Discard all").waitFor({ timeout: 20000 });
  check("[olive] under the fork the thread reads as unanchored", await until(() => rangeOf(O, friday.id), (r) => r === null), null);
  check("[olive] and its words are not highlighted", (await highlights(O)).includes("by next Friday"), false);
  await wait(1500); // longer than the settle pass (600 ms): an orphan write would have landed
  check("[server] no orphan is written while the proposal stands", await hasOrphan(), false);
  check("[cora, eddie] the shared page is untouched: their highlight stands", [await rangeOf(C, friday.id), await rangeOf(E, friday.id)], ["by next Friday", "by next Friday"]);
  await shot(O, "10-olive-review-fork");

  // Cora comments on other words while the review is open.
  await doubleClickWord(C, "p_risk", "migration");
  await C.waitForSelector(".nt-comment-float", { timeout: 5000 });
  await C.click(".nt-comment-float");
  await C.waitForSelector(".nt-comment-draft textarea:focus");
  const migrationBody = body("Is there a rollback plan for the migration?");
  await C.keyboard.type(migrationBody, { delay: 5 });
  await C.keyboard.press("Enter");
  const migration = (await until(serverThreads, (l) => l.some((t) => t.exact === "migration"))).find((t) => t.exact === "migration");
  check("[server] Cora's thread lands during the review", migration && [migration.blockId, migration.comments[0].authorId, migration.comments[0].text], ["p_risk", PEOPLE.cora.userId, migrationBody]);
  check("[olive] and reaches Olive's forked page, highlighted", await until(() => highlights(O), (h) => h.includes("migration")), ["migration"]);
  check("[server] still no orphan for the rewritten thread", await hasOrphan(), false);

  await reviewBar("Discard all").click();
  check("[olive] Discard restores the words", await until(() => blockText(O, newBlock), (t) => t === shipText), shipText);
  check("[olive] and the highlight", await until(() => rangeOf(O, friday.id), (r) => r === "by next Friday"), "by next Friday");
  check("[server] the thread was never orphaned, its anchor as it was", await storedFriday().then((t) => [t.orphaned, t.blockId, t.exact]), [false, newBlock, "by next Friday"]);
  await idle();

  const drifted = "Ship it by the next Friday if the tests pass and the design review signs off.";
  chatScript.push(
    toolStep(["call_edit2", "edit_page", { pageId: page._id, html: `<p id="${newBlock}">${drifted}</p>` }]),
    says("Adjusted."),
  );
  await ask("Say the next Friday instead");
  await reviewBar("Keep all").waitFor({ timeout: 20000 });
  check("[olive] the second proposal is on her page", await until(() => blockText(O, newBlock), (t) => t === drifted), drifted);
  await wait(1500);
  check("[server] under the fork, the stored quote is untouched", await storedFriday().then((t) => [t.orphaned, t.exact]), [false, "by next Friday"]);
  await reviewBar("Keep all").click();
  // Stage 2 is a local edit-distance match: "next Friday" is 3 edits from the
  // stored "by next Friday", "by the next Friday" is 4, so the nearer wins.
  check("[server] Keep re-resolves against the kept text through stage 2: the quote is rewritten, same block",
    await until(storedFriday, (t) => t.exact !== "by next Friday").then((t) => [t.orphaned, t.blockId, t.exact]), [false, newBlock, "next Friday"]);
  check("[server] the page holds the kept words", await until(async () => (await reader.storedBlocks(olive, page.docId)).find((b) => b.id === newBlock)?.text, (t) => t === drifted), drifted);
  check("[olive] her highlight is the re-resolved words", await until(() => rangeOf(O, friday.id), (r) => r === "next Friday"), "next Friday");
  // Cora and Eddie never forked: the kept words reach them as a remote edit
  // inside their live range, which maps and grows — until Olive's rewritten
  // quote arrives and their range moves to what it quotes. No reload.
  check("[cora, eddie] their highlights follow the stored quote, without a reload", [
    await until(() => rangeOf(C, friday.id), (r) => r === "next Friday"),
    await until(() => rangeOf(E, friday.id), (r) => r === "next Friday"),
  ], ["next Friday", "next Friday"]);
  await wait(1500);
  check("[server] and neither wrote it back: the quote stays Olive's", await storedFriday().then((t) => t.exact), "next Friday");
  await C.reload({ waitUntil: "domcontentloaded" });
  await editorOf(C, newBlock);
  check("[cora] a reload agrees", await until(() => rangeOf(C, friday.id), (r) => r === "next Friday"), "next Friday");
  await idle();

  // =========================================================================
  section("6. Undo isolation: the document's ⌘Z, a card's ⌘Z, and a text box's own");
  const threadCount = async () => (await serverThreads()).length;
  const countBefore = await threadCount();
  await clickEndOf(O, "p_intro");
  await O.keyboard.type(" Draft.", { delay: 20 });
  await until(async () => (await reader.storedBlocks(olive, page.docId)).find((b) => b.id === "p_intro")?.text, (t) => t?.endsWith(" Draft."));
  await O.keyboard.press(UNDO);
  check("[olive] ⌘Z in the document takes back her typing", await until(async () => (await reader.storedBlocks(olive, page.docId)).find((b) => b.id === "p_intro")?.text, (t) => !t?.endsWith(" Draft.")), PARAGRAPHS[0][1]);
  check("[server] and no comment with it", await threadCount(), countBefore);
  await putChatAway(O);
  await waitFor(O, () => document.querySelector(".nt-comment-layer")?.dataset.mode === "cards");

  await O.click(`${card(migration.id)} .nt-comment-body`);
  await O.click(`${card(migration.id)} textarea[aria-label="Reply"]`);
  const undoneBody = body("We keep the old tables for a week.");
  await O.keyboard.type(undoneBody, { delay: 5 });
  await O.keyboard.press("Enter");
  check("[server] Olive's reply is stored", (await until(serverThreads, (l) => l.find((t) => t.id === migration.id)?.comments.length === 2)).find((t) => t.id === migration.id).comments.length, 2);
  await O.click(`${card(migration.id)} textarea[aria-label="Reply"]`);
  await O.keyboard.type("half a thought", { delay: 5 });
  await O.keyboard.press(UNDO);
  // The browser undoes its own typing (how much per press is its business).
  const boxAfter = await O.$eval(`${card(migration.id)} textarea[aria-label="Reply"]`, (el) => el.value);
  check("[olive] ⌘Z in the reply box is the box's own: the browser's undo, unclaimed",
    ["half a thought".startsWith(boxAfter) && boxAfter.length < "half a thought".length, await O.evaluate(() => window.__lastUndoKey?.defaultPrevented ?? null)], [true, false]);
  check("[server] and the stored reply stands", (await serverThreads()).find((t) => t.id === migration.id).comments.length, 2);
  await O.click(`${card(migration.id)} .nt-comment-name`);
  await O.keyboard.press(UNDO);
  check("[server] ⌘Z on the focused card takes her reply back, on the server",
    (await until(serverThreads, (l) => l.find((t) => t.id === migration.id)?.comments.length === 1)).find((t) => t.id === migration.id).comments.map((c) => c.authorId), [PEOPLE.cora.userId]);
  check("[cora] the reply leaves her screen too", await waitFor(C, ([sel, w]) => !document.querySelector(sel)?.textContent.includes(w), [card(migration.id), undoneBody]), true);
  check("[server] the page was not touched by either undo", (await reader.storedBlocks(olive, page.docId)).find((b) => b.id === "p_intro")?.text, PARAGRAPHS[0][1]);

  // =========================================================================
  section("7. The assistant's comment tools, with no model: a scripted stand-in drives the real executors");
  await bringChatOut(O);
  await O.waitForSelector(".nt-composer-input");
  const assistantBody = "Where does this hosting cost come from? @Eddie Editor";
  const turnStart = chatBodies.length;
  chatScript.push(
    toolStep(["call_c1", "create_comment", { pageId: page._id, blockId: "p_budget", quote: "hosting cost", text: assistantBody, mentions: ["Eddie Editor"] }]),
    toolStep(["call_c2", "create_comment", { pageId: page._id, blockId: "p_budget", quote: "cloud spend", text: "This quote is not on the page." }]),
    says("I asked Eddie about the hosting cost."),
  );
  await ask("Ask Eddie where the hosting cost comes from");
  const outputOf = (b, id) => b.messages.flatMap((m) => m.parts ?? []).find((p) => p.toolCallId === id);
  const afterCreate = await bodyAt(turnStart + 1);
  const created = outputOf(afterCreate, "call_c1");
  check("[chat] create_comment with a real quote starts a thread", [created?.state, String(created?.output).startsWith("Started thread")], ["output-available", true]);
  const hosting = (await until(serverThreads, (l) => l.some((t) => t.exact === "hosting cost"))).find((t) => t.exact === "hosting cost");
  check("[server] stored under Olive's name, marked via the assistant", hosting && [hosting.blockId, hosting.comments[0].authorId, hosting.comments[0].via, hosting.comments[0].text],
    ["p_budget", PEOPLE.olive.userId, "assistant", assistantBody]);
  BODIES.push(assistantBody);
  const afterRefusal = await bodyAt(turnStart + 2);
  const refused = outputOf(afterRefusal, "call_c2");
  check("[chat] a quote that is not on the page is refused, saying so", String(refused?.output).split("\n")[0],
    'Nothing was written. Block "p_budget" does not say "cloud spend" — the quote has to be its words exactly, character for character, as plain text without tags.');
  check("[server] and nothing is written for it", (await serverThreads()).filter((t) => t.exact === "cloud spend").length, 0);
  check("[chat] the resumed request's digest carries the new thread", (afterRefusal.comments?.threads ?? []).some((t) => t.id === hosting.id), true);
  check("[eddie] the card on his screen says via assistant, under Olive's name", await waitFor(E, ([sel]) => { const t = document.querySelector(sel)?.textContent ?? ""; return t.includes("via assistant") && t.includes("Olive Owner"); }, [card(hosting.id)]), true);
  check("[eddie] and he is told he was mentioned", (await until(() => as("eddie").query(anyApi.commentNotices.inbox, {}), (n) => n.some((x) => x.threadId === hosting.id))).filter((x) => x.threadId === hosting.id).map((x) => x.kind), ["mention"]);
  await shot(E, "11-eddie-via-assistant");
  await idle();
  check("[olive] every chat request was answered in her tab; none was left unscripted", chatScript.length, 0);

  // =========================================================================
  section("8. Audit and export: Olive downloads the comment activity; it records every action and no words");
  // One more kind of action for the record: Cora deletes her own reply.
  await C.click(`${card(friday.id)} .nt-comment-body`);
  const ownReply = C.locator(`${card(friday.id)} .nt-comment`).filter({ hasText: reopenBody });
  await ownReply.hover();
  await ownReply.locator('button[aria-label="More actions"]').click();
  await C.getByRole("menuitem", { name: "Delete", exact: true }).click();
  check("[server] Cora's reply is deleted", (await until(storedFriday, (t) => t.comments.length === 2)).comments.map((c) => c.text), [firstBody, replyBody]);

  await putChatAway(O);
  await O.click("text=Projects");
  // The project's own menu, as a right-click on it opens it.
  await O.waitForSelector("text=Autumn launch", { timeout: 20000 });
  await O.getByText("Autumn launch", { exact: true }).first().click({ button: "right" });
  const [download] = await Promise.all([
    O.waitForEvent("download", { timeout: 20000 }),
    O.click("[role='menuitem']:has-text('Export comment activity')"),
  ]);
  const csv = await readFile(await download.path(), "utf8");
  await download.saveAs(path.join(shots, "comment-activity.csv"));
  const rows = csv.replace(/^﻿/, "").trim().split(/\r?\n/);
  const header = rows[0];
  const cells = (row) => row.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((cell) => cell.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
  const actions = rows.slice(1).map(cells).map(([, action, , actorId, , subjectId]) => [action, actorId, subjectId]);
  check("[olive] the file is named for the project", download.suggestedFilename().startsWith("Autumn launch comment activity "), true);
  check("[olive] with the audit's columns", header, "at,action,actor,actor id,subject kind,subject id,page,counts");
  check("[csv] the rows are the actions taken, in order, by whom, on which thread", actions, [
    ["comment.create", PEOPLE.cora.userId, friday.id],
    ["comment.reply", PEOPLE.olive.userId, friday.id],
    ["comment.resolve", PEOPLE.eddie.userId, friday.id],
    ["comment.reply", PEOPLE.cora.userId, friday.id],
    ["comment.create", PEOPLE.cora.userId, migration.id],
    ["comment.reply", PEOPLE.olive.userId, migration.id],
    ["comment.create", PEOPLE.olive.userId, hosting.id],
    ["comment.delete", PEOPLE.cora.userId, friday.id],
  ]);
  check("[csv] and not one word anyone wrote", BODIES.filter((text) => csv.includes(text) || text.split(/\s+/).some((w) => w.length > 6 && csv.includes(w))), []);
  await shot(O, "12-olive-projects-export");

  // =========================================================================
  section("9. Two replicas converge: the comments document is one thing on every client and the server");
  const nml = (P) => P.evaluate((id) => window.e2e.commentsNml(id), page._id);
  const server = await until(() => reader.storedCommentsNml(olive, commentsDocId), (text) => text.includes(hosting.id));
  await O.goto(`${origin}/p/${projectId}?page=${page._id}`, { waitUntil: "domcontentloaded" });
  await editorOf(O, newBlock);
  const replicas = {
    olive: await until(() => nml(O), (text) => text === server),
    cora: await until(() => nml(C), (text) => text === server),
    eddie: await until(() => nml(E), (text) => text === server),
    vic: await until(() => nml(V), (text) => text === server),
  };
  const agreed = await reader.storedCommentsNml(olive, commentsDocId);
  check("[server] nothing moved while the replicas were read", agreed, server);
  check("[olive, cora, eddie, vic] every replica serializes to the server's document", Object.fromEntries(Object.entries(replicas).map(([k, v]) => [k, v === server])),
    { olive: true, cora: true, eddie: true, vic: true });
  check("[server] it holds the three threads this run left", (await serverThreads()).map((t) => [t.id, t.status, t.comments.length]),
    [[friday.id, "open", 2], [migration.id, "open", 1], [hosting.id, "open", 1]]);

  // =========================================================================
  section("10. Revocation (the gate, continued): links turned off close the channels they opened");
  const turnOff = async (label) => {
    await O.click('[aria-label="Share project"]');
    await O.click(`[role="group"][aria-label="Share links"] button:has-text("${label}")`);
    await O.click('button:has-text("Turn off link")');
    // Turning a link off is asked once more: its address stops working for good.
    await O.click('button:text-is("Turn off")');
    await O.keyboard.press("Escape");
  };
  await turnOff("Commenter link");
  check("[cora] with the comment link off, she is a viewer", await until(() => as("cora").query(anyApi.projects.myRole, { projectId }), (r) => r === "viewer"), "viewer");
  await dragSelect(C, "p_risk", "main", "risk");
  await wait(300);
  check("[cora] her selection is no longer offered a Comment", [visible(await C.evaluate(() => String(document.getSelection()))), await C.$$eval(".nt-comment-float", (els) => els.length)], ["main risk", 0]);
  check("[cora] she still reads the threads", await cardShows(C, friday.id, "Is Friday realistic"), true);
  check("[cora] and her raw append to the comments document is refused", await attempt(as("cora").mutation(anyApi.ydoc.append, { docId: commentsDocId, update: forged("cora") })), "refused: Not found");
  await turnOff("Editor link");
  await turnOff("Viewer link");
  check("[cora, eddie, vic] with every link off, each has lost the project", [
    await until(() => as("cora").query(anyApi.projects.myRole, { projectId }), (r) => r === null),
    await until(() => as("eddie").query(anyApi.projects.myRole, { projectId }), (r) => r === null),
    await until(() => as("vic").query(anyApi.projects.myRole, { projectId }), (r) => r === null),
  ], [null, null, null]);
  check("[cora, eddie, vic] and the page leaves their screens", [
    await waitFor(C, () => !document.querySelector(".bn-editor")), await waitFor(E, () => !document.querySelector(".bn-editor")), await waitFor(V, () => !document.querySelector(".bn-editor")),
  ], [true, true, true]);
  await shot(C, "13-cora-after-revocation");
  check("[sam, cora] no live link: neither document reads for anyone outside", [
    await attempt(sam.query(anyApi.ydoc.load, { docId: page.docId, afterSeq: 0 })),
    await attempt(as("cora").query(anyApi.ydoc.load, { docId: commentsDocId, afterSeq: 0 })),
  ], ["refused: Not found", "refused: Not found"]);

  // =========================================================================
  section("The guards held");
  for (const [key, tab] of Object.entries(tabs)) {
    const woke = [...new Set(tab.lanes)].sort();
    const writes = key === "olive" || key === "eddie";
    check(`[${key}] ${writes ? "woke only the ambient lanes, aborted in the tab" : "woke no AI lane"}`,
      writes ? woke.every((lane) => AI_LANE.test(lane)) : woke, writes ? true : []);
  }
  check("[olive] /api/chat was answered in her tab every time, never sent", chatBodies.length, 7);
} catch (error) {
  if (!(error instanceof Stop)) threw = error;
} finally {
  if (failures.length || threw) {
    for (const [key, tab] of Object.entries(tabs)) await tab.page.screenshot({ path: path.join(shots, `failed-${key}.png`) }).catch(() => {});
  }
  await browser?.close().catch(() => {});
  bundleServer?.close();
  await deployment?.close();
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
if (threw) failures.push(`harness threw: ${threw.stack ?? threw}`);
if (deployment?.outbound.length) failures.push(`the backend tried to reach: ${deployment.outbound.join(", ")}`);
if (failures.length) {
  console.error(`\n${failures.length} failure(s) after ${checks} checks:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`\nall ${checks} checks passed`);
process.exit(0);
