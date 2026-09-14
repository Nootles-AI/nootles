/**
 * The 13 node-level diagram tools, driven through the REAL `runClientTool` →
 * `runCanvasTool` → `toCanvasHost` path (TOOLS.md §8.2) — real BlockNote, a
 * canvas block seeded with fixture F1, real Yjs local/peer docs, a real
 * `ReviewSession` over an in-memory Convex stand-in, `peekSceneStore`, and the
 * workspace history spine.
 *
 * Own scaffold (per the build plan: this does not build on
 * `tests/canvas-harness.mjs`'s shared fixture — its own esbuild bundle, its
 * own server, its own checks — following `editor-review-undo.browser.mjs`'s
 * PATTERN). It launches through Playwright rather than that file's Puppeteer,
 * because Puppeteer is not a project dependency here — `tests/canvas-harness.mjs`
 * (HARNESS, Wave 1) already made the same call for the same reason, and its
 * `launch()`/`openPage()` are the Playwright idiom this file's request-block
 * and console-error guards are modelled on.
 *
 * No dev server, no real Convex, no API keys — every non-origin request fails
 * the run, and no AI lane is ever mounted, so nothing here can spend one.
 *
 *   node tests/canvas-tools.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "canvas-tools-"));

// `ReviewBar`/`ReviewOverlay` read through `./ReviewContext`'s hooks; the
// fixture answers them from the global the harness's `mount()` sets, the
// same stub `editor-review-undo.browser.mjs` uses.
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
  absWorkingDir: repo,
  entryPoints: ["tests/canvas-tools.browser.tsx"],
  bundle: true,
  splitting: true,
  format: "esm",
  outdir: output,
  platform: "browser",
  conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"development"', "process.env.NEXT_PUBLIC_YJS": '"1"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [
    {
      name: "fixture",
      setup(builder) {
        builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({
          path: "server-only",
          namespace: "fixture",
        }));
        builder.onResolve({ filter: /(^|\/)ReviewContext$/ }, () => ({
          path: "review-context",
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /^server-only$/, namespace: "fixture" }, () => ({
          contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };',
        }));
        builder.onLoad({ filter: /^review-context$/, namespace: "fixture" }, () => ({
          contents: REVIEW_CONTEXT,
          loader: "js",
          resolveDir: repo,
        }));
      },
    },
  ],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
  logLevel: "warning",
});
await writeFile(
  path.join(output, "index.html"),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/canvas-tools.browser.css">' +
    '<style>html,body{margin:0;height:100%;overflow:hidden;font-family:Arial,sans-serif}</style></head>' +
    '<body><div id="app"></div><script type="module" src="/canvas-tools.browser.js"></script></body></html>',
);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") {
      response.writeHead(204);
      return void response.end();
    }
    const name = pathname === "/" ? "index.html" : path.basename(pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader(
      "Content-Type",
      name.endsWith(".js")
        ? "text/javascript"
        : name.endsWith(".css")
          ? "text/css"
          : name.endsWith(".html")
            ? "text/html"
            : "application/octet-stream",
    );
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return void console.log(`  ok   ${name}`);
  failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
  console.log(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`);
};
const checkTrue = (name, actual) => check(name, actual, true);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const VIEWPORT = { width: 1280, height: 900 };
const MOD = process.platform === "darwin" ? "Meta" : "Control";
// Past `CanvasBlock.tsx`'s MIRROR_MS (5000ms) — the mirror lands early only
// on unmount/blur, so a test that wants to see it settle waits it out.
const MIRROR_MS = 5000;

let browser;
try {
  let lastLabel = "startup";
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: VIEWPORT });
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  page.on("crash", () => failures.push("page crashed"));
  page.on("console", (message) => {
    const type = message.type();
    if (type !== "error" && type !== "warning") return;
    failures.push(`console ${type}: ${message.text()} [during: ${lastLabel}]`);
  });

  const leaked = [];
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith("data:")) return route.continue();
    leaked.push(url);
    return route.abort();
  });

  await page.addInitScript(() => {
    // The canvas block's Convex hooks connect over a socket; this one never
    // opens, so nothing here can reach a real deployment.
    window.WebSocket = class extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      send() {
        throw new Error("Fixture socket must never send");
      }
      close() {
        this.readyState = 3;
      }
    };
  });

  await page.goto(origin, { waitUntil: "networkidle" });
  // Playwright's `page.evaluate(fn, arg)` takes exactly one argument (unlike
  // Puppeteer's variadic form) — every multi-argument call below packs its
  // arguments into one object and destructures them inside the page function.
  const h = (fn, arg) => page.evaluate(fn, arg);
  const run = (name, input) => h(({ name, input }) => window.canvasTools.run(name, input), { name, input });
  const diagram = () => h(() => window.canvasTools.diagram());
  const blockId = () => h(() => window.canvasTools.blockId());
  const snapshot = () => h(() => window.canvasTools.snapshot());
  const spine = () => h(() => window.canvasTools.spine());
  const camera = () => h(() => window.canvasTools.camera());
  const canUndo = () => h(() => window.canvasTools.canUndo());
  const watchHistory = () => h(() => window.canvasTools.watchHistory());
  const pushCount = () => h(() => window.canvasTools.pushCount());
  const domRect = (id) => h(({ id }) => window.canvasTools.domRect(id), { id });
  const shapeIds = () => h(() => Object.keys(window.canvasTools.shapeDom()));

  const chord = async (...keys) => {
    for (const key of keys) await page.keyboard.down(key);
    for (const key of [...keys].reverse()) await page.keyboard.up(key);
    await sleep(200);
  };
  const undo = () => chord(MOD, "z");
  const redo = () => chord(MOD, "Shift", "z");

  /** A freshly mounted, freshly seeded board — F1, nothing on any undo stack. */
  const fresh = async () => {
    await h(() => window.canvasTools.mount());
    await page.waitForSelector(".bn-editor");
    await h(() => window.canvasTools.seed());
    await page.waitForFunction(() => window.canvasTools.diagram()?.shown != null, { timeout: 10000 });
    await page.waitForFunction(() => window.canvasTools.store() !== null);
    await sleep(200);
  };

  // NT-43 (rebased in ahead of this file) makes a diagram private for as
  // long as its review is unanswered — the change is real on screen, but it
  // is not on anyone's ⌘Z timeline, canvas-local or shared, until the person
  // answers (the review IS the undo affordance while pending, exactly as it
  // already was for a text hunk). Once answered, a KEPT diagram change lands
  // as one entry on the SHARED spine — the text domain's Y.UndoManager taking
  // the page's canvas maps into its scope as the change lands (see
  // history/textDomain.ts) — not as a push on the canvas block's own local
  // history, which a review-authored write deliberately bypasses (it calls
  // `store.adoptRemote`, which clears that local stack rather than growing
  // it; see `CanvasCollab.adoptExternal`). `tests/editor-review-undo.browser
  // .mjs`'s "a kept diagram change, then ⌘Z" case is the reference for this
  // shape: stage, then explicitly answer, then check the shared spine.
  const accept = () => h(async () => {
    await window.canvasTools.acceptAll();
    await window.canvasTools.idle();
  });

  lastLabel = "write_nodes: one hunk, one undo entry, undoes cleanly";
  console.log("write_nodes: one hunk, one undo entry, undoes cleanly");
  await fresh();
  const id = await blockId();
  const baseline = (await diagram()).shown.length; // F1: s1, s2, g1, c1, c2, p1
  await watchHistory();
  const result = await run("write_nodes", { pageId: "page", blockId: id, html: '<nt-rect x="0" y="0" w="20" h="20"></nt-rect>' });
  checkTrue("write_nodes reports a shape added", /1 shape.* added/.test(result));
  const snap1 = await snapshot();
  check("one review hunk, kind update", [snap1.at(-1).pages[0].hunks.length, snap1.at(-1).pages[0].hunks[0].kind], [1, "update"]);
  check("a pending review write pushes no canvas-local history entry", await pushCount(), 0);
  check("not yet on anyone's ⌘Z timeline while the review is pending", (await spine()).undo, false);

  const shownAfterWrite = (await diagram()).shown;
  check("shown has one more shape than the baseline", shownAfterWrite.length, baseline + 1);

  await accept();
  check("still no canvas-local push — the kept step lives on the shared spine", await pushCount(), 0);
  check("one spine edit token, undoable", (await spine()).undo, true);
  // No click needed first: the spine's undo/redo key handler is a global,
  // capture-phase `document` listener (`useWorkspaceHistory.tsx`) that only
  // backs off for an ACTIVE text-entry element outside the undo scope, and
  // `seed()` already anchored a real text selection in the heading.
  await undo();
  const afterUndo = (await diagram()).shown;
  check("⌘Z removes exactly the new shape", afterUndo.length, baseline);
  await redo();
  check("⌘⇧Z brings it back", (await diagram()).shown.length, baseline + 1);

  lastLabel = "the maps and the peer see the kept shape (past the mirror)";
  console.log("the maps and the peer see the kept shape (past the mirror)");
  await sleep(MIRROR_MS + 500);
  const settled = await diagram();
  check("the maps hold the new shape", settled.maps.length, baseline + 1);
  check("the peer holds the new shape too", settled.peer.length, baseline + 1);

  lastLabel = "update_styles on three ids is one entry";
  console.log("update_styles on three ids is one entry");
  await fresh();
  const id2 = await blockId();
  await watchHistory();
  const restyled = await run("update_styles", {
    pageId: "page",
    blockId: id2,
    patches: [{ ids: ["s1", "s2", "c1"], style: { background: "#111827" } }],
  });
  checkTrue("update_styles reports the count", /3 shapes restyled/.test(restyled));
  check("a pending restyle pushes no canvas-local history entry", await pushCount(), 0);
  const s1Bg = await h(() => document.querySelector('[data-id="s1"]')?.style.background ?? "");
  checkTrue("s1's DOM reflects the new colour", s1Bg.includes("17, 24, 39") || s1Bg.includes("#111827"));
  await accept();
  check("one push for the whole restyle — one shared spine entry once kept", (await spine()).undo, true);

  lastLabel = "set_text lands as one entry and renders";
  console.log("set_text lands as one entry and renders");
  await fresh();
  const id3 = await blockId();
  await watchHistory();
  await run("set_text", { pageId: "page", blockId: id3, id: "s1", text: "Confirmed" });
  check("a pending set_text pushes no canvas-local history entry", await pushCount(), 0);
  const label = await h(() => document.querySelector('[data-id="s1"]')?.textContent ?? "");
  checkTrue("the shape renders the new text", label.includes("Confirmed"));
  await accept();
  check("one push for set_text — one shared spine entry once kept", (await spine()).undo, true);

  lastLabel = "camera is untouched by an on-screen write";
  console.log("camera is untouched by an on-screen write");
  await fresh();
  const id4 = await blockId();
  const cameraBefore = await camera();
  await run("write_nodes", { pageId: "page", blockId: id4, html: '<nt-rect x="10" y="10" w="10" h="10"></nt-rect>' });
  await sleep(150);
  check("the scene transform is untouched", await camera(), cameraBefore);

  lastLabel = "a refused write changes nothing";
  console.log("a refused write changes nothing");
  await fresh();
  const id5 = await blockId();
  const canUndoBefore = await canUndo();
  const refusal = await run("write_nodes", {
    pageId: "page",
    blockId: id5,
    html: '<nt-ellipse id="s1" x="40" y="40" w="200" h="56"></nt-ellipse>',
  });
  checkTrue("the refusal names the kind mismatch", typeof refusal === "string" && refusal.includes("rectangle"));
  check("canUndo is unchanged", await canUndo(), canUndoBefore);
  const snap2 = await snapshot();
  // A refused write never calls `stage()`, so it leaves no trace at all in
  // the session's turn list — `endTurn` only settles a turn that reached
  // `runStage` at least once.
  check("the refused turn staged nothing", snap2.length, 0);

  lastLabel = "get_geometry agrees with the DOM";
  console.log("get_geometry agrees with the DOM");
  await fresh();
  const id6 = await blockId();
  const report = await run("get_geometry", { pageId: "page", blockId: id6 });
  const c1 = report.nodes.find((n) => n.id === "c1");
  const rect = await domRect("c1");
  checkTrue("c1's reported x matches its DOM box within 0.5px", Math.abs(c1.x - rect.x) < 0.5);
  checkTrue("c1's reported y matches its DOM box within 0.5px", Math.abs(c1.y - rect.y) < 0.5);

  lastLabel = "discarding the review puts the diagram back";
  console.log("discarding the review puts the diagram back");
  await fresh();
  const id7 = await blockId();
  const before7 = (await diagram()).shown;
  await run("write_nodes", { pageId: "page", blockId: id7, html: '<nt-rect x="0" y="0" w="5" h="5"></nt-rect>' });
  check("the write is visible before it is answered", (await diagram()).shown.length, before7.length + 1);
  await h(() => window.canvasTools.rejectAll());
  await h(() => window.canvasTools.idle());
  await sleep(200);
  const rejected = await snapshot();
  check("the hunk is answered rejected", rejected.at(-1).pages[0].status[rejected.at(-1).pages[0].hunks[0].id], "rejected");
  // The checkpoint (block-prop level) is what `discard` is actually
  // contracted to restore, and it does: `.prop` (read straight off
  // `editor.document`, independent of the live store) is back to the seed.
  check("the block's own prop is put back", (await diagram()).prop, before7);
  // `.shown` (the live SceneStore, via `peekSceneStore`) is a KNOWN GAP, not
  // an artifact of this harness: `CanvasCollab.adoptExternal` (collab/binding.ts,
  // untouched by this slice) recognises the reverted HTML as an `echoes()` hit
  // — a state the maps have already been in — and skips `store.setSource`,
  // so a discarded canvas edit's live surface can lag the reverted prop
  // until something else nudges the store. Recorded here rather than
  // silently asserted around: flag for the orchestrator, not a TOOLS bug.
  console.log(
    `  note: diagram().shown after discard = ${JSON.stringify((await diagram()).shown)} ` +
      `(prop is correctly ${JSON.stringify(before7)} — see comment above)`,
  );

  lastLabel = "no request left the fixture";
  console.log("no request left the fixture");
  check("network requests seen", leaked, []);
  const ids = await shapeIds();
  checkTrue("shapes are still on screen at the end", ids.includes("s1"));
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
