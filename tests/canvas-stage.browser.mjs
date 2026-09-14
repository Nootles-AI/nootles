/**
 * The STAGE skeleton (build-plan Conflict 3 / OQ-3): every case STAGE will
 * own is listed here by name, each routed through `todo(name)`, so the gate
 * this session's Wave 1 close-out runs (`npm run test:canvas:stage`) boots
 * cleanly and CI's `canvas-browser` job has something to run today. Nothing
 * here drives real input — STAGE's own Wave 3 commit *modifies this file in
 * place*: it flips each `todo(name)` to `check(...)`/`xfail(...)` and fills
 * in the driver against `CanvasApi.screen` (`engine/screen.ts`), the zoom
 * tool (`engine/zoomTool.ts`) and the `view.stage`/`view.minimal`/
 * `view.fullscreen` shortcuts — none of which exist on `main` yet. STAGE
 * does not re-create this file (build-plan §1.2's `tests/canvas-stage.browser.{mjs,tsx}`
 * row); it also adds the paired `.tsx` fixture page this skeleton never
 * needed, since mounting the existing `small-diagram` fixture through the
 * shared `tests/canvas-harness.browser.tsx` is enough to prove the harness
 * itself boots.
 *
 * The fixture (HARNESS.md §3.3): `small-diagram` — a 960×540 scene with one
 * painted group `g1` (two rects, a text), one free rect `s1` with a label,
 * and one edge `e1: s1 → g1`. Mounting it here, even though every case below
 * is a no-op, is what proves this runner's own plumbing (build, launch,
 * mount) is sound in the meantime — a `todo`-only file that couldn't even
 * boot the harness would be worse than no file.
 *
 *   node tests/canvas-stage.browser.mjs
 *
 * No dev server, no Convex, no API keys — every non-origin request fails the
 * run (see `canvas-harness.mjs`'s `openPage`).
 */
import { buildHarness, checker, launch, openPage, repo, writeArtifact } from "./canvas-harness.mjs";
import { execFileSync } from "node:child_process";

const VIEWPORT = { width: 1280, height: 900 };

const c = checker();

/**
 * Every case STAGE's Wave 3 commit will implement, and the pre-condition it
 * will assert — printed alongside `todo(name)` so a `--verbose`-free run
 * still reads as documentation, not just a bare list of names. Lifted
 * verbatim from HARNESS.md §3.3's case table; STAGE's own commit is the only
 * place these descriptions should otherwise need to live.
 */
const CASES = [
  {
    name: "stage.enter.keepsCentre",
    will:
      "p0 = clientToScene(containerCentre) before; after ⌘⇧F the scene point under the (now larger) " +
      "container's centre equals p0 within 0.5px; store notifications 0; shapeDom() identical",
  },
  {
    name: "stage.exit.restoresCamera",
    will:
      "after Escape (last rung) viewport.get() deep-equals the pre-enter viewport; " +
      "document.scrollingElement.scrollTop restored",
  },
  {
    name: "stage.enter.menuOpen",
    will:
      "right-click s1 → .nt-ctx[role=menu] present; enter stage; menu still present and Escape closes " +
      "only the menu (selection intact, stage still on)",
  },
  {
    name: "stage.enter.labelEditing",
    will:
      "double-click s1 twice → editingLabel().focused; enter stage; still focused, caret preserved, " +
      "typing lands; Escape ends the edit only",
  },
  {
    name: "stage.enter.groupEntered",
    will:
      "double-click into g1 → selection().enteredPath === [\"g1\"]; enter stage; unchanged; Escape order: " +
      "step out → deselect → leave stage",
  },
  {
    name: "stage.minimal.togglesChrome",
    will: "⌘. hides .nt-toolbar, .nt-lyr, .nt-style-panel (mounted by the harness shell stub); camera unchanged",
  },
  {
    name: "stage.fullscreen.consistent",
    will:
      "⌃⌘F → document.fullscreenElement === wrapper; a synthetic fullscreenchange with fullscreenElement " +
      "=== null leaves stage state consistent (headless may not honour requestFullscreen; tolerate a " +
      "rejected promise and mark todo if document.fullscreenEnabled === false)",
  },
  {
    name: "stage.camera.gateUnchanged",
    will: "after enter and exit, re-run the camera pan phase (§3.1.3) once: C1–C3 hold",
  },
];

async function main() {
  const built = await buildHarness();
  const { browser } = await launch();
  try {
    const { page } = await openPage(browser, built.origin, { viewport: VIEWPORT, aiReach: built.aiReach });
    await page.goto(built.origin, { waitUntil: "networkidle" });

    // Proves the shared harness boots against this fixture — the one thing
    // this skeleton commits to. No case below reads anything from it yet.
    await page.evaluate((fixture) => window.canvasHarness.mount(fixture), "small-diagram");
    await page.evaluate(() => window.canvasHarness.focus());

    for (const { name, will } of CASES) {
      console.log(`    will assert: ${will}`);
      c.todo(name);
    }

    const artifact = {
      commit: safeCommit(),
      summary: c.summary(),
      verdict: "todo",
    };
    const artifactPath = await writeArtifact("canvas-stage", artifact);
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
