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
