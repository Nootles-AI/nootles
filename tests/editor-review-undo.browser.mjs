/**
 * Undo after answering an agent's change, driven through real Chromium mouse
 * and keyboard input.
 *
 * NT-37: a person wrote notes, asked the chat a question, and the agent's
 * answer replaced the notes. They pressed Keep all, and ⌘Z could not bring the
 * notes back.
 *
 * The page is composed the way `Editor.tsx` composes a Yjs page: the production
 * editor bound to a local Y.Doc that exchanges updates with a peer doc, the
 * document's undo domain on the workspace history spine with its capture-phase
 * key handler, the review overlay, and the review bar. The agent's turn runs
 * through the real `ReviewSession` — checkpoint, fork, applier, hunks, merge —
 * against an in-memory stand-in for Convex; only the model is replaced, by a
 * scripted batch resolved exactly as `edit_page` resolves one.
 *
 * NT-44: the chat's rewind ("Notes only", "Notes and conversation") restored
 * nothing once turn rows were stored packed, and restoring them for real
 * rewrote the page under a ⌘Z timeline that still named what it replaced. The
 * rewind is pressed through the chat transcript's own Rewind menu, wired to the
 * session as `ChatPanel` wires it.
 *
 * NT-43: an agent's diagram edit reached collaborators' maps while it was
 * still under review, and Discard, Revert and the rewind put back only the
 * block's `<nt-diagram>` mirror. Every reader of the diagram — the block prop,
 * both docs' maps, the collaborator's copy of the mirror, the review's fork and
 * the surface — is checked on its own, and a shape is dragged with the pointer.
 *
 * NT-39: an agent that changed a few words of a table had the whole table
 * washed green, as if all of it were new. Every table edit reaches the review
 * as one whole-table `setTableRows`, so the checks read what a reader meets:
 * the block's own mark, and which cells have words marked in them.
 *
 * Uses the existing esbuild dependency and an operator-installed Puppeteer. No
 * app server, no Convex, no API keys — and every non-local request fails the
 * run, so no AI lane can be spent in here.
 *
 *   NML_PUPPETEER_MODULE=/absolute/path/to/puppeteer/lib/esm/puppeteer/puppeteer.js \
 *     node tests/editor-review-undo.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "editor-review-undo-"));
const { default: puppeteer } = await import(process.env.NML_PUPPETEER_MODULE || "puppeteer");

// `ReviewProvider` builds its session from a Convex client and subscribes to
// unreviewed turns; the fixture builds the same session over memory, so the
// bar and the overlay read it through these three hooks instead.
const REVIEW_CONTEXT = `
import { useMemo, useSyncExternalStore } from "react";
const current = () => globalThis.reviewHarnessSession;
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

// The transcript learns which questions changed a page — and so which offer to
// rewind the notes — from `useQuery`; the fixture answers that one query from
// its in-memory turn rows, and leaves every other query loading.
const CHAT_CONVEX = `
export * from "convex/react";
import { useSyncExternalStore } from "react";
import { getFunctionName } from "convex/server";
const never = () => () => {};
const loading = () => undefined;
export function useQuery(query, args) {
  const turns = globalThis.reviewHarnessTurns;
  const wanted = args !== "skip" && getFunctionName(query) === "chat/turns:restorable";
  return useSyncExternalStore(wanted ? turns.subscribe : never, wanted ? turns.restorable : loading);
}
`;
const TRANSCRIPT = path.join("app", "components", "chat", "ChatTranscript.tsx");

await build({
  absWorkingDir: repo, entryPoints: ["tests/editor-review-undo.browser.tsx"], bundle: true, splitting: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"development"', "process.env.NEXT_PUBLIC_YJS": '"1"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [{ name: "fixture", setup(builder) {
    builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({ path: "server-only", namespace: "fixture" }));
    builder.onResolve({ filter: /(^|\/)ReviewContext$/ }, () => ({ path: "review-context", namespace: "fixture" }));
    builder.onResolve({ filter: /^convex\/react$/ }, (args) => (args.importer.endsWith(TRANSCRIPT) ? { path: "chat-convex", namespace: "fixture" } : undefined));
    builder.onLoad({ filter: /^chat-convex$/, namespace: "fixture" }, () => ({ contents: CHAT_CONVEX, loader: "js", resolveDir: repo }));
    builder.onLoad({ filter: /^server-only$/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };' }));
    builder.onLoad({ filter: /^review-context$/, namespace: "fixture" }, () => ({ contents: REVIEW_CONTEXT, loader: "js", resolveDir: repo }));
  } }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
});
// Tailwind is not in the bundle; the canvas block's wrapper leans on two of its
// utilities, without which a diagram lays out zero pixels wide and no shape on
// it can be pressed. `globals.css` imports Tailwind too, so the review's diff
// colours are copied from it: without them a wash paints nothing to check.
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/editor-review-undo.browser.css"><style>html,body{margin:0;height:100%;overflow:hidden;font-family:Arial,sans-serif}.relative{position:relative}.w-full{width:100%}:root{--diff-add-bg:oklch(0.962 0.024 148);--diff-add-line:oklch(0.63 0.105 148);--diff-del:oklch(0.548 0.115 25);--diff-del-bg:oklch(0.958 0.019 25)}</style></head><body><div id="app"></div><script type="module" src="/editor-review-undo.browser.js"></script></body></html>`);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") { response.writeHead(204); return void response.end(); }
    const name = pathname === "/" ? "index.html" : path.basename(pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream");
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return void console.log(`  ok   ${name}`);
  failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
  console.log(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The reporter's window.
const VIEWPORT = { width: 1470, height: 801 };
const MOD = process.platform === "darwin" ? "Meta" : "Control";
// Past Y.UndoManager's 500 ms capture window, so each typed note is its own step.
const BETWEEN_NOTES = 700;

const PAGE = [
  { type: "heading", props: { level: 1 }, content: "Enactus intro reel" },
  { type: "paragraph", content: "Notes" },
  { type: "paragraph", content: "" },
];
const HEAD = ["heading:Enactus intro reel", "paragraph:Notes"];
const NOTES = [
  "paragraph:idea: ask members about their childhood dreams",
  "paragraph:idea: letter in a child's handwriting",
  "paragraph:idea: end on the logo",
];
const SCENE = [
  "heading:Scene 1 — The Question",
  "paragraph:Visual: A café table. Actor B leans into frame.",
  "quote:\"What was your childhood dream?\"",
];

let browser;
try {
  browser = await puppeteer.launch({ headless: true, ...(process.env.NML_CHROME_PATH ? { executablePath: process.env.NML_CHROME_PATH } : {}) });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  // A renderer crash otherwise surfaces only as the next call's "detached Frame".
  page.on("error", (error) => console.log(`page crashed: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    failures.push(`console ${message.type()}: ${message.text()}`);
  });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().startsWith(origin) || request.url().startsWith("data:")) return void request.continue();
    failures.push(`request left the fixture: ${request.url()}`);
    return void request.abort();
  });

  await page.evaluateOnNewDocument(() => {
    // The canvas block's Convex hooks connect over a socket; this one never opens.
    window.WebSocket = class extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0;
      send() { throw new Error("Fixture socket must never send"); }
      close() { this.readyState = 3; }
    };
  });

  await page.goto(origin, { waitUntil: "networkidle0" });
  const h = (fn, ...args) => page.evaluate(fn, ...args);
  const texts = () => h(() => window.reviewHarness.texts());
  const forked = () => h(() => window.reviewHarness.forked());

  const fresh = async () => {
    await h(() => window.reviewHarness.mount());
    await page.waitForSelector(".bn-editor");
    await h((blocks) => window.reviewHarness.seed(blocks), PAGE);
    await page.waitForFunction(() => window.reviewHarness.textPoint(2, 0) !== null);
    // The undo domain registers from an effect.
    await page.waitForFunction(() => window.reviewHarness.stacks() !== null);
    await sleep(100);
  };
  const clickText = async (index, offset) => {
    const at = await h((i, o) => window.reviewHarness.textPoint(i, o), index, offset);
    await page.mouse.click(at.x, at.y);
    await sleep(80);
  };
  const clickEnd = async (index) => {
    const length = await h((i) => window.reviewHarness.texts()[i].split(":").slice(1).join(":").length, index);
    await clickText(index, length);
  };
  const chord = async (...keys) => {
    for (const key of keys) await page.keyboard.down(key);
    for (const key of [...keys].reverse()) await page.keyboard.up(key);
    await sleep(250);
  };
  const undo = () => chord(MOD, "z");
  const redo = () => chord(MOD, "Shift", "z");
  /** The person writing their notes, one idea at a time. */
  const typeNotes = async () => {
    await clickText(2, 0);
    for (const [i, line] of NOTES.entries()) {
      await page.keyboard.type(line.slice("paragraph:".length), { delay: 5 });
      await sleep(BETWEEN_NOTES);
      if (i < NOTES.length - 1) {
        await page.keyboard.press("Enter");
        await sleep(BETWEEN_NOTES);
      }
    }
  };
  const settled = () => page.waitForFunction(() => window.reviewHarness.open() === 0 && !window.reviewHarness.forked(), { timeout: 5000 }).then(() => sleep(250));
  /** The question typed into the chat composer, then the agent's answer staged. */
  const turn = async (kind = "agentReplace", ...args) => {
    const composer = await page.$("#composer");
    const box = await composer.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.type("turn my notes into a storyboard", { delay: 2 });
    await sleep(100);
    const id = await h((name, rest) => window.reviewHarness[name](...rest), kind, args);
    await page.waitForSelector("#bar button");
    await sleep(150);
    return id;
  };
  const peer = () => h(() => window.reviewHarness.peerTexts());
  /** A hunk's own button, topmost first, pressed with the pointer resting on it. */
  const pressHunk = async (label) => {
    const buttons = await page.$$(`button[aria-label="${label}"]`);
    const boxes = (await Promise.all(buttons.map((b) => b.boundingBox()))).filter(Boolean).sort((a, b) => a.y - b.y);
    if (!boxes.length) throw new Error(`no visible "${label}" button`);
    const box = boxes[0];
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(80);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    return boxes.length;
  };
  const press = async (label) => {
    const [button] = await page.$$(`xpath/.//div[@id="bar"]//button[normalize-space()="${label}"]`);
    if (!button) throw new Error(`no ${label} button`);
    const box = await button.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };

  console.log("typing, without the agent");
  await fresh();
  await typeNotes();
  check("notes typed", await texts(), [...HEAD, ...NOTES]);
  await undo();
  check("⌘Z takes back the newest note", await texts(), [...HEAD, ...NOTES.slice(0, 2), "paragraph:"]);
  await redo();
  check("⌘⇧Z writes it again", await texts(), [...HEAD, ...NOTES]);

  console.log("the report: Keep all, then ⌘Z");
  await fresh();
  await typeNotes();
  const kept = await turn();
  check("the agent's change is on the page, under review", await texts(), [...HEAD, ...SCENE]);
  check("the review is open and forked", [await h(() => window.reviewHarness.open()), await forked()], [1, true]);
  await press("Keep all");
  await settled();
  check("Keep all settles the turn", await h((id) => window.reviewHarness.status(id), kept), "accepted");
  check("the kept change reached the shared doc", await h(() => window.reviewHarness.peerTexts()), [...HEAD, ...SCENE]);
  await clickEnd(0);
  await undo();
  check("⌘Z brings the notes back", await texts(), [...HEAD, ...NOTES]);
  check("…and the collaborator sees them back", await h(() => window.reviewHarness.peerTexts()), [...HEAD, ...NOTES]);
  await redo();
  check("⌘⇧Z keeps the change again", await texts(), [...HEAD, ...SCENE]);
  await undo();
  check("⌘Z takes it back again", await texts(), [...HEAD, ...NOTES]);
  await undo();
  check("the next ⌘Z reaches the person's own typing", await texts(), [...HEAD, ...NOTES.slice(0, 2), "paragraph:"]);
  check("nothing reported a failure", await h(() => window.reviewHarness.failure()), null);

  console.log("⌘Z while the change is still under review");
  await fresh();
  await typeNotes();
  await turn();
  await clickEnd(0);
  await undo();
  check("⌘Z leaves a change under review alone", await texts(), [...HEAD, ...SCENE]);
  check("…still forked, still open", [await h(() => window.reviewHarness.open()), await forked()], [1, true]);
  check("…and the shared doc never heard the change", await h(() => window.reviewHarness.peerTexts()), [...HEAD, ...NOTES]);

  console.log("Discard all, then ⌘Z");
  await fresh();
  await typeNotes();
  await turn();
  await press("Discard all");
  await settled();
  check("Discard all puts the notes back", await texts(), [...HEAD, ...NOTES]);
  await clickEnd(0);
  await undo();
  check("⌘Z after a discard does not bring the change back", (await texts()).some((t) => SCENE.includes(t)), false);
  await redo();
  check("…and ⌘⇧Z gives the notes back whole", await texts(), [...HEAD, ...NOTES]);

  console.log("Keep all, a collaborator writes, then ⌘Z");
  await fresh();
  await typeNotes();
  await turn();
  await press("Keep all");
  await settled();
  await h(() => window.reviewHarness.peerType("Notes", " (from Ali)"));
  await sleep(150);
  await clickEnd(0);
  await undo();
  check("⌘Z takes back the change and leaves the collaborator's words", await texts(), [HEAD[0], "paragraph:Notes (from Ali)", ...NOTES]);

  console.log("Keep all, more typing, then ⌘Z twice");
  await fresh();
  await typeNotes();
  await turn();
  await press("Keep all");
  await settled();
  await clickEnd(0);
  await page.keyboard.type(" v2", { delay: 5 });
  await sleep(BETWEEN_NOTES);
  check("typed after keeping", (await texts())[0], "heading:Enactus intro reel v2");
  await undo();
  check("the first ⌘Z takes back only the typing", await texts(), [...HEAD, ...SCENE]);
  await undo();
  check("the second takes back the kept change", await texts(), [...HEAD, ...NOTES]);

  console.log("typing during the review, then Keep all and ⌘Z");
  await fresh();
  await typeNotes();
  await turn();
  await clickEnd(0);
  await page.keyboard.type(" v2", { delay: 5 });
  await sleep(BETWEEN_NOTES);
  await press("Keep all");
  await settled();
  const TITLED = ["heading:Enactus intro reel v2", HEAD[1]];
  check("the typing and the change reach the shared doc together", await peer(), [...TITLED, ...SCENE]);
  await clickEnd(1);
  await undo();
  check("one ⌘Z takes back both, as they landed together", await texts(), [...HEAD, ...NOTES]);
  await redo();
  check("⌘⇧Z puts both back", await texts(), [...TITLED, ...SCENE]);

  console.log("NT-36: Keep gives immediate feedback while Convex is reconnecting");
  await fresh();
  await typeNotes();
  await turn();
  await h(() => window.reviewHarness.holdMutation("ai/opLog:appendBatch"));
  check("one change is ready to keep", await pressHunk("Keep this change"), 1);
  await page.waitForFunction(
    () => window.reviewHarness.mutationBlocked("ai/opLog:appendBatch"),
    { timeout: 5000 },
  );
  check(
    "the hunk and whole-review controls say the answer is being saved",
    await h(() => ({
      inline: [...document.querySelectorAll('button[aria-label="Keeping this change"]')].map(
        (button) => ({ disabled: button.disabled, busy: button.getAttribute("aria-busy") }),
      ),
      bar: [...document.querySelectorAll("#bar button")].map((button) => ({
        text: button.textContent.trim(),
        disabled: button.disabled,
      })),
      answering: window.reviewHarness.answering().map(({ verdict }) => verdict),
      open: window.reviewHarness.open(),
    })),
    {
      inline: [{ disabled: true, busy: "true" }],
      bar: [
        { text: "Keeping…", disabled: true },
        { text: "Discard all", disabled: true },
        { text: "Revert", disabled: true },
      ],
      answering: ["accepted"],
      open: 1,
    },
  );
  await h(() => window.reviewHarness.releaseMutation("ai/opLog:appendBatch"));
  await settled();
  check("the delayed Keep lands once, without another click", await texts(), [...HEAD, ...SCENE]);
  check("the accepted ops are logged once", await h(() => window.reviewHarness.opLog()), 1);

  console.log("the change's own Keep button, then ⌘Z");
  await fresh();
  await typeNotes();
  await turn();
  check("one change, one Keep button", await pressHunk("Keep this change"), 1);
  await settled();
  check("keeping the change keeps it", await texts(), [...HEAD, ...SCENE]);
  await clickEnd(0);
  await undo();
  check("⌘Z brings the notes back", await texts(), [...HEAD, ...NOTES]);

  console.log("keep one change, discard the other, then ⌘Z");
  await fresh();
  await typeNotes();
  await turn("agentTwoChanges");
  const LOGLINE = "paragraph:Logline: a letter from childhood, read aloud.";
  check("two changes on the page", await texts(), [HEAD[0], LOGLINE, HEAD[1], ...SCENE]);
  check("two Keep buttons", await pressHunk("Keep this change"), 2);
  await sleep(300);
  await pressHunk("Discard this change");
  await settled();
  check("the logline stays and the notes come back", await texts(), [HEAD[0], LOGLINE, HEAD[1], ...NOTES]);
  await clickEnd(0);
  await undo();
  check("⌘Z takes back the logline and leaves the notes", await texts(), [...HEAD, ...NOTES]);
  await redo();
  check("⌘⇧Z writes the logline again", await texts(), [HEAD[0], LOGLINE, HEAD[1], ...NOTES]);
  await undo();
  await undo();
  check("the next ⌘Z reaches the person's own typing", await texts(), [...HEAD, ...NOTES.slice(0, 2), "paragraph:"]);

  console.log("a kept diagram change, then ⌘Z");
  const shapes = (at = false) => h((a) => window.reviewHarness.diagram(a), at);
  const privately = (at = false) => h((a) => window.reviewHarness.diagramPrivacy(a), at);
  const everywhere = (ids) => ({ prop: ids, maps: ids, peer: ids, shown: ids });
  /** What a collaborator can read of the diagram: the shared doc's maps, their own, and their copy of the mirror. */
  const seenByOthers = async (at = false) => {
    const { maps, peer } = await shapes(at);
    return { maps, peer, mirror: (await privately(at)).peerMirror };
  };
  const freshDiagram = async () => {
    await h(() => window.reviewHarness.mount());
    await page.waitForSelector(".bn-editor");
    await h(() => window.reviewHarness.seedDiagram());
    await page.waitForFunction(() => window.reviewHarness.diagram()?.shown != null, { timeout: 10000 });
    await page.waitForFunction(() => window.reviewHarness.stacks() !== null);
    await sleep(300);
  };
  await freshDiagram();
  check("the diagram starts with one shape", await shapes(), everywhere(["a"]));
  await turn("agentDiagram");
  await sleep(300);
  check("under review, the surface shows the proposal", (await shapes()).shown, ["a", "b"]);
  check("…from the review's fork", (await privately()).fork, ["a", "b"]);
  check("…and nothing a collaborator can read has it yet", await seenByOthers(), { maps: ["a"], peer: ["a"], mirror: ["a"] });
  await press("Keep all");
  await settled();
  await sleep(300);
  check("kept: the prop, the maps, the collaborator and the surface all hold both shapes", await shapes(), everywhere(["a", "b"]));
  // A kept diagram change is one step: its maps travel in the fork with its
  // mirror, and ⌘Z takes both back together.
  await clickText(0, 3);
  await undo();
  await sleep(300);
  check("⌘Z takes the kept shape back from every reader", await shapes(), everywhere(["a"]));
  await redo();
  await sleep(300);
  check("⌘⇧Z puts it back everywhere", await shapes(), everywhere(["a", "b"]));
  // Past the mirror's trail, which writes the surface back onto the prop.
  await sleep(5600);
  check("…and the mirror's trail agrees", await shapes(), everywhere(["a", "b"]));

  console.log("Revert, then typing");
  await fresh();
  await typeNotes();
  await turn();
  await press("Revert");
  await page.waitForFunction(() => window.reviewHarness.open() === 0, { timeout: 5000 });
  await sleep(250);
  check("Revert puts the notes back", await texts(), [...HEAD, ...NOTES]);
  check("Revert ends the fork", await forked(), false);
  await clickEnd(0);
  await page.keyboard.type(" v2", { delay: 5 });
  await sleep(BETWEEN_NOTES);
  check("typing after Revert reaches the shared doc", (await h(() => window.reviewHarness.peerTexts()))[0], "heading:Enactus intro reel v2");

  const clickOn = async (handle) => {
    const box = await handle.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  };
  /** Until the session has nothing queued — a rewind is several awaits long. */
  const idle = () => h(() => window.reviewHarness.idle()).then(() => sleep(250));
  const status = (id) => h((i) => window.reviewHarness.status(i), id);
  const open = () => h(() => window.reviewHarness.open());
  const conversation = () => h(() => window.reviewHarness.messages());
  /** The question's Rewind menu in the chat rail, and one of its options. */
  const rewindTo = async (option) => {
    // The menu form of the button, which only a question that changed a page has.
    const trigger = await page.waitForSelector('#chat .nt-turn.is-user button.nt-rewind[aria-haspopup="menu"]', { timeout: 5000 });
    await clickOn(trigger);
    const [item] = await page.$$(`xpath/.//div[@role="menu"]//button[@role="menuitem"][.//span[normalize-space()="${option}"]]`);
    if (!item) throw new Error(`no "${option}" in the Rewind menu`);
    await clickOn(item);
    await idle();
  };
  const DRAFT = 'textarea[aria-label="Edit this message and rewind to it"]';
  const drafting = async () => (await page.$(DRAFT)) !== null;
  const rewindAction = async (label) => {
    const [button] = await page.$$(`xpath/.//div[contains(@class,"nt-rewind-actions")]//button[normalize-space()="${label}"]`);
    if (!button) throw new Error(`no ${label} button on the rewind`);
    await clickOn(button);
    await idle();
  };
  /** Empties the question — "put it back and ask nothing" — and confirms. */
  const confirmRewind = async () => {
    // Backspaced away from its end: headless Chromium on macOS does not run
    // ⌘A's select-all for synthesized keys.
    await clickOn(await page.$(DRAFT));
    await page.keyboard.press("End");
    const length = await page.$eval(DRAFT, (el) => el.value.length);
    for (let i = 0; i < length; i++) await page.keyboard.press("Backspace");
    await sleep(80);
    await rewindAction("Rewind");
  };
  const typeAtTitle = async (value) => {
    await clickEnd(0);
    await page.keyboard.type(value, { delay: 5 });
    await sleep(BETWEEN_NOTES);
  };

  console.log("NT-44: Keep all, then Rewind › Notes only, then ⌘Z");
  await fresh();
  await typeNotes();
  const keptThenRewound = await turn();
  await press("Keep all");
  await settled();
  await rewindTo("Notes only");
  check("the rewind puts the notes back", await texts(), [...HEAD, ...NOTES]);
  check("…for the collaborator too", await peer(), [...HEAD, ...NOTES]);
  check("…the kept turn is answered no", await status(keptThenRewound), "rejected");
  check("…and the conversation stays", await conversation(), 2);
  await clickEnd(0);
  await undo();
  check("⌘Z after the rewind leaves the page whole", await texts(), [...HEAD, ...NOTES]);
  check("…on the collaborator's side too", await peer(), [...HEAD, ...NOTES]);
  await redo();
  check("…and so does ⌘⇧Z", [await texts(), await peer()], [[...HEAD, ...NOTES], [...HEAD, ...NOTES]]);
  await typeAtTitle(" v2");
  check("typing after the rewind is written", await texts(), ["heading:Enactus intro reel v2", HEAD[1], ...NOTES]);
  await undo();
  check("⌘Z takes back that typing and nothing else", await texts(), [...HEAD, ...NOTES]);
  check("nothing reported a failure", await h(() => window.reviewHarness.failure()), null);

  console.log("NT-44: Rewind › Notes only, while the change is still under review");
  await fresh();
  await typeNotes();
  const pendingThenRewound = await turn();
  await rewindTo("Notes only");
  check("the rewind puts the notes back", await texts(), [...HEAD, ...NOTES]);
  check("…ends the review and its fork", [await open(), await forked()], [0, false]);
  check("…the collaborator never saw the change", await peer(), [...HEAD, ...NOTES]);
  check("…the turn is answered no", await status(pendingThenRewound), "rejected");
  check("…and the conversation stays", await conversation(), 2);
  await clickEnd(0);
  await undo();
  check("⌘Z still reaches the person's own typing", await texts(), [...HEAD, ...NOTES.slice(0, 2), "paragraph:"]);

  console.log("NT-44: Keep all, then Rewind › Notes and conversation");
  await fresh();
  await typeNotes();
  const keptThenBoth = await turn();
  await press("Keep all");
  await settled();
  await rewindTo("Notes and conversation");
  check("the rewind is shown before it is agreed to", [await texts(), await drafting()], [[...HEAD, ...NOTES], true]);
  await confirmRewind();
  check("confirmed, the notes stay back", await texts(), [...HEAD, ...NOTES]);
  check("…for the collaborator too", await peer(), [...HEAD, ...NOTES]);
  check("…the exchange is gone", await conversation(), 0);
  check("…and the turn is answered no", await status(keptThenBoth), "rejected");
  await clickEnd(0);
  await undo();
  check("⌘Z after the rewind leaves the page whole", [await texts(), await peer()], [[...HEAD, ...NOTES], [...HEAD, ...NOTES]]);

  console.log("NT-44: Keep all, then Rewind › Notes and conversation, then Cancel");
  await fresh();
  await typeNotes();
  const keptThenCancelled = await turn();
  await press("Keep all");
  await settled();
  await rewindTo("Notes and conversation");
  check("the rewind is shown", await texts(), [...HEAD, ...NOTES]);
  await rewindAction("Cancel");
  check("Cancel puts the kept change back", await texts(), [...HEAD, ...SCENE]);
  check("…for the collaborator too", await peer(), [...HEAD, ...SCENE]);
  check("…the exchange stays", await conversation(), 2);
  check("…and the turn stays kept", await status(keptThenCancelled), "accepted");
  await clickEnd(0);
  await undo();
  check("⌘Z after the cancelled rewind leaves the page whole", [await texts(), await peer()], [[...HEAD, ...SCENE], [...HEAD, ...SCENE]]);

  console.log("NT-44: Rewind › Notes and conversation, while the change is still under review");
  await fresh();
  await typeNotes();
  const pendingThenBoth = await turn();
  await rewindTo("Notes and conversation");
  check("the rewind is shown inside the review's fork", [await texts(), await forked(), await peer()], [[...HEAD, ...NOTES], true, [...HEAD, ...NOTES]]);
  await rewindAction("Cancel");
  check("Cancel gives the change back to its review", [await texts(), await open(), await forked()], [[...HEAD, ...SCENE], 1, true]);
  check("…which the collaborator still has not seen", await peer(), [...HEAD, ...NOTES]);
  await rewindTo("Notes and conversation");
  await confirmRewind();
  check("confirmed, the notes are back and the fork is gone", [await texts(), await open(), await forked()], [[...HEAD, ...NOTES], 0, false]);
  check("…the collaborator never saw the change", await peer(), [...HEAD, ...NOTES]);
  check("…the exchange is gone", await conversation(), 0);
  check("…and the turn is answered no", await status(pendingThenBoth), "rejected");
  await clickEnd(0);
  await undo();
  check("⌘Z still reaches the person's own typing", await texts(), [...HEAD, ...NOTES.slice(0, 2), "paragraph:"]);

  /** A shape dragged across the diagram by the pointer, the way a person moves one. */
  const dragShape = async (id, dx, dy) => {
    const from = await h((i) => window.reviewHarness.shapePoint(i), id);
    if (!from) throw new Error(`no shape ${id} on the surface`);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(from.x + (dx * step) / 8, from.y + (dy * step) / 8);
      await sleep(16);
    }
    await page.mouse.up();
    await sleep(100);
  };
  const sharedAndShown = async (at = false) => {
    const { maps, peer, shown } = await shapes(at);
    return { maps, peer, shown };
  };

  console.log("NT-43: a diagram change under review, then Discard all");
  await freshDiagram();
  await turn("agentDiagram");
  await sleep(300);
  check("the proposal is on the surface, from the review's fork", [(await shapes()).shown, (await privately()).fork], [["a", "b"], ["a", "b"]]);
  check("…and nothing a collaborator can read has it", await seenByOthers(), { maps: ["a"], peer: ["a"], mirror: ["a"] });
  await press("Discard all");
  await settled();
  await sleep(300);
  check("Discard all takes the shape back from every reader", await shapes(), everywhere(["a"]));
  check("…the collaborator's copy of the mirror included", (await privately()).peerMirror, ["a"]);
  // Past the mirror's trail, which writes the surface back onto the prop.
  await sleep(5600);
  check("…and the mirror's trail does not bring it back", await shapes(), everywhere(["a"]));
  await clickText(0, 3);
  await undo();
  await sleep(300);
  check("⌘Z after the discard does not bring it back either", await shapes(), everywhere(["a"]));

  console.log("NT-43: a diagram change's own Discard button");
  await freshDiagram();
  await turn("agentDiagram");
  await sleep(300);
  check("one change, one Discard button", await pressHunk("Discard this change"), 1);
  await settled();
  await sleep(300);
  check("discarding it takes the shape back from every reader", await shapes(), everywhere(["a"]));

  console.log("NT-43: a diagram change under review, then Revert");
  await freshDiagram();
  await turn("agentDiagram");
  await sleep(300);
  await press("Revert");
  await page.waitForFunction(() => window.reviewHarness.open() === 0 && !window.reviewHarness.forked(), { timeout: 5000 });
  await sleep(300);
  check("Revert takes the shape back from every reader", await shapes(), everywhere(["a"]));
  check("…and the collaborator's copy of the mirror never had it", (await privately()).peerMirror, ["a"]);

  console.log("NT-43: a collaborator draws while a diagram change is under review, then Keep all");
  await freshDiagram();
  await turn("agentDiagram");
  await sleep(300);
  await h(() => window.reviewHarness.peerDraws("c"));
  await sleep(300);
  check("the collaborator's shape reaches the shared doc, and the proposal does not", await seenByOthers(), { maps: ["a", "c"], peer: ["a", "c"], mirror: ["a"] });
  await press("Keep all");
  await settled();
  await sleep(300);
  check("kept: both people's shapes are in every map and on the surface", await sharedAndShown(), { maps: ["a", "b", "c"], peer: ["a", "b", "c"], shown: ["a", "b", "c"] });

  console.log("NT-43: moving a shape while a diagram change is under review, then Keep all");
  await freshDiagram();
  await turn("agentDiagram");
  await sleep(300);
  const unmoved = (await shapes(true)).shown;
  await dragShape("a", 80, 0);
  // Past the store's flush into the maps; well inside the mirror's trail.
  await sleep(800);
  const moved = (await shapes(true)).shown;
  check("the drag moved the shape", moved.length === 2 && moved[0] !== unmoved[0], true);
  check("…in the review's fork", (await privately(true)).fork, moved);
  check("…and nothing a collaborator can read has the move or the proposal", await seenByOthers(true), { maps: ["a@0"], peer: ["a@0"], mirror: ["a@0"] });
  await press("Keep all");
  await settled();
  await sleep(300);
  check("kept: the move and the new shape reach every map", await sharedAndShown(true), { maps: moved, peer: moved, shown: moved });
  await sleep(5600);
  check("…and the mirror follows them", await shapes(true), everywhere(moved));

  console.log("NT-43: Keep a diagram change, then Rewind › Notes only");
  await freshDiagram();
  await turn("agentDiagram");
  await sleep(300);
  await press("Keep all");
  await settled();
  await sleep(300);
  await rewindTo("Notes only");
  await sleep(300);
  check("the rewind takes the shape back from every reader", await shapes(), everywhere(["a"]));

  console.log("NT-43: Rewind › Notes only while a diagram change is under review");
  await freshDiagram();
  await turn("agentDiagram");
  await sleep(300);
  await rewindTo("Notes only");
  await sleep(300);
  check("the rewind takes the shape back from every reader, and ends the fork", [await shapes(), await forked()], [everywhere(["a"]), false]);

  // NT-39: one day of the reporter's itinerary, with a bold run in a cell so a
  // marked word has to land past a mark boundary.
  const plain = (value) => ({ type: "text", text: value });
  const bold = (value) => ({ type: "text", text: value, marks: ["bold"] });
  const ITINERARY = [
    ["Time", "Activity", "Notes"],
    ["2:00 PM", [plain("Depart "), bold("Vancouver")], "Head south early to clear the border."],
    ["4:30 PM", "Dinner in Lynnwood", "Quick, popular stop for a road-trip kick-off dinner."],
    ["6:30 PM", "Check in at Embassy Suites", "Unwind, settle in, and enjoy the pool."],
  ];
  const cellText = (cell) => (typeof cell === "string" ? cell : cell.map((run) => run.text).join(""));
  const asText = (rows) => rows.map((cells) => cells.map(cellText));
  const withCell = (rows, r, c, cell) => rows.map((cells, i) => (i === r ? cells.map((old, j) => (j === c ? cell : old)) : cells));
  const MEAL = "Quick, popular stop for a road-trip kick-off meal.";
  /** Two cells rewritten in part: words added after the bold run, and one word swapped. */
  const PARTIAL = withCell(withCell(ITINERARY, 1, 1, [plain("Depart "), bold("Vancouver"), plain(" at noon")]), 2, 2, MEAL);
  const TRANSPARENT = "rgba(0, 0, 0, 0)";
  const NOTHING = { tone: null, ins: [], del: [], cells: [] };

  const table = (index = 0) => h((i) => window.reviewHarness.drawnTable(i), index);
  const tableRows = (index = 0) => h((i) => window.reviewHarness.tableRows(i), index);
  const underReview = () => h(() => window.reviewHarness.open());
  /** The marks and where they sit — `drawn` without the computed colour. */
  const marks = ({ tone, ins, del, cells }) => ({ tone, ins, del, cells });
  const freshTable = async () => {
    await h(() => window.reviewHarness.mount());
    await page.waitForSelector(".bn-editor");
    await h((rows) => window.reviewHarness.seedTable(rows), ITINERARY);
    await page.waitForFunction(() => window.reviewHarness.cellEnd(1, 1) !== null);
    await page.waitForFunction(() => window.reviewHarness.stacks() !== null);
    await sleep(100);
  };

  console.log("NT-39: an agent rewrites a few words of a table");
  await freshTable();
  await turn("agentTable", PARTIAL);
  check("the rewrite is on the page, under review", [await tableRows(), await underReview()], [asText(PARTIAL), 1]);
  const partial = await table();
  check("…the table is not washed as if all of it were new", [partial.tone, partial.wash], ["edit", TRANSPARENT]);
  check("…the words it wrote are marked, the word it replaced is struck, and no other cell is touched", marks(partial), {
    tone: "edit",
    ins: [" at noon", "meal."],
    del: ["dinner."],
    cells: ["1:1", "2:2"],
  });
  await clickEnd(0);
  await page.keyboard.type(" (day one)", { delay: 5 });
  await sleep(300);
  check("typing above the table leaves the marks on the same words", marks(await table()), marks(partial));
  check("one change, one Keep button", await pressHunk("Keep this change"), 1);
  await settled();
  check("keeping it keeps the rewrite", await tableRows(), asText(PARTIAL));
  check("…and nothing is drawn on the table any more", marks(await table()), NOTHING);

  console.log("NT-39: Discard all on a partly rewritten table");
  await freshTable();
  await turn("agentTable", PARTIAL);
  await press("Discard all");
  await settled();
  check("Discard all puts the table's words back", await tableRows(), asText(ITINERARY));
  check("…and nothing is drawn on it", marks(await table()), NOTHING);

  console.log("NT-39: typing into a rewritten cell while it is under review");
  await freshTable();
  await turn("agentTable", PARTIAL);
  const cellEnd = await h(() => window.reviewHarness.cellEnd(2, 2));
  await page.mouse.click(cellEnd.x, cellEnd.y);
  await sleep(80);
  await page.keyboard.type(" Cheap.", { delay: 5 });
  await sleep(300);
  check("the typing lands in that cell", await tableRows(), asText(withCell(PARTIAL, 2, 2, `${MEAL} Cheap.`)));
  check("…and the change is theirs now: nothing marked, no Discard", [marks(await table()), (await page.$$('button[aria-label="Discard this change"]')).length], [{ ...NOTHING, tone: "kept" }, 0]);

  console.log("NT-39: an agent empties a cell");
  await freshTable();
  await turn("agentTable", withCell(ITINERARY, 3, 2, ""));
  check("the words it took out are struck in the empty cell, and nowhere else", marks(await table()), {
    tone: "edit",
    ins: [],
    del: ["Unwind, settle in, and enjoy the pool."],
    cells: ["3:2"],
  });

  console.log("NT-39: an agent adds a row at the end");
  await freshTable();
  await turn("agentTable", [...ITINERARY, ["8:00 PM", "Swim", ""]]);
  check("only the new row's words are marked", marks(await table()), { tone: "edit", ins: ["8:00 PM", "Swim"], del: [], cells: ["4:0", "4:1"] });

  console.log("NT-39: an agent adds a row in the middle");
  await freshTable();
  await turn("agentTable", [ITINERARY[0], ["1:00 PM", "Lunch at the border", ""], ...ITINERARY.slice(1)]);
  check("only the new row's words are marked, not the rows it pushed down", marks(await table()), {
    tone: "edit",
    ins: ["1:00 PM", "Lunch at the border"],
    del: [],
    cells: ["1:0", "1:1"],
  });

  console.log("NT-39: an agent rewrites a cell and adds a row");
  await freshTable();
  await turn("agentTable", [...withCell(ITINERARY, 2, 2, MEAL), ["8:00 PM", "Swim", "Hotel pool"]]);
  check("the rewritten words and the new row are marked, and nothing else", marks(await table()), {
    tone: "edit",
    ins: ["meal.", "8:00 PM", "Swim", "Hotel pool"],
    del: ["dinner."],
    cells: ["2:2", "4:0", "4:1", "4:2"],
  });

  console.log("NT-39: an agent takes a row out, or adds a column");
  await freshTable();
  await turn("agentTable", ITINERARY.slice(0, 3));
  const cut = await table();
  check("a row taken out cannot be drawn inside the grid, so the table is washed whole", [marks(cut), cut.wash !== TRANSPARENT], [{ ...NOTHING, tone: "whole" }, true]);
  await freshTable();
  await turn("agentTable", ITINERARY.map((cells, i) => [...cells, i ? "" : "Cost"]));
  check("a column added reshapes every row, so the table is washed whole", marks(await table()), { ...NOTHING, tone: "whole" });

  console.log("NT-39 controls: a table written from nothing, and a rewritten line");
  await freshTable();
  await turn("agentNewTable", ITINERARY.slice(0, 2));
  const added = await table(1);
  check("a table the agent wrote from nothing is washed whole", [marks(added), added.wash !== TRANSPARENT], [{ ...NOTHING, tone: "add" }, true]);
  check("…and the table already there is left alone", marks(await table(0)), NOTHING);
  await freshTable();
  await turn("agentLine", "Drive: ~3 hrs (subject to border wait)");
  const line = await h(() => window.reviewHarness.drawnLine("Drive:"));
  check("a rewritten line has its words marked, and no wash", [marks(line), line.wash], [{ tone: "edit", ins: ["~3"], del: ["~2.5"], cells: [] }, TRANSPARENT]);
  check("nothing reported a failure", await h(() => window.reviewHarness.failure()), null);
} finally {
  await browser?.close();
  server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} failure(s)`);
  for (const failure of failures) console.log(`- ${failure}`);
  process.exit(1);
}
console.log("\nall checks passed");
