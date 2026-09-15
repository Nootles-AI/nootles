/**
 * SELECT's browser gate — real Chromium pointer and keyboard input over the
 * SELECT.md §3 fixture, driven through the shared `window.canvasHarness`
 * bundle (`tests/canvas-harness.mjs` + `tests/canvas-harness.browser.tsx`),
 * exactly as `tests/canvas-picking.browser.mjs`/`tests/canvas-stage.browser.mjs`
 * do — no second esbuild pipeline, no `.browser.tsx` mount file of its own
 * (SELECT.md §4.2's own review-note fix: HARNESS's generic `mount({ html })`
 * already covers it).
 *
 * `engine/useSelection.fixtures.ts`'s `SELECT_FIXTURE`/`SELECT_FIXTURE_HTML`
 * is one literal shared with `engine/useSelection.test.ts`, esbuild-bundled
 * for `node` the same way `canvas-picking.browser.mjs` reaches
 * `tests/canvas-fixtures.ts` — a TypeScript module behind the `@/*` alias
 * Node's type-stripping cannot resolve on its own.
 *
 *   node tests/canvas-select.browser.mjs
 *
 * No dev server, no Convex, no API keys — every non-origin request fails the
 * run (`canvas-harness.mjs`'s `openPage`).
 */
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildHarness, checker, launch, openPage, repo, writeArtifact } from "./canvas-harness.mjs";

const VIEWPORT = { width: 1280, height: 900 };
const MOUNT_SIZE = { width: 480, height: 260 }; // matches SELECT_SCENE's own w/h — the fixture's own coordinates are already scene px
const OFF_CANVAS = { x: 20, y: 20 };

const c = checker();

/** Bundles `engine/useSelection.fixtures.ts` for `node` and dynamic-imports
 *  the result — same reason as `canvas-picking.browser.mjs`'s `loadFixtures`:
 *  a `@/*`-aliased TypeScript module Node cannot resolve unassisted. */
async function loadFixtures() {
  const result = await build({
    absWorkingDir: repo,
    entryPoints: ["app/components/editor/canvas/engine/useSelection.fixtures.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
    tsconfig: "tsconfig.json",
    logLevel: "warning",
  });
  const dir = await mkdtemp(path.join(tmpdir(), "canvas-select-fixtures-"));
  const file = path.join(dir, "select-fixtures.mjs");
  await writeFile(file, result.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  return { mod, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Small driving helpers
// ---------------------------------------------------------------------------

async function scenePoint(page, x, y) {
  return page.evaluate((p) => window.canvasHarness.toClient(p), { x, y });
}

async function centre(page, id) {
  return page.evaluate((nodeId) => window.canvasHarness.centreOf(nodeId), id);
}

/** A point offset from a node's own laid rect, in client space — for a point
 *  inside a container's box but away from a specific child (K1's corner,
 *  clear of K2's cut hole; F's own padding, clear of A/G/D). */
async function insetOf(page, id, dx, dy) {
  return page.evaluate(
    ({ nodeId, ddx, ddy }) => {
      const r = window.canvasHarness.laidRect(nodeId);
      return window.canvasHarness.toClient({ x: r.x + ddx, y: r.y + ddy });
    },
    { nodeId: id, ddx: dx, ddy: dy },
  );
}

async function selection(page) {
  return page.evaluate(() => window.canvasHarness.selection());
}

async function reset(page) {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.canvasHarness.api().selection.clear());
  await page.mouse.move(OFF_CANVAS.x, OFF_CANVAS.y);
  await page.evaluate(() => window.canvasHarness.nextFrame());
  await page.evaluate(() => window.canvasHarness.focus());
  await page.evaluate(() => window.canvasHarness.resetCounters());
}

/** Whether a keypress the caller triggers inside `fn` reaches `document` —
 *  i.e. was NOT consumed (`stopPropagation`d) by the canvas keymap. */
async function keyBubbles(page, fn) {
  await page.evaluate(() => {
    window.__select_bubbled = false;
    document.addEventListener(
      "keydown",
      () => {
        window.__select_bubbled = true;
      },
      { once: true },
    );
  });
  await fn();
  return page.evaluate(() => window.__select_bubbled);
}

async function modDown(page) {
  await page.keyboard.down("Meta");
}
async function modUp(page) {
  await page.keyboard.up("Meta");
}

async function modClick(page, point) {
  await modDown(page);
  try {
    await page.mouse.click(point.x, point.y);
  } finally {
    await modUp(page);
  }
}

async function dragGesture(page, from, to, opts = {}) {
  if (opts.meta) await modDown(page);
  if (opts.shift) await page.keyboard.down("Shift");
  try {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
  } finally {
    if (opts.shift) await page.keyboard.up("Shift");
    if (opts.meta) await modUp(page);
  }
}

async function menuRowByText(page, text) {
  return page.evaluate((want) => {
    const rows = [...document.querySelectorAll('[role="menuitem"]')];
    const el = rows.find((r) => (r.textContent || "").includes(want));
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }, text);
}

async function clickMenuRow(page, text) {
  const rect = await menuRowByText(page, text);
  if (!rect) throw new Error(`menu row not found: ${text}`);
  await page.mouse.click(rect.x, rect.y);
}

async function hoverMenuRow(page, text) {
  const rect = await menuRowByText(page, text);
  if (!rect) throw new Error(`menu row not found: ${text}`);
  await page.mouse.move(rect.x, rect.y);
}

/**
 * The "Select layer" submenu's own rows, read straight off the DOM rather
 * than `canvasHarness.contextMenu()` — that helper's `menu` is the single
 * top-level `[role="menu"]` it finds, and the submenu is a sibling of it
 * (§1.3: never nested, so the top-level menu's own roving query cannot pick
 * up a submenu row), so its `querySelectorAll` never reaches these rows.
 * This mirrors `canvas-picking.browser.mjs`'s own `layerMenu` action, which
 * reads the identical global selector for the same reason (SELECT.md Q14).
 */
async function layerMenuRows(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[role="menuitem"][data-layer-id]')].map((el) => ({
      layerId: el.getAttribute("data-layer-id"),
      current: el.getAttribute("aria-current"),
    })),
  );
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function runCases(page) {
  // -- deep select (D1/D2, C12) ---------------------------------------------

  await reset(page);
  await modClick(page, await centre(page, "B"));
  {
    const s = await selection(page);
    c.check("select.deep.mod-click.ids", s.ids, ["B"]);
    c.check("select.deep.mod-click.level", s.enteredPath, ["F", "G"]);
  }
  await page.mouse.click(...Object.values(await centre(page, "C")));
  {
    const s = await selection(page);
    c.check("select.deep.mod-click.then-plain", s.ids, ["C"]);
    c.check("select.deep.mod-click.level-unchanged", s.enteredPath, ["F", "G"]);
  }

  await reset(page);
  await page.keyboard.down("Alt");
  try {
    await page.mouse.click(...Object.values(await centre(page, "B")));
  } finally {
    await page.keyboard.up("Alt");
  }
  c.check("select.deep.alt-click-is-plain", (await selection(page)).ids, ["F"]);

  // -- hover (H1/H2/H3) ------------------------------------------------------

  await reset(page);
  {
    const b = await centre(page, "B");
    await page.mouse.move(b.x, b.y);
    await page.evaluate(() => window.canvasHarness.nextFrame());
    await page.evaluate(() => window.canvasHarness.nextFrame());
    c.check("select.hover.plain-rings-outermost", (await selection(page)).hoverId, "F");

    await modDown(page);
    await page.mouse.move(b.x + 1, b.y);
    await page.evaluate(() => window.canvasHarness.nextFrame());
    await page.evaluate(() => window.canvasHarness.nextFrame());
    c.check("select.hover.mod-rings-leaf", (await selection(page)).hoverId, "B");
    await modUp(page);
  }

  await reset(page);
  await modClick(page, await centre(page, "A")); // ids=[A], level=[F]
  {
    const pad = await insetOf(page, "F", 260, 160); // clear of A/G/D
    await page.mouse.move(pad.x, pad.y);
    await page.evaluate(() => window.canvasHarness.nextFrame());
    await page.evaluate(() => window.canvasHarness.nextFrame());
    c.check("select.hover.entered-padding-no-ring", (await selection(page)).hoverId, null);
  }

  // -- context menu (M2-M9) ---------------------------------------------------

  await reset(page);
  {
    const k = await insetOf(page, "K1", 2, 2); // K's own paint, clear of K2's hole
    await page.mouse.click(k.x, k.y, { button: "right" });
    const menu = await page.evaluate(() => window.canvasHarness.contextMenu());
    c.check("select.menu.opens-on-right-click", menu.open, true);

    // The layer rows live in the nested submenu, not the top-level menu —
    // open it (hover the "Select layer" row) before reading them.
    await hoverMenuRow(page, "Select layer");
    await page.evaluate(() => window.canvasHarness.nextFrame());
    const layerRows = await layerMenuRows(page);
    c.check("select.menu.rows-front-to-back", layerRows.map((r) => r.layerId), ["K", "F"]);

    await hoverMenuRow(page, "Card");
    c.check("select.menu.row-hover-rings", (await selection(page)).hoverId, "F");

    await clickMenuRow(page, "Card");
    const afterPick = await selection(page);
    c.check("select.menu.pick-selects", afterPick.ids, ["F"]);
    c.check("select.menu.pick-hover-cleared", afterPick.hoverId, null);
    const closed = await page.evaluate(() => window.canvasHarness.contextMenu());
    c.check("select.menu.pick-closes", closed.open, false);
  }

  await reset(page);
  {
    const k = await insetOf(page, "K1", 2, 2);
    const before = await selection(page);
    await modDown(page);
    try {
      await page.mouse.click(k.x, k.y, { button: "right" });
    } finally {
      await modUp(page);
    }
    const menu = await page.evaluate(() => window.canvasHarness.contextMenu());
    const rows = menu.rows.filter((r) => r.layerId !== null);
    c.check("select.menu.mod-right-click-direct.every-row-is-a-layer", rows.length > 0 && rows.every((r) => r.layerId !== null), true);
    c.check("select.menu.mod-right-click-direct.no-preselect", (await selection(page)).ids, before.ids);
    const ariaLabel = await page.evaluate(() => document.querySelector('[role="menu"]')?.getAttribute("aria-label"));
    c.check("select.menu.mod-right-click-direct.aria-label", ariaLabel, "Select layer");
  }

  // -- frontmost-only pre-select (review #8, blocker, M15) --------------------

  {
    const { OVERLAP_FIXTURE_HTML } = fixtures;
    await page.evaluate((html) => window.canvasHarness.mount({ html }, { width: 200, height: 200 }), OVERLAP_FIXTURE_HTML);
    await page.evaluate(() => window.canvasHarness.focus());
    await page.evaluate(() => window.canvasHarness.api().selection.select(["Y"])); // back node starts selected
    const p = await scenePoint(page, 50, 50); // the fully-overlapping point
    await page.mouse.click(p.x, p.y, { button: "right" });
    c.check("select.menu.frontmost-preselect", (await selection(page)).ids, ["X"]);
    // Remount the shared fixture for every case below.
    await page.evaluate(
      (args) => window.canvasHarness.mount({ html: args.html }, args.opts),
      { html: fixtures.SELECT_FIXTURE_HTML, opts: MOUNT_SIZE },
    );
    await page.evaluate(() => window.canvasHarness.focus());
  }

  // -- keyboard navigation (K1, K4, K8, K9/K10, K15-K20, K27) -----------------

  await reset(page);
  await page.mouse.click(...Object.values(await centre(page, "F"))); // outermost click -> [F]
  await page.keyboard.press("Enter");
  {
    const s = await selection(page);
    c.check("select.keys.enter-group", s.ids, ["D"]); // F's frontmost eligible child
    c.check("select.keys.enter-group.level", s.enteredPath, ["F"]);
  }

  await reset(page);
  await modClick(page, await centre(page, "A")); // deep-select the labelled leaf A
  await page.keyboard.press("Enter");
  {
    const label = await page.evaluate(() => window.canvasHarness.editingLabel());
    c.check("select.keys.enter-text-opens-label", label.id, "A");
  }

  await reset(page);
  {
    const bubbled = await keyBubbles(page, () => page.keyboard.press("Enter"));
    c.check("select.keys.enter-nothing-not-consumed", bubbled, true);
  }

  await reset(page);
  await modClick(page, await insetOf(page, "K1", 2, 2)); // deep-select K (the boolean)
  await page.keyboard.press("Enter");
  {
    const s = await selection(page);
    c.check("select.keys.enter-boolean-steps-in", s.ids, ["K2"]);
    c.check("select.keys.enter-boolean-steps-in.level", s.enteredPath, ["F", "G", "K"]);
  }

  await reset(page);
  await modClick(page, await centre(page, "B"));
  await page.keyboard.press("Shift+Enter");
  c.check("select.keys.shift-enter-parent.1", (await selection(page)).ids, ["G"]);
  await page.keyboard.press("Shift+Enter");
  c.check("select.keys.shift-enter-parent.2", (await selection(page)).ids, ["F"]);

  await reset(page);
  await modClick(page, await insetOf(page, "D", 2, 2)); // deep-select D -> level [F]
  c.check("select.keys.tab-siblings-wrap.start", (await selection(page)).ids, ["D"]);
  {
    // Fold the "consumed" check into this first press rather than firing an
    // extra one afterward — every Tab here changes the selection, so a spare
    // press would silently shift the rest of the sequence.
    const bubbled = await keyBubbles(page, () => page.keyboard.press("Tab")); // toward the back: D -> G
    c.check("select.keys.tab-does-not-move-focus", bubbled, false);
  }
  c.check("select.keys.tab-siblings-wrap.1", (await selection(page)).ids, ["G"]);
  await page.keyboard.press("Tab"); // G -> A
  c.check("select.keys.tab-siblings-wrap.2", (await selection(page)).ids, ["A"]);
  await page.keyboard.press("Tab"); // wraps: A -> D
  c.check("select.keys.tab-siblings-wrap.3", (await selection(page)).ids, ["D"]);
  await page.keyboard.press("Shift+Tab"); // D -> A (toward the front)
  c.check("select.keys.tab-siblings-wrap.shift", (await selection(page)).ids, ["A"]);

  await reset(page);
  // Enter F's level with nothing selected there: deep-select D (level [F]),
  // then a plain click on F's own padding deselects while staying at [F].
  await modClick(page, await insetOf(page, "D", 2, 2));
  {
    const pad = await insetOf(page, "F", 260, 160);
    await page.mouse.click(pad.x, pad.y);
  }
  {
    const before = await selection(page);
    c.check("select.keys.tab-yields-focus-when-empty.precondition", { ids: before.ids, level: before.enteredPath }, { ids: [], level: ["F"] });
    const bubbled = await keyBubbles(page, () => page.keyboard.press("Tab"));
    c.check("select.keys.tab-yields-focus-when-empty (review #7 blocker)", bubbled, true);
    c.check("select.keys.tab-yields-focus-when-empty.unchanged", (await selection(page)).ids, []);
  }

  // -- Mod-drag marquee (Q1, Q4 blocker, Q7) ----------------------------------

  await reset(page);
  {
    const from = await insetOf(page, "F", 260, 160); // F's own padding
    const to = await insetOf(page, "G", 50, 20); // over B/C
    const before = await page.evaluate(() => window.canvasHarness.sceneStyle().transform);
    await dragGesture(page, from, to, { meta: true });
    const s = await selection(page);
    c.check("select.marquee.mod-drag-through-frame.ids", s.ids, ["G"]);
    c.check("select.marquee.mod-drag-through-frame.level", s.enteredPath, ["F"]);
    const fTransform = await page.evaluate(
      (id) => document.querySelector(`[data-id="${id}"]`)?.style.transform ?? "",
      "F",
    );
    void before;
    c.check("select.marquee.mod-drag-through-frame.f-has-a-transform", typeof fTransform, "string");
  }

  await reset(page);
  {
    // Select F first — the fix (review #9, blocker): prior selection must not
    // matter, marqueeThroughTarget is decided before any onSelection branch.
    await page.mouse.click(...Object.values(await centre(page, "F")));
    c.check("select.marquee.mod-drag-through-selected-frame.precondition", (await selection(page)).ids, ["F"]);
    const before = await page.evaluate(
      (id) => document.querySelector(`[data-id="${id}"]`)?.getAttribute("transform") ?? document.querySelector(`[data-id="${id}"]`)?.style.transform ?? "",
      "F",
    );
    const from = await insetOf(page, "F", 260, 160);
    const to = await insetOf(page, "G", 50, 20);
    await dragGesture(page, from, to, { meta: true });
    c.check("select.marquee.mod-drag-through-selected-frame.ids", (await selection(page)).ids, ["G"]);
    const after = await page.evaluate(
      (id) => document.querySelector(`[data-id="${id}"]`)?.getAttribute("transform") ?? document.querySelector(`[data-id="${id}"]`)?.style.transform ?? "",
      "F",
    );
    c.check("select.marquee.mod-drag-through-selected-frame.f-unmoved", after, before);
  }

  await reset(page);
  {
    const from = await insetOf(page, "K1", 2, 2); // K's own fill
    const to = await insetOf(page, "K1", 12, 12);
    await dragGesture(page, from, to, { meta: true });
    c.check("select.marquee.mod-drag-excludes-boolean.selects-whole", (await selection(page)).ids, ["K"]);
    // A real scene edit (the move), not a marquee: `historyPushes` — not the
    // debounced `onChange`/`writes` counter, which lags a live gesture's own
    // DOM writes by design.
    const pushed = await page.evaluate(() => window.canvasHarness.counters().historyPushes);
    c.check("select.marquee.mod-drag-excludes-boolean.moved-not-marqueed", pushed > 0, true);
  }

  await reset(page);
  {
    const from = await centre(page, "B");
    const to = { x: from.x + 30, y: from.y + 20 };
    await dragGesture(page, from, to, { meta: true });
    const pushed = await page.evaluate(() => window.canvasHarness.counters().historyPushes);
    c.check("select.marquee.mod-drag-leaf-moves", pushed > 0, true);
  }

  // -- undo / collapse (§3.8) --------------------------------------------------

  await reset(page);
  {
    // A real edit first, so the very next selection change is guaranteed a
    // FRESH history entry rather than silently collapsing into whatever
    // selection-only entry a previous case (or `reset()`'s own `clear()`)
    // already left on top of the stack — `useScene.ts`'s `recordSelection`
    // collapses any run of consecutive selection-only changes over the SAME
    // scene into one entry, by design (five clicks in a row cost one undo
    // step), so a clean boundary needs a real op in between.
    await page.mouse.click(...Object.values(await centre(page, "B"))); // -> [F]
    await page.keyboard.press("ArrowRight"); // nudge F 1px — a real, bracket-closing edit
    await page.evaluate(() => window.canvasHarness.nextFrame());
    await page.evaluate(() => window.canvasHarness.resetCounters());
    const beforeRun = await selection(page);

    await modClick(page, await centre(page, "B")); // -> [B], level [F,G] — a fresh push
    const firstPush = await page.evaluate(() => window.canvasHarness.counters().selectionOnlyPushes);
    c.check("select.undo.selection-only-push-recorded", firstPush > 0, true);

    await modClick(page, await centre(page, "C")); // -> [C] — no real edit since, so this collapses
    const afterSecond = await page.evaluate(() => window.canvasHarness.counters().selectionOnlyPushes);
    c.check("select.undo.consecutive-selection-changes-collapse", afterSecond, firstPush);

    await page.keyboard.press("Meta+z"); // undoes the whole collapsed run at once
    const restored = await selection(page);
    c.check("select.undo.restores-to-before-the-run", restored.ids, beforeRun.ids);
  }

  // -- read-only (§3.7) ---------------------------------------------------------

  await page.evaluate(
    (args) => window.canvasHarness.mount({ html: args.html }, { ...args.opts, readOnly: true }),
    { html: fixtures.SELECT_FIXTURE_HTML, opts: MOUNT_SIZE },
  );
  await page.evaluate(() => window.canvasHarness.focus());
  {
    const b = await centre(page, "B");
    await page.mouse.click(b.x, b.y);
    c.check("select.readonly.click-is-deep", (await selection(page)).ids, ["B"]);
    await modClick(page, b);
    c.check("select.readonly.mod-click-same", (await selection(page)).ids, ["B"]);
    await page.mouse.click(b.x, b.y, { button: "right" });
    const menu = await page.evaluate(() => window.canvasHarness.contextMenu());
    c.check("select.readonly.no-context-menu", menu.open, false);
  }

  // -- state no-drift (viewport/scene identity unchanged for selection-only work) --

  await page.evaluate(
    (args) => window.canvasHarness.mount({ html: args.html }, args.opts),
    { html: fixtures.SELECT_FIXTURE_HTML, opts: MOUNT_SIZE },
  );
  await page.evaluate(() => window.canvasHarness.focus());
  await reset(page);
  {
    const viewBefore = await page.evaluate(() => window.canvasHarness.api().viewport.get());
    const tokenBefore = await page.evaluate(() => window.canvasHarness.sceneToken());
    await modClick(page, await centre(page, "B"));
    await page.keyboard.press("Shift+Enter");
    const viewAfter = await page.evaluate(() => window.canvasHarness.api().viewport.get());
    const tokenAfter = await page.evaluate(() => window.canvasHarness.sceneToken());
    c.check("select.state.no-drift.viewport", viewAfter, viewBefore);
    c.check("select.state.no-drift.sceneToken", tokenAfter, tokenBefore);
  }
}

let fixtures;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { mod, cleanup: cleanupFixtures } = await loadFixtures();
  fixtures = mod;
  const built = await buildHarness();
  const { browser } = await launch();

  try {
    const { page, guards } = await openPage(browser, built.origin, { viewport: VIEWPORT, aiReach: built.aiReach });
    await page.goto(built.origin, { waitUntil: "networkidle" });

    await page.evaluate(
      (args) => window.canvasHarness.mount({ html: args.html }, args.opts),
      { html: fixtures.SELECT_FIXTURE_HTML, opts: MOUNT_SIZE },
    );
    await page.evaluate(() => window.canvasHarness.focus());

    await runCases(page);

    c.check("select.guard.noNetwork", guards.requests(), []);
    c.check("select.guard.noConsoleErrors", guards.errors(), []);

    const artifact = {
      commit: safeCommit(),
      summary: c.summary(),
      verdict: c.summary().failed === 0 ? "pass" : "fail",
    };
    const artifactPath = await writeArtifact("canvas-select", artifact);
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
