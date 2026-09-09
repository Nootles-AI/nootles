import { clipperReady, derivedPath, withFrames, type LiveBox } from "../scene/boolean";
import { findNode, isBoolean, nodePath, type NodeId, type Scene } from "../scene/types";

/**
 * Redraw a boolean group mid-gesture, without going through the store.
 *
 * A boolean group draws one path and none of its operands, so dragging an
 * operand paints nothing by itself: the element the gesture is moving does
 * not exist. What should move is the cut. So the gesture hands over the boxes
 * it is holding this frame, the group is rebuilt with those boxes in it, the
 * same derivation the renderer uses runs again, and the `d` is written back.
 * React overwrites it on the commit that follows — this only has to be right
 * until then.
 *
 * Only the outermost boolean ancestor has an element: everything inside it is
 * folded into that one drawing, so that is the one path to rewrite.
 */
export interface LiveBooleans {
  groups: { id: NodeId; path: SVGPathElement }[];
}

/** Settle which drawings a gesture on `ids` can change, and find their paths once. */
export function prepareBooleans(
  scene: Scene,
  ids: readonly NodeId[],
  getElement: (id: NodeId) => HTMLElement | null,
): LiveBooleans {
  const groups: LiveBooleans["groups"] = [];
  const seen = new Set<NodeId>();
  for (const id of ids) {
    const chain = nodePath(scene, id);
    // The node itself moves as a whole; only an ancestor's cut changes.
    const outer = chain.slice(0, -1).find(isBoolean);
    if (!outer || seen.has(outer.id)) continue;
    seen.add(outer.id);
    const path = getElement(outer.id)?.querySelector("path");
    if (path) groups.push({ id: outer.id, path });
  }
  return { groups };
}

export function reflowBooleans(live: LiveBooleans | null, scene: Scene, frames: readonly LiveBox[]): void {
  if (!live?.groups.length || frames.length === 0 || !clipperReady()) return;
  const byId = new Map(frames.map((frame) => [frame.id, frame]));
  for (const { id, path } of live.groups) {
    const group = findNode(scene, id);
    if (!group || !isBoolean(group)) continue;
    const d = derivedPath(withFrames(group, byId));
    if (d !== null && path.getAttribute("d") !== d) path.setAttribute("d", d);
  }
}
