import { absoluteRect, absoluteRotation, absoluteSelectionBounds, type RotatedRect } from "../scene/geometry";
import { isGroup, selectedNodes, type EdgeId, type NodeId, type Scene, type SceneNode } from "../scene/types";

/**
 * What a committed change did to the drawing, as a glide needs it — pure, so
 * `./glide` only has to play it.
 *
 * Every scene here is a LAID-OUT one (`laidOutScene`): a child an auto-layout
 * group places is compared where it is drawn, so a reorder, a gap or a sibling
 * removed glides the children the layout moved without anything measuring them.
 */

/** Where a node was drawn, less where it is now, in its parent's space. */
export interface Offset {
  dx: number;
  dy: number;
  /** Degrees, the short way round. */
  dr: number;
}

export interface GlideDiff {
  /** Same node under the same parent, drawn somewhere else. */
  moved: Map<NodeId, Offset>;
  /** New subtrees holding nothing that was there before, outermost only. */
  entered: NodeId[];
  /** Subtrees gone with nothing of them left, outermost only. */
  exited: NodeId[];
}

/**
 * Past this many shapes a change lands as it is: a model's whole-diagram write
 * should cost a render, not a hundred and fifty animations.
 */
export const GLIDE_CAP = 150;

/**
 * Commits closer together than this are a key held down — ⌘Z repeating, a
 * panel field stepped by its arrow. They land crisp: a glide restarted every
 * repeat would trail the key further behind each time.
 */
export const BURST_MS = 120;

/** An arrival's starting size: enough to read as arriving, not as growing. */
export const ARRIVE_SCALE = 0.97;

const EPSILON = 0.01;

interface Placed {
  node: SceneNode;
  parent: NodeId | null;
}

export function placements(nodes: readonly SceneNode[]): Map<NodeId, Placed> {
  const out = new Map<NodeId, Placed>();
  const visit = (list: readonly SceneNode[], parent: NodeId | null) => {
    for (const node of list) {
      out.set(node.id, { node, parent });
      if (isGroup(node)) visit(node.children, node.id);
    }
  };
  visit(nodes, null);
  return out;
}

function anyOf(node: SceneNode, index: ReadonlyMap<NodeId, Placed>): boolean {
  if (index.has(node.id)) return true;
  return isGroup(node) && node.children.some((child) => anyOf(child, index));
}

/** An angle difference folded into (-180, 180]. */
export function turn(dr: number): number {
  const r = ((((dr % 360) + 540) % 360) - 180);
  return r === -180 ? 180 : r;
}

/**
 * The turn a node made, or none when the turn is a mirror's (`scene/flip`):
 * a flip negates the rotation, or takes an odd polygon's half turn, and
 * re-draws the shape inside its box at once — gliding that as a spin would
 * show a mirror as a rotation, and the mirrored drawing at the wrong angle.
 * A turn by hand to exactly the mirror angle lands crisp too; remote flips
 * carry no tag, so the scenes are all there is to tell them by.
 */
function turnOf(was: SceneNode, now: SceneNode): number {
  const dr = turn(was.rot - now.rot);
  if (Math.abs(dr) < EPSILON) return 0;
  const redrawn =
    (was.kind === "path" && now.kind === "path" && was.d !== now.d) ||
    (was.kind === "ellipse" && now.kind === "ellipse" && was.start !== now.start);
  const negated = Math.abs(turn(was.rot + now.rot)) < EPSILON;
  const halfTurn =
    now.kind === "polygon" && Math.round(now.sides) % 2 === 1 && Math.abs(turn(was.rot + now.rot - 180)) < EPSILON;
  return redrawn || negated || halfTurn ? 0 : dr;
}

export function negligible(off: Offset): boolean {
  return Math.abs(off.dx) < EPSILON && Math.abs(off.dy) < EPSILON && Math.abs(off.dr) < EPSILON;
}

/**
 * Which shapes a change moved, brought in and took away. A node that changed
 * parent — grouped, ungrouped — is none of them: its coordinates are in a new
 * space and nothing on screen moved, so there is nothing to show.
 */
export function diffGlide(prev: Scene, next: Scene): GlideDiff {
  const before = placements(prev.nodes);
  const after = placements(next.nodes);
  const moved = new Map<NodeId, Offset>();
  const entered: NodeId[] = [];
  const exited: NodeId[] = [];

  const arrive = (list: readonly SceneNode[], parent: NodeId | null) => {
    for (const node of list) {
      const was = before.get(node.id);
      if (!was) {
        if (!anyOf(node, before)) {
          entered.push(node.id);
          continue;
        }
      } else if (was.parent === parent) {
        const off = { dx: was.node.x - node.x, dy: was.node.y - node.y, dr: turnOf(was.node, node) };
        if (!negligible(off)) moved.set(node.id, off);
      }
      if (isGroup(node)) arrive(node.children, node.id);
    }
  };
  arrive(next.nodes, null);

  const leave = (list: readonly SceneNode[]) => {
    for (const node of list) {
      if (!after.has(node.id) && !anyOf(node, after)) {
        exited.push(node.id);
        continue;
      }
      if (isGroup(node)) leave(node.children);
    }
  };
  leave(prev.nodes);

  return { moved, entered, exited };
}

export function tooMany(diff: GlideDiff): boolean {
  return diff.moved.size + diff.entered.length + diff.exited.length > GLIDE_CAP;
}

export const isBurst = (now: number, last: number): boolean => now - last < BURST_MS;

export function addOffsets(a: Offset | undefined, b: Offset): Offset {
  return a ? { dx: a.dx + b.dx, dy: a.dy + b.dy, dr: a.dr + b.dr } : b;
}

export function scaleOffset(off: Offset, k: number): Offset {
  return { dx: off.dx * k, dy: off.dy * k, dr: off.dr * k };
}

const px = (x: number, y: number) => `${x}px ${y}px`;

/**
 * Keyframes for the individual `translate` (and `rotate`) properties that draw
 * a node `off` from where its own `transform` puts it, easing to nothing. The
 * `transform` React wrote is never touched.
 *
 * `(x, y)` is that transform's translation — the node's own `x`/`y`, or zero
 * for a child a layout places. The individual properties apply outside it, so
 * a turn pivots about the parent's origin rather than the node's centre; each
 * keyframe carries the translation that puts the pivot back. The chord between
 * samples is what the eye could tell from the arc, hence one per ten degrees.
 */
export function glideKeyframes(off: Offset, x: number, y: number): Keyframe[] {
  if (Math.abs(off.dr) < EPSILON) return [{ translate: px(off.dx, off.dy) }, { translate: px(0, 0) }];
  const steps = Math.min(24, Math.max(2, Math.ceil(Math.abs(off.dr) / 10)));
  const frames: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const f = 1 - i / steps;
    const r = off.dr * f;
    const rad = (r * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    frames.push({
      offset: i / steps,
      translate: px(x + off.dx * f - (x * cos - y * sin), y + off.dy * f - (x * sin + y * cos)),
      rotate: `${r}deg`,
    });
  }
  return frames;
}

/**
 * An arrival: from nothing, and — unless motion is reduced — from a touch
 * smaller about the node's own centre. `scale` applies outside the node's
 * transform, so its translation is scaled with it and handed back through
 * `translate`. One keyframe: the end is whatever the node's style says,
 * its own opacity included.
 */
export function enterKeyframes(x: number, y: number, still: boolean): Keyframe[] {
  if (still) return [{ offset: 0, opacity: 0 }];
  const k = 1 - ARRIVE_SCALE;
  return [{ offset: 0, opacity: 0, scale: String(ARRIVE_SCALE), translate: px(k * x, k * y) }];
}

/**
 * The scene as it is drawn `k` of the way back along each offset — what the
 * connectors and the selection frame are drawn from mid-glide. Untouched
 * subtrees keep their identity.
 */
export function displace(scene: Scene, offsets: ReadonlyMap<NodeId, Offset>, k: number): Scene {
  if (offsets.size === 0 || k === 0) return scene;
  const map = (list: SceneNode[]): SceneNode[] => {
    let changed = false;
    const out = list.map((node) => {
      let n = node;
      const off = offsets.get(node.id);
      if (off) n = { ...n, x: n.x + off.dx * k, y: n.y + off.dy * k, rot: n.rot + off.dr * k } as SceneNode;
      if (isGroup(n)) {
        const children = map(n.children);
        if (children !== n.children) n = { ...n, children };
      }
      if (n !== node) changed = true;
      return n;
    });
    return changed ? out : list;
  };
  const nodes = map(scene.nodes);
  return nodes === scene.nodes ? scene : { ...scene, nodes };
}

/** The connectors with an end in or under one of `moving` — the ones a glide carries along. */
export function edgesTouching(scene: Scene, moving: Iterable<NodeId>): Set<EdgeId> {
  const under = new Set<NodeId>();
  const index = placements(scene.nodes);
  const walk = (node: SceneNode) => {
    under.add(node.id);
    if (isGroup(node)) node.children.forEach(walk);
  };
  for (const id of moving) {
    const placed = index.get(id);
    if (placed && !under.has(id)) walk(placed.node);
  }
  const out = new Set<EdgeId>();
  for (const edge of scene.edges) if (under.has(edge.from) || under.has(edge.to)) out.add(edge.id);
  return out;
}

/** The frame the overlay draws around `ids` in this scene — as `selectionFrame`, without laying it out again. */
export function frameAt(scene: Scene, ids: readonly NodeId[]): RotatedRect | null {
  const live = selectedNodes(scene, ids);
  if (live.length === 0) return null;
  if (live.length === 1) {
    const id = live[0].id;
    return { ...absoluteRect(scene, id), rot: absoluteRotation(scene, id) };
  }
  return { ...absoluteSelectionBounds(scene, live.map((node) => node.id)), rot: 0 };
}

/** `cubic-bezier(…)` as a function of time, for a frame loop keeping step with WAAPI. Anything else is linear. */
export function easingOf(css: string): (t: number) => number {
  const m = /cubic-bezier\(([^)]+)\)/.exec(css);
  const v = m?.[1].split(",").map(Number);
  if (!v || v.length !== 4 || v.some((n) => !Number.isFinite(n))) return (t) => Math.min(1, Math.max(0, t));
  const [x1, y1, x2, y2] = v;
  const at = (u: number, a: number, b: number) => 3 * a * u * (1 - u) ** 2 + 3 * b * u * u * (1 - u) + u ** 3;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    // x(u) rises monotonically on [0, 1] for any valid timing function.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (at(mid, x1, x2) < t) lo = mid;
      else hi = mid;
    }
    return at((lo + hi) / 2, y1, y2);
  };
}
