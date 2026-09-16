/**
 * The SELECT.md §3 fixture, as one source of truth: `SELECT_FIXTURE` for
 * vitest (`engine/useSelection.test.ts`) and `SELECT_FIXTURE_HTML` for the
 * browser harness (`tests/canvas-select.browser.mjs`) — the same literal, so
 * the two suites can never drift apart.
 *
 * All coordinates below are the diagram's **scene-space** positions; each
 * node's own `x`/`y` (parent-local) is that position minus its parent's
 * scene-space origin.
 *
 * ```
 * F  group "Card" 0,0 300,200 style background:#eee overflow:hidden       (painted frame)
 *   ├ A rect "Title" 20,20 200,30 (label "Title")
 *   ├ G group "Row" 20,80 260,60 (plain, unpainted)
 *   │   ├ B rect "Button" 20,80 100,40 background:#08f
 *   │   ├ C ellipse "Dot" 140,90 20,20 background:#f80
 *   │   └ K boolean "Icon" 170,95 30,30 op:"subtract"    (painted; compound of two operands)
 *   │       ├ K1 path "IconBase" 170,95 30,30 (full box)
 *   │       └ K2 path "IconHole" 178,103 14,14 (subtracted)
 *   └ D rect "Ring" 200,20 80,60 border:2px solid #000 (no background — hollow)
 * E  text "Note" 320,20 100,30 (top level, behind nothing)
 * P  path "Wave" 320,100 100,60 stroke-only
 * L  rect "Locked" 0,150 300,50 background:#ccc locked
 * ```
 */

import { serializeScene } from "../scene/serialize";
import type { Scene, SceneNode, StyleMap } from "../scene/types";

const K1_PATH = "M 0 0 L 30 0 L 30 30 L 0 30 Z";
const K2_PATH = "M 0 0 L 14 0 L 14 14 L 0 14 Z";
const WAVE_PATH = "M 0 30 C 25 0 75 60 100 30";

// `name` is the layers-panel override (`displayName()`'s first choice);
// `label` is real rendered TEXT CONTENT, which only `A` (explicitly labelled
// per the diagram) and `E` (a text node — a `text` kind's whole point) carry.
// Every other node's `label` stays `""` so it is never content-hittable by
// PICK's `contentHit` — the diagram's quoted names are display names, not
// authored text.

const k1: SceneNode = {
  id: "K1",
  kind: "path",
  x: 0,
  y: 0,
  w: 30,
  h: 30,
  rot: 0,
  style: {},
  name: "IconBase",
  label: "",
  locked: false,
  hidden: false,
  attrs: {},
  d: K1_PATH,
};

const k2: SceneNode = {
  id: "K2",
  kind: "path",
  x: 8,
  y: 8,
  w: 14,
  h: 14,
  rot: 0,
  style: {},
  name: "IconHole",
  label: "",
  locked: false,
  hidden: false,
  attrs: {},
  d: K2_PATH,
};

const K: SceneNode = {
  id: "K",
  kind: "group",
  x: 150,
  y: 15,
  w: 30,
  h: 30,
  rot: 0,
  // A boolean group paints its derived region — it needs a real fill to be
  // "painted" at all, same as any other drawn kind.
  style: { background: "#333" },
  name: "Icon",
  label: "",
  locked: false,
  hidden: false,
  attrs: {},
  children: [k1, k2],
  op: "subtract",
};

const B: SceneNode = {
  id: "B",
  kind: "rect",
  x: 0,
  y: 0,
  w: 100,
  h: 40,
  rot: 0,
  style: { background: "#08f" },
  name: "Button",
  label: "",
  locked: false,
  hidden: false,
  attrs: {},
};

const C: SceneNode = {
  id: "C",
  kind: "ellipse",
  x: 120,
  y: 10,
  w: 20,
  h: 20,
  rot: 0,
  style: { background: "#f80" },
  name: "Dot",
  label: "",
  locked: false,
  hidden: false,
  attrs: {},
};

const G: SceneNode = {
  id: "G",
  kind: "group",
  x: 20,
  y: 80,
  w: 260,
  h: 60,
  rot: 0,
  style: {},
  name: "Row",
  label: "",
  locked: false,
  hidden: false,
  attrs: {},
  children: [B, C, K],
};

const A: SceneNode = {
  id: "A",
  kind: "rect",
  x: 20,
  y: 20,
  w: 200,
  h: 30,
  rot: 0,
  style: {},
  name: "Title",
  label: "Title",
  locked: false,
  hidden: false,
  attrs: {},
};

const D: SceneNode = {
  id: "D",
  kind: "rect",
  x: 200,
  y: 20,
  w: 80,
  h: 60,
  rot: 0,
  style: { border: "2px solid #000" },
  name: "Ring",
  label: "",
  locked: false,
  hidden: false,
  attrs: {},
};

const F: SceneNode = {
  id: "F",
  kind: "group",
  x: 0,
  y: 0,
  w: 300,
  h: 200,
  rot: 0,
  style: { background: "#eee", overflow: "hidden" } as StyleMap,
  name: "Card",
  label: "",
  locked: false,
  hidden: false,
  attrs: {},
  children: [A, G, D],
};

const E: SceneNode = {
  id: "E",
  kind: "text",
  x: 320,
  y: 20,
  w: 100,
  h: 30,
  rot: 0,
  style: {},
  label: "Note",
  locked: false,
  hidden: false,
  attrs: {},
};

const P: SceneNode = {
  id: "P",
  kind: "path",
  x: 320,
  y: 100,
  w: 100,
  h: 60,
  rot: 0,
  style: { stroke: "#000", "stroke-width": "2" },
  name: "Wave",
  label: "",
  locked: false,
  hidden: false,
  attrs: {},
  d: WAVE_PATH,
};

const L: SceneNode = {
  id: "L",
  kind: "rect",
  x: 0,
  y: 150,
  w: 300,
  h: 50,
  rot: 0,
  style: { background: "#ccc" },
  name: "Locked",
  label: "",
  locked: true,
  hidden: false,
  attrs: {},
};

/** Back-to-front document order, as every scene is stored. */
export const SELECT_FIXTURE: SceneNode[] = [F, E, P, L];

const SELECT_SCENE: Scene = {
  w: 480,
  h: 260,
  style: {},
  nodes: SELECT_FIXTURE,
  edges: [],
  attrs: {},
};

/** The same fixture, serialized — mounted by `tests/canvas-select.browser.mjs`
 *  via `window.canvasHarness.mount({ html: SELECT_FIXTURE_HTML })` so the
 *  vitest and browser suites never drift apart. */
export const SELECT_FIXTURE_HTML: string = serializeScene(SELECT_SCENE);

/**
 * Two disjoint top-level rects, fully overlapping the same box — X (front)
 * and Y (back). Used only by `tests/canvas-select.browser.mjs`'s
 * frontmost-pre-select case (review #8, M15): select Y, then right-click the
 * overlap — the pre-select guard must read the FRONTMOST candidate's chain
 * only (X's), never fall back to "some candidate is already selected" (Y's),
 * or an occluded selected shape would suppress the pre-select a plain
 * left-click at the same point would do.
 */
const OVERLAP_X: SceneNode = {
  id: "X",
  kind: "rect",
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  rot: 0,
  style: { background: "#f80" },
  name: "X",
  label: "",
  locked: false,
  hidden: false,
  attrs: {},
};

const OVERLAP_Y: SceneNode = {
  id: "Y",
  kind: "rect",
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  rot: 0,
  style: { background: "#08f" },
  name: "Y",
  label: "",
  locked: false,
  hidden: false,
  attrs: {},
};

export const OVERLAP_FIXTURE_HTML: string = serializeScene({
  w: 200,
  h: 200,
  style: {},
  nodes: [OVERLAP_Y, OVERLAP_X],
  edges: [],
  attrs: {},
});
