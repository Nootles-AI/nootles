import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

/**
 * The six teammates as data, for the Heron scene to rebuild and rig.
 *
 * Run `node scripts/team-join-art/extract.mjs` after the source art changes;
 * it rewrites `art.json` from `source/chars_*.svg`, the characters exactly as
 * drawn, never edited by hand.
 *
 * Heron's importer refuses `<defs>`, so this does the intake it cannot: each
 * character's masks and gradients become definitions the scene re-declares
 * through Heron (renamed per character, since every file calls its first mask
 * `mask`), a gradient that borrows another's stops through `href` gets them
 * written out, and every group and shape carries its measured box, so the
 * scene can find joints without retyping coordinates. The one raster in the
 * set — a blurred shadow under the navigator's hand — is kept as a box only;
 * the scene paints it as a soft radial fill.
 */

const CHARS = ["pm", "design", "dev", "marketing", "stats", "customerSuccess"];
const OUT = new URL("./art.json", import.meta.url);

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
const art = {};
for (const key of CHARS) {
  const src = readFileSync(new URL(`./source/chars_${key}.svg`, import.meta.url), "utf8");
  await page.setContent(`<body style="margin:0">${src.replace(/<\?xml[^>]*>\s*/, "")}</body>`);
  art[key] = await page.evaluate((key) => {
    const svg = document.querySelector("svg");
    const round = (v) => Math.round(v * 100) / 100;
    const rename = (id) => `${key}-${id}`;
    const urlId = (v) => v?.match(/url\(["']?#([^"')]+)/)?.[1];
    const SKIP = new Set(["class", "id", "data-name", "isolation"]);
    const attrs = (el) => {
      const a = {};
      for (const { name, value } of el.attributes) {
        if (SKIP.has(name) || name === "mask" || name === "clip-path") continue;
        const id = urlId(value);
        a[name] = id ? `url(#${rename(id)})` : value;
      }
      return a;
    };
    const box = (el) => {
      const b = el.getBBox();
      return [round(b.x), round(b.y), round(b.x + b.width), round(b.y + b.height)];
    };
    const SHAPES = "path,rect,ellipse,circle,polygon,polyline,line";
    const defs = { masks: [], gradients: [] };
    for (const m of svg.querySelectorAll("defs > mask")) {
      defs.masks.push({
        id: rename(m.id),
        region: ["x", "y", "width", "height"].map((k) => Number(m.getAttribute(k))),
        shapes: [...m.querySelectorAll(SHAPES)].map((s) => ({ tag: s.tagName, a: attrs(s) })),
      });
    }
    for (const g of svg.querySelectorAll("defs > linearGradient")) {
      const href = g.getAttribute("xlink:href") ?? g.getAttribute("href");
      const from = href ? svg.querySelector(href) : null;
      const stopsOf = g.querySelectorAll("stop").length ? g : from;
      const pick = (k, d) => g.getAttribute(k) ?? from?.getAttribute(k) ?? d;
      defs.gradients.push({
        id: rename(g.id),
        x1: Number(pick("x1", 0)), y1: Number(pick("y1", 0)), x2: Number(pick("x2", 1)), y2: Number(pick("y2", 0)),
        units: pick("gradientUnits", "objectBoundingBox"),
        transform: pick("gradientTransform", undefined) ?? undefined,
        stops: [...stopsOf.querySelectorAll("stop")].map((s) => ({
          at: Number(s.getAttribute("offset")),
          color: s.getAttribute("stop-color"),
          opacity: s.hasAttribute("stop-opacity") ? Number(s.getAttribute("stop-opacity")) : undefined,
        })),
      });
    }
    const node = (el) => {
      const mask = urlId(el.getAttribute("mask"));
      if (el.tagName === "g") {
        const g = { t: "g", c: [...el.children].map(node), bb: box(el) };
        if (el.id) g.id = el.id;
        if (mask) g.mask = rename(mask);
        return g;
      }
      const s = { t: "s", tag: el.tagName, a: attrs(el), bb: box(el) };
      if (el.id) s.id = el.id;
      if (el.tagName === "image") s.a = {};
      return s;
    };
    return {
      viewBox: svg.getAttribute("viewBox").split(/[ ,]+/).map(Number),
      defs,
      tree: [...svg.children].filter((c) => c.tagName !== "defs").map(node),
    };
  }, key);
}
await browser.close();
writeFileSync(OUT, JSON.stringify(art));
console.log(`wrote ${OUT.pathname}: ${Object.keys(art).length} characters`);
