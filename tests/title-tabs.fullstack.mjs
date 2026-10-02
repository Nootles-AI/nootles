/**
 * A name edited in two tabs at once (NT-138), end to end: a REAL Convex
 * backend (a throwaway convex-local-backend, tests/fullstack-backend.mjs) and
 * the REAL app as its routes mount it — the workspace's sidebar and page title
 * (tests/comments-e2e.fullstack.tsx) — in two tabs of ONE browser context:
 * one person, one sign-in, the page open twice.
 *
 * The bug: the title field took an incoming title only while it was not
 * focused, and only at the moment the title changed. A background tab keeps
 * its focus, so a rename made in the other tab never reached it — and its next
 * keystroke saved its stale text over that rename. The sidebar's rename fields
 * had the same shape: an untouched field still wrote its stale name back.
 *
 * Every step is a real click or keystroke. What is asserted is read off both
 * screens (the title, the sidebar rows) and off the server.
 *
 * Nothing reaches a cloud deployment or a paid API: the backend is local, its
 * outbound fetches are refused (and fail the run), the AI keys are unset, the
 * ambient AI lanes are aborted in the tab, and every other browser request
 * outside the bundle and the backend fails the run.
 *
 *   npm run test:title:tabs
 *
 * Needs a convex-local-backend binary (see tests/fullstack-backend.mjs) and
 * system Chrome (`COMMENTS_BROWSER_CHANNEL=chromium` for Playwright's own).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { anyApi } from "convex/server";
import { bundleSurfaces, serveBundle, guardedTab, wait, ledger } from "./comments-surfaces.shared.mjs";
import { launchBrowser } from "./comments-launch.mjs";
import { startBackend } from "./fullstack-backend.mjs";
import { NAVIGATION } from "./comments-e2e.navigation.mjs";

const { failures, check, finish } = ledger();
let deployment, browser, served, work;
const watchdog = setTimeout(() => {
  console.error("\nwatchdog: the run took longer than 8 minutes");
  process.exit(2);
}, 8 * 60_000);
watchdog.unref();

/** Poll `read` until `accept` holds or `timeout` passes; the last value either way. */
async function until(read, accept, timeout = 8000) {
  const end = Date.now() + timeout;
  let value = await read();
  while (!accept(value) && Date.now() < end) {
    await wait(100);
    value = await read();
  }
  return value;
}

const TITLE = '[role=textbox][aria-label="Page title"]';

try {
  deployment = await startBackend({ name: "title-tabs" });
  const jwt = deployment.mint("user_tabs", "Tess Tabs");
  const tess = deployment.client(jwt);
  await tess.mutation(anyApi.profiles.skip, {});
  await tess.action(anyApi.identity.sync, {});
  for (const id of ["chat", "slash", "write"]) await tess.mutation(anyApi.profiles.seen, { id });
  const projectId = await tess.mutation(anyApi.projects.create, { title: "Tabs" });
  const [first] = await tess.query(anyApi.pages.listByProject, { projectId });
  const pageId = first._id;
  await tess.mutation(anyApi.pages.rename, { pageId, title: "p" });
  const otherId = await tess.mutation(anyApi.pages.create, { projectId, title: "Other" });
  const pageTitle = async (id = pageId) => (await tess.query(anyApi.pages.get, { pageId: id })).title;
  const projectTitle = async () => (await tess.query(anyApi.projects.get, { projectId })).title;

  work = await mkdtemp(path.join(tmpdir(), "title-tabs-"));
  await bundleSurfaces("tests/comments-e2e.fullstack.tsx", work, { probe: false, fixtures: { navigation: NAVIGATION } });
  served = await serveBundle(work);
  const { origin } = served;
  browser = await launchBrowser();
  // ONE context: the same person's browser, so its tabs share cookies and storage.
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  context.setDefaultTimeout(20_000);

  /** `hearsLate`: every frame from the backend reaches this tab that many ms late. */
  async function openTab(label, { hearsLate = 0 } = {}) {
    const { page } = await guardedTab(browser, {
      origin, allow: [deployment.url], label, failures, context, inert: false,
      path: `/p/${projectId}?page=${pageId}`,
      setup: async (_context, tab) => {
        await tab.addInitScript((cfg) => { window.__e2e = cfg; }, { url: deployment.url, jwt, identity: { userId: "user_tabs", name: "Tess Tabs" } });
        if (hearsLate) {
          await tab.addInitScript((ms) => {
            const Native = window.WebSocket;
            window.WebSocket = class extends Native {
              constructor(...args) {
                super(...args);
                const late = (listener) => (event) => setTimeout(() => listener.call(this, event), ms);
                const add = this.addEventListener.bind(this);
                this.addEventListener = (type, listener, options) => add(type, type === "message" ? late(listener) : listener, options);
                let onmessage = null;
                Object.defineProperty(this, "onmessage", {
                  get: () => onmessage,
                  set: (listener) => { onmessage = listener; add("message", late((event) => onmessage?.(event))); },
                });
              }
            };
          }, hearsLate);
        }
      },
    });
    await page.waitForSelector(TITLE);
    await page.waitForSelector(".bn-editor");
    page.label = label;
    return page;
  }
  const A = await openTab("A");
  const B = await openTab("B");

  const titleOf = (tab) => tab.$eval(TITLE, (el) => el.textContent);
  const titleFocused = (tab) => tab.$eval(TITLE, (el) => document.activeElement === el);
  const rowOf = (tab, id) => tab.$eval(`[data-row="${id}"] .nt-row-label`, (el) => el.textContent);
  const projectRow = (tab) => tab.$eval(".nt-panel-head + div .nt-row-label", (el) => el.textContent);
  /** A click in the title past its last letter, as a person puts the caret at the end. */
  const clickTitleEnd = async (tab) => {
    const box = await tab.locator(TITLE).boundingBox();
    await tab.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
  };
  const clickTitleStart = async (tab) => {
    const box = await tab.locator(TITLE).boundingBox();
    await tab.mouse.click(box.x + 1, box.y + box.height / 2);
  };
  const clickBody = (tab) => tab.locator(".bn-editor .bn-inline-content").first().click();
  /** Both tabs and the server agree on the title, or the last reading. */
  const agreed = async (want, id = pageId) =>
    until(async () => ({ server: await pageTitle(id), a: await titleOf(A), b: await titleOf(B) }),
      (v) => v.server === want && v.a === want && v.b === want);

  // ── 1. The ticket: B's caret stays in the title while A renames ──────────
  console.log("\n1. A rename in one tab reaches the other, whose caret is still in the title");
  await B.bringToFront();
  await clickTitleEnd(B);
  await B.keyboard.type("Draft", { delay: 30 });
  check("B's rename saved", await until(pageTitle, (t) => t === "pDraft"), "pDraft");
  await A.bringToFront();
  check("A shows B's rename", await until(() => titleOf(A), (t) => t === "pDraft"), "pDraft");
  await clickTitleEnd(A);
  await A.keyboard.press("ControlOrMeta+a");
  await A.keyboard.type("Launch plan", { delay: 30 });
  check("A's rename saved", await until(pageTitle, (t) => t === "Launch plan"), "Launch plan");
  check("B's title is still focused (a background tab keeps its focus)", await titleFocused(B), true);
  check("B shows A's rename while its caret is in the title", await until(() => titleOf(B), (t) => t === "Launch plan"), "Launch plan");
  check("B's sidebar row shows it", await until(() => rowOf(B, pageId), (t) => t === "Launch plan"), "Launch plan");
  await B.bringToFront();
  await clickBody(B);
  check("B still shows it after leaving the title", await titleOf(B), "Launch plan");
  await clickTitleEnd(B);
  await B.keyboard.type(" v2", { delay: 30 });
  check("B's word lands on A's rename, everywhere", await agreed("Launch plan v2"),
    { server: "Launch plan v2", a: "Launch plan v2", b: "Launch plan v2" });

  // ── 2. The caret stays where B was typing when A's rename arrives ────────
  console.log("\n2. B keeps typing in place while A's rename lands");
  await clickTitleEnd(B);
  await B.keyboard.type(" final", { delay: 30 });
  await agreed("Launch plan v2 final");
  // A renames the start while B's caret sits at the end; B goes on typing.
  await clickTitleStart(A);
  await A.keyboard.type("Q4 ", { delay: 30 });
  await until(() => titleOf(B), (t) => t.startsWith("Q4 "));
  await B.keyboard.type("!", { delay: 30 });
  check("B's next key lands at its caret, after A's rename", await agreed("Q4 Launch plan v2 final!"),
    { server: "Q4 Launch plan v2 final!", a: "Q4 Launch plan v2 final!", b: "Q4 Launch plan v2 final!" });

  // ── 3. Both tabs typing into the title at the same moment ────────────────
  console.log("\n3. Both tabs type at once, at opposite ends");
  await tess.mutation(anyApi.pages.rename, { pageId, title: "Plan" });
  await agreed("Plan");
  await clickTitleStart(A);
  await clickTitleEnd(B);
  await Promise.all([A.keyboard.type("The ", { delay: 40 }), B.keyboard.type(" for May", { delay: 40 })]);
  check("both words kept, in both tabs and on the server", await agreed("The Plan for May"),
    { server: "The Plan for May", a: "The Plan for May", b: "The Plan for May" });

  // ── 4. Switching page right after typing saves on the page typed into ────
  console.log("\n4. Leaving for another page straight after typing");
  await clickTitleEnd(B);
  await B.keyboard.type(" notes", { delay: 20 });
  await B.click(`[data-row="${otherId}"] button`);
  await B.waitForFunction((t) => document.querySelector(t)?.textContent === "Other", TITLE);
  check("the typing saved on the first page", await until(pageTitle, (t) => t === "The Plan for May notes"), "The Plan for May notes");
  check("the other page untouched", await pageTitle(otherId), "Other");
  await B.click(`[data-row="${pageId}"] button`);
  await B.waitForFunction((t) => document.querySelector(t)?.textContent === "The Plan for May notes", TITLE);

  // ── 5. The sidebar's page rename ─────────────────────────────────────────
  console.log("\n5. A rename field left open in the sidebar while the other tab renames");
  await tess.mutation(anyApi.pages.rename, { pageId, title: "Plan" });
  await agreed("Plan");
  await B.bringToFront();
  await B.dblclick(`[data-row="${pageId}"] button`);
  await B.waitForSelector('[role=textbox][aria-label="Page name"]');
  await A.bringToFront();
  await clickTitleEnd(A);
  await A.keyboard.press("ControlOrMeta+a");
  await A.keyboard.type("Budget", { delay: 30 });
  await until(pageTitle, (t) => t === "Budget");
  await B.bringToFront();
  await B.keyboard.press("Enter");
  await wait(1000);
  check("an untouched field writes nothing back", await pageTitle(), "Budget");
  check("and B shows the rename", await until(() => titleOf(B), (t) => t === "Budget"), "Budget");

  await B.dblclick(`[data-row="${pageId}"] button`);
  await B.waitForSelector('[role=textbox][aria-label="Page name"]');
  await A.bringToFront();
  await clickTitleEnd(A);
  await A.keyboard.press("ControlOrMeta+a");
  await A.keyboard.type("Costs", { delay: 30 });
  await until(pageTitle, (t) => t === "Costs");
  await B.bringToFront();
  await B.keyboard.type(" 2026", { delay: 30 });
  await B.keyboard.press("Enter");
  check("words typed against the old name land on the new one", await agreed("Costs 2026"),
    { server: "Costs 2026", a: "Costs 2026", b: "Costs 2026" });

  // ── 6. The sidebar's project name ────────────────────────────────────────
  console.log("\n6. The project name, renamed in one tab while the other's field is open");
  const renameProjectIn = async (tab) => {
    await tab.dblclick('button[title="Double-click to rename"].font-semibold');
    await tab.waitForSelector('[role=textbox][aria-label="Project name"]');
  };
  await B.bringToFront();
  await renameProjectIn(B);
  await A.bringToFront();
  await renameProjectIn(A);
  await A.keyboard.press("ControlOrMeta+a");
  await A.keyboard.type("Roadmap", { delay: 30 });
  await A.keyboard.press("Enter");
  await until(projectTitle, (t) => t === "Roadmap");
  await B.bringToFront();
  await clickBody(B); // the field closes on blur
  await wait(1000);
  check("an untouched project field writes nothing back", await projectTitle(), "Roadmap");
  check("B's sidebar shows the rename", await until(() => projectRow(B), (t) => t === "Roadmap"), "Roadmap");

  await renameProjectIn(B);
  await A.bringToFront();
  await renameProjectIn(A);
  await A.keyboard.press("ControlOrMeta+a");
  await A.keyboard.type("Atlas", { delay: 30 });
  await A.keyboard.press("Enter");
  await until(projectTitle, (t) => t === "Atlas");
  await B.bringToFront();
  await B.keyboard.type(" 2026", { delay: 30 });
  await B.keyboard.press("Enter");
  check("words typed against the old project name land on the new one", await until(projectTitle, (t) => t === "Atlas 2026"), "Atlas 2026");
  check("both sidebars show it", [await until(() => projectRow(A), (t) => t === "Atlas 2026"), await until(() => projectRow(B), (t) => t === "Atlas 2026")], ["Atlas 2026", "Atlas 2026"]);

  // ── 7. A tab that hears late saves against a title already replaced ───
  console.log("\n7. A tab hears of a rename only after it has saved its own typing");
  await tess.mutation(anyApi.pages.rename, { pageId, title: "Plan" });
  await agreed("Plan");
  const C = await openTab("C", { hearsLate: 2500 });
  await C.waitForFunction((t) => document.querySelector(t)?.textContent === "Plan", TITLE);
  await A.bringToFront();
  await clickTitleEnd(A);
  await A.keyboard.press("ControlOrMeta+a");
  await A.keyboard.type("Budget", { delay: 20 });
  await until(pageTitle, (t) => t === "Budget");
  await C.bringToFront();
  await clickTitleEnd(C);
  await C.keyboard.type(" 2026", { delay: 20 });
  check("C still shows the old title as it types (it has not heard yet)", await titleOf(C), "Plan 2026");
  check("the server rebases C's words onto A's rename", await until(pageTitle, (t) => t === "Budget 2026"), "Budget 2026");
  check("and every tab ends there", await until(async () => [await titleOf(A), await titleOf(B), await titleOf(C)],
    (v) => v.every((t) => t === "Budget 2026"), 12_000), ["Budget 2026", "Budget 2026", "Budget 2026"]);
  // C's undo takes back what C typed, not A's rename under it.
  await clickTitleEnd(C);
  await C.keyboard.press("ControlOrMeta+z");
  check("C's undo removes only its own words", await until(pageTitle, (t) => t !== "Budget 2026"), "Budget");
  check("and every tab follows", await until(async () => [await titleOf(A), await titleOf(B), await titleOf(C)],
    (v) => v.every((t) => t === "Budget"), 12_000), ["Budget", "Budget", "Budget"]);
  await C.close();

  check("no outbound fetch from the backend", deployment.outbound, []);
} catch (error) {
  failures.push(`run stopped: ${error.stack ?? error.message}`);
  console.log(`  FAIL run stopped: ${error.message}`);
} finally {
  await browser?.close().catch(() => {});
  served?.server.close();
  await deployment?.close();
  if (work) await rm(work, { recursive: true, force: true });
}
finish();
