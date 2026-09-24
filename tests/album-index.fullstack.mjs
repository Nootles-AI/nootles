/**
 * What the agent is told about an album's pictures, against a REAL backend
 * (NT-32): a throwaway convex-local-backend with this repo's functions pushed
 * to it, the real `albumIndex` in Chromium decoding real pictures into the
 * real contact sheet, and only the captioning model stood in for.
 *
 * `imageMeta` keeps colour that was measured off a picture's pixels. A picture
 * the captioning pass described but nobody measured must say so — "colour
 * unmeasured", no colour columns, no `energy` — rather than read as measured
 * flat grey, and must get its colour the next time the album is read, without
 * a second captioning call. Three ways a picture ends up described but
 * unmeasured, each a person's album:
 *
 * - a picture with nothing opaque in it, which `statsFrom` refuses to measure;
 * - a colour write that did not land, which the reader swallows by design;
 * - a row an older build wrote for either, with invented grey in its columns.
 *
 * Nothing reaches a cloud deployment or a paid API (see fullstack-backend.mjs);
 * every browser request outside the fixture and the local backend fails the
 * run, and `/api/album/index` is answered here.
 *
 *   node tests/album-index.fullstack.mjs
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { anyApi } from "convex/server";
import { bundleSurfaces, serveBundle, ledger, guardedTab } from "./comments-surfaces.shared.mjs";
import { launchBrowser } from "./comments-launch.mjs";
import { startBackend } from "./fullstack-backend.mjs";

const OWNER = { userId: "user_album_owner", name: "Ada Album" };

/** A `w`×`h` RGBA PNG, every pixel `pixel(x, y)` → [r, g, b, a]. */
function png(w, h, pixel) {
  const rows = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    rows[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) rows.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PICTURES = {
  // Saturated and graded: plenty for statsFrom to measure.
  "sunset.png": png(64, 48, (x, y) => [230, 90 + x, 30 + y, 255]),
  // Nothing opaque at all — a cut-out with the subject missing, say.
  "ghost.png": png(64, 64, () => [0, 0, 0, 0]),
  // Deep blue, then deep green: colours a grey stand-in would contradict.
  "sea.png": png(48, 64, (x, y) => [10, 40 + (y >> 1), 190 + (x >> 1), 255]),
  "forest.png": png(64, 64, (x, y) => [20 + (x >> 2), 120 + (y >> 1), 30, 255]),
};

const album = (id, origin, names) => ({
  id,
  type: "album",
  props: { data: `<nt-album>${names.map((name) => `<img src="${origin}/${name}" w="4" h="3">`).join("")}</nt-album>` },
  content: [],
  children: [],
});

/** The index's line for a picture, found by its caption. */
const lineFor = (index, name) => index.split("\n").find((line) => line.includes(`"${name}`)) ?? null;
/** The colour clause of a line: everything between the handle/ratio and the rank. */
const colourIn = (line) => line?.match(/ (#[0-9a-f]{6} h\d+ s\d+ l\d+|colour unmeasured) /)?.[1] ?? null;
const HEX = /^#[0-9a-f]{6} h\d+ s\d+ l\d+$/;

let browser;
let bundleServer;
let deployment;
const work = await mkdtemp(path.join(tmpdir(), "album-index-"));
const { failures, check, finish } = ledger();

try {
  deployment = await startBackend({ name: "album-index-e2e" });
  const jwt = deployment.mint(OWNER.userId, OWNER.name);

  /** The stored rows, as the database holds them — not as `read` answers. */
  const stored = async () => {
    const { stdout } = await deployment.convex(["data", "imageMeta", "--format", "jsonLines", "--limit", "100"]);
    const rows = stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    return (name) => rows.find((row) => row.src.endsWith(`/${name}`)) ?? null;
  };
  const MEASURED = ["hex", "palette", "hue", "sat", "light", "energy"];
  const columns = (row) => MEASURED.filter((key) => row && key in row);

  const output = path.join(work, "bundle");
  await bundleSurfaces("tests/album-index.fullstack.tsx", output, { probe: false });
  for (const [name, bytes] of Object.entries(PICTURES)) await writeFile(path.join(output, name), bytes);
  // The page has no stylesheet of its own; an empty one keeps the load quiet.
  await writeFile(path.join(output, "album-index.fullstack.css"), "");
  const served = await serveBundle(output);
  bundleServer = served.server;
  const { origin } = served;

  browser = await launchBrowser();
  const { page } = await guardedTab(browser, {
    origin, allow: [deployment.url], label: "owner", failures,
    // The dry reads below refuse the captioning call on purpose.
    expected: /status of 503/,
  });
  // The captioning model: one caption per handle on the sheet, named for the
  // picture the handle stands for so a line can be found by what it shows.
  const sheets = [];
  let captions = new Map();
  await page.route(`${origin}/api/album/index`, async (route) => {
    const { handles } = route.request().postDataJSON();
    sheets.push(handles.map((handle) => captions.get(handle) ?? handle));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ described: handles.map((handle) => ({ handle, alt: `${captions.get(handle)} photo`, striking: 40 })) }),
    });
  });
  await page.goto(origin);
  await page.waitForSelector('#app[data-ready="true"]', { state: "attached" });
  await page.evaluate(([url, token]) => window.album.connect(url, token), [deployment.url, jwt]);

  const read = async (blocks, expand) => {
    const before = sheets.length;
    const index = await page.evaluate(([b, e]) => window.album.read(b, e), [blocks, expand]);
    return { index, sheets: sheets.slice(before) };
  };
  // Captions are keyed by handle, which the index prints first on each line;
  // map them after the fact from the line order the album reads in.
  const nameCaptions = (index, names) => {
    const lines = index.split("\n").filter((line) => !line.startsWith("<!--") && !line.startsWith("     "));
    lines.forEach((line, i) => captions.set(line.split(" ")[0], names[i]));
  };

  // ── 1. A picture with nothing to measure, beside one with plenty ──────────
  {
    console.log("\nan album with a picture statsFrom cannot measure");
    const names = ["sunset.png", "ghost.png"];
    const blocks = [album("album_a", origin, names)];
    // A dry read first, with the model refusing, only to learn the handles.
    captions = new Map();
    await page.route(`${origin}/api/album/index`, (route) => route.fulfill({ status: 503, body: "" }), { times: 1 });
    nameCaptions((await read(blocks, ["album_a"])).index, names);

    const first = await read(blocks, ["album_a"]);
    check("[unmeasurable] the model was asked about it", first.sheets.flat().includes("ghost.png"), true);
    check("[unmeasurable] its line says the colour was never measured", colourIn(lineFor(first.index, "ghost.png")), "colour unmeasured");
    check("[unmeasurable] the measured picture beside it keeps its colour", HEX.test(colourIn(lineFor(first.index, "sunset.png")) ?? ""), true);
    const rows = await stored();
    check("[unmeasurable] its stored row holds the caption", rows("ghost.png")?.alt, "ghost.png photo");
    check("[unmeasurable] …and no measured columns — energy included", columns(rows("ghost.png")), []);
    check("[unmeasurable] the measured picture's row has every column", columns(rows("sunset.png")), MEASURED);

    const again = await read(blocks, ["album_a"]);
    check("[unmeasurable] read again: no second captioning call", again.sheets.length, 0);
    check("[unmeasurable] read again: still says unmeasured", colourIn(lineFor(again.index, "ghost.png")), "colour unmeasured");
  }

  // ── 2. A colour write that did not land ───────────────────────────────────
  {
    console.log("\nan album whose colour write was dropped");
    const names = ["sea.png"];
    const blocks = [album("album_b", origin, names)];
    captions = new Map();
    await page.route(`${origin}/api/album/index`, (route) => route.fulfill({ status: 503, body: "" }), { times: 1 });
    await page.evaluate(() => window.album.dropColourWrites(1));
    nameCaptions((await read(blocks, ["album_b"])).index, names);

    await page.evaluate(() => window.album.dropColourWrites(1));
    const first = await read(blocks, ["album_b"]);
    check("[dropped] the model was asked about it", first.sheets.flat(), ["sea.png"]);
    const firstColour = colourIn(lineFor(first.index, "sea.png"));
    check("[dropped] this turn's line is not invented grey", firstColour === "#808080 h0 s0 l50", false);
    const rows = await stored();
    check("[dropped] its stored row holds the caption", rows("sea.png")?.alt, "sea.png photo");
    check("[dropped] …and no invented measurements", columns(rows("sea.png")), []);

    const again = await read(blocks, ["album_b"]);
    const colour = colourIn(lineFor(again.index, "sea.png"));
    check("[dropped] next read: no second captioning call", again.sheets.length, 0);
    check("[dropped] next read: the colour is measured now", HEX.test(colour ?? ""), true);
    check("[dropped] …and it is the picture's blue, not grey", Number(colour?.match(/ h(\d+)/)?.[1]) >= 200 && Number(colour?.match(/ h(\d+)/)?.[1]) <= 240, true);
    const healed = (await stored())("sea.png");
    check("[dropped] next read: the stored row has every column", columns(healed), MEASURED);
    check("[dropped] …and kept its caption", healed?.alt, "sea.png photo");
  }

  // ── 3. A row an older build wrote, invented grey and all ──────────────────
  {
    console.log("\nan album with a row an older build wrote");
    const names = ["forest.png"];
    const blocks = [album("album_c", origin, names)];
    const legacy = path.join(work, "legacy.jsonl");
    await writeFile(legacy, JSON.stringify({
      ownerId: OWNER.userId, src: `${origin}/forest.png`,
      hex: "#808080", palette: [], hue: 0, sat: 0, light: 50, energy: 0,
      alt: "forest.png photo", striking: 55, indexedAt: Date.now(), createdAt: Date.now(),
    }) + "\n");
    await deployment.convex(["import", "--table", "imageMeta", "--append", "-y", legacy]);

    const first = await read(blocks, ["album_c"]);
    const colour = colourIn(lineFor(first.index, "forest.png"));
    check("[legacy] no captioning call — it was described", first.sheets.length, 0);
    check("[legacy] its line is not the invented grey", colour === "#808080 h0 s0 l50", false);
    check("[legacy] …it is the picture's green, measured", Number(colour?.match(/ h(\d+)/)?.[1]) >= 90 && Number(colour?.match(/ h(\d+)/)?.[1]) <= 140, true);
    const healed = (await stored())("forest.png");
    check("[legacy] the stored row now holds a measured palette", (healed?.palette ?? []).length > 0, true);
    check("[legacy] …a measured energy", typeof healed?.energy === "number" && healed.energy > 0, true);
    check("[legacy] …and its caption and rank", [healed?.alt, healed?.striking], ["forest.png photo", 55]);
  }

  check("no request left the fixture or the local backend", deployment.outbound, []);
  // The owner's own `read`, as any signed-in caller gets it, never returns another's rows.
  check("a stranger reads none of these rows", (await deployment.client(deployment.mint("user_stranger", "S")).query(anyApi.imageMeta.read, { srcs: Object.keys(PICTURES).map((name) => `${origin}/${name}`) })).length, 0);
} catch (error) {
  failures.push(`harness error: ${error?.stack ?? error}`);
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  bundleServer?.close();
  await deployment?.close().catch(() => {});
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
finish();
