/**
 * The comment UI, used the way two people would use it (docs/commenting-plan.md
 * §1, §7): Ada, an editor, and Cam, a commenter, each in their own browser,
 * on one page, with real Chromium drags, clicks and keys.
 *
 * What it covers: starting a thread from the formatting toolbar, from the
 * read-only page's floating button and from ⌘⌥M; @-mentioning someone and
 * the notice that follows; the card appearing level with its paragraph for
 * both people, with its highlight; replying, resolving (the card leaves both
 * margins for the panel's Resolved section) and reopening — by replying, as in
 * Docs, or with Reopen; editing and
 * deleting one's own comment; deleting a thread; ⌘Z on a card; Escape;
 * nearby threads stacking without overlap and the focused one taking its own
 * place; a narrow window's dots and panel; `?thread=` opening a thread and
 * leaving the address; a deleted phrase's thread under "No longer in the
 * document" and back again on undo; a mention of someone who cannot open the
 * project, refused before and after writing; a comment the assistant wrote,
 * marked as such; a signed-out guest offered "Sign in to comment"; and typing
 * two hundred characters with twenty open threads re-rendering no card.
 *
 * The page is the REAL workspace and editor (tests/comments-ui.browser.tsx);
 * Convex is a stand-in shared by both tabs through this runner, which relays
 * every accepted Yjs update to the other tab. No app server, no Convex, no
 * API keys: every off-origin request fails the run, the ambient AI lanes a
 * writer's typing wakes are aborted in the tab, and the WebSocket is inert.
 * Screenshots land in tests/.artifacts/comments-ui/.
 *
 *   node tests/comments-ui.browser.mjs
 *
 * Uses system Chrome (`channel: "chrome"`); `COMMENTS_BROWSER_CHANNEL=chromium`
 * or `COMMENTS_CHROME_PATH` picks another.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bundleSurfaces, serveBundle, ledger, guardedTab, waitFor, wait, wordBox, doubleClickWord, dragSelect, clickEndOf, UNDO,
} from "./comments-surfaces.shared.mjs";
import { launchBrowser } from "./comments-launch.mjs";

for (const key of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "MISTRAL_API_KEY", "RECRAFT_API_KEY"]) {
  delete process.env[key];
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = path.join(repo, "tests", ".artifacts", "comments-ui");
await mkdir(shots, { recursive: true });

/** `source` with `from` replaced — or the run stops, rather than count nothing. */
function swap(source, from, to) {
  if (!source.includes(from)) throw new Error(`The harness's rewrite no longer matches: ${from}`);
  return source.replace(from, to);
}

const output = await mkdtemp(path.join(tmpdir(), "comments-ui-"));
await bundleSurfaces("tests/comments-ui.browser.tsx", output, {
  probe: false,
  rewrite: {
    // The age clock re-renders every card twice a minute by design; stopped
    // here, so the typing check counts what typing costs and nothing else.
    "app/components/comments/CommentsLayer.tsx": (source) =>
      swap(source, "setInterval(() => setNow(Date.now()), 30_000)", "setInterval(() => setNow(Date.now()), 3_600_000)"),
    // Counts every render of a thread card, from inside it, for the typing check.
    "app/components/comments/ThreadCard.tsx": (source) =>
      swap(
        source,
        "const [editing, setEditing] = useState<string | null>(null);",
        "globalThis.__cardRenders = (globalThis.__cardRenders ?? 0) + 1;\n  const [editing, setEditing] = useState<string | null>(null);",
      ),
  },
});
const { origin, server } = await serveBundle(output);
const { failures, check, finish } = ledger();

/** The stand-in server both tabs share: every document's accepted updates, in order. */
const logs = {};
let commentsDocId = null;
const notices = [];
const relays = [];
const tabs = new Map();

async function broadcast(from, fn, args) {
  for (const [name, tab] of tabs) {
    if (name === from) continue;
    await tab.page.evaluate(fn, args).catch(() => {});
  }
}

let browser;
try {
  browser = await launchBrowser();

  async function open(name, visitor, { query = "", viewport = { width: 1440, height: 900 } } = {}) {
    const tab = await guardedTab(browser, { origin, inert: true, label: name, failures });
    await tab.page.setViewportSize(viewport);
    const context = tab.context;
    await context.exposeBinding("uiFetch", () => ({ logs: structuredClone(logs), commentsDocId }));
    await context.exposeBinding("uiRelay", async (_source, docId, update) => {
      (logs[docId] ??= []).push(update);
      relays.push({ at: Date.now(), from: name, docId });
      await broadcast(name, ([d, u]) => window.ui.receive(d, u), [docId, update]);
    });
    await context.exposeBinding("uiEnsure", async (_source, birth) => {
      if (!commentsDocId) {
        commentsDocId = "comments-doc-1";
        logs[commentsDocId] = [birth];
        await broadcast(name, ([d, b]) => window.ui.minted(d, b), [commentsDocId, birth]);
      }
      return { docId: commentsDocId, birth: logs[commentsDocId][0] };
    });
    await context.exposeBinding("uiNotice", (_source, who, fn, args) => {
      notices.push({ who, fn, ...args });
      if (fn === "commentNotices:event") {
        const refused = (args.mentions ?? []).filter((id) => id === "user_dee");
        return refused.length ? { refused } : {};
      }
      return {};
    });
    if (query) await tab.page.goto(`${origin}/${query}`, { waitUntil: "domcontentloaded" });
    else await tab.page.reload({ waitUntil: "domcontentloaded" });
    await tab.page.waitForFunction(() => !!window.ui);
    await tab.page.evaluate((v) => window.ui.mount(v), visitor);
    await tab.page.waitForSelector(".bn-editor [data-id='p_ship']", { timeout: 15000 });
    tabs.set(name, tab);
    return tab;
  }

  const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) });
  const stored = (page) => page.evaluate(() => window.ui.stored());
  const cards = (page) =>
    page.$$eval(".nt-comment-layer [data-thread-card]", (els) =>
      els.filter((el) => !el.hidden).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.dataset.threadCard,
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          focused: el.hasAttribute("data-focused"),
          text: el.textContent,
        };
      }),
    );
  const cardFor = async (page, id) => (await cards(page)).find((c) => c.id === id) ?? null;
  const blockTop = (page, blockId) =>
    page.$eval(`.bn-editor [data-id='${blockId}'] .bn-inline-content`, (el) => el.getBoundingClientRect().top);
  const textRight = (page) => page.$eval(".bn-editor", (el) => el.getBoundingClientRect().right);
  const highlights = (page) => page.$$eval(".bn-editor .nt-comment-hl", (els) => els.map((el) => el.textContent));
  const toolbarUp = (page) => page.$$eval(".bn-formatting-toolbar", (els) => els.some((el) => el.getBoundingClientRect().height > 0));
  const settle = () => wait(350);

  // ---- 1. Two people open the page -----------------------------------------
  console.log("\n1. Ada (editor) and Cam (commenter) open the page");
  const ada = await open("ada", "ada");
  const cam = await open("cam", "cam");
  await settle();
  const A = ada.page;
  const C = cam.page;
  check("[ada] the page is editable", await A.$eval(".bn-editor", (el) => el.getAttribute("contenteditable")), "true");
  check("[cam] the page is read-only", await C.$eval(".bn-editor", (el) => el.getAttribute("contenteditable")), "false");
  const layerMode = (page) => page.$eval(".nt-comment-layer", (el) => el.dataset.mode).catch(() => null);
  check("[ada] with the chat rail out, the margin is too narrow for cards: dots", await layerMode(A), "dots");
  check("[cam] a commenter has no chat rail: cards", await layerMode(C), "cards");
  await shot(A, "01-ada-chat-open");
  await A.click('[aria-label="Collapse chat"]');
  await wait(500);
  check("[ada] with the chat put away, the margin holds cards", await layerMode(A), "cards");
  check("[ada] nothing is written by opening a page", (await stored(A)).length, 0);

  // ---- 2. Ada starts a thread from the formatting toolbar --------------------
  console.log("\n2. Ada drags across words, presses Comment, @-mentions Cam and posts");
  await clickEndOf(A, "p_after");
  await wait(300);
  await dragSelect(A, "p_ship", "by", "Friday");
  await wait(300);
  const commentButton = A.locator('.bn-formatting-toolbar button[aria-label="Comment"]');
  check("[ada] the formatting toolbar offers Comment", await commentButton.count(), 1);
  await shot(A, "02-ada-toolbar");
  await commentButton.click();
  await wait(250);
  check("[ada] the composer opens with the keyboard", await A.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Comment");
  check("[ada] the formatting toolbar has gone", await toolbarUp(A), false);
  check("[ada] the words stay marked while she writes", await highlights(A), ["by Friday"]);
  check("[ada] Post is off while the box is empty", await A.locator(".nt-comment-draft .nt-comment-btn.is-primary").isDisabled(), true);
  await A.keyboard.press("Enter");
  await wait(100);
  check("[ada] Enter on an empty box posts nothing", (await stored(A)).length, 0);
  await A.keyboard.type("Could this be Thursday? @Ca", { delay: 15 });
  await wait(150);
  check("[ada] @ offers the project's people", await A.$$eval(".nt-mention-menu [role=option]", (els) => els.map((el) => el.textContent)), ["Cam Commenter"]);
  await shot(A, "03-ada-mention-menu");
  await A.keyboard.press("Enter");
  await A.keyboard.type("what do you think?", { delay: 10 });
  check("[ada] the pick is written as @Name", await A.$eval(".nt-comment-draft textarea", (el) => el.value), "Could this be Thursday? @Cam Commenter what do you think?");
  await A.keyboard.press("Shift+Enter");
  check("[ada] Shift+Enter writes no line break", await A.$eval(".nt-comment-draft textarea", (el) => el.value.includes("\n")), false);
  await A.keyboard.press("Enter");
  await waitFor(A, () => document.querySelectorAll(".nt-comment-layer [data-thread-card]").length === 1);
  await settle();
  const [first] = await stored(A);
  check("[ada] one thread is written, on the words she chose", first && { exact: first.exact, blockId: first.blockId, text: first.comments[0].text, authorId: first.comments[0].authorId },
    { exact: "by Friday", blockId: "p_ship", text: "Could this be Thursday? @Cam Commenter what do you think?", authorId: "user_ada" });
  check("[ada] the comment is hers, not the assistant's", first?.comments[0].via ?? null, null);
  const created = notices.find((n) => n.fn === "commentNotices:event" && n.kind === "create");
  check("[ada] Cam is told he was mentioned", created && { who: created.who, threadId: created.threadId, mentions: created.mentions }, { who: "user_ada", threadId: first?.id, mentions: ["user_cam"] });
  let card = await cardFor(A, first.id);
  check("[ada] the card is level with its paragraph", Math.abs(card.top - (await blockTop(A, "p_ship"))) <= 2, true);
  check("[ada] the card sits in the margin, clear of the text and the review's buttons", card.left - (await textRight(A)) >= 80, true);
  check("[ada] the new thread is focused, card and highlight", [card.focused, await A.$$eval(".nt-comment-hl-active", (els) => els.map((e) => e.textContent))], [true, ["by Friday"]]);
  check("[ada] the keyboard is on the new card", await A.evaluate(() => document.activeElement?.dataset.threadCard ?? null), first.id);
  check("[ada] the card names her You, and shows the mention", [card.text.includes("You"), card.text.includes("@Cam Commenter")], [true, true]);
  await shot(A, "04-ada-first-thread");

  // ---- 3. Cam sees it ----------------------------------------------------
  console.log("\n3. Cam sees Ada's thread in his margin");
  check("[cam] the card arrives", await waitFor(C, (id) => !!document.querySelector(`.nt-comment-layer [data-thread-card="${id}"]`), first.id), true);
  await settle();
  card = await cardFor(C, first.id);
  check("[cam] it is level with the paragraph for him too", Math.abs(card.top - (await blockTop(C, "p_ship"))) <= 2, true);
  check("[cam] signed by name, never an id", [card.text.includes("Ada Editor"), card.text.includes("user_ada")], [true, false]);
  check("[cam] the words are highlighted", await highlights(C), ["by Friday"]);
  const hl = await wordBox(C, "p_ship", "Friday");
  await C.mouse.click(hl.x + hl.width / 2, hl.y + hl.height / 2);
  check("[cam] clicking the highlight focuses its card", await waitFor(C, (id) => document.querySelector(`.nt-comment-layer [data-thread-card="${id}"]`)?.hasAttribute("data-focused"), first.id), true);
  await shot(C, "05-cam-sees-thread");

  // ---- 4. Cam starts his own on the read-only page ----------------------------
  console.log("\n4. Cam selects words on his read-only page and comments from the floating button");
  await doubleClickWord(C, "p_risk", "migration");
  await wait(200);
  const float = C.locator(".nt-comment-float");
  check("[cam] a Comment button floats over his selection", [await float.count(), (await float.textContent())?.trim()], [1, "Comment"]);
  await shot(C, "06-cam-float");
  await float.click();
  await wait(200);
  check("[cam] his composer has the keyboard", await C.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Comment");
  await C.keyboard.type("Is there a rollback if it goes wrong?", { delay: 8 });
  await wait(150);
  await C.click(".nt-comment-draft .nt-comment-btn.is-primary");
  // The card is drawn from the local document at once; the backend has it once the provider sends.
  await waitFor(C, () => window.ui.stored().some((t) => t.exact === "migration"));
  const second = (await stored(C)).find((t) => t.exact === "migration");
  check("[cam] his thread is written as his", second && [second.blockId, second.comments[0].authorId], ["p_risk", "user_cam"]);
  check("[cam] his page was never written", (await C.evaluate(() => window.ui.refusals)).filter((r) => r.startsWith("document")), []);
  check("[ada] Cam's thread reaches her", await waitFor(A, (id) => !!document.querySelector(`.nt-comment-layer [data-thread-card="${id}"]`), second.id), true);

  // ---- 5. Cam replies to Ada ---------------------------------------------
  console.log("\n5. Cam replies on Ada's thread");
  await C.click(`.nt-comment-layer [data-thread-card="${first.id}"] .nt-comment-body`);
  await wait(200);
  check("[cam] choosing the card focuses it and its words", [(await cardFor(C, first.id)).focused, await C.evaluate(() => window.ui.active())], [true, first.id]);
  await C.click(`.nt-comment-layer [data-thread-card="${first.id}"] textarea[aria-label="Reply"]`);
  await C.keyboard.type("Thursday works for me.", { delay: 8 });
  await C.keyboard.press("Enter");
  check("[ada] Cam's reply reaches her", await waitFor(A, (id) => document.querySelector(`.nt-comment-layer [data-thread-card="${id}"]`)?.textContent.includes("Thursday works for me."), first.id), true);
  const reply = notices.filter((n) => n.fn === "commentNotices:event" && n.kind === "reply").at(-1);
  check("[cam] Ada is told of the reply, as the thread's participant", reply && { who: reply.who, participants: reply.participants }, { who: "user_cam", participants: ["user_ada"] });
  await shot(C, "07-cam-replied");

  // ---- 6. Resolve and reopen -------------------------------------------------
  console.log("\n6. Ada resolves the thread; it leaves both margins for the panel, and a reply brings it back");
  await A.click(`.nt-comment-layer [data-thread-card="${first.id}"] .nt-comment-body`);
  await wait(150);
  await A.click(`.nt-comment-layer [data-thread-card="${first.id}"] button[aria-label="Resolve"]`);
  const gone = (page) => waitFor(page, (id) => !document.querySelector(`.nt-comment-layer [data-thread-card="${id}"]`), first.id);
  check("[ada] the card leaves her margin", await gone(A), true);
  check("[cam] and his", await gone(C), true);
  check("[cam] and its highlight goes", await waitFor(C, () => ![...document.querySelectorAll(".nt-comment-hl")].some((el) => el.textContent === "by Friday")), true);
  check("[ada] stored as resolved", (await stored(A)).find((t) => t.id === first.id)?.status, "resolved");
  check("[ada] the header counts the one open thread", await A.$eval("[data-comments-toggle] .nt-comments-badge", (el) => el.textContent), "1");
  await A.click("[data-comments-toggle]");
  await A.waitForSelector(".nt-comments-panel");
  const sectionIds = (page, kind) => page.$$eval(`.nt-comments-panel [data-section="${kind}"] [data-thread-card]`, (els) => els.map((el) => el.dataset.threadCard));
  check("[ada] the panel lists it under Resolved", await sectionIds(A, "resolved"), [first.id]);
  check("[ada] and Cam's under Open", await sectionIds(A, "open"), [second.id]);
  await wait(300);
  await shot(A, "08-ada-panel-resolved");
  await A.click(`.nt-comments-panel [data-thread-card="${first.id}"]`);
  await wait(150);
  const resolvedCard = `.nt-comments-panel [data-thread-card="${first.id}"]`;
  check("[ada] the resolved card offers Reopen and a reply box", [
    await A.locator(`${resolvedCard} button[aria-label="Reopen"]`).count(),
    await A.locator(`${resolvedCard} textarea[aria-label="Reply"]`).getAttribute("placeholder"),
  ], [1, "Reply to reopen…"]);
  await shot(A, "08b-ada-resolved-reply-box");
  const beforeReopen = notices.length;
  await A.click(`${resolvedCard} textarea[aria-label="Reply"]`);
  await A.keyboard.type("Reopening: QA slipped a day.", { delay: 5 });
  await A.keyboard.press("Enter");
  const back = (page) => waitFor(page, (id) => !!document.querySelector(`.nt-comment-layer [data-thread-card="${id}"]`), first.id);
  check("[ada] her reply reopened it: back in her margin", await back(A), true);
  check("[cam] and in his", await back(C), true);
  check("[ada] stored open, with her reply last", await waitFor(A, (id) => {
    const t = window.ui.stored().find((x) => x.id === id);
    return t?.status === "open" && t.comments.at(-1).text === "Reopening: QA slipped a day.";
  }, first.id), true);
  check("[ada] one notice, the reply's, telling Cam", notices.slice(beforeReopen).filter((n) => n.fn === "commentNotices:event").map((n) => [n.kind, n.participants]), [["reply", ["user_ada", "user_cam"]]]);
  await A.click('[aria-label="Close comments"]');

  // ---- 7. Edit and delete one's own comment -----------------------------------
  console.log("\n7. Cam edits his reply, then deletes it");
  await C.click(`.nt-comment-layer [data-thread-card="${first.id}"] .nt-comment-body`);
  await wait(200);
  const replyRow = C.locator(`.nt-comment-layer [data-thread-card="${first.id}"] .nt-comment`).nth(1);
  await replyRow.hover();
  check("[cam] Ada's comment offers him no edit", await C.locator(`.nt-comment-layer [data-thread-card="${first.id}"] .nt-comment`).nth(0).locator('button[aria-label="More actions"]').count(), 0);
  await replyRow.locator('button[aria-label="More actions"]').click();
  await C.getByRole("menuitem", { name: "Edit" }).click();
  await wait(150);
  const editBox = C.locator(`.nt-comment-layer [data-thread-card="${first.id}"] textarea[aria-label="Edit comment"]`);
  check("[cam] the edit box holds his words", await editBox.inputValue(), "Thursday works for me.");
  await editBox.fill("Thursday works for me, if QA agrees.");
  await C.keyboard.press("Enter");
  check("[ada] the edit reaches her, marked edited", await waitFor(A, (id) => {
    const t = window.ui.stored().find((x) => x.id === id);
    return t?.comments[1]?.text === "Thursday works for me, if QA agrees." && t.comments[1].edited === true;
  }, first.id), true);
  await A.click(`.nt-comment-layer [data-thread-card="${first.id}"] .nt-comment-body`);
  check("[ada] the card says edited", await waitFor(A, (id) => document.querySelector(`.nt-comment-layer [data-thread-card="${id}"]`)?.textContent.includes("edited"), first.id), true);
  await shot(A, "09-ada-sees-edit");
  await C.click(`.nt-comment-layer [data-thread-card="${first.id}"] .nt-comment-body`);
  await replyRow.hover();
  await replyRow.locator('button[aria-label="More actions"]').click();
  await C.getByRole("menuitem", { name: "Delete", exact: true }).click();
  check("[ada] the deleted reply leaves her card", await waitFor(A, (id) => window.ui.stored().find((x) => x.id === id)?.comments.length === 2, first.id), true);

  // ---- 8. ⌘Z on a card ----------------------------------------------------------
  console.log("\n8. Ada replies, clicks her card, and ⌘Z takes the reply back");
  await A.click(`.nt-comment-layer [data-thread-card="${second.id}"] .nt-comment-body`);
  await wait(150);
  await A.click(`.nt-comment-layer [data-thread-card="${second.id}"] textarea[aria-label="Reply"]`);
  await A.keyboard.type("We keep the old tables for a week.", { delay: 5 });
  await A.keyboard.press("Enter");
  await waitFor(A, (id) => window.ui.stored().find((x) => x.id === id)?.comments.length === 2, second.id);
  await A.keyboard.press(UNDO);
  check("[ada] ⌘Z in the reply box is the box's own, not the comment", (await stored(A)).find((t) => t.id === second.id).comments.length, 2);
  await A.click(`.nt-comment-layer [data-thread-card="${second.id}"] .nt-comment-name`);
  await A.keyboard.press(UNDO);
  check("[ada] ⌘Z on the card undoes her reply", await waitFor(A, (id) => window.ui.stored().find((x) => x.id === id)?.comments.length === 1, second.id), true);
  check("[ada] and the page is untouched", (await A.evaluate(() => window.ui.storedPageText())).includes("Ship it by Friday if the tests pass"), true);

  // ---- 9. Delete a thread ----------------------------------------------------------
  console.log("\n9. Ada, an editor, deletes Cam's thread; ⌘Z brings it back");
  await A.click(`.nt-comment-layer [data-thread-card="${second.id}"] .nt-comment-body`);
  await A.locator(`.nt-comment-layer [data-thread-card="${second.id}"] .nt-comment`).first().hover();
  await A.locator(`.nt-comment-layer [data-thread-card="${second.id}"] .nt-comment`).first().locator('button[aria-label="More actions"]').click();
  check("[ada] she may delete the thread but not edit his words", await A.$$eval("[role=menu] [role=menuitem]", (els) => els.map((el) => el.textContent)), ["Delete thread"]);
  await A.getByRole("menuitem", { name: "Delete thread" }).click();
  check("[cam] the thread leaves his margin", await waitFor(C, (id) => !document.querySelector(`.nt-comment-layer [data-thread-card="${id}"]`), second.id), true);
  check("[ada] stored without it", (await stored(A)).map((t) => t.id), [first.id]);
  const deleted = notices.filter((n) => n.fn === "commentNotices:event" && n.kind === "delete").at(-1);
  check("[ada] the delete is reported for the whole thread", deleted && [deleted.threadId, deleted.commentId ?? null], [second.id, null]);
  await A.locator(".nt-comment-layer").focus();
  await A.keyboard.press(UNDO);
  check("[ada] ⌘Z restores the thread she deleted", await waitFor(C, (id) => !!document.querySelector(`.nt-comment-layer [data-thread-card="${id}"]`), second.id), true);

  // ---- 10. ⌘⌥M and Escape ---------------------------------------------------------
  console.log("\n10. ⌘⌥M opens the composer; Escape discards it");
  await clickEndOf(A, "p_after");
  await dragSelect(A, "p_budget", "hosting", "cost");
  await A.keyboard.press("ControlOrMeta+Alt+KeyM");
  await wait(200);
  check("[ada] ⌘⌥M opens the composer", await A.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Comment");
  await A.keyboard.type("scrap this", { delay: 5 });
  await A.keyboard.press("Escape");
  await wait(150);
  check("[ada] Escape closes it", await A.$$eval(".nt-comment-draft", (els) => els.length), 0);
  check("[ada] with nothing written and the draft mark gone", [(await stored(A)).length, (await highlights(A)).includes("hosting cost")], [2, false]);
  await dragSelect(A, "p_budget", "hosting", "cost");
  await A.keyboard.press("ControlOrMeta+Alt+KeyM");
  await wait(150);
  await A.keyboard.type("Where does this come from?", { delay: 5 });
  await A.keyboard.press("Enter");
  check("[ada] ⌘⌥M's thread is written", await waitFor(A, () => window.ui.stored().some((t) => t.exact === "hosting cost")), true);
  const hosting = (await stored(A)).find((t) => t.exact === "hosting cost");

  // ---- 11. Nearby threads stack -----------------------------------------------------
  console.log("\n11. Threads on neighbouring lines stack without overlapping; focus brings one level with its words");
  await A.evaluate(() => window.ui.seedThreads([["p_owner", "rollout"], ["p_notes", "comments"]]));
  await waitFor(A, () => document.querySelectorAll(".nt-comment-layer [data-thread-card]").length === 5);
  await A.click(".bn-editor [data-id='p_intro'] .bn-inline-content");
  await wait(500);
  const clear = (list) => list.slice(1).every((c, i) => c.top >= list[i].bottom + 7);
  let stack = (await cards(A)).sort((a, b) => a.top - b.top);
  check("[ada] five cards, none overlapping", [stack.length, clear(stack)], [5, true]);
  await shot(A, "10-ada-stacked");
  const lowest = stack.at(-1);
  const lowestThread = (await stored(A)).find((t) => t.id === lowest.id);
  await A.click(`.nt-comment-layer [data-thread-card="${lowest.id}"] .nt-comment-body`);
  await wait(500);
  stack = (await cards(A)).sort((a, b) => a.top - b.top);
  const focusedCard = stack.find((c) => c.id === lowest.id);
  check("[ada] the chosen card rises level with its paragraph", Math.abs(focusedCard.top - (await blockTop(A, lowestThread.blockId))) <= 2, true);
  check("[ada] and the others make room, still none overlapping", clear(stack), true);
  await shot(A, "11-ada-focused-lowest");

  // ---- 12. The assistant's comment -------------------------------------------------
  console.log("\n12. A comment the assistant wrote says so");
  const said = await A.evaluate(() => window.ui.assistantComment({ blockId: "p_after", quote: "next plan", text: "Worth a short retro here." }));
  check("[ada] the assistant's tool started the thread", said.startsWith("Started thread"), true);
  const byModel = (await stored(A)).find((t) => t.exact === "next plan");
  check("[ada] stored as hers, via the assistant", byModel?.comments[0] && [byModel.comments[0].authorId, byModel.comments[0].via], ["user_ada", "assistant"]);
  check("[cam] his card says via assistant", await waitFor(C, (id) => document.querySelector(`.nt-comment-layer [data-thread-card="${id}"]`)?.textContent.includes("via assistant"), byModel.id), true);
  check("[cam] under Ada's name", (await cardFor(C, byModel.id)).text.includes("Ada Editor"), true);
  await shot(C, "12-cam-via-assistant");
  // The header gives the name its room: the meta wraps under a name it cannot
  // sit beside, and only a name wider than the card is cut.
  const viaRow = `.nt-comment-layer [data-thread-card="${byModel.id}"] .nt-comment`;
  const header = () => C.$eval(viaRow, (row) => {
    const box = (el) => el.getBoundingClientRect();
    const name = row.querySelector(".nt-comment-name");
    const meta = row.querySelector(".nt-comment-meta");
    return {
      nameCut: name.scrollWidth > name.clientWidth,
      nameShare: box(name).width / box(row.querySelector(".nt-comment-who")).width,
      metaWhole: meta.scrollWidth <= Math.ceil(box(meta).width),
      metaBelow: box(meta).top >= box(name).bottom - 2,
    };
  });
  const short = await header();
  check("[cam] a short name is whole, and so is its meta", [short.nameCut, short.metaWhole], [false, true]);
  await C.locator(viaRow).first().screenshot({ path: path.join(shots, "12b-via-short-name.png") });
  const setName = (text) => C.$eval(`${viaRow} .nt-comment-name`, (el, t) => { el.firstChild.nodeValue = t; }, text);
  await setName("Maximiliana Wolkenstein-Fairweather");
  const long = await header();
  check("[cam] a long name takes the whole line, the meta wraps under it whole", [long.nameShare > 0.95, long.metaWhole, long.metaBelow], [true, true, true]);
  await C.locator(viaRow).first().screenshot({ path: path.join(shots, "12c-via-long-name.png") });
  await setName("Ada Editor");

  // ---- 13. Mentioning someone who cannot open the project ----------------------------
  console.log("\n13. A mention of someone the project cannot reach");
  await dragSelect(A, "p_detail", "three", "waves");
  await A.keyboard.press("ControlOrMeta+Alt+KeyM");
  await wait(150);
  await A.keyboard.type("Loop in @Dee", { delay: 5 });
  await A.keyboard.press("Enter");
  await A.keyboard.type("on this", { delay: 5 });
  await A.keyboard.press("Enter");
  check("[ada] posted, and told who was not told", await waitFor(A, () => [...document.querySelectorAll(".nt-comment-layer .nt-comment-note")].some((el) => el.textContent === "Posted, but Dee Departed can't open this project, so they weren't told.")), true);
  check("[ada] the comment stands", (await stored(A)).some((t) => t.exact === "three waves"), true);
  await shot(A, "13-ada-outsider-after");
  await dragSelect(A, "p_detail", "error", "rate");
  await A.keyboard.press("ControlOrMeta+Alt+KeyM");
  await wait(150);
  await A.keyboard.type("Ask @Dee", { delay: 5 });
  await A.keyboard.press("Enter");
  await A.evaluate(() => window.ui.revoke("user_dee"));
  await wait(100);
  await A.keyboard.press("Enter");
  await wait(150);
  check("[ada] refused before writing, naming her", await A.$eval(".nt-comment-draft [role=alert]", (el) => el.textContent).catch(() => null), "Dee Departed can't open this project. Remove the mention to post.");
  check("[ada] nothing was written", (await stored(A)).some((t) => t.exact === "error rate"), false);
  await shot(A, "14-ada-outsider-before");
  await A.keyboard.press("Escape");

  // ---- 14. Orphaned by an edit, and back ------------------------------------------------
  console.log("\n14. Deleting the commented words moves the thread to “No longer in the document”; undo brings it back");
  await dragSelect(A, "p_budget", "hosting", "cost");
  await A.keyboard.press("Backspace");
  check("[ada] the card leaves the margin", await waitFor(A, (id) => !document.querySelector(`.nt-comment-layer [data-thread-card="${id}"]`), hosting.id), true);
  await wait(800);
  await A.click("[data-comments-toggle]");
  await A.waitForSelector(".nt-comments-panel");
  check("[ada] the panel lists it as no longer in the document", await sectionIds(A, "orphaned"), [hosting.id]);
  check("[ada] quoting what it was about", await A.$eval(`.nt-comments-panel [data-thread-card="${hosting.id}"] .nt-comment-quote`, (el) => el.textContent), "hosting cost");
  check("[cam] it has left his margin too", await waitFor(C, (id) => !document.querySelector(`.nt-comment-layer [data-thread-card="${id}"]`), hosting.id), true);
  await wait(300);
  await shot(A, "15-ada-orphaned");
  await A.click('[aria-label="Close comments"]');
  await A.click(".bn-editor [data-id='p_budget'] .bn-inline-content");
  await A.keyboard.press(UNDO);
  check("[ada] undoing the deletion re-anchors it", await waitFor(A, (id) => !!document.querySelector(`.nt-comment-layer [data-thread-card="${id}"]`), hosting.id, 8000), true);

  // ---- 15. A narrow window: dots and the panel --------------------------------------------
  console.log("\n15. A narrow window turns cards into dots, which open the thread in the panel");
  await C.setViewportSize({ width: 900, height: 820 });
  await wait(500);
  check("[cam] dots, not cards", [await layerMode(C), (await C.$$(".nt-comment-dot")).length > 0, (await cards(C)).length], ["dots", true, 0]);
  await shot(C, "16-cam-dots");
  const dotBox = await C.$eval(`.nt-comment-dot[data-thread-dot="${first.id}"]`, (el) => { const r = el.getBoundingClientRect(); return { top: r.top }; });
  check("[cam] the dot is level with its paragraph", Math.abs(dotBox.top - (await blockTop(C, "p_ship"))) <= 2, true);
  await C.click(`.nt-comment-dot[data-thread-dot="${first.id}"]`);
  await C.waitForSelector(".nt-comments-panel");
  check("[cam] the dot opens its thread in the panel", await C.$eval(`.nt-comments-panel [data-thread-card="${first.id}"]`, (el) => el.hasAttribute("data-focused")), true);
  await wait(300);
  await shot(C, "17-cam-dot-panel");
  await C.click('[aria-label="Close comments"]');
  await doubleClickWord(C, "p_after", "launch");
  await C.locator(".nt-comment-float").click();
  check("[cam] narrow, the composer opens in the panel", await C.evaluate(() => !!document.activeElement?.closest(".nt-comments-panel") && document.activeElement.getAttribute("aria-label")), "Comment");
  await C.keyboard.press("Escape");
  await C.setViewportSize({ width: 1440, height: 900 });
  await wait(400);
  check("[cam] wide again, cards", await layerMode(C), "cards");

  // ---- 16. A link to a thread --------------------------------------------------------------
  console.log("\n16. Opening the page from a link to a thread focuses it and leaves the address clean");
  await cam.context.close();
  tabs.delete("cam");
  const cam2 = await open("cam", "cam", { query: `?thread=${byModel.id}` });
  const C2 = cam2.page;
  check("[cam] the linked thread is focused", await waitFor(C2, (id) => document.querySelector(`.nt-comment-layer [data-thread-card="${id}"]`)?.hasAttribute("data-focused"), byModel.id, 8000), true);
  check("[cam] the address no longer names it", await C2.evaluate(() => new URL(location.href).searchParams.has("thread")), false);
  check("[cam] the page's notices are marked seen", notices.some((n) => n.fn === "commentNotices:markPageSeen" && n.who === "user_cam"), true);
  await shot(C2, "18-cam-linked-thread");
  await A.click(`.nt-comment-layer [data-thread-card="${first.id}"] .nt-comment-body`);
  await A.click(`.nt-comment-layer [data-thread-card="${first.id}"] button[aria-label="Resolve"]`);
  await waitFor(A, (id) => window.ui.stored().find((t) => t.id === id)?.status === "resolved", first.id);
  await cam2.context.close();
  tabs.delete("cam");
  const cam3 = await open("cam", "cam", { query: `?thread=${first.id}` });
  const C3 = cam3.page;
  check("[cam] a resolved thread's link opens it in the panel", await waitFor(C3, (id) => document.querySelector(`.nt-comments-panel [data-thread-card="${id}"]`)?.hasAttribute("data-focused"), first.id, 8000), true);
  check("[cam] and the address lets go of it too", await C3.evaluate(() => new URL(location.href).searchParams.has("thread")), false);
  const beforeButton = notices.length;
  await C3.click(`.nt-comments-panel [data-thread-card="${first.id}"] button[aria-label="Reopen"]`);
  check("[cam] Reopen reopens it without a word", await waitFor(C3, (id) => window.ui.stored().find((t) => t.id === id)?.status === "open", first.id), true);
  check("[cam] with a reopen notice", notices.slice(beforeButton).filter((n) => n.fn === "commentNotices:event").map((n) => n.kind), ["reopen"]);

  // ---- 17. A signed-out guest on a comment link -------------------------------------------
  console.log("\n17. A signed-out guest selecting words is offered sign-in");
  const guest = await open("guest", "guest");
  await doubleClickWord(guest.page, "p_ship", "Friday");
  await wait(200);
  check("[guest] Sign in to comment floats over the selection", (await guest.page.locator(".nt-comment-float").textContent())?.trim(), "Sign in to comment");
  check("[guest] no comment surfaces for someone who cannot read them", await guest.page.$$eval(".nt-comment-layer, [data-comments-toggle]", (els) => els.length), 0);
  await guest.page.locator(".nt-comment-float").click();
  check("[guest] pressing it opens the sign-in door, on commenting's behalf", await waitFor(guest.page, () => [...document.querySelectorAll('[role="dialog"]')].some((d) => d.textContent.includes("Sign in to comment"))), true);
  await guest.context.close();
  tabs.delete("guest");

  // ---- 18. Typing with twenty open threads ------------------------------------------------
  console.log("\n18. Typing 200 characters above twenty open threads re-renders no card");
  const words = [["p_intro", "autumn"], ["p_intro", "team"], ["p_ship", "tests"], ["p_ship", "design"], ["p_risk", "risk"], ["p_risk", "stored"],
    ["p_owner", "announcement"], ["p_budget", "Budget"], ["p_budget", "old plan"], ["p_notes", "chat"], ["p_notes", "words"], ["p_detail", "staff"],
    ["p_detail", "console"], ["p_after", "review"]];
  await A.evaluate((w) => window.ui.seedThreads(w), words);
  check("[ada] twenty open threads", await waitFor(A, () => window.ui.stored().filter((t) => t.status === "open").length >= 20), true);
  check("[ada] twenty cards", await waitFor(A, (n) => document.querySelectorAll(".nt-comment-layer [data-thread-card]").length >= n, 20), true);
  await clickEndOf(A, "p_intro");
  // Quiet first: Cam's replica settles the new anchors, and those writes come back.
  await wait(2000);
  const before = await A.evaluate(() => ({ renders: window.ui.renders(), margin: window.ui.margin() }));
  const typed = " and the quick brown fox keeps typing to prove that every keystroke leaves the cards alone";
  const text = (typed + typed + typed).slice(0, 200);
  const t0 = Date.now();
  await A.keyboard.type(text, { delay: 12 });
  const elapsed = Date.now() - t0;
  await wait(400);
  const after = await A.evaluate(() => ({ renders: window.ui.renders(), margin: window.ui.margin() }));
  const passes = after.margin.passes - before.margin.passes;
  const mean = (after.margin.totalMs - before.margin.totalMs) / Math.max(1, passes);
  console.log(`       typing took ${elapsed} ms; ${passes} layout passes, mean ${mean.toFixed(2)} ms; card renders ${after.renders - before.renders}`);
  check("[ada] no card re-rendered while typing", after.renders - before.renders, 0);
  check("[ada] the cards followed along: at most one layout pass per keystroke", passes > 0 && passes <= text.length + 5, true);
  check("[ada] a layout pass of twenty cards stays under 4 ms", mean < 4, true);
  stack = (await cards(A)).sort((a, b) => a.top - b.top);
  check("[ada] after typing, still none overlapping", clear(stack), true);
  await shot(A, "19-ada-twenty-threads");

  // ---- 19. The words go while the comment is being written ----------------------------
  console.log("\n19. A collaborator deletes the words while Ada writes about them");
  const beforeCount = (await stored(A)).length;
  await dragSelect(A, "p_after", "launch", "launch");
  await A.keyboard.press("ControlOrMeta+Alt+KeyM");
  await wait(150);
  await A.keyboard.type("Which launch?", { delay: 5 });
  await A.evaluate(() => window.ui.deleteWords("p_after", "launch"));
  await wait(300);
  check("[ada] her draft stays open, with her words", await A.$eval(".nt-comment-draft textarea", (el) => el.value).catch(() => null), "Which launch?");
  await A.keyboard.press("Enter");
  await wait(200);
  check("[ada] posting is refused, saying why", await A.$eval(".nt-comment-draft [role=alert]", (el) => el.textContent).catch(() => null), "The words this comment was about are no longer in the page.");
  check("[ada] and no thread is written about nothing", (await stored(A)).length, beforeCount);
  await A.keyboard.press("Escape");
}
catch (error) {
  failures.push(`harness threw: ${error.stack ?? error}`);
} finally {
  await browser?.close();
  server.close();
}
finish();
