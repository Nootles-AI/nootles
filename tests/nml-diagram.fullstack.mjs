/**
 * A diagram on a served page, end to end (NT-129): a REAL Convex backend (a
 * throwaway convex-local-backend, tests/fullstack-backend.mjs), the REAL app
 * as its routes mount it (tests/comments-e2e.fullstack.tsx), and a real agent
 * edit through the MCP write action.
 *
 * On a served page the diagram is drawn on its `canvas:<id>` maps, and before
 * NT-129 nothing carried those edits into canonical NML: a fresh diagram
 * reached NML with what the slash menu gave it, every later move stayed out,
 * and each NML change wrote that stale scene back over the block's prop. An
 * agent reading the page saw an old diagram, and an agent writing to it
 * worked from one.
 *
 * Every person's step is a real click, drag or keystroke. What is asserted is
 * read off the screens and off the stored history, decoded three ways: the NML
 * scene, the maps, and the prop.
 *
 * Nothing reaches a cloud deployment or a paid API: the backend is local, its
 * outbound fetches are refused (and fail the run), the AI keys are unset, the
 * ambient AI lanes are aborted in the tab, and every other browser request
 * outside the bundle and the backend fails the run.
 *
 *   npm run test:nml:diagram
 *
 * Needs a convex-local-backend binary (see tests/fullstack-backend.mjs) and
 * system Chrome (`COMMENTS_BROWSER_CHANNEL=chromium` for Playwright's own).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { ConvexHttpClient } from "convex/browser";
import { anyApi, makeFunctionReference } from "convex/server";
import { bundleSurfaces, serveBundle, guardedTab, wait, ledger } from "./comments-surfaces.shared.mjs";
import { launchBrowser } from "./comments-launch.mjs";
import { startBackend } from "./fullstack-backend.mjs";
import { NAVIGATION } from "./comments-e2e.navigation.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { failures, check, finish } = ledger();
let deployment, browser, served, work;
const watchdog = setTimeout(() => {
  console.error("\nwatchdog: the run took longer than 8 minutes");
  process.exit(2);
}, 8 * 60_000);
watchdog.unref();

/** Poll `read` until `accept` holds or `timeout` passes; the last value either way. */
async function until(read, accept, timeout = 12_000) {
  const end = Date.now() + timeout;
  let value = await read();
  while (!accept(value) && Date.now() < end) {
    await wait(150);
    value = await read();
  }
  return value;
}

const USER = { userId: "user_draw", name: "Dee Draw" };
const SURFACE = '[data-nml-served="true"] .bn-editor';

try {
  work = await mkdtemp(path.join(tmpdir(), "nml-diagram-"));
  deployment = await startBackend({ name: "nml-diagram" });
  const jwt = deployment.mint(USER.userId, USER.name);
  const dee = deployment.client(jwt);
  const admin = new ConvexHttpClient(deployment.url);
  admin.setAdminAuth(deployment.adminKey);
  const run = (name, args = {}) => admin.mutation(makeFunctionReference(name), args);

  const seedFile = path.join(work, "seed.mjs");
  await build({
    absWorkingDir: repo, entryPoints: ["tests/nml-diagram.fullstack.seed.ts"], bundle: true, format: "esm", platform: "node",
    outfile: seedFile, tsconfig: "tsconfig.json", logLevel: "warning",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  const seed = await import(pathToFileURL(seedFile).href);

  // Serving on and the owner enrolled first, so the page is born on NML (NT-124).
  await run("nmlMigration:setNmlServe", { enabled: true });
  await run("nmlMigration:addInternalOwner", { subject: USER.userId, note: "e2e" });
  await run("mcp/oauth:setMcpEnabled", { enabled: true });
  await dee.mutation(anyApi.profiles.skip, {});
  await dee.action(anyApi.identity.sync, {});
  for (const id of ["chat", "slash", "write"]) await dee.mutation(anyApi.profiles.seen, { id });
  const projectId = await dee.mutation(anyApi.projects.create, { title: "Diagrams" });
  const [first] = await dee.query(anyApi.pages.listByProject, { projectId });
  const pageId = first._id;
  const { docId } = await dee.query(anyApi.pages.get, { pageId });

  /** The stored history, read as its owner reads it. */
  async function stored() {
    const meta = await dee.query(anyApi.ydoc.meta, { docId });
    const updates = [];
    if (meta.snapshotParts > 0) {
      const parts = [];
      for (let part = 0; part < meta.snapshotParts; part++) parts.push(await dee.query(anyApi.ydoc.snapshot, { docId, gen: meta.snapshotSeq, part }));
      updates.push(Buffer.concat(parts.map((p) => Buffer.from(p))).buffer);
    }
    let cursor = meta.snapshotSeq;
    for (;;) {
      const rows = await dee.query(anyApi.ydoc.updatesSince, { docId, afterSeq: cursor });
      if (!rows.length) break;
      for (const row of rows) { updates.push(row.update); cursor = Math.max(cursor, row.seq); }
    }
    return updates;
  }
  const saved = async () => Object.values(seed.diagrams(await stored()))[0] ?? { nml: "", maps: "", prop: "" };

  await bundleSurfaces("tests/comments-e2e.fullstack.tsx", path.join(work, "bundle"), { probe: false, fixtures: { navigation: NAVIGATION } });
  served = await serveBundle(path.join(work, "bundle"));
  browser = await launchBrowser();

  async function openTab(label) {
    const { page } = await guardedTab(browser, {
      origin: served.origin, allow: [deployment.url], label, failures, inert: false,
      viewport: { width: 1400, height: 900 },
      path: `/p/${projectId}?page=${pageId}`,
      setup: async (context, tab) => {
        context.setDefaultTimeout(20_000);
        await tab.addInitScript((cfg) => { window.__e2e = cfg; }, { url: deployment.url, jwt, identity: USER });
      },
    });
    await page.waitForSelector(SURFACE);
    page.label = label;
    return page;
  }
  const frames = (tab) => tab.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const glides = document.getAnimations().filter((a) => ["nt-band-glide", "nt-glide", "nt-arrive"].includes(a.id));
    await Promise.all(glides.map((a) => a.finished.catch(() => {})));
  });
  /** Each shape on a tab's diagram as `id@x,y:label`, in page px, read off the screen. */
  const onScreen = (tab) => tab.evaluate(() => {
    const band = document.querySelector(".nt-canvas-block");
    if (!band) return "";
    return [...band.querySelectorAll("[data-id]")].map((el) => {
        const box = el.getBoundingClientRect();
        return { id: el.getAttribute("data-id"), x: Math.round(box.x), y: Math.round(box.y), text: (el.textContent ?? "").trim() };
      });
  });
  const shapeAt = async (tab, id) => (await onScreen(tab)).find((shape) => shape.id === id);
  async function drag(tab, id, dx, dy) {
    const box = await tab.locator(`.nt-canvas-block [data-id="${id}"]`).first().boundingBox();
    const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await tab.mouse.move(from.x, from.y);
    await tab.mouse.down();
    await tab.mouse.move(from.x + dx, from.y + dy, { steps: 12 });
    await frames(tab);
    await tab.mouse.up();
    await frames(tab);
  }
  /**
   * Type at the end of the line reading `line`. The caret is put there the way
   * a click past its last glyph would: on a served page a click on an empty
   * line lands on its menu, and macOS has no End in a contenteditable.
   */
  async function typeAtEnd(tab, line, text) {
    const placed = await tab.evaluate((want) => {
      const view = document.querySelector('[data-nml-served="true"] .bn-editor');
      const target = [...document.querySelectorAll('[data-nml-served="true"] .bn-inline-content')]
        .find((el) => el.textContent === want);
      if (!view || !target) return false;
      view.focus();
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      let last = null;
      while (walker.nextNode()) last = walker.currentNode;
      if (last) document.getSelection().collapse(last, last.length);
      else document.getSelection().collapse(target, 0);
      return true;
    }, line);
    if (!placed) throw new Error(`no line reading "${line}"`);
    await frames(tab);
    await tab.keyboard.type(text, { delay: 25 });
  }
  /** NML and the maps hold the same diagram — and it is `want`, when given. */
  const inStep = (want) => until(saved, (d) => d.nml !== "" && d.nml === d.maps && (!want || want(d)));
  /** A drag lands within a few px of the pointer: the canvas snaps to guides. */
  const near = (from, to, dx, dy) => !!from && !!to && Math.abs(to[0] - from[0] - dx) <= 6 && Math.abs(to[1] - from[1] - dy) <= 6;
  const position = (outline, id) => {
    const match = new RegExp(`(?:^| )${id}@(-?\\d+),(-?\\d+):`).exec(outline);
    return match ? [Number(match[1]), Number(match[2])] : null;
  };

  // ── 1. A diagram drawn on a served page reaches NML whole ──────────────────
  console.log("\n1. A diagram from the slash menu, filled from a preset");
  const A = await openTab("A");
  await typeAtEnd(A, "", "Intro");
  await A.keyboard.press("Enter");
  await A.keyboard.type("/diagram", { delay: 25 });
  await A.waitForFunction(() => document.querySelector(".nt-slash-item[aria-selected=true] .nt-slash-title")?.textContent === "Diagram");
  await A.keyboard.press("Enter");
  await A.locator('.nt-canvas-preset[data-preset="flowchart"]').click();
  await A.waitForFunction(() => document.querySelectorAll(".nt-canvas-block [data-id]").length > 2);
  await frames(A);
  const shapes = (await onScreen(A)).map((shape) => shape.id);
  let state = await inStep((d) => shapes.every((id) => d.nml.includes(`${id}@`)));
  check("every preset shape is in NML, as in the maps", state.nml === state.maps && shapes.every((id) => state.nml.includes(`${id}@`)), true);

  // ── 2. Moves reach NML, and typing never writes a stale diagram back ───────
  console.log("\n2. Dragging shapes, typing between the drags");
  const [S, T] = shapes;
  const startS = position(state.nml, S);
  // The preset lands selected; a drag of one shape is a drag of one shape.
  await A.keyboard.press("Escape");
  await frames(A);
  await drag(A, S, 120, 40);
  state = await inStep((d) => position(d.nml, S)?.[0] !== startS[0]);
  const movedS = position(state.maps, S);
  check("the first move is in NML", position(state.nml, S), movedS);
  check("and is the drag: about +120,+40", near(startS, movedS, 120, 40), true);
  await typeAtEnd(A, "Intro", " text");
  const startT = position(state.nml, T);
  await drag(A, T, -60, 80);
  await typeAtEnd(A, "Intro text", " more");
  state = await inStep((d) => position(d.nml, T)?.[1] !== startT[1]);
  const movedT = position(state.maps, T);
  check("the second move is in NML too", [position(state.nml, T), near(startT, movedT, -60, 80)], [movedT, true]);
  check("the first is still where it was put", position(state.nml, S), movedS);
  // The prop is the binding's trailing mirror: it lands once the diagram is
  // let go, and it is the maps' diagram, never NML's written back.
  await A.keyboard.press("Escape");
  await typeAtEnd(A, "Intro text more", "");
  state = await until(saved, (d) => d.prop === d.maps, 15_000);
  check("the prop catches up with the maps", state.prop, state.maps);
  await typeAtEnd(A, "Intro text more", "!");
  await wait(1500);
  state = await saved();
  check("typing after it leaves the prop on the maps' diagram", state.prop, state.maps);
  const screenS = await shapeAt(A, S);

  // ── 3. A fresh client mounts the page as it was left ──────────────────────
  console.log("\n3. A second tab opens the page");
  const B = await openTab("B");
  await B.waitForFunction(() => document.querySelectorAll(".nt-canvas-block [data-id]").length > 2);
  await frames(B);
  check("B draws the moved shape where A does", await shapeAt(B, S), screenS);
  await wait(1500);
  state = await saved();
  check("the mount wrote nothing stale", [state.nml === state.maps, position(state.nml, S)], [true, movedS]);

  // ── 4. An agent edits the diagram over MCP ────────────────────────────────
  console.log("\n4. An agent moves and relabels a shape through the MCP write action");
  const now = Date.now();
  await admin.mutation(makeFunctionReference("_system/frontend/addDocument"), {
    table: "mcpGrants",
    documents: [{
      subject: USER.userId, clientId: "e2e-agent", clientName: "E2E agent", scope: "docs:read docs:write",
      accessHash: "e2e-access", accessExpiresAt: now + 3_600_000, refreshHash: "e2e-refresh",
      refreshExpiresAt: now + 3_600_000, createdAt: now,
    }],
  });
  const grantId = (await admin.query(makeFunctionReference("_system/cli/tableData"), {
    table: "mcpGrants", order: "asc", paginationOpts: { numItems: 10, cursor: null },
  })).page[0]._id;
  const blockId = Object.keys(seed.diagrams(await stored()))[0];
  const U = shapes[2];
  const startU = position(state.nml, U);
  const data = seed.agentDiagram(await stored(), blockId, U, 200, 0, "Agent moved");
  const edit = await admin.action(makeFunctionReference("mcp/edit:editDoc"), {
    subject: USER.userId, grantId, clientName: "E2E agent", ref: docId,
    operations: [{ kind: "updateBlockProps", blockId, props: { data } }],
  });
  check("the agent's edit applied", edit.status, "applied");
  state = await inStep((d) => position(d.maps, U)?.[0] === startU[0] + 200);
  check("the agent's move is in the maps, beside NML", [position(state.maps, U), state.nml === state.maps], [[startU[0] + 200, startU[1]], true]);
  check("the person's moves are untouched", [position(state.maps, S), position(state.maps, T)], [movedS, movedT]);
  for (const tab of [A, B]) {
    const shown = await until(() => shapeAt(tab, U), (shape) => shape?.text === "Agent moved");
    check(`${tab.label} shows the agent's label`, shown?.text, "Agent moved");
    check(`${tab.label} keeps the person's move`, await shapeAt(tab, S), screenS);
  }
  await wait(1500);
  state = await saved();
  check("no tab wrote the agent's edit back or over", [state.nml === state.maps, position(state.nml, U), position(state.nml, S)], [true, [startU[0] + 200, startU[1]], movedS]);

  // ── 5. The person moves the agent's shape; the agent can no longer undo ───
  console.log("\n5. The person moves what the agent moved; then the agent asks to undo");
  await A.bringToFront();
  await drag(A, U, 0, 60);
  state = await inStep((d) => position(d.nml, U)?.[1] > startU[1] + 30);
  check("the person's move of it is in NML", [position(state.nml, U), near([startU[0] + 200, startU[1]], position(state.maps, U), 0, 60)], [position(state.maps, U), true]);
  const undo = await admin.action(makeFunctionReference("mcp/edit:undoEdit"), { subject: USER.userId, editId: edit.editId, by: "agent", grantId });
  check("the agent's undo is refused, since the person changed it after", [undo.status, undo.reason], ["refused", "changed-since"]);

  // ── 6. An agent edit undone before anyone touches it ──────────────────────
  console.log("\n6. An agent edit, undone straight away");
  const before6 = await saved();
  const data6 = seed.agentDiagram(await stored(), blockId, T, 0, -50, "Briefly");
  const edit6 = await admin.action(makeFunctionReference("mcp/edit:editDoc"), {
    subject: USER.userId, grantId, clientName: "E2E agent", ref: docId,
    operations: [{ kind: "updateBlockProps", blockId, props: { data: data6 } }],
  });
  check("the second edit applied", edit6.status, "applied");
  await until(() => shapeAt(A, T), (shape) => shape?.text === "Briefly");
  const undo6 = await admin.action(makeFunctionReference("mcp/edit:undoEdit"), { subject: USER.userId, editId: edit6.editId, by: "agent", grantId });
  check("the agent's undo applied", undo6.status, "undone");
  state = await inStep((d) => d.maps === before6.maps);
  check("NML and the maps are back where they were", [state.nml, state.maps], [before6.nml, before6.maps]);
  for (const tab of [A, B]) {
    const shown = await until(() => shapeAt(tab, T), (shape) => shape && shape.text !== "Briefly");
    check(`${tab.label} shows the label back`, shown?.text === "Briefly", false);
  }

  check("no outbound fetch from the backend", deployment.outbound, []);
} catch (error) {
  failures.push(`run stopped: ${error.stack ?? error.message}`);
  console.log(`  FAIL run stopped: ${error.message}`);
} finally {
  await browser?.close().catch(() => {});
  served?.server.close();
  await deployment?.close();
  if (work) await rm(work, { recursive: true, force: true });
}
finish();
