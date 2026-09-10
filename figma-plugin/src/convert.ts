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
import { scalePath, translatePath } from "@/app/components/editor/canvas/scene/path";
import type {
  BooleanOp,
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
  firstStroke,
  isGradient,
  pathFillDecls,
  pathStrokeDecls,
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
 *
 * The canvas has no mirror, but every mirror is a horizontal flip followed by
 * a turn, so a flipped node is read as that: `mirrored` tells the caller to
 * flip the geometry itself — path data, arc angles, corners — and `rot` is
 * the turn that follows. The box and its centre are the same either way.
 */
function frameOf(node: FigNode, transform: Transform | undefined) {
  const w = node.width;
  const h = node.height;
  if (!transform) {
    return { x: node.x, y: node.y, w, h, rot: 0, mirrored: false };
  }
  const [[a, b, tx], [c, d, ty]] = transform;
  const cx = tx + a * (w / 2) + b * (h / 2);
  const cy = ty + c * (w / 2) + d * (h / 2);
  const mirrored = a * d - b * c < 0;
  const rot = round((deg(mirrored ? Math.atan2(-c, -a) : Math.atan2(c, a)) + 360) % 360, 2) % 360;
  return { x: cx - w / 2, y: cy - h / 2, w, h, rot, mirrored };
}

/** The geometry a horizontal flip leaves behind, for each thing that has some. */
const flipPath = (d: string, w: number) => translatePath(scalePath(d, -1, 1), w, 0);
/** An arc from `start` sweeping `sweep` mirrors onto one from `-(start + sweep)`, sweeping the same way. */
const flipArc = (start: number, sweep: number) => round((((-(start + sweep)) % 360) + 360) % 360, 2);
const flipCorners = (node: FigNode): FigNode => ({
  ...node,
  topLeftRadius: node.topRightRadius,
  topRightRadius: node.topLeftRadius,
  bottomLeftRadius: node.bottomRightRadius,
  bottomRightRadius: node.bottomLeftRadius,
});

/** `outer · inner`: `inner` applies first. */
function multiply(o: Transform, i: Transform): Transform {
  return [
    [o[0][0] * i[0][0] + o[0][1] * i[1][0], o[0][0] * i[0][1] + o[0][1] * i[1][1], o[0][0] * i[0][2] + o[0][1] * i[1][2] + o[0][2]],
    [o[1][0] * i[0][0] + o[1][1] * i[1][0], o[1][0] * i[0][1] + o[1][1] * i[1][1], o[1][0] * i[0][2] + o[1][1] * i[1][2] + o[1][2]],
  ];
}

/** The general inverse: Figma's axes are unit vectors, so the determinant never vanishes. */
function invert(m: Transform): Transform {
  const [[a, b, tx], [c, d, ty]] = m;
  const det = a * d - b * c;
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [
    [ia, ib, -(ia * tx + ib * ty)],
    [ic, id, -(ic * tx + id * ty)],
  ];
}

/**
 * The transform the canvas will actually hold for a node placed by
 * `transform`: the same centre and turn, and nothing else. The canvas has no
 * skew, and it holds a mirror only as flipped geometry, so a child has to be
 * placed against this rather than against whatever Figma had, or it lands
 * where the skew or the mirror would have put it. A child of a mirrored
 * group is itself mirrored on the page, and reads its own flip off its own
 * transform.
 */
function rigidOf(node: FigNode, transform: Transform): Transform {
  const { x, y, w, h, rot } = frameOf(node, transform);
  const r = (rot * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const hw = w / 2;
  const hh = h / 2;
  return [
    [cos, -sin, x + hw - (cos * hw - sin * hh)],
    [sin, cos, y + hh - (sin * hw + cos * hh)],
  ];
}

/** A shear: the one thing a transform can do that neither a box nor flipped geometry can hold. */
function skewed(m: Transform): boolean {
  const [[a, b], [c, d]] = m;
  const off = Math.max(Math.abs(a * a + c * c - 1), Math.abs(b * b + d * d - 1), Math.abs(a * b + c * d));
  return off > 1e-3;
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

/**
 * Where a node sits in the space the canvas places it in: its parent's local
 * space, or the page for a top-level node.
 *
 * Figma's `relativeTransform` is not that when the parent is a group or a
 * boolean operation: those are transparent, and their children are expressed
 * in the nearest frame's space, so a child read relatively lands offset by
 * its group and turns about the wrong point. The absolutes tell the truth for
 * every parent, so the parent's is divided out of the child's; the relative
 * is only the fallback for a node handed in without one.
 *
 * A node sheared on the page is reported, since it is drawn square. Judged
 * on the node's own absolute: a group's transform is derived from its
 * children, so a child of a skewed group can itself be square. A mirror is
 * not a loss — {@link frameOf} folds it into the geometry — except for words
 * and pictures, which say so where they are converted.
 */
function placement(node: FigNode, parent: FigNode | undefined, ctx: Ctx): Transform | undefined {
  const abs = node.absoluteTransform;
  if (!abs) return node.relativeTransform;
  if (skewed(abs)) note(ctx, node, "skewed", "A skewed layer was drawn unskewed; the canvas has no skew.");
  if (!parent) return abs;
  if (!parent.absoluteTransform) return node.relativeTransform;
  return multiply(invert(rigidOf(parent, parent.absoluteTransform)), abs);
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

/** The bytes for an image layer, fetched up front; a miss is a line in the report. */
const imageFor = (node: FigNode, ctx: Ctx) => (layer: ImageLayer) => {
  const src = ctx.images.get(layer.hash) ?? null;
  if (!src) note(ctx, node, "image_missing", "An image fill could not be read and was left out.");
  return src;
};

/** A stroke is one colour in CSS; a gradient stroke wears its first stop and says so. */
function strokeNote(node: FigNode, ctx: Ctx) {
  if (isGradient(firstStroke(node.strokes))) note(ctx, node, "gradient_stroke", "A gradient stroke was drawn in its first colour.");
}

/** The paint every box shares: fills, stroke, corners, effects, compositing. */
function boxStyle(node: FigNode, ctx: Ctx, opts: { fills?: boolean; mirrored?: boolean } = {}): Decls {
  const style: Decls = {};
  if (opts.fills !== false) {
    const background = backgroundOf(paints(node.fills), node.width, node.height, imageFor(node, ctx));
    if (background) style.background = background;
  }
  strokeNote(node, ctx);
  Object.assign(
    style,
    strokeDecls(node.strokes, num(node.strokeWeight), node.strokeAlign, node.dashPattern),
    radiusDecls(opts.mirrored ? flipCorners(node) : node),
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
    // Figma's gap is one number along the main axis, and under space-between
    // it is not consulted at all — a stale one would push the last child off
    // the end. The layout engine reads one number too; the spacing between
    // wrapped lines is the longhand, for the day wrapping is modelled.
    const gap = node.primaryAxisAlignItems === "SPACE_BETWEEN" ? 0 : (node.itemSpacing ?? 0);
    if (gap > 0) style.gap = `${round(gap)}px`;
    const cross = node.counterAxisSpacing ?? null;
    if (node.layoutWrap === "WRAP" && cross !== null && cross !== gap) {
      style[mode === "VERTICAL" ? "column-gap" : "row-gap"] = `${round(cross)}px`;
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

const BOOLEAN_OP: Record<string, BooleanOp> = { UNION: "union", SUBTRACT: "subtract", INTERSECT: "intersect", EXCLUDE: "exclude" };

function convertNode(node: FigNode, parent: FigNode | undefined, ctx: Ctx): SceneNode | null {
  const frame = frameOf(node, placement(node, parent, ctx));
  const slot = childLayoutStyle(node, parent);

  // A boolean keeps its operands, so the operation stays editable on the
  // canvas; the result is painted the way a vector is. One with no operands
  // left to read is drawn from the geometry Figma computed, below.
  const op = node.type === "BOOLEAN_OPERATION" ? BOOLEAN_OP[node.booleanOperation ?? ""] : undefined;
  if (op && node.children?.length) {
    const kids = convertChildren(node, node.children, ctx);
    const style: StyleMap = {
      ...pathFillDecls(paints(node.fills), node.width, node.height, imageFor(node, ctx)),
      ...pathStrokeDecls(node.strokes, num(node.strokeWeight), node.dashPattern, strOf(node.strokeCap), strOf(node.strokeJoin)),
      ...effectDecls(node.effects),
      ...compositeDecls(node),
      ...slot,
      ...kids.clip,
    };
    return { kind: "group", ...base(node, frame, style, ctx), op, children: kids.children };
  }

  switch (node.type) {
    case "FRAME":
    case "GROUP":
    case "SECTION":
    case "COMPONENT":
    case "COMPONENT_SET":
    case "INSTANCE": {
      const kids = convertChildren(node, node.children ?? [], ctx);
      const style: StyleMap = { ...boxStyle(node, ctx, { mirrored: frame.mirrored }), ...layoutStyle(node, ctx), ...slot, ...kids.clip };
      const group: GroupNode = {
        kind: "group",
        ...base(node, frame, style, ctx),
        children: kids.children,
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
          ...boxStyle(node, ctx, { fills: false, mirrored: frame.mirrored }),
          "object-fit": only.scaleMode === "FIT" ? "contain" : "cover",
          ...slot,
        };
        if (frame.mirrored) note(ctx, node, "flipped", "A flipped picture was drawn unflipped; the canvas has no mirror.");
        return { kind: "image", ...base(node, frame, style, ctx), src };
      }
      return { kind: "rect", ...base(node, frame, { ...boxStyle(node, ctx, { mirrored: frame.mirrored }), ...slot }, ctx) };
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
          const start = round(((deg(arc.startingAngle) + 90) % 360 + 360) % 360, 2);
          ellipse.start = frame.mirrored ? flipArc(start, sweep) : start;
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
      strokeNote(node, ctx);
      const style: StyleMap = {
        ...pathFillDecls(paints(node.fills), node.width, node.height, imageFor(node, ctx)),
        ...pathStrokeDecls(node.strokes, num(node.strokeWeight), node.dashPattern, strOf(node.strokeCap), strOf(node.strokeJoin)),
        ...effectDecls(node.effects),
        ...compositeDecls(node),
        ...slot,
      };
      return { kind: "path", ...base(node, frame, style, ctx), d: frame.mirrored ? flipPath(d, node.width) : d };
    }

    case "TEXT": {
      const text = convertText(node);
      const style: StyleMap = { ...text.style, ...effectDecls(node.effects), ...compositeDecls(node), ...slot };
      if (frame.mirrored) note(ctx, node, "flipped", "Flipped words were drawn readable; the canvas has no mirror.");
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

/**
 * Path data in the node's own space, from whichever geometry Figma offers.
 *
 * A line has no `vectorPaths`; what it has is `strokeGeometry`, the outline
 * of its stroke, which stroked again would be twice the weight and half a
 * weight off. A line is the segment across its own box.
 */
function pathOf(node: FigNode): string | null {
  if (node.type === "LINE" && !node.vectorPaths?.length) return `M 0 0 L ${round(node.width)} 0`;
  const lists = [node.vectorPaths, node.fillGeometry, node.strokeGeometry];
  for (const list of lists) {
    const d = (list ?? []).map((p) => p.data.trim()).filter(Boolean).join(" ");
    if (d) return roundPath(d);
  }
  return null;
}

/**
 * Figma writes path coordinates at double precision — `10.265440940856934`
 * — and an icon is a hundred of them. Two decimals is what every other
 * number in the document gets, finer than a screen shows, and a fifth of
 * the bytes.
 */
const roundPath = (d: string): string =>
  d.replace(/-?\d*\.\d+(?:e[+-]?\d+)?/gi, (n) => String(round(Number(n))));

const strOf = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

// ---------------------------------------------------------------------------
// Masks

type Frame = ReturnType<typeof frameOf>;
type Kids = { children: SceneNode[]; clip?: Decls };

/**
 * A container's children, with its masks applied.
 *
 * Figma's mask is a layer that masks every sibling above it. The canvas's
 * spelling is the result rather than the mechanism: the masked siblings sit
 * in a group carrying the clip, and the masking layer is that declaration
 * rather than a node. A mask at the bottom of its container clips the
 * container itself; one higher up wraps what is above it in a group of its
 * own, which keeps the mask's id.
 */
function convertChildren(parent: FigNode, kids: FigNode[], ctx: Ctx): Kids {
  const out: SceneNode[] = [];
  for (let i = 0; i < kids.length; i++) {
    const kid = kids[i];
    if (!kid.isMask) {
      const converted = convertNode(kid, parent, ctx);
      if (converted) out.push(converted);
      continue;
    }
    const clip = clipOf(kid, parent, ctx);
    const rest = convertChildren(parent, kids.slice(i + 1), ctx);
    let masked = rest.children;
    if (rest.clip && masked.length) masked = [clipped(kids[i + 1], parent, masked, rest.clip)];
    if (!masked.length) return { children: out };
    if (!out.length) return { children: masked, clip };
    out.push(clipped(kid, parent, masked, clip));
    return { children: out };
  }
  return { children: out };
}

/** The group a mask becomes when it is not the bottom of its container. */
function clipped(mask: FigNode, parent: FigNode, children: SceneNode[], clip: Decls): GroupNode {
  const named = mask.name && !DEFAULT_NAME.test(mask.name.trim());
  return {
    kind: "group",
    id: idOf(mask),
    x: 0,
    y: 0,
    w: round(parent.width),
    h: round(parent.height),
    rot: 0,
    style: clip,
    label: "",
    ...(named ? { name: mask.name } : {}),
    locked: mask.locked === true,
    hidden: mask.visible === false,
    attrs: { "data-figma-id": mask.id },
    children,
  };
}

/**
 * The declaration a mask is. A plain box over the whole container is the
 * container clipping its contents; anything else is the mask's outline as a
 * clip path, in the container's space.
 */
function clipOf(mask: FigNode, parent: FigNode, ctx: Ctx): Decls {
  if (mask.type === "TEXT" || paints(mask.fills).some((p) => visible(p) && p.type === "IMAGE")) {
    note(ctx, mask, "mask_outline", "A picture or text mask was applied as its outline.");
  }
  const frame = frameOf(mask, placement(mask, parent, ctx));
  const covers =
    frame.x <= 0.5 && frame.y <= 0.5 && frame.x + frame.w >= parent.width - 0.5 && frame.y + frame.h >= parent.height - 0.5;
  if (covers && frame.rot === 0 && isPlainBox(mask)) return { overflow: "hidden" };
  const d = outlineIn(mask, frame, ctx);
  return d ? { "clip-path": `path("${d}")` } : { overflow: "hidden" };
}

/** A square-cornered rectangle, however Figma spelled it: a rect, a frame, a four-corner vector, or a group of one. */
function isPlainBox(node: FigNode): boolean {
  if (node.type === "RECTANGLE" || node.type === "FRAME") return Object.keys(radiusDecls(node)).length === 0;
  if (node.type === "GROUP" || node.type === "BOOLEAN_OPERATION") {
    const only = node.children?.length === 1 ? node.children[0] : null;
    return !!only && only.width >= node.width - 0.5 && only.height >= node.height - 0.5 && isPlainBox(only);
  }
  const d = pathOf(node);
  if (!d) return false;
  const box = /^M\s*0\s+0\s+L\s*([\d.]+)\s+0\s+L\s*\1\s+([\d.]+)\s+L\s*0\s+\2\s+(?:L\s*0\s+0\s+)?Z$/i.exec(d.trim());
  return !!box && Math.abs(Number(box[1]) - node.width) < 0.5 && Math.abs(Number(box[2]) - node.height) < 0.5;
}

/**
 * A mask's outline in its container's space: the union of what it draws,
 * each piece moved to where it sits. A turn is not carried — the clip is a
 * path in the container's own axes — so a turned mask is applied square and
 * said so.
 */
function outlineIn(node: FigNode, frame: Frame, ctx: Ctx): string {
  if (frame.rot !== 0) note(ctx, node, "mask_turned", "A turned mask was applied unturned.");
  const own = node.children?.length
    ? node.children
        .map((child) => outlineIn(child, frameOf(child, placement(child, node, ctx)), ctx))
        .filter(Boolean)
        .join(" ")
    : (pathOf(node) ?? `M 0 0 L ${round(frame.w)} 0 L ${round(frame.w)} ${round(frame.h)} L 0 ${round(frame.h)} Z`);
  return own ? translatePath(own, round(frame.x), round(frame.y)) : "";
}

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
 * The selection as a scene. Top-level nodes are placed on the page and then
 * shifted so the selection's own corner is the origin —
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
    const converted = convertNode(node, undefined, ctx);
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
