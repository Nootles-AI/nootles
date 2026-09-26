/**
 * A diagram suggestion on a real page (`diagram-suggest.browser.tsx`), driven
 * by a scripted stream — never a model. It walks the suggestion through its
 * three states (thinking, drawing, waiting on Tab), photographs each for a
 * column and a wide diagram, and checks:
 *
 *   - the ghost is one element for the whole run, never rebuilt per chunk, and
 *     a shape already drawn holds still as the next ones arrive;
 *   - Tab — finished or mid-stream — lands the diagram exactly where the ghost
 *     stood: the band, every shape, and the paragraph below it;
 *   - Escape takes it away and gives the page its height back;
 *   - while planning the band says so, centred and pulsing, and the caret line
 *     says nothing past the caret; the words fade once the first shape comes;
 *   - reduced motion stops every animation the ghost runs.
 *
 * Every non-origin request is aborted and the page's own fetch throws, so a
 * run cannot reach a paid endpoint even by accident.
 *
 *   node tests/diagram-suggest.browser.mjs            # checks + screenshots
 *   SHOTS=before node tests/diagram-suggest.browser.mjs   # screenshots only, named before-*
 *
 * Screenshots land in `tests/.artifacts/diagram-suggest/`.
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checker, launch, openPage, repo, writeAppStylesheet } from "./canvas-harness.mjs";

const prefix = process.env.SHOTS === "before" ? "before" : "after";
const shotsOnly = prefix === "before";
const shots = path.join(repo, "tests/.artifacts/diagram-suggest");
await mkdir(shots, { recursive: true });

const output = await mkdtemp(path.join(tmpdir(), "diagram-suggest-"));
await build({
  absWorkingDir: repo,
  entryPoints: ["tests/diagram-suggest.browser.tsx"],
  bundle: true,
  splitting: true,
  format: "esm",
  outdir: output,
  platform: "browser",
  conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [
    {
      name: "browser-stubs",
      setup(builder) {
        builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({
          path: "server-only",
          namespace: "fixture",
        }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached the browser fixture") };',
        }));
      },
    },
  ],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
  logLevel: "warning",
});
await writeAppStylesheet(output);
await writeFile(
  path.join(output, "index.html"),
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/diagram-suggest.browser.css"><style>html,body{height:100%;margin:0}</style></head><body><div id="app"></div><script type="module" src="/diagram-suggest.browser.js"></script></body></html>',
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
      name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html",
    );
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const { check, summary, failures } = checker();
const { browser } = await launch();

/** Rounded to the half pixel: sub-pixel layout noise is not a shift anyone sees. */
const r = (v) => Math.round(v * 2) / 2;
const rect = (b) => b && { left: r(b.left), top: r(b.top), width: r(b.width), height: r(b.height) };
const rects = (m) => Object.fromEntries(Object.entries(m).map(([id, b]) => [id, rect(b)]));

const written = [];

async function scenario(viewport, fn) {
  const { page, guards } = await openPage(browser, origin, { viewport });
  await page.addInitScript(() => {
    window.WebSocket = class extends EventTarget {
      readyState = 0;
      send() {
        throw new Error("fixture socket must never send");
      }
      close() {
        this.readyState = 3;
      }
    };
  });
  await page.goto(origin);
  await page.waitForFunction(() => window.diagramSuggest?.ready());
  const at = (fn, ...args) => page.evaluate(({ fn, args }) => window.diagramSuggest[fn](...args), { fn, args });
  const settle = (ms = 0) =>
    page.evaluate(
      (ms) => new Promise((done) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(done)), ms)),
      ms,
    );
  const shoot = async (name) => {
    const lead = await at("lead");
    const after = await at("after");
    const top = Math.max(0, lead.top - 48);
    const bottom = Math.min(viewport.height, after.top + after.height + 40);
    const file = path.join(shots, `${prefix}-${name}.png`);
    await page.screenshot({ path: file, clip: { x: 0, y: top, width: viewport.width, height: bottom - top } });
    written.push(path.relative(repo, file));
  };
  try {
    await fn({ page, at, settle, shoot });
    check(`[${viewport.width}px] no page errors`, guards.errors(), []);
    check(`[${viewport.width}px] no requests off the fixture`, guards.requests(), []);
  } finally {
    await page.close();
  }
}

/** Streams the fixture in `steps` chunks, calling `each` after every one that drew something. */
async function stream({ at, settle }, steps, until = 1, each = async () => {}) {
  const total = await at("length");
  for (let i = 1; i <= steps; i++) {
    const n = Math.round((total * until * i) / steps);
    if (await at("stream", n)) {
      await settle();
      await each(i);
    }
  }
}

try {
  // ---- A column diagram, with the prose half of the suggestion before it.
  await scenario({ width: 1280, height: 900 }, async (ctx) => {
    const { page, at, settle, shoot } = ctx;
    await at("reset", "column", ", from push to production:");
    await settle();
    const bare = await at("after");

    await at("think");
    await settle(400);
    await shoot("column-1-thinking");
    if (!shotsOnly) {
      check("thinking: the ghost says so", await at("phase"), "thinking");
      check("thinking: the caret line has the caret alone, no words", await at("status"), null);
      check(
        "thinking: the caret still pulses on the caret line",
        await page.evaluate(() => !!document.querySelector(".nt-ghost .nt-stream-head.is-live")),
        true,
      );
      const plan = await at("planning");
      check("thinking: the band says it is planning", [plan?.text, plan?.opacity, plan?.italic], ["Planning diagram", 1, true]);
      check("thinking: the planning words sit centred in the band", plan?.offset, [0, 0]);
      check("thinking: the planning words pulse", plan?.animation, "nt-ghost-plan");
    }

    // One element for the whole run, so a chunk never rebuilds what is drawn.
    await page.evaluate(() => {
      window.__ghost = document.querySelector(".nt-diagram-ghost");
    });
    let before = null;
    let moved = [];
    let rebuilt = false;
    await stream(ctx, 8, 0.8, async () => {
      const now = rects(await at("ghostShapes"));
      if (before) {
        for (const [id, b] of Object.entries(before)) {
          if (now[id] && JSON.stringify(now[id]) !== JSON.stringify(b)) moved.push(id);
        }
      }
      before = now;
      rebuilt ||= await page.evaluate(() => document.querySelector(".nt-diagram-ghost") !== window.__ghost);
    });
    await settle(400);
    await shoot("column-2-drawing");
    if (!shotsOnly) {
      check("drawing: the ghost says so", await at("phase"), "drawing");
      check("drawing: the caret line says so", await at("status"), "Drawing diagram");
      const plan = await at("planning");
      check("drawing: the planning words are gone from the band", [plan?.opacity, plan?.animation], [0, "none"]);
      check("drawing: the ghost is the same element from thinking on", rebuilt, false);
      check("drawing: a shape already drawn holds still as the next arrive", moved, []);
    }

    await at("complete");
    await settle(700);
    await shoot("column-3-waiting");
    if (!shotsOnly) {
      check("waiting: the ghost says so", await at("phase"), "waiting");
      check("waiting: the caret line offers Tab and Escape", await at("status"), "Tab to insert Esc to dismiss");
      check(
        "waiting: still the one element",
        await page.evaluate(() => document.querySelector(".nt-diagram-ghost") === window.__ghost),
        true,
      );
    }
    const ghost = rect(await at("ghost"));
    const ghostShapes = rects(await at("ghostShapes"));
    const afterGhost = rect(await at("after"));

    await page.keyboard.press("Tab");
    await page.waitForFunction(() => window.diagramSuggest.real() !== null, null, { timeout: 3000 });
    await settle(300);
    await shoot("column-4-accepted");
    if (!shotsOnly) {
      check("Tab: the suggestion is gone", [await at("showing"), await at("ghostEls")], [null, 0]);
      check("Tab: the diagram lands in the ghost's band exactly", rect(await at("real")), ghost);
      check("Tab: every shape lands where its ghost stood", rects(await at("realShapes")), ghostShapes);
      check("Tab: the paragraph below does not move", rect(await at("after")), afterGhost);
    }

    // ---- Escape: the ghost goes, and the page gives its room back.
    await at("undoLanding");
    await settle(200);
    await at("reset", "column", "");
    await at("think");
    await stream(ctx, 3);
    await at("complete");
    await settle(500);
    await page.keyboard.press("Escape");
    await settle(300);
    if (!shotsOnly) {
      check("Escape: the suggestion is gone", [await at("showing"), await at("ghostEls")], [null, 0]);
      check("Escape: nothing landed", (await at("blocks")).includes("canvas"), false);
      check("Escape: the paragraph below is back where it was", rect(await at("after")).top, r(bare.top));
    }

    // ---- Tab mid-stream lands what was on screen, where it was on screen.
    await at("reset", "column", "");
    await at("think");
    await stream(ctx, 5, 0.6);
    await settle(500);
    const midGhost = rect(await at("ghost"));
    const midShapes = rects(await at("ghostShapes"));
    const midAfter = rect(await at("after"));
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => window.diagramSuggest.real() !== null, null, { timeout: 3000 });
    await settle(300);
    if (!shotsOnly) {
      check("Tab mid-stream: the band lands in the ghost's place", rect(await at("real")), midGhost);
      check("Tab mid-stream: every shape drawn so far lands where it stood", rects(await at("realShapes")), midShapes);
      check("Tab mid-stream: the paragraph below does not move", rect(await at("after")), midAfter);
    }
  });

  // ---- A wide diagram: drawn at the wide band's real geometry, margins and all.
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 760, height: 1000 },
  ]) {
    await scenario(viewport, async (ctx) => {
      const { page, at, settle, shoot } = ctx;
      const tag = viewport.width < 1000 ? "wide-narrow-pane" : "wide";
      await at("reset", "wide", "");
      await at("think");
      await settle(300);
      if (tag === "wide") await shoot(`${tag}-1-thinking`);
      await stream(ctx, 6, 0.7);
      await settle(400);
      await shoot(`${tag}-2-drawing`);
      await at("complete");
      await settle(700);
      await shoot(`${tag}-3-waiting`);
      const ghost = rect(await at("ghost"));
      const ghostShapes = rects(await at("ghostShapes"));
      const afterGhost = rect(await at("after"));
      await page.keyboard.press("Tab");
      await page.waitForFunction(() => window.diagramSuggest.real() !== null, null, { timeout: 3000 });
      await settle(300);
      if (!shotsOnly) {
        check(`[${tag}] Tab: the wide band lands in the ghost's band exactly`, rect(await at("real")), ghost);
        check(`[${tag}] Tab: every shape lands where its ghost stood`, rects(await at("realShapes")), ghostShapes);
        check(`[${tag}] Tab: the paragraph below does not move`, rect(await at("after")), afterGhost);
      }
    });
  }

  // ---- Reduced motion: the ghost still says its state, and nothing moves.
  if (!shotsOnly) {
    const { page, guards } = await openPage(browser, origin, { viewport: { width: 1280, height: 900 } });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(origin);
    await page.waitForFunction(() => window.diagramSuggest?.ready());
    const at = (fn, ...args) => page.evaluate(({ fn, args }) => window.diagramSuggest[fn](...args), { fn, args });
    await at("reset", "column", "");
    await at("think");
    await page.waitForTimeout(100);
    const plan = await at("planning");
    check(
      "reduced motion: the band still says it is planning, steady",
      [plan?.text, plan?.opacity, plan?.animation],
      ["Planning diagram", 1, "none"],
    );
    await at("stream", 400);
    await page.waitForTimeout(100);
    // The app's own reduced-motion rule shortens transitions to a hair rather
    // than removing them, so anything under a millisecond counts as still.
    const moving = await page.evaluate(() => {
      const longest = (list) => Math.max(...list.split(",").map((t) => parseFloat(t) * (t.trim().endsWith("ms") ? 1 : 1000)));
      return [...document.querySelectorAll(".nt-diagram-ghost, .nt-diagram-ghost *, .nt-ghost-status, .nt-ghost-status *")]
        .flatMap((el) => ["", "::before", "::after"].map((p) => [el, p, getComputedStyle(el, p || null)]))
        .filter(([, , s]) =>
          (s.animationName !== "none" && longest(s.animationDuration) >= 1) ||
          (s.transitionProperty !== "none" && longest(s.transitionDuration) >= 1),
        )
        .map(([el, p, s]) => `${el.className?.baseVal ?? el.className}${p} ${s.animationName} ${s.transitionProperty}`);
    });
    check("reduced motion: nothing in the ghost animates", moving, []);
    check("reduced motion: the state still reads", await at("status"), "Drawing diagram");
    check("[reduced] no page errors", guards.errors(), []);
    await page.close();
  }
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.log(`  FAIL ${error?.message ?? error}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log("\nScreenshots:");
for (const file of written) console.log(`  ${file}`);

if (shotsOnly) process.exit(0);
const { failed } = summary();
if (failed || failures.length) {
  console.log(`\n${Math.max(failed, failures.length)} diagram suggestion check(s) failed.`);
  process.exit(1);
}
console.log("\nAll diagram suggestion checks passed.");
