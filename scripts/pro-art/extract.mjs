import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

/**
 * The team illustration as data, for the Heron scene to rebuild and rig.
 *
 * Run `node scripts/pro-art/extract.mjs` after the source art changes; it
 * rewrites `art.json` from `team-doc.source.svg`, which is the illustration
 * exactly as drawn and is never edited by hand.
 *
 * Heron's own importer refuses stylesheets and `<defs>`, so this does the
 * intake it cannot: class rules become plain presentation attributes, the
 * masks, clip and gradients become definitions the scene re-declares through
 * Heron, and the document's glyph outlines are split — the header into words,
 * everything else into lines — each with its measured box, since a word only
 * knows where it is once a browser has laid it out. Nothing is redrawn.
 */

const SOURCE = new URL("./team-doc.source.svg", import.meta.url);
const OUT = new URL("./art.json", import.meta.url);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(
  `<body style="margin:0">${readFileSync(SOURCE, "utf8").replace(/<\?xml[^>]*>\s*/, "")}</body>`,
);

const art = await page.evaluate(() => {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.querySelector("svg");
  const round = (v) => Math.round(v * 100) / 100;

  // Class rules as attribute maps, merged in stylesheet order.
  const rules = new Map();
  const sheet = svg.querySelector("style").sheet;
  for (const rule of sheet.cssRules) {
    for (const sel of rule.selectorText.split(",")) {
      const cls = sel.trim().replace(/^\./, "");
      const decl = rules.get(cls) ?? {};
      for (const prop of rule.style) decl[prop] = rule.style.getPropertyValue(prop).trim();
      rules.set(cls, decl);
    }
  }
  const styled = (el) => {
    const out = {};
    for (const cls of (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean)) {
      Object.assign(out, rules.get(cls) ?? {});
    }
    return out;
  };
  const urlId = (v) => v?.match(/url\(["']?#([^"')]+)/)?.[1];

  const SKIP = new Set(["class", "id", "data-name"]);
  const PAINT = ["fill", "stroke", "stroke-width", "stroke-miterlimit", "stroke-linecap",
    "stroke-linejoin", "fill-rule", "opacity", "stroke-opacity", "fill-opacity"];
  function shapeAttrs(el) {
    const a = {};
    for (const { name, value } of el.attributes) if (!SKIP.has(name)) a[name] = value;
    const css = styled(el);
    for (const p of PAINT) if (css[p] !== undefined && a[p] === undefined) a[p] = css[p];
    if (a["stroke-width"]) a["stroke-width"] = a["stroke-width"].replace(/px$/, "");
    for (const k of ["fill", "stroke"]) {
      const id = urlId(a[k]);
      if (id) a[k] = `url(#${id})`;
      // Computed colours come back as rgb(); keep them, they are exact.
    }
    return a;
  }
  const box = (el) => {
    const b = el.getBBox();
    return [round(b.x), round(b.y), round(b.x + b.width), round(b.y + b.height)];
  };

  // ---- Definitions ------------------------------------------------------------

  const defs = { masks: [], clips: [], gradients: [] };
  const shapesIn = (el) =>
    [...el.querySelectorAll("path,rect,ellipse,circle,polygon,polyline,line")].map((s) => ({
      tag: s.tagName,
      a: shapeAttrs(s),
    }));
  for (const m of svg.querySelectorAll("defs > mask")) {
    defs.masks.push({
      id: m.id,
      units: m.getAttribute("maskUnits") ?? "objectBoundingBox",
      region: ["x", "y", "width", "height"].map((k) => Number(m.getAttribute(k))),
      shapes: shapesIn(m),
    });
  }
  for (const c of svg.querySelectorAll("defs > clipPath")) {
    defs.clips.push({ id: c.id, shapes: shapesIn(c) });
  }
  for (const g of svg.querySelectorAll("defs > linearGradient")) {
    defs.gradients.push({
      id: g.id,
      x1: Number(g.getAttribute("x1")),
      y1: Number(g.getAttribute("y1")),
      x2: Number(g.getAttribute("x2")),
      y2: Number(g.getAttribute("y2")),
      units: g.getAttribute("gradientUnits") ?? "objectBoundingBox",
      transform: g.getAttribute("gradientTransform") ?? undefined,
      stops: [...g.querySelectorAll("stop")].map((s) => ({
        at: Number(s.getAttribute("offset")),
        color: s.getAttribute("stop-color"),
        opacity: s.hasAttribute("stop-opacity") ? Number(s.getAttribute("stop-opacity")) : undefined,
      })),
    });
  }

  // ---- Glyph splitting -----------------------------------------------------------

  const measure = (d, host) => {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    host.appendChild(p);
    const b = p.getBBox();
    p.remove();
    return { x: b.x, y: b.y, r: b.x + b.width, b: b.y + b.height, h: b.height };
  };
  const subpaths = (el) =>
    el.getAttribute("d").split(/(?=M)/).filter((s) => s.trim())
      .map((d) => ({ d, ...measure(d, el.parentNode) }));
  function rows(parts) {
    const out = [];
    for (const p of [...parts].sort((a, b) => a.y - b.y)) {
      const row = out[out.length - 1];
      if (row && p.y < row.b - Math.min(row.b - row.y, p.h) * 0.3) {
        row.parts.push(p);
        row.b = Math.max(row.b, p.b);
      } else out.push({ y: p.y, b: p.b, parts: [p] });
    }
    return out;
  }
  function words(row) {
    const h = row.b - row.y;
    const out = [];
    for (const p of [...row.parts].sort((a, b) => a.x - b.x)) {
      const w = out[out.length - 1];
      if (w && p.x - w.r < h * 0.3) {
        w.parts.push(p);
        w.r = Math.max(w.r, p.r);
      } else out.push({ r: p.r, parts: [p] });
    }
    return out;
  }
  /** A glyph run: an unclassed or plainly filled path of many outlines. */
  const isGlyphs = (el) =>
    el.tagName === "path" &&
    el.getAttribute("d").split("M").length > 3 &&
    !el.hasAttribute("transform") &&
    !/cls-(8|18|28|33)\b/.test(el.getAttribute("class") ?? "");
  const split = (el, byWords) => {
    const chunks = rows(subpaths(el)).flatMap((r) => (byWords ? words(r) : [r]));
    const base = shapeAttrs(el);
    return chunks.map((c) => {
      const d = c.parts.map((p) => p.d).join("");
      const m = measure(d, el.parentNode);
      return { t: "s", tag: "path", a: { ...base, d }, bb: [m.x, m.y, m.r, m.b].map(round), text: true };
    });
  };

  // ---- The tree -----------------------------------------------------------------

  const WORDS = new Set(["Section_Header", "Section_User_Flow"]);
  function node(el, byWords) {
    const tag = el.tagName;
    if (tag === "g") {
      const css = styled(el);
      const g = { t: "g", c: [] };
      if (el.id) g.id = el.id;
      // The stylesheet's `mask` shorthand is expanded by the CSSOM.
      const mask = urlId(css["mask-image"] ?? css.mask ?? el.getAttribute("mask"));
      const clip = urlId(css["clip-path"] ?? el.getAttribute("clip-path"));
      if (mask) g.mask = mask;
      if (clip) g.clip = clip;
      const words = byWords || WORDS.has(el.id);
      for (const c of el.children) {
        if (isGlyphs(c) && el.closest("#Document_Card")) g.c.push(...split(c, words));
        else g.c.push(node(c, words));
      }
      return g;
    }
    return { t: "s", tag, a: shapeAttrs(el), bb: box(el) };
  }

  const tree = [...svg.children].filter((c) => c.tagName !== "defs").map((c) => node(c, false));
  return {
    viewBox: svg.getAttribute("viewBox").split(/[ ,]+/).map(Number),
    defs,
    tree,
  };
});

await browser.close();
writeFileSync(OUT, JSON.stringify(art));
const count = (n) => (n.t === "g" ? n.c.reduce((s, c) => s + count(c), 0) : 1);
console.log(
  `wrote ${OUT.pathname}: ${art.tree.reduce((s, n) => s + count(n), 0)} shapes, ` +
    `${art.defs.masks.length} masks, ${art.defs.clips.length} clips, ${art.defs.gradients.length} gradients`,
);
