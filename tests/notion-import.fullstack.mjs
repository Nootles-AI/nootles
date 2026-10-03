/**
 * A Notion import racing a person who opens its pages (NT-131), end to end: a
 * REAL Convex backend (a throwaway convex-local-backend,
 * tests/fullstack-backend.mjs), the REAL app as its route mounts it, and the
 * REAL import run (`runImport`) in a tab of its own, with only Notion stood in
 * (tests/notion-import.fullstack.tsx).
 *
 * An import makes every page first and fills each after reading Notion, which
 * can take minutes, and the empty pages sit in the sidebar the whole time.
 * Before NT-131 an internal owner's import pages were born on NML, and opening
 * one let the editor's first flush beat the import's `ydoc.init`: the import
 * reported the page done, and it stayed empty.
 *
 * Run for a served owner (enrolled, serving on) and for an ordinary one:
 * 1. pages opened while Notion is still being read fill in front of the
 *    person, and stay filled — and a served owner's page then migrates;
 * 2. a page typed on before it is filled keeps the person's words, and the
 *    import says that page failed rather than "done".
 *
 * Nothing reaches a cloud deployment or a paid API: the backend is local, its
 * outbound fetches are refused (and fail the run), the AI keys are unset, the
 * ambient AI lanes are aborted in the tab, and every other browser request
 * outside the bundle and the backend fails the run.
 *
 *   npm run test:notion:import
 *
 * Needs a convex-local-backend binary (see tests/fullstack-backend.mjs) and
 * system Chrome (`COMMENTS_BROWSER_CHANNEL=chromium` for Playwright's own).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Y from "yjs";
import { ConvexHttpClient } from "convex/browser";
import { anyApi, makeFunctionReference } from "convex/server";
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
async function until(read, accept, timeout = 12_000) {
  const end = Date.now() + timeout;
  let value = await read();
  while (!accept(value) && Date.now() < end) {
    await wait(150);
    value = await read();
  }
  return value;
}

const EDITOR = ".bn-editor";

try {
  work = await mkdtemp(path.join(tmpdir(), "notion-import-"));
  deployment = await startBackend({ name: "notion-import" });
  const admin = new ConvexHttpClient(deployment.url);
  admin.setAdminAuth(deployment.adminKey);
  const run = (name, args = {}) => admin.mutation(makeFunctionReference(name), args);
  await run("nmlMigration:setNmlServe", { enabled: true });
  await run("nmlMigration:addInternalOwner", { subject: "user_nina", note: "e2e" });

  await bundleSurfaces("tests/notion-import.fullstack.tsx", path.join(work, "bundle"), { probe: false, fixtures: { navigation: NAVIGATION } });
  served = await serveBundle(path.join(work, "bundle"));
  browser = await launchBrowser();

  async function person(userId, name) {
    const jwt = deployment.mint(userId, name);
    const client = deployment.client(jwt);
    await client.mutation(anyApi.profiles.skip, {});
    await client.action(anyApi.identity.sync, {});
    for (const id of ["chat", "slash", "write"]) await client.mutation(anyApi.profiles.seen, { id });
    return { userId, name, jwt, client };
  }

  async function openTab(who, at, label) {
    const { page } = await guardedTab(browser, {
      origin: served.origin, allow: [deployment.url], label, failures, inert: false,
      viewport: { width: 1400, height: 900 }, path: at,
      setup: async (context, tab) => {
        context.setDefaultTimeout(20_000);
        await tab.addInitScript((cfg) => { window.__e2e = cfg; }, { url: deployment.url, jwt: who.jwt, identity: { userId: who.userId, name: who.name } });
      },
    });
    page.label = label;
    return page;
  }

  /** A document's stored history, read as its owner reads it: the log's position, the words on each root. */
  async function stored(who, docId) {
    const meta = await who.client.query(anyApi.ydoc.meta, { docId });
    const doc = new Y.Doc();
    if (meta?.snapshotParts) {
      const parts = [];
      for (let part = 0; part < meta.snapshotParts; part++) parts.push(await who.client.query(anyApi.ydoc.snapshot, { docId, gen: meta.snapshotSeq, part }));
      Y.applyUpdate(doc, new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p)))));
    }
    let cursor = meta?.snapshotSeq ?? 0;
    for (;;) {
      const rows = await who.client.query(anyApi.ydoc.updatesSince, { docId, afterSeq: cursor });
      if (!rows.length) break;
      for (const row of rows) { Y.applyUpdate(doc, new Uint8Array(row.update)); cursor = Math.max(cursor, row.seq); }
    }
    const result = { seq: meta?.seq ?? 0, page: doc.getXmlFragment("prosemirror").toString(), nml: JSON.stringify(doc.getMap("nml").toJSON()) };
    doc.destroy();
    return result;
  }

  const shown = (tab) => tab.$eval(EDITOR, (el) => el.textContent ?? "");
  const isServed = (tab) => tab.evaluate(() => Boolean(document.querySelector('[data-nml-served="true"]')));
  const progress = (tab) => tab.evaluate(() => window.e2e.progress());

  /** Start an import in its own tab; resolves once pass one has made every page and Notion is being read. */
  async function startImport(who, title, pages) {
    const tab = await openTab(who, "/__import", `${who.name} importer`);
    await tab.waitForFunction(() => window.e2e);
    await tab.evaluate(([t, p]) => window.e2e.start(t, p), [title, pages]);
    await until(() => tab.evaluate((id) => window.e2e.reading(id), pages[0][0]), Boolean);
    const { projectId } = await progress(tab);
    const rows = await who.client.query(anyApi.pages.listByProject, { projectId });
    const pageIds = Object.fromEntries(pages.map(([, pageTitle]) => [pageTitle, rows.find((row) => row.title === pageTitle)?._id]));
    const docIds = {};
    for (const [pageTitle, id] of Object.entries(pageIds)) docIds[pageTitle] = (await who.client.query(anyApi.pages.get, { pageId: id })).docId;
    return { tab, projectId, pageIds, docIds };
  }

  for (const [who, servedOwner] of [[await person("user_nina", "Nina Nml"), true], [await person("user_pat", "Pat Plain"), false]]) {
    const kind = servedOwner ? "served owner" : "ordinary owner";

    // ── 1. Pages opened while Notion is being read ───────────────────────
    console.log(`\n1. ${kind}: pages opened while the import is still reading Notion`);
    const one = await startImport(who, "Launch", [["n-brief", "Brief"], ["n-notes", "Notes"]]);
    check(`${kind}: pass one made both pages`, Object.values(one.pageIds).every(Boolean), true);
    // Brief is the new project's blank page, adopted; Notes was made for the import.
    const viewers = {};
    for (const title of ["Brief", "Notes"]) {
      viewers[title] = await openTab(who, `/p/${one.projectId}?page=${one.pageIds[title]}`, `${who.name} ${title}`);
      await viewers[title].waitForSelector(EDITOR);
    }
    await wait(3000);
    for (const title of ["Brief", "Notes"]) {
      check(`${kind}: opening ${title} wrote nothing to it`, (await stored(who, one.docIds[title])).seq, 0);
    }
    await one.tab.evaluate(() => window.e2e.answer("n-brief", "Brief words from Notion"));
    await until(() => one.tab.evaluate(() => window.e2e.reading("n-notes")), Boolean);
    await one.tab.evaluate(() => window.e2e.answer("n-notes", "Notes words from Notion"));
    const done = await until(() => progress(one.tab), (p) => p?.finished);
    check(`${kind}: the import reports both pages done`, done.pages.map((p) => [p.title, p.state]), [["Brief", "done"], ["Notes", "done"]]);
    for (const title of ["Brief", "Notes"]) {
      const words = `${title} words from Notion`;
      check(`${kind}: ${title} is stored with Notion's words`, (await stored(who, one.docIds[title])).page.includes(words), true);
      check(`${kind}: the open ${title} tab shows them as they land`, await until(() => shown(viewers[title]), (t) => t.includes(words)), words);
    }
    const fresh = await openTab(who, `/p/${one.projectId}?page=${one.pageIds.Notes}`, `${who.name} Notes again`);
    await fresh.waitForSelector(EDITOR);
    check(`${kind}: Notes opened afresh shows Notion's words`, await until(() => shown(fresh), (t) => t.includes("Notes words from Notion")), "Notes words from Notion");
    if (servedOwner) {
      // Filled, it migrates on its next open, as an imported page always has.
      check("served owner: Notes, reopened, migrates and is served", await until(() => isServed(fresh), Boolean, 20_000), true);
      check("served owner: the words are in canonical NML", await until(async () => (await stored(who, one.docIds.Notes)).nml.includes("Notes words from Notion"), Boolean), true);
      check("served owner: and on the served surface", await until(() => shown(fresh), (t) => t.includes("Notes words from Notion")), "Notes words from Notion");
    } else {
      check("ordinary owner: Notes stays on the ordinary editor", await isServed(fresh), false);
    }
    for (const tab of [one.tab, fresh, ...Object.values(viewers)]) await tab.close();

    // ── 2. A page typed on before it is filled ───────────────────────────
    console.log(`\n2. ${kind}: a page someone types on before the import fills it`);
    const two = await startImport(who, "Typed", [["n-draft", "Draft"]]);
    const typist = await openTab(who, `/p/${two.projectId}?page=${two.pageIds.Draft}`, `${who.name} Draft`);
    await typist.waitForSelector(EDITOR);
    await typist.locator(`${EDITOR} .bn-inline-content`).first().click();
    await typist.keyboard.type("My own words", { delay: 30 });
    check(`${kind}: the typing is saved`, await until(async () => (await stored(who, two.docIds.Draft)).page.includes("My own words"), Boolean), true);
    await two.tab.evaluate(() => window.e2e.answer("n-draft", "Draft words from Notion"));
    const after = await until(() => progress(two.tab), (p) => p?.finished);
    check(`${kind}: the import says the page failed, and why, and kept it`,
      after.pages.map((p) => [p.state, p.kept, p.error]),
      [["failed", true, "Someone wrote on this page before the import could fill it."]]);
    check(`${kind}: the project stays`, Boolean(await who.client.query(anyApi.projects.get, { projectId: two.projectId })), true);
    check(`${kind}: the page stays in the sidebar`, (await who.client.query(anyApi.pages.listByProject, { projectId: two.projectId })).map((p) => p.title), ["Draft"]);
    const kept = await stored(who, two.docIds.Draft);
    check(`${kind}: it holds the person's words, not the import's`, [kept.page.includes("My own words"), kept.page.includes("Draft words")], [true, false]);
    check(`${kind}: and the person's tab still shows them`, await shown(typist), "My own words");
    for (const tab of [two.tab, typist]) await tab.close();
  }

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
