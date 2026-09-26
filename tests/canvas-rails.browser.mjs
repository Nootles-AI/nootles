/**
 * The shell's rails as a diagram takes them, in the REAL workspace
 * (`canvas-rails.browser.tsx`) over a stand-in Convex:
 *
 * - a rail that is out turns its face over to the diagram's panel in place,
 *   and the document column keeps its width;
 * - a rail that is put away stays away: the panel floats over the page where
 *   the rail would stand, and the column keeps its width;
 * - a press on the diagram's empty canvas chooses the diagram itself — the
 *   panels come up with no shape selected, the Design panel shows the
 *   diagram's own fields, and a background set there paints the band;
 * - a press inside a floating panel is the diagram's chrome, and a press
 *   outside every band and panel lets the diagram go.
 *
 * Screenshots land in tests/.artifacts/canvas-rails/. No app server, no
 * Convex, no API keys: every off-origin request fails the
 * run, the ambient AI lanes are aborted in the tab, and the WebSocket is inert.
 * Nothing is typed into the document.
 *
 *   node tests/canvas-rails.browser.mjs
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bundleSurfaces, serveBundle, ledger, guardedTab, wait, waitFor } from "./comments-surfaces.shared.mjs";
import { launch, repo } from "./canvas-harness.mjs";

for (const key of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "MISTRAL_API_KEY", "RECRAFT_API_KEY"]) {
  delete process.env[key];
}

const shots = path.join(repo, "tests", ".artifacts", "canvas-rails");
await mkdir(shots, { recursive: true });

const output = await mkdtemp(path.join(tmpdir(), "canvas-rails-"));
await bundleSurfaces("tests/canvas-rails.browser.tsx", output, { probe: false });
const { origin, server } = await serveBundle(output);
const { failures, check, finish } = ledger();

/** Longer than a rail's turn (360ms on the spring) and a float's slide. */
const SETTLE = 600;
const centre = (box) => [box.left + box.width / 2, box.top + box.height / 2];

let browser;
try {
  ({ browser } = await launch());

  /** A fresh workspace with the rails as a person last left them. */
  async function open(label, { leftOpen, rightOpen }) {
    const tab = await guardedTab(browser, {
      origin,
      inert: true,
      label,
      failures,
      viewport: { width: 1440, height: 900 },
      setup: (context) =>
        context.addInitScript(
          ([l, r]) => {
            localStorage.setItem("nt:leftOpen", l ? "1" : "0");
            localStorage.setItem("nt:rightOpen", r ? "1" : "0");
          },
          [leftOpen, rightOpen],
        ),
    });
    const ready = await waitFor(tab.page, () => window.rails?.ready(), undefined, 15000);
    check(`[${label}] the diagram is on the page`, ready, true);
    await wait(SETTLE);
    const at = (fn, ...args) => tab.page.evaluate(({ fn, args }) => window.rails[fn](...args), { fn, args });
    return { ...tab, at };
  }

  // ---- Sidebar put away, chat out ------------------------------------------
  {
    const { page, at } = await open("left away", { leftOpen: false, rightOpen: true });
    const before = await at("column");
    check("[left away] the sidebar starts put away, the chat out", await at("sides"), {
      leftOpen: false,
      rightOpen: true,
      left: [],
      right: ["Chat"],
      floatLeft: null,
      floatRight: null,
    });

    await page.mouse.click(...centre(await at("shape")));
    await wait(SETTLE);
    check("[left away] a shape selected: layers float, the chat turns over to Design", await at("sides"), {
      leftOpen: false,
      rightOpen: true,
      left: [],
      right: ["Design"],
      floatLeft: "Layers",
      floatRight: null,
    });
    const float = await at("float", "left");
    check("[left away] the float stands where the rail would, at its width, held off the edges", {
      left: float.left,
      top: float.top,
      width: float.width,
      height: float.height,
      visible: float.visible,
    }, { left: 16, top: 16, width: 256, height: 900 - 32, visible: true });
    const card = await at("card");
    check("[left away] a thin band parts the float from the sheet's edge", {
      left: float.left - card.left >= 6,
      top: float.top - card.top >= 6,
      bottom: card.top + card.height - (float.top + float.height) >= 6,
    }, { left: true, top: true, bottom: true });
    check("[left away] the column keeps its width and place", await at("column"), before);

    // A press inside the float is the diagram's chrome, not a press outside it.
    await page.mouse.click(float.left + float.width / 2, float.top + float.height - 40);
    await wait(SETTLE);
    check("[left away] a press in the float keeps the panels", (await at("sides")).floatLeft, "Layers");

    // Empty canvas: the diagram itself.
    const band = await at("band");
    await page.mouse.click(band.left + band.width - 60, band.top + band.height - 30);
    await wait(SETTLE);
    const sides = await at("sides");
    check("[left away] a press on empty canvas keeps both panels up", [sides.floatLeft, sides.right], ["Layers", ["Design"]]);
    check("[left away] the band shows its edge and grid, chosen", await at("holding"), true);
    const design = await at("design");
    check("[left away] the Design panel speaks for the diagram itself", {
      head: design?.head,
      sections: design?.sections,
      background: !!design?.background,
    }, { head: "Canvas", sections: ["Diagram"], background: true });

    // A background set there paints the band. The hex is typed into the
    // panel's own field — never the document.
    await page.mouse.dblclick(...centre(design.background));
    const typing = await waitFor(page, () => document.activeElement?.getAttribute("aria-label") === "Hex colour");
    check("[left away] a double-click on Background types its hex", typing, true);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("dcecf5");
    await page.keyboard.press("Enter");
    await wait(200);
    check("[left away] the background paints the band", await at("paint"), "rgb(220, 236, 245)");
    check("[left away] a band's ground has no corner of its own", await at("corner"), "0px");

    // A painted ground can be rounded, by as much as the panel says.
    const radius = (await at("design"))?.radius;
    check("[left away] with a background, the panel offers a corner radius", !!radius, true);
    await page.mouse.click(...centre(radius));
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("12");
    await page.keyboard.press("Enter");
    await wait(200);
    check("[left away] and the band's ground takes it", await at("corner"), "12px");
    check("[left away] and the panels stay with the diagram", (await at("sides")).floatLeft, "Layers");
    check("[left away] the column still has not moved", await at("column"), before);

    // Out past every band and panel — the page's own margin, clear of the
    // float and the bar: the diagram is let go.
    const column = await at("column");
    await page.mouse.click(column.left + column.width - 60, column.top + column.height * 0.7);
    await wait(SETTLE);
    check("[left away] a press outside lets the diagram go", await at("sides"), {
      leftOpen: false,
      rightOpen: true,
      left: [],
      right: ["Chat"],
      floatLeft: null,
      floatRight: null,
    });
    check("[left away] and the band its edge", await at("holding"), false);
    await page.context().close();
  }

  // ---- Sidebar out ----------------------------------------------------------
  {
    const { page, at } = await open("left out", { leftOpen: true, rightOpen: true });
    const before = await at("column");
    await page.mouse.click(...centre(await at("shape")));
    await wait(SETTLE);
    check("[left out] both rails turn over in place, nothing floats", await at("sides"), {
      leftOpen: true,
      rightOpen: true,
      left: ["Layers"],
      right: ["Design"],
      floatLeft: null,
      floatRight: null,
    });
    check("[left out] the column keeps its width and place", await at("column"), before);
    await page.screenshot({ path: path.join(shots, "turned-over.png") });
    await page.context().close();
  }

  // ---- Both put away --------------------------------------------------------
  {
    const { page, at } = await open("both away", { leftOpen: false, rightOpen: false });
    const before = await at("column");
    const band = await at("band");
    await page.mouse.click(band.left + band.width - 60, band.top + band.height - 30);
    await wait(SETTLE);
    check("[both away] empty canvas floats both panels, and neither rail comes out", await at("sides"), {
      leftOpen: false,
      rightOpen: false,
      left: [],
      right: [],
      floatLeft: "Layers",
      floatRight: "Design",
    });
    const right = await at("float", "right");
    check("[both away] the Design float stands at the chat's width on the right", {
      right: 1440 - (right.left + right.width),
      width: right.width,
      visible: right.visible,
    }, { right: 16, width: 320, visible: true });
    const card = await at("card");
    check("[both away] a thin band parts the right float from the sheet's edge", {
      right: card.left + card.width - (right.left + right.width) >= 6,
      top: right.top - card.top >= 6,
      bottom: card.top + card.height - (right.top + right.height) >= 6,
    }, { right: true, top: true, bottom: true });
    check("[both away] the column keeps its width and place", await at("column"), before);
    await page.screenshot({ path: path.join(shots, "both-floating.png") });

    // Escape with nothing selected: the diagram becomes a block of the page,
    // and the panels go with it.
    await page.keyboard.press("Escape");
    await wait(SETTLE);
    const sides = await at("sides");
    check("[both away] Escape past the selection lets the diagram go", [sides.floatLeft, sides.floatRight], [null, null]);
    await page.context().close();
  }
} catch (error) {
  failures.push(`harness threw: ${error?.stack ?? error}`);
  console.error(error);
} finally {
  await browser?.close();
  server.close();
}
finish();
