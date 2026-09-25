/**
 * Two people on one shared diagram, driven through real Chromium mouse and
 * keyboard input, one browser each.
 *
 * NT-30: a diagram's block prop is a MIRROR of its CRDT maps, written by each
 * client on a trailing 5s cadence. A client that sees a prop change it did not
 * write has to tell a collaborator's lagging mirror (ignore it) from an outside
 * author (diff it into the maps). It told them apart by looking the HTML up in
 * a window of states its own maps had been in — and a mirror flushed while
 * someone else was also editing describes a state no other replica was ever
 * in, so it read as an outside author and was diffed back into everyone's
 * maps, taking back what had changed since it was flushed. Separately, the
 * mirror written was the flush that asked for it, five seconds old, so two
 * people editing in turn left the block without the second person's edit.
 *
 * Each person is their own browser — their own Y.Doc, BlockNote editor, canvas
 * block, scene store and binding. The two docs exchange updates through this
 * script on YConvexProvider's cadence (leading edge after quiet, a 500ms
 * trailing throttle, merged updates), with a network latency added in between;
 * a direction can also be held back, as a slow round trip holds it.
 *
 * Uses the existing esbuild dependency and an operator-installed Puppeteer. No
 * app server, no Convex, no API keys — and every non-local request fails the
 * run, so no AI lane can be spent in here.
 *
 *   NML_PUPPETEER_MODULE=/absolute/path/to/puppeteer/lib/esm/puppeteer/puppeteer.js \
 *     node tests/canvas-collab-mirror.browser.mjs
 *
 * `NT30_REPO_A` / `NT30_REPO_B` build either person's page from another
 * checkout (the fixture file is copied in), for a clean before/after or a
 * mixed deploy.
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "canvas-collab-mirror-"));
const { default: puppeteer } = await import(process.env.NML_PUPPETEER_MODULE || "puppeteer");

const ENTRY = "tests/canvas-collab-mirror.browser.tsx";
const roots = { a: path.resolve(process.env.NT30_REPO_A || repo), b: path.resolve(process.env.NT30_REPO_B || repo) };

async function bundle(root, dir) {
  if (root !== repo) await copyFile(path.join(repo, ENTRY), path.join(root, ENTRY));
  await mkdir(dir, { recursive: true });
  await build({
    absWorkingDir: root, entryPoints: [ENTRY], bundle: true, splitting: true,
    format: "esm", outdir: dir, platform: "browser", conditions: ["browser", "import", "style"],
    tsconfig: "tsconfig.json",
    define: { "process.env.NODE_ENV": '"development"' },
    banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
    plugins: [{ name: "fixture", setup(builder) {
      builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({ path: "server-only", namespace: "fixture" }));
      builder.onLoad({ filter: /^server-only$/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };' }));
    } }],
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
  });
  // Tailwind is not in the bundle; the canvas block's wrapper leans on two of its
  // utilities, without which a diagram lays out zero pixels wide.
  await writeFile(path.join(dir, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="canvas-collab-mirror.browser.css"><style>html,body{margin:0;height:100%;overflow:hidden;font-family:Arial,sans-serif}.relative{position:relative}.w-full{width:100%}</style></head><body><div id="app"></div><script type="module" src="canvas-collab-mirror.browser.js"></script></body></html>`);
}
await bundle(roots.a, path.join(output, "a"));
await bundle(roots.b, path.join(output, "b"));
console.log(roots.a === roots.b ? `both people: ${roots.a}` : `person A: ${roots.a}\nperson B: ${roots.b}`);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") { response.writeHead(204); return void response.end(); }
    const [, person, ...rest] = pathname.split("/");
    const name = rest.join("/") ? path.basename(rest.join("/")) : "index.html";
    const data = await readFile(path.join(output, person, name));
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream");
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return void console.log(`  ok   ${name}`);
  failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
  console.log(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const VIEWPORT = { width: 1100, height: 760 };
/** What a Convex round trip costs between one person's append and the other's pull. */
let latency = 250;
/** Past the mirror's 5s trail, its 500ms flush and the relay. */
const SETTLE = 7000;

const browsers = [];
try {
  const people = {};
  for (const role of ["a", "b"]) {
    // Two people are two browsers. A background tab runs no animation frames,
    // and a drag moves its shapes in one — a second tab could never move anything.
    const browser = await puppeteer.launch({ headless: true, ...(process.env.NML_CHROME_PATH ? { executablePath: process.env.NML_CHROME_PATH } : {}) });
    browsers.push(browser);
    const page = (await browser.pages())[0] ?? (await browser.newPage());
    await page.setViewport(VIEWPORT);
    const label = role.toUpperCase();
    page.on("pageerror", (error) => failures.push(`${label} page error: ${error.message}`));
    page.on("error", (error) => console.log(`${label} crashed: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() !== "error" && message.type() !== "warning") return;
      failures.push(`${label} console ${message.type()}: ${message.text()}`);
    });
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.url().startsWith(origin) || request.url().startsWith("data:")) return void request.continue();
      failures.push(`${label} request left the fixture: ${request.url()}`);
      return void request.abort();
    });
    await page.evaluateOnNewDocument(() => {
      // The canvas block's Convex hooks connect over a socket; this one never opens.
      window.WebSocket = class extends EventTarget {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
        readyState = 0;
        send() { throw new Error("Fixture socket must never send"); }
        close() { this.readyState = 3; }
      };
    });
    people[role] = page;
  }

  // The network: FIFO per direction, every flush delayed by the same latency,
  // and a direction held back entirely while `held[from]` stands.
  const lanes = { a: Promise.resolve(), b: Promise.resolve() };
  const held = { a: null, b: null };
  const holdFrom = (role) => {
    let release;
    held[role] = { gate: new Promise((resolve) => (release = resolve)), release };
  };
  const releaseFrom = (role) => {
    held[role]?.release();
    held[role] = null;
  };
  for (const role of ["a", "b"]) {
    const other = role === "a" ? "b" : "a";
    await people[role].exposeFunction("relayOut", (update) => {
      const sent = Date.now();
      const gate = held[role]?.gate;
      lanes[role] = lanes[role].then(async () => {
        if (gate) await gate;
        const wait = sent + latency - Date.now();
        if (wait > 0) await sleep(wait);
        await people[other].evaluate((u) => window.collab.receive(u), update).catch(() => {});
      });
    });
  }

  const h = (role, fn, ...args) => people[role].evaluate(fn, ...args);
  const read = (role) => h(role, () => window.collab.read());

  const fresh = async () => {
    releaseFrom("a");
    releaseFrom("b");
    for (const role of ["a", "b"]) await people[role].goto(`${origin}/${role}/`, { waitUntil: "networkidle0" });
    const state = await h("a", () => window.collab.create());
    await h("b", (s) => window.collab.join(s), state);
    for (const role of ["a", "b"]) {
      await people[role].waitForFunction(() => window.collab.shapePoint("a") !== null && window.collab.shapePoint("b") !== null);
    }
    await sleep(400);
  };

  /** A shape dragged across the diagram by the pointer, the way a person moves one; resolves at the release. */
  const dragShape = async (role, id, dx, dy) => {
    const page = people[role];
    const from = await h(role, (i) => window.collab.shapePoint(i), id);
    if (!from) throw new Error(`${role}: no shape ${id} on the surface`);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step++) {
      await page.mouse.move(from.x + (dx * step) / 8, from.y + (dy * step) / 8);
      await sleep(16);
    }
    await page.mouse.up();
    return Date.now();
  };

  const both = async () => ({ A: await read("a"), B: await read("b") });
  /** The diagram's truth and what each person sees of it. */
  const seen = (r) => ({ maps: r.maps, shown: r.shown, drawn: r.drawn });
  const at = (list, id) => list.find((s) => s.startsWith(`${id}@`));
  const movedFrom = (before, after) => ["a", "b"].map((id) => at(after, id) !== at(before, id));

  /**
   * After two moves: both arrive; once every mirror has landed nothing has
   * moved back for either person; and a little later both block props say
   * what the maps say.
   */
  const settles = async (before) => {
    await sleep(1500);
    const live = await both();
    check("both moves arrive for both people", [seen(live.B), movedFrom(before.maps, live.A.maps)], [seen(live.A), [true, true]]);
    await sleep(SETTLE);
    const settled = await both();
    check("once the mirrors land, nothing has moved back for A", seen(settled.A), seen(live.A));
    check("…nor for B", seen(settled.B), seen(live.A));
    await sleep(SETTLE);
    const later = await both();
    check("both block props come to say what the maps say", [later.A.prop, later.B.prop], [live.A.maps, live.A.maps]);
    check("…and still nothing has moved back", [seen(later.A), seen(later.B)], [seen(live.A), seen(live.A)]);
  };

  console.log(`\nsanity: one person moves a shape, the other sees it`);
  latency = 250;
  await fresh();
  let before = await read("a");
  check("both people start on the same diagram", seen(await read("b")), seen(before));
  await dragShape("a", "a", 120, 0);
  await sleep(1500);
  const moved = await read("b");
  check("the move reaches the other person's maps, surface and pixels", seen(moved), seen(await read("a")));
  check("…and it is a move", movedFrom(before.maps, moved.maps), [true, false]);
  await sleep(SETTLE);
  const quiet = await both();
  check("once the mirrors land, nothing has moved back", seen(quiet.B), seen(moved));
  check("…and both block props say what the maps say", [quiet.A.prop, quiet.B.prop], [moved.maps, moved.maps]);

  console.log(`\nNT-30: two people move two shapes at the same moment, 400ms apart on the network`);
  latency = 400;
  await fresh();
  before = await read("a");
  {
    const [releasedB, releasedA] = await Promise.all([dragShape("b", "b", 0, 90), dragShape("a", "a", 140, 0)]);
    console.log(`  A let go ${releasedA - releasedB}ms after B`);
  }
  await settles(before);

  console.log(`\nNT-30: the same, with B's updates held back for a second`);
  latency = 250;
  await fresh();
  before = await read("a");
  holdFrom("b");
  await Promise.all([dragShape("b", "b", 0, 90), dragShape("a", "a", 140, 0)]);
  await sleep(1000);
  releaseFrom("b");
  await settles(before);

  console.log(`\nNT-30: two people move two shapes in turn, 2.5s apart`);
  latency = 250;
  await fresh();
  before = await read("a");
  await dragShape("b", "b", 0, 90);
  await sleep(2500);
  await dragShape("a", "a", 140, 0);
  await settles(before);

  console.log(`\nNT-30: A moves a shape, then drags the diagram below the next paragraph while B's move is on its way`);
  latency = 250;
  await fresh();
  before = await read("b");
  holdFrom("b");
  await Promise.all([dragShape("b", "b", 0, 90), dragShape("a", "a", 140, 0)]);
  await sleep(900); // A's flush has asked for a mirror; B's move has not reached A
  const withBoth = await read("b");
  check("B has both moves", movedFrom(before.maps, withBoth.maps), [true, true]);
  await h("a", () => window.collab.calls());
  await h("a", () => window.collab.moveDiagram());
  await sleep(300);
  console.log(`  A's binding as the moved block's old view went away: ${JSON.stringify(await h("a", () => window.collab.calls()))}`);
  releaseFrom("b");
  await sleep(800);
  // The move remounts the diagram on both screens, so both views' last mirrors are in play.
  const landed = await read("b");
  console.log(`  the prop B holds after the move: ${JSON.stringify(landed.prop)}, stamped: ${landed.stamped}`);
  check("the prop B holds after the move carries A's move, marked as a mirror", [at(landed.prop, "a"), landed.stamped], [at(withBoth.maps, "a"), true]);
  await sleep(SETTLE);
  const afterMove = await both();
  check("once it lands, nothing has moved back for B", seen(afterMove.B), seen(withBoth));
  check("…nor for A", seen(afterMove.A), seen(withBoth));

  console.log(`\nNT-30's own scenario: one person arrow-keys a shape for 5s without pausing, the other watches`);
  latency = 250;
  await fresh();
  before = await read("a");
  await dragShape("b", "b", 0, 40);
  await sleep(1200); // flushed: this is the mirror that trails the run
  await people.b.keyboard.down("Shift");
  const runStart = Date.now();
  let presses = 0;
  while (Date.now() - runStart < 5600) {
    await people.b.keyboard.press("ArrowRight");
    presses++;
    await sleep(80);
  }
  await people.b.keyboard.up("Shift");
  await sleep(1500);
  const nudged = await both();
  await sleep(SETTLE);
  const nudgedLater = await both();
  console.log(`  ${presses} presses; A's echo window held ${nudgedLater.A.window} states, B's ${nudgedLater.B.window}`);
  check("every press arrives for the watcher", seen(nudged.A), seen(nudged.B));
  check("…and moved the shape", movedFrom(before.maps, nudged.A.maps), [false, true]);
  check("once the trailing mirror lands, nothing has moved back", [seen(nudgedLater.A), seen(nudgedLater.B)], [seen(nudged.B), seen(nudged.B)]);
  check("…and both block props say what the maps say", [nudgedLater.A.prop, nudgedLater.B.prop], [nudged.B.maps, nudged.B.maps]);

  console.log(`\nan outside author — a whole-diagram write with no maps behind it — still lands for both`);
  latency = 250;
  await fresh();
  await sleep(SETTLE);
  await h("b", () => window.collab.outsideWrite());
  await sleep(2500);
  const outside = await both();
  check("B takes it into its maps and its surface", [outside.B.maps.some((s) => s.startsWith("c@")), outside.B.shown.some((s) => s.startsWith("c@"))], [true, true]);
  check("…and A gets it from them", seen(outside.A), seen(outside.B));
  await sleep(SETTLE);
  const outsideLater = await both();
  check("…and it stays", [seen(outsideLater.A), seen(outsideLater.B)], [seen(outside.B), seen(outside.B)]);
} finally {
  await Promise.all(browsers.map((browser) => browser.close()));
  server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} failure(s):\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("\nall checks passed");
}
