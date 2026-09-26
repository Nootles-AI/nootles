/**
 * Two people on one diagram: does a collaborator's selection outline stay on
 * the shape while THIS person moves it?
 *
 * NT-73: the outline (`.nt-copresence-ghost`) was painted from the scene model
 * and repainted only on an awareness or store change. A local drag writes only
 * the DOM until it lands, so the outline sat at the shape's old place for the
 * whole drag, then glided over on the 240ms transition meant for remote
 * samples. The painter now reads the canvas's live gesture frames, and only a
 * remote hand's samples glide.
 *
 * Each person is their own Chromium (a background tab runs no rAF, and the
 * gesture moves shapes in rAF) with a real `YConvexProvider` — the real 200ms
 * awareness throttle and 500ms flush — over a stand-in Convex backend relayed
 * through this script with a round-trip latency. Positions are read once per
 * rendered frame, in scene px against the scene layer.
 *
 * A selects something; B then moves it — a move, a turned shape, a resize, a
 * rotation, a group under a selected child, an alt-drag duplicate, an Escape,
 * a keyboard nudge — and on every one of B's frames A's outline must sit on
 * the shape (±1px). Also: a selected connector's halo follows its re-route, A's
 * own view lands B's outline with the shape, and a control with nothing
 * selected shows no outline at all.
 *
 * No app server, no Convex, no API keys; every off-origin request is refused
 * and fails the run, so no AI lane can be spent in here.
 *
 *   node tests/canvas-presence.browser.mjs
 *   CANVAS_PRESENCE_LATENCY=400 node tests/canvas-presence.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "canvas-presence-"));
const artifacts = path.join(repo, "tests/.artifacts/canvas-presence");
const ENTRY = "tests/canvas-presence.browser.tsx";
/** Client → backend → client round trip, ms. */
const LATENCY = Number(process.env.CANVAS_PRESENCE_LATENCY ?? 200);

await build({
  absWorkingDir: repo, entryPoints: [ENTRY], bundle: true, splitting: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [{ name: "fixture", setup(builder) {
    builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({ path: "server-only", namespace: "fixture" }));
    builder.onLoad({ filter: /^server-only$/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };' }));
  } }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
});
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="canvas-presence.browser.css"><style>html,body{margin:0;height:100%;overflow:hidden;font-family:Arial,sans-serif}.relative{position:relative}.w-full{width:100%}</style></head><body><div id="app"></div><script type="module" src="canvas-presence.browser.js"></script></body></html>`);

const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, "http://x").pathname === "/" ? "index.html" : path.basename(new URL(req.url, "http://x").pathname);
    const data = await readFile(path.join(output, name));
    res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream");
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { chromium } = await import("playwright");
const browsers = [];
const errors = [];
const failures = [];
const log = {};

async function person(role) {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.CANVAS_BROWSER_CHANNEL === "headless-shell" ? undefined : "chromium",
    executablePath: process.env.CANVAS_CHROME_PATH || undefined,
  });
  browsers.push(browser);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => errors.push(`${role} pageerror: ${e.message}`));
  page.on("console", (m) => {
    // A font or favicon the static server does not have is not the app.
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`${role} console: ${m.text()}`);
  });
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith("data:")) return route.continue();
    errors.push(`${role} left the origin: ${url}`);
    return route.abort();
  });
  await page.addInitScript(() => {
    window.WebSocket = class extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0;
      send() {}
      close() { this.readyState = 3; }
    };
  });
  return page;
}

/**
 * The backend: a mutation reaches it LATENCY/2 after it is sent, and every
 * subscriber, sender included, hears the result LATENCY/2 later, in order per
 * subscription. `hold[role]` delays presence to that person on top — a slow
 * presence query, so a document update can overtake it.
 */
const hold = { a: 0, b: 0 };
function backend(pages) {
  let seq = 0;
  const rows = new Map();
  const lanes = new Map();
  const deliver = (event) => {
    for (const [role, page] of Object.entries(pages)) {
      const due = Date.now() + LATENCY / 2 + (event.kind === "rows" ? hold[role] : 0);
      const lane = `${role}:${event.kind}`;
      lanes.set(lane, (lanes.get(lane) ?? Promise.resolve()).then(async () => {
        const wait = due - Date.now();
        if (wait > 0) await sleep(wait);
        await page.evaluate((e) => window.probe.receive(e), event).catch(() => {});
      }));
    }
  };
  return async (name, args) => {
    await sleep(LATENCY / 2);
    if (name === "ydoc:append") {
      for (const update of args.chunks) deliver({ kind: "append", seq: ++seq, update });
      return seq;
    }
    if (name === "presence:heartbeat") {
      rows.set(args.sessionId, { sessionId: args.sessionId, clientId: args.clientId, userId: null, user: args.user, state: args.state, updatedAt: Date.now() });
      deliver({ kind: "rows", rows: [...rows.values()] });
      return null;
    }
    if (name === "presence:leave") {
      rows.delete(args.sessionId);
      deliver({ kind: "rows", rows: [...rows.values()] });
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function check(ok, message, detail) {
  if (ok) {
    console.log(`  ok    ${message}`);
    return;
  }
  console.log(`  FAIL  ${message}${detail ? `\n        ${detail}` : ""}`);
  failures.push(message);
}

const near = (p, q, tol = 1) =>
  !!p && !!q && ["x", "y", "w", "h"].every((k) => Math.abs(p[k] - q[k]) <= tol);
const fmt = (r) => (r ? `(${r.x}, ${r.y}, ${r.w}×${r.h})` : "none");

/** The frames on which `a` and `b` disagree, and the first of them. */
function misses(rows, pick) {
  const off = rows.filter((row) => {
    const [p, q] = pick(row);
    return !near(p, q);
  });
  const first = off[0];
  return { count: off.length, first: first && pick(first).map(fmt).join(" vs ") };
}

/** Until B's view shows A's outline on `id` (or no outline at all), at rest. */
async function settled(page, id) {
  const end = Date.now() + 8000;
  let last = "";
  while (Date.now() < end) {
    const [ghosts, shape] = await page.evaluate((i) => [window.probe.ghosts(), i && window.probe.shape(i)], id);
    const now = JSON.stringify(ghosts);
    const there = id ? ghosts.length === 1 && near(ghosts[0], shape) : ghosts.length === 0;
    if (there && now === last) return;
    last = now;
    await sleep(150);
  }
  throw new Error(`B's view never showed A's outline ${id ? `on ${id}` : "gone"}`);
}

async function select(page, ids, edgeIds = []) {
  await page.evaluate(([i, e]) => window.probe.select(i, e), [ids, edgeIds]);
}

async function drag(page, from, to, { steps = 24, hold = 150, keys = [], before } = {}) {
  await page.mouse.move(from.x, from.y);
  for (const key of keys) await page.keyboard.down(key);
  await page.mouse.down();
  for (let s = 1; s <= steps; s++) {
    await page.mouse.move(from.x + ((to.x - from.x) * s) / steps, from.y + ((to.y - from.y) * s) / steps);
    await sleep(16);
  }
  await sleep(hold);
  if (before) await before();
  await page.mouse.up();
  for (const key of keys) await page.keyboard.up(key);
}

/** Record B (and A) while `act` runs, then a beat past it for the landing. */
async function recording(pages, id, act, after = 700) {
  await pages.a.evaluate((i) => window.probe.record(i), id);
  await pages.b.evaluate((i) => window.probe.record(i), id);
  await act();
  await sleep(after);
  const b = await pages.b.evaluate(() => window.probe.stop());
  const a = await pages.a.evaluate(() => window.probe.stop());
  return { a, b };
}

const point = (page, id) => page.evaluate((i) => window.probe.point(i), id);
const offset = (p, dx, dy) => ({ x: p.x + dx, y: p.y + dy });

/** Every B frame shows A's outline on the shape. */
function followed(name, rows, { moved = 50, own = true } = {}) {
  const start = rows[0]?.shape;
  const travel = Math.max(0, ...rows.map((r) => Math.hypot(r.shape.x - start.x, r.shape.y - start.y, r.shape.w - start.w, r.shape.h - start.h)));
  check(rows.length > 20 && travel >= moved, `${name}: the gesture really moved the shape (${Math.round(travel)} px over ${rows.length} frames)`);
  const absent = rows.filter((r) => r.ghosts.length !== 1).length;
  check(absent === 0, `${name}: A's outline is up on every frame`, `${absent} frame(s) without exactly one outline`);
  const off = misses(rows, (r) => [r.ghosts[0], r.shape]);
  check(off.count === 0, `${name}: A's outline sits on the shape on every frame (${rows.length} frames)`, `${off.count} frame(s) off; first: outline ${off.first}`);
  if (!own) return;
  // Before the press it frames whatever B had selected last.
  const mine = misses(rows.filter((r) => r.outline && r.down), (r) => [r.outline, r.shape]);
  check(mine.count === 0, `${name}: B's own selection frame sits on the shape while B's hand is on it`, `first: ${mine.first}`);
}

/**
 * A's own screen: B's outline streams ahead while the shape waits for the
 * commit; once the shape lands, the outline is on it — not gliding after it,
 * and not held off it by a sample older than the landing.
 */
function observed(name, rows) {
  const final = rows[rows.length - 1].shape;
  const landed = rows.findIndex((r) => near(r.shape, final));
  const after = rows.slice(landed + 1).filter((r) => !near(r.ghosts[0], r.shape));
  check(landed > 0 && !near(rows[0].shape, final), `${name}: A saw the shape land where B put it`);
  check(after.length === 0, `${name}: from the frame after it lands, B's outline sits on the shape on A's screen`, `${after.length} frame(s) off; first: ${after[0] && fmt(after[0].ghosts[0])} vs ${fmt(final)}`);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

try {
  const pages = { a: await person("a"), b: await person("b") };
  const call = backend(pages);
  for (const page of Object.values(pages)) {
    await page.exposeFunction("backendCall", (name, args) => call(name, args));
    await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  }
  await pages.a.evaluate(() => window.probe.start({ name: "Ada", color: "#3366cc" }, true));
  await sleep(1500);
  await pages.b.evaluate(() => window.probe.start({ name: "Bram", color: "#cc3366" }, false));
  await sleep(1500);

  // Only the person on the diagram broadcasts: whoever holds a selection in
  // it. A's selections below are what put A there.
  await pages.a.waitForFunction(() => window.probe.ready());
  console.log(`latency ${LATENCY} ms`);

  console.log("\n— control: A has nothing selected");
  {
    await select(pages.a, []);
    await settled(pages.b, null);
    const b = await point(pages.b, "b");
    const { b: rows } = await recording(pages, "b", () => drag(pages.b, b, offset(b, 0, 120)));
    check(rows.every((r) => r.ghosts.length === 0), "control: no outline is drawn for nobody's selection");
    const mine = misses(rows.filter((r) => r.outline && r.down), (r) => [r.outline, r.shape]);
    check(mine.count === 0 && rows.some((r) => r.outline && r.down), "control: B's own frame sits on the shape", `first: ${mine.first}`);
    log.control = rows;
    // Put it back where the scenarios below expect it.
    const back = await point(pages.b, "b");
    await drag(pages.b, back, offset(back, 0, -120));
  }

  console.log("\n— move: A has `a` selected, B drags it");
  {
    await select(pages.a, ["a"]);
    check(await pages.a.evaluate(() => window.probe.broadcasting()), "move: A's selection puts A's diagram in focus, so A broadcasts");
    await settled(pages.b, "a");
    const from = await point(pages.b, "a");
    const { a, b } = await recording(pages, "a", () => drag(pages.b, from, offset(from, 60, 200)), 2500);
    followed("move", b);
    log.move = { a, b };

    observed("observer", a);
  }

  console.log("\n— observer, commit first: B's presence reaches A late, so B's drag lands before the signal that ends it");
  {
    hold.a = 700;
    const from = await point(pages.b, "a");
    const { a } = await recording(pages, "a", () => drag(pages.b, from, offset(from, 0, 100)), 3000);
    hold.a = 0;
    observed("commit first", a);
    log.commitFirst = a;
  }

  console.log("\n— observer, own edit first: A moves the shape B has selected, then B drags it");
  {
    // A landing A made itself says nothing about B's next drag, which must
    // still stream ahead on A's screen.
    await pages.a.evaluate(() => window.probe.nudge("a", 0, -40));
    await sleep(1200);
    const from = await point(pages.b, "a");
    const { a } = await recording(pages, "a", () => drag(pages.b, from, offset(from, 0, 60)), 2500);
    const ahead = a.filter((r) => r.ghosts[0] && Math.abs(r.ghosts[0].y - r.shape.y) > 20).length;
    check(ahead > 5, `own edit first: B's outline streamed ahead of the shape on A's screen (${ahead} frames)`);
    observed("own edit first", a);
    log.ownEditFirst = a;
  }

  console.log("\n— turned shape: A has `r` (30°) selected, B drags it");
  {
    await select(pages.a, ["r"]);
    await settled(pages.b, "r");
    const from = await point(pages.b, "r");
    const { b } = await recording(pages, "r", () => drag(pages.b, from, offset(from, 220, 210)));
    followed("turned", b);
    check(b.every((r) => /rotate\(30deg\)/.test(r.ghostTransform ?? "")), "turned: the outline keeps its 30° turn on every frame");
    log.turned = b;
  }

  console.log("\n— resize: A has `a` selected, B pulls its right edge");
  {
    await select(pages.a, ["a"]);
    await settled(pages.b, "a");
    const at = await point(pages.b, "a");
    await pages.b.mouse.click(at.x, at.y);
    await sleep(100);
    const grip = await pages.b.evaluate(() => window.probe.handle("edges", 2));
    const { b } = await recording(pages, "a", () => drag(pages.b, grip, offset(grip, 80, 0)));
    followed("resize", b);
    log.resize = b;
  }

  console.log("\n— rotate: A has `r` selected, B turns it");
  {
    await select(pages.a, ["r"]);
    await settled(pages.b, "r");
    const at = await point(pages.b, "r");
    await pages.b.mouse.click(at.x, at.y);
    await sleep(100);
    const zone = await pages.b.evaluate(() => window.probe.handle("zones", 3));
    const { b } = await recording(pages, "r", async () => {
      await pages.b.mouse.move(zone.x, zone.y);
      await pages.b.mouse.down();
      const dx = zone.x - at.x;
      const dy = zone.y - at.y;
      for (let s = 1; s <= 24; s++) {
        const t = (s / 24) * (50 * Math.PI) / 180;
        await pages.b.mouse.move(at.x + dx * Math.cos(t) - dy * Math.sin(t), at.y + dx * Math.sin(t) + dy * Math.cos(t));
        await sleep(16);
      }
      await sleep(150);
      await pages.b.mouse.up();
    });
    followed("rotate", b, { moved: 10 });
    const rot = await pages.b.evaluate(() => window.probe.model("r").rot);
    const last = b[b.length - 1].ghostTransform ?? "";
    check(Math.abs(rot - 30) > 20 && new RegExp(`rotate\\(${rot}deg\\)`).test(last), `rotate: the landed outline carries the new turn (${rot}°)`, `transform ${last}`);
    log.rotate = b;
  }

  console.log("\n— group: A has child `c1` selected, B drags the group by `c2`");
  {
    await select(pages.a, ["c1"]);
    await settled(pages.b, "c1");
    const from = await point(pages.b, "c2");
    const { b } = await recording(pages, "c1", () => drag(pages.b, from, offset(from, 0, 80)));
    // B's own frame is on the group it is dragging, not on `c1`.
    followed("group", b, { own: false });
    log.group = b;
  }

  console.log("\n— duplicate: A has `b` selected, B alt-drags a copy off it");
  {
    await select(pages.a, ["b"]);
    await settled(pages.b, "b");
    const before = await pages.b.evaluate(() => window.probe.count());
    const from = await point(pages.b, "b");
    const { b } = await recording(pages, "b", () => drag(pages.b, from, offset(from, 200, 0), { keys: ["Alt"] }));
    const start = b[0].shape;
    check(b.some((r) => r.shape.x > start.x + 100), "duplicate: the preview carried the copy away");
    const off = b.filter((r) => !near(r.ghosts[0], start));
    check(off.length === 0, "duplicate: A's outline stays on the original, which is not moving", `${off.length} frame(s) off; first: ${off[0] && fmt(off[0].ghosts[0])}`);
    const after = await pages.b.evaluate(() => window.probe.count());
    check(after === before + 1 && near(b[b.length - 1].shape, start), "duplicate: a copy landed and the original is where it was");
    log.duplicate = b;
  }

  console.log("\n— escape: A has `b` selected, B drags it and presses Escape");
  {
    await select(pages.a, ["b"]);
    await settled(pages.b, "b");
    const from = await point(pages.b, "b");
    const { b } = await recording(pages, "b", () =>
      drag(pages.b, from, offset(from, 0, 120), { before: () => pages.b.keyboard.press("Escape") }));
    followed("escape", b);
    check(near(b[b.length - 1].shape, b[0].shape), "escape: the shape went back where it started");
    log.escape = b;
  }

  console.log("\n— nudge: A has `a` selected, B nudges it with Shift+→");
  {
    await select(pages.a, ["a"]);
    await settled(pages.b, "a");
    const at = await point(pages.b, "a");
    await pages.b.mouse.click(at.x, at.y);
    await sleep(100);
    const { b } = await recording(pages, "a", async () => {
      for (let i = 0; i < 6; i++) {
        await pages.b.keyboard.press("Shift+ArrowRight");
        await sleep(60);
      }
    });
    followed("nudge", b);
    log.nudge = b;
  }

  console.log("\n— connector: A has `e1` selected, B drags the shape it leaves from");
  {
    await select(pages.a, [], ["e1"]);
    await settled(pages.b, null);
    await pages.b.waitForFunction(() => window.probe.halos() === 1);
    const from = await point(pages.b, "a");
    const { b } = await recording(pages, "a", () => drag(pages.b, from, offset(from, 0, -100)));
    const moved = new Set(b.map((r) => r.edge)).size;
    check(moved > 10, `connector: the connector re-routed through the drag (${moved} routes)`);
    const off = b.filter((r) => r.halo !== r.edge);
    check(off.length === 0, `connector: A's halo follows the connector on every frame (${b.length} frames)`, `${off.length} frame(s) off`);
    log.connector = b;
  }
} catch (error) {
  failures.push(`the run threw: ${error?.stack ?? error}`);
  console.log(`  FAIL  the run threw: ${error?.stack ?? error}`);
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
  server.close();
}

if (errors.length) {
  console.log(`\npage errors:\n  ${errors.join("\n  ")}`);
  failures.push("page errors");
}
if (failures.length) {
  await mkdir(artifacts, { recursive: true });
  await writeFile(path.join(artifacts, "frames.json"), JSON.stringify(log, null, 1));
  console.error(`\n${failures.length} check(s) failed — frames in ${path.relative(repo, artifacts)}/frames.json`);
  process.exitCode = 1;
} else {
  console.log("\nall canvas presence checks passed");
}
