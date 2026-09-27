/**
 * Resizing and scaling containers on a bare `CanvasSurface` — real Chromium
 * pointer input on the selection frame's handles, through the shared
 * `window.canvasHarness` bundle.
 *
 * Every combined thing a diagram holds — a plain group, an auto-layout row, a
 * union, a subtract, a flattened path, a group around a rotated child, a group
 * inside a group — and one lone rect beside them, each dragged by a corner, an
 * edge, a Shift corner and an Alt corner, and scaled with the Scale tool. For
 * every one:
 *
 *   - the container lands on the box the drag asked for;
 *   - every box inside it lands where the committed scene says (`laidRect`),
 *     and the pixels agree with the scene after release (`domRect`);
 *   - the last live frame is where the release lands, and what it draws
 *     is what the release draws — nothing jumps, a boolean's cut included;
 *   - one undo puts the scene back exactly.
 *
 * The landing boxes are pinned in `EXPECTED`. A handle stretches: a plain
 * group's children and a boolean's operands take the container's factor on
 * each axis (strokes and type stay as drawn), an auto-layout group re-flows
 * its children at their own size, and a rotated child keeps its angle (see
 * `scene/stretch`). The Scale tool scales everything evenly, strokes and type
 * included.
 *
 *   node tests/canvas-resize.browser.mjs
 */
import { execFileSync } from "node:child_process";
import { buildHarness, checker, launch, openPage, pretendApplePlatform, repo, writeArtifact } from "./canvas-harness.mjs";

const VIEWPORT = { width: 1280, height: 900 };
const OFF_CANVAS = { x: 8, y: 8 };
const RECORD = process.env.CANVAS_RESIZE_RECORD === "1";

const c = checker();

/** The diagram root around one case's content. */
const root = (body) => `<nt-diagram id="resize" h="520" style="background: #fff">\n${body}\n</nt-diagram>`;

/**
 * One container per case, at (200, 120) — well inside the band, clear of
 * its sides whichever way a drag goes. `ids` lists every node whose landing
 * box is compared, the container first.
 */
const CASES = {
  group: {
    ids: ["g", "ga", "gb"],
    drawn: "ga",
    html: root(
      `  <nt-group id="g" x="200" y="120" w="200" h="120">
    <nt-rect id="ga" x="0" y="0" w="80" h="60" style="background: #ef4444; border: 2px solid #111; font-size: 13px"></nt-rect>
    <nt-rect id="gb" x="120" y="60" w="80" h="60" style="background: #3b82f6"></nt-rect>
  </nt-group>`,
    ),
  },
  "auto-layout": {
    ids: ["fl", "fa", "fb"],
    html: root(
      `  <nt-group id="fl" x="200" y="120" w="210" h="100" style="display: flex; flex-direction: row; gap: 10px; padding: 10px; background: #f5f5f4">
    <nt-rect id="fa" w="90" h="80" style="background: #ef4444"></nt-rect>
    <nt-rect id="fb" w="90" h="80" style="background: #3b82f6"></nt-rect>
  </nt-group>`,
    ),
  },
  union: {
    ids: ["un", "ua", "ub"],
    html: root(
      `  <nt-group id="un" x="200" y="120" w="200" h="120" op="union" style="background: #6366f1">
    <nt-rect id="ua" x="0" y="0" w="130" h="90"></nt-rect>
    <nt-ellipse id="ub" x="70" y="30" w="130" h="90"></nt-ellipse>
  </nt-group>`,
    ),
  },
  subtract: {
    ids: ["sb", "sa", "sc"],
    html: root(
      `  <nt-group id="sb" x="200" y="120" w="200" h="120" op="subtract" style="background: #6366f1">
    <nt-rect id="sa" x="0" y="0" w="200" h="120"></nt-rect>
    <nt-ellipse id="sc" x="60" y="20" w="80" h="80"></nt-ellipse>
  </nt-group>`,
    ),
  },
  flattened: {
    ids: ["pf"],
    html: root(
      `  <nt-path id="pf" x="200" y="120" w="200" h="120" d="M 0 0 L 130 0 L 130 30 C 170 30 200 60 200 75 C 200 100 170 120 135 120 L 0 120 Z" style="background: #6366f1"></nt-path>`,
    ),
  },
  "rotated-child": {
    ids: ["gr", "rc", "rd"],
    html: root(
      `  <nt-group id="gr" x="200" y="120" w="200" h="120">
    <nt-rect id="rc" x="20" y="30" w="100" h="60" rot="30" style="background: #ef4444"></nt-rect>
    <nt-rect id="rd" x="150" y="70" w="50" h="50" style="background: #3b82f6"></nt-rect>
  </nt-group>`,
    ),
  },
  nested: {
    ids: ["no", "ni", "na", "nb", "nc"],
    html: root(
      `  <nt-group id="no" x="200" y="120" w="200" h="120">
    <nt-group id="ni" x="0" y="0" w="120" h="80">
      <nt-rect id="na" x="0" y="0" w="50" h="40" style="background: #ef4444"></nt-rect>
      <nt-rect id="nb" x="70" y="40" w="50" h="40" style="background: #22c55e"></nt-rect>
    </nt-group>
    <nt-rect id="nc" x="150" y="70" w="50" h="50" style="background: #3b82f6"></nt-rect>
  </nt-group>`,
    ),
  },
  "drawn-inside": {
    ids: ["dg", "dp", "du", "dv"],
    html: root(
      `  <nt-group id="dg" x="200" y="120" w="200" h="120">
    <nt-polygon id="dp" x="0" y="0" w="70" h="60" sides="5" style="background: #ef4444; border-radius: 8px"></nt-polygon>
    <nt-group id="du" x="80" y="0" w="120" h="70" op="union" style="background: #6366f1">
      <nt-rect id="dua" x="0" y="0" w="80" h="50" style="border-radius: 12px"></nt-rect>
      <nt-ellipse id="dub" x="50" y="20" w="70" h="50"></nt-ellipse>
    </nt-group>
    <nt-path id="dv" x="0" y="80" w="200" h="40" d="M 0 40 C 60 0 140 0 200 40" style="fill: none; stroke: #111; stroke-width: 2"></nt-path>
  </nt-group>`,
    ),
  },
  "rotated-group": {
    ids: ["rg", "ra", "rb"],
    frame: { x: 200, y: 120, w: 200, h: 120, rot: 20 },
    html: root(
      `  <nt-group id="rg" x="200" y="120" w="200" h="120" rot="20">
    <nt-rect id="ra" x="0" y="0" w="80" h="60" style="background: #ef4444"></nt-rect>
    <nt-rect id="rb" x="120" y="60" w="80" h="60" style="background: #3b82f6"></nt-rect>
  </nt-group>`,
    ),
  },
  "group-and-rect": {
    ids: ["mg", "ma", "mb", "mr"],
    select: ["mg", "mr"],
    html: root(
      `  <nt-group id="mg" x="200" y="120" w="120" h="120">
    <nt-rect id="ma" x="0" y="0" w="50" h="50" style="background: #ef4444"></nt-rect>
    <nt-rect id="mb" x="70" y="70" w="50" h="50" style="background: #3b82f6"></nt-rect>
  </nt-group>
  <nt-rect id="mr" x="340" y="180" w="60" h="60" style="background: #22c55e"></nt-rect>`,
    ),
  },
  single: {
    ids: ["lone"],
    html: root(`  <nt-rect id="lone" x="200" y="120" w="200" h="120" style="background: #ef4444"></nt-rect>`),
  },
};

/**
 * Each drag: the handle pressed, how far (scene px, at zoom 1), the keys
 * held, and the tool. Deltas are chosen to meet no other shape's edge, so
 * snapping has nothing to add.
 */
const DRAGS = {
  corner: { handle: "se", dx: 63, dy: 37 },
  "corner-nw": { handle: "nw", dx: -41, dy: -23 },
  edge: { handle: "e", dx: 53, dy: 0 },
  shift: { handle: "se", dx: 63, dy: 13, shift: true },
  alt: { handle: "se", dx: 31, dy: 17, alt: true },
  scale: { handle: "se", dx: 63, dy: 37, tool: "scale" },
};

/** The container box a drag asks for — the one thing needing no reference. */
function askedBox(start, drag) {
  const { handle, dx, dy } = drag;
  if (drag.tool === "scale" || drag.shift || drag.rotated) return null;
  const hx = handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0;
  const hy = handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0;
  const box = { ...start };
  const mx = hx * dx;
  const my = hy * dy;
  if (drag.alt) return { x: start.x - mx, y: start.y - my, w: start.w + 2 * mx, h: start.h + 2 * my };
  if (hx > 0) box.w += dx;
  if (hx < 0) {
    box.x += dx;
    box.w -= dx;
  }
  if (hy > 0) box.h += dy;
  if (hy < 0) {
    box.y += dy;
    box.h -= dy;
  }
  return box;
}

const FRAC = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };

/** Where a handle sits on a box turned by `rot` about its centre, in scene px. */
function handlePoint(box, fx, fy) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const ox = (fx - 0.5) * box.w;
  const oy = (fy - 0.5) * box.h;
  const t = ((box.rot ?? 0) * Math.PI) / 180;
  return { x: cx + ox * Math.cos(t) - oy * Math.sin(t), y: cy + ox * Math.sin(t) + oy * Math.cos(t) };
}

const round = (r) => ({
  x: Math.round(r.x * 10) / 10,
  y: Math.round(r.y * 10) / 10,
  w: Math.round(r.w * 10) / 10,
  h: Math.round(r.h * 10) / 10,
});

function near(a, b, eps = 0.6) {
  return (
    Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.w - b.w) <= eps && Math.abs(a.h - b.h) <= eps
  );
}

/** Each node's box, by `laidRect` or `domRect`; a node with no element of its own — a boolean's operands, drawn as its one path — is left out of the pixels. */
async function boxes(page, ids, kind) {
  return page.evaluate(
    ({ ids, kind }) =>
      Object.fromEntries(
        ids
          .filter((id) => kind !== "domRect" || document.querySelector(`[data-id="${CSS.escape(id)}"]`))
          .map((id) => [id, window.canvasHarness[kind](id)]),
      ),
    { ids, kind },
  );
}

/**
 * What each drawn node paints, in client px: the path an SVG-drawn node (a
 * path, a boolean) draws inside its box, or the box itself. A box can land
 * where the preview put it while what is drawn in it does not.
 */
async function paints(page, ids) {
  return page.evaluate((ids) => {
    const out = {};
    for (const id of ids) {
      const el = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (!el) continue;
      const path = el.querySelector(":scope > path, :scope > svg > path");
      const r = (path ?? el).getBoundingClientRect();
      out[id] = { x: r.left, y: r.top, w: r.width, h: r.height };
    }
    return out;
  }, ids);
}

/** A node's committed `style`, found anywhere in the scene. */
async function styleOf(page, id) {
  return page.evaluate((id) => {
    const find = (nodes) => {
      for (const node of nodes) {
        if (node.id === id) return node;
        const inner = node.children && find(node.children);
        if (inner) return inner;
      }
      return null;
    };
    return find(window.canvasHarness.api().store.getScene().nodes)?.style ?? null;
  }, id);
}

/** An undo glides the shapes it moves (`render/glide.ts`); the pixels are compared once they have landed. */
async function landed(page) {
  await page.evaluate(() => window.canvasHarness.nextFrame());
  await page.waitForFunction(() => !document.getAnimations().some((a) => a.id === "nt-glide"));
  await page.evaluate(() => window.canvasHarness.nextFrame());
}

async function runDrag(page, name, spec, dragName, drag) {
  await page.evaluate((html) => window.canvasHarness.mount({ html }), spec.html);
  const id = spec.ids[0];
  const before = await page.evaluate(() => JSON.stringify(window.canvasHarness.api().store.getScene()));
  const picked = spec.select ?? [id];
  const start = await page.evaluate((ids) => {
    const rects = ids.map((n) => window.canvasHarness.laidRect(n));
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
  }, picked);
  await page.evaluate(
    ({ ids, tool }) => {
      const h = window.canvasHarness;
      h.look({ x: 360, y: 200 }, 1);
      h.api().selection.select(ids);
      if (tool) h.api().setTool(tool);
      h.focus();
    },
    { ids: picked, tool: drag.tool ?? null },
  );
  await page.evaluate(() => window.canvasHarness.nextFrame());
  await page.evaluate(() => window.canvasHarness.nextFrame());

  const [fx, fy] = FRAC[drag.handle];
  const from = await page.evaluate((p) => window.canvasHarness.toClient(p), handlePoint(spec.frame ?? start, fx, fy));
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el?.parentElement?.getAttribute("class") ?? el?.getAttribute("class") ?? null;
  }, from);
  const to = { x: from.x + drag.dx, y: from.y + drag.dy };

  if (drag.shift) await page.keyboard.down("Shift");
  if (drag.alt) await page.keyboard.down("Alt");
  let live;
  let livePaint;
  let halfway;
  try {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
    await page.evaluate(() => window.canvasHarness.nextFrame());
    halfway = await boxes(page, spec.ids, "domRect");
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.evaluate(() => window.canvasHarness.nextFrame());
    await page.evaluate(() => window.canvasHarness.nextFrame());
    live = await boxes(page, spec.ids, "domRect");
    livePaint = await paints(page, spec.ids);
    await page.mouse.up();
  } finally {
    if (drag.alt) await page.keyboard.up("Alt");
    if (drag.shift) await page.keyboard.up("Shift");
  }
  await page.evaluate(() => window.canvasHarness.nextFrame());
  await page.evaluate(() => window.canvasHarness.nextFrame());
  const laid = await boxes(page, spec.ids, "laidRect");
  const drawn = spec.drawn ? await styleOf(page, spec.drawn) : null;
  const dom = await boxes(page, spec.ids, "domRect");
  const paint = await paints(page, spec.ids);
  const pushes = await page.evaluate(() => window.canvasHarness.counters().historyPushes);
  await page.evaluate(() => window.canvasHarness.api().store.undo());
  await landed(page);
  const undone = await page.evaluate(() => JSON.stringify(window.canvasHarness.api().store.getScene()));
  const domUndone = await boxes(page, spec.ids, "domRect");
  const laidUndone = await boxes(page, spec.ids, "laidRect");
  await page.evaluate(() => window.canvasHarness.api().setTool("move"));
  await page.mouse.move(OFF_CANVAS.x, OFF_CANVAS.y);

  return { drawn, hit, start, halfway, live, livePaint, paint, laid, dom, pushes, undoExact: undone === before, domUndone, laidUndone };
}

async function runCases(page, expected, recorded) {
  for (const [name, spec] of Object.entries(CASES)) {
    for (const [dragName, drag] of Object.entries(DRAGS)) {
      const key = `${name}.${dragName}`;
      const r = await runDrag(page, name, spec, dragName, drag);
      const laid = Object.fromEntries(Object.entries(r.laid).map(([k, v]) => [k, round(v)]));
      recorded[key] = laid;
      if (RECORD) {
        console.log(`  rec  ${key} hit=${r.hit} ${JSON.stringify(laid)}`);
        continue;
      }
      const id = spec.ids[0];
      c.check(`resize.${key}.handle-hit`, /nt-ov-(corners|edges)/.test(r.hit ?? ""), true);
      c.check(`resize.${key}.one-undo-step`, r.pushes, 1);
      const asked = spec.select ? null : askedBox(r.start, { ...drag, rotated: !!spec.frame?.rot });
      if (asked) c.check(`resize.${key}.container-box`, near(r.laid[id], asked), true);
      const want = expected[key];
      if (want) {
        const off = spec.ids.filter((n) => {
          const [x, y, w, h] = want[n];
          return !near(r.laid[n], { x, y, w, h });
        });
        c.check(`resize.${key}.lands-as-pinned`, off.map((n) => [n, laid[n]]), []);
      } else {
        c.check(`resize.${key}.has-reference`, false, true);
      }
      const drawn = spec.ids.filter((n) => r.dom[n]);
      const unpainted = drawn.filter((n) => !near(r.dom[n], r.laid[n], 1));
      c.check(
        `resize.${key}.pixels-are-the-scene`,
        unpainted.map((n) => [n, round(r.dom[n]), laid[n]]),
        [],
      );
      // The scale tool previews as a transform, whose bounding box a rotated
      // child's box does not share; every other gesture previews as it lands.
      const jumped = drawn.filter((n) => !near(r.live[n], r.dom[n], 1));
      c.check(`resize.${key}.no-jump-on-release`, jumped.map((n) => [n, round(r.live[n]), round(r.dom[n])]), []);
      const repainted = drawn.filter((n) => !near(r.livePaint[n], r.paint[n], 1));
      c.check(`resize.${key}.drawing-lands-as-previewed`, repainted, []);
      // A handle stretches the geometry and leaves what is drawn on it; the
      // Scale tool takes the stroke and the type along.
      if (spec.drawn) {
        const k = drag.tool === "scale" ? r.laid[spec.drawn].w / 80 : 1;
        const want = { border: `${Math.round(2 * k * 1000) / 1000}px solid #111`, "font-size": `${Math.round(13 * k * 1000) / 1000}px` };
        c.check(`resize.${key}.stroke-and-type`, { border: r.drawn.border, "font-size": r.drawn["font-size"] }, want);
      }
      const flipped = drawn.filter((n) => r.halfway[n].w <= 0 || r.halfway[n].h <= 0);
      c.check(`resize.${key}.no-flip-midway`, flipped, []);
      c.check(`resize.${key}.undo-exact`, r.undoExact, true);
      const back = drawn.filter((n) => !near(r.domUndone[n], r.laidUndone[n], 1));
      c.check(`resize.${key}.undo-repaints`, back, []);
    }
  }
}

async function main() {
  const built = await buildHarness();
  const { browser } = await launch();
  const recorded = {};
  try {
    const { page, guards } = await openPage(browser, built.origin, { viewport: VIEWPORT, aiReach: built.aiReach });
    await pretendApplePlatform(page);
    await page.goto(built.origin, { waitUntil: "networkidle" });
    await runCases(page, EXPECTED, recorded);
    c.check("resize.guard.noNetwork", guards.requests(), []);
    c.check("resize.guard.noConsoleErrors", guards.errors(), []);
    const artifactPath = await writeArtifact("canvas-resize", {
      commit: safeCommit(),
      summary: c.summary(),
      recorded,
      verdict: c.summary().failed === 0 ? "pass" : "fail",
    });
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

/**
 * Landing boxes as `[x, y, w, h]` (scene px, a rotated node's by its bounds)
 * per `case.drag`, recorded with `CANVAS_RESIZE_RECORD=1`. The containers
 * land as they did at 41f3d35, the commit before diagrams became bands, except
 * where that commit still snapped to the diagram's own surface (`*.alt`'s y
 * and h), which a band no longer offers as a target; what is inside them
 * follows the stretch described at the top. `group.corner` reads it plainly:
 * 263 × 157 from 200 × 120 is 1.315 × 1.308, so `ga`'s 80 × 60 lands at
 * 105.2 × 78.5 and `gb`, 120 in, at 157.8.
 */
const EXPECTED = {
  "group.corner": { g: [200, 120, 263, 157], ga: [200, 120, 105.2, 78.5], gb: [357.8, 198.5, 105.2, 78.5] },
  "group.corner-nw": { g: [159, 97, 241, 143], ga: [159, 97, 96.4, 71.5], gb: [303.6, 168.5, 96.4, 71.5] },
  "group.edge": { g: [200, 120, 253, 120], ga: [200, 120, 101.2, 60], gb: [351.8, 180, 101.2, 60] },
  "group.shift": { g: [200, 120, 263, 157.8], ga: [200, 120, 105.2, 78.9], gb: [357.8, 198.9, 105.2, 78.9] },
  "group.alt": { g: [169, 103, 262, 154], ga: [169, 103, 104.8, 77], gb: [326.2, 180, 104.8, 77] },
  "group.scale": { g: [200, 120, 262.6, 157.6], ga: [200, 120, 105.1, 78.8], gb: [357.6, 198.8, 105.1, 78.8] },
  "auto-layout.corner": { fl: [200, 120, 273, 137], fa: [210, 130, 90, 80], fb: [310, 130, 90, 80] },
  "auto-layout.corner-nw": { fl: [159, 97, 251, 123], fa: [169, 107, 90, 80], fb: [269, 107, 90, 80] },
  "auto-layout.edge": { fl: [200, 120, 263, 100], fa: [210, 130, 90, 80], fb: [310, 130, 90, 80] },
  "auto-layout.shift": { fl: [200, 120, 273, 130], fa: [210, 130, 90, 80], fb: [310, 130, 90, 80] },
  "auto-layout.alt": { fl: [169, 103, 272, 134], fa: [179, 113, 90, 80], fb: [279, 113, 90, 80] },
  "auto-layout.scale": { fl: [200, 120, 275.7, 131.3], fa: [213.1, 133.1, 118.2, 105], fb: [344.4, 133.1, 118.2, 105] },
  "union.corner": { un: [200, 120, 263, 157], ua: [200, 120, 171, 117.8], ub: [292, 159.3, 171, 117.8] },
  "union.corner-nw": { un: [159, 97, 241, 143], ua: [159, 97, 156.7, 107.3], ub: [243.4, 132.8, 156.7, 107.3] },
  "union.edge": { un: [200, 120, 253, 120], ua: [200, 120, 164.5, 90], ub: [288.5, 150, 164.5, 90] },
  "union.shift": { un: [200, 120, 263, 157.8], ua: [200, 120, 171, 118.4], ub: [292, 159.5, 171, 118.4] },
  "union.alt": { un: [169, 103, 262, 154], ua: [169, 103, 170.3, 115.5], ub: [260.7, 141.5, 170.3, 115.5] },
  "union.scale": { un: [200, 120, 262.6, 157.6], ua: [200, 120, 170.7, 118.2], ub: [291.9, 159.4, 170.7, 118.2] },
  "subtract.corner": { sb: [200, 120, 263, 157], sa: [200, 120, 263, 157], sc: [278.9, 146.2, 105.2, 104.7] },
  "subtract.corner-nw": { sb: [159, 97, 241, 143], sa: [159, 97, 241, 143], sc: [231.3, 120.8, 96.4, 95.3] },
  "subtract.edge": { sb: [200, 120, 253, 120], sa: [200, 120, 253, 120], sc: [275.9, 140, 101.2, 80] },
  "subtract.shift": { sb: [200, 120, 263, 157.8], sa: [200, 120, 263, 157.8], sc: [278.9, 146.3, 105.2, 105.2] },
  "subtract.alt": { sb: [169, 103, 262, 154], sa: [169, 103, 262, 154], sc: [247.6, 128.7, 104.8, 102.7] },
  "subtract.scale": { sb: [200, 120, 262.6, 157.6], sa: [200, 120, 262.6, 157.6], sc: [278.8, 146.3, 105.1, 105.1] },
  "flattened.corner": { pf: [200, 120, 263, 157] },
  "flattened.corner-nw": { pf: [159, 97, 241, 143] },
  "flattened.edge": { pf: [200, 120, 253, 120] },
  "flattened.shift": { pf: [200, 120, 263, 157.8] },
  "flattened.alt": { pf: [169, 103, 262, 154] },
  "flattened.scale": { pf: [200, 120, 262.6, 157.6] },
  "rotated-child.corner": { gr: [200, 120, 263, 157], rc: [215.5, 131.6, 153, 133.7], rd: [397.3, 211.6, 65.8, 65.4] },
  "rotated-child.corner-nw": { gr: [159, 97, 241, 143], rc: [173.4, 107.4, 139.9, 122.2], rd: [339.8, 180.4, 60.3, 59.6] },
  "rotated-child.edge": { gr: [200, 120, 253, 120], rc: [220.3, 122, 136.5, 115.9], rd: [389.8, 190, 63.2, 50] },
  "rotated-child.shift": { gr: [200, 120, 263, 157.8], rc: [215.4, 131.9, 153.3, 134.1], rd: [397.3, 212.1, 65.8, 65.8] },
  "rotated-child.alt": { gr: [169, 103, 262, 154], rc: [184.9, 113.9, 151.6, 132.2], rd: [365.5, 192.8, 65.5, 64.2] },
  "rotated-child.scale": { gr: [200, 120, 262.6, 157.6], rc: [215.4, 131.8, 153.1, 133.9], rd: [397, 211.9, 65.7, 65.7] },
  "nested.corner": { no: [200, 120, 263, 157], ni: [200, 120, 157.8, 104.7], na: [200, 120, 65.8, 52.3], nb: [292.1, 172.3, 65.8, 52.3], nc: [397.3, 211.6, 65.8, 65.4] },
  "nested.corner-nw": { no: [159, 97, 241, 143], ni: [159, 97, 144.6, 95.3], na: [159, 97, 60.3, 47.7], nb: [243.4, 144.7, 60.3, 47.7], nc: [339.8, 180.4, 60.3, 59.6] },
  "nested.edge": { no: [200, 120, 253, 120], ni: [200, 120, 151.8, 80], na: [200, 120, 63.2, 40], nb: [288.6, 160, 63.2, 40], nc: [389.8, 190, 63.2, 50] },
  "nested.shift": { no: [200, 120, 263, 157.8], ni: [200, 120, 157.8, 105.2], na: [200, 120, 65.8, 52.6], nb: [292.1, 172.6, 65.8, 52.6], nc: [397.3, 212.1, 65.8, 65.8] },
  "nested.alt": { no: [169, 103, 262, 154], ni: [169, 103, 157.2, 102.7], na: [169, 103, 65.5, 51.3], nb: [260.7, 154.3, 65.5, 51.3], nc: [365.5, 192.8, 65.5, 64.2] },
  "nested.scale": { no: [200, 120, 262.6, 157.6], ni: [200, 120, 157.6, 105.1], na: [200, 120, 65.7, 52.5], nb: [291.9, 172.5, 65.7, 52.5], nc: [397, 211.9, 65.7, 65.7] },
  "drawn-inside.corner": { dg: [200, 120, 263, 157], dp: [200, 120, 92.1, 78.5], du: [305.2, 120, 157.8, 91.6], dv: [200, 224.7, 263, 52.3] },
  "drawn-inside.corner-nw": { dg: [159, 97, 241, 143], dp: [159, 97, 84.4, 71.5], du: [255.4, 97, 144.6, 83.4], dv: [159, 192.3, 241, 47.7] },
  "drawn-inside.edge": { dg: [200, 120, 253, 120], dp: [200, 120, 88.6, 60], du: [301.2, 120, 151.8, 70], dv: [200, 200, 253, 40] },
  "drawn-inside.shift": { dg: [200, 120, 263, 157.8], dp: [200, 120, 92.1, 78.9], du: [305.2, 120, 157.8, 92.1], dv: [200, 225.2, 263, 52.6] },
  "drawn-inside.alt": { dg: [169, 103, 262, 154], dp: [169, 103, 91.7, 77], du: [273.8, 103, 157.2, 89.8], dv: [169, 205.7, 262, 51.3] },
  "drawn-inside.scale": { dg: [200, 120, 262.6, 157.6], dp: [200, 120, 91.9, 78.8], du: [305.1, 120, 157.6, 91.9], dv: [200, 225.1, 262.6, 52.5] },
  "rotated-group.corner": { rg: [181, 89.4, 301, 218.2], ra: [203.8, 89.4, 125, 99.8], rb: [334.3, 207.8, 125, 99.8] },
  "rotated-group.corner-nw": { rg: [141.9, 66.4, 275.2, 204.2], ra: [163.7, 66.4, 114.4, 93.7], rb: [280.8, 176.9, 114.4, 93.7] },
  "rotated-group.edge": { rg: [185.5, 89.4, 275.8, 198.2], ra: [206, 89.4, 114.4, 90.6], rb: [326.4, 197.1, 114.4, 90.6] },
  "rotated-group.shift": { rg: [172.4, 89.4, 301.9, 238.8], ra: [199.5, 89.4, 126.2, 110.4], rb: [321.1, 217.8, 126.2, 110.4] },
  "rotated-group.alt": { rg: [150.8, 72.4, 298.3, 215.2], ra: [173.2, 72.4, 123.8, 98.4], rb: [303, 189.2, 123.8, 98.4] },
  "rotated-group.scale": { rg: [181, 79.8, 300.7, 237.9], ra: [207.9, 79.8, 125.7, 110], rb: [329.1, 207.8, 125.7, 110] },
  "group-and-rect.corner": { mg: [200, 120, 157.8, 157], ma: [200, 120, 65.8, 65.4], mb: [292.1, 211.6, 65.8, 65.4], mr: [384.1, 198.5, 78.9, 78.5] },
  "group-and-rect.corner-nw": { mg: [159, 97, 144.6, 143], ma: [159, 97, 60.3, 59.6], mb: [243.4, 180.4, 60.3, 59.6], mr: [327.7, 168.5, 72.3, 71.5] },
  "group-and-rect.edge": { mg: [200, 120, 151.8, 120], ma: [200, 120, 63.2, 50], mb: [288.6, 190, 63.2, 50], mr: [377.1, 180, 75.9, 60] },
  "group-and-rect.shift": { mg: [200, 120, 157.8, 157.8], ma: [200, 120, 65.8, 65.8], mb: [292.1, 212.1, 65.8, 65.8], mr: [384.1, 198.9, 78.9, 78.9] },
  "group-and-rect.alt": { mg: [169, 103, 157.2, 154], ma: [169, 103, 65.5, 64.2], mb: [260.7, 192.8, 65.5, 64.2], mr: [352.4, 180, 78.6, 77] },
  "group-and-rect.scale": { mg: [200, 120, 157.6, 157.6], ma: [200, 120, 65.7, 65.7], mb: [291.9, 211.9, 65.7, 65.7], mr: [383.9, 198.8, 78.8, 78.8] },
  "single.corner": { lone: [200, 120, 263, 157] },
  "single.corner-nw": { lone: [159, 97, 241, 143] },
  "single.edge": { lone: [200, 120, 253, 120] },
  "single.shift": { lone: [200, 120, 263, 157.8] },
  "single.alt": { lone: [169, 103, 262, 154] },
  "single.scale": { lone: [200, 120, 262.6, 157.6] },
};

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
