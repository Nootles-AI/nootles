/**
 * Alignment and distribution snapping — what makes placement feel deliberate.
 *
 * A gesture hands this module the lines its geometry carries (a selection's
 * edges and centres, or the one edge a resize handle drags) and gets back an
 * adjusted delta plus the guides that actually fired, so the overlay can draw
 * exactly what happened and nothing else.
 *
 * ## Why the lock, and not just "snap the nearest"
 *
 * Snapping per frame with no memory jitters: the pointer sits a pixel outside
 * the threshold, the shape jumps back, the pointer moves a pixel and it snaps
 * again. The fix — taken from GrapesJS's `Dragger` — is to *lock* an axis when
 * it snaps: record the delta at which the snap holds, force that delta while the
 * raw pointer delta stays within the threshold of it, and only re-search once it
 * has escaped. The result is a shape that sticks, then releases cleanly, which
 * is what Figma feels like.
 *
 * The guide-locking model below is adapted from GrapesJS
 * (`packages/core/src/utils/Dragger.ts`), used under the BSD-3-Clause licence:
 *
 *   Copyright (c) 2017-current, Artur Arseniev. All rights reserved.
 *
 *   Redistribution and use in source and binary forms, with or without
 *   modification, are permitted provided that the conditions of the
 *   BSD-3-Clause licence are met. THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT
 *   HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES ARE
 *   DISCLAIMED.
 *
 * ## Alignment, and distribution
 *
 * Two families of guide, both through that same lock. Alignment comes from the
 * candidates' edges and centres. Distribution comes from the gaps *between*
 * them: a box dropped where its gap to the left-hand neighbour equals the gap
 * to the right-hand one, or where it continues an evenly spaced run. Where both
 * are in reach on an axis, alignment wins — it is the more specific answer, and
 * the one Figma gives.
 *
 * ## Scene units, screen threshold
 *
 * Every coordinate here is scene px. The *threshold* is screen px and is divided
 * by the zoom on the way in, so the distance at which things snap is the same
 * physical distance whether you are at 20% or 400%. Anything else is noticed
 * immediately: at 400% a scene-px threshold would snap from four pixels away, at
 * 20% you could not hit it at all.
 */

import { absoluteBounds, type Handle } from "../scene/geometry";
import {
  findParent,
  type GroupNode,
  type NodeId,
  type Point,
  type Rect,
  type Scene,
} from "../scene/types";

/** `"x"` is a *vertical* line at a given x — the axis its position is measured on. */
export type Axis = "x" | "y";

/**
 * Only so the overlay can style them, and so ties prefer a centre. `"spacing"`
 * belongs to a distribution mark, which measures a gap rather than naming a
 * line, and is never a {@link SnapLine}'s kind.
 */
export type SnapKind = "edge" | "centre" | "spacing";

/** A line the moving geometry can snap to. `from`/`to` are along the other axis. */
export interface SnapLine {
  axis: Axis;
  at: number;
  from: number;
  to: number;
  kind: SnapKind;
}

/**
 * A line carried by the moving geometry.
 *
 * `at` is where it sits at zero delta and `weight` is how it moves with the
 * gesture's delta: `1` for an edge that follows the pointer, `-1` for the
 * opposite edge during an alt-resize, which grows the other way.
 */
export interface SnapTarget {
  axis: Axis;
  at: number;
  weight: 1 | -1;
  from: number;
  to: number;
}

/**
 * A guide that fired, in the orientation it is drawn: `at` is its position and
 * `from`/`to` are its extent along the other axis.
 *
 * For an alignment guide `at` is the static line the geometry landed on. A
 * `"spacing"` mark instead spans the gap it measures, so an equal-gap snap on
 * the x axis draws horizontal bars and therefore reports `axis: "y"`.
 */
export interface SnapGuide {
  axis: Axis;
  at: number;
  from: number;
  to: number;
  kind: SnapKind;
}

export interface SnapOptions {
  /** Screen px, divided by the zoom before use. */
  threshold?: number;
  /** Scene px. `0` disables grid snapping. */
  grid?: number;
  /**
   * The moving geometry's box at zero delta. Distribution needs a box rather
   * than a set of lines — a gap has two ends — and the box is rigid for the
   * gestures that offer it. Omit it and equal-gap snapping is simply off.
   */
  moving?: Rect;
}

/** What a frame's gesture is, beyond its delta. */
export interface SnapPass {
  /**
   * Which axes the gesture actually moves. A guide is drawn long enough to
   * reach the geometry it lines up with, and that geometry travels with the
   * gesture — but an edge handle drives ONE axis, and extending the guide by
   * pointer wander on the other drew it far past anything that had moved.
   * Defaults to both, which is a move.
   */
  drives?: { x: boolean; y: boolean };
  /**
   * Offer equal-gap snapping. Moves only: a resize deliberately snaps just the
   * edges its handle drags (see {@link resizeTargets}), and a gap on the far
   * side pulling that box back would fight the handle the same way.
   */
  spacing?: boolean;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: readonly SnapGuide[];
}

/**
 * One gesture's snapping. Stateful on purpose — the axis locks are what stop
 * the jitter, and they only mean anything across frames.
 */
export interface Snapper {
  /**
   * @param targets lines the moving geometry carries; the first per axis is the
   *   one grid snapping uses.
   * @param delta the raw pointer delta in scene px.
   * @param zoom the viewport's zoom, for the screen-px threshold.
   * @param enabled `false` (⌘/Ctrl held) passes the delta through and drops the
   *   locks, so releasing the key does not resume a stale snap. Snapping being
   *   off for the session ({@link isSnapEnabled}) does the same, so a caller
   *   need not consult it.
   * @param pass what this gesture is, beyond the delta. Defaults to a move that
   *   drives both axes and is offered no distribution.
   */
  snap(
    targets: readonly SnapTarget[],
    delta: Point,
    zoom: number,
    enabled?: boolean,
    pass?: SnapPass,
  ): SnapResult;
  reset(): void;
}

const BOTH_AXES = { x: true, y: true } as const;
const NO_PASS: SnapPass = {};

const DEFAULT_THRESHOLD = 6;
const NO_GUIDES: readonly SnapGuide[] = [];

// ---------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------

/**
 * Whether snapping is on at all, for the session.
 *
 * Module state and deliberately not persisted, like the other sticky defaults:
 * it is a mood you are in while working, not a preference. Distinct from the
 * ⌘/Ctrl override a gesture passes to {@link Snapper.snap}, which suspends
 * snapping for one drag and leaves this untouched.
 */
let snapEnabled = true;
const snapListeners = new Set<() => void>();

export function isSnapEnabled(): boolean {
  return snapEnabled;
}

export function setSnapEnabled(on: boolean): void {
  if (on === snapEnabled) return;
  snapEnabled = on;
  for (const listener of snapListeners) listener();
}

/** Subscribe to {@link isSnapEnabled}, for `useSyncExternalStore`. */
export function subscribe(listener: () => void): () => void {
  snapListeners.add(listener);
  return () => {
    snapListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Building lines and targets
// ---------------------------------------------------------------------------

/** A box's six lines: both edges and the centre, on each axis. */
export function boxLines(rect: Rect): SnapLine[] {
  const x1 = rect.x;
  const x2 = rect.x + rect.w;
  const y1 = rect.y;
  const y2 = rect.y + rect.h;
  return [
    { axis: "x", at: x1, from: y1, to: y2, kind: "edge" },
    { axis: "x", at: x1 + rect.w / 2, from: y1, to: y2, kind: "centre" },
    { axis: "x", at: x2, from: y1, to: y2, kind: "edge" },
    { axis: "y", at: y1, from: x1, to: x2, kind: "edge" },
    { axis: "y", at: y1 + rect.h / 2, from: x1, to: x2, kind: "centre" },
    { axis: "y", at: y2, from: x1, to: x2, kind: "edge" },
  ];
}

/** The six lines a dragged box carries. Edges first, so grid snap uses one. */
export function boxTargets(rect: Rect): SnapTarget[] {
  const x1 = rect.x;
  const x2 = rect.x + rect.w;
  const y1 = rect.y;
  const y2 = rect.y + rect.h;
  return [
    { axis: "x", at: x1, weight: 1, from: y1, to: y2 },
    { axis: "x", at: x2, weight: 1, from: y1, to: y2 },
    { axis: "x", at: x1 + rect.w / 2, weight: 1, from: y1, to: y2 },
    { axis: "y", at: y1, weight: 1, from: x1, to: x2 },
    { axis: "y", at: y2, weight: 1, from: x1, to: x2 },
    { axis: "y", at: y1 + rect.h / 2, weight: 1, from: x1, to: x2 },
  ];
}

/**
 * The edges a resize handle moves. Only the dragged edges snap — a resize that
 * also snapped its centre would fight the handle. `fromCentre` (alt) adds the
 * opposite edge, which travels the other way, hence `weight: -1`.
 */
export function resizeTargets(
  rect: Rect,
  handle: Handle,
  fromCentre = false,
): SnapTarget[] {
  const out: SnapTarget[] = [];
  const x1 = rect.x;
  const x2 = rect.x + rect.w;
  const y1 = rect.y;
  const y2 = rect.y + rect.h;
  const hx = handle.includes("w") ? -1 : handle.includes("e") ? 1 : 0;
  const hy = handle.includes("n") ? -1 : handle.includes("s") ? 1 : 0;
  if (hx !== 0) {
    out.push({ axis: "x", at: hx > 0 ? x2 : x1, weight: 1, from: y1, to: y2 });
    if (fromCentre) {
      out.push({ axis: "x", at: hx > 0 ? x1 : x2, weight: -1, from: y1, to: y2 });
    }
  }
  if (hy !== 0) {
    out.push({ axis: "y", at: hy > 0 ? y2 : y1, weight: 1, from: x1, to: x2 });
    if (fromCentre) {
      out.push({ axis: "y", at: hy > 0 ? y1 : y2, weight: -1, from: x1, to: x2 });
    }
  }
  return out;
}

/** Everything one gesture may snap to, gathered once when it starts. */
export interface SnapScope {
  /** Every candidate's edges and centres, for alignment. */
  lines: SnapLine[];
  /** The sibling boxes whose gaps distribution measures. */
  boxes: Rect[];
}

/**
 * What the moving nodes may snap to, in **scene** space: their siblings, the
 * group that contains them, and the diagram surface.
 *
 * Siblings only, like Figma — a shape three groups deep is not a candidate for
 * something at the top level, and offering every node in the document as a
 * target makes the guides noise rather than information. A selection spanning
 * two parents has no shared siblings, so it falls back to the top level.
 *
 * The container and the surface align but do not distribute: a gap measured to
 * the inside of the frame you are working in is a number about the frame, not
 * about the row of shapes the eye is actually reading.
 */
export function collectSnapScope(
  scene: Scene,
  moving: ReadonlySet<NodeId>,
): SnapScope {
  const lines = boxLines({ x: 0, y: 0, w: scene.w, h: scene.h });
  const boxes: Rect[] = [];
  const parent = sharedParent(scene, moving);
  if (parent) lines.push(...boxLines(absoluteBounds(scene, parent.id)));
  for (const node of parent ? parent.children : scene.nodes) {
    if (node.hidden || moving.has(node.id)) continue;
    const box = absoluteBounds(scene, node.id);
    lines.push(...boxLines(box));
    boxes.push(box);
  }
  return { lines, boxes };
}

function sharedParent(scene: Scene, ids: ReadonlySet<NodeId>): GroupNode | null {
  let shared: GroupNode | null = null;
  let first = true;
  for (const id of ids) {
    const parent = findParent(scene, id);
    if (first) {
      shared = parent;
      first = false;
    } else if (parent !== shared) {
      return null;
    }
  }
  return shared;
}

// ---------------------------------------------------------------------------
// The snapper
// ---------------------------------------------------------------------------

interface Lock {
  target: SnapTarget;
  line: SnapLine;
  /** The delta at which the target sits exactly on the line. */
  delta: number;
}

/** A box's extent on one axis (`lo`/`hi`) and the band it occupies across it. */
interface Span {
  lo: number;
  hi: number;
  from: number;
  to: number;
}

/**
 * One of the equal gaps a distribution snap makes. `a` and `b` are the spans on
 * either side of it; `moves` says which of the two is the moving geometry, so
 * the mark can be redrawn where the gesture has since put it.
 */
interface Gap {
  a: Span;
  b: Span;
  moves: 0 | 1 | 2;
}

/** The distribution counterpart of {@link Lock}: a delta and what to draw. */
interface GapLock {
  delta: number;
  gaps: Gap[];
}

function spanOf(rect: Rect, axis: Axis): Span {
  return axis === "x"
    ? { lo: rect.x, hi: rect.x + rect.w, from: rect.y, to: rect.y + rect.h }
    : { lo: rect.y, hi: rect.y + rect.h, from: rect.x, to: rect.x + rect.w };
}

function carries(targets: readonly SnapTarget[], axis: Axis): boolean {
  for (const target of targets) if (target.axis === axis) return true;
  return false;
}

export function createSnapper(
  scope: SnapScope,
  options: SnapOptions = {},
): Snapper {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const grid = options.grid ?? 0;
  const linesX = scope.lines.filter((line) => line.axis === "x");
  const linesY = scope.lines.filter((line) => line.axis === "y");
  // Partitioned per axis here for the same reason the lines are: the searches
  // below run inside a pointer gesture and may only do the cheap part.
  const spansX = scope.boxes.map((box) => spanOf(box, "x"));
  const spansY = scope.boxes.map((box) => spanOf(box, "y"));
  const movingX = options.moving ? spanOf(options.moving, "x") : null;
  const movingY = options.moving ? spanOf(options.moving, "y") : null;

  let lockX: Lock | null = null;
  let lockY: Lock | null = null;
  let gapX: GapLock | null = null;
  let gapY: GapLock | null = null;

  function resolve(
    axis: Axis,
    lock: Lock | null,
    targets: readonly SnapTarget[],
    raw: number,
    tolerance: number,
  ): Lock | null {
    // Held while the pointer stays within reach of where the snap put it.
    if (lock && Math.abs(raw - lock.delta) <= tolerance) return lock;

    const candidates = axis === "x" ? linesX : linesY;
    let best: Lock | null = null;
    let bestDistance = Infinity;
    for (const target of targets) {
      if (target.axis !== axis) continue;
      const position = target.at + target.weight * raw;
      for (const line of candidates) {
        const distance = Math.abs(line.at - position);
        if (distance > tolerance) continue;
        const closer = distance < bestDistance - 0.01;
        const tied =
          !closer &&
          distance <= bestDistance + 0.01 &&
          line.kind === "centre" &&
          best?.line.kind !== "centre";
        if (!closer && !tied) continue;
        bestDistance = Math.min(bestDistance, distance);
        best = {
          target,
          line,
          delta: (line.at - target.at) / target.weight,
        };
      }
    }
    return best;
  }

  /**
   * The equal-gap search, through the same lock as alignment.
   *
   * Only three placements are worth offering, and all three are read off the
   * moving box's immediate neighbours: sit between them with matching gaps, or
   * continue the run that one of them already belongs to. Anything further
   * afield is a coincidence rather than a layout the eye was reading.
   */
  function resolveGap(
    axis: Axis,
    lock: GapLock | null,
    raw: number,
    cross: number,
    tolerance: number,
  ): GapLock | null {
    if (lock && Math.abs(raw - lock.delta) <= tolerance) return lock;

    const moving = axis === "x" ? movingX : movingY;
    const spans = axis === "x" ? spansX : spansY;
    if (!moving || spans.length < 2) return null;
    const lo = moving.lo + raw;
    const hi = moving.hi + raw;
    const from = moving.from + cross;
    const to = moving.to + cross;

    // Candidates that share no band with the moving box are measuring a gap
    // across a different row, which is a number about nothing. The tolerance
    // slack on either side keeps a snap reachable from both directions, the
    // same way the alignment search is.
    let left: Span | null = null;
    let right: Span | null = null;
    for (const span of spans) {
      if (span.to <= from || span.from >= to) continue;
      if (span.hi <= lo + tolerance) {
        if (!left || span.hi > left.hi) left = span;
      } else if (span.lo >= hi - tolerance) {
        if (!right || span.lo < right.lo) right = span;
      }
    }
    if (!left && !right) return null;

    // The neighbours' own neighbours — the run to continue. Judged in the
    // moving box's band, not each other's: a run the eye reads is a row.
    let beyondLeft: Span | null = null;
    let beyondRight: Span | null = null;
    for (const span of spans) {
      if (span.to <= from || span.from >= to) continue;
      if (left && span.hi <= left.lo && (!beyondLeft || span.hi > beyondLeft.hi)) {
        beyondLeft = span;
      }
      if (right && span.lo >= right.hi && (!beyondRight || span.lo < beyondRight.lo)) {
        beyondRight = span;
      }
    }

    // In preference order, and each rejected unless it lands the box clear of
    // the neighbour on the far side.
    const placements: GapLock[] = [];
    if (left && right) {
      const delta = (left.hi + right.lo - moving.lo - moving.hi) / 2;
      if (moving.lo + delta >= left.hi) {
        placements.push({
          delta,
          gaps: [
            { a: left, b: moving, moves: 2 },
            { a: moving, b: right, moves: 1 },
          ],
        });
      }
    }
    if (right && beyondRight) {
      const delta = right.lo - (beyondRight.lo - right.hi) - moving.hi;
      if (!left || moving.lo + delta >= left.hi) {
        placements.push({
          delta,
          gaps: [
            { a: moving, b: right, moves: 1 },
            { a: right, b: beyondRight, moves: 0 },
          ],
        });
      }
    }
    if (left && beyondLeft) {
      const delta = left.hi + (left.lo - beyondLeft.hi) - moving.lo;
      if (!right || moving.hi + delta <= right.lo) {
        placements.push({
          delta,
          gaps: [
            { a: beyondLeft, b: left, moves: 0 },
            { a: left, b: moving, moves: 2 },
          ],
        });
      }
    }

    // Centring between two neighbours is offered first and beaten only by a
    // clear margin, so a tie goes to it — dropping into a slot is what the
    // gesture usually means.
    let best: GapLock | null = null;
    let bestDistance = Infinity;
    for (const placement of placements) {
      const distance = Math.abs(placement.delta - raw);
      if (distance > tolerance || distance >= bestDistance - 0.01) continue;
      bestDistance = distance;
      best = placement;
    }
    return best;
  }

  function toGrid(
    axis: Axis,
    targets: readonly SnapTarget[],
    raw: number,
  ): number {
    if (grid <= 0) return raw;
    const target = targets.find((candidate) => candidate.axis === axis);
    if (!target) return Math.round(raw / grid) * grid;
    const position = target.at + target.weight * raw;
    return (Math.round(position / grid) * grid - target.at) / target.weight;
  }

  function guideFor(lock: Lock, otherDelta: number): SnapGuide {
    const { line, target } = lock;
    // The target's extent travels with the gesture's other axis, so the guide
    // spans the two nodes where they actually are, not where they started.
    return {
      axis: line.axis,
      at: line.at,
      from: Math.min(line.from, target.from + otherDelta),
      to: Math.max(line.to, target.to + otherDelta),
      kind: line.kind,
    };
  }

  /**
   * A mark spanning one equal gap, drawn across the axis it measures — so a gap
   * along x is a horizontal bar. `delta` is where the gesture has put the
   * moving span on that axis and `cross` where it has put it on the other, so a
   * held snap keeps its marks on the shape rather than where it entered.
   */
  function gapGuide(gap: Gap, axis: Axis, delta: number, cross: number): SnapGuide {
    const ad = gap.moves === 1 ? delta : 0;
    const bd = gap.moves === 2 ? delta : 0;
    const ac = gap.moves === 1 ? cross : 0;
    const bc = gap.moves === 2 ? cross : 0;
    return {
      axis: axis === "x" ? "y" : "x",
      at:
        (Math.max(gap.a.from + ac, gap.b.from + bc) +
          Math.min(gap.a.to + ac, gap.b.to + bc)) /
        2,
      from: gap.a.hi + ad,
      to: gap.b.lo + bd,
      kind: "spacing",
    };
  }

  return {
    snap(targets, delta, zoom, enabled = true, pass = NO_PASS) {
      if (!enabled || !snapEnabled) {
        lockX = null;
        lockY = null;
        gapX = null;
        gapY = null;
        return { dx: delta.x, dy: delta.y, guides: NO_GUIDES };
      }
      const tolerance = threshold / Math.max(zoom, 0.001);
      lockX = resolve("x", lockX, targets, delta.x, tolerance);
      lockY = resolve("y", lockY, targets, delta.y, tolerance);

      // Alignment wins the axis outright, and its lock drops any distribution
      // one — a spacing snap left standing would resume the moment the
      // alignment released, from a search two pointer positions stale. An axis
      // the gesture carries no target on is one Shift has locked out, which
      // distribution must respect exactly as the alignment search does.
      const distribute = pass.spacing === true;
      gapX =
        distribute && !lockX && carries(targets, "x")
          ? resolveGap("x", gapX, delta.x, delta.y, tolerance)
          : null;
      gapY =
        distribute && !lockY && carries(targets, "y")
          ? resolveGap("y", gapY, delta.y, delta.x, tolerance)
          : null;

      const dx = lockX
        ? lockX.delta
        : gapX
          ? gapX.delta
          : toGrid("x", targets, delta.x);
      const dy = lockY
        ? lockY.delta
        : gapY
          ? gapY.delta
          : toGrid("y", targets, delta.y);

      let guides: readonly SnapGuide[] = NO_GUIDES;
      if (lockX || lockY || gapX || gapY) {
        const drives = pass.drives ?? BOTH_AXES;
        const fired: SnapGuide[] = [];
        if (lockX) fired.push(guideFor(lockX, drives.y ? dy : 0));
        if (lockY) fired.push(guideFor(lockY, drives.x ? dx : 0));
        if (gapX) {
          for (const gap of gapX.gaps) fired.push(gapGuide(gap, "x", dx, dy));
        }
        if (gapY) {
          for (const gap of gapY.gaps) fired.push(gapGuide(gap, "y", dy, dx));
        }
        guides = fired;
      }
      return { dx, dy, guides };
    },

    reset() {
      lockX = null;
      lockY = null;
      gapX = null;
      gapY = null;
    },
  };
}
