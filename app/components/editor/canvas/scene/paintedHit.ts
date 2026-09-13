/** Geometry-only picking. Cached by immutable node; never reads DOM or the camera. */
import { outlineOf } from "./outline";
import { parseSubpaths } from "./path";
import { paintOf } from "./paint";
import { derivedPath, operandsPath } from "./boolean";
import { isBoolean, type Point, type SceneNode } from "./types";

type Contour = { points: Point[]; closed: boolean };
const contours = new WeakMap<SceneNode, Contour[]>();
const booleanContours = new WeakMap<SceneNode, { d: string; paths: Contour[] }>();

export function visiblePaint(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  if (!v || v === "none" || v === "transparent") return false;
  if (/^#[\da-f]{8}$/.test(v) && v.endsWith("00")) return false;
  if (/^#[\da-f]{4}$/.test(v) && v.endsWith("0")) return false;
  if (/\/\s*0(?:\.0+)?%?\s*\)$/.test(v)) return false;
  if (/^(?:rgba?|hsla?)\([^,]+,[^,]+,[^,]+,\s*0(?:\.0+)?%?\s*\)$/.test(v)) return false;
  return true;
}

function distance(p: Point, a: Point, b: Point): number {
  const x = b.x - a.x, y = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * x + (p.y - a.y) * y) / (x * x + y * y || 1)));
  return Math.hypot(p.x - a.x - t * x, p.y - a.y - t * y);
}

const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function cubic(out: Point[], a: Point, b: Point, c: Point, d: Point, depth = 0): void {
  if (depth >= 12 || Math.max(distance(b, a, d), distance(c, a, d)) <= 0.05) {
    out.push(d);
    return;
  }
  const ab = middle(a, b), bc = middle(b, c), cd = middle(c, d);
  const abc = middle(ab, bc), bcd = middle(bc, cd), center = middle(abc, bcd);
  cubic(out, a, ab, abc, center, depth + 1);
  cubic(out, center, bcd, cd, d, depth + 1);
}

function flatten(d: string): Contour[] {
  return parseSubpaths(d).map(({ anchors, closed }) => {
    const points: Point[] = [];
    if (anchors.length) points.push(anchors[0].point);
    for (let i = 1; i < anchors.length + Number(closed); i++) {
      const a = anchors[i - 1], b = anchors[i % anchors.length];
      cubic(points, a.point,
        { x: a.point.x + a.handleOut.x, y: a.point.y + a.handleOut.y },
        { x: b.point.x + b.handleIn.x, y: b.point.y + b.handleIn.y }, b.point);
    }
    return { points, closed };
  });
}

function contains(paths: Contour[], p: Point, evenodd: boolean, fill: boolean, stroke: number): boolean {
  let winding = 0;
  for (const { points, closed } of paths) {
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      if (stroke > 0 && (closed || i < points.length - 1) && distance(p, a, b) <= stroke) return true;
      // SVG fills close open contours implicitly, strokes do not.
      if (a.y <= p.y && b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) winding++;
      if (a.y > p.y && b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) winding--;
    }
  }
  return fill && (evenodd ? Math.abs(winding) % 2 === 1 : winding !== 0);
}

export function paintedHit(node: SceneNode, point: Point, tolerance: number): boolean {
  if (node.style.opacity !== undefined && Number(node.style.opacity) === 0) return false;
  const box = point.x >= -tolerance && point.y >= -tolerance && point.x <= node.w + tolerance && point.y <= node.h + tolerance;
  // Text and images intentionally select their editable object, not individual glyphs/pixels.
  if (node.kind === "text" || node.kind === "image") return box;
  const paint = paintOf(node.style);
  const fill = visiblePaint(paint.fill ?? undefined) || visiblePaint(paint.css ?? undefined) || visiblePaint(node.style["background-image"]);
  let stroke = visiblePaint(paint.attrs.stroke) ? Number.parseFloat(paint.attrs.strokeWidth ?? "1") : 0;
  if ((node.kind === "path" || isBoolean(node)) && node.style.stroke === undefined && !paint.attrs.stroke && !fill) stroke = 2;
  if (node.label && box) return true;
  if (!fill && !(stroke > 0)) return false;
  const slop = tolerance + (stroke || 0);
  if (node.kind !== "path" && (point.x < -slop || point.y < -slop || point.x > node.w + slop || point.y > node.h + slop)) return false;
  if (fill && node.kind === "rect" && !node.style["border-radius"] && box) return true;
  if (fill && node.kind === "ellipse" && node.start === undefined && node.sweep === undefined && node.inner === undefined && node.w > 0 && node.h > 0 &&
    ((point.x - node.w / 2) / (node.w / 2)) ** 2 + ((point.y - node.h / 2) / (node.h / 2)) ** 2 <= 1) return true;
  let paths = contours.get(node);
  if (isBoolean(node)) {
    const d = derivedPath(node) ?? operandsPath(node);
    const previous = booleanContours.get(node);
    paths = previous?.d === d ? previous.paths : flatten(d);
    if (previous?.d !== d) booleanContours.set(node, { d, paths });
  }
  if (!paths) {
    const d = outlineOf(node.kind === "group" ? { ...node, kind: "rect" } : node);
    if (!d) return box && fill;
    paths = flatten(d);
    contours.set(node, paths);
  }
  const evenodd = node.kind === "ellipse" || isBoolean(node) || node.style["fill-rule"] === "evenodd";
  // CSS borders sit inside boxes. SVG strokes straddle their outline.
  const width = stroke > 0 ? stroke / (node.kind === "rect" ? 1 : 2) + tolerance : 0;
  return contains(paths, point, evenodd, fill, width) && (node.kind !== "rect" || box);
}
