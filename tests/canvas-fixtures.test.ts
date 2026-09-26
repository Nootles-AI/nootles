import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { familyName } from "@/app/components/editor/canvas/render/fonts";
import { laidOutScene } from "@/app/components/editor/canvas/scene/autoLayout";
import { normalizeDiagram } from "@/app/components/editor/canvas/scene/band";
import { absoluteBounds, toLocal } from "@/app/components/editor/canvas/scene/geometry";
import { parseScene } from "@/app/components/editor/canvas/scene/parse";
import { hitTestPath } from "@/app/components/editor/canvas/scene/picking";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import {
  findNode,
  isBoolean,
  walk,
  type EllipseNode,
  type NodeId,
  type Point,
  type Rect,
  type RectNode,
  type Scene,
  type SceneNode,
} from "@/app/components/editor/canvas/scene/types";
import {
  FIXTURES,
  PICKING_PROBES,
  shapeIdsIn,
  type FixtureName,
  type Probe,
  type ProbeAction,
  type ProbeAnchor,
} from "./canvas-fixtures";

/**
 * Proves the fixture file this session's browser harness builds on is
 * actually what it claims to be: a lossless round trip, unique ids, no
 * network-reaching fonts, and a picking probe table that is checked against
 * the code it claims to describe — including a mechanical re-derivation of
 * every `xfail` tag, so a future probe can't silently drift the way
 * `hollow.button.cmd`/`clip.outside.cmd` once did (see HARNESS.md's review
 * notes). None of this touches `app/**` — it is pure verification against the
 * real, unmodified parser, serializer and geometry.
 */

const parse = (html: string): Scene => parseScene(html, (h) => parseHTML(h).document as unknown as Document);

const FIXTURE_NAMES = Object.keys(FIXTURES) as FixtureName[];

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe("fixtures.roundTrip", () => {
  for (const name of FIXTURE_NAMES) {
    it(name, () => {
      const { html } = FIXTURES[name];
      expect(serializeScene(parse(html))).toBe(html);
    });
  }
});

describe("fixtures.parseEquals", () => {
  for (const name of FIXTURE_NAMES) {
    it(name, () => {
      const { scene, html } = FIXTURES[name];
      expect(parse(serializeScene(scene))).toEqual(scene);
      // Redundant with the line above by construction (`html` IS
      // `serializeScene(scene)`) but states the contract literally.
      expect(parse(html)).toEqual(scene);
    });
  }
});

// The harness mounts through the diagram reader. A fixture it moved would move
// every probe's point off the shape the probe names.
describe("fixtures.bandRoots", () => {
  for (const name of FIXTURE_NAMES) {
    it(name, () => {
      const scene = parse(FIXTURES[name].html);
      expect(normalizeDiagram(scene)).toBe(scene);
    });
  }
});

describe("fixtures.idsUnique", () => {
  for (const name of FIXTURE_NAMES) {
    it(name, () => {
      const ids: NodeId[] = [];
      walk(FIXTURES[name].scene.nodes, (node) => void ids.push(node.id));
      expect(ids.every((id) => id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    });
  }
});

describe("fixtures.noRemoteFonts", () => {
  for (const name of FIXTURE_NAMES) {
    it(name, () => {
      const { scene } = FIXTURES[name];
      expect(familyName(scene.style["font-family"])).toBeNull();
      walk(scene.nodes, (node) => {
        expect(familyName(node.style["font-family"])).toBeNull();
        expect(node.label.includes("font-family")).toBe(false);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// nested-flex — the layout-agreement fixture
// ---------------------------------------------------------------------------

describe("fixtures.nestedFlex.laid", () => {
  it("moves the flowing children off their authored placeholders and leaves the pinned one", () => {
    const original = FIXTURES["nested-flex"].scene;
    const laid = laidOutScene(original);
    const at = (s: Scene, id: NodeId) => findNode(s, id)!;
    // `placeNode` returns the SAME object when a group's own resolved rect
    // doesn't change — object identity is exactly "did layout touch this".
    for (const id of ["title", "row", "pinned", "r1", "r2", "r3"]) {
      expect(at(laid, id), `${id} should have moved off its placeholder`).not.toBe(at(original, id));
    }
    expect(at(laid, "p2"), "a pinned child keeps its place").toBe(at(original, "p2"));
    const r1 = at(laid, "r1") as RectNode;
    const r2 = at(laid, "r2") as RectNode;
    expect(r1.h, "align-items:stretch resizes r1 to the row's height").toBe(60);
    expect(r2.h, "align-items:stretch resizes r2 to the row's height").toBe(60);
  });
});

// ---------------------------------------------------------------------------
// pick-all — resolving a probe's `where`
// ---------------------------------------------------------------------------

function resolvePoint(where: ProbeAnchor, laid: Scene): Point {
  if ("node" in where) {
    const box = absoluteBounds(laid, where.node);
    return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  }
  return where;
}

function pointsOf(probe: Probe): readonly ProbeAnchor[] {
  const where = probe.where;
  // `Array.isArray`'s `is any[]` predicate doesn't narrow a `readonly T[]`
  // union member cleanly; the shape is known, so state it directly.
  return Array.isArray(where) ? (where as readonly ProbeAnchor[]) : [where as ProbeAnchor];
}

describe("fixtures.pickAll.geometry", () => {
  const CLICK_LIKE: readonly ProbeAction[] = ["click", "cmdClick", "altClick", "hover"];
  // `card.padding.cmd`'s real outcome is no longer a direct function of raw
  // `hitTestPath` geometry: SELECT's `marqueeThroughTarget` (engine/
  // useSelection.ts) intercepts a Mod-press on a painted, non-boolean
  // container's own padding *before* any click decision, and a zero-movement
  // release resolves it as an empty marquee (SELECT.md's own Q6) rather than
  // a deep-select of the chain `hitTestPath` reports. This re-derivation is
  // for probes whose selection follows directly from the paint chain; this
  // one doesn't, by design — its own probe carries the real end-to-end
  // answer and its reasoning in `note` instead.
  const NOT_REDUCIBLE_TO_GEOMETRY = new Set(["card.padding.cmd"]);
  for (const probe of PICKING_PROBES) {
    if (
      probe.xfail ||
      probe.today === "n/a" ||
      !CLICK_LIKE.includes(probe.action) ||
      NOT_REDUCIBLE_TO_GEOMETRY.has(probe.id)
    ) {
      continue;
    }
    it(probe.id, () => {
      const laid = laidOutScene(FIXTURES[probe.fixture].scene);
      // Real `hitTestPath` on main, exactly as `SelectionStore.click`/`hover`
      // call it today — no tolerance argument is ever passed pre-PICK.
      // `cmdClick` means deep now that SELECT has wired ⌘/Ctrl to `isModKey`
      // (`engine/shortcuts.ts`).
      const deep = (probe.readOnly ?? false) || probe.action === "altClick" || probe.action === "cmdClick";
      const point = resolvePoint(pointsOf(probe)[0], laid);
      const chain = hitTestPath(laid, point, { deep });
      const got = chain.length ? [deep ? chain[chain.length - 1].id : chain[0].id] : [];
      expect(got).toEqual(probe.today);
    });
  }
});

describe("fixtures.pickAll.margins", () => {
  // §3.2.1's own stated invariant, verified rather than assumed: the two
  // regions review round 2 added (layers-locked, layers-dupe-name) sit clear
  // of every PRE-EXISTING region's box by >=60 scene px "on the axis that
  // separates them" — not necessarily every axis, since two boxes can overlap
  // on one axis and still be unambiguous because they're far apart on the
  // other (`three-layers`' box overlaps `layers-locked`'s on x but not y, for
  // instance). The two new regions were never verified against EACH OTHER
  // (only against the seven originals — §3.2.1's own worked examples are both
  // against `ring-hole`/`stroke-path`), and in fact aren't: `hhide`'s corner
  // and `d1`'s corner come within 20px. The one pre-existing region with any
  // rotation (`rotated-group`) is compared by its own authored, UNROTATED box
  // rather than `absoluteBounds`'s rotated AABB — a wider box than the design
  // ever reasoned about, and not what "clear of every other region's box"
  // meant when the reviewer verified it against two axis-aligned examples.
  const REGIONS: Record<string, readonly NodeId[]> = {
    hollow: ["btn", "hollow"],
    ring: ["under", "ring"],
    clip: ["clip"],
    rotated: ["rg"],
    stroke: ["pth"],
    padding: ["card"],
    layers: ["L1", "L2", "L3"],
    locked: ["hbase", "hlock", "hhide"],
    dupe: ["d1", "d2"],
  };
  const NEW_REGIONS = ["locked", "dupe"] as const;

  /** Every id above is a top-level node of `pick-all`, so its own `x/y/w/h`
   *  (unrotated, unclipped — the plain box a fixture author reasoned about
   *  when placing it) IS its scene-space footprint; no `absoluteBounds`. */
  function regionBounds(laid: Scene): Record<string, Rect> {
    const out: Record<string, Rect> = {};
    for (const [region, ids] of Object.entries(REGIONS)) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const id of ids) {
        const node = findNode(laid, id)!;
        x0 = Math.min(x0, node.x);
        y0 = Math.min(y0, node.y);
        x1 = Math.max(x1, node.x + node.w);
        y1 = Math.max(y1, node.y + node.h);
      }
      out[region] = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    return out;
  }

  /** The widest gap on any single separating axis; negative where the boxes'
   *  projections overlap on every axis (i.e. they actually intersect). */
  function clearance(a: Rect, b: Rect): number {
    const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w));
    const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));
    return Math.max(dx, dy);
  }

  const laid = laidOutScene(FIXTURES["pick-all"].scene);
  const bounds = regionBounds(laid);
  const MARGIN = 60;

  for (const region of NEW_REGIONS) {
    it(`${region} stays >=${MARGIN}px clear of every pre-existing region`, () => {
      for (const [other, box] of Object.entries(bounds)) {
        if (other === region || (NEW_REGIONS as readonly string[]).includes(other)) continue;
        const gap = clearance(bounds[region], box);
        expect(gap, `${region} vs ${other}: only ${gap.toFixed(1)}px clear`).toBeGreaterThanOrEqual(MARGIN);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// pick-all — the xfail attribution, mechanically re-derived
// ---------------------------------------------------------------------------

function isFilledLike(style: SceneNode["style"]): boolean {
  for (const prop of ["background", "background-color", "background-image"]) {
    const v = style[prop];
    if (v !== undefined && v !== "" && v !== "none" && v !== "transparent") return true;
  }
  return false;
}

/**
 * A hand-written stand-in for PICK's future paint-aware `hitsShape`, built
 * only from the vocabulary this fixture's probes actually need: a leaf only
 * registers when it is painted, an ellipse's `inner` is a real hole, and a
 * path is never a candidate (no probe in this table needs a true positive off
 * a curve). Deliberately NOT importing PICK's not-yet-written module — see
 * §4.1 of HARNESS.md.
 */
function simLeafHit(node: SceneNode, local: Point): boolean {
  if (node.kind === "path") return false;
  if (!isFilledLike(node.style)) return false;
  if (node.kind === "ellipse") {
    const rx = node.w / 2;
    const ry = node.h / 2;
    if (rx <= 0 || ry <= 0) return false;
    const dx = (local.x - rx) / rx;
    const dy = (local.y - ry) / ry;
    const r2 = dx * dx + dy * dy;
    if (r2 > 1) return false;
    const inner = (node as EllipseNode).inner;
    if (inner && r2 < inner * inner) return false;
    return true;
  }
  return local.x >= 0 && local.x <= node.w && local.y >= 0 && local.y <= node.h;
}

/** A clipping group's own box gates whether its children can be reached at all. */
function withinOwnBox(node: SceneNode, local: Point): boolean {
  return local.x >= 0 && local.x <= node.w && local.y >= 0 && local.y <= node.h;
}

/** The `hitTestPath`-equivalent chain PICK's paint + clip policy alone would
 *  produce, with `deep` driven only by `altKey` (never `metaKey`, since
 *  SELECT hasn't wired that yet) — the intermediate state §4.1 asks for. */
function simChain(nodes: readonly SceneNode[], point: Point, out: SceneNode[]): boolean {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.hidden || node.locked) continue;
    const local = toLocal(point, node);
    if (node.kind === "group") {
      const clips = node.style.overflow === "hidden";
      const inside = withinOwnBox(node, local);
      out.push(node);
      if ((!clips || inside) && simChain(node.children, local, out)) return true;
      if (inside && (isFilledLike(node.style) || isBoolean(node))) return true;
      out.pop();
      continue;
    }
    if (simLeafHit(node, local)) {
      out.push(node);
      return true;
    }
  }
  return false;
}

/** Every painted candidate, deepest/frontmost first — the intermediate
 *  `candidates()` answer PICK's geometry alone determines. */
function simCandidates(nodes: readonly SceneNode[], point: Point, out: SceneNode[]): void {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.hidden || node.locked) continue;
    const local = toLocal(point, node);
    if (node.kind === "group") {
      const clips = node.style.overflow === "hidden";
      const inside = withinOwnBox(node, local);
      if (!clips || inside) simCandidates(node.children, local, out);
      if (inside && (isFilledLike(node.style) || isBoolean(node))) out.push(node);
      continue;
    }
    if (simLeafHit(node, local)) out.push(node);
  }
}

function simulate(probe: Probe): NodeId[] {
  const laid = laidOutScene(FIXTURES[probe.fixture].scene);
  const point = resolvePoint(pointsOf(probe)[0], laid);
  if (probe.action === "candidates") {
    const out: SceneNode[] = [];
    simCandidates(laid.nodes, point, out);
    return out.map((n) => n.id);
  }
  const deep = (probe.readOnly ?? false) || probe.action === "altClick";
  const out: SceneNode[] = [];
  const hit = simChain(laid.nodes, point, out);
  if (!hit) return [];
  return [(deep ? out[out.length - 1] : out[0]).id];
}

describe("fixtures.pickAll.xfailReasons", () => {
  for (const probe of PICKING_PROBES) {
    it(probe.id, () => {
      if (probe.verify || probe.menuOpen === false) {
        expect(probe.note, `${probe.id} needs a note explaining its exemption`).toBeTruthy();
        return;
      }
      const todayArray = probe.today === "n/a" ? null : probe.today;
      const equal = todayArray !== null && JSON.stringify([...probe.expect]) === JSON.stringify([...todayArray]);
      if (probe.xfail) {
        expect(equal, `${probe.id}: xfail is set but expect equals today`).toBe(false);
        expect(probe.note, `${probe.id} needs a note explaining why today differs`).toBeTruthy();
      } else {
        expect(todayArray, `${probe.id}: no xfail means today must be a real answer`).not.toBeNull();
        expect([...(todayArray ?? [])], `${probe.id}: no xfail means expect === today`).toEqual([...probe.expect]);
      }
    });
  }
});

describe("fixtures.pickAll.xfailReasons — intermediate PICK-alone re-derivation", () => {
  const MENU_ACTIONS: readonly ProbeAction[] = ["layerMenu", "layerMenuPick"];

  // Both PICK ("Wave 1") and SELECT ("Wave 4") have now landed and removed
  // every `xfail` tag they resolved — this is the Wave-5 "assert zero
  // remaining" flip (build-plan §5 item 1), always present so the suite is
  // never empty once the last tag comes off.
  it("no probe carries a leftover xfail tag", () => {
    expect(PICKING_PROBES.filter((p) => p.xfail).map((p) => p.id)).toEqual([]);
  });

  for (const probe of PICKING_PROBES) {
    if (!probe.xfail) continue;
    it(`${probe.id} (${probe.xfail})`, () => {
      if (MENU_ACTIONS.includes(probe.action)) {
        // "Select layer ▸" does not exist at all until SELECT lands,
        // independent of whether PICK has landed — there is no intermediate
        // geometry question to ask.
        expect(probe.xfail, `${probe.id}: a menu probe's gap can only be SELECT's`).toBe("SELECT");
        expect(probe.today).toBe("n/a");
        return;
      }
      const got = simulate(probe);
      const reached = JSON.stringify(got) === JSON.stringify([...probe.expect]);
      if (probe.xfail === "PICK") {
        expect(reached, `${probe.id}: PICK landing alone should already reach expect`).toBe(true);
        return;
      }
      // xfail: "SELECT" — PICK's paint/clip policy alone must NOT be enough;
      // what's left must be a chain of >=2 where click and deep disagree.
      expect(reached, `${probe.id}: PICK alone must not already reach expect (that would make it PICK's, not SELECT's)`).toBe(false);
      const laid = laidOutScene(FIXTURES[probe.fixture].scene);
      const point = resolvePoint(pointsOf(probe)[0], laid);
      const chain: SceneNode[] = [];
      simChain(laid.nodes, point, chain);
      expect(chain.length, `${probe.id}: the remaining gap must be a chain of length >= 2`).toBeGreaterThanOrEqual(2);
    });
  }
});

describe("shapeIdsIn", () => {
  it("lists shapes at any depth, never the root or an edge", () => {
    const html =
      `<nt-diagram id="b7" w="10" h="10">\n  <nt-group id="g1" x="0" y="0" w="5" h="5">\n` +
      `    <nt-rect id="r1" x="0" y="0" w="1" h="1"></nt-rect>\n  </nt-group>\n` +
      `  <nt-edge id="e1" from="r1" to="g1"></nt-edge>\n</nt-diagram>`;
    expect([...shapeIdsIn(html)]).toEqual(["g1", "r1"]);
  });
});
