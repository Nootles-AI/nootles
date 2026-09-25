/**
 * A link that runs out while someone is typing (NT-80), end to end: a REAL
 * Convex backend (a throwaway convex-local-backend, tests/fullstack-backend.mjs),
 * the REAL project stack `/p/<id>` renders (tests/link-expiry.fullstack.tsx),
 * and real keystrokes across the moment the link runs out.
 *
 * Olive owns two projects and hands Gus the editor link to each; Vic reads one
 * through the viewer link.
 *
 * - Its lapse armed (`share.lapse`, as `setLink` and the backfill schedule
 *   it): at the moment, with nothing else written, every query that answered
 *   through the link runs again — the project closes to Gus, every word he
 *   typed before it is on the server, and nothing is left retrying.
 * - No lapse armed (a link that ran out while its role query still showed
 *   the pen — one set before the lapse existed): the first refused flush
 *   locks the page, keeps what he typed on screen and says so, and nothing
 *   retries on its own — not even when Olive's next edit re-runs the page's
 *   reads for him, which now refuse him (the order CI found by timing, forced
 *   here). Let back in by a new link, "Try again" lands it.
 * - A reader's document changed locally, as the NML compatibility mirror
 *   repairs a projection: nothing is sent, and nothing is left "unsaved".
 *
 * Link dates are days long, so the harness moves one to seconds away through
 * the backend's own admin function (the dashboard's field edit) — the one
 * thing done around the app rather than through it.
 *
 *   npm run test:links:expiry
 *
 * Needs a convex-local-backend binary (see tests/fullstack-backend.mjs) and
 * system Chrome (`COMMENTS_BROWSER_CHANNEL=chromium` for Playwright's own).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { anyApi, makeFunctionReference } from "convex/server";
import { ConvexHttpClient } from "convex/browser";
import * as Y from "yjs";
import { bundleSurfaces, serveBundle, guardedTab, ledger, wait } from "./comments-surfaces.shared.mjs";
import { launchBrowser } from "./comments-launch.mjs";
import { startBackend } from "./fullstack-backend.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PEOPLE = {
  olive: { userId: "user_olive", name: "Olive Owner" },
  gus: { userId: "user_gus", name: "Gus Guest" },
  vic: { userId: "user_vic", name: "Vic Viewer" },
};
/** Every append the server turns down, as the Convex client logs it — before and after it carried a code. */
const REFUSED_APPEND = /M\(ydoc:append\)[\s\S]*(Uncaught Error: Not found|"code":"write_refused")/;
const NO_ACCESS = "You don’t have access to this project";
const HELD = "You can no longer edit this page";

const { failures, check, finish } = ledger();
let deployment, browser, bundleServer, work;
const watchdog = setTimeout(() => {
  console.error("link-expiry: no verdict after 8 minutes");
  process.exit(1);
}, 8 * 60_000);
watchdog.unref();

try {
  work = await mkdtemp(path.join(tmpdir(), "link-expiry-"));
  deployment = await startBackend({ name: "link-expiry" });
  const CONVEX_URL = deployment.url;
  const jwt = Object.fromEntries(Object.entries(PEOPLE).map(([key, who]) => [key, deployment.mint(who.userId, who.name)]));
  const as = (who) => deployment.client(jwt[who]);
  const admin = new ConvexHttpClient(CONVEX_URL);
  admin.setAdminAuth(deployment.adminKey);

  const readerFile = path.join(work, "reader.mjs");
  await build({
    absWorkingDir: repo, entryPoints: ["tests/comments-e2e.reader.ts"], bundle: true, format: "esm", platform: "node",
    outfile: readerFile, tsconfig: "tsconfig.json", logLevel: "warning",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  const reader = await import(pathToFileURL(readerFile).href);

  for (const who of Object.keys(PEOPLE)) {
    await as(who).mutation(anyApi.profiles.skip, {});
    await as(who).action(anyApi.identity.sync, {});
    for (const id of ["tester-note", "chat", "slash", "write"]) await as(who).mutation(anyApi.profiles.seen, { id });
  }
  const olive = as("olive");

  /** A project of Olive's, its one page, and Gus in through its editor link. */
  async function sharedWithGus(title) {
    const projectId = await olive.mutation(anyApi.projects.create, { title });
    const [page] = await olive.query(anyApi.pages.listByProject, { projectId });
    const token = await olive.mutation(anyApi.share.setLink, { projectId, role: "editor", enabled: true, expiresInDays: 1 });
    await as("gus").mutation(anyApi.share.claim, { token });
    return { projectId, docId: page.docId };
  }

  const table = async (name) =>
    (await admin.query(makeFunctionReference("_system/cli/tableData"), { table: name, order: "asc", paginationOpts: { numItems: 500, cursor: null } })).page;
  const patch = (name, ids, fields) => admin.mutation(makeFunctionReference("_system/frontend/patchDocumentsFields"), { table: name, ids, fields });

  /** The editor link, and Gus's claim through it, run out `inMs` from now. */
  async function runsOutIn(projectId, inMs, { arm }) {
    const at = Date.now() + inMs;
    const claim = (await table("shareClaims")).find((c) => c.projectId === projectId && c.granteeId === PEOPLE.gus.userId);
    await patch("projects", [projectId], { editShareExpiresAt: at });
    await patch("shareClaims", [claim._id], { expiresAt: at });
    // The backfill is how a date set around `setLink` gets its lapse: the same job.
    const armed = arm
      ? await admin.mutation(makeFunctionReference("migrations:armLinkLapses"), {}).then((r) => r.armed, (e) => `missing (${e.message.split("\n")[0]})`)
      : "not armed";
    console.log(`  … the editor link runs out at +${inMs}ms (lapse: ${armed})`);
    return at;
  }

  const output = path.join(work, "bundle");
  await bundleSurfaces("tests/link-expiry.fullstack.tsx", output, { probe: false });
  const served = await serveBundle(output);
  bundleServer = served.server;
  browser = await launchBrowser();

  async function open(who, projectId, docId) {
    const tab = await guardedTab(browser, { origin: served.origin, allow: [CONVEX_URL], label: who, failures, expected: REFUSED_APPEND });
    await tab.page.waitForFunction(() => typeof window.expiry?.mount === "function");
    await tab.page.evaluate((cfg) => window.expiry.mount(cfg), { url: CONVEX_URL, jwt: jwt[who], identity: PEOPLE[who], projectId });
    await tab.page.waitForSelector(".bn-editor", { timeout: 30_000 });
    await tab.page.waitForFunction((id) => window.expiry.held(id) !== null, docId, { timeout: 30_000 });
    return tab;
  }
  const refusedSince = (tab, from) => tab.expectedErrors.slice(from).length;
  const editable = (page) => page.$eval(".bn-editor", (el) => el.getAttribute("contenteditable")).catch(() => null);
  const says = (page, text) => page.evaluate((t) => document.body.textContent.includes(t), text);
  const stored = async (docId) => (await reader.storedBlocks(olive, docId)).map((b) => b.text).join(" ");

  /**
   * Gus types one word every 200ms until `until`, from the end of the page;
   * returns each word with when it was typed. `watch` runs after each word.
   */
  async function typeUntil(page, until, prefix, watch) {
    const typed = [];
    for (let i = 1; Date.now() < until; i++) {
      const word = `${prefix}${String(i).padStart(2, "0")}`;
      typed.push({ word, at: Date.now() });
      await page.keyboard.type(`${word} `);
      await watch?.();
      await wait(200);
    }
    return typed;
  }

  // ── A: the lapse armed ─────────────────────────────────────────────────────
  {
    console.log("\nA. the editor link runs out mid-typing, its lapse armed");
    const { projectId, docId } = await sharedWithGus("Autumn launch");
    const { page, expectedErrors, context } = await open("gus", projectId, docId);
    const gus = { page, expectedErrors };
    await page.click(".bn-editor");
    await wait(300);
    const at = await runsOutIn(projectId, 5000, { arm: true });
    let closedAt = null;
    const typed = await typeUntil(page, at + 4000, "a", async () => {
      if (closedAt === null && (await says(page, NO_ACCESS))) closedAt = Date.now();
    });
    const errorsAtClose = gus.expectedErrors.length;
    await wait(10_000);
    const text = await stored(docId);
    const before = typed.filter((t) => t.at < at - 1000).map((t) => t.word);
    check("[gus] typed words before the link ran out", before.length > 10, true);
    check("[server] every word typed a second or more before it ran out is on the page", before.filter((w) => !text.includes(w)), []);
    check("[gus] the project closes to him as it runs out (within 2s)", closedAt !== null && closedAt - at < 2000, true);
    check("[gus] …saying he no longer has access", await says(page, NO_ACCESS), true);
    check("[gus] nothing goes on retrying a refused change in the 10s after", refusedSince(gus, errorsAtClose), 0);
    await context.close();
  }

  // ── B: no lapse armed — the role still shows the pen ───────────────────────
  let reopened;
  {
    console.log("\nB. the editor link runs out mid-typing with no lapse armed");
    reopened = await sharedWithGus("Winter plan");
    const { projectId, docId } = reopened;
    const { page, expectedErrors, context } = await open("gus", projectId, docId);
    const gus = { page, expectedErrors };
    await page.click(".bn-editor");
    await wait(300);
    const at = await runsOutIn(projectId, 4000, { arm: false });
    let lockedAt = null;
    const typed = await typeUntil(page, at + 3000, "b", async () => {
      if (lockedAt === null && (await editable(page)) === "false") lockedAt = Date.now();
    });
    // Typed after the moment. The first of them is what the refused flush
    // carried; any typed once the page had locked went nowhere. So the held
    // ones are read off his screen rather than guessed from keystroke timing,
    // which a slow runner stretches.
    const typedAfter = typed.filter((t) => t.at > at).map((t) => t.word);
    const errorsAtLock = gus.expectedErrors.length;
    // Olive edits the page: every read of it Gus holds runs again, and refuses him.
    const edit = new Y.Doc();
    edit.getMap("olive").set("at", Date.now());
    const bytes = Y.encodeStateAsUpdate(edit);
    await olive.mutation(anyApi.ydoc.append, { docId, update: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    await wait(15_000);
    const onScreen = await page.$eval(".bn-editor", (el) => el.textContent);
    const afterAt = typedAfter.filter((w) => onScreen.includes(w));
    const text = await stored(docId);
    check("[gus] the page stops taking keystrokes within 2s of the first refused flush", lockedAt !== null && lockedAt - at < 2000, true);
    check("[gus] …and says his changes weren't saved", await says(page, HELD), true);
    check("[gus] what he typed after it ran out is still on his screen, to copy", afterAt.length > 0, true);
    check("[server] …and none of it reached the page", afterAt.filter((w) => text.includes(w)), []);
    check("[gus] leaving would warn: the tab holds unsaved changes", (await page.evaluate((id) => window.expiry.held(id), docId))?.unsynced, true);
    check("[gus] nothing retries on its own in the 15s after", refusedSince(gus, errorsAtLock), 0);

    // Asked to try again while still out: one more attempt, refused, and held.
    await page.getByRole("button", { name: "Try again" }).click();
    await wait(3000);
    check("[gus] \"Try again\" while still out tries once, and holds again", refusedSince(gus, errorsAtLock), 1);
    check("[gus] …the page still locked, and still saying so", [await editable(page), await says(page, HELD)], ["false", true]);

    // Olive turns the link on again — a new one, since the old ran out. That
    // write is what re-runs Gus's queries: the project closes to him.
    const token = await olive.mutation(anyApi.share.setLink, { projectId, role: "editor", enabled: true, expiresInDays: 7 });
    const closed = await page.waitForFunction((t) => document.body.textContent.includes(t), NO_ACCESS, { timeout: 5000 }).then(() => true, () => false);
    check("[gus] Olive's next write about the project closes it to him", closed, true);
    // He opens the new link in another tab: the project comes back, and the
    // page, mounting on the words it held, offers them once more.
    await as("gus").mutation(anyApi.share.claim, { token });
    const back = await page.waitForFunction(() => document.querySelector(".bn-editor")?.getAttribute("contenteditable") === "true", null, { timeout: 10_000 }).then(() => true, () => false);
    await wait(2000);
    const after = await stored(docId);
    check("[gus] let back in by the new link, he has the pen again", back, true);
    check("[server] …and every word he was held to lands", afterAt.filter((w) => !after.includes(w)), []);
    check("[gus] …and the notice goes", await says(page, HELD), false);
    await context.close();
  }

  // ── C: a reader's document, changed locally ───────────────────────────────
  {
    console.log("\nC. a reader's document changes locally");
    const { projectId, docId } = reopened;
    const token = await olive.mutation(anyApi.share.setLink, { projectId, role: "viewer", enabled: true, expiresInDays: null });
    await as("vic").mutation(anyApi.share.claim, { token });
    const { page, expectedErrors, context } = await open("vic", projectId, docId);
    const seqBefore = (await olive.query(anyApi.ydoc.meta, { docId })).seq;
    check("[vic] reads the page, without the pen", await editable(page), "false");
    await page.evaluate((id) => window.expiry.localChange(id), docId);
    await wait(8000);
    check("[vic] nothing he never typed is sent", expectedErrors.length, 0);
    check("[server] …the page's log is untouched", (await olive.query(anyApi.ydoc.meta, { docId })).seq, seqBefore);
    check("[vic] …and leaving would not warn of unsaved changes", (await page.evaluate((id) => window.expiry.held(id), docId))?.unsynced, false);
    check("[vic] …nor is he told his changes weren't saved", await says(page, HELD), false);
    await context.close();
  }

  check("the backend reached nothing outside it", deployment.outbound, []);
} catch (error) {
  failures.push(`run aborted: ${error.stack ?? error}`);
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  bundleServer?.close();
  await Promise.race([deployment?.close(), wait(5000)]);
  if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
}
finish();
