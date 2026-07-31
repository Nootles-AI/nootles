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

import {
  memo,
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type SyntheticEvent,
} from "react";

import { layoutOf } from "../scene/autoLayout";
import {
  hasText,
  isGroup,
  type GroupLayout,
  type NodeId,
  type SceneNode,
  type StyleMap,
} from "../scene/types";
import { shapeOf, type Shape } from "./svgShape";
import "./shape.css";

/**
 * How an enclosing group places this node. Absent means absolute positioning at
 * the node's own `x`/`y`; the `stretch-*` forms leave one axis to CSS, because
 * that is the axis a stretching parent resolves for itself in
 * `scene/autoLayout`.
 *
 * A string rather than the parent's `GroupLayout`, so that a group re-rendering
 * does not hand every child a freshly allocated object and defeat the memo.
 */
export type Flow = "flow" | "stretch-x" | "stretch-y";

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
  /** Set by the enclosing group on its children; the surface omits it. */
  flow?: Flow;
}

const stop = (event: SyntheticEvent) => event.stopPropagation();

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
  flow,
}: ShapeViewProps) {
  const editing = editingId === node.id && hasText(node) && !node.locked;
  const label = useRef<HTMLSpanElement>(null);

  // React renders the editable element with no children and never touches its
  // content again: the text goes in from here and the browser owns it from
  // there until the edit commits. Reconciling React's idea of the label against
  // the nodes the browser made while typing is what duplicated the text and
  // detached a node out from under `removeChild`.
  useEffect(() => {
    const el = label.current;
    if (!editing || !el) return;
    el.textContent = node.label;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    // Natively, not through React. ProseMirror listens on its own element,
    // which sits between this one and the React root — so a synthetic
    // stopPropagation runs too late and the editor has already acted. ⌘A was
    // reaching it as "select the whole document", and the Backspace after it
    // deleted the diagram.
    const swallow = (event: Event) => event.stopPropagation();
    el.addEventListener("keydown", swallow);
    return () => el.removeEventListener("keydown", swallow);
  }, [editing, node.label]);

  // A hidden node inside an auto-layout group keeps its slot — `resolveLayout`
  // counts it — so there it is painted invisible instead of dropped, and its
  // siblings do not reflow out from under the hit-tester.
  if (node.hidden && !flow) return null;

  const shape = shapeOf(node);
  const style = boxStyle(node, flow, shape);
  const className = `ab-node ab-node-${node.kind}${editing ? " is-editing" : ""}`;

  if (node.kind === "path") {
    return (
      <svg
        data-id={node.id}
        className={className}
        // `overflow: visible` because a stroke straddles the geometry it
        // follows, and the box is tight to that geometry — clipped, every
        // curve loses its outer half and a mitred corner far more than that.
        // A zero-length axis is a straight line, and a zero-sized view box is
        // not rendered at all, so it takes a 1 to exist.
        style={{ ...style, overflow: "visible" }}
        viewBox={`0 0 ${node.w || 1} ${node.h || 1}`}
        preserveAspectRatio="none"
      >
        {/* `d` is local to the box and the `resize` op stretches it with the
            box, so the view box is always exactly the box. A live resize writes
            only the CSS size, leaving the two of them stale together — which is
            the same stretch, so the preview and what lands are one geometry.
            The stroke stays the weight it was authored at. */}
        <path d={node.d} vectorEffect="non-scaling-stroke" />
      </svg>
    );
  }

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
        alt={node.label}
        draggable={false}
      />
    );
  }

  const layout = isGroup(node) ? layoutOf(node) : null;
  const childFlow = layout ? flowFor(layout) : undefined;

  const commit = () => onEditEnd?.(node.id, label.current?.textContent ?? "");

  return (
    <div
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
        <span
          ref={label}
          className="ab-edit"
          contentEditable
          // While a label is open the canvas keymap already stands down (it
          // tests `isContentEditable`); this is for the ProseMirror editor
          // around it, whose handlers are ancestors of ours.
          onKeyDown={keyDown}
          onKeyUp={stop}
          onBeforeInput={stop}
          onPointerDown={stop}
          onDoubleClick={stop}
          onBlur={commit}
        />
      ) : hasText(node) ? (
        node.label
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
            />
          ))
        : null}
    </div>
  );
});

function keyDown(event: KeyboardEvent<HTMLSpanElement>) {
  event.stopPropagation();
  if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
    event.preventDefault();
    // Blur commits, so both endings go through one path.
    event.currentTarget.blur();
  }
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
 */
function boxStyle(
  node: SceneNode,
  flow: Flow | undefined,
  shape: Shape | null,
): CSSProperties {
  return {
    ...toCss(node.style, shape ? shape.drop : undefined),
    ...(shape?.clip ? { clipPath: shape.clip } : null),
    position: flow ? "relative" : "absolute",
    transform: flow
      ? `rotate(${node.rot}deg)`
      : `translate3d(${node.x}px, ${node.y}px, 0) rotate(${node.rot}deg)`,
    width: flow === "stretch-x" ? "auto" : `${node.w}px`,
    height: flow === "stretch-y" ? "auto" : `${node.h}px`,
    ...(flow ? { flex: "none" } : null),
    ...(node.hidden ? { visibility: "hidden" as const } : null),
    ...(node.locked ? { pointerEvents: "none" as const } : null),
  };
}

/**
 * An auto-layout group sets real `display: flex`/`grid` and lets the browser
 * place its children; a plain group positions them absolutely. That split is the
 * whole trick — one layout engine for the paint (CSS) and a model of the same
 * rules in `scene/autoLayout` for hit-testing, kept in step by both reading the
 * one `style`.
 */
function flowFor(layout: GroupLayout): Flow | undefined {
  if (layout.mode === "none") return undefined;
  if (layout.alignItems !== "stretch") return "flow";
  return layout.mode === "flex" && layout.flexDirection.startsWith("column")
    ? "stretch-x"
    : "stretch-y";
}

const CAMEL = new Map<string, string>();

/** `border-radius` → `borderRadius`; `--brand` and `-webkit-*` are handled too. */
function cssKey(prop: string): string {
  let key = CAMEL.get(prop);
  if (key === undefined) {
    key = prop.startsWith("--")
      ? prop
      : prop.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
    CAMEL.set(prop, key);
  }
  return key;
}

export function toCss(
  style: StyleMap,
  drop?: (prop: string) => boolean,
): CSSProperties {
  const out: Record<string, string> = {};
  for (const prop in style) {
    if (!drop?.(prop)) out[cssKey(prop)] = style[prop];
  }
  return out as CSSProperties;
}
