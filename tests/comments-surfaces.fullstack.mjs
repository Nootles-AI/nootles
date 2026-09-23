/**
 * The commenter, the viewer and the signed-out guest against a REAL backend:
 * a throwaway convex-local-backend on free ports, this repo's functions pushed
 * to it, and tokens from a fake OIDC issuer the backend trusts — so every
 * verdict below is `convex/prosemirror.ts` and `convex/auth.ts` deciding, not
 * a stand-in (docs/commenting-plan.md §5, §12 "The gate").
 *
 * The owner makes a project, turns on the comment and viewer links, and writes
 * the page; the commenter and the viewer claim their links. Then, through the
 * real workspace in Chromium, driven by mouse and keyboard:
 *
 * - the commenter's keystrokes never reach the page, and the same identity's
 *   raw append to the page's document is refused by the server — while the
 *   thread they start on words they selected lands in the comments document,
 *   where the owner reads it; ⌘Z on their card takes it back, on the server;
 * - the viewer reads that thread, is offered nothing for a selection, and the
 *   same identity's raw append to the comments document is refused;
 * - the signed-out guest on the comment link reads the page, is offered the
 *   sign-in door for a selection, and never asks for the comments.
 *
 * Nothing here reaches a cloud deployment or a paid API: `CONVEX_DEPLOYMENT`
 * is masked for every CLI call, the backend's action fetches go through a
 * proxy that refuses them, the AI keys are unset, and every browser request
 * outside the bundle and the local backend fails the run.
 *
 *   node tests/comments-surfaces.fullstack.mjs
 *
 * Needs a convex-local-backend binary (see tests/fullstack-backend.mjs) and
 * system Chrome.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { anyApi } from "convex/server";
import {
  bundleSurfaces, serveBundle, ledger, guardedTab, lanesCheck, probe, threadCount, docText, domSelection,
  lastKeyClaimed, waitFor, wait, doubleClickWord, dragSelect, clickEndOf, clickCard, startThread, UNDO, REDO,
} from "./comments-surfaces.shared.mjs";
import { launchBrowser } from "./comments-launch.mjs";
import { startBackend } from "./fullstack-backend.mjs";

const PEOPLE = {
  owner: { userId: "user_fs_owner", name: "Olive Owner" },
  commenter: { userId: "user_fs_commenter", name: "Cora Commenter" },
  viewer: { userId: "user_fs_viewer", name: "Vic Viewer" },
};

let browser;
let bundleServer;
let deployment;
const work = await mkdtemp(path.join(tmpdir(), "comments-fullstack-"));
const { failures, check, finish } = ledger();

try {
  deployment = await startBackend({ name: "comments-surfaces-e2e" });
  const CONVEX_URL = deployment.url;
  const jwt = Object.fromEntries(Object.entries(PEOPLE).map(([role, who]) => [role, deployment.mint(who.userId, who.name)]));
  const outbound = deployment.outbound;

  // ── The owner's project, links and claims, over the real wire ──────────────
  const as = (role) => deployment.client(jwt[role]);
  const owner = as("owner");
  const projectId = await owner.mutation(anyApi.projects.create, { title: "Launch plan" });
  const [page] = await owner.query(anyApi.pages.listByProject, { projectId });
  await owner.mutation(anyApi.pages.rename, { pageId: page._id, title: "Launch plan" });
  const commentToken = await owner.mutation(anyApi.share.setLink, { projectId, role: "commenter", enabled: true });
  const viewerToken = await owner.mutation(anyApi.share.setLink, { projectId, role: "viewer", enabled: true });
  await as("commenter").mutation(anyApi.share.claim, { token: commentToken });
  await as("viewer").mutation(anyApi.share.claim, { token: viewerToken });
  check("the commenter's role, as the server resolves it", await as("commenter").query(anyApi.projects.myRole, { projectId }), "commenter");
  check("the viewer's role, as the server resolves it", await as("viewer").query(anyApi.projects.myRole, { projectId }), "viewer");
  // ── Browser ────────────────────────────────────────────────────────────────
  const output = path.join(work, "bundle");
  await bundleSurfaces("tests/comments-surfaces.fullstack.tsx", output);
  const served = await serveBundle(output);
  bundleServer = served.server;
  browser = await launchBrowser();
  // The Convex client logs a refused mutation; the harness's own raw append is
  // the only one expected, and each tab counts that it saw exactly one.
  const REFUSED_APPEND = /M\(ydoc:append\)[\s\S]*Uncaught Error: Not found/;
  const tab = async (label) => {
    const opened = await guardedTab(browser, { origin: served.origin, allow: [CONVEX_URL], label, failures, expected: REFUSED_APPEND });
    await opened.page.waitForSelector('#app[data-ready="true"]', { state: "attached" });
    return opened;
  };
  const settle = async (page) => {
    await page.waitForSelector(".bn-editor [data-id='p_ship']", { timeout: 30000 });
    await page.waitForSelector("#probe[data-status]");
  };

  // The owner writes the page, as the app births a document, and stays to read.
  const ownerTab = await tab("owner");
  await ownerTab.page.evaluate((cfg) => window.full.connect(cfg), { url: CONVEX_URL, jwt: jwt.owner, identity: PEOPLE.owner });
  await ownerTab.page.evaluate((docId) => window.full.seedPage(docId, [
    { id: "p_ship", text: "Ship it by Friday if the tests pass." },
    { id: "p_second", text: "A second paragraph to read." },
  ]), page.docId);
  const ownerReads = {
    threads: () => ownerTab.page.evaluate((pageId) => window.full.storedThreads(pageId), page._id),
    pageSeq: () => ownerTab.page.evaluate((docId) => window.full.pageSeq(docId), page.docId),
  };

  // ---------------------------------------------------------------- commenter
  {
    console.log("\nthe commenter, in the real workspace");
    const { page: tabPage, context, lanes, expectedErrors } = await tab("commenter");
    await tabPage.evaluate((cfg) => window.full.mount(cfg), { url: CONVEX_URL, jwt: jwt.commenter, identity: PEOPLE.commenter, projectId });
    await settle(tabPage);
    check("[commenter] the page is read-only", await tabPage.$eval(".bn-editor", (el) => el.getAttribute("contenteditable")), "false");
    check("[commenter] comments: may read and write", await probe(tabPage).then((p) => [p.canRead, p.canComment]), [true, true]);

    const seqBefore = await ownerReads.pageSeq();
    await clickEndOf(tabPage, "p_ship");
    await tabPage.keyboard.type(" zq");
    await wait(1500);
    check("[commenter] typing leaves the page as it was", (await docText(tabPage)).includes("zq"), false);
    check("[commenter] …and nothing reached the page's stored log", await ownerReads.pageSeq(), seqBefore);
    check("[commenter] the same identity's raw append to the page's document is refused by the server",
      (await tabPage.evaluate((docId) => window.full.forceAppend(docId), page.docId)).startsWith("refused"), true);
    check("[commenter] …and the page's log is untouched", await ownerReads.pageSeq(), seqBefore);

    await doubleClickWord(tabPage, "p_ship", "Friday");
    check("[commenter] words select in the read-only page", await domSelection(tabPage), "Friday");
    check("[commenter] …and are offered for a comment", (await probe(tabPage)).selection?.kind, "comment");

    await startThread(tabPage, { blockId: "p_ship", word: "Friday", body: "Friday is ambitious", lastBlockId: "p_second" });
    check("[commenter] the first comment mints the comments document and lands on the server",
      await waitFor(tabPage, () => JSON.parse(document.querySelector("#probe").dataset.threads).length === 1, undefined, 15000), true);
    let seen = [];
    for (let i = 0; i < 50 && seen.length !== 1; i++, await wait(200)) seen = await ownerReads.threads();
    check("[commenter] the owner reads it from storage, anchored on the words and signed by the commenter", seen, [{ exact: "Friday", blockId: "p_ship", authors: [PEOPLE.commenter.userId] }]);
    check("[commenter] still nothing written to the page", await ownerReads.pageSeq(), seqBefore);

    await clickEndOf(tabPage, "p_ship");
    await tabPage.keyboard.press(UNDO);
    await wait(500);
    check("[commenter] ⌘Z in the page does not reach the comment", await threadCount(tabPage), 1);
    await clickCard(tabPage);
    await tabPage.keyboard.press(UNDO);
    check("[commenter] ⌘Z on the card takes the comment back", await waitFor(tabPage, () => JSON.parse(document.querySelector("#probe").dataset.threads).length === 0, undefined, 10000), true);
    for (let i = 0; i < 50 && seen.length !== 0; i++, await wait(200)) seen = await ownerReads.threads();
    check("[commenter] …on the server too", seen, []);
    check("[commenter] the card claimed the press", await lastKeyClaimed(tabPage), true);
    await tabPage.keyboard.press(REDO);
    for (let i = 0; i < 50 && seen.length !== 1; i++, await wait(200)) seen = await ownerReads.threads();
    check("[commenter] ⌘⇧Z puts it back, on the server", seen.length, 1);
    check("[commenter] the one refusal logged is the harness's own raw append", expectedErrors.length, 1);
    lanesCheck(check, "commenter", lanes, { writes: false });
    await context.close();
  }

  // ---------------------------------------------------------------- viewer
  {
    console.log("\nthe viewer, in the real workspace");
    const { page: tabPage, context, lanes, expectedErrors } = await tab("viewer");
    await tabPage.evaluate((cfg) => window.full.mount(cfg), { url: CONVEX_URL, jwt: jwt.viewer, identity: PEOPLE.viewer, projectId });
    await settle(tabPage);
    check("[viewer] the page is read-only", await tabPage.$eval(".bn-editor", (el) => el.getAttribute("contenteditable")), "false");
    check("[viewer] reads the commenter's thread", await waitFor(tabPage, () => JSON.parse(document.querySelector("#probe").dataset.threads).length === 1, undefined, 15000), true);
    check("[viewer] comments: reads, never writes", await probe(tabPage).then((p) => [p.canRead, p.canComment, p.store]), [true, false, false]);
    await dragSelect(tabPage, "p_second", "second", "paragraph");
    check("[viewer] words select", await domSelection(tabPage), "second paragraph");
    check("[viewer] …and nothing is offered for them", (await probe(tabPage)).selection, null);
    const commentsDocId = await tabPage.evaluate((pageId) => window.full.commentsDocId(pageId), page._id);
    check("[viewer] the same identity's raw append to the comments document is refused by the server",
      (await tabPage.evaluate((docId) => window.full.forceAppend(docId), commentsDocId)).startsWith("refused"), true);
    check("[viewer] the thread is as it was", (await ownerReads.threads()).length, 1);
    check("[viewer] the one refusal logged is the harness's own raw append", expectedErrors.length, 1);
    lanesCheck(check, "viewer", lanes, { writes: false });
    await context.close();
  }

  // ---------------------------------------------------------------- guest
  {
    console.log("\na signed-out guest on the comment link");
    const { page: tabPage, context, lanes, expectedErrors } = await tab("guest");
    await tabPage.evaluate((cfg) => window.full.mount(cfg), { url: CONVEX_URL, jwt: null, identity: null, token: commentToken });
    await settle(tabPage);
    check("[guest] reads the page", (await docText(tabPage)).includes("Ship it by Friday"), true);
    check("[guest] comments: none, and the sign-in door", await probe(tabPage).then((p) => [p.status, p.canRead, p.signIn, p.threads]), ["absent", false, true, []]);
    await doubleClickWord(tabPage, "p_ship", "Friday");
    check("[guest] a selection offers the sign-in", (await probe(tabPage)).selection?.kind, "signIn");
    const called = await tabPage.evaluate(() => window.full.called());
    check("[guest] the tab never asks for the comments", called.filter((name) => name.startsWith("comments:")), []);
    check("[guest] no refusal logged", expectedErrors.length, 0);
    lanesCheck(check, "guest", lanes, { writes: false });
    await context.close();
  }
  check("the backend fetched nothing beyond its own issuer", outbound, []);
} catch (error) {
  failures.push(`harness threw: ${error.stack ?? error}`);
} finally {
  await browser?.close();
  bundleServer?.close();
  await deployment?.close();
  await rm(work, { recursive: true, force: true }).catch(() => {});
}

finish();
