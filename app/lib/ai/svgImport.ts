import type { ParseHtml } from "@/app/components/editor/canvas/scene/parse";
import { applyOps } from "@/app/components/editor/canvas/scene/ops";
import {
  pathDataBounds,
  scalePath,
  translatePath,
} from "@/app/components/editor/canvas/scene/path";
import type {
  PathNode,
  Scene,
  SceneNode,
  StyleMap,
} from "@/app/components/editor/canvas/scene/types";

/**
 * Standard SVG → a {@link Scene}, sized to a frame.
 *
 * The import seam for drawings made OUTSIDE the grammar — a vector model's
 * output arrives as ordinary SVG, and this is what turns it into the same
 * editable shapes everything else on the canvas is. One directional bet runs
 * through it: convert at the door, never store. A document holds only scene
 * grammar, so nothing downstream — layers, gestures, the AI reading the page —
 * ever learns SVG existed.
 *
 * Built against what Recraft V4 actually emits, censused rather than assumed:
 * a flat list of `<path>` elements in paint order (no groups, whatever the
 * marketing says about layers), identity `translate(0,0)` transforms, `rgb()`
 * fills, an occasional gradient, and no clip paths, masks, images or `use`.
 * The converter therefore flattens groups rather than modelling them, and
 * handles the affine transforms it can see — translate, scale, and a matrix
 * without rotation — by folding them into coordinates. Anything stranger is
 * ignored where it stands: a shape slightly misplaced is visibly wrong and
 * fixable, where a refusal would blank the whole drawing.
 */

/** translate/scale folded flat: `x' = x·sx + tx`. */
type Affine = { sx: number; sy: number; tx: number; ty: number };

const IDENTITY: Affine = { sx: 1, sy: 1, tx: 0, ty: 0 };

function compose(outer: Affine, inner: Affine): Affine {
  return {
    sx: outer.sx * inner.sx,
    sy: outer.sy * inner.sy,
    tx: outer.sx * inner.tx + outer.tx,
    ty: outer.sy * inner.ty + outer.ty,
  };
}

/**
 * A `transform` attribute as an {@link Affine}. Rotation and skew have no slot
 * in the fold, so a rotating matrix keeps only its scale-and-move part — the
 * documented "visibly wrong beats blank" trade, and one the census says is
 * never exercised.
 */
function parseTransform(raw: string | null): Affine {
  let out = IDENTITY;
  if (!raw) return out;
  for (const m of raw.matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
    const args = m[2].split(/[\s,]+/).filter(Boolean).map(Number);
    switch (m[1]) {
      case "translate":
        out = compose(out, { ...IDENTITY, tx: args[0] ?? 0, ty: args[1] ?? 0 });
        break;
      case "scale":
        out = compose(out, {
          ...IDENTITY,
          sx: args[0] ?? 1,
          sy: args[1] ?? args[0] ?? 1,
        });
        break;
      case "matrix":
        if (args.length === 6) {
          out = compose(out, { sx: args[0], sy: args[3], tx: args[4], ty: args[5] });
        }
        break;
    }
  }
  return out;
}

const num = (el: Element, name: string, fallback = 0): number => {
  const v = Number.parseFloat(el.getAttribute(name) ?? "");
  return Number.isFinite(v) ? v : fallback;
};

/** The primitives, as path data — the same conversions the icon build does. */
function elementToD(el: Element): string | null {
  switch (el.tagName.toLowerCase()) {
    case "path":
      return el.getAttribute("d") ?? "";
    case "circle": {
      const r = num(el, "r");
      return ellipseD(num(el, "cx"), num(el, "cy"), r, r);
    }
    case "ellipse":
      return ellipseD(num(el, "cx"), num(el, "cy"), num(el, "rx"), num(el, "ry"));
    case "rect": {
      const x = num(el, "x");
      const y = num(el, "y");
      const w = num(el, "width");
      const h = num(el, "height");
      return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
    }
    case "line":
      return `M ${num(el, "x1")} ${num(el, "y1")} L ${num(el, "x2")} ${num(el, "y2")}`;
    case "polyline":
    case "polygon": {
      const nums = (el.getAttribute("points") ?? "")
        .trim()
        .split(/[\s,]+/)
        .map(Number)
        .filter(Number.isFinite);
      if (nums.length < 4) return "";
      const parts: string[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        parts.push(`${i === 0 ? "M" : "L"} ${nums[i]} ${nums[i + 1]}`);
      }
      return parts.join(" ") + (el.tagName.toLowerCase() === "polygon" ? " Z" : "");
    }
    default:
      return null;
  }
}

function ellipseD(cx: number, cy: number, rx: number, ry: number): string {
  return (
    `M ${cx - rx} ${cy} ` +
    `A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} ` +
    `A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`
  );
}

/**
 * Gradient fills, resolved to a solid. The defs do not survive the trip — a
 * scene has no `<defs>` to keep them in — so a `url(#…)` fill takes its
 * gradient's middle stop, which reads as the average of a two-stop wash. The
 * census found two in 266 paths; flat is the house style anyway.
 */
function gradientStops(doc: Document): Map<string, string> {
  const out = new Map<string, string>();
  for (const grad of Array.from(
    doc.querySelectorAll("linearGradient, radialGradient"),
  )) {
    const id = grad.getAttribute("id");
    if (!id) continue;
    const stops = Array.from(grad.querySelectorAll("stop")).map(
      (s) =>
        s.getAttribute("stop-color") ??
        /stop-color:\s*([^;]+)/.exec(s.getAttribute("style") ?? "")?.[1] ??
        "",
    );
    const pick = stops[Math.floor(stops.length / 2)] || stops[0];
    if (pick) out.set(id, pick.trim());
  }
  return out;
}

/** Presentation attributes → the style a scene path paints itself with. */
function styleOf(el: Element, gradients: Map<string, string>): StyleMap {
  const out: StyleMap = {};
  const paint = (value: string | null): string | null => {
    if (!value) return null;
    const url = /^url\(["']?#([^"')]+)["']?\)/.exec(value.trim());
    if (url) return gradients.get(url[1]) ?? null;
    return value.trim();
  };
  // SVG's unstated default is a black fill, and Recraft leans on it.
  out.fill = paint(el.getAttribute("fill")) ?? "#000000";
  if (out.fill === "none") out.fill = "none";
  for (const name of [
    "stroke",
    "stroke-width",
    "stroke-linecap",
    "stroke-linejoin",
    "fill-rule",
    "opacity",
    "fill-opacity",
    "stroke-opacity",
  ]) {
    const value = el.getAttribute(name);
    if (value && value !== "inherit") out[name] = value;
  }
  return out;
}

const SKIP = new Set(["defs", "metadata", "title", "desc", "style", "script"]);

export type ImportedScene = {
  scene: Scene;
  /** Elements the converter had no reading for — worth logging, never fatal. */
  dropped: number;
};

/**
 * The SVG, as a scene exactly `frame` big.
 *
 * COVER fit: scaled uniformly until both axes are filled and centred, so an
 * aspect mismatch between what the vector model can produce and what the shot
 * wants crops equally at the edges — what a film crop does — rather than
 * letterboxing or stretching. The scale runs through the scene's own ops, so
 * path data and style lengths take the factor together.
 */
export function importSvgScene(
  svg: string,
  frame: { w: number; h: number },
  parseHtml: ParseHtml,
  /** Layer-panel name for the group the drawing arrives as. */
  label = "Drawing",
): ImportedScene | null {
  const doc = parseHtml(`<!DOCTYPE html><html><body>${svg}</body></html>`);
  const root = doc.querySelector("svg");
  if (!root) return null;

  const viewBox = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const [minX, minY, vw, vh] =
    viewBox.length === 4 && viewBox.every(Number.isFinite)
      ? viewBox
      : [0, 0, num(root, "width", frame.w), num(root, "height", frame.h)];
  if (!(vw > 0) || !(vh > 0)) return null;

  const gradients = gradientStops(doc);
  const nodes: PathNode[] = [];
  let dropped = 0;
  let n = 0;

  const walk = (parent: Element, outer: Affine) => {
    for (const el of Array.from(parent.children)) {
      const tag = el.tagName.toLowerCase();
      if (SKIP.has(tag)) continue;
      const at = compose(outer, parseTransform(el.getAttribute("transform")));
      if (tag === "g" || tag === "svg") {
        walk(el, at);
        continue;
      }
      const raw = elementToD(el);
      if (raw === null) {
        dropped++;
        continue;
      }
      if (!raw) continue;
      const d = translatePath(scalePath(raw, at.sx, at.sy), at.tx, at.ty);
      const bounds = pathDataBounds(d);
      if (!bounds || bounds.w <= 0 || bounds.h <= 0) continue;
      nodes.push({
        id: `v${++n}`,
        kind: "path",
        x: bounds.x - minX,
        y: bounds.y - minY,
        w: bounds.w,
        h: bounds.h,
        rot: 0,
        d: translatePath(d, -bounds.x, -bounds.y),
        style: styleOf(el, gradients),
        label: "",
        locked: false,
        hidden: false,
        attrs: {},
      });
    }
  };
  walk(root, IDENTITY);
  if (!nodes.length) return null;

  const k = Math.max(frame.w / vw, frame.h / vh);
  const scaled = applyOps(
    { w: vw, h: vh, style: {}, nodes, edges: [], attrs: {} },
    [
      { type: "scale", ids: nodes.map((node) => node.id), k, anchor: { x: 0, y: 0 } },
      {
        type: "move",
        ids: nodes.map((node) => node.id),
        dx: (frame.w - vw * k) / 2,
        dy: (frame.h - vh * k) / 2,
      },
    ],
  );

  // One named group around the whole drawing, spanning the frame at the
  // origin — children's coordinates are already relative to it. The picture
  // then moves, layers and deletes as one thing, and the layer panel shows
  // its parts under one name instead of hundreds of loose paths.
  const kept = budgeted(scaled.nodes.map(rounded));
  return {
    scene: {
      ...scaled,
      w: frame.w,
      h: frame.h,
      nodes: [
        {
          id: "v0",
          kind: "group",
          x: 0,
          y: 0,
          w: frame.w,
          h: frame.h,
          rot: 0,
          style: {},
          label,
          locked: false,
          hidden: false,
          attrs: {},
          children: kept,
        },
      ],
    },
    dropped,
  };
}

/**
 * How much drawing a drawing may be.
 *
 * A crowd scene came back as ~2500 paths — 989KB imported, a whisker under
 * Convex's 1MiB value ceiling, minutes to generate and heavy everywhere it
 * travels. At shot scale most of that is texture: sub-pixel specks and grain
 * nobody can see. Cull the invisible first, then the smallest until the scene
 * fits the budget — z-order kept, so what remains is the same picture with
 * less noise. ~250KB keeps a twelve-shot board clear of every 1MiB ceiling.
 */
const BYTE_BUDGET = 250_000;
/** Below this many square px a shape is grain, not drawing. */
const MIN_AREA = 0.5;

function budgeted(nodes: SceneNode[]): SceneNode[] {
  let kept = nodes.filter((node) => node.w * node.h >= MIN_AREA);
  const weight = (list: SceneNode[]) =>
    list.reduce((sum, n) => sum + (n.kind === "path" ? n.d.length : 60) + 60, 0);
  if (weight(kept) <= BYTE_BUDGET) return kept;
  const byArea = [...kept].sort((a, b) => a.w * a.h - b.w * b.h);
  const cut = new Set<string>();
  let over = weight(kept) - BYTE_BUDGET;
  for (const node of byArea) {
    if (over <= 0) break;
    cut.add(node.id);
    over -= (node.kind === "path" ? node.d.length : 60) + 60;
  }
  kept = kept.filter((node) => !cut.has(node.id));
  return kept;
}

/**
 * A 2048-space drawing scaled into a 320-wide shot turns every coordinate
 * into a fifteen-digit float, and the serialized scene came out AS BIG AS THE
 * SOURCE — which mattered the moment a nine-shot board met Convex's 1MiB
 * value ceiling. A tenth of a pixel is beyond what any of these drawings
 * resolve; one decimal keeps the geometry and returns the bytes.
 */
const round1 = (v: number) => Math.round(v * 10) / 10;

function rounded(node: SceneNode): SceneNode {
  const box = {
    x: round1(node.x),
    y: round1(node.y),
    w: round1(node.w),
    h: round1(node.h),
  };
  if (node.kind !== "path") return { ...node, ...box };
  return {
    ...node,
    ...box,
    d: node.d.replace(/-?\d+\.\d+(?:e-?\d+)?/gi, (n) => String(round1(Number(n)))),
  };
}
