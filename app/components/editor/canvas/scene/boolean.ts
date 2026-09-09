/**
 * Boolean operations: the one shape a group with an `op` draws.
 *
 * The operands stay what they are — a rect, an arc, a pen path, a group of
 * them — and the result is derived, never stored, so the operation is still
 * there to edit. Deriving it means clipping one region against another, which
 * is done on polygons: every operand's outline is flattened to points at a
 * tolerance well under a pixel, `polygon-clipping` does the set algebra, and
 * the rings that come back are written as straight segments. The operands
 * keep their curves; only the drawing is faceted, finer than the eye.
 *
 * The clipper is loaded on demand, since most diagrams never need it. Before
 * it arrives {@link derivedPath} is `null`, and the renderer draws the
 * operands' outlines together in its place: for a beat, a union.
 */

import type { MultiPolygon, Ring } from "polygon-clipping";
import { rectCentre, rotateAround } from "./geometry";
import { mintId } from "./ops";
import { outlineOf } from "./outline";
import { parseSubpaths, scalePath, type Path } from "./path";
import {
  findNode,
  isBoolean,
  isGroup,
  type BooleanOp,
  type GroupNode,
  type NodeId,
  type Point,
  type Scene,
  type SceneNode,
  type SceneOp,
} from "./types";

type Geom = Parameters<typeof import("polygon-clipping").union>[0];
type Clipper = Pick<typeof import("polygon-clipping"), "union" | "intersection" | "difference" | "xor">;

let clipper: Clipper | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

export const clipperReady = (): boolean => clipper !== null;

/** Fetch the clipper once; resolves when {@link derivedPath} can answer. */
export function loadClipper(): Promise<void> {
  if (clipper) return Promise.resolve();
  loading ??= import("polygon-clipping").then((mod) => {
    clipper = "union" in mod ? mod : (mod as { default: Clipper }).default;
    for (const listen of listeners) listen();
  });
  return loading;
}

/** For `useSyncExternalStore`: fires once, when the clipper lands. */
export function subscribeClipper(listen: () => void): () => void {
  listeners.add(listen);
  return () => {
    listeners.delete(listen);
  };
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

/** How far a chord may sit from its curve, in scene px. */
const TOLERANCE = 0.1;
const MAX_DEPTH = 14;

function rings(d: string): Ring[] {
  return parseSubpaths(d)
    .map(ringOf)
    .filter((ring) => ring.length >= 3);
}

/** A subpath as a closed ring: an open one is closed by its fill anyway. */
function ringOf(path: Path): Ring {
  const out: Ring = [];
  const n = path.anchors.length;
  if (n === 0) return out;
  const first = path.anchors[0].point;
  out.push([first.x, first.y]);
  const segments = path.closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const a = path.anchors[i];
    const b = path.anchors[(i + 1) % n];
    cubic(
      a.point,
      { x: a.point.x + a.handleOut.x, y: a.point.y + a.handleOut.y },
      { x: b.point.x + b.handleIn.x, y: b.point.y + b.handleIn.y },
      b.point,
      out,
      0,
    );
  }
  // The closing segment lands back on the first point; a ring implies it.
  const last = out[out.length - 1];
  if (out.length > 1 && last[0] === out[0][0] && last[1] === out[0][1]) out.pop();
  return out;
}

/** Adaptive subdivision: split until both control points sit on the chord. */
function cubic(p0: Point, p1: Point, p2: Point, p3: Point, out: Ring, depth: number): void {
  if (depth >= MAX_DEPTH || flat(p0, p1, p2, p3)) {
    out.push([p3.x, p3.y]);
    return;
  }
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const p23 = mid(p2, p3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const m = mid(p012, p123);
  cubic(p0, p01, p012, m, out, depth + 1);
  cubic(m, p123, p23, p3, out, depth + 1);
}

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function flat(p0: Point, p1: Point, p2: Point, p3: Point): boolean {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const len = Math.hypot(dx, dy);
  const off = (p: Point) =>
    len < 1e-9
      ? Math.hypot(p.x - p0.x, p.y - p0.y)
      : Math.abs((p.x - p0.x) * dy - (p.y - p0.y) * dx) / len;
  return off(p1) <= TOLERANCE && off(p2) <= TOLERANCE;
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

const EMPTY: MultiPolygon = [];

function signedArea(ring: Ring): number {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return area / 2;
}

/**
 * The area a set of subpaths fills, under the fill rule that paints it.
 * Even-odd is the exclusive-or of the rings. Non-zero is read as the rings
 * turning one way united, less the rings turning the other — exact for every
 * outline the outline writers produce and for any drawing whose holes wind
 * against their shell, which is how every path tool writes one.
 */
function filled(clip: Clipper, ringList: Ring[], evenodd: boolean): MultiPolygon {
  if (ringList.length === 0) return EMPTY;
  const polys = ringList.map((ring): Geom => [ring]);
  if (evenodd) return clip.xor(polys[0], ...polys.slice(1));
  const forward = ringList.filter((ring) => signedArea(ring) >= 0).map((ring): Geom => [ring]);
  const backward = ringList.filter((ring) => signedArea(ring) < 0).map((ring): Geom => [ring]);
  const unite = (list: Geom[]): MultiPolygon => (list.length ? clip.union(list[0], ...list.slice(1)) : EMPTY);
  if (!forward.length) return unite(backward);
  if (!backward.length) return unite(forward);
  return clip.xor(unite(forward), unite(backward));
}

/** A region in a node's local space, moved into its parent's. */
function placed(region: MultiPolygon, node: SceneNode): MultiPolygon {
  const r = (node.rot * Math.PI) / 180;
  const cos = node.rot === 0 ? 1 : Math.cos(r);
  const sin = node.rot === 0 ? 0 : Math.sin(r);
  const cx = node.w / 2;
  const cy = node.h / 2;
  const map = ([x, y]: Ring[number]): Ring[number] => {
    const dx = x - cx;
    const dy = y - cy;
    return [node.x + cx + cos * dx - sin * dy, node.y + cy + sin * dx + cos * dy];
  };
  return region.map((poly) => poly.map((ring) => ring.map(map)));
}

const regions = new WeakMap<SceneNode, MultiPolygon>();

/** The area a node covers, in its own local space; empty for what has none. */
function regionOf(node: SceneNode, clip: Clipper): MultiPolygon {
  const cached = regions.get(node);
  if (cached) return cached;
  let region: MultiPolygon;
  if (isGroup(node)) {
    // A plain group in a boolean is the union of what it holds — Figma's
    // reading, and the only one under which grouping operands changes nothing.
    const parts = operands(node, clip);
    region = node.op ? combine(node.op, parts, clip) : parts.length ? clip.union(parts[0], ...parts.slice(1)) : EMPTY;
  } else {
    const d = outlineOf(node);
    region = d ? filled(clip, rings(d), node.style["fill-rule"]?.trim() === "evenodd") : EMPTY;
  }
  regions.set(node, region);
  return region;
}

/** The children's regions in the group's space, hidden ones left out. */
function operands(group: GroupNode, clip: Clipper): MultiPolygon[] {
  return group.children
    .filter((child) => !child.hidden)
    .map((child) => placed(regionOf(child, clip), child))
    .filter((region) => region.length > 0);
}

function combine(op: GroupNode["op"], parts: MultiPolygon[], clip: Clipper): MultiPolygon {
  if (parts.length === 0) return EMPTY;
  if (parts.length === 1) return parts[0];
  const [first, ...rest] = parts;
  switch (op) {
    case "union":
      return clip.union(first, ...rest);
    case "intersect":
      return clip.intersection(first, ...rest);
    case "subtract":
      return clip.difference(first, ...rest);
    case "exclude":
      return clip.xor(first, ...rest);
    default:
      return EMPTY;
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const num = (n: number) => String(Math.round(n * 1000) / 1000);

/** The clipper closes a ring by repeating its first point; `Z` says that. */
function closed(ring: Ring): Ring {
  const [first, last] = [ring[0], ring[ring.length - 1]];
  return ring.length > 1 && first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
}

function regionPath(region: MultiPolygon, dx = 0, dy = 0): string {
  return region
    .flat()
    .map((ring) => `M ${closed(ring).map(([x, y]) => `${num(x + dx)} ${num(y + dy)}`).join(" L ")} Z`)
    .join(" ");
}

/**
 * The shape a boolean group draws, as path data local to its box. Rings from
 * a clipper never overlap, so any fill rule paints them alike. `null` before
 * the clipper has loaded, and `""` when the operation leaves nothing.
 */
export function derivedPath(group: GroupNode): string | null {
  if (!clipper || !group.op) return null;
  return regionPath(regionOf(group, clipper));
}

/**
 * The operands' outlines laid together in the group's space, for the moment
 * before the clipper is in: drawn under the non-zero rule they read as a union.
 */
export function operandsPath(group: GroupNode): string {
  return group.children
    .filter((child) => !child.hidden)
    .map((child) => {
      const d = isGroup(child) ? operandsPath(child) : outlineOf(child);
      return d ? regionPath(placed(rings(d).map((ring) => [ring]), child)) : "";
    })
    .filter(Boolean)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Live preview
// ---------------------------------------------------------------------------

/** A box a gesture is holding a node at, in its parent's space. */
export type LiveBox = Pick<SceneNode, "id" | "x" | "y" | "w" | "h" | "rot">;

/**
 * The group as it would be if every descendant named in `frames` sat in its
 * live box — what a gesture is about to commit, one frame early. Only the
 * touched nodes and their ancestors are new objects; every other operand is
 * the same object as before, so its region stays cached and a frame costs
 * one clip. A path is stretched with its box, as the `resize` op will do.
 */
export function withFrames(group: GroupNode, frames: ReadonlyMap<NodeId, LiveBox>): GroupNode {
  const place = (node: SceneNode): SceneNode => {
    const live = frames.get(node.id);
    let next = node;
    if (live) {
      const d = node.kind === "path" && (live.w !== node.w || live.h !== node.h)
        ? { d: scalePath(node.d, node.w ? live.w / node.w : 1, node.h ? live.h / node.h : 1) }
        : {};
      next = { ...node, x: live.x, y: live.y, w: live.w, h: live.h, rot: live.rot, ...d };
    }
    if (!isGroup(next)) return next;
    let changed = false;
    const children = next.children.map((child) => {
      const placed = place(child);
      if (placed !== child) changed = true;
      return placed;
    });
    return changed ? { ...next, children } : next;
  };
  return place(group) as GroupNode;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * What a boolean command does to a selection: two or more nodes become a
 * boolean group wearing the operation; a lone group takes the operation
 * itself, whether it had one before or not. One node that is not a group has
 * nothing to combine with. `select` is what the selection should become.
 */
export function booleanOps(
  scene: Scene,
  nodes: readonly SceneNode[],
  op: BooleanOp,
): { ops: SceneOp[]; select: NodeId[] } | null {
  if (nodes.length === 1 && isGroup(nodes[0])) {
    const id = nodes[0].id;
    return { ops: [{ type: "setShape", ids: [id], params: { op } }], select: [id] };
  }
  if (nodes.length < 2) return null;
  const groupId = mintId(scene);
  return { ops: [{ type: "group", ids: nodes.map((node) => node.id), groupId, op }], select: [groupId] };
}

/** True when {@link booleanOps} would do something with this selection. */
export const canBoolean = (nodes: readonly SceneNode[]): boolean =>
  nodes.length >= 2 || (nodes.length === 1 && isGroup(nodes[0]));

/** The flattens for whichever of `ids` are boolean groups, once the clipper is in. */
export function flattenOps(scene: Scene, ids: readonly NodeId[]): SceneOp[] {
  return ids
    .map((id) => findNode(scene, id))
    .map((node) => (node ? flattenOp(node) : null))
    .filter((op): op is SceneOp => op !== null);
}

/**
 * The op that turns a boolean group into the plain path it drew, in place —
 * same id, same slot, same style, so a connector on it stays on it. The path's
 * box is tight to the drawing, which may not be the group's box, and a turned
 * group turns about its own centre, so the new box is placed where the old
 * one's rotation had put that part of it.
 *
 * `null` for anything but a boolean group, or before the clipper has loaded.
 */
export function flattenOp(node: SceneNode): SceneOp | null {
  if (!clipper || !isBoolean(node)) return null;
  const region = regionOf(node, clipper);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const poly of region) {
    for (const ring of poly) {
      for (const [x, y] of ring) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x0 === Infinity) return null;
  const w = x1 - x0;
  const h = y1 - y0;
  const centre = rotateAround(
    { x: node.x + x0 + w / 2, y: node.y + y0 + h / 2 },
    rectCentre(node),
    node.rot,
  );
  return {
    type: "setPath",
    id: node.id,
    d: regionPath(region, -x0, -y0),
    frame: { x: centre.x - w / 2, y: centre.y - h / 2, w, h },
  };
}
