/**
 * A Figma selection as a canvas scene.
 *
 * Pure: Figma nodes in, a `Scene` out, and nothing touched on the way. Image
 * bytes are the one thing the converter cannot reach for itself, so they are
 * asked for up front through `images` and handed back as data URIs; the
 * plugin's main thread is the only place that can fetch them, and a test
 * hands in a stub.
 *
 * The output is the canvas's own model, serialized by the canvas's own
 * serializer, so what lands on the clipboard is byte for byte what a hand
 * would have drawn — the same grammar the AI reads and writes. Every node
 * carries the id it had in Figma as `data-figma-id`, which the grammar keeps
 * verbatim: that is the hook a later paste-and-replace hangs on.
 *
 * Nothing disappears silently. A node the canvas cannot hold becomes a
 * placeholder that says what it was, and every loss is a line in the report
 * the plugin shows beside its Copy button.
 */

import { textToLabel } from "@/app/components/editor/canvas/scene/label";
import type {
  EllipseNode,
  GroupNode,
  Scene,
  SceneEdge,
  SceneNode,
  StyleMap,
} from "@/app/components/editor/canvas/scene/types";
import { num, paints, type FigNode, type Transform } from "./model";
import {
  backgroundOf,
  compositeDecls,
  effectDecls,
  pathPaintDecls,
  radiusDecls,
  round,
  strokeDecls,
  type Decls,
  type ImageLayer,
} from "./paint";
import { convertText } from "./text";

export type Diagnostic = {
  code: string;
  nodeId: string;
  name: string;
  message: string;
};

export type ConvertResult = {
  scene: Scene;
  report: Diagnostic[];
  /** Shapes written, connectors included. */
  count: number;
};

/** Image bytes by Figma hash, as a data URI, or null when they cannot be had. */
export type ImageSource = (hash: string) => Promise<string | null>;

// ---------------------------------------------------------------------------

const DEFAULT_NAME = /^(Rectangle|Ellipse|Frame|Group|Text|Line|Vector|Polygon|Star|Section|Component|Instance|Arrow|Union|Subtract|Intersect|Exclude|Boolean|Slice|Sticky|Shape|Connector)( \d+)?$/i;

/** A Figma id (`12:34`, `I12:34;56:78`) as an id the grammar is happy with. */
const idOf = (node: FigNode) => `f${node.id.replace(/[^A-Za-z0-9]+/g, "-")}`;

const visible = (paint: { visible?: boolean }) => paint.visible !== false;

const deg = (rad: number) => (rad * 180) / Math.PI;

/**
 * Where a node sits, from its transform: the canvas holds the unrotated box
 * and a clockwise turn about its centre, Figma a transform whose origin is the
 * node's own top-left corner. The centre is the one point both agree on.
 */
function frameOf(node: FigNode, transform: Transform | undefined) {
  const w = node.width;
  const h = node.height;
  if (!transform) {
    return { x: node.x, y: node.y, w, h, rot: 0 };
  }
  const [[a, b, tx], [c, d, ty]] = transform;
  const cx = tx + a * (w / 2) + b * (h / 2);
  const cy = ty + c * (w / 2) + d * (h / 2);
  const rot = (deg(Math.atan2(c, a)) + 360) % 360;
  return { x: cx - w / 2, y: cy - h / 2, w, h, rot: round(rot, 2) };
}

type Ctx = {
  report: Diagnostic[];
  images: Map<string, string | null>;
  /** Figma id → our id, for the connectors that follow the shapes. */
  ids: Map<string, string>;
};

function note(ctx: Ctx, node: FigNode, code: string, message: string) {
  ctx.report.push({ code, nodeId: node.id, name: node.name, message });
}

function base(node: FigNode, frame: ReturnType<typeof frameOf>, style: StyleMap, ctx: Ctx) {
  const id = idOf(node);
  ctx.ids.set(node.id, id);
  const named = node.name && !DEFAULT_NAME.test(node.name.trim());
  return {
    id,
    x: round(frame.x),
    y: round(frame.y),
    w: round(frame.w),
    h: round(frame.h),
    rot: frame.rot,
    style,
    label: "",
    ...(named ? { name: node.name } : {}),
    locked: node.locked === true,
    hidden: node.visible === false,
    attrs: { "data-figma-id": node.id },
  };
}

/** The paint every box shares: fills, stroke, corners, effects, compositing. */
function boxStyle(node: FigNode, ctx: Ctx, opts: { fills?: boolean } = {}): Decls {
  const style: Decls = {};
  if (opts.fills !== false) {
    const background = backgroundOf(paints(node.fills), node.width, node.height, (layer: ImageLayer) => {
      const src = ctx.images.get(layer.hash) ?? null;
      if (!src) note(ctx, node, "image_missing", "An image fill could not be read and was left out.");
      return src;
    });
    if (background) style.background = background;
  }
  Object.assign(
    style,
    strokeDecls(node.strokes, num(node.strokeWeight), node.strokeAlign, node.dashPattern),
    radiusDecls(node),
    effectDecls(node.effects),
    compositeDecls(node),
  );
  return style;
}

const AXIS: Record<string, string> = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", SPACE_BETWEEN: "space-between", BASELINE: "baseline" };

/** A frame's auto layout as the CSS the layout engine reads. */
function layoutStyle(node: FigNode, ctx: Ctx): Decls {
  const style: Decls = {};
  const mode = node.layoutMode ?? "NONE";
  if (mode === "GRID") {
    style.display = "grid";
    note(ctx, node, "grid_layout", "A grid layout was brought as a grid without its tracks.");
  } else if (mode === "HORIZONTAL" || mode === "VERTICAL") {
    style.display = "flex";
    if (mode === "VERTICAL") style["flex-direction"] = "column";
    if (node.layoutWrap === "WRAP") style["flex-wrap"] = "wrap";
    const gap = node.itemSpacing ?? 0;
    const cross = node.counterAxisSpacing ?? null;
    if (gap > 0 || (cross !== null && cross > 0)) {
      style.gap = cross !== null && cross !== gap ? `${round(cross)}px ${round(gap)}px` : `${round(gap)}px`;
    }
    const justify = AXIS[node.primaryAxisAlignItems ?? "MIN"];
    if (justify && justify !== "flex-start") style["justify-content"] = justify;
    const align = AXIS[node.counterAxisAlignItems ?? "MIN"];
    if (align && align !== "flex-start") style["align-items"] = align;
  }
  const pad = [node.paddingTop ?? 0, node.paddingRight ?? 0, node.paddingBottom ?? 0, node.paddingLeft ?? 0];
  if (pad.some((p) => p > 0)) {
    const [t, r, b, l] = pad.map((p) => `${round(p)}px`);
    style.padding = t === r && r === b && b === l ? t : t === b && r === l ? `${t} ${r}` : `${t} ${r} ${b} ${l}`;
  }
  if (node.layoutSizingHorizontal === "HUG") style.width = "fit-content";
  if (node.layoutSizingVertical === "HUG") style.height = "fit-content";
  if (node.clipsContent === true) style.overflow = "hidden";
  return style;
}

/** What a child of an auto-layout frame says about its own slot. */
function childLayoutStyle(node: FigNode, parent: FigNode | undefined): Decls {
  const style: Decls = {};
  if (!parent || (parent.layoutMode !== "HORIZONTAL" && parent.layoutMode !== "VERTICAL")) return style;
  if (node.layoutPositioning === "ABSOLUTE") {
    style.position = "absolute";
    return style;
  }
  const row = parent.layoutMode === "HORIZONTAL";
  const main = row ? node.layoutSizingHorizontal : node.layoutSizingVertical;
  const cross = row ? node.layoutSizingVertical : node.layoutSizingHorizontal;
  if (main === "FILL") style.flex = "1";
  if (cross === "FILL") style["align-self"] = "stretch";
  return style;
}

// ---------------------------------------------------------------------------

function convertNode(node: FigNode, parent: FigNode | undefined, ctx: Ctx, transform: Transform | undefined): SceneNode | null {
  const frame = frameOf(node, transform);
  const slot = childLayoutStyle(node, parent);

  switch (node.type) {
    case "FRAME":
    case "GROUP":
    case "SECTION":
    case "COMPONENT":
    case "COMPONENT_SET":
    case "INSTANCE": {
      const style: StyleMap = { ...boxStyle(node, ctx), ...layoutStyle(node, ctx), ...slot };
      const group: GroupNode = {
        kind: "group",
        ...base(node, frame, style, ctx),
        children: (node.children ?? [])
          .map((child) => convertNode(child, node, ctx, child.relativeTransform))
          .filter((child): child is SceneNode => child !== null),
      };
      return group;
    }

    case "RECTANGLE": {
      const shown = paints(node.fills).filter(visible);
      const only = shown.length === 1 && shown[0].type === "IMAGE" ? shown[0] : null;
      const src = only?.imageHash ? ctx.images.get(only.imageHash) : null;
      if (only && src) {
        // A picture in a box is a picture: the image kind, with the box's own
        // corners and shadow on it.
        const style: StyleMap = {
          ...boxStyle(node, ctx, { fills: false }),
          "object-fit": only.scaleMode === "FIT" ? "contain" : "cover",
          ...slot,
        };
        return { kind: "image", ...base(node, frame, style, ctx), src };
      }
      return { kind: "rect", ...base(node, frame, { ...boxStyle(node, ctx), ...slot }, ctx) };
    }

    case "ELLIPSE": {
      const style: StyleMap = { ...boxStyle(node, ctx), ...slot };
      const ellipse: EllipseNode = { kind: "ellipse", ...base(node, frame, style, ctx) };
      const arc = node.arcData;
      if (arc) {
        const sweep = round(deg(arc.endingAngle - arc.startingAngle), 2);
        const full = Math.abs(Math.abs(sweep) - 360) < 0.01 && arc.innerRadius === 0;
        if (!full) {
          // Figma's zero is three o'clock; the canvas's is twelve.
          ellipse.start = round(((deg(arc.startingAngle) + 90) % 360 + 360) % 360, 2);
          ellipse.sweep = sweep;
          if (arc.innerRadius > 0) ellipse.inner = round(arc.innerRadius, 3);
        }
      }
      return ellipse;
    }

    case "POLYGON":
      return {
        kind: "polygon",
        ...base(node, frame, { ...boxStyle(node, ctx), ...slot }, ctx),
        sides: Math.max(3, Math.round(node.pointCount ?? 3)),
      };

    case "STAR":
    case "VECTOR":
    case "LINE":
    case "BOOLEAN_OPERATION": {
      const d = pathOf(node);
      if (!d) return placeholder(node, frame, ctx, slot, "A vector with no geometry the canvas could read.");
      const style: StyleMap = {
        ...pathPaintDecls(paints(node.fills), node.strokes, num(node.strokeWeight), node.dashPattern, strOf(node.strokeCap), strOf(node.strokeJoin)),
        ...effectDecls(node.effects),
        ...compositeDecls(node),
        ...slot,
      };
      return { kind: "path", ...base(node, frame, style, ctx), d };
    }

    case "TEXT": {
      const text = convertText(node);
      const style: StyleMap = { ...text.style, ...effectDecls(node.effects), ...compositeDecls(node), ...slot };
      return { kind: "text", ...base(node, frame, style, ctx), label: text.label };
    }

    // FigJam.
    case "SHAPE_WITH_TEXT": {
      const style: StyleMap = { ...boxStyle(node, ctx), ...CENTRED, ...slot };
      const label = textToLabel(node.text?.characters ?? "");
      const shape = node.shapeType ?? "SQUARE";
      if (shape === "ELLIPSE") return { kind: "ellipse", ...base(node, frame, style, ctx), label };
      if (shape === "DIAMOND") return { kind: "polygon", ...base(node, frame, style, ctx), label, sides: 4 };
      if (shape === "TRIANGLE_UP") return { kind: "polygon", ...base(node, frame, style, ctx), label, sides: 3 };
      if (shape === "ROUNDED_RECTANGLE" && !style["border-radius"]) style["border-radius"] = "8px";
      return { kind: "rect", ...base(node, frame, style, ctx), label };
    }
    case "STICKY": {
      const style: StyleMap = { ...boxStyle(node, ctx), padding: "16px", "text-align": "left", ...slot };
      return { kind: "rect", ...base(node, frame, style, ctx), label: textToLabel(node.text?.characters ?? "") };
    }
    case "CONNECTOR":
      // Written after the shapes, once both ends have ids.
      return null;

    default:
      return placeholder(node, frame, ctx, slot, `A ${node.type.toLowerCase().replace(/_/g, " ")} has no place on the canvas yet.`);
  }
}

const CENTRED: Decls = {
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  "text-align": "center",
};

/** The visible placeholder for anything the canvas cannot hold. */
function placeholder(node: FigNode, frame: ReturnType<typeof frameOf>, ctx: Ctx, slot: Decls, why: string): SceneNode {
  note(ctx, node, "stubbed", why);
  const style: StyleMap = {
    border: "1px dashed #9a9a9a",
    color: "#6b6b6b",
    "font-size": "12px",
    ...CENTRED,
    ...slot,
  };
  return { kind: "rect", ...base(node, frame, style, ctx), label: textToLabel(node.name || node.type) };
}

/** Path data in the node's own space, from whichever geometry Figma offers. */
function pathOf(node: FigNode): string | null {
  const lists = [node.vectorPaths, node.fillGeometry, node.strokeGeometry];
  for (const list of lists) {
    const d = (list ?? []).map((p) => p.data.trim()).filter(Boolean).join(" ");
    if (d) return d;
  }
  return null;
}

const strOf = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

// ---------------------------------------------------------------------------

function connector(node: FigNode, ctx: Ctx, index: number): SceneEdge | null {
  const from = node.connectorStart && "endpointNodeId" in node.connectorStart ? ctx.ids.get(node.connectorStart.endpointNodeId) : undefined;
  const to = node.connectorEnd && "endpointNodeId" in node.connectorEnd ? ctx.ids.get(node.connectorEnd.endpointNodeId) : undefined;
  if (!from || !to) {
    note(ctx, node, "connector_dropped", "A connector with an end on nothing in the selection was left out.");
    return null;
  }
  const style: StyleMap = {};
  const stroke = (node.strokes ?? []).find((s) => visible(s) && s.type === "SOLID" && s.color);
  if (stroke?.color) style.stroke = cssColorOf(stroke);
  const weight = num(node.strokeWeight);
  if (weight && weight !== 1) style["stroke-width"] = String(round(weight));
  if (node.dashPattern?.length) style["stroke-dasharray"] = node.dashPattern.map((n) => round(n)).join(" ");
  return {
    id: `e${index + 1}`,
    from,
    to,
    label: node.text?.characters ?? "",
    style,
    attrs: { "data-figma-id": node.id },
  };
}

function cssColorOf(paint: { color?: { r: number; g: number; b: number }; opacity?: number }): string {
  // Local to keep `paint.ts` the only importer of the colour maths.
  const { r, g, b } = paint.color!;
  const hex = (n: number) => Math.round(n * 255).toString(16).padStart(2, "0");
  const a = paint.opacity ?? 1;
  return a >= 0.999 ? `#${hex(r)}${hex(g)}${hex(b)}` : `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${round(a, 3)})`;
}

/** Every image hash the selection paints with, so the bytes can be fetched once. */
export function imageHashes(nodes: FigNode[]): string[] {
  const out = new Set<string>();
  const walk = (node: FigNode) => {
    for (const paint of paints(node.fills)) {
      if (paint.type === "IMAGE" && paint.imageHash && visible(paint)) out.add(paint.imageHash);
    }
    node.children?.forEach(walk);
  };
  nodes.forEach(walk);
  return [...out];
}

/**
 * The selection as a scene. Top-level nodes are placed by their absolute
 * transforms and then shifted so the selection's own corner is the origin —
 * the canvas centres a paste on the viewport, so absolute page coordinates
 * would only make the numbers large.
 */
export async function convertSelection(selection: FigNode[], images: ImageSource): Promise<ConvertResult> {
  const ctx: Ctx = { report: [], images: new Map(), ids: new Map() };
  await Promise.all(
    imageHashes(selection).map(async (hash) => {
      let src: string | null = null;
      try {
        src = await images(hash);
      } catch {
        src = null;
      }
      ctx.images.set(hash, src);
    }),
  );

  const nodes: SceneNode[] = [];
  const connectors: FigNode[] = [];
  for (const node of selection) {
    if (node.type === "CONNECTOR") {
      connectors.push(node);
      continue;
    }
    const converted = convertNode(node, undefined, ctx, node.absoluteTransform ?? node.relativeTransform);
    if (converted) nodes.push(converted);
  }

  // Figma nests connectors beside the shapes they join, so any that came in
  // with a selected frame count too.
  const inside: FigNode[] = [];
  const dig = (node: FigNode) => {
    node.children?.forEach((child) => {
      if (child.type === "CONNECTOR") inside.push(child);
      dig(child);
    });
  };
  selection.forEach(dig);

  const edges = [...connectors, ...inside]
    .map((node, i) => connector(node, ctx, i))
    .filter((edge): edge is SceneEdge => edge !== null);

  // Shift to the selection's own corner.
  if (nodes.length) {
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    for (const node of nodes) {
      node.x = round(node.x - minX);
      node.y = round(node.y - minY);
    }
  }
  const w = Math.max(1, ...nodes.map((n) => n.x + n.w));
  const h = Math.max(1, ...nodes.map((n) => n.y + n.h));

  let count = edges.length;
  const tally = (list: SceneNode[]) => {
    for (const node of list) {
      count += 1;
      if (node.kind === "group") tally(node.children);
    }
  };
  tally(nodes);

  return {
    scene: { w: round(w), h: round(h), style: {}, nodes, edges, attrs: {} },
    report: ctx.report,
    count,
  };
}
