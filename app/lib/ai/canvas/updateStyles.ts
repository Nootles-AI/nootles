import { applyOps } from "@/app/components/editor/canvas/scene/ops";
import {
  findNode,
  type Scene,
  type SceneOp,
} from "@/app/components/editor/canvas/scene/types";
import { refused, type Refusal } from "./host";

/**
 * `update_styles`' planner — "recolour or restyle many shapes at once" (TOOLS.md
 * §5.5). One patch names ids (shapes, connectors, or the literal `"diagram"`)
 * and the declarations to set; `null` removes one. Applied in patch order, so
 * a later patch touching the same id wins.
 */

export type StylePatchInput = {
  ids: readonly string[];
  style: Record<string, string | null>;
};

export type StylesPlan = {
  ops: SceneOp[];
  next: Scene;
  touched: string[];
};

/** `position`, `left`, and friends move a shape; they are not a style
 *  declaration `update_styles` will touch — `move`/`write_nodes` do that. */
const GEOMETRY_PROPS = new Set(["position", "left", "top", "right", "bottom", "transform", "inset"]);

const PROP_NAME = /^(--[\w-]+|[a-z][a-z0-9-]*)$/i;

export function planUpdateStyles(
  scene: Scene,
  patches: readonly StylePatchInput[],
): StylesPlan | Refusal {
  for (const patch of patches) {
    for (const prop of Object.keys(patch.style)) {
      if (!PROP_NAME.test(prop)) {
        return refused(`"${prop}" is not a CSS property name update_styles can write.`);
      }
      if (GEOMETRY_PROPS.has(prop.toLowerCase())) {
        return refused(
          `${prop} is geometry, not style — move the shape with move, or write its box with write_nodes.`,
        );
      }
    }
    for (const id of patch.ids) {
      if (id === "diagram") continue;
      const isNode = findNode(scene, id) !== null;
      const isEdge = scene.edges.some((e) => e.id === id);
      if (!isNode && !isEdge) {
        return refused(
          `This diagram has no shape, connector, or "diagram" surface with id "${id}".`,
        );
      }
    }
  }

  const ops: SceneOp[] = [];
  const touched = new Set<string>();
  for (const patch of patches) {
    const decls = trimmed(patch.style);
    if (!Object.keys(decls).length) continue;
    const nodeIds = patch.ids.filter((id) => id !== "diagram" && findNode(scene, id) !== null);
    const edgeIds = patch.ids.filter((id) => scene.edges.some((e) => e.id === id));
    const diagram = patch.ids.includes("diagram");
    if (nodeIds.length) {
      ops.push({ type: "setStyle", ids: nodeIds, decls });
      for (const id of nodeIds) touched.add(id);
    }
    if (edgeIds.length) {
      ops.push({ type: "setEdgeStyle", ids: edgeIds, decls });
      for (const id of edgeIds) touched.add(id);
    }
    if (diagram) {
      ops.push({ type: "setDiagram", style: decls });
      touched.add("diagram");
    }
  }

  const next = applyOps(scene, ops);
  return { ops, next, touched: [...touched] };
}

/** `null` → remove; a real value is trimmed, so incidental whitespace from a
 *  model is never why two calls disagree on whether anything changed. */
function trimmed(style: Record<string, string | null>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [prop, value] of Object.entries(style)) {
    out[prop] = value === null ? undefined : value.trim();
  }
  return out;
}
