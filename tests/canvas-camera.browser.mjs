/**
 * The camera performance and correctness gate — proves, with real Chromium
 * input over a 1,000-shape board, that panning, zooming and dragging the
 * hand tool touch nothing but the viewport transform: zero scene
 * notifications, an identical shape DOM, zero writes, zero history entries,
 * and `will-change: transform` held only for the duration of the gesture.
 * Timing (C9/C10) is gated against a baseline recorded on the operator's own
 * machine — see §3.1.6 of HARNESS.md for why a shared CI runner's numbers
 * would be noise, not signal (`canvas-browser`'s CI job runs this file with
 * `CANVAS_PERF_GATE=off`).
 *
 *   node tests/canvas-camera.browser.mjs                # compare (or skip)
 *   node tests/canvas-camera.browser.mjs --record        # record a baseline
 *   CANVAS_BASELINE_REF=origin/main node … --record       # A/B re-record
 *
 * No dev server, no Convex, no API keys — every non-origin request fails the
 * run (see `canvas-harness.mjs`'s `openPage`).
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildHarness,
  checker,
  droppedFrames,
  launch,
  machineKey,
  openPage,
  percentiles,
  repo,
  writeArtifact,
} from "./canvas-harness.mjs";

const RECORD = process.argv.includes("--record");
const PERF_GATE_OFF = process.env.CANVAS_PERF_GATE === "off";
const BASELINE_REF = process.env.CANVAS_BASELINE_REF;
const VIEWPORT = { width: 1200, height: 800 };
const PHASE_FRAMES = 120;
const SETTLE_MS = 200; // > useViewport's SETTLE_MS (140ms)

const c = checker();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function baselinePath(key) {
  return path.join(repo, "tests", "baselines", `canvas-camera.${key}.json`);
}

async function writeBaseline(key, record) {
  await mkdir(path.dirname(baselinePath(key)), { recursive: true });
  await writeFile(baselinePath(key), JSON.stringify(record, null, 2) + "\n");
}

async function readBaseline(key) {
  try {
    return JSON.parse(await readFile(baselinePath(key), "utf8"));
  } catch {
    return null;
  }
}

/** One 3-phase block against an already-mounted, already-settled page.
 *  Returns per-phase `{intervals, dropped}`, the run's `wheelHandlerMs`, and
 *  runs every correctness assertion (C1–C8, C11) inline via `c`. */
async function runOnce(page) {
  const ev = (fn, ...args) => page.evaluate(fn, ...args);

  await ev((fixture) => window.canvasHarness.mount(fixture, { width: 1200, height: 800 }), "flat-board");
  await ev(() => window.canvasHarness.focus());
  await ev(() => window.canvasHarness.look({ x: 600, y: 400 }, 1));
  const centre = await ev(() => window.canvasHarness.toClient({ x: 600, y: 400 }));
  // A hover is a selection-store change, never a scene-store one — allowed,
  // and reset away below regardless.
  await page.mouse.move(centre.x, centre.y);
  await sleep(SETTLE_MS);
  await ev(() => window.canvasHarness.resetCounters());
  const before = await ev(() => ({
    token: window.canvasHarness.sceneToken(),
    dom: window.canvasHarness.shapeDom(),
    source: window.canvasHarness.source(),
  }));

  const wheelHandlerMs = [];
  const phaseResult = {};

  const checkCommon = async (phase) => {
    const counters = await ev(() => window.canvasHarness.counters());
    const after = await ev(() => ({
      token: window.canvasHarness.sceneToken(),
      dom: window.canvasHarness.shapeDom(),
      source: window.canvasHarness.source(),
    }));
    c.check(`camera.${phase}.zeroNotifications`, counters.notifications, 0);
    c.check(`camera.${phase}.identicalSceneToken`, after.token, before.token);
    c.check(`camera.${phase}.zeroSceneIdentityChanges`, counters.sceneIdentityChanges, 0);
    const domEqual = after.dom === before.dom;
    c.check(`camera.${phase}.identicalShapeDom`, domEqual, true);
    if (!domEqual) {
      const a = before.dom.slice(0, 200);
      const b = after.dom.slice(0, 200);
      console.log(`    first 200 chars before: ${a}\n    first 200 chars after:  ${b}`);
    }
    c.check(`camera.${phase}.zeroShapeMutations`, counters.shapeMutations, 0);
    if (counters.shapeMutations > 0) {
      console.log(`    first mutations: ${JSON.stringify(counters.shapeMutationSamples)}`);
    }
    c.check(`camera.${phase}.zeroWrites`, counters.writes, 0);
    c.check(`camera.${phase}.identicalSource`, after.source === before.source, true);
    c.check(`camera.${phase}.zeroHistoryPushes`, counters.historyPushes, 0);
    c.check(`camera.${phase}.zeroSelectionOnlyPushes`, counters.selectionOnlyPushes, 0);
    const refit = await page.evaluate(() => document.querySelector(".nt-canvas-refit") !== null);
    c.check(`camera.${phase}.noRefit`, refit, false);
    await ev(() => window.canvasHarness.resetCounters());
  };

  const settleCheck = async (phase) => {
    await sleep(SETTLE_MS);
    const style = await ev(() => window.canvasHarness.sceneStyle());
    c.check(`camera.${phase}.willChangeSettled`, style.willChange, "");
  };

  // -- pan --------------------------------------------------------------
  await ev(() => window.canvasHarness.startFrames());
  const panStart = await ev(() => window.canvasHarness.api().viewport.get());
  for (let i = 0; i < PHASE_FRAMES; i++) {
    const dx = i % 2 ? 4 : -4;
    await page.mouse.wheel(dx, 6);
    await ev(() => window.canvasHarness.nextFrame());
    if (i === 10) {
      const style = await ev(() => window.canvasHarness.sceneStyle());
      c.check("camera.pan.willChangeDuring", style.willChange, "transform");
    }
  }
  const panSampled = await ev(() => window.canvasHarness.stopFrames());
  const panEnd = await ev(() => window.canvasHarness.api().viewport.get());
  c.check(
    "camera.pan.cameraMoved",
    { dx: Math.abs(panEnd.x - panStart.x) <= 1, dy: Math.abs(panEnd.y - (panStart.y - 720)) <= 1 },
    { dx: true, dy: true },
  );
  wheelHandlerMs.push(...panSampled.wheelHandlerMs);
  phaseResult.pan = { intervals: panSampled.intervals, dropped: droppedFrames(panSampled.intervals, 16.667) };
  await checkCommon("pan");
  await settleCheck("pan");

  // -- zoom ---------------------------------------------------------------
  await ev(() => window.canvasHarness.startFrames());
  await page.keyboard.down("Control");
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, -5);
    await ev(() => window.canvasHarness.nextFrame());
  }
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, 5);
    await ev(() => window.canvasHarness.nextFrame());
  }
  await page.keyboard.up("Control");
  const zoomSampled = await ev(() => window.canvasHarness.stopFrames());
  const zoomEnd = await ev(() => window.canvasHarness.api().viewport.get());
  c.check("camera.zoom.returnsToStart", Math.abs(zoomEnd.zoom - 1) < 1e-6, true);
  wheelHandlerMs.push(...zoomSampled.wheelHandlerMs);
  phaseResult.zoom = { intervals: zoomSampled.intervals, dropped: droppedFrames(zoomSampled.intervals, 16.667) };
  await checkCommon("zoom");
  await settleCheck("zoom");

  // -- drag (hand tool) -----------------------------------------------------
  await ev(() => window.canvasHarness.api().setTool("hand"));
  const preDrag = await ev(() => window.canvasHarness.api().viewport.get());
  await ev(() => window.canvasHarness.startFrames());
  await page.mouse.down();
  const RADIUS = 120;
  let sawGrabbing = false;
  // A circle through `centre` itself (not one centred ON it): offsetting by
  // `cos(angle) - 1` puts angle 0 (and, exactly, angle 2π) back at (0, 0),
  // so the 120th move — `angle((i+1)/120 · 2π)` — lands the pointer back on
  // its own mouse.down position instead of stopping 3° short of the loop.
  for (let i = 0; i < PHASE_FRAMES; i++) {
    const angle = (2 * Math.PI * (i + 1)) / PHASE_FRAMES;
    await page.mouse.move(centre.x + RADIUS * (Math.cos(angle) - 1), centre.y + RADIUS * Math.sin(angle));
    await ev(() => window.canvasHarness.nextFrame());
    if (i === 30) {
      sawGrabbing = await page.evaluate(() => document.querySelector(".nt-canvas-viewport.is-grabbing") !== null);
    }
  }
  await page.mouse.up();
  await ev(() => window.canvasHarness.api().setTool("move"));
  const dragSampled = await ev(() => window.canvasHarness.stopFrames());
  const postDrag = await ev(() => window.canvasHarness.api().viewport.get());
  c.check("camera.drag.isGrabbingDuring", sawGrabbing, true);
  c.check(
    "camera.drag.returnsWithin1px",
    Math.abs(postDrag.x - preDrag.x) <= 1 && Math.abs(postDrag.y - preDrag.y) <= 1,
    true,
  );
  c.todo("camera.drag.cancelledLeavesNoTrace");
  phaseResult.drag = { intervals: dragSampled.intervals, dropped: droppedFrames(dragSampled.intervals, 16.667) };
  await checkCommon("drag");
  await settleCheck("drag");

  // -- idle (C11) -----------------------------------------------------------
  await ev(() => window.canvasHarness.startFrames());
  for (let i = 0; i < 60; i++) await ev(() => window.canvasHarness.nextFrame());
  const idleSampled = await ev(() => window.canvasHarness.stopFrames());
  c.check("camera.idle.noLoaf", idleSampled.loaf.length, 0);
  const idleCounters = await ev(() => window.canvasHarness.counters());
  c.check(
    "camera.idle.countersUnchanged",
    {
      notifications: idleCounters.notifications,
      writes: idleCounters.writes,
      historyPushes: idleCounters.historyPushes,
      selectionOnlyPushes: idleCounters.selectionOnlyPushes,
      shapeMutations: idleCounters.shapeMutations,
    },
    { notifications: 0, writes: 0, historyPushes: 0, selectionOnlyPushes: 0, shapeMutations: 0 },
  );

  return { phases: phaseResult, wheelHandlerMs };
}

function summarizePhase(runs) {
  // `runs` is one array of interval-sets per run, for one phase.
  const perRun = runs.map((r) => percentiles(r.intervals));
  const p95s = perRun.map((p) => p.p95).sort((a, b) => a - b);
  const median = p95s[Math.floor((p95s.length - 1) / 2)];
  const droppedList = runs.map((r) => r.dropped).sort((a, b) => a - b);
  const medianDropped = droppedList[Math.floor((droppedList.length - 1) / 2)];
  return { gateP95: median, medianDropped, runs: perRun.map((p, i) => ({ ...p, dropped: runs[i].dropped })) };
}

async function main() {
  const built = await buildHarness();
  const { browser, mode, version } = await launch();
  try {
    const key = await machineKey(version);
    const baseline = await readBaseline(key);

    const runCount = RECORD ? 5 : 3;
    const warmups = RECORD ? 1 : 0;
    const collected = { pan: [], zoom: [] , drag: [] };
    const wheelHandlerMs = [];
    let lastRunAiReach = null;
    let lastGuards = null;

    for (let i = 0; i < warmups + runCount; i++) {
      const { page, guards } = await openPage(browser, built.origin, { viewport: VIEWPORT, aiReach: built.aiReach });
      await page.goto(built.origin, { waitUntil: "networkidle" });
      const result = await runOnce(page);
      if (i >= warmups) {
        collected.pan.push(result.phases.pan);
        collected.zoom.push(result.phases.zoom);
        collected.drag.push(result.phases.drag);
        wheelHandlerMs.push(...result.wheelHandlerMs);
      }
      lastRunAiReach = await page.evaluate(() => window.canvasHarness.aiReach());
      lastGuards = { requests: guards.requests(), errors: guards.errors() };
      const blocked = await page.evaluate(() => window.canvasHarness.counters().blockedCalls);
      c.check(`camera.guard.noBlockedCalls.run${i}`, blocked, []);
      await page.close();
    }

    c.check("camera.guard.noNetwork", lastGuards.requests, []);
    c.check("camera.guard.noConsoleErrors", lastGuards.errors, []);
    c.check("camera.guard.aiReach", [...lastRunAiReach].sort(), [...built.aiReach].sort());

    const wheelP95 = percentiles(wheelHandlerMs).p95;
    c.check("camera.all.wheelHandlerP95Under2ms", wheelP95 < 2, true);
    console.log(`  info wheelHandlerMs p95=${wheelP95.toFixed(3)}ms (n=${wheelHandlerMs.length})`);

    const summaries = { pan: summarizePhase(collected.pan), zoom: summarizePhase(collected.zoom), drag: summarizePhase(collected.drag) };
    for (const [phase, s] of Object.entries(summaries)) {
      console.log(`  info ${phase}: p95 runs=${s.runs.map((r) => r.p95.toFixed(2)).join(",")} gate=${s.gateP95.toFixed(2)} dropped=${s.runs.map((r) => r.dropped).join(",")}`);
    }

    if (RECORD) {
      if (BASELINE_REF) {
        await recordAgainstRef({ key, mode, version, browser, baseline });
      } else {
        const dirty = execFileSync("git", ["status", "--porcelain", "--", "app/components/editor/canvas"], { cwd: repo, encoding: "utf8" }).trim();
        if (dirty) {
          console.error("refusing to record: app/components/editor/canvas has uncommitted changes\n" + dirty);
          process.exitCode = 1;
          return;
        }
        const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
        const record = {
          key,
          recordedAt: new Date().toISOString(),
          commit,
          mode,
          browser: `Chromium ${version} channel=${process.env.CANVAS_BROWSER_CHANNEL === "headless-shell" ? "headless-shell" : "chromium"}`,
          fixture: { name: "flat-board", shapes: 1000, seed: 1 },
          viewport: VIEWPORT,
          protocol: { warmup: warmups, runs: runCount, framesPerPhase: PHASE_FRAMES, ref: null },
          envelope: { relative: 0.05, absoluteMs: 0.4 },
          phases: {
            pan: { gateP95: summaries.pan.gateP95, runs: summaries.pan.runs },
            zoom: { gateP95: summaries.zoom.gateP95, runs: summaries.zoom.runs },
            drag: { gateP95: summaries.drag.gateP95, runs: summaries.drag.runs },
          },
          wheelHandlerP95: wheelP95,
        };
        await writeBaseline(key, record);
        console.log(`\nrecorded baseline: ${baselinePath(key)}`);
      }
    } else {
      gateAgainstBaseline(baseline, mode, summaries);
    }

    const artifact = {
      key,
      mode,
      browser: version,
      commit: safeCommit(),
      baseline: baseline ? baselinePath(key) : null,
      phases: {
        pan: { ...percentiles(collected.pan.at(-1)?.intervals ?? []), dropped: collected.pan.at(-1)?.dropped ?? 0, intervals: collected.pan.at(-1)?.intervals ?? [] },
        zoom: { ...percentiles(collected.zoom.at(-1)?.intervals ?? []), dropped: collected.zoom.at(-1)?.dropped ?? 0, intervals: collected.zoom.at(-1)?.intervals ?? [] },
        drag: { ...percentiles(collected.drag.at(-1)?.intervals ?? []), dropped: collected.drag.at(-1)?.dropped ?? 0, intervals: collected.drag.at(-1)?.intervals ?? [] },
      },
      wheelHandler: percentiles(wheelHandlerMs),
      counters: {},
      verdict: RECORD ? "recorded" : baseline ? (c.summary().failed === 0 ? "pass" : "fail") : PERF_GATE_OFF ? "gate-off" : "no-baseline",
    };
    const artifactPath = await writeArtifact("canvas-camera", artifact);
    console.log(`  artifact: ${artifactPath}`);
  } finally {
    await browser.close();
    await built.close();
  }
}

function safeCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function gateAgainstBaseline(baseline, mode, summaries) {
  if (!baseline) {
    console.log("  skip camera.baseline.* — no-baseline (run: npm run test:canvas:camera:record on this machine)");
    return;
  }
  if (baseline.mode !== mode) {
    console.log(`  skip camera.baseline.* — baseline was recorded in "${baseline.mode}" mode, this run is "${mode}"`);
    return;
  }
  if (PERF_GATE_OFF) {
    for (const phase of ["pan", "zoom", "drag"]) {
      console.log(`  skip camera.baseline.${phase}.p95 — gate-off`);
    }
    return;
  }
  const envelope = baseline.envelope ?? { relative: 0.05, absoluteMs: 0.4 };
  for (const phase of ["pan", "zoom", "drag"]) {
    const base = baseline.phases[phase];
    const now = summaries[phase];
    if (mode === "vsync") {
      const limit = (base.runs?.reduce((a, r) => a + (r.dropped ?? 0), 0) / (base.runs?.length || 1) || 0) + 1;
      c.check(`camera.baseline.${phase}.droppedFrames`, now.medianDropped <= limit, true);
    } else {
      const limit = Math.max(base.gateP95 * (1 + envelope.relative), base.gateP95 + envelope.absoluteMs);
      c.check(`camera.baseline.${phase}.p95`, now.gateP95 <= limit, true);
      console.log(`  info ${phase} p95=${now.gateP95.toFixed(2)}ms limit=${limit.toFixed(2)}ms baseline=${base.gateP95.toFixed(2)}ms`);
    }
  }
}

/** §3.1.6's A/B re-record: A is `CANVAS_BASELINE_REF`'s tree, B is the
 *  working tree, alternated in one browser/process so the only variable is
 *  the source. Refuses to write a new baseline if A itself has drifted from
 *  the committed one by more than the envelope — the machine, not the code,
 *  moved, and a number taken now would be flattering or unfair either way. */
async function recordAgainstRef({ key, mode, version, browser, baseline }) {
  if (!baseline) {
    console.error("refusing an A/B re-record: no existing baseline to compare A against");
    process.exitCode = 1;
    return;
  }
  const builtA = await buildHarness({ ref: BASELINE_REF });
  const aRuns = { pan: [], zoom: [], drag: [] };
  const bRuns = { pan: [], zoom: [], drag: [] };
  const totalPairs = 5;
  for (let i = 0; i < 1 + totalPairs; i++) {
    const discard = i === 0;
    // A
    {
      const { page } = await openPage(browser, builtA.origin, { viewport: VIEWPORT, aiReach: builtA.aiReach });
      await page.goto(builtA.origin, { waitUntil: "networkidle" });
      const result = await runOnce(page);
      if (!discard) for (const phase of ["pan", "zoom", "drag"]) aRuns[phase].push(result.phases[phase]);
      await page.close();
    }
    // B (the caller's own already-built harness is for the working tree;
    // re-open a fresh page against it for parity with A's fresh page).
    {
      const builtB = await buildHarness();
      const { page } = await openPage(browser, builtB.origin, { viewport: VIEWPORT, aiReach: builtB.aiReach });
      await page.goto(builtB.origin, { waitUntil: "networkidle" });
      const result = await runOnce(page);
      if (!discard) for (const phase of ["pan", "zoom", "drag"]) bRuns[phase].push(result.phases[phase]);
      await page.close();
      await builtB.close();
    }
  }
  await builtA.close();

  const envelope = baseline.envelope ?? { relative: 0.05, absoluteMs: 0.4 };
  let driftedPhase = null;
  const aSummaries = {};
  for (const phase of ["pan", "zoom", "drag"]) {
    aSummaries[phase] = summarizePhase(aRuns[phase]);
    const base = baseline.phases[phase];
    const limit = Math.max(base.gateP95 * (1 + envelope.relative), base.gateP95 + envelope.absoluteMs);
    if (mode !== "vsync" && aSummaries[phase].gateP95 > limit) driftedPhase = phase;
  }
  if (driftedPhase) {
    console.error(
      `refusing to record: A (${BASELINE_REF}) has drifted from the committed baseline on "${driftedPhase}" ` +
        `(${aSummaries[driftedPhase].gateP95.toFixed(2)}ms vs baseline ${baseline.phases[driftedPhase].gateP95.toFixed(2)}ms) — the machine, not the code, moved`,
    );
    process.exitCode = 1;
    return;
  }

  const bSummariesFinal = { pan: summarizePhase(bRuns.pan), zoom: summarizePhase(bRuns.zoom), drag: summarizePhase(bRuns.drag) };
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const record = {
    key,
    recordedAt: new Date().toISOString(),
    commit,
    mode,
    browser: `Chromium ${version}`,
    fixture: { name: "flat-board", shapes: 1000, seed: 1 },
    viewport: VIEWPORT,
    protocol: { warmup: 1, runs: totalPairs, framesPerPhase: PHASE_FRAMES, ref: BASELINE_REF },
    envelope,
    abPairs: { a: aSummaries, b: bSummariesFinal },
    phases: {
      pan: { gateP95: bSummariesFinal.pan.gateP95, runs: bSummariesFinal.pan.runs },
      zoom: { gateP95: bSummariesFinal.zoom.gateP95, runs: bSummariesFinal.zoom.runs },
      drag: { gateP95: bSummariesFinal.drag.gateP95, runs: bSummariesFinal.drag.runs },
    },
    wheelHandlerP95: baseline.wheelHandlerP95,
  };
  await writeBaseline(key, record);
  console.log(`\nrecorded A/B baseline against ${BASELINE_REF}: ${baselinePath(key)}`);
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
