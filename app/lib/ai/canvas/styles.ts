import { isAutoLayout, layoutOf } from "@/app/components/editor/canvas/scene/autoLayout";
import { paintOf } from "@/app/components/editor/canvas/scene/paint";
import {
  findNode,
  isArc,
  isBoolean,
  isGroup,
  nodePath,
  walk,
  type EdgeId,
  type GroupLayout,
  type NodeId,
  type Scene,
  type SceneNodeKind,
  type StyleMap,
} from "@/app/components/editor/canvas/scene/types";
import { customProperties, resolveVars, type ColorVariable } from "@/app/components/editor/canvas/scene/vars";
import { parseColor } from "@/app/components/editor/canvas/panels/controls/color";
import { AI } from "../aiConfig";

/**
 * `get_styles`' report — "what everything on a diagram looks like" (TOOLS.md
 * §5.2): each shape's CSS exactly as authored, the same declarations with
 * every `var()` resolved along the CSS cascade, the diagram's own tokens, and
 * for a drawn kind the fill/stroke it actually paints with. Pure.
 */

export type NodeStyles = {
  id: string;
  kind: SceneNodeKind;
  style: StyleMap;
  resolved?: StyleMap;
  paint?: { fill: string | null; stroke?: string; strokeWidth?: string };
  layout?: GroupLayout;
};

export type StylesReport = {
  diagram: { style: StyleMap; resolved?: StyleMap };
  tokens: { name: string; value: string; resolved: string; color: boolean }[];
  nodes: NodeStyles[];
  edges: { id: EdgeId; style: StyleMap; resolved?: StyleMap }[];
  omitted?: number;
};

/** Only the declarations a `var()` actually appears in, resolved — `undefined`
 *  when nothing in `style` references one, so a plain node costs no field. */
function resolvedSubset(style: StyleMap, vars: readonly ColorVariable[]): StyleMap | undefined {
  const out: StyleMap = {};
  let any = false;
  for (const [prop, value] of Object.entries(style)) {
    if (!value.includes("var(")) continue;
    any = true;
    out[prop] = resolveVars(value, vars);
  }
  return any ? out : undefined;
}

/** Fill/stroke as the shape actually paints — the same reading `toHtml.ts`
 *  and the renderer use, over the style with every `var()` already inlined so
 *  a token never shows up as `null` for want of resolving it first. */
function paintReport(style: StyleMap, vars: readonly ColorVariable[]): NodeStyles["paint"] {
  const resolved: StyleMap = {};
  for (const [prop, value] of Object.entries(style)) resolved[prop] = resolveVars(value, vars);
  const paint = paintOf(resolved);
  const fill = paint.css ?? (paint.fill === "none" ? null : paint.fill);
  return {
    fill,
    ...(paint.attrs.stroke ? { stroke: paint.attrs.stroke } : {}),
    ...(paint.attrs.strokeWidth ? { strokeWidth: paint.attrs.strokeWidth } : {}),
  };
}

function isPaintedKind(node: { kind: SceneNodeKind }): boolean {
  return node.kind === "polygon" || node.kind === "path";
}

export function stylesReport(
  scene: Scene,
  opts: { ids?: readonly string[]; max?: number } = {},
): StylesReport {
  const wanted = opts.ids?.length ? new Set(opts.ids) : null;
  const max = opts.max ?? AI.chat.canvas.maxStyleNodes;
  const diagramVars = customProperties(scene.style);

  const tokens = diagramVars.map((v) => {
    const resolved = resolveVars(v.value, diagramVars);
    return { name: v.name, value: v.value, resolved, color: parseColor(resolved) !== null };
  });

  const diagram = {
    style: scene.style,
    resolved: resolvedSubset(scene.style, diagramVars),
  };

  type Row = {
    id: NodeId;
    kind: SceneNodeKind;
    style: StyleMap;
    vars: ColorVariable[];
    groupLayoutMode: boolean;
    painted: boolean;
  };
  const rows: Row[] = [];
  walk(scene.nodes, (node) => {
    if (wanted && !nodePath(scene, node.id).some((n) => wanted.has(n.id))) return;
    const ancestors = nodePath(scene, node.id).slice(0, -1).reverse();
    const vars = [
      ...customProperties(node.style),
      ...ancestors.flatMap((a) => customProperties(a.style)),
      ...diagramVars,
    ];
    rows.push({
      id: node.id,
      kind: node.kind,
      style: node.style,
      vars,
      groupLayoutMode: isGroup(node) && isAutoLayout(node),
      painted: isPaintedKind(node) || isArc(node) || isBoolean(node),
    });
  });

  const capped = rows.slice(0, max);
  const omitted = rows.length - capped.length;

  const nodes: NodeStyles[] = capped.map((row) => {
    const entry: NodeStyles = { id: row.id, kind: row.kind, style: row.style };
    const resolved = resolvedSubset(row.style, row.vars);
    if (resolved) entry.resolved = resolved;
    if (row.painted) entry.paint = paintReport(row.style, row.vars);
    if (row.groupLayoutMode) {
      const node = findNode(scene, row.id);
      if (node && isGroup(node)) entry.layout = layoutOf(node);
    }
    return entry;
  });

  const edges = scene.edges
    .filter((e) => !wanted || (wanted.has(e.from) && wanted.has(e.to)))
    .map((e) => {
      const resolved = resolvedSubset(e.style, diagramVars);
      return { id: e.id, style: e.style, ...(resolved ? { resolved } : {}) };
    });

  return {
    diagram: diagram.resolved ? diagram : { style: diagram.style },
    tokens,
    nodes,
    edges,
    ...(omitted ? { omitted } : {}),
  };
}
