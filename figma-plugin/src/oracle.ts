/**
 * The placement oracle, for tests and for a details dump.
 *
 * Figma's `absoluteTransform` is the truth about where every node sits on the
 * page, and `absoluteRect` is where the canvas puts it once layout and
 * hugging have had their say. Independent of the converter's own arithmetic:
 * the centre is read straight off the matrix and the clockwise turn off its
 * first column. One line per node more than half a pixel or half a degree
 * off, so a whole details dump is one assertion.
 */

import { laidOutScene } from "@/app/components/editor/canvas/scene/autoLayout";
import { absoluteRect, absoluteRotation } from "@/app/components/editor/canvas/scene/geometry";
import { reflowHugs } from "@/app/components/editor/canvas/scene/ops";
import type { Scene, SceneNode } from "@/app/components/editor/canvas/scene/types";
import type { FigNode } from "./model";
import { round } from "./paint";

export function misplaced(selection: FigNode[], scene: Scene): string[] {
  const expected = (node: FigNode) => {
    const [[a, b, tx], [c, d, ty]] = node.absoluteTransform!;
    const cx = tx + (a * node.width + b * node.height) / 2;
    const cy = ty + (c * node.width + d * node.height) / 2;
    // A mirror is read as a horizontal flip and then a turn; the turn is the rot.
    const mirrored = a * d - b * c < 0;
    const rot = (Math.atan2(mirrored ? -c : c, mirrored ? -a : a) * 180) / Math.PI;
    return { x: cx - node.width / 2, y: cy - node.height / 2, w: node.width, h: node.height, rot };
  };
  const tops = selection.filter((n) => n.type !== "CONNECTOR" && n.absoluteTransform).map(expected);
  const corner = { x: Math.min(...tops.map((t) => t.x)), y: Math.min(...tops.map((t) => t.y)) };
  const laid = reflowHugs(laidOutScene(scene));
  const sceneNodeOf = (figmaId: string, nodes: SceneNode[] = laid.nodes): SceneNode | null => {
    for (const n of nodes) {
      if (n.attrs["data-figma-id"] === figmaId) return n;
      if (n.kind === "group") {
        const inner = sceneNodeOf(figmaId, n.children);
        if (inner) return inner;
      }
    }
    return null;
  };
  const turn = (deg: number) => Math.abs((((deg % 360) + 540) % 360) - 180);
  const out: string[] = [];
  const walk = (node: FigNode) => {
    // A connector is an edge, and a mask is a declaration; neither has a box.
    if (node.type === "CONNECTOR" || node.isMask) return;
    const placed = sceneNodeOf(node.id);
    if (!placed) {
      out.push(`${node.name} (${node.id}): not in the scene`);
      return;
    }
    if (node.absoluteTransform) {
      const want = expected(node);
      want.x -= corner.x;
      want.y -= corner.y;
      const got = { ...absoluteRect(laid, placed.id), rot: absoluteRotation(laid, placed.id) };
      const off = (["x", "y", "w", "h", "rot"] as const).filter((k) => (k === "rot" ? turn(got.rot - want.rot) : Math.abs(got[k] - want[k])) > 0.5);
      if (off.length) out.push(`${node.name} (${node.id}): ${off.map((k) => `${k} ${round(got[k])} ≠ ${round(want[k])}`).join(", ")}`);
    }
    // A boolean operation is one path on the canvas; its operands have no box of their own.
    if (placed.kind === "group") node.children?.forEach(walk);
  };
  selection.forEach(walk);
  return out;
}

/**
 * A details dump, as the converter's input. The dump is what `code.ts` saw,
 * so a text's styled segments are handed back as the method the converter
 * calls, and nothing else needs rehydrating.
 */
export function rehydrate(dump: unknown): FigNode {
  const node = dump as FigNode & { segments?: unknown[]; children?: unknown[] };
  const out: FigNode = { ...node };
  if (Array.isArray(node.segments)) out.getStyledTextSegments = () => node.segments as never;
  if (Array.isArray(node.children)) out.children = node.children.map(rehydrate);
  return out;
}
