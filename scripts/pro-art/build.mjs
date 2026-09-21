import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

/**
 * Builds the Pro picture: the team illustration, animated as the characters
 * building the document together.
 *
 * Run `node scripts/pro-art/build.mjs` after editing the choreography below;
 * it rewrites `public/pro/team-doc.svg` from `team-doc.source.svg`, which is
 * the illustration exactly as drawn and is never edited by hand.
 *
 * The drawing is flat paths, so the build does the rigging. It measures the
 * geometry in a headless browser (glyph outlines have no other way to say
 * where they are), then:
 *
 *  - groups each character's limbs, antennae and eyes so they can move about
 *    their joints, keeping the paint order the artist drew;
 *  - splits the document's glyph outlines into words (header, flowchart) and
 *    lines (mockups, code), a letter's counters staying with it;
 *  - writes one keyframe track per moving part, all on one 24-second clock, so
 *    a walk cycle runs only while its character walks and a hammer swings only
 *    while there is code to hammer.
 *
 * Nothing is masked or wiped: every part of the document arrives as a thing
 * placed by someone. Tracks move `translate`, `rotate`, `scale` and `opacity`
 * only, and idle loops (blinks, antennae) sit on different elements from the
 * clocked tracks, so the two never write the same property of one element.
 */

const SOURCE = new URL("./team-doc.source.svg", import.meta.url);
const OUT = new URL("../../public/pro/team-doc.svg", import.meta.url);

const browser = await chromium.launch();
const page = await browser.newPage();
const source = readFileSync(SOURCE, "utf8").replace(/<\?xml[^>]*>\s*/, "");
await page.setContent(`<body style="margin:0">${source}</body>`);

const built = await page.evaluate(() => {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.querySelector("svg");
  const LOOP = 24;
  const css = [];
  let n = 0;

  // ---- Keyframe tracks ----------------------------------------------------

  const pct = (t) => `${Math.max(0, Math.min(100, (t / LOOP) * 100)).toFixed(3)}%`;
  const decl = (p) =>
    Object.entries(p)
      .map(([k, v]) => `${k}:${v}`)
      .join(";");

  /**
   * One clocked track. `frames` are [seconds, props, ease?] in time order; the
   * first frame's props hold from 0s and the last's to the end of the loop.
   */
  function track(el, frames, { origin, box = "view-box" } = {}) {
    el = own(el);
    const name = `k${n++}`;
    const rows = [];
    const first = frames[0][1];
    if (frames[0][0] > 0) rows.push(`0%{${decl(first)}}`);
    for (const [t, p, ease] of frames) {
      rows.push(`${pct(t)}{${decl(p)}${ease ? `;animation-timing-function:${ease}` : ""}}`);
    }
    const last = frames[frames.length - 1];
    if (last[0] < LOOP) rows.push(`100%{${decl(last[1])}}`);
    css.push(`@keyframes ${name}{${rows.join("")}}`);
    const cls = `a-${name}`;
    el.classList.add(cls);
    css.push(
      `.${cls}{animation:${name} ${LOOP}s linear infinite;transform-box:${box};` +
        (origin ? `transform-origin:${origin};` : "transform-origin:50% 50%;") +
        `}`,
    );
  }

  /** An unclocked loop, for what living things do all the time. */
  function idle(el, name, body, { origin, box = "fill-box" } = {}) {
    el = own(el);
    el.style.transformBox = box;
    el.style.transformOrigin = origin ?? "50% 50%";
    el.style.animation = body;
    if (!css.some((r) => r.startsWith(`@keyframes ${name}{`))) css.push(IDLE[name]);
  }
  const IDLE = {
    blink: "@keyframes blink{0%,93%,100%{scale:1 1}96%{scale:1 .08}}",
    wobble: "@keyframes wobble{from{rotate:-5deg}to{rotate:5deg}}",
  };

  /**
   * Alternates a property between two values over [t0, t1], in steps of half a
   * period, resting at `rest` on either side — a walk cycle, a scribble, a
   * brush stroke, only for as long as the work lasts.
   */
  function osc(t0, t1, period, prop, a, b, rest) {
    const f = [[t0, { [prop]: rest }]];
    let t = t0 + period / 4;
    let flip = false;
    while (t < t1 - period / 4) {
      f.push([t, { [prop]: flip ? b : a }, "ease-in-out"]);
      t += period / 2;
      flip = !flip;
    }
    f.push([t1, { [prop]: rest }]);
    return f;
  }
  /** Merges frame lists for one property, in time order. */
  const seq = (...lists) => lists.flat().sort((x, y) => x[0] - y[0]);

  // ---- DOM helpers ----------------------------------------------------------

  /**
   * The element to animate. One drawn with a `transform` attribute (the eyes
   * are rotated ellipses) is wrapped: a transform origin re-centres that
   * attribute too, so even `scale: 1` about its middle would move it.
   */
  function own(el) {
    if (!el.hasAttribute("transform")) return el;
    const g = document.createElementNS(NS, "g");
    el.parentNode.insertBefore(g, el);
    g.appendChild(el);
    return g;
  }

  const byId = (id) => document.getElementById(id);
  const kids = (el) => [...el.children];
  /** Wraps `els` (in their current order) in a new group placed where the first was. */
  function group(els, cls) {
    const g = document.createElementNS(NS, "g");
    if (cls) g.setAttribute("class", cls);
    els[0].parentNode.insertBefore(g, els[0]);
    for (const e of els) g.appendChild(e);
    return g;
  }
  const bbox = (el) => {
    const b = el.getBBox();
    return { x: b.x, y: b.y, r: b.x + b.width, b: b.y + b.height, w: b.width, h: b.height };
  };

  /** A path's glyph outlines, each subpath with its box. */
  function subpaths(path) {
    const d = path.getAttribute("d");
    return d
      .split(/(?=M)/)
      .filter((s) => s.trim())
      .map((s) => {
        const p = document.createElementNS(NS, "path");
        p.setAttribute("d", s);
        path.parentNode.appendChild(p);
        const b = bbox(p);
        p.remove();
        return { d: s, ...b };
      });
  }

  /** Clusters outlines into rows by vertical overlap. */
  function rows(parts) {
    const sorted = [...parts].sort((p, q) => p.y - q.y);
    const out = [];
    for (const p of sorted) {
      const row = out[out.length - 1];
      if (row && p.y < row.b - Math.min(row.b - row.y, p.h) * 0.3) {
        row.parts.push(p);
        row.b = Math.max(row.b, p.b);
      } else out.push({ y: p.y, b: p.b, parts: [p] });
    }
    return out;
  }
  /** Splits a row into words at gaps wider than a fraction of its height. */
  function words(row) {
    const h = row.b - row.y;
    const sorted = [...row.parts].sort((p, q) => p.x - q.x);
    const out = [];
    for (const p of sorted) {
      const w = out[out.length - 1];
      if (w && p.x - w.r < h * 0.3) {
        w.parts.push(p);
        w.r = Math.max(w.r, p.r);
      } else out.push({ x: p.x, r: p.r, y: row.y, parts: [p] });
    }
    return out;
  }
  /** Replaces a path with one path per chunk, same class; returns them with boxes. */
  function explode(path, chunks) {
    const made = chunks.map((c) => {
      const p = document.createElementNS(NS, "path");
      if (path.getAttribute("class")) p.setAttribute("class", path.getAttribute("class"));
      p.setAttribute("d", c.parts.map((s) => s.d).join(""));
      path.parentNode.insertBefore(p, path);
      return p;
    });
    path.remove();
    return made.map((el) => ({ el, ...bbox(el) }));
  }
  const asWords = (path) => explode(path, rows(subpaths(path)).flatMap(words));
  const asLines = (path) => explode(path, rows(subpaths(path)));
  /** A section's parts, glyph paths split, everything else whole. */
  function pieces(section, split) {
    const out = [];
    const walk = (el) => {
      for (const c of kids(el)) {
        const multi = c.tagName === "path" && (c.getAttribute("d") || "").split("M").length > 2;
        const isGlyphs = multi && !c.getAttribute("class")?.match(/cls-(8|18|28|33)\b/);
        if (c.tagName === "g" && !c.getAttribute("class") && !c.getAttribute("mask")) walk(c);
        else if (isGlyphs) out.push(...split(c));
        else out.push({ el: c, ...bbox(c) });
      }
    };
    walk(section);
    return out;
  }

  // ---- The document ---------------------------------------------------------

  /** Placed by hand: rises a few units into place as it fades up. */
  const settle = (el, t, from = "0 6px", dur = 0.22) =>
    track(el, [
      [0, { opacity: 0, translate: from }],
      [t, { opacity: 0, translate: from }, "cubic-bezier(.2,.7,.3,1)"],
      [t + dur, { opacity: 1, translate: "0 0" }],
    ]);
  /** Set down with a little give: grows from just under size. */
  const pop = (el, t, from = ".7") =>
    track(
      el,
      [
        [0, { opacity: 0, scale: from }],
        [t, { opacity: 0, scale: from }, "cubic-bezier(.3,1.6,.5,1)"],
        [t + 0.28, { opacity: 1, scale: "1" }],
      ],
      { box: "fill-box" },
    );
  /** Drawn out from its start: an arrow or rule grows along its length. */
  const draw = (el, t) =>
    track(
      el,
      [
        [0, { opacity: 0, scale: "0 1" }],
        [t, { opacity: 1, scale: "0 1" }, "cubic-bezier(.4,0,.2,1)"],
        [t + 0.3, { opacity: 1, scale: "1 1" }],
      ],
      { box: "fill-box", origin: "0% 50%" },
    );
  /** Spreads items over [t0, t1] in the given order. */
  const spread = (items, t0, t1, fn) =>
    items.forEach((it, i) => fn(it, t0 + ((t1 - t0) * i) / Math.max(1, items.length - 1)));

  // The whole document leaves together at the end of the loop.
  const FADE = [23.0, 23.8];
  const leave = (el) =>
    track(el, [
      [FADE[0], { opacity: 1 }, "ease-in"],
      [FADE[1], { opacity: 0 }],
    ]);

  // Header — written word by word by the turtle, in reading order.
  const header = byId("Section_Header");
  const headerWords = pieces(header, asWords).sort((p, q) => p.y - q.y || p.x - q.x);
  // Reading order: rows first (a row is words whose tops sit together).
  const reading = rows(headerWords.map((w) => ({ ...w, b: w.b }))).flatMap((r) =>
    r.parts.sort((p, q) => p.x - q.x),
  );
  spread(reading, 2.45, 5.2, (w, t) => settle(w.el, t, "0 5px", 0.18));
  leave(header);

  // Flowchart — boxes set down and arrows drawn, left to right.
  const flow = byId("Section_User_Flow");
  const flowParts = pieces(flow, asWords).sort((p, q) => p.x - q.x || p.y - q.y);
  spread(flowParts, 5.5, 7.5, (p, t) => {
    const arrow = p.w > p.h * 3 && p.h < 16 && p.el.tagName === "path";
    arrow ? draw(p.el, t) : pop(p.el, t, ".8");
  });
  leave(flow);

  // Mockups — painted top to bottom, the cart and then the payment panel.
  const paint = (id, t0, t1) => {
    const panel = byId(id);
    const parts = pieces(panel, asLines).sort((p, q) => p.y - q.y || p.x - q.x);
    spread(parts, t0, t1, (p, t) =>
      p.w > 150 && p.h > 150 ? pop(p.el, t, ".96") : settle(p.el, t, "0 4px"),
    );
    leave(panel);
  };
  paint("Mockup_Cart_Panel", 14.4, 15.9);
  paint("Mockup_Payment_Panel", 15.95, 17.5);

  // Code — the slab dropped in on the first blow, then a line per blow.
  const code = byId("Section_Code_Block");
  const codeParts = pieces(code, asLines);
  const HIT0 = 19.2;
  const HIT = 0.36;
  const slab = codeParts.filter((p) => p.w > 1000);
  const heading = codeParts.filter((p) => p.y < 1460 && p.w <= 1000);
  const body = codeParts.filter((p) => !slab.includes(p) && !heading.includes(p));
  heading.forEach((p) => settle(p.el, HIT0 - 0.5, "0 4px"));
  slab.forEach((p) =>
    track(p.el, [
      [0, { opacity: 0, translate: "0 -60px" }],
      [HIT0 - 0.12, { opacity: 0, translate: "0 -60px" }, "cubic-bezier(.5,0,1,.6)"],
      [HIT0, { opacity: 1, translate: "0 0" }, "ease-out"],
      [HIT0 + 0.08, { opacity: 1, translate: "0 4px" }, "ease-out"],
      [HIT0 + 0.2, { opacity: 1, translate: "0 0" }],
    ]),
  );
  const codeRows = rows(body.map((p) => ({ ...p })));
  codeRows.forEach((row, i) =>
    row.parts.forEach((p) => {
      const t = HIT0 + HIT * (i + 1);
      track(p.el, [
        [0, { opacity: 0, translate: "0 -10px" }],
        [t - 0.06, { opacity: 0, translate: "0 -10px" }, "cubic-bezier(.5,0,1,.6)"],
        [t, { opacity: 1, translate: "0 0" }, "ease-out"],
        [t + 0.06, { opacity: 1, translate: "0 2px" }, "ease-out"],
        [t + 0.16, { opacity: 1, translate: "0 0" }],
      ]);
    }),
  );
  const LAST_HIT = HIT0 + HIT * codeRows.length;
  leave(code);

  // ---- The team -------------------------------------------------------------

  /** The walker: in from off the page, bobbing in step, and out at the end. */
  function walker(el, from, t0, t1, step) {
    const wrap = group([el], "walker");
    track(wrap, [
      [0, { translate: from, opacity: 1 }],
      [t0, { translate: from, opacity: 1 }, "cubic-bezier(.35,.1,.45,1)"],
      [t1, { translate: "0 0", opacity: 1 }],
      [FADE[0], { translate: "0 0", opacity: 1 }, "ease-in"],
      [FADE[1], { translate: "0 0", opacity: 0 }],
    ]);
    track(el, osc(t0, t1, step, "translate", "0 -7px", "0 0", "0 0"));
  }
  const part = (els, cls) => group(els, cls);

  // Turtle: walks in from the left, writes the header, then looks it over.
  {
    const t = byId("Character_-_Green_Turtle");
    const c = kids(t);
    const pencil = c.slice(0, 7);
    const armR = part([c[7], c[8]]);
    const armL = part([...pencil, c[9], c[10]]);
    armR.after(armL);
    const shade = c[13];
    const [shadeL, shadeR] = kids(shade.firstElementChild);
    const shadeR2 = shade.cloneNode(true);
    shadeR2.firstElementChild.firstElementChild.remove();
    shadeR.remove();
    const legL = part([c[11], shade]);
    const legR = part([c[12]]);
    legR.appendChild(shadeR2);
    legL.after(legR);
    void shadeL;
    const antR = part([c[14], c[15]]);
    const antL = part([c[16], c[17]]);
    walker(t, "-760px 0", 0.3, 2.2, 0.32);
    const STEP = 0.32;
    track(legL, osc(0.3, 2.2, STEP, "rotate", "-16deg", "14deg", "0deg"), { origin: "575px 505px" });
    track(legR, osc(0.3, 2.2, STEP, "rotate", "14deg", "-16deg", "0deg"), { origin: "632px 505px" });
    track(
      armR,
      seq(osc(0.3, 2.2, STEP, "rotate", "10deg", "-8deg", "0deg"), [
        [5.3, { rotate: "0deg" }, "ease-in-out"],
        [5.6, { rotate: "-14deg" }, "ease-in-out"],
        [6.4, { rotate: "0deg" }],
      ]),
      { origin: "628px 478px" },
    );
    // The pencil arm: up to the page, scribbling while the words come, then down.
    track(
      armL,
      seq(
        [
          [0, { rotate: "18deg" }],
          [0.3, { rotate: "18deg" }],
          [2.2, { rotate: "18deg" }, "ease-out"],
          [2.4, { rotate: "0deg" }],
        ],
        osc(2.4, 5.25, 0.2, "rotate", "-5deg", "4deg", "0deg").slice(1),
        [
          [5.25, { rotate: "0deg" }, "ease-in-out"],
          [5.7, { rotate: "22deg" }],
        ],
      ),
      { origin: "566px 496px" },
    );
    idle(antR, "wobble", "wobble 1.1s ease-in-out infinite alternate", { origin: "0% 100%" });
    idle(antL, "wobble", "wobble 1.3s ease-in-out infinite alternate-reverse", { origin: "100% 100%" });
  }

  // Bear: lowered on the rope with the card, sets it in the flowchart's last
  // box, and climbs back out.
  {
    const rope = byId("Rope");
    track(rope, [
      [0, { translate: "0 -700px" }],
      [7.3, { translate: "0 -700px" }, "cubic-bezier(.3,.1,.3,1)"],
      [8.0, { translate: "0 0" }],
      [12.9, { translate: "0 0" }, "ease-in"],
      [13.4, { translate: "0 -700px" }],
    ]);

    const bear = byId("Character_-_Pink_Bear");
    const c = kids(bear);
    const card = part([c[10], c[11], c[12]]);
    card.id = "Card";
    const legUpper = part([c[9]]);
    const legLower = part([c[2]]);
    const earBack = part([c[4]]);
    const earFront = part([c[13]]);
    const armFront = part([c[14]]);
    // The card goes over the bear (it crosses the ear on its way to the page),
    // all but the paw that grips it, which stays on top of it.
    bear.appendChild(card);
    const paw = part([c[15]]);
    bear.appendChild(paw);
    const armBack = part([c[3]]);
    const eyes = part([c[6], c[7]]);
    const bun = part([c[0], c[1]]);
    // The bear's parts either side of the card, moved together.
    const body = part(kids(bear).filter((k) => k !== card && k !== paw));
    const hand = part([paw]);
    const DOWN = [7.9, 9.2];
    const UP = [11.5, 12.9];
    const climb = (start, end, pulls) => {
      const f = [];
      for (let i = 0; i < pulls; i++) {
        const a = start + ((end - start) * i) / pulls;
        const b = start + ((end - start) * (i + 0.7)) / pulls;
        const c2 = start + ((end - start) * (i + 1)) / pulls;
        f.push([a, { translate: `0 ${(-820 * i) / pulls}px` }, "cubic-bezier(.4,0,.2,1)"]);
        f.push([b, { translate: `0 ${(-820 * (i + 1)) / pulls}px` }]);
        f.push([c2, { translate: `0 ${(-820 * (i + 1)) / pulls}px` }]);
      }
      return f;
    };
    const bearPath = [
      [0, { translate: "0 -820px" }],
      [DOWN[0], { translate: "0 -820px" }, "cubic-bezier(.25,.1,.25,1)"],
      [DOWN[1], { translate: "0 10px" }, "ease-in-out"],
      [DOWN[1] + 0.25, { translate: "0 -6px" }, "ease-in-out"],
      [DOWN[1] + 0.45, { translate: "0 0" }],
      ...climb(UP[0], UP[1], 4),
    ];
    for (const g of [body, hand]) track(g, bearPath);

    // Legs flutter on the way down and kick on the way up.
    const legs = (off) =>
      seq(
        osc(DOWN[0], DOWN[1], 0.24, "rotate", `${-10 + off}deg`, `${9 - off}deg`, "0deg"),
        osc(UP[0], UP[1], 0.35, "rotate", `${14 - off}deg`, `${-12 + off}deg`, "0deg"),
      );
    track(legUpper, legs(0), { origin: "1415px 600px" });
    track(legLower, legs(4), { origin: "1422px 640px" });
    // Ears flop out behind as it slides, and settle.
    const ears = [
      [0, { rotate: "0deg" }],
      [DOWN[0], { rotate: "0deg" }, "ease-out"],
      [DOWN[0] + 0.4, { rotate: "-24deg" }],
      [DOWN[1], { rotate: "-18deg" }, "cubic-bezier(.3,1.8,.5,1)"],
      [DOWN[1] + 0.5, { rotate: "0deg" }],
      [UP[0], { rotate: "0deg" }, "ease-in-out"],
      [UP[0] + 0.3, { rotate: "14deg" }],
      [UP[1], { rotate: "10deg" }],
    ];
    track(earBack, ears, { origin: "1234px 612px" });
    track(earFront, ears, { origin: "1240px 606px" });
    track(bun, [
      [DOWN[1], { rotate: "0deg" }, "ease-out"],
      [DOWN[1] + 0.12, { rotate: "-8deg" }, "cubic-bezier(.3,1.8,.5,1)"],
      [DOWN[1] + 0.6, { rotate: "0deg" }],
    ], { origin: "1305px 590px" });

    // The hand-over: the arm reaches up-left and lets the card go into place.
    const REACH = [9.8, 10.6];
    const reach = [
      [0, { rotate: "0deg" }],
      [REACH[0], { rotate: "0deg" }, "cubic-bezier(.4,0,.2,1)"],
      [REACH[1], { rotate: "20deg" }, "ease-in-out"],
      [REACH[1] + 0.35, { rotate: "20deg" }, "ease-in-out"],
      [REACH[1] + 0.7, { rotate: "-6deg" }, "ease-in-out"],
      [REACH[1] + 1.0, { rotate: "4deg" }, "ease-in-out"],
      [UP[0], { rotate: "0deg" }],
    ];
    track(armFront, reach, { origin: "1328px 690px" });
    track(paw, reach, { origin: "1328px 690px" });
    // Handing it over, the bear swings out on the rope, away from the page, so
    // the card goes down in front of it rather than over its face. Rope and bear
    // swing as one, from the top of the rope; the card is set apart from both,
    // so it stays where it was put.
    const swing = group([rope, bear]);
    swing.after(card);
    track(swing, [
      [0, { rotate: "0deg" }],
      [REACH[0] + 0.15, { rotate: "0deg" }, "ease-in-out"],
      [REACH[1] - 0.05, { rotate: "-6deg" }],
      [REACH[1] + 0.6, { rotate: "-6deg" }, "ease-in-out"],
      [UP[0] - 0.1, { rotate: "1.5deg" }, "ease-in-out"],
      [UP[0] + 0.3, { rotate: "0deg" }],
    ], { origin: "1336px 0px" });
    track(armBack, osc(UP[0], UP[1], 0.35, "rotate", "-10deg", "8deg", "0deg"), { origin: "1300px 682px" });
    // Card: rides down in the paw, then lifts, turns level and is set down as
    // the last box: centre (1202, 688) → (1196, 618), −22.5° → level.
    track(card, [
      [0, { translate: "0 -820px", rotate: "0deg", opacity: 1 }],
      [DOWN[0], { translate: "0 -820px", rotate: "0deg", opacity: 1 }, "cubic-bezier(.25,.1,.25,1)"],
      [DOWN[1], { translate: "0 10px", rotate: "0deg", opacity: 1 }, "ease-in-out"],
      [DOWN[1] + 0.25, { translate: "0 -6px", rotate: "0deg", opacity: 1 }, "ease-in-out"],
      [REACH[0], { translate: "0 0", rotate: "0deg", opacity: 1 }, "cubic-bezier(.4,0,.2,1)"],
      [REACH[0] + 0.45, { translate: "-18px -100px", rotate: "-50deg", opacity: 1 }, "cubic-bezier(.3,1.3,.5,1)"],
      [REACH[1], { translate: "-6.5px -69.9px", rotate: "-67.5deg", opacity: 1 }],
      [FADE[0], { translate: "-6.5px -69.9px", rotate: "-67.5deg", opacity: 1 }, "ease-in"],
      [FADE[1], { translate: "-6.5px -69.9px", rotate: "-67.5deg", opacity: 0 }],
    ], { origin: "1202.3px 687.9px" });
    // Delighted when it lands: the eyes close into a smile, then open.
    track(eyes, [
      [0, { scale: "1 1" }],
      [REACH[1] + 0.05, { scale: "1 1" }, "ease-out"],
      [REACH[1] + 0.2, { scale: "1.1 .3" }],
      [REACH[1] + 0.8, { scale: "1.1 .3" }, "ease-in-out"],
      [REACH[1] + 1.0, { scale: "1 1" }],
    ], { box: "fill-box" });
    for (const e of kids(eyes)) idle(e, "blink", "blink 3.3s linear infinite");
  }

  // Elephant: walks in from the right and paints both mockups.
  {
    const e = byId("Character_-_Yellow_Elephant");
    const c = kids(e);
    const brush = c.slice(0, 4);
    const antenna = part([c[4], c[5], c[6]]);
    const palArm = part([c[7], c[8]]);
    const legBack = part([c[9], c[10]]);
    const legFront = part([c[13]]);
    const eyes = part([c[12], c[14]]);
    const beret = part([c[15]]);
    const brushArm = part([...brush, c[16]]);
    // The brush arm goes back where the arm was drawn, over the body.
    beret.after(brushArm);
    const palette = part(c.slice(17, 23));
    const WALK = [12.6, 14.25];
    const PAINT = [14.35, 17.55];
    walker(e, "620px 0", WALK[0], WALK[1], 0.34);
    track(legBack, osc(WALK[0], WALK[1], 0.34, "rotate", "14deg", "-14deg", "0deg"), { origin: "1117px 1400px" });
    track(legFront, osc(WALK[0], WALK[1], 0.34, "rotate", "-14deg", "14deg", "0deg"), { origin: "1139px 1405px" });
    // Strokes: back, press, sweep — each one lands a piece of the mockup.
    track(brushArm, seq(
      [[0, { rotate: "-10deg" }], [WALK[1], { rotate: "-10deg" }, "ease-out"]],
      osc(PAINT[0], PAINT[1], 0.42, "rotate", "12deg", "-8deg", "0deg"),
      [[PAINT[1] + 0.4, { rotate: "-18deg" }]],
    ), { origin: "1106px 1392px" });
    const dip = (t) => [
      [t, { rotate: "0deg" }, "ease-in-out"],
      [t + 0.2, { rotate: "-12deg" }, "ease-in-out"],
      [t + 0.45, { rotate: "0deg" }],
    ];
    const palFrames = seq([[0, { rotate: "0deg" }]], dip(15.1), dip(16.5));
    track(palArm, palFrames, { origin: "1118px 1360px" });
    track(palette, palFrames, { origin: "1118px 1360px" });
    track(beret, seq(osc(WALK[0], WALK[1], 0.34, "rotate", "-6deg", "3deg", "0deg")), { origin: "1160px 1332px" });
    // Eyes on the work while painting.
    track(eyes, [
      [0, { translate: "0 0" }],
      [PAINT[0], { translate: "0 0" }, "ease-out"],
      [PAINT[0] + 0.3, { translate: "-3px 1px" }],
      [PAINT[1], { translate: "-3px 1px" }, "ease-in-out"],
      [PAINT[1] + 0.4, { translate: "0 0" }],
    ]);
    for (const x of kids(eyes)) idle(x, "blink", "blink 4.1s linear infinite");
    idle(antenna, "wobble", "wobble 1.4s ease-in-out infinite alternate", { origin: "30% 100%" });
  }

  // Alien: marches in from the left and hammers out the code, a line a blow.
  {
    const a = byId("Character_-_Blue_Alien");
    const c = kids(a);
    const armUp = part([c[0], c[5], c[6]]);
    const legL = part([c[1], c[2]]);
    const legR = part([c[3], c[4]]);
    const armDown = part([c[7]]);
    const antL = part([c[8], c[9], c[10]]);
    const eyes = part([c[12], c[13]]);
    const antR = part([c[14], c[15], c[16]]);
    const hammer = part(c.slice(18, 22));
    const WALK = [17.2, 18.9];
    walker(a, "-800px 0", WALK[0], WALK[1], 0.3);
    track(legL, osc(WALK[0], WALK[1], 0.3, "rotate", "-15deg", "15deg", "0deg"), { origin: "590px 1975px" });
    track(legR, osc(WALK[0], WALK[1], 0.3, "rotate", "15deg", "-15deg", "0deg"), { origin: "646px 1978px" });
    track(armDown, osc(WALK[0], WALK[1], 0.3, "rotate", "10deg", "-10deg", "0deg"), { origin: "640px 1898px" });
    // Wind up and strike, once per line.
    const blows = [];
    const hits = [HIT0, ...Array.from({ length: Math.round((LAST_HIT - HIT0) / HIT) }, (_, i) => HIT0 + HIT * (i + 1))];
    blows.push([0, { rotate: "0deg" }], [HIT0 - 0.5, { rotate: "0deg" }, "ease-out"]);
    for (const h of hits) {
      blows.push([h - 0.2, { rotate: "-26deg" }, "cubic-bezier(.6,0,1,.5)"]);
      blows.push([h, { rotate: "8deg" }, "ease-out"]);
      blows.push([h + 0.08, { rotate: "4deg" }, "ease-in-out"]);
    }
    blows.push([LAST_HIT + 0.4, { rotate: "-34deg" }, "ease-in-out"], [LAST_HIT + 0.8, { rotate: "-28deg" }]);
    for (const g of [armUp, hammer]) track(g, blows, { origin: "598px 1916px" });
    // A wince on every blow.
    const winces = [[0, { scale: "1 1" }]];
    for (const h of hits) winces.push([h - 0.02, { scale: "1 1" }, "ease-out"], [h + 0.05, { scale: "1.1 .45" }, "ease-in"], [h + 0.2, { scale: "1 1" }]);
    track(eyes, winces, { box: "fill-box" });
    for (const x of kids(eyes)) idle(x, "blink", "blink 3.7s linear infinite");
    idle(antL, "wobble", "wobble .9s ease-in-out infinite alternate", { origin: "60% 100%" });
    idle(antR, "wobble", "wobble 1s ease-in-out infinite alternate-reverse", { origin: "20% 100%" });
  }

  const style = document.createElementNS(NS, "style");
  style.textContent =
    css.join("\n") +
    "\n@media (prefers-reduced-motion:reduce){*{animation:none!important}}";
  svg.querySelector("defs").appendChild(style);
  return new XMLSerializer().serializeToString(svg);
});

await browser.close();
writeFileSync(OUT, `<?xml version="1.0" encoding="UTF-8"?>\n${built}\n`);
console.log(`wrote ${OUT.pathname} (${Math.round(built.length / 1024)} KB)`);
