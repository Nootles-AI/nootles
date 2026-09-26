import { COLUMN_WIDTH } from "@/app/lib/column";
import { bandLeft, bandWidth } from "./bandSpan";
import type { Rect, Scene, SceneOp } from "./types";

/** Below this, two coordinates are the same place. */
const EPS = 1e-6;

/**
 * What a band has to do to hold `box`, drawn somewhere its author could not
 * be kept inside it.
 *
 * Most gestures clamp their input — the pointer that sizes a shape or drags
 * one is held in the band — and their output follows. A pen cannot: a curve
 * reaches past the anchors and handles it was given, so what it draws is only
 * known once it is drawn. This is the band's answer to such a drawing, the
 * same one it gives a model's (`fitToBand`): past the column it turns wide,
 * and what is still above its top or past its range moves in by the least
 * amount — the whole drawing, so its own arrangement is kept. Below needs
 * nothing; the band's floor already follows its lowest content down.
 */
export interface Room {
  /** The band turns wide to reach `box`. */
  wide: boolean;
  /** How far everything moves to land `box` inside. */
  dx: number;
  dy: number;
}

export function roomFor(scene: Pick<Scene, "wide">, box: Rect): Room | null {
  const wide = scene.wide !== true && (box.x < -EPS || box.x + box.w > COLUMN_WIDTH + EPS);
  const left = bandLeft({ wide: scene.wide || wide });
  const { dx, dy } = leastMove(box, left, left + bandWidth({ wide: scene.wide || wide }));
  return wide || dx || dy ? { wide, dx, dy } : null;
}

/**
 * The least move that lands `box` between `left` and `right` and below the
 * band's top — its left edge on `left` when it is wider than the room.
 */
export function leastMove(box: Rect, left: number, right: number): { dx: number; dy: number } {
  const dx =
    box.x < left - EPS
      ? left - box.x
      : box.x + box.w > right + EPS
        ? Math.max(left - box.x, right - (box.x + box.w))
        : 0;
  return { dx, dy: box.y < -EPS ? -box.y : 0 };
}

/** {@link Room} as the ops that make it: every top-level node moves. */
export function roomOps(scene: Scene, room: Room): SceneOp[] {
  const ops: SceneOp[] = [];
  if (room.wide) ops.push({ type: "setDiagram", wide: true });
  if (room.dx || room.dy) {
    ops.push({ type: "move", ids: scene.nodes.map((node) => node.id), dx: room.dx, dy: room.dy });
  }
  return ops;
}
