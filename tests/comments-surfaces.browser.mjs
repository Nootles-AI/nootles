/**
 * Who may do what to a page and its comments, driven like a person would —
 * real Chromium clicks, double-clicks, drags and keys — through the real
 * workspace and the real share route (docs/commenting-plan.md §5, §6).
 *
 * One fresh tab per visitor: the owner, an editor, a commenter, a viewer, an
 * operator standing in for the commenter, and a signed-out guest on a comment
 * link. For each, the harness asserts:
 *
 * - the page: whether a keystroke, a `/`, a drag handle, the page's tools, the
 *   title and the chat reach it, and that a reader's tab never so much as
 *   attempts a write to the page's document;
 * - selection: that words can be selected in the read-only page too, and what
 *   `useCommentableSelection` offers for them — a thread (owner, editor,
 *   commenter), the sign-in door (the guest), nothing (viewer, stand-in);
 * - comments: who reads the threads, who starts one, and that the signed-out
 *   visitor's tab never asks for the comments at all;
 * - undo: ⌘Z on a comment card undoes the last comment action and never the
 *   document; ⌘Z in the document undoes the document and never a comment,
 *   even a newer one; ⌘Z typing in a comment composer is the browser's own.
 *
 * See tests/comments-surfaces.shared.mjs for the bundle and the fixtures;
 * Convex is a stand-in (tests/comments-surfaces.browser.tsx) reached through
 * the real `convex/react` and `YConvexProvider`s. No app server, no Convex, no
 * API keys; every off-origin request fails the run, a writer's ambient AI
 * lanes are aborted in the tab (a reader must wake none), and the WebSocket is
 * inert.
 *
 *   node tests/comments-surfaces.browser.mjs
 *
 * Uses system Chrome (`channel: "chrome"`); `COMMENTS_BROWSER_CHANNEL=chromium`
 * or `COMMENTS_CHROME_PATH` picks another.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bundleSurfaces, serveBundle, ledger, guardedTab, lanesCheck, probe, threadCount, docText, domSelection,
  lastKeyClaimed, waitFor, wait, wordBox, doubleClickWord, dragSelect, clickEndOf, clickCard, startThread, UNDO, REDO,
} from "./comments-surfaces.shared.mjs";
import { launchBrowser } from "./comments-launch.mjs";

for (const key of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "MISTRAL_API_KEY", "RECRAFT_API_KEY"]) {
  delete process.env[key];
}

const output = await mkdtemp(path.join(tmpdir(), "comments-surfaces-"));
await bundleSurfaces("tests/comments-surfaces.browser.tsx", output);
const { origin, server } = await serveBundle(output);
const { failures, check, finish } = ledger();

let browser;
try {
  browser = await launchBrowser();

  /** A fresh guarded tab with the visitor's surface mounted and settled. */
  async function open(visitor, options = {}) {
    const tab = await guardedTab(browser, { origin, inert: true, label: visitor, failures });
    await tab.page.waitForFunction(() => !!window.surfaces);
    await tab.page.evaluate(([v, o]) => window.surfaces.mount(v, o), [visitor, options]);
    await tab.page.waitForSelector(".bn-editor [data-id='p_ship']", { timeout: 15000 });
    await tab.page.waitForSelector("#probe[data-status]");
    return tab;
  }

  const calls = (page) => page.evaluate(() => window.surfaces.calls());
  const pageWrites = async (page) => (await calls(page)).filter((c) => c.kind === "mutation" && c.name === "ydoc:append" && c.docId === "page-doc-1");
  const refused = async (page) => (await calls(page)).filter((c) => c.refused);
  const start = (page, blockId, word, body) => startThread(page, { blockId, word, body, lastBlockId: "p_second" });

  const surfaceChecks = async (page, visitor, { writes }) => {
    check(`[${visitor}] the document ${writes ? "is" : "is not"} editable`, await page.$eval(".bn-editor", (el) => el.getAttribute("contenteditable")), writes ? "true" : "false");
    check(`[${visitor}] the page's tools ${writes ? "are" : "are not"} out`, (await page.$$('[role="toolbar"][aria-label="Page tools"]')).length > 0, writes);
    check(`[${visitor}] the title ${writes ? "is" : "is not"} editable`, (await page.$$('[aria-label="Page title"]')).length > 0, writes);
    check(`[${visitor}] the chat ${writes ? "is" : "is not"} there to edit pages with`, (await page.$$('[aria-label="Chat"]')).length > 0, writes);
  };

  const typingChecks = async (page, visitor, { writes }) => {
    const before = await docText(page);
    await clickEndOf(page, "p_ship");
    await page.keyboard.type(" zq");
    await wait(150);
    const after = await docText(page);
    check(`[${visitor}] typing ${writes ? "reaches" : "does not reach"} the page`, after.includes(" zq"), writes);
    if (!writes) check(`[${visitor}] the page reads as it did`, after, before);
    await page.keyboard.type("/");
    await wait(250);
    check(`[${visitor}] "/" ${writes ? "opens" : "opens no"} slash menu`, (await page.$$("#bn-suggestion-menu")).length > 0, writes);
    await page.keyboard.press("Escape");
    if (writes) {
      await page.keyboard.press("Backspace");
      await wait(100);
    }
    // A hover over the block is where a drag handle would appear.
    const box = await wordBox(page, "p_ship", "Ship");
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await wait(250);
    check(`[${visitor}] a hovered block ${writes ? "offers" : "offers no"} drag handle`, (await page.$$(".bn-side-menu, [aria-label='Drag to move'], .nt-side-menu")).length > 0, writes);
  };

  const selectionChecks = async (page, visitor, expected) => {
    await doubleClickWord(page, "p_ship", "Friday");
    check(`[${visitor}] a double-click selects a word`, await domSelection(page), "Friday");
    check(`[${visitor}] the selection offers ${expected ? expected : "nothing"}`, (await probe(page)).selection,
      expected ? { kind: expected, exact: "Friday", blockId: "p_ship", prefix: "Ship it by " } : null);
    await dragSelect(page, "p_second", "second", "paragraph");
    check(`[${visitor}] a drag selects a phrase`, await domSelection(page), "second paragraph");
    const dragged = (await probe(page)).selection;
    check(`[${visitor}] …and the phrase is ${expected ? "offered, anchored in its own block" : "not offered"}`,
      dragged && { kind: dragged.kind, exact: dragged.exact, blockId: dragged.blockId },
      expected ? { kind: expected, exact: "second paragraph", blockId: "p_second" } : null);
    await clickCard(page);
    check(`[${visitor}] letting go of the words withdraws the offer`, (await probe(page)).selection, null);
  };

  const noPageWrite = async (page, visitor) => {
    check(`[${visitor}] never attempts a write to the page's document`, (await pageWrites(page)).length, 0);
  };
  const nothingRefused = async (page, visitor) => {
    check(`[${visitor}] nothing it attempted was refused by the gate`, await refused(page), []);
  };

  // ---------------------------------------------------------------- owner
  {
    console.log("\nthe owner");
    const { page, context, lanes } = await open("owner");
    await surfaceChecks(page, "owner", { writes: true });
    await typingChecks(page, "owner", { writes: true });
    check("[owner] typed words reach the stored page", await waitFor(page, () => window.surfaces.storedPageText().includes("zq")), true);
    check("[owner] comments: reads and writes, no document yet", await probe(page).then((p) => [p.status, p.canRead, p.canComment, p.store]), ["absent", true, true, false]);
    await selectionChecks(page, "owner", "comment");

    console.log("\n  ⌘Z: the document and the comments are two timelines");
    await start(page, "p_ship", "Friday", "Is Friday real?");
    check("[owner] the first comment mints the comments document and lands", await waitFor(page, () => window.surfaces.storedThreads().length === 1), true);
    check("[owner] the thread, as the card reads it", (await probe(page)).threads.map((t) => [t.exact, t.comments]), [["Friday", 1]]);
    check("[owner] with its history beside its store", await probe(page).then((p) => [p.status, p.store, p.history]), ["ready", true, true]);

    // The comment is newer than the typing; ⌘Z in the document still takes the typing.
    await clickEndOf(page, "p_ship");
    await page.keyboard.press(UNDO);
    await wait(200);
    check("[owner] ⌘Z in the document undoes the document's newest edit", (await docText(page)).includes("zq"), false);
    check("[owner] …and not the newer comment", await threadCount(page), 1);
    check("[owner] the spine claimed the press", await lastKeyClaimed(page), true);

    await page.keyboard.press(REDO);
    await wait(200);
    check("[owner] ⌘⇧Z in the document redoes it", (await docText(page)).includes("zq"), true);

    await clickCard(page);
    check("[owner] a click on the card puts focus in the comment surface", await page.evaluate(() => document.activeElement?.id), "comment-card");
    await page.keyboard.press(UNDO);
    check("[owner] ⌘Z on the card undoes the comment", await waitFor(page, () => JSON.parse(document.querySelector("#probe").dataset.threads).length === 0), true);
    check("[owner] …everywhere it is stored", await waitFor(page, () => window.surfaces.storedThreads().length === 0), true);
    check("[owner] …and leaves the document's edit standing", (await docText(page)).includes("zq"), true);
    await page.keyboard.press(UNDO);
    await wait(200);
    check("[owner] a second ⌘Z on the card has no older comment to take, and still leaves the document", (await docText(page)).includes("zq"), true);
    check("[owner] the card claimed the press rather than let it through", await lastKeyClaimed(page), true);
    await page.keyboard.press(REDO);
    check("[owner] ⌘⇧Z on the card brings the comment back", await waitFor(page, () => JSON.parse(document.querySelector("#probe").dataset.threads).length === 1), true);

    console.log("\n  ⌘Z typing a comment is the browser's own");
    await page.click("#comment-body");
    await page.keyboard.type("draft words");
    await page.keyboard.press(UNDO);
    await wait(150);
    check("[owner] the composer's ⌘Z is left to the browser", await lastKeyClaimed(page), false);
    check("[owner] …which takes back the typing", await page.$eval("#comment-body", (el) => el.value.includes("draft words")), false);
    check("[owner] …and no comment", await threadCount(page), 1);
    check("[owner] …and not the document", (await docText(page)).includes("zq"), true);

    await nothingRefused(page, "owner");
    lanesCheck(check, "owner", lanes, { writes: true });
    await context.close();
  }

  // ---------------------------------------------------------------- editor
  {
    console.log("\nan editor");
    const { page, context, lanes } = await open("editor", { seedThread: true });
    await surfaceChecks(page, "editor", { writes: true });
    await typingChecks(page, "editor", { writes: true });
    check("[editor] reads the existing thread", (await probe(page)).threads, [{ id: "thread_seed", exact: "second", comments: 1 }]);
    await selectionChecks(page, "editor", "comment");
    await start(page, "p_ship", "tests", "Which tests?");
    check("[editor] starts a thread on the existing document", await waitFor(page, () => window.surfaces.storedThreads().length === 2), true);
    await clickCard(page);
    await page.keyboard.press(UNDO);
    check("[editor] ⌘Z on the card takes back only their own comment", await waitFor(page, () => window.surfaces.storedThreads().map((t) => t.id).join() === "thread_seed"), true);
    await nothingRefused(page, "editor");
    lanesCheck(check, "editor", lanes, { writes: true });
    await context.close();
  }

  // ---------------------------------------------------------------- commenter
  {
    console.log("\na commenter");
    const { page, context, lanes } = await open("commenter", { seedThread: true });
    await surfaceChecks(page, "commenter", { writes: false });
    await typingChecks(page, "commenter", { writes: false });
    check("[commenter] comments: reads and writes", await probe(page).then((p) => [p.status, p.canRead, p.canComment, p.store, p.history]), ["ready", true, true, true, true]);
    check("[commenter] reads the owner's thread", (await probe(page)).threads, [{ id: "thread_seed", exact: "second", comments: 1 }]);
    await selectionChecks(page, "commenter", "comment");

    await start(page, "p_ship", "Friday", "Friday is ambitious");
    check("[commenter] starts a thread without the pen", await waitFor(page, () => window.surfaces.storedThreads().length === 2), true);
    check("[commenter] the thread is on the words they selected", (await probe(page)).threads.map((t) => t.exact), ["second", "Friday"]);

    await clickEndOf(page, "p_ship");
    await page.keyboard.press(UNDO);
    await wait(200);
    check("[commenter] ⌘Z in the (read-only) document does not reach the comment", await threadCount(page), 2);
    await clickCard(page);
    await page.keyboard.press(UNDO);
    check("[commenter] ⌘Z on the card undoes their comment", await waitFor(page, () => window.surfaces.storedThreads().length === 1), true);
    check("[commenter] …and never someone else's", (await probe(page)).threads.map((t) => t.id), ["thread_seed"]);
    await page.keyboard.press(REDO);
    check("[commenter] ⌘⇧Z brings it back", await waitFor(page, () => window.surfaces.storedThreads().length === 2), true);

    check("[commenter] the page is unchanged in storage", await page.evaluate(() => window.surfaces.storedPageText()), "Ship it by Friday if the tests pass. A second paragraph to read.");
    await noPageWrite(page, "commenter");
    check("[commenter] every write went to the comments document", [...new Set((await calls(page)).filter((c) => c.name === "ydoc:append").map((c) => c.docId))], ["comments-doc-1"]);
    await nothingRefused(page, "commenter");
    lanesCheck(check, "commenter", lanes, { writes: false });
    await context.close();
  }

  // ---------------------------------------------------------------- viewer and stand-in
  for (const visitor of ["viewer", "standIn"]) {
    console.log(visitor === "viewer" ? "\na viewer" : "\nan operator standing in for the commenter");
    const { page, context, lanes } = await open(visitor, { seedThread: true });
    await surfaceChecks(page, visitor, { writes: false });
    await typingChecks(page, visitor, { writes: false });
    check(`[${visitor}] comments: reads, never writes`, await probe(page).then((p) => [p.status, p.canRead, p.canComment, p.store, p.history]), ["ready", true, false, false, false]);
    check(`[${visitor}] reads the thread`, (await probe(page)).threads, [{ id: "thread_seed", exact: "second", comments: 1 }]);
    await selectionChecks(page, visitor, null);

    await doubleClickWord(page, "p_ship", "Friday");
    await page.click("#comment-start");
    await wait(200);
    check(`[${visitor}] a reach for Comment starts nothing`, (await probe(page)).threads.length, 1);
    check(`[${visitor}] …and asks the server for nothing`, (await calls(page)).filter((c) => c.kind === "mutation" && (c.name === "comments:ensureDoc" || c.name === "ydoc:append")).length, 0);

    await clickCard(page);
    await page.keyboard.press(UNDO);
    await wait(150);
    check(`[${visitor}] ⌘Z on a card is claimed and changes nothing`, [await lastKeyClaimed(page), await threadCount(page)], [true, 1]);
    await noPageWrite(page, visitor);
    await nothingRefused(page, visitor);
    lanesCheck(check, visitor, lanes, { writes: false });
    await context.close();
  }

  // ---------------------------------------------------------------- guest
  {
    console.log("\na signed-out guest on a comment link");
    const { page, context, lanes } = await open("guest", { seedThread: true });
    const askedForComments = async () => (await calls(page)).filter((c) => c.name === "comments:docFor" || c.docId === "comments-doc-1").length;
    check("[guest] the document is not editable", await page.$eval(".bn-editor", (el) => el.getAttribute("contenteditable")), "false");
    check("[guest] comments: none to read, the sign-in door to offer", await probe(page).then((p) => [p.status, p.canRead, p.canComment, p.signIn, p.threads]), ["absent", false, false, true, []]);
    check("[guest] the tab never asks for the comments", await askedForComments(), 0);
    await selectionChecks(page, "guest", "signIn");
    await doubleClickWord(page, "p_ship", "Friday");
    check("[guest] the card offers to sign in", await page.textContent("#comment-start"), "Sign in to comment");
    await page.click("#comment-start");
    check("[guest] which opens the sign-in door, on commenting's behalf", await waitFor(page, () => [...document.querySelectorAll('[role="dialog"]')].some((d) => d.textContent.includes("Sign in to comment"))), true);
    check("[guest] still no document written, and none minted", (await calls(page)).filter((c) => c.kind === "mutation" && (c.name === "ydoc:append" || c.name === "comments:ensureDoc")).length, 0);
    check("[guest] still never asked for the comments", await askedForComments(), 0);
    lanesCheck(check, "guest", lanes, { writes: false });
    await context.close();
  }
} finally {
  await browser?.close();
  server.close();
}

finish();
