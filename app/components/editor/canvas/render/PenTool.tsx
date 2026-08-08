"use client";

/**
 * The pen tool: draw a path, then edit it.
 *
 * Mount this as a direct child of the viewport container (the element
 * `ViewportController.containerRef` is attached to), not of the transformed
 * scene layer. It covers the container and draws in **viewport px**, which is
 * what keeps an anchor 7px across at every zoom — the one property that makes a
 * pen tool usable when you are zoomed out.
 *
 * Anchors are held in **scene space**, in a ref. Scene space is the only space
 * that survives an edit: writing the path back re-origins the node's box around
 * the new bounds, so an anchor list in the node's own coordinates would need
 * rebasing after every change. They are converted to the node's local space
 * once, at the moment the path is written.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { SceneStore } from "../engine/useScene";
import type { ViewportController } from "../engine/useViewport";
import {
  absoluteRect,
  absoluteRotation,
  sceneToViewport,
  toLocal,
  toWorld,
} from "../scene/geometry";
import { mintId } from "../scene/ops";
import {
  bendSegment,
  clearHandles,
  hitTestPath,
  insertAnchor,
  parsePath,
  parseSubpaths,
  removeAnchor,
  serializePath,
  serializeSubpaths,
  setAnchorKind,
  setHandle,
  subpathsBounds,
  type Anchor,
} from "../scene/path";
import { DRAWN_INK, DRAWN_STROKE_WIDTH } from "./svgShape";
import type { NodeId, PathNode, Point } from "../scene/types";

/** Screen px. Constant at every zoom, because the overlay draws in viewport px. */
const ANCHOR_SIZE = 7;
const HANDLE_RADIUS = 3.5;
const GRAB = 8;
/** Screen px of travel before a placed anchor starts pulling its handles out. */
const PULL = 3;
/** The ring drawn around the first anchor when a press there would close. */
const CLOSE_RING = 6.5;
/** Illustrator's and Figma's badge: a small ring up and right of the cursor. */
const CLOSE_GLYPH = 4;
const GLYPH_OFFSET = 11;

/** One ink for the tool's chrome, the line it draws, and the renderer's
 *  fallback for a path nobody painted — so all three are the same black. */
const INK = DRAWN_INK;
const MUTED = "#9a9a9a";

const ZERO: Point = { x: 0, y: 0 };

type Side = "in" | "out";

type Drag =
  /**
   * An anchor being given its handles by the press that landed on it — placing
   * a new one, ⌘-stripping an old one, or closing the loop. `anchor` is how it
   * stood the instant the press took it, which a drag shorter than `PULL`
   * restores: the gesture then amounts to the press alone.
   */
  | { kind: "place"; index: number; anchor: Anchor }
  | { kind: "anchor"; index: number }
  | { kind: "handle"; index: number; side: Side }
  | { kind: "bend"; index: number; t: number };

/** How far an arrow key moves the selected anchors, in scene px. */
const NUDGE = 1;
const NUDGE_FAR = 10;

const ARROWS: Readonly<Record<string, Point>> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/** ⌘ on Apple platforms, Ctrl elsewhere — the bend modifier, as in Figma. */
function bendKey(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.metaKey || e.ctrlKey;
}

export interface PenToolProps {
  store: SceneStore;
  viewport: ViewportController;
  /** An existing path to edit. `null` draws a new one from the first click. */
  nodeId?: NodeId | null;
  /** The pen is done: leave the tool, and select `id` when there is one. */
  onFinish: (id: NodeId | null) => void;
}

/** Map an anchor through a point transform, carrying its handles along. */
function mapAnchor(a: Anchor, f: (p: Point) => Point): Anchor {
  const point = f(a.point);
  const rel = (h: Point): Point => {
    const q = f({ x: a.point.x + h.x, y: a.point.y + h.y });
    return { x: q.x - point.x, y: q.y - point.y };
  };
  return {
    point,
    handleIn: rel(a.handleIn),
    handleOut: rel(a.handleOut),
    kind: a.kind,
  };
}

/** A node's box in scene space, as a frame `toLocal`/`toWorld` accept. */
function nodeFrame(store: SceneStore, id: NodeId) {
  const scene = store.getScene();
  return { ...absoluteRect(scene, id), rot: absoluteRotation(scene, id) };
}

function load(store: SceneStore, id: NodeId | null) {
  const node = id ? store.getNode(id) : null;
  if (!node || node.kind !== "path") return { anchors: [] as Anchor[], closed: false };
  const frame = nodeFrame(store, node.id);
  const parsed = parsePath(node.d);
  return {
    anchors: parsed.anchors.map((a) => mapAnchor(a, (p) => toWorld(p, frame))),
    closed: parsed.closed,
  };
}

/** Somewhere a Backspace means "delete a character", not "delete an anchor". */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Move every selected anchor by the same delta, handles and all. */
function nudgeAnchors(
  anchors: readonly Anchor[],
  selected: ReadonlySet<number>,
  dx: number,
  dy: number,
): Anchor[] {
  return anchors.map((a, i) =>
    selected.has(i)
      ? { ...a, point: { x: a.point.x + dx, y: a.point.y + dy } }
      : a,
  );
}

/** The topmost anchor within `tol` of `p`, or -1. Both are in scene units. */
function nearestAnchor(
  anchors: readonly Anchor[],
  p: Point,
  tol: number,
): number {
  for (let i = anchors.length - 1; i >= 0; i--) {
    const q = anchors[i].point;
    if (Math.abs(q.x - p.x) <= tol && Math.abs(q.y - p.y) <= tol) return i;
  }
  return -1;
}

/** Move a circle into place, or hide it. */
function place(el: SVGCircleElement | null, on: boolean, x = 0, y = 0): void {
  if (!el) return;
  el.style.display = on ? "" : "none";
  if (!on) return;
  el.setAttribute("cx", String(x));
  el.setAttribute("cy", String(y));
}

function paintHandle(
  line: SVGLineElement | null,
  dot: SVGCircleElement | null,
  anchor: Anchor | undefined,
  handle: Point | undefined,
): void {
  const on = !!anchor && !!handle && (handle.x !== 0 || handle.y !== 0);
  if (line) line.style.display = on ? "" : "none";
  if (dot) dot.style.display = on ? "" : "none";
  if (!on || !anchor || !handle) return;
  const x = anchor.point.x + handle.x;
  const y = anchor.point.y + handle.y;
  line?.setAttribute("x1", String(anchor.point.x));
  line?.setAttribute("y1", String(anchor.point.y));
  line?.setAttribute("x2", String(x));
  line?.setAttribute("y2", String(y));
  dot?.setAttribute("cx", String(x));
  dot?.setAttribute("cy", String(y));
}

export function PenTool({
  store,
  viewport,
  nodeId = null,
  onFinish,
}: PenToolProps) {
  const [initial] = useState(() => load(store, nodeId));

  const anchorsRef = useRef<Anchor[]>(initial.anchors);
  const closedRef = useRef(initial.closed);
  /**
   * The selected anchors, by index. Handles are shown — and grabbable — for
   * every one of them, Delete removes all of them and the arrows nudge all of
   * them; drawing simply keeps the anchor just placed in it, alone.
   */
  const selectedRef = useRef<Set<number>>(
    new Set(initial.anchors.length ? [initial.anchors.length - 1] : []),
  );
  const idRef = useRef<NodeId | null>(nodeId);
  /** Only a path we are drawing grows from a click on empty canvas. */
  const drawingRef = useRef(nodeId === null);
  const cursorRef = useRef<Point | null>(null);
  const dragRef = useRef<Drag | null>(null);
  /**
   * The press that closed the loop is still down. Closing is a gesture like any
   * other — it shuts the path on the way down and finishes it on the way up, so
   * a drag between the two curves the closing segment.
   */
  const closingRef = useRef(false);
  const pointerRef = useRef(-1);
  const frameRef = useRef(0);

  /** Whether a `store.begin()` bracket is open, so unmount can close it. */
  const bracketRef = useRef(false);
  const curveRef = useRef<SVGPathElement>(null);
  const draftRef = useRef<SVGPathElement>(null);
  const closeRingRef = useRef<SVGCircleElement>(null);
  const closeGlyphRef = useRef<SVGCircleElement>(null);
  const squaresRef = useRef<(SVGRectElement | null)[]>([]);
  const outLineRef = useRef<(SVGLineElement | null)[]>([]);
  const inLineRef = useRef<(SVGLineElement | null)[]>([]);
  const outDotRef = useRef<(SVGCircleElement | null)[]>([]);
  const inDotRef = useRef<(SVGCircleElement | null)[]>([]);

  /**
   * The only structural fact React needs: how many anchors there are, and so
   * how many squares and handle pairs exist. Which of them are selected, and
   * where they all sit, is painted onto those elements — not rendered.
   */
  const [count, setCount] = useState(initial.anchors.length);

  // -- Closing --------------------------------------------------------------

  /**
   * Whether a press at `p` would close the path rather than drop another
   * anchor. The hover indicator asks this exact question, so what is shown and
   * what happens cannot drift apart.
   *
   * The tolerance is `GRAB` **screen** px converted to scene units, like every
   * other handle on the canvas: a target that shrank with the zoom would be
   * unhittable from far out.
   */
  const closesLoop = useCallback(
    (p: Point | null): boolean =>
      !!p &&
      drawingRef.current &&
      !closedRef.current &&
      anchorsRef.current.length > 2 &&
      nearestAnchor(anchorsRef.current, p, GRAB / viewport.get().zoom) === 0,
    [viewport],
  );

  // -- Painting -------------------------------------------------------------

  const paint = useCallback(() => {
    const curve = curveRef.current;
    if (!curve) return;
    const vp = viewport.get();
    const px = anchorsRef.current.map((a) =>
      mapAnchor(a, (p) => sceneToViewport(p, vp)),
    );
    curve.setAttribute("d", serializePath(px, closedRef.current));

    const tip = cursorRef.current;
    const last = px[px.length - 1];
    const live = drawingRef.current && !closedRef.current && !dragRef.current;
    const closing = live && closesLoop(tip);
    const cursor = tip ? sceneToViewport(tip, vp) : null;

    // While closing, the rubber band *is* the closing segment — handles and all
    // — so the loop is drawn before it is committed.
    const target: Anchor | null = closing
      ? px[0]
      : cursor && {
          point: cursor,
          handleIn: ZERO,
          handleOut: ZERO,
          kind: "corner",
        };
    const rubber =
      live && last && target ? serializePath([last, target], false) : "";
    draftRef.current?.setAttribute("d", rubber);

    place(closeRingRef.current, closing, px[0]?.point.x, px[0]?.point.y);
    place(
      closeGlyphRef.current,
      closing,
      (cursor?.x ?? 0) + GLYPH_OFFSET,
      (cursor?.y ?? 0) - GLYPH_OFFSET,
    );

    const selected = selectedRef.current;
    for (let i = 0; i < px.length; i++) {
      const el = squaresRef.current[i];
      if (!el) continue;
      const on = selected.has(i);
      el.setAttribute("x", String(px[i].point.x - ANCHOR_SIZE / 2));
      el.setAttribute("y", String(px[i].point.y - ANCHOR_SIZE / 2));
      el.setAttribute("fill", on ? INK : "#fff");
      // Handles belong to the selection, so several anchors can be under the
      // hand at once — which is what makes a multi-anchor selection editable
      // rather than merely movable.
      const shown = on ? px[i] : undefined;
      paintHandle(
        outLineRef.current[i],
        outDotRef.current[i],
        shown,
        px[i].handleOut,
      );
      paintHandle(
        inLineRef.current[i],
        inDotRef.current[i],
        shown,
        px[i].handleIn,
      );
    }
  }, [viewport, closesLoop]);

  // Every render is a structural change; positions are written here, not in JSX.
  useLayoutEffect(paint);

  // Pan and zoom move the overlay without changing anything React renders.
  useEffect(() => viewport.subscribe(paint), [viewport, paint]);

  /**
   * Anything that changed the anchor list or the selection. The count is the
   * only part React renders; the rest is repainted here, because a selection
   * that moved between two anchors is not a structural change and must not
   * cost a render.
   */
  const sync = useCallback(() => {
    setCount(anchorsRef.current.length);
    paint();
  }, [paint]);

  // -- Writing --------------------------------------------------------------

  const write = useCallback(() => {
    const id = idRef.current;
    if (!id) return;
    const node = store.getNode(id);
    if (!node || node.kind !== "path") return;
    const frame = nodeFrame(store, id);
    const local = anchorsRef.current.map((a) =>
      mapAnchor(a, (p) => toLocal(p, frame)),
    );
    /**
     * The strokes this tool is not editing.
     *
     * A drawn shape is often several subpaths — a stick figure is a head and
     * five lines — and the pen loads only the first, because an editable path is
     * one anchor list. Serializing just that list would delete the rest of the
     * drawing the moment a point was nudged, so they are carried through
     * untouched.
     *
     * Re-read from the node here rather than held from mount: they are already
     * in the node's local space, and reading them now means the space they are
     * in is the same one `local` was just mapped into, whatever happened to the
     * node's frame while the points were open.
     */
    const rest = parseSubpaths(node.d).slice(1);
    const edited = { anchors: local, closed: closedRef.current };
    const box = subpathsBounds([edited, ...rest]) ?? { x: 0, y: 0, w: 0, h: 0 };
    const move = (a: Anchor): Anchor => ({
      ...a,
      point: { x: a.point.x - box.x, y: a.point.y - box.y },
    });
    const shifted = local.map(move);
    // The box has moved within the node's own space; re-place it so the drawing
    // stays where it is — which under rotation is not a plain subtraction.
    const centre = toWorld(
      { x: box.x + box.w / 2, y: box.y + box.h / 2 },
      node,
    );
    store.dispatch({
      type: "setPath",
      id,
      d: serializeSubpaths([
        { anchors: shifted, closed: closedRef.current },
        ...rest.map((p) => ({ ...p, anchors: p.anchors.map(move) })),
      ]),
      frame: {
        x: centre.x - box.w / 2,
        y: centre.y - box.h / 2,
        w: box.w,
        h: box.h,
      },
    });
  }, [store]);

  const ensureNode = useCallback(
    (at: Point): void => {
      if (idRef.current) return;
      const id = mintId(store.getScene());
      const node: PathNode = {
        kind: "path",
        id,
        x: at.x,
        y: at.y,
        w: 0,
        h: 0,
        rot: 0,
        style: {
          fill: "none",
          stroke: INK,
          "stroke-width": DRAWN_STROKE_WIDTH,
        },
        label: "",
        locked: false,
        hidden: false,
        attrs: {},
        d: "",
      };
      store.dispatch({ type: "insert", nodes: [node] });
      idRef.current = id;
    },
    [store],
  );

  const finish = useCallback(() => {
    const id = idRef.current;
    if (anchorsRef.current.length < 2) {
      if (id) store.dispatch({ type: "remove", ids: [id] });
      onFinish(null);
      return;
    }
    write();
    onFinish(id);
  }, [store, write, onFinish]);

  /** One visual update and one committed edit per frame, never per event. */
  const schedule = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      paint();
      if (dragRef.current) write();
    });
  }, [paint, write]);

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      // Escape can unmount us mid-drag; an unclosed bracket would wedge undo.
      if (bracketRef.current) store.commit();
    },
    [store],
  );

  // -- Hit testing ----------------------------------------------------------

  /** The nearest grabbable handle — any selected anchor's — within `tol`. */
  const hitHandle = useCallback(
    (p: Point, tol: number): { index: number; side: Side } | null => {
      const anchors = anchorsRef.current;
      let best: { index: number; side: Side } | null = null;
      let nearest = tol;
      for (const index of selectedRef.current) {
        const a = anchors[index];
        if (!a) continue;
        for (const side of ["out", "in"] as const) {
          const h = side === "in" ? a.handleIn : a.handleOut;
          if (h.x === 0 && h.y === 0) continue;
          const d = Math.hypot(a.point.x + h.x - p.x, a.point.y + h.y - p.y);
          if (d <= nearest) {
            nearest = d;
            best = { index, side };
          }
        }
      }
      return best;
    },
    [],
  );

  // -- Pointer --------------------------------------------------------------

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      // Space-drag belongs to the viewport, whatever tool is active.
      if (e.button !== 0 || viewport.panState() !== "idle") return;
      e.preventDefault();
      const p = viewport.clientToScene({ x: e.clientX, y: e.clientY });
      const tol = GRAB / viewport.get().zoom;
      const anchors = anchorsRef.current;
      const closed = closedRef.current;

      const begin = (drag: Drag) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        pointerRef.current = e.pointerId;
        dragRef.current = drag;
        bracketRef.current = true;
        store.begin();
      };

      const grabbed = hitHandle(p, tol);
      if (grabbed) {
        // Alt breaks the mirror, so this one side moves alone.
        if (e.altKey) {
          anchorsRef.current = setAnchorKind(anchors, grabbed.index, "corner");
        }
        begin({ kind: "handle", ...grabbed });
        return;
      }

      const index = nearestAnchor(anchors, p, tol);
      if (index >= 0) {
        if (closesLoop(p)) {
          // Shut the loop now; the handle pull every other anchor gets then
          // curves the closing segment, and the release finishes the path.
          closedRef.current = true;
          closingRef.current = true;
          selectedRef.current = new Set([0]);
          begin({ kind: "place", index: 0, anchor: anchors[0] });
          write();
          sync();
          return;
        }
        if (bendKey(e)) {
          // ⌘ on an anchor is Figma's bend tool, and both halves of it fall out
          // of one gesture: the press strips the curves, and a drag from there
          // pulls new ones symmetrically out of the corner it left. Release
          // without moving and the strip is all that happened.
          anchorsRef.current = clearHandles(anchors, index);
          selectedRef.current = new Set([index]);
          begin({ kind: "place", index, anchor: anchorsRef.current[index] });
          write();
        } else if (e.shiftKey) {
          // Extending the selection is a statement about which anchors, not the
          // start of a drag of them.
          const next = new Set(selectedRef.current);
          if (!next.delete(index)) next.add(index);
          selectedRef.current = next;
        } else {
          if (!selectedRef.current.has(index)) {
            selectedRef.current = new Set([index]);
          }
          begin({ kind: "anchor", index });
        }
        sync();
        return;
      }

      const hit = hitTestPath({ anchors, closed }, p, tol);
      if (hit) {
        if (bendKey(e)) {
          begin({ kind: "bend", index: hit.index, t: hit.t });
          return;
        }
        anchorsRef.current = insertAnchor({ anchors, closed }, hit.index, hit.t);
        selectedRef.current = new Set([hit.index + 1]);
        begin({ kind: "anchor", index: hit.index + 1 });
        write();
        sync();
        return;
      }

      if (!drawingRef.current || closed) {
        finish();
        return;
      }
      ensureNode(p);
      anchorsRef.current = [
        ...anchors,
        { point: p, handleIn: ZERO, handleOut: ZERO, kind: "corner" },
      ];
      const placed = anchorsRef.current.length - 1;
      selectedRef.current = new Set([placed]);
      begin({
        kind: "place",
        index: placed,
        anchor: anchorsRef.current[placed],
      });
      write();
      sync();
    },
    [
      viewport,
      store,
      closesLoop,
      hitHandle,
      write,
      ensureNode,
      finish,
      sync,
    ],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const p = viewport.clientToScene({ x: e.clientX, y: e.clientY });
      cursorRef.current = p;
      const drag = dragRef.current;
      const anchors = anchorsRef.current;
      const a = drag ? anchors[drag.index] : undefined;
      if (drag && a) {
        const v = { x: p.x - a.point.x, y: p.y - a.point.y };
        if (drag.kind === "anchor") {
          // The whole selection travels with the anchor under the hand.
          anchorsRef.current = nudgeAnchors(
            anchors,
            selectedRef.current,
            v.x,
            v.y,
          );
        } else if (drag.kind === "handle") {
          anchorsRef.current = setHandle(anchors, drag.index, drag.side, v);
        } else if (drag.kind === "bend") {
          anchorsRef.current = bendSegment(
            { anchors, closed: closedRef.current },
            drag.index,
            drag.t,
            p,
          );
        } else {
          // Click-and-drag pulls both handles out symmetrically — the gesture
          // the whole tool is judged on, and the same one that curves the
          // closing segment when the press landed on the first anchor.
          const pulled = Math.hypot(v.x, v.y) * viewport.get().zoom > PULL;
          const next = anchors.slice();
          next[drag.index] = pulled
            ? {
                ...drag.anchor,
                handleOut: v,
                handleIn: { x: -v.x, y: -v.y },
                kind: "smooth",
              }
            : drag.anchor;
          anchorsRef.current = next;
        }
      }
      schedule();
    },
    [viewport, schedule],
  );

  /** The rubber band and the close badge follow a cursor that is still here. */
  const onPointerLeave = useCallback(() => {
    if (dragRef.current) return;
    cursorRef.current = null;
    schedule();
  }, [schedule]);

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      if (e.pointerId !== pointerRef.current) return;
      pointerRef.current = -1;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      if (!dragRef.current) return;
      dragRef.current = null;
      write();
      bracketRef.current = false;
      store.commit();
      if (closingRef.current) {
        closingRef.current = false;
        onFinish(idRef.current);
        return;
      }
      paint();
    },
    [write, store, paint, onFinish],
  );

  const onDoubleClick = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      const p = viewport.clientToScene({ x: e.clientX, y: e.clientY });
      const anchors = anchorsRef.current;
      const index = nearestAnchor(anchors, p, GRAB / viewport.get().zoom);
      if (index < 0) return;
      e.preventDefault();
      anchorsRef.current = setAnchorKind(
        anchors,
        index,
        anchors[index].kind === "smooth" ? "corner" : "smooth",
      );
      selectedRef.current = new Set([index]);
      write();
      sync();
    },
    [viewport, write, sync],
  );

  // -- Keyboard -------------------------------------------------------------

  /**
   * Bound on the window in the **capture** phase, which is the only place ahead
   * of the canvas keymap on the container below us. Without that, ⌫ deletes the
   * whole path instead of an anchor, an arrow key moves the node instead of the
   * points, and Escape drops the selection on its way out — the canvas is right
   * about all three, but not while its vectors are open.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextEntry(e.target)) return;
      const claim = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (e.key === "Enter" || e.key === "Escape") {
        claim();
        finish();
        return;
      }

      const selected = selectedRef.current;
      if (selected.size === 0) return;

      const arrow = ARROWS[e.key];
      if (arrow) {
        claim();
        const step = e.shiftKey ? NUDGE_FAR : NUDGE;
        anchorsRef.current = nudgeAnchors(
          anchorsRef.current,
          selected,
          arrow.x * step,
          arrow.y * step,
        );
        write();
        sync();
        return;
      }

      if (e.key !== "Backspace" && e.key !== "Delete") return;
      claim();
      // Highest index first, so each removal leaves the ones still to go where
      // they were. What is left simply joins up — the path stays one subpath.
      let next = anchorsRef.current;
      for (const index of [...selected].sort((a, b) => b - a)) {
        next = removeAnchor(next, index);
      }
      anchorsRef.current = next;
      const keep = Math.min(Math.min(...selected), next.length - 1);
      selectedRef.current = new Set(keep >= 0 ? [keep] : []);
      if (next.length < 2) closedRef.current = false;
      write();
      sync();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [finish, write, sync]);

  // -- Overlay --------------------------------------------------------------

  return (
    <svg
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        cursor: "var(--nt-pen-cursor, crosshair)",
        touchAction: "none",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
      onDoubleClick={onDoubleClick}
    >
      <g fill="none" strokeWidth={1}>
        <path ref={curveRef} stroke={INK} />
        <path ref={draftRef} stroke={MUTED} strokeDasharray="3 3" />
        {Array.from({ length: count }, (_, i) => (
          <g key={i} stroke={MUTED}>
            <line
              ref={(el) => {
                outLineRef.current[i] = el;
              }}
            />
            <line
              ref={(el) => {
                inLineRef.current[i] = el;
              }}
            />
            <circle
              ref={(el) => {
                outDotRef.current[i] = el;
              }}
              r={HANDLE_RADIUS}
              fill="#fff"
            />
            <circle
              ref={(el) => {
                inDotRef.current[i] = el;
              }}
              r={HANDLE_RADIUS}
              fill="#fff"
            />
          </g>
        ))}
      </g>
      <g stroke={INK} strokeWidth={1}>
        {Array.from({ length: count }, (_, i) => (
          <rect
            key={i}
            ref={(el) => {
              squaresRef.current[i] = el;
            }}
            width={ANCHOR_SIZE}
            height={ANCHOR_SIZE}
            fill="#fff"
          />
        ))}
      </g>
      {/* The loop-closing affordance: the first anchor ringed, and the badge
          Illustrator and Figma both hang beside the cursor. */}
      <g fill="none" stroke={INK} strokeWidth={1.25} pointerEvents="none">
        <circle ref={closeRingRef} r={CLOSE_RING} style={{ display: "none" }} />
        <circle
          ref={closeGlyphRef}
          r={CLOSE_GLYPH}
          style={{ display: "none" }}
        />
      </g>
    </svg>
  );
}
