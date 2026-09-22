/**
 * The STAGE browser gate: the expanded stage, minimal UI, browser fullscreen
 * and the zoom tool's screen-mode plumbing, against a real `CanvasSurface` +
 * `Toolbar` + `LayersPanel` + `CanvasStylePanel` (`tests/canvas-stage.browser.tsx`).
 * Reuses `tests/canvas-harness.mjs`'s shared Playwright/esbuild scaffold;
 * builds its own bundle since that scaffold's `buildHarness()` is pinned to
 * the shared entry point (same pattern as `canvas-compile`/`canvas-color-pick`).
 *
 * This file replaces HARNESS's Wave-1 `todo`-only skeleton in place: every
 * case named there is now real (`check`), except the one the skeleton itself
 * flagged as genuinely opportunistic in headless Chromium — a real
 * `requestFullscreen()` call, which this run attempts for real and only
 * falls back to `todo` if headless actually refuses it.
 *
 *   node tests/canvas-stage.browser.mjs
 *
 * No dev server, no Convex, no API keys — every non-origin request fails the
 * run (see `canvas-harness.mjs`'s `openPage`).
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checker,
  launch,
  openPage,
  pretendApplePlatform,
  repo,
  writeAppStylesheet,
  writeArtifact,
} from "./canvas-harness.mjs";

const c = checker();

function rejectNextServerDiagnosticsPlugin() {
  return {
    name: "reject-next-server-diagnostics",
    setup(builder) {
      builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({
        path: "server-only",
        namespace: "fixture",
      }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };',
      }));
    },
  };
}

function contentTypeFor(name) {
  if (name.endsWith(".js") || name.endsWith(".mjs")) return "text/javascript";
  if (name.endsWith(".css")) return "text/css";
  if (name.endsWith(".html")) return "text/html";
  return "application/octet-stream";
}

async function buildStageHarness() {
  const output = await mkdtemp(path.join(tmpdir(), "canvas-stage-"));
  await build({
    absWorkingDir: repo,
    entryPoints: ["tests/canvas-stage.browser.tsx"],
    bundle: true,
    splitting: true,
    format: "esm",
    outdir: output,
    platform: "browser",
    conditions: ["browser", "import", "style"],
    tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"development"' },
    banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
    plugins: [rejectNextServerDiagnosticsPlugin()],
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
    logLevel: "warning",
  });

  await writeAppStylesheet(output);

  await writeFile(
    path.join(output, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8">' +
      '<link rel="stylesheet" href="/app.css">' +
      '<link rel="stylesheet" href="/canvas-stage.browser.css">' +
      '</head><body><div id="app"></div><script type="module" src="/canvas-stage.browser.js"></script></body></html>',
  );

  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      if (pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }
      const name = pathname === "/" ? "index.html" : path.basename(pathname);
      const data = await readFile(path.join(output, name));
      response.setHeader("Content-Type", contentTypeFor(name));
      response.end(data);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((resolve) => server.close(resolve)) };
}

function safeCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const close = (a, b, tol = 0.5) => Math.abs(a - b) < tol;

async function main() {
  const built = await buildStageHarness();
  const { browser } = await launch();
  try {
    const { page, guards } = await openPage(browser, built.origin, { viewport: { width: 1280, height: 900 } });
    // Every chord below (⌘⇧F, ⌘., ⌃⌘F) is written against the Apple
    // binding table.
    await pretendApplePlatform(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(built.origin, { waitUntil: "networkidle" });

    const evalMount = () => page.evaluate(() => window.stageHarness.mount());
    const H = (fn, ...args) => page.evaluate(fn, ...args);
    // A real wait rather than another `nextFrame()` round trip: this runner
    // launches Chromium with `--disable-frame-rate-limit --disable-gpu-vsync`
    // (`canvas-harness.mjs`'s `launch()`), which decouples `requestAnimationFrame`
    // from an actual paint — the dev-only self-check's own rAF (§3.1 step 6 of
    // STAGE.md) can otherwise fire against a layout Chromium has not finished
    // settling yet. A real browser's rAF has no such gap; this is a headless
    // timing accommodation, not evidence of a product bug.
    const settle = () => page.waitForTimeout(120);

    // -- stage.enter.keepsCentre ---------------------------------------------
    await evalMount();
    await H(() => window.stageHarness.focus());
    // The viewport as it stood before any of this file ever staged anything —
    // `stage.exit.restoresCamera` below needs this exact baseline, not the
    // already-staged one case 1 leaves behind.
    const vp0 = await H(() => window.stageHarness.viewport());
    const p0 = await H(() => window.stageHarness.centreScenePoint());
    const domBefore = await H(() => window.stageHarness.shapeDom());
    await H(() => window.stageHarness.resetCounters());
    await H(() => window.stageHarness.pressStageChord());
    await settle();
    const p1 = await H(() => window.stageHarness.centreScenePoint());
    c.check("stage.enter.keepsCentre: data-stage set", await H(() => window.stageHarness.dataStage()), true);
    c.check(
      "stage.enter.keepsCentre: scene point under the centre is unchanged",
      { x: close(p0.x, p1.x), y: close(p0.y, p1.y) },
      { x: true, y: true },
    );
    c.check("stage.enter.keepsCentre: zero store notifications", (await H(() => window.stageHarness.counters())).notifications, 0);
    c.check("stage.enter.keepsCentre: shape DOM identical", await H(() => window.stageHarness.shapeDom()), domBefore);

    // -- stage.exit.restoresCamera --------------------------------------------
    await H(() => window.stageHarness.setScrollTop(300));
    const scrollBefore = await H(() => window.stageHarness.scrollTop());
    await H(() => window.stageHarness.pressEscape());
    await settle();
    const vpAfter = await H(() => window.stageHarness.viewport());
    c.check("stage.exit.restoresCamera: data-stage cleared", await H(() => window.stageHarness.dataStage()), false);
    c.check(
      "stage.exit.restoresCamera: viewport restored within 1e-6",
      { x: close(vp0.x, vpAfter.x, 1e-6), y: close(vp0.y, vpAfter.y, 1e-6), zoom: vpAfter.zoom === vp0.zoom },
      { x: true, y: true, zoom: true },
    );
    c.check("stage.exit.restoresCamera: scroll position untouched", await H(() => window.stageHarness.scrollTop()), scrollBefore);

    // -- stage.enter.menuOpen --------------------------------------------------
    // Opening the menu moves focus onto it (`ContextMenu.tsx`'s own layout
    // effect), so the ⌘⇧F chord — a real keydown always targets whatever is
    // focused — would land on the menu, not the canvas keymap. Entering the
    // stage here is the toolbar/menu's own path: a direct `screen.set` call,
    // exactly what a pointer click on "Expanded stage" would do.
    await evalMount();
    await H(() => window.stageHarness.focus());
    await H(() => window.stageHarness.contextMenuAt("s1"));
    c.check("stage.enter.menuOpen: context menu opened", await H(() => window.stageHarness.menuPresent()), true);
    await H(() => window.stageHarness.api().screen.set({ stage: true }));
    await settle();
    c.check("stage.enter.menuOpen: menu still present once staged", await H(() => window.stageHarness.menuPresent()), true);
    c.check("stage.enter.menuOpen: staged", await H(() => window.stageHarness.dataStage()), true);
    await H(() => window.stageHarness.pressEscape());
    c.check("stage.enter.menuOpen: escape closed only the menu", await H(() => window.stageHarness.menuPresent()), false);
    c.check("stage.enter.menuOpen: selection intact", (await H(() => window.stageHarness.selectionSnapshot())).ids, ["s1"]);
    c.check("stage.enter.menuOpen: stage still on", await H(() => window.stageHarness.dataStage()), true);

    // -- stage.enter.labelEditing (no typing — see the module doc comment) ----
    // While `.nt-edit` is focused, `isTextEntry()` makes the WHOLE canvas
    // keymap inert by design (the module's own header: "While a label is
    // being edited nothing here fires") — so ⌘⇧F is correctly a no-op here
    // too. Same reasoning as menuOpen above: enter via the direct API call.
    await evalMount();
    await H(() => window.stageHarness.focus());
    await H(() => window.stageHarness.dblClickShape("s1"));
    await H(() => window.stageHarness.dblClickShape("s1"));
    const editBefore = await H(() => window.stageHarness.editingLabel());
    c.check("stage.enter.labelEditing: label open before staging", editBefore, { id: "s1", focused: true });
    await H(() => window.stageHarness.api().screen.set({ stage: true }));
    await settle();
    const editAfterStage = await H(() => window.stageHarness.editingLabel());
    c.check("stage.enter.labelEditing: still focused, same shape, once staged", editAfterStage, { id: "s1", focused: true });
    await H(() => window.stageHarness.pressEscape());
    const editAfterEscape = await H(() => window.stageHarness.editingLabel());
    c.check("stage.enter.labelEditing: escape ends only the edit", editAfterEscape.id, null);
    c.check("stage.enter.labelEditing: stage untouched by that escape", await H(() => window.stageHarness.dataStage()), true);
    c.check(
      "stage.enter.labelEditing: the shape stays selected (E3's ×1)",
      (await H(() => window.stageHarness.selectionSnapshot())).ids,
      ["s1"],
    );

    // -- stage.enter.groupEntered ----------------------------------------------
    await evalMount();
    await H(() => window.stageHarness.focus());
    await H(() => window.stageHarness.dblClickShape("gr1")); // a child of g1 — enters the group
    const enteredBefore = await H(() => window.stageHarness.selectionSnapshot());
    c.check("stage.enter.groupEntered: entered g1 before staging", enteredBefore, { ids: ["gr1"], enteredPath: ["g1"] });
    await H(() => window.stageHarness.pressStageChord());
    await settle();
    c.check(
      "stage.enter.groupEntered: unchanged once staged",
      await H(() => window.stageHarness.selectionSnapshot()),
      { ids: ["gr1"], enteredPath: ["g1"] },
    );
    await H(() => window.stageHarness.pressEscape());
    c.check(
      "stage.enter.groupEntered: escape 1 steps out (selects g1)",
      await H(() => window.stageHarness.selectionSnapshot()),
      { ids: ["g1"], enteredPath: [] },
    );
    c.check("stage.enter.groupEntered: still staged after escape 1", await H(() => window.stageHarness.dataStage()), true);
    await H(() => window.stageHarness.pressEscape());
    c.check(
      "stage.enter.groupEntered: escape 2 deselects",
      await H(() => window.stageHarness.selectionSnapshot()),
      { ids: [], enteredPath: [] },
    );
    c.check("stage.enter.groupEntered: still staged after escape 2", await H(() => window.stageHarness.dataStage()), true);
    await H(() => window.stageHarness.pressEscape());
    c.check("stage.enter.groupEntered: escape 3 leaves the stage", await H(() => window.stageHarness.dataStage()), false);

    // -- stage.minimal.togglesChrome --------------------------------------------
    await evalMount();
    await H(() => window.stageHarness.focus());
    const vpBeforeMinimal = await H(() => window.stageHarness.viewport());
    c.check(
      "stage.minimal.togglesChrome: chrome present before",
      await H(() => window.stageHarness.chromeMounted()),
      { toolbar: true, layers: true, stylePanel: true },
    );
    await H(() => window.stageHarness.pressMinimalChord());
    await settle();
    c.check(
      "stage.minimal.togglesChrome: chrome gone",
      await H(() => window.stageHarness.chromeMounted()),
      { toolbar: false, layers: false, stylePanel: false },
    );
    c.check(
      "stage.minimal.togglesChrome: camera untouched",
      await H(() => window.stageHarness.viewport()),
      vpBeforeMinimal,
    );
    await H(() => window.stageHarness.pressMinimalChord());
    await settle();
    c.check(
      "stage.minimal.togglesChrome: chrome back",
      await H(() => window.stageHarness.chromeMounted()),
      { toolbar: true, layers: true, stylePanel: true },
    );

    // -- stage.fullscreen.consistent --------------------------------------------
    // The one case the skeleton itself calls genuinely opportunistic in
    // headless Chromium: a real `requestFullscreen()` needs transient user
    // activation, which this run gives it via a real, trusted Playwright
    // click (not the synthetic dispatch every other case above uses) before
    // the real keyboard chord. If headless still refuses it, this is `todo`,
    // never a failure.
    await evalMount();
    const enabled = await H(() => window.stageHarness.fullscreenEnabled());
    if (!enabled) {
      c.todo("stage.fullscreen.consistent (document.fullscreenEnabled is false in this browser)");
    } else {
      const rect = await H(() => window.stageHarness.containerRect());
      await page.mouse.click((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
      await page.keyboard.press("Control+Meta+F");
      let gotFullscreen = false;
      for (let i = 0; i < 10 && !gotFullscreen; i++) {
        await page.waitForTimeout(100);
        gotFullscreen = await H(() => window.stageHarness.fullscreenElementIsDocument());
      }
      if (!gotFullscreen) {
        c.todo("stage.fullscreen.consistent (headless refused requestFullscreen)");
      } else {
        c.check(
          "stage.fullscreen.consistent: our state matches {stage,fullscreen}",
          await H(() => window.stageHarness.screenState()),
          { stage: true, minimal: false, fullscreen: true },
        );
        // Simulate the browser leaving fullscreen on its own (F11, chrome's
        // own Escape) by exiting for real without going through `screen`.
        await H(() => window.stageHarness.exitFullscreenDirect());
        let cleared = false;
        for (let i = 0; i < 10 && !cleared; i++) {
          await page.waitForTimeout(100);
          cleared = !(await H(() => window.stageHarness.fullscreenElementIsDocument()));
        }
        c.check("stage.fullscreen.consistent: browser-side exit clears our flag", cleared, true);
        c.check(
          "stage.fullscreen.consistent: stage stays after a browser-side exit",
          await H(() => window.stageHarness.screenState()),
          { stage: true, minimal: false, fullscreen: false },
        );
      }
    }

    // -- stage.camera.gateUnchanged ----------------------------------------------
    await evalMount();
    await H(() => window.stageHarness.focus());
    await H(() => window.stageHarness.pressStageChord());
    await settle();
    const domStaged = await H(() => window.stageHarness.shapeDom());
    await H(() => window.stageHarness.resetCounters());
    await H(async () => {
      for (let i = 0; i < 20; i++) window.stageHarness.panBy(3, -2);
    });
    await H(() => window.stageHarness.nextFrame());
    const afterPan = await H(() => window.stageHarness.counters());
    c.check("stage.camera.gateUnchanged: panning while staged writes nothing to the scene", afterPan, {
      notifications: 0,
      historyPushes: 0,
      shapeMutations: 0,
    });
    c.check("stage.camera.gateUnchanged: shape DOM identical after panning", await H(() => window.stageHarness.shapeDom()), domStaged);
    await H(() => window.stageHarness.pressEscape());
    await H(() => window.stageHarness.pressEscape());
    await H(() => window.stageHarness.pressEscape());
    c.check("stage.camera.gateUnchanged: leaving the stage is still zero-write", await H(() => window.stageHarness.counters()), {
      notifications: 0,
      historyPushes: 0,
      shapeMutations: 0,
    });

    c.check("no request left the fixture", guards.requests(), []);
    c.check("no console error", guards.errors(), []);

    await page.close();

    const artifact = {
      commit: safeCommit(),
      summary: c.summary(),
      verdict: c.summary().failed === 0 ? "pass" : "fail",
    };
    const artifactPath = await writeArtifact("canvas-stage", artifact);
    console.log(`  artifact: ${artifactPath}`);
  } finally {
    await browser.close();
    await built.close();
  }
}

main()
  .then(() => {
    const summary = c.summary();
    console.log(`\n${summary.failed} failing, ${summary.xfailed} xfailed, ${summary.xpassed} xpassed, ${summary.todo} todo`);
    if (summary.failed > 0) {
      console.error(`\n${c.failures.length} failure(s):\n\n${c.failures.join("\n\n")}`);
      process.exitCode = 1;
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
