/**
 * A diagram made, taken away, and another made where it was
 * (`canvas-rebirth.browser.tsx`): the new one starts empty and narrow, however
 * the old one went — taken back with ⌘Z or deleted with its last shape — and
 * undoing back to the old one brings it back wide, with its shapes. And a new
 * one offers its presets: chosen, closed, or drawn past, the offer ends.
 *
 *   node tests/canvas-rebirth.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checker, launch, openPage, repo, writeAppStylesheet } from "./canvas-harness.mjs";

const output = await mkdtemp(path.join(tmpdir(), "canvas-rebirth-"));

await build({
  absWorkingDir: repo,
  entryPoints: ["tests/canvas-rebirth.browser.tsx"],
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
          contents:
            'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached the browser fixture") };',
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
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/canvas-rebirth.browser.css"><style>html,body{height:100%;margin:0}</style></head><body><div id="app"></div><script type="module" src="/canvas-rebirth.browser.js"></script></body></html>',
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

let guards = null;
let page = null;
try {
  ({ page, guards } = await openPage(browser, origin, { viewport: { width: 1100, height: 900 } }));
  // Convex's client opens its socket on the first subscription: one that
  // never connects, as in the other page harnesses.
  await page.addInitScript(() => {
    window.WebSocket = class extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
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
  await page.waitForFunction(() => window.canvasRebirth?.ready());
  const at = (fn, ...args) => page.evaluate(({ fn, args }) => window.canvasRebirth[fn](...args), { fn, args });
  const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const mounted = (id) => page.waitForFunction((id) => window.canvasRebirth.mounted(id), id, { timeout: 5000 });
  /** Undoes until the page holds these block kinds, or gives up. */
  const undoTo = async (kinds) => {
    for (let i = 0; i < 8 && JSON.stringify(await at("blocks")) !== JSON.stringify(kinds); i++) {
      await at("undo");
      await frame();
    }
    return at("blocks");
  };
  /** Undoes until this block is on the page again; whether it came back. */
  const undoUntilBack = async (id) => {
    for (let i = 0; i < 8 && !(await at("ids")).includes(id); i++) {
      await at("undo");
      await frame();
    }
    return (await at("ids")).includes(id);
  };

  // ---- Taken back with ⌘Z -------------------------------------------------
  let [intro, line] = await at("seed");
  await frame();
  const wide = await at("slash", "wide", line);
  await mounted(wide);
  await at("put", wide, "w1");
  await frame();
  check("a wide diagram is born wide", await at("scene", wide), { wide: "pinned", nodes: ["w1"] });
  check("under an id of its own, not the line's", wide !== line, true);

  check("⌘Z takes it back to the line", await undoTo(["paragraph", "paragraph"]), ["paragraph", "paragraph"]);
  await at("redo");
  await frame();
  await mounted(wide);
  await at("redo");
  await frame();
  check("redo brings it back whole", await at("scene", wide), { wide: "pinned", nodes: ["w1"] });
  await undoTo(["paragraph", "paragraph"]);

  line = (await at("ids"))[1];
  const plain = await at("slash", "diagram", line);
  await mounted(plain);
  check("a diagram made on the same line is a new one", plain !== wide, true);
  check("and starts narrow and empty", await at("scene", plain), { wide: false, nodes: [] });
  check("undoing it brings back the line", await undoTo(["paragraph", "paragraph"]), ["paragraph", "paragraph"]);
  await at("redo");
  await frame();
  await mounted(plain);
  check("and redoing it brings back the same new diagram", await at("scene", plain), { wide: false, nodes: [] });

  // ---- Deleted with its last shape ----------------------------------------
  [intro, line] = await at("seed");
  await frame();
  const first = await at("slash", "wide", line);
  await mounted(first);
  await at("put", first, "w2");
  await frame();
  await at("remove", first);
  await frame();
  check("deleted, the diagram is gone", await at("blocks"), ["paragraph"]);
  const next = await at("addLine", intro);
  const second = await at("slash", "diagram", next);
  await mounted(second);
  check("a diagram made where it was starts narrow and empty", await at("scene", second), { wide: false, nodes: [] });

  check("undoing back to the deleted diagram", await undoUntilBack(first), true);
  check("takes the new one away", (await at("ids")).includes(second), false);
  await mounted(first);
  check("brings it back wide, with its shapes", await at("scene", first), { wide: "pinned", nodes: ["w2"] });

  // ---- The presets a new diagram offers ----------------------------------
  // Not the copy a closed bar leaves fading for a moment (`leaveAsCopy`).
  const bar = (id) => page.locator(`[data-id="${id}"] .nt-canvas-presets:not(.is-leaving)`);
  const barShown = async (id) => (await bar(id).count()) === 1;
  const kinds = (shapes) => shapes.map((shape) => shape.kind);

  [intro, line] = await at("seed");
  await frame();
  const flow = await at("slash", "diagram", line);
  await mounted(flow);
  await frame();
  check("a diagram from the slash menu offers presets", await barShown(flow), true);
  check("in place of its Add shapes line", await page.locator(`[data-id="${flow}"] .nt-canvas-placeholder`).count(), 0);
  check(
    "Blank, or five of them",
    await bar(flow).evaluate((el) => [...el.children].map((child) => child.textContent)),
    ["Blank", "or", "Flowchart", "iPhone", "Browser", "Matrix", "Timeline"],
  );
  await bar(flow).locator('[data-preset="flowchart"]').click();
  await frame();
  check("choosing Flowchart draws it", await at("shapes", flow), [
    { kind: "rect", label: "Process" },
    { kind: "polygon", label: "Condition" },
    { kind: "rect", label: "End state" },
    { kind: "rect", label: "End state" },
  ]);
  check("with its shapes selected", await at("selected", flow), 4);
  check("and the bar gone", await barShown(flow), false);
  check("with the band holding the keyboard", await page.evaluate((id) => !!document.activeElement?.closest(`[data-id="${id}"]`), flow), true);
  await at("undo");
  await frame();
  check("one undo takes the preset back", await at("shapes", flow), []);
  check("and leaves the diagram", await at("blocks"), ["paragraph", "canvas"]);
  check("without offering the presets again", await barShown(flow), false);

  [intro, line] = await at("seed");
  await frame();
  const closed = await at("slash", "diagram", line);
  await mounted(closed);
  await frame();
  const shots = path.join(repo, "tests/.artifacts/presets");
  await mkdir(shots, { recursive: true });
  await page.mouse.move(0, 0);
  await frame();
  await page.locator(`[data-id="${closed}"] .nt-canvas`).first().screenshot({ path: path.join(shots, "bar.png") });
  await bar(closed).locator('[data-preset="blank"]').click();
  await frame();
  check("Blank closes the bar", await barShown(closed), false);
  check("and Add shapes is back", await page.locator(`[data-id="${closed}"] .nt-canvas-placeholder`).count(), 1);
  check("the diagram left empty, ready to draw", await at("shapes", closed), []);
  check("with the band holding the keyboard", await page.evaluate((id) => !!document.activeElement?.closest(`[data-id="${id}"]`), closed), true);

  [intro, line] = await at("seed");
  await frame();
  const drawn = await at("slash", "diagram", line);
  await mounted(drawn);
  await frame();
  await at("setTool", "rect");
  await frame();
  const band = await page.locator(`[data-id="${drawn}"] .nt-canvas`).first().boundingBox();
  await page.mouse.move(band.x + 60, band.y + 20);
  await page.mouse.down();
  await page.mouse.move(band.x + 180, band.y + 60, { steps: 4 });
  await page.mouse.up();
  await frame();
  check("a shape drawn instead is drawn", kinds(await at("shapes", drawn)), ["rect"]);
  check("and ends the offer", [await barShown(drawn), await at("offered", drawn)], [false, false]);
  await at("setTool", "move");

  [intro, line] = await at("seed");
  await frame();
  const wideBar = await at("slash", "wide", line);
  await mounted(wideBar);
  await frame();
  check("a wide canvas offers them too", await barShown(wideBar), true);
  await bar(wideBar).locator("button").first().focus();
  check("Blank comes first on the keyboard", await page.evaluate(() => document.activeElement?.getAttribute("data-preset")), "blank");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  check("the arrows walk the bar, past the or", await page.evaluate(() => document.activeElement?.getAttribute("data-preset")), "phone");
  await page.keyboard.press("Enter");
  await frame();
  check("Enter chooses: the iPhone lands as one group", kinds(await at("shapes", wideBar)), ["group"]);
  check("and the canvas stays wide", (await at("scene", wideBar)).wide, "pinned");
  check("selected whole", await at("selection", wideBar), { ids: ["iPhone"], entered: [] });
  const time = page.locator(`[data-id="${wideBar}"] [data-id="${await at("named", wideBar, "Time")}"]`);
  await time.dblclick();
  await frame();
  check("a double-click goes inside it, onto the part under the pointer", await at("selection", wideBar), {
    ids: ["Time"],
    entered: ["iPhone"],
  });
  await page.keyboard.press("Escape");
  await frame();
  check("and Escape steps back out onto the phone", await at("selection", wideBar), { ids: ["iPhone"], entered: [] });

  // Each preset as it lands, for the eye.
  for (const preset of ["flowchart", "phone", "browser", "matrix", "timeline"]) {
    [intro, line] = await at("seed");
    await frame();
    const shown = await at("slash", "diagram", line);
    await mounted(shown);
    await frame();
    await bar(shown).locator(`[data-preset="${preset}"]`).click();
    await at("clear", shown);
    await page.mouse.move(0, 0);
    await frame();
    await page.locator(`[data-id="${shown}"] .nt-canvas`).first().screenshot({ path: path.join(shots, `${preset}.png`) });
  }

  [intro, line] = await at("seed");
  await frame();
  const escaped = await at("slash", "diagram", line);
  await mounted(escaped);
  await frame();
  await bar(escaped).locator("button").first().focus();
  await page.keyboard.press("Escape");
  await frame();
  check("Escape closes the bar", await barShown(escaped), false);
  check("without taking the diagram", await at("blocks"), ["paragraph", "canvas"]);

  // ---- The arrows through a new diagram's presets ------------------------
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("data-preset") ?? null);
  const press = async (...keys) => {
    for (const key of keys) await page.keyboard.press(key);
    await frame();
  };
  /** A diagram placed as the slash menu places one — selected whole — with a line of text after it. */
  const placed = async () => {
    [intro, line] = await at("seed");
    await frame();
    const id = await at("slash", "diagram", line);
    const after = await at("addText", id, "After the diagram.");
    await mounted(id);
    await at("selectBlocks", [id]);
    await frame();
    return { id, after };
  };

  let arrowed = await placed();
  check("placed, the diagram is selected whole", await at("blockSelection"), [arrowed.id]);
  await press("ArrowRight");
  check("→ goes onto the bar's first option", await focused(), "blank");
  check("in its focus wash", await page.evaluate(() => document.activeElement?.matches(":focus-visible")), true);
  const walk = [];
  for (let i = 0; i < 5; i++) {
    await press("ArrowRight");
    walk.push(await focused());
  }
  check("→ walks each option in turn, past the or", walk, ["flowchart", "phone", "browser", "matrix", "timeline"]);
  await press("ArrowRight");
  check("→ off the last goes on into the text after the diagram", await at("caret"), { block: arrowed.after, offset: 0 });
  check("leaving the offer standing", [await barShown(arrowed.id), await at("shapes", arrowed.id)], [true, []]);

  arrowed = await placed();
  await press("ArrowRight", "ArrowRight", "ArrowRight", "ArrowLeft");
  check("← walks back", await focused(), "flowchart");
  await press("ArrowLeft");
  check("to the first option", await focused(), "blank");
  await press("ArrowLeft");
  check("← off the first goes back to the diagram's plate", [await focused(), await at("blockSelection")], [null, [arrowed.id]]);
  await press("ArrowLeft");
  check("and a further ← does what ← on a plate does", await at("caret"), {
    block: intro,
    offset: "A diagram goes below.".length,
  });

  arrowed = await placed();
  await press("ArrowRight", "ArrowRight", "Enter");
  check("→ → Enter chooses Flowchart", (await at("shapes", arrowed.id))[0], { kind: "rect", label: "Process" });
  check("and the bar goes", await barShown(arrowed.id), false);

  arrowed = await placed();
  await press("ArrowRight", "ArrowRight", "ArrowRight", "Space");
  check("Space chooses too: → → → Space is the iPhone", kinds(await at("shapes", arrowed.id)), ["group"]);

  arrowed = await placed();
  await press("Enter");
  check("Enter on the placed diagram still goes onto the first option", await focused(), "blank");
  await press("ArrowRight", "Escape");
  check("Escape closes the bar", await barShown(arrowed.id), false);
  check("back onto the diagram's plate", [await at("blockSelection"), await at("shapes", arrowed.id)], [[arrowed.id], []]);
  await press("ArrowRight");
  check("where → with no offer steps into the text, as before", await at("caret"), { block: arrowed.after, offset: 0 });

  // ---- A chosen preset arrives -------------------------------------------
  /** What of this diagram is mid-entrance: the band opening, shapes and connectors arriving. */
  const arriving = (id) =>
    page.evaluate((id) => {
      const band = document.querySelector(`[data-id="${id}"] .nt-canvas`);
      return {
        opening: band?.hasAttribute("data-opening") ?? false,
        shapes: band?.querySelectorAll(".nt-canvas-scene > [data-arriving]").length ?? 0,
        edges: band?.querySelectorAll(".nt-edge[data-arriving]").length ?? 0,
      };
    }, id);
  arrowed = await placed();
  await bar(arrowed.id).locator('[data-preset="flowchart"]').click();
  await frame();
  const landing = await arriving(arrowed.id);
  check("a chosen preset lands whole at once", (await at("shapes", arrowed.id)).length, 4);
  check("and plays its entrance: the band opening, every shape and connector arriving", landing, {
    opening: true,
    shapes: 4,
    edges: await at("edgeCount", arrowed.id),
  });
  check(
    "staggered in order",
    await page.evaluate(
      (id) =>
        [...document.querySelectorAll(`[data-id="${id}"] .nt-canvas-scene > [data-arriving]`)].map((el) =>
          el.style.getPropertyValue("--nt-arrive-delay"),
        ),
      arrowed.id,
    ),
    ["0ms", "30ms", "60ms", "90ms"],
  );
  await page.evaluate(() =>
    document.getAnimations().forEach((animation) => {
      animation.pause();
      animation.currentTime = 110;
    }),
  );
  await page.mouse.move(0, 0);
  await page.locator(`[data-id="${arrowed.id}"] .nt-canvas`).first().screenshot({ path: path.join(shots, "insert-1.png") });
  await page.evaluate(() => document.getAnimations().forEach((animation) => animation.play()));
  await page.waitForTimeout(700);
  check("and lets go of it once played", await arriving(arrowed.id), { opening: false, shapes: 0, edges: 0 });
  await page.locator(`[data-id="${arrowed.id}"] .nt-canvas`).first().screenshot({ path: path.join(shots, "insert-2.png") });
  await at("undo");
  await frame();
  await at("redo");
  await frame();
  check("a redo of it arrives as any redo does", await arriving(arrowed.id), { opening: false, shapes: 0, edges: 0 });

  await page.emulateMedia({ reducedMotion: "reduce" });
  arrowed = await placed();
  await bar(arrowed.id).locator('[data-preset="flowchart"]').click();
  await frame();
  check("under reduced motion it simply lands", await arriving(arrowed.id), { opening: false, shapes: 0, edges: 0 });
  await page.emulateMedia({ reducedMotion: "no-preference" });

  [intro, line] = await at("seed");
  await frame();
  const removed = await at("slash", "diagram", line);
  await mounted(removed);
  await frame();
  await at("remove", removed);
  await page.waitForTimeout(20);
  check("a diagram taken away takes its offer", await at("offered", removed), false);

  check("no page errors", guards.errors(), []);
  check("no requests off the fixture", guards.requests(), []);
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.log(`  FAIL ${error?.message ?? error}`);
  for (const line of guards?.errors() ?? []) console.log(`    ${line}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const { failed } = summary();
if (failed || failures.length) {
  console.log(`\n${Math.max(failed, failures.length)} canvas rebirth check(s) failed.`);
  process.exit(1);
}
console.log("\nAll canvas rebirth checks passed.");
