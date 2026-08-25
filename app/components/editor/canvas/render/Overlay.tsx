"use client";

/**
 * Everything drawn on top of the shapes: the selection frame and its handles,
 * the hover outline, the marquee, the snap guides — alignment lines and
 * equal-gap marks — and the gesture readout, which says where a move is putting
 * the box, how big a resize is making it, or what angle a rotation is at.
 *
 * Mount it as the last child of the viewport's scene layer, so it inherits the
 * pan/zoom transform for free — every coordinate here is scene px and a pan
 * costs nothing. What cannot ride that transform is anything meant to be a
 * fixed size on screen: handles, hairlines and the readout are drawn at
 * `1/zoom` scene px, and the zoom is the only viewport value this subscribes to.
 *
 * The frame is Figma's: a hairline rectangle, four round corner handles, and no
 * visible edge bars — an edge is resized by grabbing the outline itself, which
 * is a hit strip the whole length of the side.
 *
 * `update` is the gesture layer's imperative channel — it writes attributes
 * straight onto the SVG once per frame and React hears nothing until the
 * gesture commits. Both paths funnel through {@link draw}, so what a gesture
 * paints and what a render paints cannot drift.
 */

import {
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";

import {
  rotationCursor,
  type OverlayHandle,
  type ReadoutMode,
} from "../engine/gestures";
import type { SnapGuide } from "../engine/snapping";
import { useViewportZoom, type ViewportController } from "../engine/useViewport";
import {
  nodeBounds,
  normalizeAngle,
  type Handle,
  type RotatedRect,
} from "../scene/geometry";
import type { NodeId, Rect, SceneNodeKind } from "../scene/types";

import "./overlay.css";

export interface OverlayApi extends OverlayHandle {
  /** The rubber band, in scene px. `null` hides it. */
  marquee(rect: Rect | null): void;
}

export interface OverlayProps {
  viewport: ViewportController;
  /** The selection box in scene space, carrying its rotation. `null` when empty. */
  selection: RotatedRect | null;
  /**
   * The selected ids. With exactly one, that node's rendered corner radii are
   * read off the element and become draggable. The frame itself is never
   * measured: `selection` is already the laid-out geometry.
   */
  ids?: readonly NodeId[];
  /** Faint per-member outlines. Pass them only for a multi-selection. */
  members: readonly RotatedRect[];
  /** The node under the pointer, when it is not already selected. */
  hover: RotatedRect | null;
  onResizeStart(event: ReactPointerEvent, handle: Handle): void;
  onRotateStart(event: ReactPointerEvent): void;
  /** Omit to leave the radius handles off. */
  onRadiusStart?(event: ReactPointerEvent, corner: Handle): void;
  /**
   * Draw what is selected, and nothing to grab it by. A viewer may point at a
   * shape — so the outline and the hover ring stay — but every handle is a
   * verb they do not have, and a radius anchor on a shape nobody can round is
   * just an invitation that goes nowhere.
   */
  readOnly?: boolean;
  ref?: Ref<OverlayApi>;
}

/** Screen px — everything below is divided by the zoom on the way out. */
const GRIP = 7;
const RADIUS_GRIP = 6;
const TARGET = 15;
const EDGE = 9;
const ZONE = 18;
/** Where a zero radius handle sits, how big its target is, and when it shows. */
const RADIUS_INSET = 9;
const RADIUS_TARGET = 13;
/** Four extra dots inside a small box read as noise long before they overlap. */
const RADIUS_MIN_BOX = 72;
const TICK = 3;
/** An equal-gap mark's end bars, taller than a guide's tick so it reads as a
 *  measurement of the gap rather than as a line something sits on. */
const GAP_CAP = 5;
const CHIP_GAP = 9;

/** Where each handle sits in the box, as a fraction. */
const FRAC: Record<Handle, readonly [number, number]> = {
  nw: [0, 0],
  n: [0.5, 0],
  ne: [1, 0],
  e: [1, 0.5],
  se: [1, 1],
  s: [0.5, 1],
  sw: [0, 1],
  w: [0, 0.5],
};

const CORNERS = ["nw", "ne", "se", "sw"] as const satisfies readonly Handle[];
const EDGES = ["n", "e", "s", "w"] as const satisfies readonly Handle[];
const CURSORS = ["ew", "nwse", "ns", "nesw"];
const NO_GUIDES: readonly SnapGuide[] = [];
/**
 * Kinds whose corner radius means nothing, as class names. Each of them is
 * painted by an `<svg>` rather than by its box (see `render/svgShape`), so
 * there is no box corner on screen for a radius to round — and for a triangle
 * or a diamond three of the four box corners are not even on the shape.
 */
const NO_RADIUS = (
  ["path", "ellipse", "polygon"] as const satisfies readonly SceneNodeKind[]
).map((kind) => `nt-node-${kind}`);

/** The outward direction of a handle, clockwise from +x, in a y-down space. */
function outward(handle: Handle): number {
  const [fx, fy] = FRAC[handle];
  return normalizeAngle((Math.atan2(fy * 2 - 1, fx * 2 - 1) * 180) / Math.PI);
}

function resizeCursor(handle: Handle, rot: number): string {
  const step = Math.round(normalizeAngle(outward(handle) + rot) / 45) % 4;
  return `${CURSORS[step]}-resize`;
}

function box(el: Element, x: number, y: number, w: number, h: number) {
  el.setAttribute("x", String(x));
  el.setAttribute("y", String(y));
  el.setAttribute("width", String(Math.max(w, 0)));
  el.setAttribute("height", String(Math.max(h, 0)));
}

function dot(el: Element, cx: number, cy: number, r: number) {
  el.setAttribute("cx", String(cx));
  el.setAttribute("cy", String(cy));
  el.setAttribute("r", String(r));
}

/** A passive outline's geometry, as JSX attributes. */
function outlineOf(r: RotatedRect) {
  const spin = `rotate(${r.rot} ${r.x + r.w / 2} ${r.y + r.h / 2})`;
  return {
    x: r.x,
    y: r.y,
    width: r.w,
    height: r.h,
    transform: r.rot ? spin : undefined,
  };
}

/**
 * Lines with Figma's end ticks, as one path. A spacing mark is the same
 * geometry put to another use: it spans only the gap it measures, and its ends
 * are bars rather than ticks — so a run of equal gaps reads as a row of short
 * double-ended bars, not as one long line through everything.
 */
function guidePath(guides: readonly SnapGuide[], k: number): string {
  let d = "";
  for (const g of guides) {
    const t = (g.kind === "spacing" ? GAP_CAP : TICK) * k;
    if (g.axis === "x") {
      d += `M${g.at} ${g.from}V${g.to}`;
      d += `M${g.at - t} ${g.from}h${t * 2}M${g.at - t} ${g.to}h${t * 2}`;
    } else {
      d += `M${g.from} ${g.at}H${g.to}`;
      d += `M${g.from} ${g.at - t}v${t * 2}M${g.to} ${g.at - t}v${t * 2}`;
    }
  }
  return d;
}

function sameRect(a: RotatedRect | null, b: RotatedRect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.rot === b.rot;
}

/** The rendered corner radii, in scene px; `null` when the shape cannot have one. */
function radiiOf(el: HTMLElement): number[] | null {
  if (NO_RADIUS.some((name) => el.classList.contains(name))) return null;
  const css = getComputedStyle(el);
  // A clipped box is the same story by another route — the legacy `clip-path`
  // diamond rounds corners the clip has already cut away.
  if (css.clipPath !== "none") return null;
  return [
    css.borderTopLeftRadius,
    css.borderTopRightRadius,
    css.borderBottomRightRadius,
    css.borderBottomLeftRadius,
  ].map((value) => Number.parseFloat(value) || 0);
}

export function Overlay({
  viewport,
  selection,
  ids,
  members,
  hover,
  onResizeStart,
  onRotateStart,
  onRadiusStart,
  readOnly = false,
  ref,
}: OverlayProps) {
  const zoom = useViewportZoom(viewport);

  const root = useRef<SVGSVGElement>(null);
  const frame = useRef<SVGGElement>(null);
  const outline = useRef<SVGRectElement>(null);
  const grips = useRef<SVGGElement>(null);
  const edges = useRef<SVGGElement>(null);
  const corners = useRef<SVGGElement>(null);
  const zones = useRef<SVGGElement>(null);
  const radii = useRef<SVGGElement>(null);
  const radiusZones = useRef<SVGGElement>(null);
  const chip = useRef<SVGGElement>(null);
  const chipBox = useRef<SVGRectElement>(null);
  const chipText = useRef<SVGTextElement>(null);
  const guides = useRef<SVGPathElement>(null);
  const band = useRef<SVGRectElement>(null);

  // Everything the imperative path needs that a render owns. Written in the
  // layout effect below, never during render.
  const state = useRef({
    zoom: 1,
    selection: null as RotatedRect | null,
    /** Corner radii in scene px, or `null` for no radius handles at all. */
    radii: null as readonly number[] | null,
    /**
     * What the readout should say. Set by the handle that started the gesture,
     * or announced by the gesture layer for a move, which starts on the shape.
     */
    mode: null as ReadoutMode | null,
    live: false,
  });

  /** Each radius handle sits where its arc starts, or at a reachable minimum. */
  const drawRadii = useCallback((rect: Rect, k: number) => {
    const values = state.current.radii;
    const on = values !== null && Math.min(rect.w, rect.h) >= RADIUS_MIN_BOX * k;
    radii.current!.style.display = on ? "" : "none";
    radiusZones.current!.style.display = on ? "" : "none";
    if (!values || !on) return;
    const inset = RADIUS_INSET * k;
    const limit = Math.min(rect.w, rect.h) / 2;
    for (let i = 0; i < CORNERS.length; i++) {
      const [fx, fy] = FRAC[CORNERS[i]];
      const d = Math.min(Math.max(values[i], inset), limit);
      const px = rect.x + (fx ? rect.w - d : d);
      const py = rect.y + (fy ? rect.h - d : d);
      dot(radii.current!.children[i], px, py, (RADIUS_GRIP / 2) * k);
      dot(radiusZones.current!.children[i], px, py, (RADIUS_TARGET / 2) * k);
    }
  }, []);

  const draw = useCallback(
    (
      rect: Rect | null,
      rot: number,
      fired: readonly SnapGuide[],
      live: boolean,
    ) => {
      // Mounted together with every other ref below, so one guard covers them.
      const svg = root.current;
      if (!svg) return;
      const k = 1 / state.current.zoom;
      svg.style.setProperty("--k", String(k));
      svg.classList.toggle("is-live", live);
      guides.current!.setAttribute("d", guidePath(fired, k));

      const group = frame.current!;
      if (!rect) {
        group.style.display = "none";
        chip.current!.style.display = "none";
        return;
      }
      group.style.display = "";

      const { x, y, w, h } = rect;
      const cx = x + w / 2;
      const cy = y + h / 2;
      group.setAttribute("transform", rot ? `rotate(${rot} ${cx} ${cy})` : "");
      box(outline.current!, x, y, w, h);

      // Read-only stops at the outline. The handle groups are hidden markup
      // below, so nothing here is stale — there is simply nothing to place,
      // and the readout only ever describes a gesture in progress.
      if (readOnly) {
        chip.current!.style.display = "none";
        return;
      }

      const t = TARGET * k;
      const z = ZONE * k;
      for (let i = 0; i < CORNERS.length; i++) {
        const [fx, fy] = FRAC[CORNERS[i]];
        const px = x + fx * w;
        const py = y + fy * h;
        dot(grips.current!.children[i], px, py, (GRIP / 2) * k);
        box(corners.current!.children[i], px - t / 2, py - t / 2, t, t);
        box(zones.current!.children[i], px - (fx ? 0 : z), py - (fy ? 0 : z), z, z);
      }

      // No visible bars, but the whole edge is still grabbable — the corners are
      // painted after these, so they win where the two overlap.
      const e = EDGE * k;
      const strip = edges.current!.children;
      box(strip[0], x, y - e / 2, w, e);
      box(strip[1], x + w - e / 2, y, e, h);
      box(strip[2], x, y + h - e / 2, w, e);
      box(strip[3], x - e / 2, y, e, h);

      drawRadii(rect, k);

      const readout = chip.current!;
      const mode = live ? state.current.mode : null;
      if (!mode) {
        readout.style.display = "none";
        return;
      }
      const label =
        mode === "rotate"
          ? `${Math.round(normalizeAngle(rot))}°`
          : mode === "move"
            ? // Where the box is landing, which is what a move is choosing.
              `${Math.round(x)}, ${Math.round(y)}`
            : `${Math.round(w)} × ${Math.round(h)}`;
      // Monospace, so the box can be sized without measuring.
      const width = label.length * 6.7 + 14;
      chipText.current!.textContent = label;
      chipBox.current!.setAttribute("x", String(-width / 2));
      chipBox.current!.setAttribute("width", String(width));
      const b = nodeBounds({ x, y, w, h, rot });
      readout.style.display = "";
      readout.setAttribute(
        "transform",
        `translate(${b.x + b.w / 2} ${b.y + b.h + CHIP_GAP * k}) scale(${k})`,
      );
    },
    [drawRadii, readOnly],
  );

  /** What the corner radii were last read for, so they are not read for nothing. */
  const probed = useRef<{ id: NodeId | null; box: RotatedRect | null }>({
    id: null,
    box: null,
  });

  useLayoutEffect(() => {
    state.current.zoom = zoom;
    state.current.selection = selection;
    // `getComputedStyle` forces a style read, so it is done when the selected
    // node or its box changes and not when the zoom does — a wheel zoom
    // re-renders every frame, and a radius in scene px does not depend on it.
    const id = ids?.length === 1 ? ids[0] : null;
    const last = probed.current;
    if (id !== last.id || !sameRect(selection, last.box)) {
      probed.current = { id, box: selection };
      const el =
        id && onRadiusStart
          ? viewport.sceneRef.current?.querySelector<HTMLElement>(
              `[data-id="${CSS.escape(id)}"]`,
            )
          : null;
      state.current.radii = el ? radiiOf(el) : null;
    }
    if (state.current.live) return;
    draw(selection, selection?.rot ?? 0, NO_GUIDES, false);
  });

  useImperativeHandle(
    ref,
    () => ({
      update(rect, rot, fired) {
        state.current.live = rect !== null;
        if (rect) {
          draw(rect, rot, fired, true);
          return;
        }
        state.current.mode = null;
        const current = state.current.selection;
        draw(current, current?.rot ?? 0, NO_GUIDES, false);
      },
      mode(next) {
        state.current.mode = next;
      },
      radius(values) {
        state.current.radii = values;
        const current = state.current.selection;
        if (current) drawRadii(current, 1 / state.current.zoom);
      },
      marquee(rect) {
        const el = band.current;
        if (!el) return;
        if (!rect) {
          el.style.display = "none";
          return;
        }
        el.style.display = "";
        box(el, rect.x, rect.y, rect.w, rect.h);
      },
    }),
    [draw, drawRadii],
  );

  const rot = selection?.rot ?? 0;
  /** Every group that is a verb — present in the markup, absent to a reader. */
  const grabbable = readOnly ? { display: "none" } : undefined;
  const start =
    (mode: "resize" | "rotate", handle: Handle) =>
    (event: ReactPointerEvent) => {
      event.stopPropagation();
      state.current.mode = mode;
      if (mode === "rotate") onRotateStart(event);
      else onResizeStart(event, handle);
    };

  return (
    <svg ref={root} className={readOnly ? "nt-ov is-view" : "nt-ov"}>
      <g className="nt-ov-members">
        {members.map((m, i) => (
          <rect key={i} {...outlineOf(m)} />
        ))}
      </g>
      {hover && <rect className="nt-ov-hover" {...outlineOf(hover)} />}
      <path ref={guides} className="nt-ov-guides" d="" />
      <rect ref={band} className="nt-ov-band" style={{ display: "none" }} />
      {/* Kept in the tree read-only rather than dropped: `draw` addresses every
          ref below without guarding, and a hidden group is a cheaper promise to
          keep than four more null checks on the path that runs every frame. */}
      <g ref={frame} style={{ display: "none" }}>
        <rect ref={outline} className="nt-ov-outline" />
        <g ref={zones} className="nt-ov-zones" style={grabbable}>
          {CORNERS.map((corner) => (
            <rect
              key={corner}
              style={{ cursor: rotationCursor(outward(corner) + rot) }}
              onPointerDown={readOnly ? undefined : start("rotate", corner)}
            />
          ))}
        </g>
        <g ref={edges} className="nt-ov-edges" style={grabbable}>
          {EDGES.map((handle) => (
            <rect
              key={handle}
              style={{ cursor: resizeCursor(handle, rot) }}
              onPointerDown={readOnly ? undefined : start("resize", handle)}
            />
          ))}
        </g>
        <g ref={corners} className="nt-ov-corners" style={grabbable}>
          {CORNERS.map((handle) => (
            <rect
              key={handle}
              style={{ cursor: resizeCursor(handle, rot) }}
              onPointerDown={readOnly ? undefined : start("resize", handle)}
            />
          ))}
        </g>
        <g ref={grips} className="nt-ov-grips" style={grabbable}>
          {CORNERS.map((corner) => (
            <circle key={corner} />
          ))}
        </g>
        <g ref={radii} className="nt-ov-radii" style={{ display: "none" }}>
          {CORNERS.map((corner) => (
            <circle key={corner} />
          ))}
        </g>
        <g
          ref={radiusZones}
          className="nt-ov-radius-zones"
          style={{ display: "none" }}
        >
          {CORNERS.map((corner) => (
            <circle
              key={corner}
              onPointerDown={(event) => {
                event.stopPropagation();
                onRadiusStart?.(event, corner);
              }}
            />
          ))}
        </g>
      </g>
      <g ref={chip} className="nt-ov-chip" style={{ display: "none" }}>
        <rect ref={chipBox} y="0" height="18" rx="3" />
        <text ref={chipText} y="12.5" textAnchor="middle" />
      </g>
    </svg>
  );
}
