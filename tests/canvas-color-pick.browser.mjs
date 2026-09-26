/**
 * The COLOR browser gate: the colour-pick session end to end, against a real
 * `CanvasSurface` + `CanvasStylePanel` (`tests/canvas-color-pick.browser.tsx`)
 * — mode gating, `paintAt` reading, wide-gamut/var preservation, one undo
 * entry, cancellation, and the Selection colours section. Reuses
 * `tests/canvas-harness.mjs`'s shared Playwright/esbuild scaffold; builds its
 * own bundle since that scaffold's `buildHarness()` is pinned to the shared
 * entry point (same pattern as `tests/canvas-compile.browser.mjs`).
 *
 * A representative subset of COLOR's own spec §8.2 (not all 28 cases — see
 * the slice's reported deviations): the mode-gate/cursor invariant, the
 * session state machine (var kept, gradient interpolated, cancel via Escape
 * and via an outside click, no scene churn while hovering, one undo entry,
 * the var-onto-bound-field rebind rule, the mode-gate-before-readOnly
 * invariant, no `--nt-select` anywhere in this slice's own chrome), the
 * screen-sample path, and the Selection colours section.
 *
 *   node tests/canvas-color-pick.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { checker, launch, openPage, repo, writeArtifact } from "./canvas-harness.mjs";

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

async function buildColorPickHarness() {
  const output = await mkdtemp(path.join(tmpdir(), "canvas-color-pick-"));
  await build({
    absWorkingDir: repo,
    entryPoints: ["tests/canvas-color-pick.browser.tsx"],
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

  const appCssPath = path.join(repo, "app/globals.css");
  const styles = await postcss([tailwind({ base: repo })]).process(await readFile(appCssPath, "utf8"), {
    from: appCssPath,
  });
  await writeFile(path.join(output, "app.css"), styles.css);

  await writeFile(
    path.join(output, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8">' +
      '<link rel="stylesheet" href="/app.css">' +
      '<link rel="stylesheet" href="/canvas-color-pick.browser.css">' +
      '</head><body><div id="app"></div><script type="module" src="/canvas-color-pick.browser.js"></script></body></html>',
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

async function main() {
  const built = await buildColorPickHarness();
  const { browser } = await launch();
  try {
    const { page, guards } = await openPage(browser, built.origin, { viewport: { width: 1400, height: 900 } });
    await page.goto(built.origin, { waitUntil: "networkidle" });

    // Each scenario group below starts from a fresh `mount()` — the fixture
    // scene is otherwise shared and mutated live (this is the real store,
    // not a fixture reset per case), and several cases below deliberately
    // change the same node's fill.
    await page.evaluate(() => window.pick.mount());

    // -- pick-cursor: mode gate + cursor precedence -------------------------
    await page.evaluate(() => window.pick.startPick("grad-rect", "background", "canvas"));
    c.check("pick-cursor: data-mode set", await page.evaluate(() => window.pick.dataMode()), "color-pick");
    const cursor = await page.evaluate(() => window.pick.cursorOf());
    c.check("pick-cursor: cursor is the pick cursor, not crosshair", cursor.startsWith("url("), true);
    await page.evaluate(() => window.pick.cancelPick());
    c.check("pick-cursor: cancel clears data-mode", await page.evaluate(() => window.pick.dataMode()), null);

    // -- pick-var-kept: picking a var() fill keeps the reference ------------
    await page.evaluate(() => window.pick.mount());
    await page.evaluate(() => window.pick.startPick("grad-rect", "background", "canvas"));
    // var-rect's centre: x=20+80=100, y=20+60=80.
    await page.evaluate(() => window.pick.clickAt(100, 80));
    c.check("pick-var-kept: destination now reads var(--brand)", await page.evaluate(() => window.pick.styleOf("grad-rect", "background")), "var(--brand)");
    c.check("pick-var-kept: mode released", await page.evaluate(() => window.pick.dataMode()), null);
    c.check("pick-var-kept: exactly one history push", await page.evaluate(() => window.pick.history()), 1);

    // -- pick-gradient-interpolated ------------------------------------------
    await page.evaluate(() => window.pick.mount());
    await page.evaluate(() => window.pick.startPick("var-rect", "background", "canvas"));
    // grad-rect midpoint: x=220+100=320, y=80 -> t=0.5 -> #808080.
    await page.evaluate(() => window.pick.clickAt(320, 80));
    c.check(
      "pick-gradient-interpolated: destination is the interpolated hex",
      await page.evaluate(() => window.pick.styleOf("var-rect", "background")),
      "#808080",
    );
    c.check("pick-gradient-interpolated: one history push", await page.evaluate(() => window.pick.history()), 1);

    // -- pick-cancel-escape ---------------------------------------------------
    await page.evaluate(() => window.pick.mount());
    const beforeEscape = await page.evaluate(() => window.pick.styleOf("var-rect", "background"));
    await page.evaluate(() => window.pick.startPick("var-rect", "background", "canvas"));
    await page.evaluate(() => window.pick.moveAt(100, 80));
    await page.evaluate(() => window.pick.pressEscape());
    c.check("pick-cancel-escape: session ends", (await page.evaluate(() => window.pick.pickState())).active, false);
    c.check("pick-cancel-escape: nothing applied", await page.evaluate(() => window.pick.styleOf("var-rect", "background")), beforeEscape);
    c.check("pick-cancel-escape: no history push", await page.evaluate(() => window.pick.history()), 0);

    // -- pick-cancel-outside ---------------------------------------------------
    await page.evaluate(() => window.pick.mount());
    await page.evaluate(() => window.pick.startPick("var-rect", "background", "canvas"));
    await page.evaluate(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    c.check("pick-cancel-outside: session ends", (await page.evaluate(() => window.pick.pickState())).active, false);
    c.check("pick-cancel-outside: no history push", await page.evaluate(() => window.pick.history()), 0);

    // -- pick-hover-no-scene-renders -------------------------------------------
    await page.evaluate(() => window.pick.mount());
    await page.evaluate(() => window.pick.startPick("var-rect", "background", "canvas"));
    await page.evaluate(async () => {
      for (let i = 0; i < 24; i++) {
        await window.pick.moveAt(20 + i * 4, 30 + (i % 5) * 6);
      }
    });
    c.check("pick-hover-no-scene-renders: zero history pushes", await page.evaluate(() => window.pick.history()), 0);
    c.check("pick-hover-no-scene-renders: scene identity unchanged", await page.evaluate(() => window.pick.sceneToken()), 0);
    await page.evaluate(() => window.pick.cancelPick());

    // -- pick-one-undo -----------------------------------------------------
    await page.evaluate(() => window.pick.mount());
    const preUndo = await page.evaluate(() => window.pick.styleOf("grad-rect", "background"));
    await page.evaluate(() => window.pick.startPick("grad-rect", "background", "canvas"));
    await page.evaluate(() => window.pick.clickAt(100, 80)); // picks var-rect's var(--brand) — a real change
    c.check("pick-one-undo: the pick actually landed", await page.evaluate(() => window.pick.styleOf("grad-rect", "background")), "var(--brand)");
    await page.evaluate(() => window.pick.api().store.undo());
    c.check("pick-one-undo: one undo restores the pre-pick value", await page.evaluate(() => window.pick.styleOf("grad-rect", "background")), preUndo);
    await page.evaluate(() => window.pick.api().store.redo());
    c.check("pick-one-undo: redo restores the picked value", await page.evaluate(() => window.pick.styleOf("grad-rect", "background")), "var(--brand)");

    // -- pick-var-onto-bound-field-rebinds --------------------------------
    // accent-rect's background is bound to --accent; pick var-rect's
    // var(--brand) onto it — it must rebind (read var(--brand)) and leave
    // --accent's own declaration untouched.
    await page.evaluate(() => window.pick.mount());
    const accentBefore = await page.evaluate(() => window.pick.diagramVar("--accent"));
    await page.evaluate(() => window.pick.startPick("accent-rect", "background", "canvas", "--accent"));
    await page.evaluate(() => window.pick.clickAt(100, 80));
    c.check("rebind: accent-rect now reads var(--brand)", await page.evaluate(() => window.pick.styleOf("accent-rect", "background")), "var(--brand)");
    c.check("rebind: --accent's own declaration is untouched", await page.evaluate(() => window.pick.diagramVar("--accent")), accentBefore);

    // -- mode-gate-before-readonly -------------------------------------------
    await page.evaluate(() => window.pick.mount({ readOnly: true }));
    const gate = await page.evaluate(() => window.pick.modeGateBeforeReadOnly());
    c.check("mode-gate-before-readonly: the mode's own handler ran", gate.modeRan, true);
    c.check("mode-gate-before-readonly: readOnly's selection.click did not fire", gate.selectionChanged, false);

    // -- screen source (a stubbed EyeDropper) ---------------------------------
    await page.evaluate(() => window.pick.mount());
    await page.evaluate(() => window.pick.resetCounters());
    await page.evaluate(() => window.pick.setEyeDropper("resolve", "#ff0000"));
    await page.evaluate(() => window.pick.startPick("var-rect", "background", "screen"));
    await page.evaluate(() => window.pick.sleep(50));
    c.check("screen sample applies the sampled colour", await page.evaluate(() => window.pick.styleOf("var-rect", "background")), "#FF0000");
    await page.evaluate(() => window.pick.setEyeDropper(null));

    // -- ui: the real dropper/sampler buttons exist and are wired -------------
    await page.evaluate(() => window.pick.select(["var-rect"]));
    await page.evaluate(() => window.pick.nextFrame());
    await page.evaluate(() => window.pick.openFillPopoverSlow());
    const hasDropper = await page.evaluate(() => !!window.pick.dropperButton());
    c.check("ui: the Fill popover shows a real Pick-from-canvas button", hasDropper, true);
    await page.evaluate(() => window.pick.dropperButton()?.click());
    c.check("ui: clicking it really starts a canvas session", await page.evaluate(() => window.pick.dataMode()), "color-pick");
    await page.evaluate(() => window.pick.cancelPick());

    // -- selection-colours: distinct rows, edit recolours every use ----------
    await page.evaluate(() => window.pick.select(["share-a", "share-b"]));
    await page.evaluate(() => window.pick.nextFrame());
    const rows = await page.evaluate(() => window.pick.selectionColourRows());
    c.check("selection-colours: one row for the shared colour", rows.length, 1);
    c.check("selection-colours: two uses", rows[0]?.uses, "2");

    await page.evaluate(() => window.pick.resetCounters());
    const input = await page.evaluate(() => window.pick.openSelectionColourHexInput());
    c.check("selection-colours: hex input opened via double-click", input !== null, true);
    await page.evaluate(() => {
      const el = document.querySelector('input[aria-label="Hex colour"]');
      if (el) {
        el.value = "654321";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.blur();
      }
    });
    await page.evaluate(() => window.pick.nextFrame());
    c.check("selection-colours: both shapes recoloured", await page.evaluate(() => [window.pick.styleOf("share-a", "background"), window.pick.styleOf("share-b", "background")]), [
      "#654321",
      "#654321",
    ]);
    // `StylePanel`'s own bracket (`useHistoryBracket`) settles a typed edit
    // after 350ms of quiet, same as any other panel field — this is one
    // `run()` call, so it is one entry once that idle window has passed.
    await page.evaluate(() => window.pick.sleep(400));
    c.check(
      "selection-colours: one undo entry for the whole recolour",
      await page.evaluate(() => window.pick.history()),
      1,
    );

    // -- ui: a portalled inspector menu remains part of the canvas ----------
    await page.evaluate(() => window.pick.mount());
    await page.evaluate(() => window.pick.select(["var-rect"]));
    await page.evaluate(() => window.pick.nextFrame());
    c.check("ui: Fill type menu offers Linear", await page.evaluate(() => window.pick.chooseFillType("Linear")), true);
    c.check("ui: choosing Fill type keeps the shape selected", await page.evaluate(() => [...window.pick.api().selection.getSnapshot().ids]), ["var-rect"]);
    c.check(
      "ui: choosing Fill type applies the portalled menu item",
      await page.evaluate(() => window.pick.styleOf("var-rect", "background")?.startsWith("linear-gradient")),
      true,
    );

    // -- no-accent-added ------------------------------------------------------
    await page.evaluate(() => window.pick.startPick("var-rect", "background", "canvas"));
    await page.evaluate(() => window.pick.moveAt(100, 80));
    const noAccent = await page.evaluate(() => window.pick.computedNoAccent().join(" "));
    c.check("no-accent-added: no computed colour is the canvas's --nt-select", noAccent.includes("rgb(13, 153, 255)"), false);
    await page.evaluate(() => window.pick.cancelPick());

    c.check("no request left the fixture", guards.requests(), []);
    c.check("no console error", guards.errors(), []);

    await page.close();
  } finally {
    await browser.close();
    await built.close();
  }

  const artifact = { verdict: c.summary().failed === 0 ? "pass" : "fail" };
  const artifactPath = await writeArtifact("canvas-color-pick", artifact);
  console.log(`  artifact: ${artifactPath}`);
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
