/**
 * The picking gate — drives real Chromium pointer and keyboard input over
 * `PICKING_PROBES` (`tests/canvas-fixtures.ts`) at every zoom in `PICK_ZOOMS`,
 * against the shared `pick-all` fixture, through the same
 * `tests/canvas-harness.browser.tsx` page `canvas-camera.browser.mjs` mounts.
 *
 * This file is the CANONICAL picking test (build-plan Conflict 4 / OQ-4):
 * PICK's own F1–F12 stay as vitest-only coverage (`scene/picking.test.ts`)
 * plus whatever they contributed to the fixture/probe table in
 * `tests/canvas-fixtures.ts`; PICK does not stand up a second browser
 * harness at this path. Every probe whose `expect` differs from what `main`
 * does today already carries `probe.xfail` ("PICK" or "SELECT") — this
 * runner reads that tag rather than re-deriving it (the mechanical
 * re-derivation lives in `tests/canvas-fixtures.test.ts`'s
 * `fixtures.pickAll.xfailReasons` suite). On `main` this run is expected to
 * finish `failed === 0` with `xfailed > 0`: an XPASS (a tagged probe that
 * actually reached `expect`) is treated as a failure, because it means the
 * tag should have come off in whatever PR made it pass.
 *
 * Two things this file needs that neither `canvas-harness.mjs` nor
 * `canvas-harness.browser.tsx` provide:
 *
 *   1. `PICKING_PROBES`/`PICK_ZOOMS` live in `tests/canvas-fixtures.ts`, a
 *      TypeScript module reached through the `@/*` path alias — Node's own
 *      type-stripping resolves neither the alias nor `.ts` extensions on
 *      relative specifiers, so `loadFixtures` below esbuild-bundles it for
 *      the `node` platform (the same `tsconfig`-driven alias resolution
 *      `buildHarness` already relies on for the browser bundle) and dynamic
 *      `import()`s the result. The module is pure scene/layout logic with no
 *      DOM dependency, so a Node-platform bundle of it needs nothing the
 *      browser bundle doesn't already prove works.
 *   2. Real camera placement before real input: `viewport.set()` (which
 *      `look()` calls) updates the viewport's in-memory position
 *      synchronously but defers the DOM `transform` write to the next
 *      `requestAnimationFrame` (`useViewport.ts`'s `commit`/`flush`). A probe
 *      computes its click point from that same in-memory position via
 *      `toClient()`, so clicking before the transform has actually painted
 *      would send Chromium's real hit-test against the OLD transform while
 *      our math already assumes the new one. Two `nextFrame()` awaits after
 *      every `look()` (mirroring `mount()`'s own settle idiom) closes that
 *      gap before any pointer event is dispatched.
 *
 *   node tests/canvas-picking.browser.mjs
 *
 * No dev server, no Convex, no API keys — every non-origin request fails the
 * run (see `canvas-harness.mjs`'s `openPage`).
 */
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  buildHarness,
  checker,
  launch,
  openPage,
  pretendApplePlatform,
  repo,
  writeArtifact,
} from "./canvas-harness.mjs";

const VIEWPORT = { width: 1280, height: 900 };
// The canvas itself is forced to exactly this size regardless of the page's
// own viewport (`canvas-harness.browser.css`'s `!important` rule) — §3.2.2's
// "zoom 8 shows 150×100 scene px" arithmetic is 1200/8 and 800/8, so the
// mount below must use these defaults, not `mount()`'s own fallback by
// coincidence.
const MOUNT_SIZE = { width: 1200, height: 800 };
const OFF_CANVAS = { x: 20, y: 20 }; // inside #app's 40px gutter, outside the wrapper

const c = checker();

/** Bundles `tests/canvas-fixtures.ts` for `node` and dynamic-imports the
 *  result — see the header note on why this can't just be a bare `import`. */
async function loadFixtures() {
  const result = await build({
    absWorkingDir: repo,
    entryPoints: ["tests/canvas-fixtures.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
    tsconfig: "tsconfig.json",
    logLevel: "warning",
  });
  const dir = await mkdtemp(path.join(tmpdir(), "canvas-fixtures-"));
  const file = path.join(dir, "canvas-fixtures.mjs");
  await writeFile(file, result.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Anchors, bounding boxes, points
// ---------------------------------------------------------------------------

function pointsOf(probe) {
  return Array.isArray(probe.where) ? probe.where : [probe.where];
}

/** Scene point for one anchor — a plain point, or a laid node's centre read
 *  straight off the mounted fixture (never re-derived from the fixture's own
 *  authored geometry, which a flex/auto-layout region would get wrong). */
async function resolveAnchor(page, anchor) {
  if (anchor && typeof anchor === "object" && "node" in anchor) {
    return page.evaluate((id) => {
      const r = window.canvasHarness.laidRect(id);
      return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    }, anchor.node);
  }
  return anchor;
}

/** `look()` centres on the bounding box of a probe's points (§3.2.2) — for a
 *  single-point probe this is just that point. */
function bboxCentre(points) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

// ---------------------------------------------------------------------------
// Reset between probes (§3.2.2)
// ---------------------------------------------------------------------------

/** Escape ×2 (out of any entered level, then off any open menu — order
 *  doesn't matter since either keypress the other doesn't need is a no-op),
 *  clear the selection outright, and park the pointer somewhere provably off
 *  the canvas so a stale hover never leaks into the next probe. Run after
 *  every (probe, zoom) — finer-grained than the spec's "between probes", and
 *  strictly safer for it. */
async function resetBetweenProbes(page) {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.canvasHarness.api().selection.clear());
  await page.mouse.move(OFF_CANVAS.x, OFF_CANVAS.y);
  await page.evaluate(() => window.canvasHarness.nextFrame());
  await page.evaluate(() => window.canvasHarness.focus());
}

// ---------------------------------------------------------------------------
// Driving one action
// ---------------------------------------------------------------------------

const NEEDS_META = new Set(["layerMenu", "layerMenuPick"]);

/** Runs `probe.action` at already-placed client coordinates and returns the
 *  "actual" value the table's `expect` is compared against. */
async function runAction(page, probe, clientPoints, scenePoints) {
  const ev = (fn, ...args) => page.evaluate(fn, ...args);

  switch (probe.action) {
    case "click": {
      await page.mouse.click(clientPoints[0].x, clientPoints[0].y);
      return ev(() => window.canvasHarness.selection().ids);
    }

    case "shiftClick": {
      await page.mouse.click(clientPoints[0].x, clientPoints[0].y);
      await page.keyboard.down("Shift");
      try {
        await page.mouse.click(clientPoints[1].x, clientPoints[1].y);
      } finally {
        await page.keyboard.up("Shift");
      }
      return ev(() => window.canvasHarness.selection().ids);
    }

    case "cmdClick": {
      await page.keyboard.down("Meta");
      try {
        await page.mouse.click(clientPoints[0].x, clientPoints[0].y);
      } finally {
        await page.keyboard.up("Meta");
      }
      return ev(() => window.canvasHarness.selection().ids);
    }

    case "altClick": {
      await page.keyboard.down("Alt");
      try {
        await page.mouse.click(clientPoints[0].x, clientPoints[0].y);
      } finally {
        await page.keyboard.up("Alt");
      }
      return ev(() => window.canvasHarness.selection().ids);
    }

    case "hover": {
      await page.mouse.move(clientPoints[0].x, clientPoints[0].y);
      await ev(() => window.canvasHarness.nextFrame());
      await ev(() => window.canvasHarness.nextFrame());
      const hoverId = await ev(() => window.canvasHarness.selection().hoverId);
      return hoverId ? [hoverId] : [];
    }

    case "candidates": {
      // `SelectionStore.candidates` doesn't exist pre-PICK/SELECT — caught
      // inside the page so a missing method reports a mismatching sentinel
      // (correctly xfailed) instead of throwing the whole run over.
      return page.evaluate((point) => {
        const selection = window.canvasHarness.api().selection;
        if (typeof selection.candidates !== "function") return ["__missing:candidates__"];
        try {
          const found = selection.candidates(point);
          return found.map((entry) => (entry && entry.node ? entry.node.id : entry.id));
        } catch (error) {
          return [`__threw:${error instanceof Error ? error.message : String(error)}__`];
        }
      }, scenePoints[0]);
    }

    case "layerMenu":
    case "layerMenuPick": {
      // §3.2.2: every layerMenu/layerMenuPick probe opens via ⌘+right-click,
      // except the one `menuOpen: false` probe, which is a plain right-click
      // proving the handler is undefined in read-only mode at all.
      const useMeta = NEEDS_META.has(probe.action) && probe.menuOpen !== false;
      if (useMeta) await page.keyboard.down("Meta");
      try {
        await page.mouse.click(clientPoints[0].x, clientPoints[0].y, { button: "right" });
      } finally {
        if (useMeta) await page.keyboard.up("Meta");
      }

      if (probe.menuOpen === false) {
        return ev(() => window.canvasHarness.contextMenu().open);
      }

      const menu = await ev(() => window.canvasHarness.contextMenu());
      const layerRows = menu.rows.filter((row) => row.layerId !== null);

      if (probe.action === "layerMenu") {
        return layerRows.map((row) => row.layerId);
      }

      // layerMenuPick: click row `probe.pick` if a "Select layer" submenu
      // with that many rows actually exists yet (pre-SELECT, none do — the
      // probe stays xfailed against whatever selection the plain right-click
      // itself already produced, per today's `onContextMenu`).
      const index = probe.pick ?? 0;
      if (index < layerRows.length) {
        const rect = await page.evaluate((i) => {
          const rows = [...document.querySelectorAll('[role="menuitem"][data-layer-id]')];
          const el = rows[i];
          if (!el) return null;
          const box = el.getBoundingClientRect();
          return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
        }, index);
        if (rect) await page.mouse.click(rect.x, rect.y);
      }
      return ev(() => window.canvasHarness.selection().ids);
    }

    default:
      throw new Error(`picking runner: unhandled action "${probe.action}"`);
  }
}

// ---------------------------------------------------------------------------
// Layout agreement (§3.2.3) — must pass on main, no xfail possible here
// ---------------------------------------------------------------------------

async function runLayoutAgreement(page) {
  await page.evaluate((fixture) => window.canvasHarness.mount(fixture), "nested-flex");
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll(".nt-canvas-scene [data-id]")].map((el) => el.getAttribute("data-id")),
  );
  let worst = 0;
  const offenders = [];
  for (const id of ids) {
    const dom = await page.evaluate((nodeId) => window.canvasHarness.domRect(nodeId), id);
    const laid = await page.evaluate((nodeId) => window.canvasHarness.laidRect(nodeId), id);
    const dx = Math.abs(dom.x - laid.x);
    const dy = Math.abs(dom.y - laid.y);
    const dw = Math.abs(dom.w - laid.w);
    const dh = Math.abs(dom.h - laid.h);
    const deviation = Math.max(dx, dy, dw, dh);
    worst = Math.max(worst, deviation);
    if (deviation > 0.5) offenders.push({ id, dom, laid, deviation });
  }
  c.check("picking.layout.agreement", worst <= 0.5, true);
  if (offenders.length) {
    console.log(`    offenders (>0.5px): ${JSON.stringify(offenders, null, 2)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { mod: fixtures, cleanup: cleanupFixtures } = await loadFixtures();
  const { PICKING_PROBES, PICK_ZOOMS } = fixtures;
  const built = await buildHarness();
  const { browser } = await launch();

  const totals = { writes: 0, historyPushes: 0, selectionOnlyPushes: 0 };
  const accumulate = async (page) => {
    const counters = await page.evaluate(() => window.canvasHarness.counters());
    totals.writes += counters.writes;
    totals.historyPushes += counters.historyPushes;
    totals.selectionOnlyPushes += counters.selectionOnlyPushes;
  };

  try {
    const { page, guards } = await openPage(browser, built.origin, { viewport: VIEWPORT, aiReach: built.aiReach });
    // Every `cmdClick`/`layerMenu` probe presses ⌘, and the surface reads the
    // deep-select modifier as `isApplePlatform() ? metaKey : ctrlKey`.
    await pretendApplePlatform(page);
    await page.goto(built.origin, { waitUntil: "networkidle" });

    await runLayoutAgreement(page);

    // -- picking probes -----------------------------------------------------
    let mountedReadOnly = false;
    const mountBase = async () => {
      await accumulate(page);
      await page.evaluate((args) => window.canvasHarness.mount(args.fixture, args.opts), {
        fixture: "pick-all",
        opts: MOUNT_SIZE,
      });
      await page.evaluate(() => window.canvasHarness.focus());
      mountedReadOnly = false;
    };
    const mountReadOnly = async () => {
      await accumulate(page);
      await page.evaluate((args) => window.canvasHarness.mount(args.fixture, args.opts), {
        fixture: "pick-all",
        opts: { ...MOUNT_SIZE, readOnly: true },
      });
      await page.evaluate(() => window.canvasHarness.focus());
      mountedReadOnly = true;
    };

    await mountBase();

    for (const probe of PICKING_PROBES) {
      const zooms = probe.zooms ?? PICK_ZOOMS;

      if (probe.verify) {
        // The Figma-actual answer is unresolved; `expect` is a placeholder
        // never compared (§2.1's own `verify` contract).
        for (const zoom of zooms) c.todo(`picking.${probe.id}@${zoom}`);
        continue;
      }

      const wantReadOnly = probe.readOnly ?? false;
      if (wantReadOnly && !mountedReadOnly) await mountReadOnly();
      else if (!wantReadOnly && mountedReadOnly) await mountBase();

      for (const zoom of zooms) {
        const anchors = pointsOf(probe);
        const scenePoints = await Promise.all(anchors.map((anchor) => resolveAnchor(page, anchor)));
        const centre = bboxCentre(scenePoints);
        await page.evaluate((args) => window.canvasHarness.look(args.centre, args.zoom), { centre, zoom });
        // Two frames: `viewport.set()` updates the in-memory camera
        // synchronously but the DOM `transform` write is deferred to the
        // next rAF (`useViewport.ts`'s `commit`/`flush`) — see the header
        // note. Real pointer input must land after the repaint, not before.
        await page.evaluate(() => window.canvasHarness.nextFrame());
        await page.evaluate(() => window.canvasHarness.nextFrame());
        const clientPoints = await Promise.all(
          scenePoints.map((point) => page.evaluate((p) => window.canvasHarness.toClient(p), point)),
        );

        const name = `picking.${probe.id}@${zoom}`;
        let actual;
        try {
          actual = await runAction(page, probe, clientPoints, scenePoints);
        } catch (error) {
          actual = `__error:${error instanceof Error ? error.message : String(error)}__`;
        }

        if (probe.menuOpen === false) {
          c.check(name, actual, false);
        } else if (probe.xfail) {
          c.xfail(probe.xfail, name, actual, probe.expect);
        } else {
          c.check(name, actual, probe.expect);
        }

        await resetBetweenProbes(page);
      }
    }

    // Leave the run on the base (read-write) mount for the guard reads below.
    if (mountedReadOnly) await mountBase();
    await accumulate(page);

    // -- guards (§2.6, §4.3) --------------------------------------------------
    c.check("picking.guard.noNetwork", guards.requests(), []);
    c.check("picking.guard.noConsoleErrors", guards.errors(), []);
    const blocked = await page.evaluate(() => window.canvasHarness.counters().blockedCalls);
    c.check("picking.guard.noBlockedCalls", blocked, []);
    const reach = await page.evaluate(() => window.canvasHarness.aiReach());
    c.check("picking.guard.aiReach", [...reach].sort(), [...built.aiReach].sort());
    // Selecting is not editing: not one probe above should have dispatched a
    // scene op, however many times it changed what was selected.
    c.check("picking.guard.noWrites", totals.writes, 0);
    c.check(
      "picking.guard.historyIsSelectionOnly",
      { real: totals.historyPushes, selectionOnly: totals.selectionOnlyPushes > 0 },
      { real: 0, selectionOnly: true },
    );

    const artifact = {
      commit: safeCommit(),
      summary: c.summary(),
      totals,
      aiReach: reach,
      verdict: c.summary().failed === 0 ? "pass" : "fail",
    };
    const artifactPath = await writeArtifact("canvas-picking", artifact);
    console.log(`  artifact: ${artifactPath}`);
  } finally {
    await browser.close();
    await built.close();
    await cleanupFixtures();
  }
}

function safeCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  } catch {
    return null;
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
