import { laidOutScene, measureGroup } from "@/app/components/editor/canvas/scene/autoLayout";
import { BAND } from "@/app/components/editor/canvas/scene/band";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import type {
  EllipseNode,
  GroupNode,
  NodeId,
  PathNode,
  Point,
  RectNode,
  Scene,
  SceneNode,
  StyleMap,
  TextNode,
} from "@/app/components/editor/canvas/scene/types";

/**
 * Deterministic canvas fixtures and the picking probe table.
 *
 * Every downstream browser test (picking, select, colour-pick, tools and
 * compile) mounts one of these
 * through `tests/canvas-harness.browser.tsx` rather than typing scene HTML
 * inline. Keeping the geometry here, once, is what lets a probe's `where`
 * and a fixture's box agree by construction instead of by two people
 * copying the same numbers into two files.
 *
 * A `Fixture` is built as a `Scene` object first and serialized once — never
 * the other way around — so `html` is `serializeScene(scene)` by
 * construction and the round-trip tests in `canvas-fixtures.test.ts` are
 * checking the real parser and serializer, not this file's arithmetic.
 *
 * ## A quiet trap this file works around
 *
 * `serializeScene` omits `x`/`y` for every child of an auto-layout group
 * (`display:flex|grid`) — including a `position:absolute` "pinned" child,
 * which keeps its own `x`/`y` through {@link laidOutScene} but NOT through a
 * serialize → parse round trip (there is no per-child override of the
 * parent's blanket `computed` flag in `scene/serialize.ts`; confirmed by
 * reading it, not assumed). So every child of a flex/grid group in
 * `nested-flex` is authored at `x:0, y:0` — the value such a round trip
 * actually produces — and the "a pinned child keeps its place" fixture
 * (`p2`) proves that by staying at that same `(0, 0)` while its flowing
 * sibling (`p1`) is moved off it by the layout engine. The fixture still
 * exercises exactly what {@link isPinned} exists for: with `p2` filtered out
 * of the flow, `p1` alone determines the row's cursor.
 */

// ---------------------------------------------------------------------------
// Node builders — the boilerplate every fixture below would otherwise repeat
// ---------------------------------------------------------------------------

interface NodeExtra {
  name?: string;
  label?: string;
  locked?: boolean;
  hidden?: boolean;
  rot?: number;
  attrs?: Record<string, string>;
}

function baseOf(id: NodeId, x: number, y: number, w: number, h: number, style: StyleMap, extra: NodeExtra) {
  return {
    id,
    x,
    y,
    w,
    h,
    rot: extra.rot ?? 0,
    style,
    label: extra.label ?? "",
    ...(extra.name !== undefined ? { name: extra.name } : {}),
    locked: extra.locked ?? false,
    hidden: extra.hidden ?? false,
    attrs: extra.attrs ?? {},
  };
}

function rect(id: NodeId, x: number, y: number, w: number, h: number, style: StyleMap = {}, extra: NodeExtra = {}): RectNode {
  return { ...baseOf(id, x, y, w, h, style, extra), kind: "rect" };
}

function ellipse(
  id: NodeId,
  x: number,
  y: number,
  w: number,
  h: number,
  style: StyleMap = {},
  extra: NodeExtra & { inner?: number; start?: number; sweep?: number } = {},
): EllipseNode {
  return {
    ...baseOf(id, x, y, w, h, style, extra),
    kind: "ellipse",
    ...(extra.inner !== undefined ? { inner: extra.inner } : {}),
    ...(extra.start !== undefined ? { start: extra.start } : {}),
    ...(extra.sweep !== undefined ? { sweep: extra.sweep } : {}),
  };
}

function text(id: NodeId, x: number, y: number, w: number, h: number, style: StyleMap = {}, extra: NodeExtra = {}): TextNode {
  return { ...baseOf(id, x, y, w, h, style, extra), kind: "text" };
}

function pathNode(id: NodeId, x: number, y: number, w: number, h: number, d: string, style: StyleMap = {}, extra: NodeExtra = {}): PathNode {
  return { ...baseOf(id, x, y, w, h, style, extra), kind: "path", d };
}

function group(
  id: NodeId,
  x: number,
  y: number,
  w: number,
  h: number,
  children: SceneNode[],
  style: StyleMap = {},
  extra: NodeExtra & { op?: GroupNode["op"] } = {},
): GroupNode {
  return {
    ...baseOf(id, x, y, w, h, style, extra),
    kind: "group",
    children,
    ...(extra.op !== undefined ? { op: extra.op } : {}),
  };
}

/**
 * A band root, as every diagram is stored now: no width, and a height that
 * already holds the content. The harness mounts through the diagram reader,
 * which would move an old root's content to fit the band — and every probe's
 * point with it.
 */
function scene(h: number, nodes: SceneNode[], opts: { id?: string; edges?: Scene["edges"]; style?: StyleMap } = {}): Scene {
  return {
    w: 0,
    h,
    style: opts.style ?? { background: "#fff" },
    nodes,
    edges: opts.edges ?? [],
    ...(opts.id ? { id: opts.id } : {}),
    attrs: {},
  };
}

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type FixtureName =
  | "nested-flex"
  | "pick-hollow-rect"
  | "pick-ring-hole"
  | "pick-clipped-child"
  | "pick-rotated-group"
  | "pick-stroke-path"
  | "pick-painted-padding"
  | "pick-three-layers"
  | "pick-locked-hidden"
  | "pick-dupe-name"
  | "pick-all";

/** `html` is always `serializeScene(scene)` — never authored by hand. */
export interface Fixture {
  name: FixtureName;
  scene: Scene;
  html: string;
}

function fixtureFrom(name: FixtureName, built: Scene): Fixture {
  return { name, scene: built, html: serializeScene(built) };
}

/** Screen px of grab slack the probes assume — `scene/picking.ts`'s own,
 *  real export (build-plan §2.2 #4), re-exported here so a probe-table
 *  consumer that wants the tolerance a `zoom` implies never hand-derives
 *  `HIT_SLOP_PX / zoom` a second, driftable way. */
export { HIT_SLOP_PX, slopFor } from "@/app/components/editor/canvas/scene/picking";

/**
 * The document scales a probe runs at: a phone's band, 1, and the most a page
 * zooms in. A diagram has no zoom of its own — `look()` scales the page.
 */
export const PICK_ZOOMS = [0.5, 1, 2] as const;

// ---------------------------------------------------------------------------
// nested-flex — the layout-agreement fixture (§3.2.3)
// ---------------------------------------------------------------------------

function nestedFlex(): Fixture {
  // Children of an auto-layout group are positioned by the layout engine, so
  // their authored x/y is a placeholder the round trip also produces: 0, 0.
  const r1 = rect("r1", 0, 0, 60, 40);
  const r2 = rect("r2", 0, 0, 90, 40);
  const r3 = rect("r3", 0, 0, 60, 60);
  const ghost = rect("ghost", 0, 0, 40, 40, {}, { hidden: true });
  // `height` is deliberately absent, not `"fit-content"`: a group whose
  // stretch axis is ALSO hugging its own content is a combination Figma's
  // own editor never lets you create (children set to "Fill container" are
  // only offered once the frame's cross-axis sizing is "Fixed"), and for
  // good reason — CSS cannot resolve it either. `ShapeView`'s `isAutoSize`
  // only swaps in the literal `fit-content` keyword for a `width`/`height`
  // that says so; leave the key out and it falls back to the group's own
  // measured pixel size (`boxStyle`'s `flow === "stretch-y" ? "auto" : …`
  // branch — resolved here at `rowSize.h`), which is the only value real
  // `align-items: stretch` has anything to stretch its empty children
  // against. Confirmed empirically: with `height: "fit-content"` still in
  // place, Chromium computes `row`'s own height as 0 (a flex container
  // hugging its cross size sizes it from each item's PRE-stretch
  // hypothetical size, which for a content-less `<div>` with `height: auto`
  // is 0 — nothing is left to stretch afterwards) — collapsing every
  // descendant below it and failing `picking.layout.agreement`. `width`
  // stays `"fit-content"`: that axis genuinely hugs correctly, since every
  // child's width is an explicit pixel value the browser can sum without
  // ever touching content size.
  const rowSize = measureGroup(
    group("row", 0, 0, 0, 0, [r1, r2, r3, ghost], {
      display: "flex",
      gap: "8px",
      "align-items": "stretch",
      width: "fit-content",
    }),
  );
  const row = group("row", 0, 0, rowSize.w, rowSize.h, [r1, r2, r3, ghost], {
    display: "flex",
    gap: "8px",
    "align-items": "stretch",
    width: "fit-content",
  });

  const p1 = rect("p1", 0, 0, 50, 30);
  // Pinned: keeps its own x/y (here, the origin — see the header note on why
  // this fixture cannot author a non-zero pinned position and still round-trip).
  const p2 = rect("p2", 0, 0, 50, 30, { position: "absolute" });
  const pinned = group("pinned", 0, 0, 220, 60, [p1, p2], { display: "flex", gap: "8px", padding: "8px" });

  const title = text("title", 0, 0, 200, 24, { "font-size": "14px" }, { label: "Nested flex" });
  const outerSize = measureGroup(
    group("outer", 0, 0, 0, 0, [title, row, pinned], {
      display: "flex",
      "flex-direction": "column",
      gap: "12px",
      padding: "16px",
      width: "fit-content",
      height: "fit-content",
      background: "#f5f5f4",
    }),
  );
  const outer = group("outer", 200, 120, outerSize.w, outerSize.h, [title, row, pinned], {
    display: "flex",
    "flex-direction": "column",
    gap: "12px",
    padding: "16px",
    width: "fit-content",
    height: "fit-content",
    background: "#f5f5f4",
  });

  return fixtureFrom("nested-flex", scene(400, [outer], { id: "nested-flex" }));
}

// ---------------------------------------------------------------------------
// The nine picking regions (§3.2.1) — each a factory, so pick-all and the
// standalone pick-* fixtures build fresh, independent node trees rather than
// sharing object identity across two different scenes. Stacked down one
// column band (x in [0, 720]), as a diagram on the page is laid out.
// ---------------------------------------------------------------------------

/** The lowest region's bottom (the dupe pair's, 3004) and a band below it. */
const PICK_H = 3004 + BAND;

function hollowRectRegion(): SceneNode[] {
  return [
    rect("btn", 100, 100, 200, 80, { background: "#ddd", "border-radius": "8px" }, { label: "Button" }),
    rect("hollow", 60, 60, 400, 300, { border: "4px solid #333" }),
  ];
}

function ringHoleRegion(): SceneNode[] {
  return [
    rect("under", 160, 540, 200, 200, { background: "#fbbf24" }),
    ellipse("ring", 60, 440, 400, 400, { background: "#6366f1" }, { inner: 0.5 }),
  ];
}

function clippedChildRegion(): SceneNode[] {
  return [
    group(
      "clip",
      100,
      920,
      300,
      200,
      [rect("esc", 250, 50, 200, 100, { background: "#f87171" })],
      { overflow: "hidden", background: "#eee" },
    ),
  ];
}

function rotatedGroupRegion(): SceneNode[] {
  return [
    group(
      "rg",
      90,
      1262,
      300,
      200,
      [
        rect("ra", 0, 0, 120, 80, { background: "#ef4444" }),
        rect("rb", 180, 120, 120, 80, { background: "#3b82f6" }),
      ],
      {},
      { rot: 30 },
    ),
  ];
}

function strokePathRegion(): SceneNode[] {
  return [
    pathNode("pth", 60, 1604, 300, 200, "M 0 0 C 100 200 200 0 300 200", {
      fill: "none",
      stroke: "#111",
      "stroke-width": "6",
    }),
  ];
}

function paintedPaddingRegion(): SceneNode[] {
  // Flex children: authored x/y are placeholders the layout engine (and, in
  // the browser, the harness's `laidRect`) replaces — see the header note.
  return [
    group(
      "card",
      100,
      1884,
      400,
      160,
      [
        rect("c1", 0, 0, 100, 100, { background: "#fca5a5" }),
        rect("c2", 0, 0, 100, 100, { background: "#93c5fd" }),
        rect("c3", 0, 0, 100, 100, { background: "#86efac" }),
      ],
      { display: "flex", gap: "16px", padding: "24px", background: "#fff", border: "1px solid #ccc" },
    ),
  ];
}

function threeLayersRegion(): SceneNode[] {
  return [
    rect("L1", 60, 2124, 300, 200, { background: "#e5e7eb" }, { name: "Back" }),
    rect("L2", 160, 2174, 300, 200, { background: "#9ca3af" }, { name: "Middle" }),
    rect("L3", 260, 2224, 300, 200, { background: "#4b5563" }, { name: "Front" }),
  ];
}

function layersLockedRegion(): SceneNode[] {
  return [
    rect("hbase", 470, 2504, 250, 150, { background: "#a3e635" }),
    rect("hlock", 470, 2504, 250, 150, { background: "#facc15" }, { locked: true }),
    rect("hhide", 570, 2624, 150, 140, { background: "#f472b6" }, { hidden: true }),
  ];
}

function layersDupeNameRegion(): SceneNode[] {
  return [
    rect("d1", 300, 2744, 260, 200, { background: "#fda4af" }, { name: "Rectangle" }),
    rect("d2", 400, 2804, 260, 200, { background: "#fdba74" }, { name: "Rectangle" }),
  ];
}

/** Every standalone `pick-*` region fixture shares `pick-all`'s band height
 *   so its absolute coordinates need no re-basing — "own scene" just
 *  means a distinct `Scene` object holding only that region's nodes. */
function regionFixture(name: FixtureName, nodes: SceneNode[]): Fixture {
  return fixtureFrom(name, scene(PICK_H, nodes, { id: name }));
}

function pickAll(): Fixture {
  const nodes: SceneNode[] = [
    ...hollowRectRegion(),
    ...ringHoleRegion(),
    ...clippedChildRegion(),
    ...rotatedGroupRegion(),
    ...strokePathRegion(),
    ...paintedPaddingRegion(),
    ...threeLayersRegion(),
    ...layersLockedRegion(),
    ...layersDupeNameRegion(),
  ];
  return fixtureFrom("pick-all", scene(PICK_H, nodes, { id: "pick" }));
}

// ---------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------

export const FIXTURES: Readonly<Record<FixtureName, Fixture>> = {
  "nested-flex": nestedFlex(),
  "pick-hollow-rect": regionFixture("pick-hollow-rect", hollowRectRegion()),
  "pick-ring-hole": regionFixture("pick-ring-hole", ringHoleRegion()),
  "pick-clipped-child": regionFixture("pick-clipped-child", clippedChildRegion()),
  "pick-rotated-group": regionFixture("pick-rotated-group", rotatedGroupRegion()),
  "pick-stroke-path": regionFixture("pick-stroke-path", strokePathRegion()),
  "pick-painted-padding": regionFixture("pick-painted-padding", paintedPaddingRegion()),
  "pick-three-layers": regionFixture("pick-three-layers", threeLayersRegion()),
  "pick-locked-hidden": regionFixture("pick-locked-hidden", layersLockedRegion()),
  "pick-dupe-name": regionFixture("pick-dupe-name", layersDupeNameRegion()),
  "pick-all": pickAll(),
};

// Re-export so a probe-table consumer never has to import `autoLayout`
// directly just to resolve a `{node, at: "centre"}` anchor for itself.
export { laidOutScene };

// ---------------------------------------------------------------------------
// PICKING_PROBES (§3.2.2)
// ---------------------------------------------------------------------------

export type ProbeAnchor = Point | { node: NodeId; at: "centre" };

export type ProbeAction = "click" | "shiftClick" | "cmdClick" | "altClick" | "hover" | "candidates" | "layerMenu" | "layerMenuPick";

export interface Probe {
  /** e.g. `"hollow.button.cmd"`. */
  id: string;
  fixture: FixtureName;
  /** Scene px, or a laid node's centre. More than one entry only for a
   *  multi-point gesture (`shiftClick`); `look()` centres on their bounding box. */
  where: ProbeAnchor | readonly ProbeAnchor[];
  action: ProbeAction;
  /** `layerMenuPick` only: row index, 0 = frontmost. */
  pick?: number;
  /**
   * `layerMenu` only, and only to assert the menu does NOT open: when present
   * and `false`, the runner checks `contextMenu().open === false` directly and
   * ignores `expect`/`today` (they carry no menu-row information in this
   * case). Absent (the default) means the normal `layerMenu` semantics.
   */
  menuOpen?: false;
  /** Selection ids after the action (`[]` = nothing); `candidates`: ids
   *  front→back; `layerMenu`: row ids front→back. */
  expect: readonly NodeId[];
  /** What `main` does today; `"n/a"` when the surface does not exist yet. */
  today: readonly NodeId[] | "n/a";
  /**
   * Set iff `expect !== today`. Attribution: simulate PICK landing alone
   * (painted geometry + clipping, SELECT's `metaKey → deep` NOT wired) and
   * re-check `expect` against that intermediate result. If `expect` is
   * already reached, `xfail: "PICK"`. Only if the chain still has ≥2 entries
   * and click vs. the deep variant still differ does `xfail: "SELECT"`
   * apply — `fixtures.pickAll.xfailReasons` (canvas-fixtures.test.ts)
   * mechanically re-derives this so the tag can't drift from the code the
   * way `hollow.button.cmd`/`clip.outside.cmd` once did (see the review-notes
   * table at the top of HARNESS.md).
   */
  xfail?: "PICK" | "SELECT";
  /** Default `false`; `mount(fixture, { readOnly: true })` when set. */
  readOnly?: boolean;
  /**
   * The Figma-actual answer is unresolved. `expect` is a placeholder best
   * guess, never compared — the runner routes this probe through `todo(id)`,
   * not `check`/`xfail`.
   */
  verify?: true;
  /** Default {@link PICK_ZOOMS}; a probe whose `where` is multi-point must
   *  exclude any zoom whose viewport is smaller than its points' bounding box. */
  zooms?: readonly number[];
  /** The reason `today` differs, or (for a `verify`/`menuOpen:false` probe)
   *  the reason it is exempt from the expect/today equality check. */
  note?: string;
}

const centre = (node: NodeId): ProbeAnchor => ({ node, at: "centre" });

export const PICKING_PROBES: readonly Probe[] = [
  // -- hollow-rect --------------------------------------------------------
  {
    id: "hollow.button.click",
    fixture: "pick-all",
    where: { x: 200, y: 140 },
    action: "click",
    expect: ["btn"],
    today: ["btn"],
    note: "frame is hollow (border only); the click falls through to the button behind it",
  },
  {
    id: "hollow.button.cmd",
    fixture: "pick-all",
    where: { x: 200, y: 140 },
    action: "cmdClick",
    expect: ["btn"],
    today: ["btn"],
    note:
      "pointerdown reads altKey only (SELECT not merged), so ⌘-click is a plain click here; hitTestPath(200,140) is " +
      "already the length-1 chain [btn], so deep is a no-op on it",
  },
  {
    id: "hollow.button.hover",
    fixture: "pick-all",
    where: { x: 200, y: 140 },
    action: "hover",
    expect: ["btn"],
    today: ["btn"],
  },
  {
    id: "hollow.button.candidates",
    fixture: "pick-all",
    where: { x: 200, y: 140 },
    action: "candidates",
    expect: ["btn"],
    today: ["btn"],
    note: "hollow is unpainted here",
  },
  {
    id: "hollow.border.click",
    fixture: "pick-all",
    where: { x: 260, y: 62 },
    action: "click",
    expect: ["hollow"],
    today: ["hollow"],
    note: "on the 4px border (y 60–64)",
  },
  {
    id: "hollow.empty.click",
    fixture: "pick-all",
    where: { x: 400, y: 300 },
    action: "click",
    expect: [],
    today: [],
    note: "interior, no paint",
  },
  {
    id: "hollow.empty.candidates",
    fixture: "pick-all",
    where: { x: 400, y: 300 },
    action: "candidates",
    expect: [],
    today: [],
    note: "hollow is unpainted here too, and nothing else is under the point",
  },

  // -- ring-hole ------------------------------------------------------------
  {
    id: "ring.hole.click",
    fixture: "pick-all",
    where: { x: 260, y: 640 },
    action: "click",
    expect: ["under"],
    today: ["under"],
    note: "ring's inner hole is not paint; the click falls through to under",
  },
  {
    id: "ring.hole.candidates",
    fixture: "pick-all",
    where: { x: 260, y: 640 },
    action: "candidates",
    expect: ["under"],
    today: ["under"],
    note: "under is the only painted node at the ring's centre",
  },
  {
    id: "ring.band.click",
    fixture: "pick-all",
    where: { x: 260, y: 460 },
    action: "click",
    expect: ["ring"],
    today: ["ring"],
    note: "180px from centre, inside the 100–200 band",
  },
  {
    id: "ring.band.candidates",
    fixture: "pick-all",
    where: { x: 260, y: 460 },
    action: "candidates",
    expect: ["ring"],
    today: ["ring"],
    note: "(260,460) is outside under (160–360 × 540–740), so only the band answers",
  },

  // -- clipped-child --------------------------------------------------------
  {
    id: "clip.outside.click",
    fixture: "pick-all",
    where: { x: 500, y: 1020 },
    action: "click",
    expect: [],
    today: [],
    note: "esc's box reaches past the clip edge, but the clipping group's own box does not — clipped out",
  },
  {
    id: "clip.outside.cmd",
    fixture: "pick-all",
    where: { x: 500, y: 1020 },
    action: "cmdClick",
    expect: [],
    today: [],
    note: "hitTestPath(500,600) is an empty chain; click/hitTest return null for it regardless of deep",
  },
  {
    id: "clip.inside.click",
    fixture: "pick-all",
    where: { x: 400, y: 1020 },
    action: "click",
    expect: ["clip"],
    today: ["clip"],
    note: "inside both group and child; outermost wins",
  },
  {
    id: "clip.inside.cmd",
    fixture: "pick-all",
    where: { x: 400, y: 1020 },
    action: "cmdClick",
    expect: ["esc"],
    today: ["esc"],
    note: "⌘→deep, wired by SELECT: the chain [clip, esc] resolves to its leaf",
  },
  // `clip.inside.alt` documented Alt = deep on main; deleted here, per its own
  // note, now that SELECT has released Alt to duplicate-on-drag only (C12:
  // Alt+click reads as a plain click — see `select.deep.alt-click-is-plain`
  // in `tests/canvas-select.browser.mjs`).

  // -- rotated-group --------------------------------------------------------
  {
    id: "rot.ra.click",
    fixture: "pick-all",
    where: centre("ra"),
    action: "click",
    expect: ["rg"],
    today: ["rg"],
    note: "rotation-correct (toLocal)",
  },
  {
    id: "rot.ra.cmd",
    fixture: "pick-all",
    where: centre("ra"),
    action: "cmdClick",
    expect: ["ra"],
    today: ["ra"],
    note: "⌘→deep, wired by SELECT: the chain [rg, ra] resolves to its leaf",
  },
  {
    id: "rot.gap.click",
    fixture: "pick-all",
    where: { x: 240, y: 1362 },
    action: "click",
    expect: [],
    today: [],
    note: "group centre, between children, unpainted group",
  },
  {
    id: "rot.aabb.click",
    fixture: "pick-all",
    where: { x: 60, y: 1352 },
    action: "click",
    expect: [],
    today: [],
    note: "inside the group's AABB, outside its rotated box",
  },

  // -- stroke-path ------------------------------------------------------------
  {
    id: "path.curve.click",
    fixture: "pick-all",
    where: { x: 210, y: 1704 },
    action: "click",
    expect: ["pth"],
    today: ["pth"],
    note: "on the curve (t = 0.5)",
  },
  {
    id: "path.off.click",
    fixture: "pick-all",
    where: { x: 65, y: 1799 },
    action: "click",
    expect: [],
    today: [],
    note: "in the box, 700+ px from the curve — outside stroke tolerance at every zoom",
  },
  {
    id: "path.off.candidates",
    fixture: "pick-all",
    where: { x: 65, y: 1799 },
    action: "candidates",
    expect: [],
    today: [],
    note: "outside stroke tolerance; the curve, not the box, is what's measured",
  },

  // -- painted-padding ----------------------------------------------------
  {
    id: "card.padding.click",
    fixture: "pick-all",
    where: { x: 110, y: 1894 },
    action: "click",
    expect: ["card"],
    today: ["card"],
    note: "painted group's padding",
  },
  {
    id: "card.padding.cmd",
    fixture: "pick-all",
    where: { x: 110, y: 1894 },
    action: "cmdClick",
    expect: [],
    today: [],
    note:
      "SELECT's marqueeThroughTarget (Q6): a Mod-press on a painted, non-boolean container's own padding arms a " +
      "marquee-through-the-frame gesture on pointerdown, before any click/select decision — released with zero " +
      "movement, that is a marquee with an empty rect (commit([], [card])), not a deep-select of the container",
  },
  {
    id: "card.c2.click",
    fixture: "pick-all",
    where: centre("c2"),
    action: "click",
    expect: ["card"],
    today: ["card"],
  },
  {
    id: "card.c2.cmd",
    fixture: "pick-all",
    where: centre("c2"),
    action: "cmdClick",
    expect: ["c2"],
    today: ["c2"],
    note: "⌘→deep, wired by SELECT: the chain [card, c2] resolves to its leaf",
  },
  {
    id: "card.c2.candidates",
    fixture: "pick-all",
    where: centre("c2"),
    action: "candidates",
    expect: ["c2", "card"],
    today: ["c2", "card"],
    note: "the deepest painted node is c2 itself, with the painted card behind it",
  },

  // -- three-layers -----------------------------------------------------------
  {
    id: "layers.all.click",
    fixture: "pick-all",
    where: { x: 310, y: 2274 },
    action: "click",
    expect: ["L3"],
    today: ["L3"],
  },
  {
    id: "layers.all.shift",
    fixture: "pick-all",
    where: [{ x: 310, y: 2274 }, { x: 110, y: 2154 }],
    action: "shiftClick",
    expect: ["L1", "L3"],
    today: ["L1", "L3"],
    note: "document order",
  },
  {
    id: "layers.all.candidates",
    fixture: "pick-all",
    where: { x: 310, y: 2274 },
    action: "candidates",
    expect: ["L3", "L2", "L1"],
    today: ["L3", "L2", "L1"],
    note: "all three rects are painted and overlap at this point, front to back",
  },
  {
    id: "layers.all.menu",
    fixture: "pick-all",
    where: { x: 310, y: 2274 },
    action: "layerMenu",
    expect: ["L3", "L2", "L1"],
    today: ["L3", "L2", "L1"],
    note: "\"Select layer ▸\", via ⌘+right-click",
  },
  {
    id: "layers.back.pick",
    fixture: "pick-all",
    where: { x: 310, y: 2274 },
    action: "layerMenuPick",
    pick: 2,
    // The menu is fixed-position inside the zoomed column, so at 2 it opens
    // twice as far from the pointer and off the page, until it is portalled
    // out of the column with document zoom.
    zooms: [0.5, 1],
    expect: ["L1"],
    today: ["L1"],
    note: "select-behind, via ⌘+right-click",
  },
  {
    id: "layers.only1.click",
    fixture: "pick-all",
    where: { x: 110, y: 2154 },
    action: "click",
    expect: ["L1"],
    today: ["L1"],
  },

  // -- layers-locked ----------------------------------------------------------
  {
    id: "layers.locked.click",
    fixture: "pick-all",
    where: { x: 540, y: 2579 },
    action: "click",
    expect: ["hbase"],
    // Already true on main, no xfail: `hitChain` (scene/geometry.ts) skips
    // `node.locked && !opts.includeLocked` outright — a locked leaf is
    // click-through today, not merely unselected once clicked. Confirmed by
    // running this probe for real (tests/canvas-picking.browser.mjs) rather
    // than assumed — the browser runner is the first thing to have ever
    // exercised it, and it XPASSed against the original `xfail: "PICK"`
    // guess (locked/hidden exclusion was mistaken for one of PICK's paint-
    // policy additions; it predates this initiative entirely).
    today: ["hbase"],
    note: "locked hlock fully covers hbase and is on top in document order; a locked leaf is click-through",
  },
  {
    id: "layers.locked.candidates",
    fixture: "pick-all",
    where: { x: 540, y: 2579 },
    action: "candidates",
    expect: ["hbase"],
    today: ["hbase"],
    note: "hlock excluded from the candidate list, not merely unselected",
  },
  {
    id: "layers.hidden.candidates",
    fixture: "pick-all",
    where: { x: 620, y: 2699 },
    action: "candidates",
    expect: [],
    today: [],
    note: "a hidden node is never hit, so candidates is empty, not [hhide]",
  },
  {
    id: "layers.hidden.hover",
    fixture: "pick-all",
    where: { x: 620, y: 2699 },
    action: "hover",
    expect: [],
    // Already true on main, no xfail needed even before PICK landed — same
    // correction as `layers.locked.click` above and for the same reason:
    // `hitChain` already skipped `node.hidden` outright, so a hidden node was
    // never reachable by hover either.
    today: [],
    note: "hoverId must not resolve to a hidden node",
  },
  {
    id: "layers.locked.menu",
    fixture: "pick-all",
    where: { x: 540, y: 2579 },
    action: "layerMenu",
    expect: ["hbase", "hlock"],
    today: "n/a",
    verify: true,
    note:
      "does \"Select layer ▸\" list a locked layer at all (so it can be selected-then-unlocked), or exclude it the " +
      "way a plain click does? Unresolved against a live Figma file",
  },

  // -- layers-dupe-name -------------------------------------------------------
  {
    id: "layers.dupe.menu",
    fixture: "pick-all",
    where: { x: 460, y: 2874 },
    action: "layerMenu",
    expect: ["d2", "d1"],
    today: ["d2", "d1"],
    note: "both nodes named \"Rectangle\"; disambiguated by id suffix, not [\"Rectangle\",\"Rectangle\"]",
  },

  // -- read-only mode -----------------------------------------------------
  {
    id: "layers.readOnly.hover",
    fixture: "pick-all",
    where: { x: 200, y: 140 },
    action: "hover",
    expect: ["btn"],
    today: ["btn"],
    readOnly: true,
    note:
      "onPointerMove reads deep: readOnly || event.altKey, so read-only hover is already deep here with no Alt/Meta " +
      "held; reuses hollow.button's point to prove the paint policy is independent of ⌘-deep wiring",
  },
  {
    id: "layers.readOnly.contextMenu",
    fixture: "pick-all",
    where: { x: 310, y: 2274 },
    action: "layerMenu",
    menuOpen: false,
    expect: [],
    today: "n/a",
    readOnly: true,
    note: "onContextMenu is undefined in read-only mode; already holds on main, so no xfail",
  },
];

/** Reusable read-only lookup: does `where` name a node? */
export function anchorNode(where: ProbeAnchor): NodeId | null {
  return "node" in where ? where.node : null;
}

/** The ids of every shape in a serialized scene — never the root's, never an edge's. */
export function shapeIdsIn(html: string): Set<string> {
  return new Set(
    [...html.matchAll(/<nt-(?!diagram\b|edge\b)[a-z]+\b[^>]*\sid="([^"]*)"/g)].map((m) => m[1]),
  );
}
