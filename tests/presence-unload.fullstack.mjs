/**
 * A tab that refreshes or closes, end to end (NT-137): a REAL Convex backend
 * (a throwaway convex-local-backend, tests/fullstack-backend.mjs), the REAL
 * provider, editor, caret layer and facepile (tests/presence-unload.fullstack.tsx),
 * and one browser context per person, signed in with tokens from the fake
 * issuer the backend trusts.
 *
 * The bug: `presence.leave` went over the websocket from `pagehide`, and the
 * browser closes that socket in the same moment, so the mutation never ran.
 * The refreshed tab came back under a new session id and drew its own old
 * caret as somebody else's; everyone else saw the person twice; a closed tab
 * left a ghost behind for everyone until its row went stale.
 *
 * Alice owns the page and Bob is in through its editor link. Everything they
 * do is a real click, keystroke, reload, navigation or tab close. What is
 * asserted is read off both screens (carets, awareness, facepile), and off the
 * `presence` table with admin auth.
 *
 * Nothing reaches a cloud deployment or a paid API: the backend is local, its
 * outbound fetches are refused (and fail the run), the AI keys are unset, and
 * every browser request outside the bundle and the backend fails the run.
 *
 *   npm run test:presence:unload
 *
 * Needs a convex-local-backend binary (see tests/fullstack-backend.mjs) and
 * system Chrome (`COMMENTS_BROWSER_CHANNEL=chromium` for Playwright's own).
 */
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Y from "yjs";
import { ConvexHttpClient } from "convex/browser";
import { anyApi, makeFunctionReference } from "convex/server";
import { bundleSurfaces, serveBundle, wait, ledger } from "./comments-surfaces.shared.mjs";
import { launchBrowser } from "./comments-launch.mjs";
import { startBackend } from "./fullstack-backend.mjs";

const { failures, check, finish } = ledger();
const PEOPLE = {
  alice: { userId: "user_alice", name: "Alice", color: "#cc3300" },
  bob: { userId: "user_bob", name: "Bob", color: "#3366cc" },
};

let deployment, browser, served, work, relay;
const watchdog = setTimeout(() => {
  console.error("presence-unload: watchdog fired after 6 minutes");
  process.exit(1);
}, 6 * 60_000);
watchdog.unref();

try {
  deployment = await startBackend({ name: "presence-unload" });
  const { url, siteUrl } = deployment;
  const jwt = Object.fromEntries(Object.entries(PEOPLE).map(([key, who]) => [key, deployment.mint(who.userId, who.name)]));
  const as = (who) => deployment.client(jwt[who]);
  const admin = new ConvexHttpClient(url);
  admin.setAdminAuth(deployment.adminKey);
  for (const who of Object.keys(PEOPLE)) {
    await as(who).mutation(anyApi.profiles.skip, {});
    await as(who).action(anyApi.identity.sync, {});
  }

  // A page of Alice's with a line in it, and Bob in through its editor link.
  const projectId = await as("alice").mutation(anyApi.projects.create, { title: "Shot list" });
  const [page] = await as("alice").query(anyApi.pages.listByProject, { projectId });
  const docId = page.docId;
  const token = await as("alice").mutation(anyApi.share.setLink, { projectId, role: "editor", enabled: true, expiresInDays: 1 });
  await as("bob").mutation(anyApi.share.claim, { token });
  {
    const doc = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("Opening shot over the harbour at dawn")]);
    doc.getXmlFragment("prosemirror").insert(0, [paragraph]);
    const update = Y.encodeStateAsUpdate(doc);
    await as("alice").mutation(anyApi.ydoc.init, { docId, update: update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength) });
  }

  /**
   * The deployment's HTTP site, behind a relay that counts the goodbyes it
   * carries — a request sent while its page unloads is invisible to
   * Playwright, so the count is taken where it lands.
   */
  const beacons = [];
  /** Set to swallow goodbyes: they are counted, answered, and never delivered. */
  let lose = false;
  relay = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (request.method === "POST" && request.url === "/presence/leave") {
        beacons.push({ body: JSON.parse(body.toString() || "null"), type: request.headers["content-type"] });
        if (lose) return void response.writeHead(204).end();
      }
      const target = new URL(siteUrl);
      const forward = httpRequest({ host: target.hostname, port: target.port, path: request.url, method: request.method, headers: { ...request.headers, host: target.host } }, (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      });
      forward.on("error", () => { response.statusCode = 502; response.end(); });
      forward.end(body);
    });
  });
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const site = `http://127.0.0.1:${relay.address().port}`;
  /** Waits briefly for `count` beacons to have landed, and takes them. */
  const landed = async (count) => {
    for (let i = 0; i < 20 && beacons.length < count; i++) await wait(50);
    return beacons.splice(0);
  };

  /** The presence table for this page, as the backend holds it. */
  const rows = async () => {
    const answer = await admin.query(makeFunctionReference("_system/cli/tableData"), {
      table: "presence", order: "asc", paginationOpts: { numItems: 100, cursor: null },
    });
    return answer.page.filter((row) => row.docId === docId).map((row) => ({ sessionId: row.sessionId, clientId: row.clientId, name: row.user.name }));
  };
  const names = async () => (await rows()).map((row) => row.name).sort();

  work = await mkdtemp(path.join(tmpdir(), "presence-unload-"));
  await bundleSurfaces("tests/presence-unload.fullstack.tsx", work, { probe: false });
  served = await serveBundle(work);
  const { origin } = served;
  browser = await launchBrowser();

  const address = (who) => {
    const p = PEOPLE[who];
    const query = new URLSearchParams({ url, site, jwt: jwt[who], doc: docId, user: p.userId, name: p.name, color: p.color });
    return `${origin}/?${query}`;
  };

  /**
   * A person's browser. Every request that is not the bundle or the backend
   * fails the run; requests to the backend are left unrouted, so a beacon
   * sent while the page unloads is the browser's own.
   */
  async function open(who, { storage } = {}) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    await context.route((target) => !target.href.startsWith(url) && !target.href.startsWith(site), (route) => {
      const target = route.request().url();
      if (target.startsWith(origin) || target.startsWith("data:")) return route.continue();
      failures.push(`[${who}] request left the fixture: ${target}`);
      return route.abort();
    });
    // "Duplicate tab": the new tab starts with a copy of the old one's sessionStorage.
    if (storage) {
      await context.addInitScript((entries) => {
        if (sessionStorage.getItem("__copied")) return;
        for (const [key, value] of Object.entries(entries)) sessionStorage.setItem(key, value);
        sessionStorage.setItem("__copied", "1");
      }, storage);
    }
    const tab = await context.newPage();
    watch(tab, who);
    await tab.goto(address(who), { waitUntil: "domcontentloaded" });
    await ready(tab, who);
    return { context, tab };
  }

  function watch(tab, who) {
    tab.on("pageerror", (error) => failures.push(`[${who}] page error: ${error.message}`));
    tab.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (/Download the React DevTools/.test(text)) return;
      failures.push(`[${who}] console error: ${text}`);
    });
  }

  async function ready(tab, who) {
    await tab.waitForFunction(() => window.presenceTab?.ready(), null, { timeout: 20_000 }).catch(() => {
      throw new Error(`${who}'s editor never mounted`);
    });
  }

  /** Puts the caret at the end of the line — a person clicking into the page. */
  async function placeCaret(tab) {
    await tab.click(".bn-editor .bn-block-content", { position: { x: 5, y: 5 } });
    await tab.keyboard.press("End");
  }

  const carets = (tab) => tab.evaluate(() => window.presenceTab.carets());
  const remote = (tab) => tab.evaluate(() => window.presenceTab.remote());
  const self = (tab) => tab.evaluate(() => window.presenceTab.self());
  const pile = (tab) => tab.evaluate(() => window.presenceTab.pile());
  const until = (tab, fn, arg, timeout = 8000) => tab.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
  const untilRows = async (test, timeout = 8000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const now = await rows();
      if (test(now)) return now;
      if (Date.now() > end) return now;
      await wait(100);
    }
  };

  /**
   * Samples `tab`'s screen every 100ms for `ms`, returning every distinct
   * thing it showed — so a ghost that flickers in and out cannot slip past.
   */
  async function sample(tab, ms, read = () => window.presenceTab.carets().slice().sort()) {
    const shown = new Set();
    const end = Date.now() + ms;
    while (Date.now() < end) {
      shown.add(JSON.stringify(await tab.evaluate(read)));
      await wait(100);
    }
    return [...shown].map((s) => JSON.parse(s));
  }

  // --- both on the page ---------------------------------------------------
  console.log("\nAlice and Bob on the page");
  let alice = await open("alice");
  const bob = await open("bob");
  await placeCaret(alice.tab);
  await placeCaret(bob.tab);
  check("Bob sees Alice's caret", await until(bob.tab, () => window.presenceTab.carets().join() === "Alice"), true);
  check("Alice sees Bob's caret", await until(alice.tab, () => window.presenceTab.carets().join() === "Bob"), true);
  check("Bob's facepile shows Alice", await until(bob.tab, () => window.presenceTab.pile().join() === "Alice"), true);
  check("one row each", await names(), ["Alice", "Bob"]);

  // --- Alice refreshes ----------------------------------------------------
  console.log("\nAlice refreshes the page");
  const before = await self(alice.tab);
  beacons.length = 0;
  const watching = sample(bob.tab, 6000);
  await alice.tab.reload({ waitUntil: "domcontentloaded" });
  const right = await untilRows((now) => !now.some((row) => row.clientId === before.clientId), 1500);
  check("her old row is gone as the page goes", right.some((row) => row.clientId === before.clientId), false);
  check("the goodbye went by beacon, as text/plain, naming the incarnation that left",
    await landed(1), [{ body: { docId, sessionId: before.sessionId, clientId: before.clientId }, type: "text/plain;charset=UTF-8" }]);
  await ready(alice.tab, "alice");
  const after = await self(alice.tab);
  check("the refreshed page kept her session", after.sessionId, before.sessionId);
  check("and is a new client", after.clientId !== before.clientId, true);
  check("the handover was taken, so nothing waits in her tab's storage",
    Object.keys(await alice.tab.evaluate(() => window.presenceTab.session())).filter((k) => k.startsWith("nootles:presence")), []);
  const aliceSaw = await sample(alice.tab, 3000, () => window.presenceTab.remote().map((r) => r.name).sort());
  check("Alice's refreshed tab never holds herself as a collaborator", aliceSaw.every((seen) => !seen.includes("Alice")), true);
  check("and draws only Bob's caret", await carets(alice.tab), ["Bob"]);
  await placeCaret(alice.tab);
  const bobSaw = await watching;
  check("Bob never sees Alice twice", bobSaw.every((seen) => seen.filter((n) => n === "Alice").length <= 1), true);
  check("Bob sees her caret back once she clicks in", await until(bob.tab, () => window.presenceTab.carets().join() === "Alice"), true);
  check("Bob's awareness holds one Alice, her new client",
    (await remote(bob.tab)).map((r) => [r.name, r.clientId]), [["Alice", after.clientId]]);
  check("the table holds one row each", await names(), ["Alice", "Bob"]);
  check("Bob's facepile shows Alice once", await pile(bob.tab), ["Alice"]);

  // --- Alice refreshes with the beacon lost -------------------------------
  console.log("\nAlice refreshes again, and her goodbye is lost");
  const lostFrom = await self(alice.tab);
  beacons.length = 0;
  lose = true;
  // Bob's view of Alice is cleared the moment the old row stops being live, so
  // what matters for him is that he never sees two of her.
  const watchingLost = sample(bob.tab, 5000);
  await alice.tab.reload({ waitUntil: "domcontentloaded" });
  await ready(alice.tab, "alice");
  const lostTo = await self(alice.tab);
  check("the refreshed page still kept her session", lostTo.sessionId, lostFrom.sessionId);
  check("its beacon was sent and lost", (await landed(1)).map((b) => b.body.clientId), [lostFrom.clientId]);
  const lostSaw = await sample(alice.tab, 3000, () => window.presenceTab.remote().map((r) => r.name).sort());
  check("without the beacon, her tab still never shows her own old caret",
    lostSaw.every((seen) => !seen.includes("Alice")), true);
  check("and her heartbeat took over the old row", (await untilRows((now) => !now.some((r) => r.clientId === lostFrom.clientId)))
    .filter((r) => r.name === "Alice").map((r) => [r.sessionId, r.clientId]), [[lostTo.sessionId, lostTo.clientId]]);
  check("Bob never saw Alice twice", (await watchingLost).every((seen) => seen.filter((n) => n === "Alice").length <= 1), true);
  lose = false;
  await placeCaret(alice.tab);
  check("Bob sees her again", await until(bob.tab, () => window.presenceTab.carets().join() === "Alice"), true);

  // --- Alice duplicates the tab -------------------------------------------
  console.log("\nAlice duplicates the tab");
  const original = await self(alice.tab);
  const copied = await alice.tab.evaluate(() => window.presenceTab.session());
  const twin = await open("alice", { storage: copied });
  beacons.length = 0;
  const twinSelf = await self(twin.tab);
  check("the duplicate is a session of its own", twinSelf.sessionId !== original.sessionId, true);
  await placeCaret(twin.tab);
  check("Bob sees both of Alice's tabs — two real carets",
    await until(bob.tab, () => window.presenceTab.carets().filter((n) => n === "Alice").length === 2), true);
  check("each of Alice's tabs sees the other and Bob",
    [(await remote(alice.tab)).map((r) => r.name).sort(), (await remote(twin.tab)).map((r) => r.name).sort()],
    [["Alice", "Bob"], ["Alice", "Bob"]]);
  check("three rows", await names(), ["Alice", "Alice", "Bob"]);
  await twin.tab.close({ runBeforeUnload: true });
  await twin.context.close();
  check("the duplicate's goodbye names its own session", (await landed(1)).map((b) => b.body.sessionId), [twinSelf.sessionId]);
  check("closing the duplicate takes its caret down for Bob",
    await until(bob.tab, () => window.presenceTab.carets().filter((n) => n === "Alice").length === 1, null, 3000), true);
  check("and its row", (await untilRows((now) => now.length === 2, 3000)).map((r) => r.sessionId).includes(twinSelf.sessionId), false);

  // --- Alice leaves in-app ------------------------------------------------
  console.log("\nAlice leaves the page in-app (the websocket goodbye)");
  const inApp = await self(alice.tab);
  beacons.length = 0;
  await alice.tab.evaluate(() => window.presenceTab.unmount());
  check("her row is gone", (await untilRows((now) => !now.some((r) => r.sessionId === inApp.sessionId), 3000)).some((r) => r.sessionId === inApp.sessionId), false);
  check("Bob's screen lets her go", await until(bob.tab, () => window.presenceTab.carets().length === 0, null, 3000), true);
  check("no beacon for an in-app leave", await landed(0), []);
  await alice.tab.reload({ waitUntil: "domcontentloaded" });
  await ready(alice.tab, "alice");
  await placeCaret(alice.tab);
  check("Alice comes back", await until(bob.tab, () => window.presenceTab.carets().join() === "Alice"), true);

  // --- Alice navigates away -----------------------------------------------
  console.log("\nAlice navigates away");
  const away = await self(alice.tab);
  beacons.length = 0;
  await alice.tab.goto("data:text/html,<p>elsewhere</p>", { waitUntil: "domcontentloaded" });
  check("her row is gone at once", (await untilRows((now) => !now.some((r) => r.sessionId === away.sessionId), 1500)).some((r) => r.sessionId === away.sessionId), false);
  check("by beacon", (await landed(1)).map((b) => b.body.sessionId), [away.sessionId]);
  check("Bob's caret layer lets her go", await until(bob.tab, () => window.presenceTab.carets().length === 0, null, 2000), true);
  check("and his facepile", await until(bob.tab, () => window.presenceTab.pile().length === 0, null, 2000), true);
  await alice.tab.goto(address("alice"), { waitUntil: "domcontentloaded" });
  await ready(alice.tab, "alice");
  await placeCaret(alice.tab);
  check("Alice comes back", await until(bob.tab, () => window.presenceTab.carets().join() === "Alice"), true);

  // --- Alice closes the tab -----------------------------------------------
  console.log("\nAlice closes the tab");
  const closing = await self(alice.tab);
  beacons.length = 0;
  await alice.tab.close({ runBeforeUnload: true });
  check("her row is gone at once", (await untilRows((now) => !now.some((r) => r.sessionId === closing.sessionId), 1500)).some((r) => r.sessionId === closing.sessionId), false);
  check("by beacon", (await landed(1)).map((b) => b.body.sessionId), [closing.sessionId]);
  check("Bob's caret layer lets her go within a beat", await until(bob.tab, () => window.presenceTab.carets().length === 0, null, 2000), true);
  check("and his awareness", await remote(bob.tab), []);
  check("and his facepile", await until(bob.tab, () => window.presenceTab.pile().length === 0, null, 2000), true);
  check("only Bob is left in the table", await names(), ["Bob"]);
  await alice.context.close();

  // --- a stranger's beacon ------------------------------------------------
  console.log("\nA beacon naming somebody else's row");
  const bobRow = (await rows()).find((r) => r.name === "Bob");
  const forged = await fetch(`${siteUrl}/presence/leave`, { method: "POST", body: JSON.stringify({ docId, sessionId: "guessed", clientId: bobRow.clientId }) });
  check("a wrong session id is answered and changes nothing", [forged.status, await names()], [204, ["Bob"]]);
  const stale = await fetch(`${siteUrl}/presence/leave`, { method: "POST", body: JSON.stringify({ docId, sessionId: bobRow.sessionId, clientId: bobRow.clientId + 1 }) });
  check("Bob's session with another client id changes nothing", [stale.status, await names()], [204, ["Bob"]]);
  check("garbage is refused", (await fetch(`${siteUrl}/presence/leave`, { method: "POST", body: "{" })).status, 400);
  check("no outbound fetch from the backend", deployment.outbound, []);
} catch (error) {
  failures.push(`run stopped: ${error.stack ?? error.message}`);
  console.log(`  FAIL run stopped: ${error.message}`);
} finally {
  await browser?.close().catch(() => {});
  served?.server.close();
  relay?.close();
  await deployment?.close();
  if (work) await rm(work, { recursive: true, force: true });
}
finish();
