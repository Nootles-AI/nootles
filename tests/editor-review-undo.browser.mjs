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

await build({
  absWorkingDir: repo, entryPoints: ["tests/editor-review-undo.browser.tsx"], bundle: true, splitting: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"development"', "process.env.NEXT_PUBLIC_YJS": '"1"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [{ name: "fixture", setup(builder) {
    builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({ path: "server-only", namespace: "fixture" }));
    builder.onResolve({ filter: /(^|\/)ReviewContext$/ }, () => ({ path: "review-context", namespace: "fixture" }));
    builder.onLoad({ filter: /^server-only$/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };' }));
    builder.onLoad({ filter: /^review-context$/, namespace: "fixture" }, () => ({ contents: REVIEW_CONTEXT, loader: "js", resolveDir: repo }));
  } }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
});
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/editor-review-undo.browser.css"><style>html,body{margin:0;height:100%;overflow:hidden;font-family:Arial,sans-serif}</style></head><body><div id="app"></div><script type="module" src="/editor-review-undo.browser.js"></script></body></html>`);

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
  const turn = async (kind = "agentReplace") => {
    const composer = await page.$("#composer");
    const box = await composer.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.type("turn my notes into a storyboard", { delay: 2 });
    await sleep(100);
    const id = await h((name) => window.reviewHarness[name](), kind);
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
  const shapes = () => h(() => window.reviewHarness.diagram());
  const everywhere = (ids) => ({ prop: ids, maps: ids, peer: ids, shown: ids });
  await h(() => window.reviewHarness.mount());
  await page.waitForSelector(".bn-editor");
  await h(() => window.reviewHarness.seedDiagram());
  await page.waitForFunction(() => window.reviewHarness.diagram()?.shown != null, { timeout: 10000 });
  await page.waitForFunction(() => window.reviewHarness.stacks() !== null);
  await sleep(300);
  check("the diagram starts with one shape", await shapes(), everywhere(["a"]));
  await turn("agentDiagram");
  await sleep(300);
  check("under review, the surface shows the proposal", (await shapes()).shown, ["a", "b"]);
  await press("Keep all");
  await settled();
  await sleep(300);
  check("kept: the prop, the maps, the collaborator and the surface all hold both shapes", await shapes(), everywhere(["a", "b"]));
  // A diagram's maps reach the shared doc outside the fork, so its kept change
  // stays off the timeline rather than letting ⌘Z take back only the mirror.
  await clickText(0, 3);
  await undo();
  await sleep(300);
  check("⌘Z does not split the diagram from its mirror", await shapes(), everywhere(["a", "b"]));
  // Past the mirror's trail, which writes the surface back onto the prop.
  await sleep(5600);
  check("…nor does the mirror once it has trailed", await shapes(), everywhere(["a", "b"]));

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
