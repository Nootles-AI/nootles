/**
 * Loading a canvas block's stored source, whatever generation wrote it.
 *
 * Blocks written before the DOM canvas hold React Flow JSON —
 * `{ nodes: [{ id, position, width, height, data: { label, shape } }], edges }`.
 * Blocks written since hold canvas HTML. One function reads both, so the block
 * never has to know which era its content came from and there is no separate
 * migration pass to run.
 *
 * Two things the old format says that the new one says differently:
 *
 *  - **`position` is a centre, not a corner.** The old canvas ran React Flow
 *    with `nodeOrigin={[0.5, 0.5]}`, so a node's stored position is the middle
 *    of its box; `x`/`y` here are the top-left. Reading it as a corner shifts
 *    every shape by half its size.
 *  - **Appearance was a stylesheet, not data.** The old shapes were styled
 *    entirely by `canvas.css`, and the grammar has no classes — so the look has
 *    to be written out as the inline CSS it becomes. The literal values below
 *    are the resolved `canvas.css` ones, so a migrated diagram is the same
 *    diagram.
 *
 * **Edges are preserved, never destroyed.** This pass has no connectors, so
 * there is nowhere to put them — but a document that had them keeps them,
 * verbatim, in a `data-legacy-edges` attribute on the surface, which the parser
 * and serializer round-trip untouched. Whenever connectors arrive, the data is
 * still there to read.
 */

import { mintIds } from "./ops";
import { parseScene, type ParseHtml } from "./parse";
import type { Scene, SceneEdge, SceneNode, StyleMap } from "./types";

/** A blank surface, in the size the grammar's examples use. */
export const DEFAULT_SCENE_W = 960;
export const DEFAULT_SCENE_H = 540;

/** Breathing room left around migrated content, and the amount the content is
 *  shifted by so that a diagram authored at negative coordinates lands on the
 *  surface. */
const PADDING = 40;

// Resolved from canvas.css so the migrated shapes are the shapes that were
// there. `--background`, `--shape-line`, `--foreground`.
const SURFACE = "oklch(1 0 90)";
const LINE = "oklch(0.865 0.004 90)";
const INK = "oklch(0.25 0.005 90)";
const SHADOW = "0 1px 2px rgb(20 15 40 / 0.06), 0 4px 12px rgb(20 15 40 / 0.05)";

/** The old label was a centred flex child; the grammar implies no layout. */
const CENTRED: StyleMap = {
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  "text-align": "center",
};

const DIAMOND_CLIP = "polygon(50% 0,100% 50%,50% 100%,0 50%)";

type LegacyShape = "rectangle" | "ellipse" | "diamond" | "text";

/** Default box per shape, from the old canvas — React Flow measured unsized
 *  nodes at render time, so a persisted node may have no width or height. */
const LEGACY_SIZE: Record<LegacyShape, { w: number; h: number }> = {
  rectangle: { w: 148, h: 64 },
  ellipse: { w: 140, h: 96 },
  diamond: { w: 128, h: 96 },
  text: { w: 120, h: 40 },
};

export type CanvasFormat = "html" | "legacy" | "empty";

/**
 * Which generation wrote this source. `"empty"` covers both a blank block and
 * a source that is neither — there is nothing to recover from a string that
 * parses as neither HTML nor JSON, and throwing would take the page with it.
 */
export function detectCanvasFormat(source: string): CanvasFormat {
  const trimmed = source.trim();
  if (!trimmed) return "empty";
  if (trimmed.startsWith("<")) return "html";
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? "legacy" : "empty";
  } catch {
    return "empty";
  }
}

/** A blank canvas — also what an unreadable source falls back to. */
export function emptyScene(): Scene {
  return {
    w: DEFAULT_SCENE_W,
    h: DEFAULT_SCENE_H,
    style: {},
    nodes: [],
    edges: [],
    attrs: {},
  };
}

/**
 * Stored source → `Scene`, for either format. `parseHtml` is forwarded to
 * {@link parseScene} for callers without a DOM (the round-trip harness).
 */
export function migrateLegacyCanvas(
  source: string,
  parseHtml?: ParseHtml,
): Scene {
  switch (detectCanvasFormat(source)) {
    case "html":
      return parseScene(source, parseHtml);
    case "legacy":
      return fromLegacyJson(source);
    case "empty":
      return emptyScene();
  }
}

function fromLegacyJson(source: string): Scene {
  const doc: unknown = JSON.parse(source);
  if (!isRecord(doc)) return emptyScene();
  const legacyNodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const edges = Array.isArray(doc.edges) ? doc.edges : [];

  const nodes: SceneNode[] = [];
  const taken = new Set<string>();
  for (const raw of legacyNodes) {
    if (!isRecord(raw)) continue;
    const node = toSceneNode(raw);
    if (taken.has(node.id)) node.id = "";
    else taken.add(node.id);
    nodes.push(node);
  }
  // Ids are assigned after the whole list is known, so a minted id cannot
  // collide with a legacy one further down. An id only goes missing on
  // corrupt data — where the edges naming it were already dangling.
  const blanks = nodes.filter((node) => node.id === "");
  if (blanks.length) {
    const fresh = mintIds(nodes, blanks.length);
    blanks.forEach((node, i) => {
      node.id = fresh[i];
    });
  }

  place(nodes);
  return {
    w: Math.max(DEFAULT_SCENE_W, Math.ceil(extent(nodes, "x"))),
    h: Math.max(DEFAULT_SCENE_H, Math.ceil(extent(nodes, "y"))),
    style: {},
    nodes,
    edges: toSceneEdges(edges, nodes),
    attrs: {},
  };
}

/**
 * The old graph's edges, which the model now has somewhere to put.
 *
 * They were parked verbatim in a `data-legacy-edges` attribute by the rewrite
 * that removed connectors — the note said "waiting for when connectors arrive",
 * and this is that. React Flow's `source`/`target` are node ids, which the
 * migration above preserves, so the only work is dropping the ends that no
 * longer name anything and carrying the label across.
 */
function toSceneEdges(raw: unknown[], nodes: readonly SceneNode[]): SceneEdge[] {
  const known = new Set(nodes.map((node) => node.id));
  const used = new Set<string>();
  const out: SceneEdge[] = [];
  let n = 0;

  for (const item of raw) {
    if (!isRecord(item)) continue;
    const from = typeof item.source === "string" ? item.source : "";
    const to = typeof item.target === "string" ? item.target : "";
    if (!known.has(from) || !known.has(to) || from === to) continue;

    const id = typeof item.id === "string" ? item.id : "";
    let edgeId = id && !used.has(id) && !known.has(id) ? id : "";
    while (!edgeId) {
      const fresh = `e${++n}`;
      if (!used.has(fresh) && !known.has(fresh)) edgeId = fresh;
    }
    used.add(edgeId);

    out.push({
      id: edgeId,
      from,
      to,
      label: typeof item.label === "string" ? item.label.trim() : "",
      style: {},
      attrs: {},
    });
  }
  return out;
}

function toSceneNode(raw: Record<string, unknown>): SceneNode {
  const data = isRecord(raw.data) ? raw.data : {};
  const shape = shapeOf(data.shape);
  const size = LEGACY_SIZE[shape];
  const w = positive(raw.width, size.w);
  const h = positive(raw.height, size.h);
  const position = isRecord(raw.position) ? raw.position : {};
  const base = {
    id: typeof raw.id === "string" && raw.id ? raw.id : "",
    // React Flow's nodeOrigin was [0.5, 0.5]: the stored point is the centre.
    x: number(position.x, 0) - w / 2,
    y: number(position.y, 0) - h / 2,
    w,
    h,
    rot: 0,
    label: typeof data.label === "string" ? data.label : "",
    locked: false,
    hidden: false,
    attrs: {},
  };

  switch (shape) {
    case "rectangle":
      return { ...base, kind: "rect", style: boxStyle({ "border-radius": "10px" }) };
    case "ellipse":
      return { ...base, kind: "ellipse", style: boxStyle() };
    case "diamond":
      return {
        ...base,
        kind: "rect",
        style: {
          background: SURFACE,
          "clip-path": DIAMOND_CLIP,
          // A clip-path cuts a border away with the corners, so the outline is
          // a drop-shadow — which follows the clip, as the old SVG's did.
          filter: `drop-shadow(0 0 1px ${LINE}) drop-shadow(0 4px 10px rgb(20 15 40 / 0.06))`,
          color: INK,
          "font-size": "13px",
          ...CENTRED,
        },
      };
    case "text":
      return {
        ...base,
        kind: "text",
        style: {
          color: INK,
          "font-size": "14px",
          "font-weight": "450",
          ...CENTRED,
        },
      };
  }
}

function boxStyle(extra: StyleMap = {}): StyleMap {
  return {
    background: SURFACE,
    border: `1.5px solid ${LINE}`,
    ...extra,
    "box-shadow": SHADOW,
    color: INK,
    "font-size": "13px",
    ...CENTRED,
  };
}

/** Shift the content to sit at `PADDING` from the surface's top-left, since the
 *  old canvas panned freely and its coordinates are routinely negative. */
function place(nodes: SceneNode[]): void {
  if (!nodes.length) return;
  const dx = PADDING - Math.min(...nodes.map((node) => node.x));
  const dy = PADDING - Math.min(...nodes.map((node) => node.y));
  for (const node of nodes) {
    node.x += dx;
    node.y += dy;
  }
}

function extent(nodes: readonly SceneNode[], axis: "x" | "y"): number {
  const size = axis === "x" ? "w" : "h";
  let max = 0;
  for (const node of nodes) max = Math.max(max, node[axis] + node[size]);
  return max + PADDING;
}

function shapeOf(value: unknown): LegacyShape {
  return value === "ellipse" || value === "diamond" || value === "text"
    ? value
    : "rectangle";
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positive(value: unknown, fallback: number): number {
  const n = number(value, fallback);
  return n > 0 ? n : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
