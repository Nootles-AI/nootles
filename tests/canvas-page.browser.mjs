/**
 * Two diagrams on one page (`canvas-page.browser.tsx`), driven with a real
 * pointer: a Shift-click selects across them, one drag moves both, the band
 * grows under it and the top holds it, one undo takes the whole move back,
 * and a marquee from one band reaches into the next. At 150% document zoom
 * a click and a drag still land in the diagram's own px. The page's keys:
 * ⌥⇧ picks a tool from the text, Escape abandons a draw and a marquee and
 * climbs out of a diagram onto the page, ⌘A climbs from shapes to blocks, and
 * shapes pasted into the text make a diagram. Drawing on the page: a draw just
 * below a band goes into it, one on an empty line makes a diagram, the pen's
 * first point makes one for it; ⌫ on a last shape takes the diagram, Merge
 * joins two that touch, each one undo step.
 *
 *   node tests/canvas-page.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checker, launch, openPage, repo, writeAppStylesheet } from "./canvas-harness.mjs";

const output = await mkdtemp(path.join(tmpdir(), "canvas-page-"));

await build({
  absWorkingDir: repo,
  entryPoints: ["tests/canvas-page.browser.tsx"],
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
  '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/canvas-page.browser.css"><style>html,body{height:100%;margin:0}</style></head><body><div id="app"></div><script type="module" src="/canvas-page.browser.js"></script></body></html>',
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

const centre = (box) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });

let guards = null;
let page = null;
try {
  ({ page, guards } = await openPage(browser, origin, { viewport: { width: 1100, height: 900 } }));
  // Convex's client opens its socket on the first subscription; here it is
  // a socket that never connects, as in the block-drag harness, rather than
  // the guard's throwing one.
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
  await page.waitForFunction(() => window.canvasPage?.ready());
  const at = (fn, ...args) => page.evaluate(({ fn, args }) => window.canvasPage[fn](...args), { fn, args });
  const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  const drag = async (from, dx, dy, { hold } = {}) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
    await frame();
    const during = hold ? await hold() : null;
    await page.mouse.up();
    await frame();
    return during;
  };

  // A press on a band's empty canvas chooses the diagram itself — what the
  // panels then speak for — with nothing selected, and shows its edge.
  const emptyOf = (band) => [band.left + band.width - 40, band.top + band.height - 20];
  await page.mouse.click(...emptyOf(await at("band", "top")));
  await frame();
  check("a press on empty canvas makes its diagram active", [await at("active"), await at("selection")], ["top", {}]);
  check("the active band shows its edge", [await at("holding", "top"), await at("holding", "bottom")], [true, false]);
  await page.mouse.click(...emptyOf(await at("band", "bottom")));
  await frame();
  check("a press on another diagram's empty canvas moves it", await at("active"), "bottom");
  check("and its edge with it", [await at("holding", "top"), await at("holding", "bottom")], [false, true]);
  await page.mouse.click(...Object.values(centre(await at("shape", "top", "a1"))));
  await frame();
  check("a shape selected makes its diagram active", [await at("active"), await at("focused")], ["top", "top"]);
  await page.keyboard.press("Escape");
  await frame();
  check("Escape lets the shape go and keeps the diagram", [await at("active"), await at("selection")], ["top", {}]);
  await page.mouse.click(...Object.values(centre(await at("block", "between"))));
  await frame();
  check("a press on the page's text lets the diagram go", [await at("active"), await at("holding", "top")], [null, false]);

  // A Shift-click selects across diagrams; the frame is drawn once, in the
  // diagram last pressed, and each diagram outlines its own members.
  await page.mouse.click(...Object.values(centre(await at("shape", "top", "a1"))));
  check("a click selects in its diagram", await at("selection"), { top: ["a1"] });
  await page.keyboard.down("Shift");
  await page.mouse.click(...Object.values(centre(await at("shape", "bottom", "b1"))));
  await page.keyboard.up("Shift");
  await frame();
  check("a Shift-click in the next diagram keeps the first", await at("selection"), {
    bottom: ["b1"],
    top: ["a1"],
  });
  check("focus follows the Shift-click", await at("focused"), "bottom");
  check("one frame, in the focused band", [await at("framed", "top"), await at("framed", "bottom")], [false, true]);
  check("every band outlines its own", [await at("members", "top"), await at("members", "bottom")], [1, 1]);

  // One drag moves both, by the same amount on screen.
  await drag(centre(await at("shape", "bottom", "b1")), 60, 20);
  check("the drag moved both diagrams' shapes", [await at("model", "top", "a1"), await at("model", "bottom", "b1")], [
    { x: 140, y: 60 },
    { x: 360, y: 60 },
  ]);
  check("the selection is still both", await at("selection"), { bottom: ["b1"], top: ["a1"] });

  await at("undo");
  await frame();
  check("one undo takes the whole move back", [await at("model", "top", "a1"), await at("model", "bottom", "b1")], [
    { x: 80, y: 40 },
    { x: 300, y: 40 },
  ]);

  // The top of every band holds the gesture together.
  await drag(centre(await at("shape", "bottom", "b1")), 0, -200);
  check("the top holds both", [(await at("model", "top", "a1")).y, (await at("model", "bottom", "b1")).y], [0, 0]);
  await at("undo");
  await frame();

  // Down past the bottom: each band grows under the drag, and keeps it.
  const heights = await drag(centre(await at("shape", "bottom", "b1")), 0, 150, {
    hold: async () => [(await at("band", "top")).height, (await at("band", "bottom")).height],
  });
  check("both bands grow during the drag", heights.map((h) => h > 180), [true, true]);
  check("and keep the height it reached", [(await at("height", "top")) > 180, (await at("height", "bottom")) > 180], [
    true,
    true,
  ]);
  await at("undo");
  await frame();
  check("one undo puts both heights back", [await at("height", "top"), await at("height", "bottom")], [180, 180]);

  {
    // ---- A band's height, pinned and not --------------------------------------
    // Scrolled so a band sits mid-screen: whatever changes its height moves only
    // what is below it — its top and its shapes stay put on screen.
    await at("clear");
    await at("padPage", 1200);
    await at("centreBand", "bottom");
    await frame();
    const still = async () => ({ band: (await at("band", "bottom")).top, shape: (await at("shape", "bottom", "b1")).top });
    const near = (a, b) => Math.abs(a - b) <= 1;
    const rest = await still();
    await drag(centre(await at("heightGrip", "bottom")), 0, 100);
    let now = await still();
    check("a grip dragged down leaves the band's top and shapes where they were", [near(now.band, rest.band), near(now.shape, rest.shape)], [true, true]);
    check("and sets the height it was dragged to", await at("height", "bottom"), 280);

    // With room to spare below the drawing, the band offers to fit its content.
    const offer = await at("autoOffer", "bottom");
    check("room below the drawing offers auto height", !!offer, true);
    await page.mouse.click(...Object.values(centre(offer.go)));
    await frame();
    now = await still();
    check("auto height sets the height the content needs", await at("height", "bottom"), 40 + 70 + 24);
    check("and the band draws at it", (await at("band", "bottom")).height, 40 + 70 + 24);
    check("its top and shapes still where they were", [near(now.band, rest.band), near(now.shape, rest.shape)], [true, true]);
    check("and the offer goes with the room", await at("autoOffer", "bottom"), null);
    await at("undo");
    await frame();
    check("one undo gives the room back", await at("height", "bottom"), 280);
    await at("redo");
    await frame();
    await drag(centre(await at("heightGrip", "bottom")), 0, 60);
    const again = await at("autoOffer", "bottom");
    check("a new height with room offers it again", !!again, true);
    await page.mouse.click(...Object.values(centre(again.dismiss)));
    await frame();
    check("× puts the offer away and keeps the height", [await at("autoOffer", "bottom"), (await at("height", "bottom")) > 134], [null, true]);
    await drag(centre(await at("heightGrip", "bottom")), 0, 20);
    check("the next resize brings it back", !!(await at("autoOffer", "bottom")), true);

    // The offer is just its words and its ×, and rides the grip: centred on
    // it, above it with the next block close under the band, below it given
    // room — following it live through a drag.
    const rides = async () => {
      const o = await at("autoOffer", "bottom");
      const g = await at("heightGrip", "bottom");
      const b = await at("band", "bottom");
      const onGrip = Math.abs(o.whole.left + o.whole.width / 2 - (g.left + g.width / 2)) <= 1;
      const side = o.at === "below" ? o.whole.top >= b.top + b.height - 0.5 : o.whole.top + o.whole.height <= g.top + 0.5;
      return { at: o.at, onGrip, side, near: o.at === "below" ? o.whole.top - (b.top + b.height) < 6 : g.top - (o.whole.top + o.whole.height) < 6 };
    };
    const words = await at("autoOffer", "bottom");
    check("the offer is its words alone, no glyph", [words.text, words.glyphs], ["Auto height", 0]);
    check("with the next block close under the band, it sits just above the grip", await rides(), { at: "above", onGrip: true, side: true, near: true });
    await at("roomUnder", "bottom", 60);
    await drag(centre(await at("heightGrip", "bottom")), 0, 10);
    check("given room under the band, just below it", await rides(), { at: "below", onGrip: true, side: true, near: true });
    const live = await drag(centre(await at("heightGrip", "bottom")), 0, 40, { hold: rides });
    check("and it follows the grip through the drag", live, { at: "below", onGrip: true, side: true, near: true });
    await at("roomUnder", "bottom", null);

    // Dragged up, the grip goes right to the shapes, past the room Auto height
    // leaves under them — and Auto height gives that room back.
    await drag(centre(await at("heightGrip", "bottom")), 0, -400);
    check("the grip pulls the band up to where its shapes end, no further", [await at("height", "bottom"), (await at("band", "bottom")).height], [40 + 70, 40 + 70]);
    const tight = await at("autoOffer", "bottom");
    check("tighter than the room under the shapes, the band offers auto height", !!tight, true);
    await page.mouse.click(...Object.values(centre(tight.go)));
    await frame();
    check("which puts the room back", [await at("height", "bottom"), await at("autoOffer", "bottom")], [40 + 70 + 24, null]);
    await at("undo");
    await frame();
    check("one undo pulls it tight again", await at("height", "bottom"), 40 + 70);
    await at("redo");
    await frame();

    // A shape dragged down grows the band under it, and the page does not move.
    const grab = await at("shape", "bottom", "b1");
    await drag(centre(grab), 0, 150);
    now = await still();
    check("a band grown by a drag keeps its top where it was", near(now.band, rest.band), true);
    check("and the shape landed where the pointer let it go", near(now.shape - grab.top, 150), true);
    const grownTo = await at("height", "bottom");
    await drag(centre(await at("shape", "bottom", "b1")), 0, -150);
    check("dragged back up, the band keeps the height it grew to — it never shrinks on its own", await at("height", "bottom"), grownTo);
    // And with the band's top cut off by the pane's: the band holds its place
    // rather than whatever of the page happens to sit below it.
    await at("bandTopAt", "bottom", -60);
    await frame();
    const cut = await still();
    const held = await at("shape", "bottom", "b1");
    await drag(centre(held), 0, 150);
    now = await still();
    check("cut off at the top, a band grown by a drag keeps its place", near(now.band, cut.band), true);
    check("and the shape lands under the pointer", near(now.shape - held.top, 150), true);
    await drag(centre(await at("heightGrip", "bottom")), 0, 80);
    check("and a grip dragged down keeps it too", near((await still()).band, cut.band), true);
    await at("dispatch", "bottom", [
      { type: "resize", frames: [{ id: "b1", x: 300, y: 40, w: 120, h: 70 }] },
      { type: "setDiagram", h: 180 },
    ]);
    await at("padPage", null);
    await at("clear");
    await frame();

    // ---- Past the column's side ----------------------------------------------
    // A shape held at the side washes both margins in, faintly; pushed on — well
    // past, and still outward — the drag goes on into the margin, over the
    // page, and that side's wash deepens. The band never changes under the
    // hand: it turns wide on the drop, and only if the drop is past the column.
    const pushTo = async (dxs, { escape = false } = {}) => {
      const from = centre(await at("shape", "top", "a2"));
      const seen = [];
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (const dx of dxs) {
        await page.mouse.move(from.x + dx, from.y, { steps: 6 });
        await frame();
        // A spring out past the side plays out before the shape is measured.
        await page.waitForFunction(() => document.getAnimations().every((a) => a.id !== "nt-snap"));
        const shape = await at("shape", "top", "a2");
        // So does the deep wash's wipe, before its layers are read.
        await page.waitForFunction(() => document.getAnimations().every((a) => !a.effect?.target?.closest?.(".nt-canvas-margins")));
        seen.push({ wash: await at("wash", "top"), wide: await at("wide", "top"), deep: await at("deep", "top"), left: shape.left, right: shape.left + shape.width });
      }
      if (escape) await page.keyboard.press("Escape");
      await page.mouse.up();
      await frame();
      return seen;
    };
    const within = (a, b, tol = 0.5) => Math.abs(a - b) <= tol;
    const sameRects = (a, b) =>
      Object.keys(a).length === Object.keys(b).length &&
      Object.entries(a).every(([id, r]) => b[id] && ["left", "top", "width", "height"].every((k) => within(r[k], b[id][k])));
    // a2 is 420…540 across: 180px of room to the column's side, at 100%.
    const a2 = await at("shape", "top", "a2");
    let seen = await pushTo([200]);
    check("held at the column's side, the margins wash in faintly", [seen[0].wash, seen[0].wide], ["held", false]);
    check("and let go inside the column, it moves no further than the side", [await at("wide", "top"), (await at("model", "top", "a2")).x], [false, 600]);
    check("and the wash goes", await at("wash", "top"), null);
    // Deepening, a darker layer wipes out from the column's edge; easing out,
    // it is past halfway at half time. Back, it wipes home a touch quicker.
    const wiped = async (side, way) => {
      const w = await at("wipe", "top", side, way);
      return w && { ms: w.ms, ends: [w.covered[0], w.covered[2]], early: way === "in" ? w.covered[1] > 0.5 && w.covered[1] < 1 : w.covered[1] > 0 && w.covered[1] < 0.5 };
    };
    check(
      "a side deepening wipes out from the column's edge, and back to it leaving — either side",
      [await wiped("right", "in"), await wiped("right", "out"), await wiped("left", "in"), await wiped("left", "out")],
      [
        { ms: 220, ends: [0, 1], early: true },
        { ms: 160, ends: [1, 0], early: true },
        { ms: 220, ends: [0, 1], early: true },
        { ms: 160, ends: [1, 0], early: true },
      ],
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    check("with reduced motion it swaps, no wipe", [await at("wipe", "top", "right", "in"), await at("wipe", "top", "left", "out")], [null, null]);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await at("undo");
    await frame();

    seen = await pushTo([200, 260]);
    check("pushed on, but short of the threshold, the side still holds it", [seen.map((s) => s.wash), (await at("model", "top", "a2")).x, await at("wide", "top")], [["held", "held"], 600, false]);
    // A hard stop at the side first; then it gives a little toward the pull —
    // less the further it goes — and stretches a touch.
    await at("undo");
    await frame();
    const side = a2.left + 180;
    seen = await pushTo([200, 240, 270]);
    const gave = seen.map((s) => s.left - side);
    check("just past the side, a hard stop: the shape does not move", [Math.abs(gave[0]) <= 0.5, Math.abs(seen[0].right - seen[0].left - a2.width) <= 0.5], [true, true]);
    check("pushed on, it gives a little, never the rubber band's reach", gave.slice(1).map((g) => g > 0.5 && g < 14), [true, true]);
    check("and gives less for each px further", gave[2] - gave[1] < gave[1], true);
    check("stretching a touch, never out into the margin", seen.slice(1).map((s) => s.right - (side + a2.width) < 14 + 0.04 * a2.width + 0.5 && s.right - s.left > a2.width), [true, true]);
    await at("undo");
    await frame();

    const columnRects = await at("rects", "top");
    seen = await pushTo([200, 300, 330]);
    check("pushed well past, the side it goes into deepens — and the band stays in the column", seen.map((s) => [s.wash, s.wide]), [["held", false], ["right", false], ["right", false]]);
    check("and the shape follows the pointer into the margin", within(seen[2].left, a2.left + 330, 1), true);
    check("the side turning deep is covered by its dark layer; the faint one is not", [seen[0].deep, seen[2].deep], [[0, 0], [0, 1]]);
    const landed = await at("frameOf", "top", "a2");
    check("let go in the margin, the band turns wide", [await at("wideKind", "top"), landed.x + landed.w > 720], [true, true]);
    const framesShape = async () => {
      const f = await at("frameRect", "top");
      const r = await at("shape", "top", "a2");
      return !!f && ["left", "top", "width", "height"].every((k) => within(f[k], r[k], 1));
    };
    check("and the selection frame is on the shape at once, the pointer still", await framesShape(), true);
    check("and nothing that stayed put moved a pixel", sameRects({ a1: columnRects.a1 }, { a1: (await at("rects", "top")).a1 }), true);
    await at("undo");
    await frame();
    check("one undo takes the move and the widening back", [await at("wide", "top"), (await at("model", "top", "a2")).x], [false, 420]);
    check("and every shape is where it was on screen", sameRects(columnRects, await at("rects", "top")), true);

    seen = await pushTo([200, 300, 100]);
    check("pushed past and brought back inside, the side holds it again", seen.map((s) => s.wash), ["held", "right", null]);
    check("the drop inside the column leaves the band in the column", await at("wide", "top"), false);
    const inside = await at("frameOf", "top", "a2");
    check("with the shape where it was dropped", [inside.x > 420, inside.x + inside.w <= 720], [true, true]);
    await at("undo");
    await frame();

    seen = await pushTo([200, 300, 215]);
    const straddling = await at("frameOf", "top", "a2");
    check("dropped across the column's side, the band turns wide", [await at("wide", "top"), straddling.x < 720 && straddling.x + straddling.w > 720], [true, true]);
    await at("undo");
    await frame();

    seen = await pushTo([200, 300], { escape: true });
    check("Escape after the push leaves the band in the column", [await at("wide", "top"), (await at("model", "top", "a2")).x, await at("wash", "top")], [false, 420, null]);
    await at("clear");

    // ---- One scale, wide or not -----------------------------------------------
    // A wide band is drawn at the text's scale, as a column one is, and shows as
    // much of its margins as the pane has room for: turning it wide or back —
    // from the panel, by a drop in a margin, or with the pen below — moves
    // nothing already drawn, at a pane too narrow for the whole wide band and
    // at one wide enough.
    const paneContent = () =>
      page.evaluate(() => {
        const pane = document.querySelector(".nt-pane");
        const style = getComputedStyle(pane);
        return pane.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      });
    const toggles = async (label) => {
      const before = await at("rects", "top");
      const origin = await at("origin", "top");
      await at("setDiagram", "top", { wide: true });
      await frame();
      check(`${label}: Wide from the panel pins the band`, await at("wideKind", "top"), "pinned");
      check(`${label}: and moves no shape`, sameRects(before, await at("rects", "top")), true);
      const wideOrigin = await at("origin", "top");
      check(`${label}: nor the text's edge, nor the scale`, [within(wideOrigin.x, origin.x), within(wideOrigin.y, origin.y), wideOrigin.scale], [true, true, origin.scale]);
      const pane = await paneContent();
      const shown = Math.min(1200, Math.max(720, (pane - 48) / origin.scale));
      check(`${label}: the wide band shows what the pane has room for`, within(await at("bandWidth", "top"), shown, 1), true);
      await at("setDiagram", "top", { wide: false });
      await frame();
      check(`${label}: and back to the column moves nothing either`, [await at("wide", "top"), sameRects(before, await at("rects", "top"))], [false, true]);
      return shown;
    };
    const narrowShown = await toggles("a pane narrower than the wide band");
    check("which is narrower than the whole wide band here", narrowShown < 1200, true);

    // Margin shapes: shown where the pane has room, clipped where it has none.
    await at("setDiagram", "top", { wide: true });
    await at("put", "top", "mNear", 730, 120, 40);
    await at("put", "top", "mFar", 1200 - 240 - 50, 120, 40);
    await frame();
    const margin = (narrowShown - 720) / 2;
    check("a shape in the shown margin is drawn", await at("visibleAt", "top", "mNear"), true);
    check("one past what the pane shows is clipped", [margin < 190, await at("visibleAt", "top", "mFar")], [true, false]);
    await page.setViewportSize({ width: 1500, height: 900 });
    await frame();
    await frame();
    check("with room for the whole wide band, it is drawn too", await at("visibleAt", "top", "mFar"), true);
    await at("dispatch", "top", [{ type: "remove", ids: ["mNear", "mFar"] }]);
    await at("setDiagram", "top", { wide: false });
    await frame();
    check("the whole wide band where the pane has room", await toggles("a pane with room"), 1200);
    await page.setViewportSize({ width: 1100, height: 900 });
    await frame();
    await frame();

    // ---- Wide pinned, and wide for what it holds ------------------------------
    await at("setDiagram", "top", { wide: true });
    await at("dispatch", "top", [{ type: "move", ids: ["a1"], dx: 4, dy: 0 }]);
    check("a band pinned wide stays wide with nothing in its margins", await at("wideKind", "top"), "pinned");
    await drag(centre(await at("shape", "top", "a2")), -500, 0);
    check("a drag into a pinned band's margin keeps the pin", [await at("wideKind", "top"), (await at("frameOf", "top", "a2")).x < 0], ["pinned", true]);
    check("the selection frame is on it", await framesShape(), true);
    // A fold into the column, or out, plays out on the scene layer; then the frame sits on the shape.
    const played = async () => {
      // A frame first: the panel's write renders, and its animation starts, after the call returns.
      await frame();
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".nt-canvas-scene")].every((el) => el.getAnimations().length === 0),
      );
    };
    await at("setDiagram", "top", { wide: false });
    check("the column clears the pin", await at("wideKind", "top"), null);
    await played();
    check("folded into the column from the panel, the selection frame follows the shape", await framesShape(), true);
    await at("setDiagram", "top", { wide: true });
    await played();
    check("and out again", [await at("wideKind", "top"), await framesShape()], ["pinned", true]);
    await at("setDiagram", "top", { wide: false });
    await played();
    await at("dispatch", "top", [
      { type: "resize", frames: [{ id: "a1", x: 80, y: 40, w: 120, h: 70 }, { id: "a2", x: 420, y: 40, w: 120, h: 70 }] },
      { type: "setDiagram", wide: false, h: 180 },
    ]);
    await at("clear");
    await frame();

    // ---- A connector across a change of width ---------------------------------
    // A shape joined to one in the column, dragged in out of the margin: the
    // band folds back to the column on the drop, and the connector is drawn
    // from the committed scene — both ends on their shapes — then and a frame
    // later. Dragged back out, the band turns wide and the same holds.
    await at("dispatch", "top", [
      { type: "setDiagram", wide: true },
      { type: "insert", nodes: [{ id: "m1", kind: "rect", x: -200, y: 200, w: 100, h: 60, rot: 0, style: { background: "#d8e8c8" }, label: "", locked: false, hidden: false, attrs: {} }] },
    ]);
    await at("connect", "top", "e1", "a1", "m1");
    await frame();
    check("the connector starts drawn as routed", (await at("connector", "top", "e1"))?.asRouted, true);
    await drag(centre(await at("shape", "top", "m1")), 400, 0);
    check("dragged into the column, the band folds back", [await at("wide", "top"), (await at("frameOf", "top", "m1")).x], [false, 200]);
    check("and the connector is the committed scene's route, end to end", await at("connector", "top", "e1"), { asRouted: true, from: 0, to: 0 });
    await frame();
    check("still, a frame later", await at("connector", "top", "e1"), { asRouted: true, from: 0, to: 0 });
    {
      const from = centre(await at("shape", "top", "m1"));
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      for (const dx of [-150, -320, -350]) {
        await page.mouse.move(from.x + dx, from.y, { steps: 6 });
        await frame();
      }
      await page.mouse.up();
      await frame();
    }
    check("dragged back out past the side, the band turns wide", [await at("wideKind", "top"), (await at("frameOf", "top", "m1")).x], [true, -150]);
    check("and the connector follows it, end to end", await at("connector", "top", "e1"), { asRouted: true, from: 0, to: 0 });
    await frame();
    check("still, a frame later ", await at("connector", "top", "e1"), { asRouted: true, from: 0, to: 0 });
    await at("dispatch", "top", [
      { type: "removeEdge", ids: ["e1"] },
      { type: "remove", ids: ["m1"] },
      { type: "resize", frames: [{ id: "a1", x: 80, y: 40, w: 120, h: 70 }, { id: "a2", x: 420, y: 40, w: 120, h: 70 }] },
      { type: "setDiagram", wide: false, h: 180 },
    ]);
    await at("clear");
    await frame();

    // ---- Folded into the column, and out again ------------------------------
    await at("setDiagram", "top", { wide: true });
    await at("put", "top", "m1", 900, 40, 60);
    await frame();
    await at("setDiagram", "top", { wide: false });
    await frame();
    const folded = await at("frameOf", "top", "m1");
    check("into the column, a drawing in the margin is scaled to fit", [await at("wide", "top"), folded.x + folded.w <= 720 + 0.01], [false, true]);
    check("and the band is the column's width", await at("bandWidth", "top"), 720);
    await at("setDiagram", "top", { wide: true });
    await frame();
    check("back out before any edit, it is unfolded exactly", await at("frameOf", "top", "m1"), { x: 900, y: 40, w: 60, h: 70 });
    await at("setDiagram", "top", { wide: false });
    await at("dispatch", "top", [{ type: "move", ids: ["a1"], dx: 0, dy: 4 }]);
    await at("setDiagram", "top", { wide: true });
    await frame();
    check("after an edit, back out only widens", (await at("frameOf", "top", "m1")).x < 720, true);
    await at("dispatch", "top", [
      { type: "remove", ids: ["m1"] },
      { type: "resize", frames: [{ id: "a1", x: 80, y: 40, w: 120, h: 70 }, { id: "a2", x: 420, y: 40, w: 120, h: 70 }] },
      { type: "setDiagram", wide: false, h: 180 },
    ]);
    await frame();
  }

  // ---- Snapping to the other diagrams ----------------------------------------
  // A shape dragged in one diagram lines up with the shapes of the others, as
  // one dragged across several does: b1's left edge brought within a few px
  // of a1's, in the diagram above, lands on it — and draws the guide.
  {
    await at("clear");
    // The fold and unfold just above play out first.
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".nt-canvas-scene")].every((el) => el.getAnimations().length === 0),
    );
    const a1 = await at("shape", "top", "a1");
    const b1 = await at("shape", "bottom", "b1");
    const reach = a1.left + 3 - b1.left;
    await page.mouse.click(...Object.values(centre(b1)));
    const guided = await drag(centre(b1), reach, 0, { hold: () => at("guiding", "bottom") });
    const landed = await at("shape", "bottom", "b1");
    check("a shape dragged near another diagram's shape snaps to it", [Math.round(landed.left - a1.left), (await at("model", "bottom", "b1")).x], [0, 80]);
    check("and draws the guide while it is held there", guided, true);
    await at("undo");
    await frame();
    await at("snapTarget", "diagrams", false);
    await drag(centre(await at("shape", "bottom", "b1")), reach, 0);
    check("with Other diagrams off, it goes where the pointer took it", (await at("model", "bottom", "b1")).x, 83);
    await at("undo");
    await at("snapTarget", "diagrams", true);
    await at("clear");
    await frame();
  }

  // A plain click on empty canvas clears the page.
  const top = await at("band", "top");
  await page.mouse.click(top.left + 20, top.top + 150);
  check("a click on empty canvas clears every diagram", await at("selection"), {});

  // A marquee from empty space in one band reaches into the next.
  const a1 = await at("shape", "top", "a1");
  const b1 = await at("shape", "bottom", "b1");
  await page.mouse.move(a1.left - 20, a1.top - 16);
  await page.mouse.down();
  await page.mouse.move(b1.left + 20, b1.top + 20, { steps: 16 });
  await frame();
  await page.mouse.up();
  check("a marquee across two bands selects in both", await at("selection"), { top: ["a1"], bottom: ["b1"] });
  check("focus is where it started", await at("focused"), "top");

  // The document's zoom: ⌘= steps the page, the bar reads it, and a diagram
  // at 150% still takes a click and a drag in its own px.
  await page.mouse.click(...Object.values(centre(await at("shape", "top", "a2"))));
  const grip = await at("grip", "top");
  check("a selected shape shows its grips", grip > 0, true);
  await at("clear");
  const mod = (await at("apple")) ? "Meta" : "Control";
  check("the page opens at 100%", await at("zoomReadout"), "100%");
  check("at 100% the bar has no reset", await at("zoomReset"), null);
  await page.keyboard.press(`${mod}+Equal`);
  await frame();
  check("⌘= zooms the page a step", await at("zoomReadout"), "125%");
  await page.keyboard.press(`${mod}+Equal`);
  await frame();
  check("and another", await at("zoomReadout"), "150%");
  check("the band is drawn at the page's zoom", Math.round((await at("bandScale", "top")) * 100) / 100, 1.5);
  await at("reveal", "top", "a2");
  await frame();
  await page.mouse.click(...Object.values(centre(await at("shape", "top", "a2"))));
  check("at 150%, a click selects the shape under it", await at("selection"), { top: ["a2"] });
  check("its grips keep their size on screen", await at("grip", "top"), grip);
  await drag(centre(await at("shape", "top", "a2")), 90, 30);
  check("a drag moves it by the pointer's distance in the diagram's px", await at("model", "top", "a2"), {
    x: 480,
    y: 60,
  });
  await at("undo");
  await frame();
  await page.keyboard.press(`${mod}+Digit0`);
  await frame();
  check("⌘0 puts the page back at 100%", await at("zoomReadout"), "100%");
  check("and the band at its own size", await at("bandScale", "top"), 1);
  check("and the reset leaves the bar", await at("zoomReset"), null);
  await page.keyboard.press(`${mod}+Equal`);
  await frame();
  const reset = await at("zoomReset");
  check("zoomed in, the bar offers a reset", !!reset, true);
  await page.mouse.click(reset.x, reset.y);
  await frame();
  check("a click on it puts the page back at 100%", await at("zoomReadout"), "100%");
  check("and it goes", await at("zoomReset"), null);

  // A pane narrowed under a held pointer — a rail opening on the selection
  // the press made — leaves the band's scale alone until the pointer lets go.
  const held = centre(await at("shape", "top", "a2"));
  await page.mouse.move(held.x, held.y);
  await page.mouse.down();
  await at("paneWidth", 700);
  await frame();
  await frame();
  check("a band under a held pointer keeps its scale", await at("bandScale", "top"), 1);
  await page.mouse.up();
  await frame();
  await frame();
  check("and takes the narrower pane's once it is let go", (await at("bandScale", "top")) < 1, true);
  check("its selection's grips still keep their size on screen", await at("grip", "top"), grip);
  await at("paneWidth", null);
  await frame();
  await frame();
  check("a pane given its width back gives the band its size", await at("bandScale", "top"), 1);
  await at("clear");

  // The page's keys. With the caret in the text a bare letter is typing; ⌥⇧
  // and the letter picks the tool from there all the same, and Escape puts
  // it down without leaving the text.
  const tool = async () => (await at("tool"))?.tool;
  await at("caretAtEnd", "between");
  await frame();
  check("the caret is in the text", await at("keyboard"), "text");
  await page.keyboard.press("r");
  check("a bare R in the text types", await at("text", "between"), "A paragraph between them.r");
  check("and picks no tool", await tool(), "move");
  await page.keyboard.press("Alt+Shift+KeyR");
  check("⌥⇧R from the text arms the rectangle", await tool(), "rect");
  check("and types nothing", await at("text", "between"), "A paragraph between them.r");
  await page.keyboard.press("Backspace");
  check("the text's own keys are still the text's", await at("text", "between"), "A paragraph between them.");
  await page.keyboard.press("Escape");
  check("Escape from the text puts the tool down", await tool(), "move");
  check("and leaves the caret where it was", await at("keyboard"), "text");

  // Escape abandons a draw: the shape it had put in goes, the release draws
  // nothing, and the tool stays in hand for the next Escape.
  await page.keyboard.press("Alt+Shift+KeyR");
  const topBand = await at("band", "top");
  const shapes = await at("count", "top");
  await page.mouse.move(topBand.left + 250, topBand.top + 100);
  await page.mouse.down();
  await page.mouse.move(topBand.left + 330, topBand.top + 150, { steps: 8 });
  await frame();
  check("a draw under way puts its shape in", await at("count", "top"), shapes + 1);
  await page.keyboard.press("Escape");
  await frame();
  check("Escape mid-draw takes it back out", await at("count", "top"), shapes);
  await page.mouse.move(topBand.left + 360, topBand.top + 160, { steps: 4 });
  await page.mouse.up();
  await frame();
  check("and the release draws nothing", await at("count", "top"), shapes);
  check("the rectangle is still in hand", await tool(), "rect");
  await page.keyboard.press("Escape");
  check("the next Escape puts it down", await tool(), "move");

  // Escape abandons a marquee: what it had taken is let go, and its rubber
  // band comes down.
  const a2 = await at("shape", "top", "a2");
  await page.mouse.move(topBand.left + 300, topBand.top + 10);
  await page.mouse.down();
  await page.mouse.move(a2.left + 20, a2.top + 20, { steps: 10 });
  await frame();
  check("a marquee under way selects what it crosses", await at("selection"), { top: ["a2"] });
  await page.keyboard.press("Escape");
  await frame();
  check("Escape mid-marquee puts the selection back", await at("selection"), {});
  check("and takes the marquee down", await at("marqueeShown"), false);
  await page.mouse.move(a2.left + 40, a2.top + 30, { steps: 4 });
  await page.mouse.up();
  await frame();
  check("and the release selects nothing", await at("selection"), {});

  // ⌘A climbs: the diagram's shapes, then the page as blocks.
  await page.mouse.click(...Object.values(centre(await at("shape", "top", "a1"))));
  check("a click selects a shape", await at("selection"), { top: ["a1"] });
  await page.keyboard.press(`${mod}+KeyA`);
  check("⌘A takes the whole diagram", await at("selection"), { top: ["a1", "a2"] });
  await page.keyboard.press(`${mod}+KeyA`);
  check("the next ⌘A lets the shapes go", await at("selection"), {});
  check("and takes the page as blocks", (await at("blockSelection")).length, (await at("blocks")).length);
  check("with the keyboard on the page", await at("keyboard"), "text");
  await page.keyboard.press("Escape");
  check("Escape lets the blocks go", await at("blockSelection"), []);

  // Shapes pasted into the text make a diagram of them, after the paragraph,
  // their shapes selected and the keyboard on its band.
  await at("caretAtEnd", "between");
  const before = await at("diagrams");
  await at(
    "paste",
    '<nt-diagram h="120"><nt-rect id="n1" x="40" y="200" w="120" h="60"></nt-rect>' +
      '<nt-rect id="n2" x="220" y="210" w="80" h="80"></nt-rect></nt-diagram>',
  );
  await page.waitForFunction((n) => window.canvasPage.diagrams().length === n, before.length + 1);
  const made = (await at("diagrams")).find((id) => !before.includes(id));
  check("pasting shapes into the text makes a diagram of them", await at("count", made), 2);
  const order = (await at("blocks")).map((block) => block.split(":")[0]);
  check("right after the paragraph", order.indexOf(made), order.indexOf("between") + 1);
  check("the paragraph is untouched", await at("text", "between"), "A paragraph between them.");
  await page.waitForFunction((id) => (window.canvasPage.selection()[id] ?? []).length === 2, made);
  check("its shapes are selected", (await at("selection"))[made]?.length, 2);
  check("with the keyboard on its band", await at("keyboard"), `band:${made}`);
  check("its shapes start at the band's margin", await at("model", made, (await at("selection"))[made][0]), {
    x: 40,
    y: 24,
  });

  // Escape climbs out of a diagram and onto the page: the shapes let go, then
  // the diagram selected as a block, where Enter goes back in and ⌫ takes it.
  await page.mouse.click(...Object.values(centre(await at("shape", "bottom", "b1"))));
  check("a click selects in the diagram below", await at("selection"), { bottom: ["b1"] });
  await page.keyboard.press("Escape");
  check("the first Escape lets the shape go", await at("selection"), {});
  check("the band keeps the keyboard", await at("keyboard"), "band:bottom");
  await page.keyboard.press("Escape");
  check("the next selects the diagram as a block", await at("blockSelection"), ["bottom"]);
  check("and hands the keyboard to the page", await at("keyboard"), "text");
  await page.keyboard.press("Enter");
  check("Enter goes back in, onto its frontmost shape", await at("selection"), { bottom: ["b1"] });
  check("with the keyboard on its band", await at("keyboard"), "band:bottom");
  check("and the block let go", await at("blockSelection"), []);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  check("two Escapes select the block again", await at("blockSelection"), ["bottom"]);
  await page.keyboard.press("Backspace");
  check(
    "⌫ takes the diagram out of the page",
    (await at("blocks")).some((block) => block.startsWith("bottom:")),
    false,
  );

  // Drawing on the page. A draw begun in the room just below a diagram goes
  // into it, and the band grows to hold it.
  await at("clear");
  await at("pick", "rect");
  const topNow = await at("band", "top");
  const topShapes = await at("count", "top");
  const topHeight = await at("height", "top");
  const blockCount = (await at("blocks")).length;
  const gapAt = { x: topNow.left + 200, y: topNow.top + topNow.height + 10 };
  await page.mouse.move(gapAt.x, gapAt.y);
  await frame();
  check("armed, the band a draw below it would go into is outlined", await at("target"), "top");
  await drag(gapAt, 120, 60);
  await page.waitForFunction((n) => window.canvasPage.count("top") === n, topShapes + 1);
  check("a draw in the room below a diagram goes into it", await at("count", "top"), topShapes + 1);
  check("no diagram is made for it", (await at("blocks")).length, blockCount);
  check("the band grows to hold it", (await at("height", "top")) > topHeight, true);
  check("and the tool is put down", await tool(), "move");
  check("the outline goes with it", await at("target"), null);
  await page.waitForFunction(() => (window.canvasPage.selection().top ?? []).length === 1);

  // Pasted back over its originals, again and again, each copy lands a step
  // further out than the one before.
  const drawnId = (await at("selection")).top[0];
  const original = await at("model", "top", drawnId);
  const copied = await at("copy");
  await at("paste", copied);
  const once = await at("model", "top", (await at("selection")).top[0]);
  await at("paste", copied);
  const twice = await at("model", "top", (await at("selection")).top[0]);
  check("a paste over its originals lands beside them", once, { x: original.x + 10, y: original.y + 10 });
  check("and the next a step further out", twice, { x: original.x + 20, y: original.y + 20 });
  await at("undo");
  await at("undo");
  await frame();

  // On an empty line, the line becomes a diagram holding what was drawn —
  // one clear of the room under the diagram above it.
  await at("clear");
  const emptyLine = await at("addLine", "outro");
  await frame();
  await at("pick", "rect");
  const line = await at("block", emptyLine);
  const lineAt = { x: line.left + 80, y: line.top + line.height / 2 };
  await page.mouse.move(lineAt.x, lineAt.y);
  await frame();
  check("over an empty line, a line shows where the diagram would go", (await at("insertLine")) !== null, true);
  await drag(lineAt, 140, 70);
  await page.waitForFunction((id) => !window.canvasPage.blocks().some((b) => b.startsWith(`${id}:`)), emptyLine);
  const drawnOn = (await at("diagrams")).find((id) => !before.includes(id) && id !== made);
  const order2 = (await at("blocks")).map((block) => block.split(":")[0]);
  check("a draw on an empty line makes a diagram in the line's place", order2.indexOf(drawnOn), order2.indexOf("outro") + 1);
  await page.waitForFunction((id) => window.canvasPage.count(id) === 1, drawnOn);
  check("its shape a band below the diagram's top", (await at("nodes", drawnOn))[0]?.y, 24);
  check("the insertion line comes down", await at("insertLine"), null);
  await page.waitForFunction((id) => (window.canvasPage.selection()[id] ?? []).length === 1, drawnOn);
  check("selected, with the keyboard on its band", await at("keyboard"), `band:${drawnOn}`);

  // ⌫ on a diagram's last shape takes the diagram with it, and one undo
  // brings back both. Undo is the text's, so the page stops being served
  // from NML here (see `unserve`). The shape is moved first, as a person
  // would: the selection its going lets go of is then a stop of its own in
  // the diagram's history, which must not be the step's to take first — the
  // diagram is not there to take it until the text brings its block back.
  await at("unserve");
  const lastShape = (await at("nodes", drawnOn))[0];
  await drag(centre(await at("shape", drawnOn, lastShape.id)), 30, 20);
  await page.keyboard.press("Backspace");
  await page.waitForFunction((id) => !window.canvasPage.blocks().includes(`${id}:canvas`), drawnOn);
  check("⌫ on a diagram's last shape takes its block out", (await at("blocks")).includes(`${drawnOn}:canvas`), false);
  check("with the caret in the text beside it", await at("keyboard"), "text");
  // Promptly, as a keypress sees it — not awaiting the step: a press waiting
  // on a diagram that is not coming back swallows every press after it.
  const press = (step) => page.evaluate((step) => void window.canvasPage[step](), step);
  await press("undo");
  await page.waitForFunction((id) => window.canvasPage.count(id) === 1, drawnOn, { timeout: 2000 });
  check("one undo brings back the diagram and its shape", (await at("blocks")).includes(`${drawnOn}:canvas`), true);
  await press("redo");
  await page.waitForFunction((id) => !window.canvasPage.blocks().includes(`${id}:canvas`), drawnOn, { timeout: 2000 });
  check("redo takes it out again", (await at("blocks")).includes(`${drawnOn}:canvas`), false);
  await press("undo");
  await page.waitForFunction((id) => window.canvasPage.count(id) === 1, drawnOn, { timeout: 2000 });
  check("and undo brings it back again", (await at("blocks")).includes(`${drawnOn}:canvas`), true);

  // ⌫ straight after a nudge: the nudge is a step of its own, under the
  // step the block went in — undo brings the diagram back as it was when it
  // went, and the next undo, from the diagram it brought back, the nudge.
  await page.mouse.click(...Object.values(centre(await at("shape", drawnOn, lastShape.id))));
  const unnudged = await at("model", drawnOn, lastShape.id);
  await page.keyboard.press("ArrowRight");
  const nudged = await at("model", drawnOn, lastShape.id);
  await page.keyboard.press("Backspace");
  await page.waitForFunction((id) => !window.canvasPage.blocks().includes(`${id}:canvas`), drawnOn);
  await press("undo");
  await page.waitForFunction((id) => window.canvasPage.count(id) === 1, drawnOn, { timeout: 2000 });
  check("after a nudge, undo brings the diagram back as it went", await at("model", drawnOn, lastShape.id), nudged);
  await at("undo");
  check("and the next undo takes the nudge back", await at("model", drawnOn, lastShape.id), unnudged);

  // Two diagrams that touch can be one: Merge at their seam, one undo to take
  // it back, and × to keep them apart.
  await at("clear");
  check("no Merge with a paragraph between two diagrams", await at("seam", "top"), null);
  await at("removeBlock", "between");
  await frame();
  const seam = await at("seam", "top");
  check("once they touch, Merge is offered at their seam", seam !== null, true);
  const upperCount = await at("count", "top");
  const lowerCount = await at("count", made);
  const upperHeight = await at("height", "top");
  const upperIds = (await at("nodes", "top")).map((node) => node.id);
  await page.mouse.click(...Object.values(centre(seam.merge)));
  await page.waitForFunction((id) => !window.canvasPage.diagrams().includes(id), made);
  check("Merge brings the diagram below into the one above", await at("count", "top"), upperCount + lowerCount);
  const brought = (await at("nodes", "top")).filter((node) => !upperIds.includes(node.id));
  check("its shapes come in under the upper band", brought.every((node) => node.y >= upperHeight), true);
  check("and its block is gone", (await at("blocks")).some((block) => block.startsWith(`${made}:`)), false);
  await at("undo");
  await page.waitForFunction((id) => window.canvasPage.count(id) !== null, made);
  check("one undo takes the whole merge back", [await at("count", "top"), await at("count", made)], [
    upperCount,
    lowerCount,
  ]);
  const offered = await at("seam", "top");
  check("the offer is back with the pair", offered !== null, true);
  await page.mouse.click(...Object.values(centre(offered.dismiss)));
  await frame();
  check("× puts it away for that pair", await at("seam", "top"), null);

  // The pen on the page: its first point makes a diagram for it, which goes
  // again if the path is given up before its second point.
  const spare = await at("addLine", drawnOn);
  const penLine = await at("addLine", spare);
  await frame();
  const diagramsBefore = await at("diagrams");
  const penAt = async () => {
    const box = await at("block", penLine);
    return { x: box.left + 120, y: box.top + box.height / 2 };
  };
  const stepsBefore = await at("textSteps");
  await at("pick", "pen");
  const first = await penAt();
  await page.mouse.click(first.x, first.y);
  await page.waitForFunction((n) => window.canvasPage.diagrams().length === n, diagramsBefore.length + 1);
  const penBorn = (await at("diagrams")).find((id) => !diagramsBefore.includes(id));
  await page.waitForFunction((id) => window.canvasPage.count(id) === 1, penBorn);
  check("the pen's first point on the page makes a diagram for it", await at("count", penBorn), 1);
  const penOrder = (await at("blocks")).map((block) => block.split(":")[0]);
  check("just before the line it was pressed on", penOrder.indexOf(penBorn), penOrder.indexOf(penLine) - 1);
  await page.keyboard.press("Escape");
  await page.waitForFunction((id) => !window.canvasPage.diagrams().includes(id), penBorn);
  check("given up after one point, the diagram goes with it", (await at("diagrams")).includes(penBorn), false);
  check("and the line is still there", (await at("blocks")).includes(`${penLine}:paragraph`), true);
  check("leaving no step on the text's history", await at("textSteps"), stepsBefore);

  await at("pick", "pen");
  const again = await penAt();
  await page.mouse.click(again.x, again.y);
  await page.waitForFunction((n) => window.canvasPage.diagrams().length === n, diagramsBefore.length + 1);
  const pathBorn = (await at("diagrams")).find((id) => !diagramsBefore.includes(id));
  await page.waitForFunction((id) => window.canvasPage.count(id) === 1, pathBorn);
  const bornBand = await at("band", pathBorn);
  const bornHeight = await at("height", pathBorn);
  // Below the band, on the page: the diagram mid-path takes the point, and
  // grows to hold it.
  await page.mouse.click(bornBand.left + 320, bornBand.top + bornBand.height + 60);
  await frame();
  check("a later point below the band grows it", (await at("height", pathBorn)) > bornHeight, true);
  check("and makes no other diagram", (await at("diagrams")).length, diagramsBefore.length + 1);
  await page.keyboard.press("Enter");
  await page.waitForFunction((id) => (window.canvasPage.selection()[id] ?? []).length === 1, pathBorn);
  check("Enter makes the path, in the pen's diagram", await at("count", pathBorn), 1);
  check("and the tool is put down", await tool(), "move");

  {
    // ---- The pen past the band it made ----------------------------------------
    // Above it, the path moves down and the band grows to hold the point; in its
    // margins, the wash says the band will turn wide, and the point turns it;
    // below, it grows. The rubber band reaches the pointer wherever it is.
    const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;
    // Each made below the last, a line apart, so none is pressed in another's
    // band of room.
    let lastLine = penLine;
    const penBornAt = async () => {
      const line = await at("addLine", lastLine);
      lastLine = line;
      await frame();
      // Mid-screen, with room above and below it for the band to grow into.
      await page.evaluate((id) => document.querySelector(`.bn-block-outer[data-id="${id}"]`)?.scrollIntoView({ block: "center" }), line);
      await frame();
      const known = await at("diagrams");
      await at("pick", "pen");
      const box = await at("block", line);
      await page.mouse.click(box.left + 200, box.top + box.height / 2);
      await page.waitForFunction((n) => window.canvasPage.diagrams().length === n, known.length + 1);
      const id = (await at("diagrams")).find((d) => !known.includes(d));
      await page.waitForFunction((d) => window.canvasPage.count(d) === 1, id);
      await at("centreBand", id);
      await frame();
      return id;
    };
    const pathOf = async (id) => at("frameOf", id, (await at("nodes", id))[0].id);

    const up = await penBornAt();
    const band = await at("band", up);
    const scale = await at("bandScale", up);
    const first = await pathOf(up);
    await page.mouse.move(band.left + 300, band.top - 40, { steps: 4 });
    await frame();
    const reaching = await at("penDraft", up);
    check("hovered above the band, the pen's rubber band reaches the pointer", !!reaching && near(reaching.top, band.top - 40, 2), true);
    await page.mouse.click(band.left + 300, band.top - 40);
    await frame();
    const lifted = await pathOf(up);
    check("a point pressed above the band lands at its top", near(lifted.y, 0, 0.5), true);
    check("the first point moved down with it, keeping the path's shape", near(lifted.h, first.y + 40 / scale), true);
    const grown = await at("band", up);
    check("the band grows to hold it, its top where it was", [near(grown.top, band.top), grown.height > band.height], [true, true]);

    const below = await at("band", up);
    await page.mouse.move(below.left + 200, below.top + below.height + 50, { steps: 4 });
    await frame();
    const down = await at("penDraft", up);
    check("hovered below the band, the rubber band reaches down past it", !!down && near(down.top + down.height, below.top + below.height + 50, 2), true);

    await page.mouse.move(below.left + below.width + 80, below.top + below.height / 2, { steps: 4 });
    await frame();
    const aside = await at("penDraft", up);
    check("hovered in the margin, the side the next point widens into washes in deep", await at("wash", up), "right");
    check("and the rubber band reaches into it", !!aside && near(aside.left + aside.width, below.left + below.width + 80, 2), true);
    const penOrigin = await at("origin", up);
    await page.mouse.click(below.left + below.width + 80, below.top + below.height / 2);
    await frame();
    const widened = await pathOf(up);
    check("a point pressed in the margin turns the diagram wide", await at("wideKind", up), true);
    const widenedOrigin = await at("origin", up);
    check("and moves nothing already drawn", [near(widenedOrigin.x, penOrigin.x, 0.5), near(widenedOrigin.y, penOrigin.y, 0.5), widenedOrigin.scale], [true, true, penOrigin.scale]);
    check("and lands there", widened.x + widened.w > 720 + 40, true);
    check("the wash goes with the margins", await at("edge", up), false);
    await page.keyboard.press("Enter");
    await page.waitForFunction((d) => (window.canvasPage.selection()[d] ?? []).length === 1, up);
    // The first undo takes back the selection Enter made; the next, the point.
    await at("undo");
    await frame();
    check("undo first lets go of the path Enter selected", [JSON.stringify(await at("selection")), await at("wide", up)], ["{}", true]);
    await at("undo");
    await frame();
    const unwidened = await pathOf(up);
    check("one undo takes back the point and the width together", [await at("wide", up), near(unwidened.x + unwidened.w, lifted.x + lifted.w)], [false, true]);

    // ---- A curve pulled past the band stays in it ------------------------------
    // Handles pulled out of a band by the pen: the curve it draws is held, above
    // by moving the drawing down, beside by turning wide, below by growing.
    await at("clear");
    const curve = await penBornAt();
    const cb = await at("band", curve);
    const k = await at("bandScale", curve);
    // The second anchor near the top, dragged down-right: its in-handle points
    // up-left, and the curve into it arches above the band's top.
    await drag({ x: cb.left + 420, y: cb.top + 20 }, 160, 140);
    let f = await pathOf(curve);
    check("a curve arched above the band's top is moved down into it", f.y >= -0.01, true);
    // The two anchors are a few px apart down the band; the arch between them
    // tens of px tall.
    check("with its box around the whole arch, not only its anchors", f.h > 30, true);
    let drawn = await at("band", curve);
    check("and the band holds its lowest point", drawn.height / k >= f.y + f.h - 0.5, true);
    // The third near the column's right edge, dragged left: its in-handle
    // points right, and the curve into it bulges past the column.
    const edgeAt = { x: drawn.left + drawn.width - 30, y: drawn.top + drawn.height - 40 };
    const held = await drag(edgeAt, -200, 30, { hold: () => at("edge", curve) });
    check("while a curve is pulled past the column, the margins wash in", held, true);
    f = await pathOf(curve);
    check("let go, the band turns wide to hold it", await at("wide", curve), true);
    check("and the curve is inside the wide band", [f.x >= -240 - 0.01, f.x + f.w <= 960 + 0.01, f.y >= -0.01], [true, true, true]);
    drawn = await at("band", curve);
    check("the band still holds its lowest point", drawn.height / (await at("bandScale", curve)) >= f.y + f.h - 0.5, true);
    await page.keyboard.press("Enter");
    await at("clear");
    await at("padPage", null);
    await frame();
  }

  // ⌫ over a selection spanning diagrams, where the upper one goes with its
  // last shape: the caret that lands in the text lets nothing of the lower
  // one's selection go before it is deleted too.
  await at("clear");
  await at("reveal", "top", "a1");
  await frame();
  await page.mouse.click(...Object.values(centre(await at("shape", "top", "a1"))));
  await page.keyboard.press(`${mod}+KeyA`);
  const lowerIds = (await at("nodes", made)).map((node) => node.id);
  check("the whole of the upper one", (await at("selection")).top?.length, await at("count", "top"));
  // Its shapes paint nothing a pointer could pick.
  await at("add", made, [lowerIds[0]]);
  check("a selection holds all of one diagram and part of the next", (await at("selection"))[made], [lowerIds[0]]);
  await page.keyboard.press("Backspace");
  await page.waitForFunction(() => !window.canvasPage.diagrams().includes("top"));
  check("⌫ takes the emptied diagram out", (await at("blocks")).some((block) => block.startsWith("top:")), false);
  check("and the selected shape out of the one below", (await at("nodes", made)).map((node) => node.id), lowerIds.slice(1));
  await press("undo");
  await page.waitForFunction(() => window.canvasPage.count("top") !== null);
  check("one undo brings both back", (await at("nodes", made)).map((node) => node.id), lowerIds);

  // A diagram that is the page's first block, held — node-selected — when its
  // last shape goes: undo, redo and undo again keep the view on the doc.
  await at("clear");
  await at("removeBlock", "intro");
  await frame();
  check("the diagram is the first block", (await at("blocks"))[0], "top:canvas");
  await page.mouse.click(...Object.values(centre(await at("shape", "top", "a1"))));
  await page.keyboard.press(`${mod}+KeyA`);
  await page.keyboard.press("Backspace");
  await page.waitForFunction(() => !window.canvasPage.diagrams().includes("top"));
  await press("undo");
  await page.waitForFunction(() => window.canvasPage.count("top") !== null, null, { timeout: 2000 });
  check("undo brings the first diagram back", await at("viewBlocks"), await at("docBlocks"));
  await press("redo");
  await page.waitForFunction(() => !window.canvasPage.diagrams().includes("top"), null, { timeout: 2000 });
  check("redo takes it out, the view agreeing with the doc", await at("viewBlocks"), await at("docBlocks"));
  await press("undo");
  await page.waitForFunction(() => window.canvasPage.count("top") !== null, null, { timeout: 2000 });
  check("and undo brings it back again", [(await at("viewBlocks"))[0], await at("viewBlocks")], ["top", await at("docBlocks")]);

  // Nested under a paragraph, a diagram's band stays on the text column.
  check("a diagram can be nested", await at("nest", pathBorn), "true");
  await frame();
  check(
    "and its band stays on the text column",
    Math.round((await at("band", pathBorn)).left - (await at("band", "top")).left),
    0,
  );

  check("no page errors", guards.errors(), []);
  check("no requests off the fixture", guards.requests(), []);
} catch (error) {
  failures.push(String(error?.stack ?? error));
  console.log(`  FAIL ${error?.message ?? error}`);
  for (const line of guards?.errors() ?? []) console.log(`    ${line}`);
  const shown = await page?.evaluate(() => ({
    bands: document.querySelectorAll(".nt-canvas").length,
    blocks: document.querySelectorAll(".bn-block-content").length,
  })).catch(() => null);
  if (shown) console.log(`    on the page: ${JSON.stringify(shown)}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const { failed } = summary();
if (failed || failures.length) {
  console.log(`\n${Math.max(failed, failures.length)} canvas page check(s) failed.`);
  process.exit(1);
}
console.log("\nAll canvas page checks passed.");
