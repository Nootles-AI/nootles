"use client";

/**
 * One `SceneNode`, one DOM element.
 *
 * The grammar *is* CSS, so this is a transcription rather than a translation:
 * geometry becomes a `transform` and a width/height, and the node's `style` map
 * becomes the element's inline style, declaration for declaration. There is no
 * intermediate style model to disagree with the parser, and an unknown property
 * reaches the browser exactly as it was authored.
 *
 * It takes the node, never the scene, and is memo'd on it. `scene/ops` keeps the
 * identity of everything it did not touch, so dragging one shape re-renders one
 * shape.
 */

import { memo, useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties, type SyntheticEvent } from "react";

import { flowFor, isAutoSize, LABEL_OWNED, labelInsetOf, toCss, type Flow } from "../scene/boxModel";
import { isPinned, layoutOf } from "../scene/autoLayout";
import { clipperReady, derivedPath, loadClipper, operandsPath, subscribeClipper } from "../scene/boolean";
import { labelText } from "../scene/label";
import { LabelContent, LabelEdit } from "./ShapeLabel";
import {
  hasText,
  isBoolean,
  isGroup,
  type GroupNode,
  type NodeId,
  type SceneNode,
} from "../scene/types";
import { paintsBox, pathPaint, shadowFilter, shapeOf, type Shape } from "./svgShape";
import "./shape.css";

/**
 * How an enclosing group places this node. Moved to `scene/boxModel.ts`
 * (COMPILE, build-plan §1.1) so `app/lib/ai/html/toHtml.ts` can share the same
 * type without importing a `"use client"` React module; re-exported here for
 * `CanvasSurface.tsx` and `EdgeLayer.tsx`, which already read it off this
 * file.
 */
export type { Flow };

export interface ShapeViewProps {
  node: SceneNode;
  /** The one node whose label is open for editing; null while none is. */
  editingId?: NodeId | null;
  /**
   * Double-click on a text-bearing shape. Advisory — the same double-click can
   * also mean "enter this group", so the surface decides whether to honour it
   * by setting `editingId`.
   */
  onEditStart?: (id: NodeId) => void;
  /** Blur or Escape. The caller dispatches `setLabel` and clears `editingId`. */
  onEditEnd?: (id: NodeId, label: string) => void;
  /** The label mid-edit, debounced — streamed so collaborators watch it typed. */
  onEditLive?: (id: NodeId, label: string) => void;
  /**
   * Open this label for editing now — the solo chip's "Edit text". Not
   * advisory: the surface selects the node and sets `editingId` outright.
   * Absent on a read-only surface, where a solo chip just navigates.
   */
  onEditOpen?: (id: NodeId) => void;
  /**
   * The box the browser gave a text sized by its own words (`width:
   * max-content`, `height: auto`), reported so the model can hold it.
   */
  onMeasure?: (id: NodeId, w: number, h: number) => void;
  /** Set by the enclosing group on its children; the surface omits it. */
  flow?: Flow;
}

/**
 * A press inside the shape but beside its label. The canvas focuses itself on
 * every press it sees, which would blur the label and end the edit, so the
 * press is swallowed and the caret stays where it is.
 */
const hold = (event: SyntheticEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

export const ShapeView = memo(function ShapeView({
  node,
  editingId = null,
  onEditStart,
  onEditEnd,
  onEditLive,
  onEditOpen,
  onMeasure,
  flow: slot,
}: ShapeViewProps) {
  // A child pinned inside an auto-layout group is placed by its own `x`/`y`,
  // the way `scene/autoLayout` places it: out of the flow, in the group's box.
  const flow = slot && isPinned(node) ? undefined : slot;
  const editing = editingId === node.id && hasText(node) && !node.locked;
  const box = useRef<HTMLDivElement>(null);
  const autoW = isAutoSize(node.style.width);
  const autoH = isAutoSize(node.style.height);
  // The one DOM read in the canvas, and it is the browser's own text layout,
  // which nothing in `scene/` can do without a font. Reported, not written:
  // the surface decides whether the number is news.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !onMeasure || !(autoW || autoH) || !hasText(node)) return;
    const report = () => onMeasure(node.id, el.offsetWidth, el.offsetHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [autoW, autoH, node, onMeasure]);

  // A hidden node inside an auto-layout group keeps its slot — `resolveLayout`
  // counts it — so there it is painted invisible instead of dropped, and its
  // siblings do not reflow out from under the hit-tester.
  if (node.hidden && !flow) return null;

  const shape = shapeOf(node);
  // A shadow follows the drawing, not the box, wherever the box is not the
  // drawing: the SVG kinds, and a group that paints nothing of its own.
  const cast =
    node.kind === "path" || shape || (isGroup(node) && !paintsBox(node.style))
      ? shadowFilter(node.style)
      : null;
  const style = { ...boxStyle(node, flow, shape), ...cast };
  const className = `nt-node nt-node-${node.kind}${editing ? " is-editing" : ""}`;

  if (node.kind === "path") return <PathView node={node} d={node.d} flow={flow} cast={cast} className={className} />;
  if (isBoolean(node)) return <BooleanView node={node} flow={flow} cast={cast} className={className} />;

  if (node.kind === "image") {
    // `src` is any URL or data URI, and the grammar's `object-fit` needs a real
    // replaced element, so this cannot be `next/image`.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        data-id={node.id}
        className={className}
        style={style}
        src={node.src}
        alt={labelText(node.label)}
        draggable={false}
      />
    );
  }

  const layout = isGroup(node) ? layoutOf(node) : null;
  const childFlow = layout ? flowFor(layout) : undefined;

  return (
    <div
      ref={box}
      data-id={node.id}
      className={className}
      style={style}
      onDoubleClick={
        hasText(node) && !node.locked ? () => onEditStart?.(node.id) : undefined
      }
      onPointerDown={editing ? hold : undefined}
    >
      {shape?.child}
      {editing ? (
        <LabelEdit
          label={node.label}
          onEnd={(label) => onEditEnd?.(node.id, label)}
          onLive={onEditLive && ((label) => onEditLive(node.id, label))}
        />
      ) : hasText(node) ? (
        <LabelContent
          label={node.label}
          clamp={node.style["-webkit-line-clamp"]}
          onEdit={
            !node.locked && onEditOpen ? () => onEditOpen(node.id) : undefined
          }
        />
      ) : null}
      {isGroup(node)
        ? node.children.map((child) => (
            <ShapeView
              key={child.id}
              node={child}
              flow={childFlow}
              editingId={editingId}
              onEditStart={onEditStart}
              onEditEnd={onEditEnd}
              onEditLive={onEditLive}
              onEditOpen={onEditOpen}
              onMeasure={onMeasure}
            />
          ))
        : null}
    </div>
  );
});

/** A path: the one element that IS its geometry. */
function PathView({
  node,
  d,
  flow,
  cast,
  className,
  fillRule,
}: {
  node: SceneNode;
  d: string;
  flow: Flow | undefined;
  cast: CSSProperties | null;
  className: string;
  /** A boolean's rings never overlap, so even-odd paints them alike and a
   *  hole is a hole; a pen path keeps SVG's default and its own `fill-rule`. */
  fillRule?: "evenodd";
}) {
  const { paint, drop } = pathPaint(node.style, d);
  return (
    <svg
      data-id={node.id}
      className={className}
      // `overflow: visible` because a stroke straddles the geometry it
      // follows, and the box is tight to that geometry — clipped, every
      // curve loses its outer half and a mitred corner far more than that.
      // A zero-length axis is a straight line, and a zero-sized view box is
      // not rendered at all, so it takes a 1 to exist.
      style={{ ...boxStyle(node, flow, null, drop), ...paint, ...cast, overflow: "visible" }}
      viewBox={`0 0 ${node.w || 1} ${node.h || 1}`}
      preserveAspectRatio="none"
    >
      {/* `d` is local to the box and the `resize` op stretches it with the
          box, so the view box is always exactly the box. A live resize writes
          only the CSS size, leaving the two of them stale together — which is
          the same stretch, so the preview and what lands are one geometry.
          The stroke stays the weight it was authored at. */}
      <path d={d} fillRule={fillRule} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * A boolean group draws one derived path and none of its children. The
 * clipper is fetched on the first one seen; until it lands the operands'
 * outlines stand in, drawn together.
 */
function BooleanView(props: {
  node: GroupNode;
  flow: Flow | undefined;
  cast: CSSProperties | null;
  className: string;
}) {
  const ready = useSyncExternalStore(subscribeClipper, clipperReady, () => false);
  if (!ready) void loadClipper();
  const d = (ready ? derivedPath(props.node) : null) ?? operandsPath(props.node);
  return <PathView {...props} d={d} fillRule="evenodd" />;
}

/**
 * The box, as CSS.
 *
 * The node's own declarations go on first: `x`/`y`/`w`/`h`/`rot` are attributes,
 * and a `style` that fought them would paint the shape somewhere the hit-tester
 * and the gesture layer are not. Placement is a `transform` — the property a
 * gesture writes per frame, and the one the compositor can animate.
 *
 * An SVG-drawn kind gives up its box paint: the fill and stroke are the shape's,
 * so leaving `background` and `border` on the element would paint a rectangle
 * around the triangle. The one exception is a fill only CSS can draw, which
 * stays on the box and is clipped to the shape instead.
 *
 * The translation is 2D on purpose. `translate3d` asks for a composited layer,
 * and a shape that owns one is rastered once and magnified from then on — it
 * goes soft as soon as the viewport zooms past the scale it was drawn at, and
 * only sharpens again when something happens to repaint it. A gesture still
 * writes the 3D form while it is dragging the element (`engine/gestures`), so
 * the promotion lasts exactly as long as the movement does — the same bargain
 * `engine/useViewport` makes for the scene layer.
 */
function boxStyle(
  node: SceneNode,
  flow: Flow | undefined,
  shape: Shape | null,
  /** For the kinds that are their own geometry and have no `Shape` to ask. */
  drop?: (prop: string) => boolean,
): CSSProperties {
  const dropped = drop ?? (shape ? shape.drop : undefined);
  const inset = labelInsetOf(node);
  return {
    ...toCss(node.style, (prop) => LABEL_OWNED.has(prop) || !!dropped?.(prop)),
    ...(shape?.clip ? { clipPath: shape.clip } : null),
    ...(inset !== null ? { padding: inset } : null),
    position: flow ? "relative" : "absolute",
    transform: flow
      ? `rotate(${node.rot}deg)`
      : `translate(${node.x}px, ${node.y}px) rotate(${node.rot}deg)`,
    // A sizing keyword in the node's own style — `width: max-content` for a
    // text that is as wide as its words — is the one thing allowed to beat the
    // attribute: the attribute then holds what the browser measured.
    ...(isAutoSize(node.style.width)
      ? { width: node.style.width }
      : { width: flow === "stretch-x" ? "auto" : `${node.w}px` }),
    ...(isAutoSize(node.style.height)
      ? { height: node.style.height }
      : { height: flow === "stretch-y" ? "auto" : `${node.h}px` }),
    ...(flow ? { flex: "none" } : null),
    ...(node.hidden ? { visibility: "hidden" as const } : null),
    ...(node.locked ? { pointerEvents: "none" as const } : null),
  };
}

/**
 * `LABEL_OWNED`, `isAutoSize`, `labelInsetOf`, `flowFor`, `cssKey` and `toCss`
 * all moved to `scene/boxModel.ts` (COMPILE, build-plan §1.1) so the compiler
 * (`app/lib/ai/html/toHtml.ts`) can share this exact reading of a node's box
 * without importing a `"use client"` React module. Re-exported below for
 * `CanvasSurface.tsx` and `ScenePreview.tsx`, which already read
 * `isAutoSize`/`toCss` off this file.
 */
export { isAutoSize, toCss };
