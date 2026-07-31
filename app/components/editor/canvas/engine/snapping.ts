/**
 * Alignment snapping — the thing that makes placement feel deliberate.
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

/** Only so the overlay can style them, and so ties prefer a centre. */
export type SnapKind = "edge" | "centre";

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

/** A guide that fired. `at` is the static line it landed on. */
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
   * @param drives which axes the gesture actually moves. A guide is drawn long
   *   enough to reach the geometry it lines up with, and that geometry travels
   *   with the gesture — but an edge handle drives ONE axis, and extending the
   *   guide by pointer wander on the other drew it far past anything that had
   *   moved. Defaults to both, which is a move.
   */
  snap(
    targets: readonly SnapTarget[],
    delta: Point,
    zoom: number,
    enabled?: boolean,
    drives?: { x: boolean; y: boolean },
  ): SnapResult;
  reset(): void;
}

const BOTH_AXES = { x: true, y: true } as const;

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

/**
 * What the moving nodes may snap to, in **scene** space: their siblings, the
 * group that contains them, and the diagram surface.
 *
 * Siblings only, like Figma — a shape three groups deep is not a candidate for
 * something at the top level, and offering every node in the document as a
 * target makes the guides noise rather than information. A selection spanning
 * two parents has no shared siblings, so it falls back to the top level.
 */
export function collectSnapLines(
  scene: Scene,
  moving: ReadonlySet<NodeId>,
): SnapLine[] {
  const lines = boxLines({ x: 0, y: 0, w: scene.w, h: scene.h });
  const parent = sharedParent(scene, moving);
  if (parent) lines.push(...boxLines(absoluteBounds(scene, parent.id)));
  for (const node of parent ? parent.children : scene.nodes) {
    if (node.hidden || moving.has(node.id)) continue;
    lines.push(...boxLines(absoluteBounds(scene, node.id)));
  }
  return lines;
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

export function createSnapper(
  lines: readonly SnapLine[],
  options: SnapOptions = {},
): Snapper {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const grid = options.grid ?? 0;
  const linesX = lines.filter((line) => line.axis === "x");
  const linesY = lines.filter((line) => line.axis === "y");

  let lockX: Lock | null = null;
  let lockY: Lock | null = null;

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

  return {
    snap(targets, delta, zoom, enabled = true, drives = BOTH_AXES) {
      if (!enabled || !snapEnabled) {
        lockX = null;
        lockY = null;
        return { dx: delta.x, dy: delta.y, guides: NO_GUIDES };
      }
      const tolerance = threshold / Math.max(zoom, 0.001);
      lockX = resolve("x", lockX, targets, delta.x, tolerance);
      lockY = resolve("y", lockY, targets, delta.y, tolerance);

      const dx = lockX ? lockX.delta : toGrid("x", targets, delta.x);
      const dy = lockY ? lockY.delta : toGrid("y", targets, delta.y);

      let guides: readonly SnapGuide[] = NO_GUIDES;
      if (lockX || lockY) {
        const fired: SnapGuide[] = [];
        if (lockX) fired.push(guideFor(lockX, drives.y ? dy : 0));
        if (lockY) fired.push(guideFor(lockY, drives.x ? dx : 0));
        guides = fired;
      }
      return { dx, dy, guides };
    },

    reset() {
      lockX = null;
      lockY = null;
    },
  };
}
