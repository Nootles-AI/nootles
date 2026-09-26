"use client";

/**
 * Drag, resize and rotate — the three gestures the canvas lives or dies by.
 *
 * ## Nothing re-renders while your finger is down
 *
 * A gesture reads the scene once, at pointerdown, and from then on owns the
 * pixels: it writes `transform`, `width` and `height` straight onto each node's
 * element and onto the selection overlay, through refs, exactly once per
 * animation frame. React is told nothing until pointerup, when the whole
 * gesture lands as **one** array of ops inside one `begin`/`commit` bracket —
 * one undo entry, one persist. Everything that changes per frame lives in a ref
 * on the session object below; nothing here calls `setState`.
 *
 * That is also why this hook takes its collaborators as plain accessors rather
 * than as values: a value would have to come from React state, and React state
 * that changes during a drag is exactly what we are avoiding.
 *
 * ## Three spaces, and the conversions between them
 *
 * The pointer arrives in **client** px, snapping and the overlay work in
 * **scene** px, and both the DOM writes and the ops are in a node's **parent**
 * space — because that is what `x`/`y` mean and what `transform` does. So every
 * frame computes each node's box in both scene and parent space (see
 * {@link Frame}); the conversion is a rotation by the node's *ancestors'*
 * rotation, which is fixed for the duration of the gesture and captured once.
 * Client → scene is asked afresh every frame: the page can scroll the band
 * under a held pointer, and the band is wherever it is now.
 *
 * ## A band holds what is in it
 *
 * A diagram on the page is its band's width and grows downward, so a gesture
 * keeps the selection inside the band's x-range and below its top — or, for
 * content that already reached past them, no further out than it began. A
 * move is clamped exactly, a scale's factor is capped, and a resize that would
 * leave is clamped where the maths is linear and refused where it is not.
 *
 * ## Modifiers, as Figma has trained everyone to expect
 *
 * Shift constrains — axis-locks a drag, keeps the aspect ratio of a resize,
 * quantises a rotation to 15°. Alt resizes about the centre, and turns a drag
 * into a duplicate. ⌘/Ctrl suspends snapping. Escape cancels and puts
 * everything back. All of them are live: pressing Shift mid-drag re-runs the
 * frame without waiting for the pointer to move.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";

import { serializeComposite } from "../panels/cssCatalog";
import { shapeWriter, type ShapeWriter } from "../render/svgShape";
import {
  isAutoLayout,
  laidOutScene,
  layoutOf,
  resolveLayout,
} from "../scene/autoLayout";
import {
  absoluteRect,
  absoluteRotation,
  angleOf,
  HANDLE_EDGES,
  HANDLES,
  nodeBounds,
  normalizeAngle,
  resizeRect,
  rotateAround,
  selectionBounds,
  snapAngle,
  toLocal,
  unionBounds,
  type Handle,
  type RotatedRect,
} from "../scene/geometry";
import { mintIds, reflowHugs } from "../scene/ops";
import {
  findNode,
  findParent,
  isContainer,
  nodePath,
  walk,
  type GroupNode,
  type NodeFrame,
  type NodeId,
  type Point,
  type Rect,
  type Scene,
  type SceneNode,
  type SceneOp,
} from "../scene/types";
import {
  boxTargets,
  collectSnapScope,
  createSnapper,
  resizeTargets,
  type SnapExtra,
  type SnapGuide,
  type SnapLine,
  type SnapTarget,
  type Snapper,
} from "./snapping";

// ---------------------------------------------------------------------------
// Collaborators
// ---------------------------------------------------------------------------

/**
 * The slice of the scene store a gesture needs. Structural on purpose — the
 * store is written elsewhere and only has to have these four members.
 */
export interface TransformStore {
  getScene(): Scene;
  /** Open a coalescing bracket: everything until `commit` is one undo entry. */
  begin(): void;
  commit(): void;
  dispatch(ops: SceneOp[]): void;
}

/** What the overlay's readout chip describes while a gesture runs. */
export type ReadoutMode = "move" | "resize" | "rotate";

/**
 * The overlay's imperative handle. Called once per frame during a gesture, and
 * once with `null` when it ends — which means "the gesture is over, draw
 * yourself from the committed scene again".
 */
export interface OverlayHandle {
  update(
    rect: Rect | null,
    rot: number,
    guides: readonly SnapGuide[],
  ): void;
  /** The four corner radii in scene px, clockwise from the top-left. */
  radius(corners: readonly number[]): void;
  /**
   * What the readout should say, announced once as the gesture goes active. The
   * overlay knows this already for its own handles, but a move starts on the
   * shape and never touches one — so the mode has to arrive from here.
   */
  mode(mode: ReadoutMode | null): void;
}

export type GestureMode = "move" | "resize" | "scale" | "rotate" | "reorder";

/**
 * Which of them the readout can speak for. A scale reads as the box it lands
 * on, like a resize; a reorder is placed by the layout rather than the pointer,
 * so coordinates would be a lie.
 */
const READOUT: Record<GestureMode, ReadoutMode | null> = {
  move: "move",
  resize: "resize",
  scale: "resize",
  rotate: "rotate",
  reorder: null,
};

/** A band's x-range in scene px; its top is always 0. */
export interface BandRange {
  minX: number;
  maxX: number;
}

export interface TransformGestureOptions {
  store: TransformStore;
  /** Event coordinates → scene px. Asked every frame. */
  clientToScene(point: Point): Point;
  /** Screen px per scene px, so snapping reads the same on screen at any scale. */
  screenScale(): number;
  /** The band the selection is held in, or `null` for a frame, which has none. */
  band?(): BandRange | null;
  /** Selection ids. Ids nested inside another selected node are ignored. */
  getSelection(): readonly NodeId[];
  /** A node's rendered element. The surface finds and caches it; we only read. */
  getElement(id: NodeId): HTMLElement | null;
  overlay?: { current: OverlayHandle | null };
  /** New selection after a gesture that creates nodes (alt-drag duplicate). */
  onSelect?(ids: NodeId[]): void;
  /** Raised when a gesture starts moving and when it ends. */
  onActiveChange?(active: boolean): void;
  /**
   * After each frame's DOM writes, with every moving node's box this frame and
   * the lowest scene y any of them reaches, rotation included (`-Infinity`
   * when the frame placed none — a reorder). For anything drawn *from* the
   * shapes rather than by them — the connectors, whose route is a function of
   * two boxes that this gesture is in the middle of moving, a boolean group,
   * whose one drawing is cut from operands that have no element of their own
   * to read.
   */
  onFrame?(frames: readonly LiveFrame[], bottom: number): void;
  /**
   * With the frame's other writes, the lowest scene y the moving boxes reach:
   * the band grows to hold them. A write, never a read, so a gesture spanning
   * several diagrams writes every band before anything measures one.
   */
  grow?(bottom: number): void;
  /** Lines beyond the diagram's own shapes — a frame's box, a band's column. */
  snapExtra?(): SnapExtra;
  /**
   * Inside the bracket the gesture lands in, after its ops: anything the
   * landing implies, in the same undo entry.
   */
  onLand?(): void;
  /** Grid pitch in scene px. `0`/omitted disables grid snapping. */
  grid?: number;
  /** Snap distance in SCREEN px, so it is constant at every zoom. */
  snapThreshold?: number;
  /** Floor for a resized box. Defaults to 1 scene px. */
  minSize?: number;
}

/** A moving node's box this frame, in its parent's space — what the op will say. */
export interface LiveFrame {
  id: NodeId;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

/**
 * What one frame of a gesture came to, in the scene px of the diagram that
 * decided it. A gesture spanning several diagrams is decided once, by the
 * diagram under the pointer, and every other one lands the same decision in
 * its own px — see {@link convertDecision}.
 */
export type Decision =
  | { kind: "move"; dx: number; dy: number }
  | { kind: "resize"; dx: number; dy: number }
  | { kind: "scale"; k: number }
  | { kind: "rotate"; deg: number };

/** How far a move may take a selection, in scene px; downward is open. */
export interface Allowed {
  minDx: number;
  maxDx: number;
  minDy: number;
}

/**
 * What a session is told by whoever runs several at once. `bounds` is the box
 * every one of them acts about — the page's selection, in this diagram's px —
 * so a resize stretches, a scale pins and a rotation turns about the same
 * place in each. `sole` says whether the page holds exactly one shape.
 */
export interface SessionOverrides {
  bounds?: Rect;
  sole?: boolean;
  /** Decided with others: a resize is refused whole rather than clamped per edge. */
  lockstep?: boolean;
  /** Other diagrams' shapes, in this one's px — the decider's alone. */
  foreign?: readonly SnapLine[];
}

export interface TransformGestureApi {
  /** Pointerdown on a selected node. */
  startMove(event: PointerLike): void;
  /** Pointerdown on one of the overlay's eight resize handles. */
  startResize(event: PointerLike, handle: Handle): void;
  /** The same eight handles under the scale tool: one factor for everything. */
  startScale(event: PointerLike, handle: Handle): void;
  /** Pointerdown in one of the four rotation zones outside the corners. */
  startRotate(event: PointerLike): void;
  /** Pointerdown on one of the four corner-radius handles. */
  startRadius(event: PointerLike, corner: Handle): void;
  /** True once a gesture has passed the movement threshold. */
  isActive(): boolean;
  /**
   * True while an alt-drag previews a duplicate: the elements on the move are
   * the copy-to-be, and the nodes they were drawn for stay where they are.
   */
  duplicating(): boolean;
  /** Abandon the gesture and put the DOM back. */
  cancel(): void;
}

/** Satisfied by both a DOM `PointerEvent` and React's synthetic one. */
export type PointerLike = {
  clientX: number;
  clientY: number;
  pointerId: number;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  preventDefault(): void;
};

/** Screen px of travel before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD = 3;

/** Shift-rotate quantum, Figma's. Unshifted, rotation still lands on a degree. */
const ROTATE_STEP = 15;

/** Unshifted, the cardinal angles still pull the shape onto them from this close. */
const CARDINAL_STEP = 45;
const CARDINAL_PULL = 3;

/** Two presses this close in time and place are a double-click. */
const DOUBLE_MS = 400;
const DOUBLE_SLOP = 4;

/** How coarsely the rotation cursor is drawn, and the strings drawn so far. */
const CURSOR_STEP = 15;
const CURSORS = new Map<number, string>();

/** Radius handles, and the longhands behind the shorthand, in the same order. */
const RADIUS_CORNERS: readonly Handle[] = ["nw", "ne", "se", "sw"];
const RADIUS_PROPS = [
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
];

const NO_GUIDES: readonly SnapGuide[] = [];

/** Snap options for the two gestures that pass them, hoisted: `snap` runs once
 *  a frame and a fresh literal per call is garbage on the hottest path. */
const WITH_SPACING = { spacing: true } as const;
const RESIZE_DRIVES: Record<Handle, { drives: { x: boolean; y: boolean } }> =
  Object.fromEntries(
    HANDLES.map((h) => [
      h,
      { drives: { x: h !== "n" && h !== "s", y: h !== "e" && h !== "w" } },
    ]),
  ) as Record<Handle, { drives: { x: boolean; y: boolean } }>;
const ORIGIN: Point = { x: 0, y: 0 };

// ---------------------------------------------------------------------------
// Session state — every per-frame value lives here, never in React
// ---------------------------------------------------------------------------

interface Mods {
  shift: boolean;
  alt: boolean;
  /** ⌘/Ctrl: pass the pointer through untouched by snapping. */
  free: boolean;
}

/**
 * The edges a selection is held inside: the band's, or — for content that
 * already reached past one — wherever it began, so nothing is yanked back into
 * the band on the first frame and nothing goes further out. Downward is open:
 * the band grows.
 */
interface Fence {
  left: number;
  right: number;
  top: number;
}

function fenceFor(band: BandRange | null, box: Rect): Fence | null {
  if (!band) return null;
  return {
    left: Math.min(band.minX, box.x),
    right: Math.max(band.maxX, box.x + box.w),
    top: Math.min(0, box.y),
  };
}

/** Below this, two coordinates are the same place. */
const FENCE_EPS = 1e-6;

/**
 * How far a box may move inside a band: to its edges and no higher than its
 * top, or — for a box that already reached past one — no further out than it
 * began, so nothing jumps on the first frame.
 */
export function moveAllowed(band: BandRange | null, reach: Rect): Allowed | null {
  const fence = fenceFor(band, reach);
  if (!fence) return null;
  return {
    minDx: fence.left - reach.x,
    maxDx: fence.right - (reach.x + reach.w),
    minDy: fence.top - reach.y,
  };
}

/** Room that suits both; `null` is no fence at all. Each holds zero, so the result does. */
export function intersectAllowed(a: Allowed | null, b: Allowed | null): Allowed | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minDx: Math.max(a.minDx, b.minDx),
    maxDx: Math.min(a.maxDx, b.maxDx),
    minDy: Math.max(a.minDy, b.minDy),
  };
}

/** `a` measured in another diagram's px, `ratio` of theirs to one of these. */
export function scaleAllowed(a: Allowed | null, ratio: number): Allowed | null {
  if (!a || ratio === 1) return a;
  return { minDx: a.minDx * ratio, maxDx: a.maxDx * ratio, minDy: a.minDy * ratio };
}

/**
 * A decision made in one diagram's px, for another's: lengths go through the
 * screen, where the two agree (`from` and `to` are each one's screen px per
 * scene px); a factor and an angle mean the same everywhere.
 */
export function convertDecision(decision: Decision, from: number, to: number): Decision {
  const ratio = from / to;
  if (ratio === 1) return decision;
  switch (decision.kind) {
    case "move":
    case "resize":
      return { kind: decision.kind, dx: decision.dx * ratio, dy: decision.dy * ratio };
    default:
      return decision;
  }
}

const IDENTITY: Record<GestureMode, Decision> = {
  move: { kind: "move", dx: 0, dy: 0 },
  reorder: { kind: "move", dx: 0, dy: 0 },
  resize: { kind: "resize", dx: 0, dy: 0 },
  scale: { kind: "scale", k: 1 },
  rotate: { kind: "rotate", deg: 0 },
};

/** A node as it was when the gesture began, plus the styles to restore. */
interface NodeStart {
  id: NodeId;
  /** The laid-out box, in the node's parent space. */
  local: Rect;
  rot: number;
  /** Inside an auto-layout group: the browser, not `x`/`y`, places this one. */
  flow: boolean;
  /** Rotation contributed by ancestor groups; constant during the gesture. */
  ancestorRot: number;
  scene: Rect;
  sceneRot: number;
  el: HTMLElement | null;
  transform: string;
  width: string;
  height: string;
  /** Set only for a shape whose geometry a stretch cannot draw; see
   *  {@link shapeWriter}. */
  shape: ShapeWriter | null;
}

/** One node's box this frame, in both spaces. Mutated in place, never allocated. */
interface Frame {
  id: NodeId;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  srot: number;
}

interface ReorderSibling {
  node: SceneNode;
  el: HTMLElement | null;
  transform: string;
}

/**
 * Dragging a child of an auto-layout group does not move it — the browser owns
 * its position — so the gesture reorders it instead, previewing the new order
 * by asking the layout engine where everything would land.
 */
interface ReorderState {
  parent: GroupNode;
  moving: SceneNode[];
  /** Non-dragged children in *visual* order, which `-reverse` inverts. */
  others: ReorderSibling[];
  reversed: boolean;
  axis: "x" | "y" | "grid";
  startRects: Map<NodeId, Rect>;
  offsets: Map<NodeId, Point>;
  /** The parent's box in scene space, for putting the pointer in its space. */
  box: RotatedRect;
  startIndex: number;
  index: number;
  dirty: boolean;
}

interface Session {
  mode: GestureMode;
  /** The only shape the gesture moves on the whole page: its own axes, its own angle. */
  sole: boolean;
  lockstep: boolean;
  pointerId: number;
  handle: Handle | null;
  scene: Scene;
  /** Scene-space pointer at pointerdown. */
  origin: Point;
  startClient: Point;
  client: Point;
  mods: Mods;
  starts: NodeStart[];
  frames: Frame[];
  scratch: RotatedRect[];
  bounds: Rect;
  /** How far the selection may go this gesture, or `null` outside a band. */
  fence: Fence | null;
  /** The selection's box at the start, rotation included — what the fence holds. */
  reach: Rect;
  /** A move's reach inside the fence — narrowed to every diagram's when decided for several. */
  allowed: Allowed | null;
  /** The last decision that stayed inside the fence, for a resize or a rotation to fall back on. */
  accepted: Decision;
  centre: Point;
  startAngle: number;
  /** Accumulated rotation, unwrapped so a full turn keeps counting. */
  turn: number;
  /** Scale only: this frame's factor, and the scene point it is taken about. */
  k: number;
  anchor: Point;
  targets: SnapTarget[];
  targetsX: SnapTarget[];
  targetsY: SnapTarget[];
  snapper: Snapper;
  reorder: ReorderState | null;
  /** Any node in the gesture is placed by an auto-layout parent. */
  flow: boolean;
  active: boolean;
  ghosts: HTMLElement[];
  raf: number;
  detach: () => void;
}

/**
 * The last press on a resettable handle. Pointer events carry no dependable
 * click count, and a `dblclick` listener would arrive after the drag it is
 * meant to replace, so the pair is recognised here from time and distance.
 */
export interface Press {
  key: string;
  time: number;
  x: number;
  y: number;
}

export function isDoubleClick(press: Press, key: string, event: PointerLike): boolean {
  const now = performance.now();
  const again =
    press.key === key &&
    now - press.time < DOUBLE_MS &&
    Math.abs(event.clientX - press.x) < DOUBLE_SLOP &&
    Math.abs(event.clientY - press.y) < DOUBLE_SLOP;
  // Blanking the key stops a third press from resetting all over again.
  press.key = again ? "" : key;
  press.time = now;
  press.x = event.clientX;
  press.y = event.clientY;
  return again;
}

/** What a held pointer reports to whoever is driving a gesture with it. */
export interface PointerDrive {
  move(event: PointerEvent): void;
  /** Any key but Escape, down or up: a modifier may have changed. */
  key(event: KeyboardEvent): void;
  /** Released (with the event) or cancelled — Escape, or the pointer lost. */
  end(cancelled: boolean, event?: PointerEvent): void;
}

/**
 * One pointer, followed on the window until it lets go. Returns the detach,
 * which `end` does not call for you — a driver tearing down several sessions
 * wants to choose when its listeners go.
 */
export function drivePointer(pointerId: number, drive: PointerDrive): () => void {
  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) drive.move(ev);
  };
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) drive.end(false, ev);
  };
  const onKey = (ev: KeyboardEvent) => {
    // Ahead of every keymap: the Escape that cancels a gesture is spent here.
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      drive.end(true);
      return;
    }
    drive.key(ev);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  return () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
  };
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export function useTransformGesture(
  options: TransformGestureOptions,
): TransformGestureApi {
  const optionsRef = useRef(options);
  // Latest-callback ref, updated in an effect and never during render.
  useEffect(() => {
    optionsRef.current = options;
  });

  const sessionRef = useRef<Session | null>(null);
  const pressRef = useRef<Press>({ key: "", time: 0, x: 0, y: 0 });

  const start = useCallback(
    (event: PointerLike, mode: GestureMode, handle: Handle | null) => {
      const o = optionsRef.current;
      if (sessionRef.current) return;
      const session = createGestureSession(o, event, mode, handle);
      if (!session) return;
      event.preventDefault();
      sessionRef.current = session;

      session.detach = drivePointer(session.pointerId, {
        move: (ev) => {
          session.client.x = ev.clientX;
          session.client.y = ev.clientY;
          readGestureMods(session, ev);
          schedule(session, optionsRef.current);
        },
        key: (ev) => {
          readGestureMods(session, ev);
          schedule(session, optionsRef.current);
        },
        end: (cancelled, ev) => {
          if (sessionRef.current !== session) return;
          if (ev) readGestureMods(session, ev);
          sessionRef.current = null;
          finish(session, optionsRef.current, cancelled);
        },
      });
    },
    [],
  );

  useEffect(
    () => () => {
      const session = sessionRef.current;
      if (!session) return;
      sessionRef.current = null;
      finish(session, optionsRef.current, true);
    },
    [],
  );

  return useMemo<TransformGestureApi>(
    () => ({
      startMove: (event) => start(event, "move", null),
      startResize: (event, handle) => start(event, "resize", handle),
      startScale: (event, handle) => start(event, "scale", handle),
      startRotate: (event) => {
        if (!isDoubleClick(pressRef.current, "rotate", event)) {
          start(event, "rotate", null);
          return;
        }
        event.preventDefault();
        resetGestureRotation(optionsRef.current);
      },
      startRadius: (event, corner) =>
        isDoubleClick(pressRef.current, `radius:${corner}`, event)
          ? resetRadius(optionsRef.current, event, corner)
          : startRadiusDrag(optionsRef.current, event, corner),
      isActive: () => sessionRef.current?.active ?? false,
      duplicating: () => {
        const session = sessionRef.current;
        return !!session?.active && session.mode === "move" && session.mods.alt;
      },
      cancel: () => {
        const session = sessionRef.current;
        if (!session) return;
        sessionRef.current = null;
        finish(session, optionsRef.current, true);
      },
    }),
    [start],
  );
}

/**
 * Figma's rotate affordance: a short arc with an arrowhead at either end, drawn
 * so it wraps the corner it belongs to and turned with it — at 45° the cursor
 * is at 45°. `outward` is the corner's direction in screen space, clockwise
 * from +x; the glyph is authored for a bottom-right corner and rotated onto the
 * other three.
 *
 * Quantised and memoised, because a data URI is expensive and a cursor drawn to
 * the nearest 15° is indistinguishable from one drawn to the nearest degree.
 */
export function rotationCursor(outward: number): string {
  const angle =
    (Math.round(normalizeAngle(outward - 45) / CURSOR_STEP) * CURSOR_STEP) % 360;
  const cached = CURSORS.get(angle);
  if (cached) return cached;

  // An arc of radius 10 about the corner at (5,5), spanning 14°–76°, with a
  // tangential head at each end. The hotspot sits just inside its midpoint.
  const glyph =
    '<path d="M14.7 7.42A10 10 0 0 1 7.42 14.7" fill="none"/>' +
    '<path d="M15.67 3.54 17.42 8.1 11.98 6.74Z"/>' +
    '<path d="M3.54 15.67 6.74 11.98 8.1 17.42Z"/>';
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">' +
    `<g transform="rotate(${angle} 12 12) translate(2 2)" stroke-linejoin="round" stroke-linecap="round">` +
    `<g fill="#fff" stroke="#fff" stroke-width="3.2">${glyph}</g>` +
    `<g fill="#1c1c1c" stroke="#1c1c1c" stroke-width="1.3">${glyph}</g>` +
    "</g></svg>";
  const cursor = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 12 12, crosshair`;
  CURSORS.set(angle, cursor);
  return cursor;
}

// ---------------------------------------------------------------------------
// Corner radius
// ---------------------------------------------------------------------------

/** ⌘/Ctrl on a radius handle: edit the grabbed corner alone. */
function splitsCorners(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.metaKey || event.ctrlKey;
}

/** The one node a radius gesture can act on: selected alone, unlocked, rendered. */
function soleTarget(
  o: TransformGestureOptions,
): { scene: Scene; node: SceneNode; el: HTMLElement } | null {
  const scene = laidOutScene(o.store.getScene());
  const ids = topMostIds(scene, o.getSelection());
  if (ids.length !== 1) return null;
  const node = findNode(scene, ids[0]);
  const el = o.getElement(ids[0]);
  return node && !node.locked && el ? { scene, node, el } : null;
}

/**
 * The four rendered radii, whether they still agree — Figma lets one handle
 * speak for all four until the corners disagree — and the vertical half of a
 * `/`-form shorthand, which nothing here edits.
 */
function readRadii(node: SceneNode, el: HTMLElement) {
  const css = getComputedStyle(el);
  const values = [
    css.borderTopLeftRadius,
    css.borderTopRightRadius,
    css.borderBottomRightRadius,
    css.borderBottomLeftRadius,
  ].map((value) => Number.parseFloat(value) || 0);
  const authored = node.style["border-radius"] ?? "";
  const slash = authored.indexOf("/");
  return {
    values,
    together: values.every((value) => value === values[0]),
    vertical: slash < 0 ? null : authored.slice(slash + 1).trim(),
  };
}

function commitRadius(
  o: TransformGestureOptions,
  node: SceneNode,
  values: readonly number[],
  vertical: string | null,
) {
  o.store.begin();
  o.store.dispatch([
    {
      type: "setStyle",
      ids: [node.id],
      decls: { "border-radius": radiusCss(values, vertical) },
    },
  ]);
  o.store.commit();
}

/**
 * Double-clicking a radius handle zeroes it, moving exactly what a drag from
 * that same handle would have moved: all four while they still agree, or the
 * grabbed corner alone once they differ — or with ⌘ held.
 */
function resetRadius(
  o: TransformGestureOptions,
  event: PointerLike,
  corner: Handle,
) {
  const index = RADIUS_CORNERS.indexOf(corner);
  const target = soleTarget(o);
  if (index < 0 || !target) return;
  const { values, together, vertical } = readRadii(target.node, target.el);
  const next =
    together && !splitsCorners(event)
      ? [0, 0, 0, 0]
      : values.map((value, i) => (i === index ? 0 : value));
  if (next.every((value, i) => value === values[i])) return;
  event.preventDefault();
  o.overlay?.current?.radius(next);
  commitRadius(o, target.node, next, vertical);
}

/**
 * Dragging a corner-radius handle. Small enough to own its own pointer loop:
 * nothing moves, nothing snaps, and the only thing written per frame is the
 * element's `border-radius` — the very declaration the style panel writes, so
 * the two edit one value rather than two.
 */
function startRadiusDrag(
  o: TransformGestureOptions,
  event: PointerLike,
  corner: Handle,
) {
  const index = RADIUS_CORNERS.indexOf(corner);
  const target = soleTarget(o);
  if (index < 0 || !target) return;
  const { scene, node, el } = target;

  const box: RotatedRect = {
    ...absoluteRect(scene, node.id),
    rot: absoluteRotation(scene, node.id),
  };

  const { values: start, together, vertical } = readRadii(node, el);
  const limit = Math.min(box.w, box.h) / 2;
  const restore = el.style.borderRadius;

  event.preventDefault();
  const client = { x: event.clientX, y: event.clientY };
  // ⌘ is how a user gets from uniform corners to asymmetric ones on purpose,
  // and it is live: press or release it mid-drag and the next frame obeys.
  let solo = splitsCorners(event);
  let values = start;
  let raf = 0;

  const paint = () => {
    raf = 0;
    const local = toLocal(o.clientToScene(client), box);
    const dx = index === 1 || index === 2 ? box.w - local.x : local.x;
    const dy = index >= 2 ? box.h - local.y : local.y;
    const next = Math.round(Math.min(Math.max((dx + dy) / 2, 0), limit));
    values =
      together && !solo
        ? [next, next, next, next]
        : start.map((value, i) => (i === index ? next : value));
    el.style.borderRadius = radiusCss(values, vertical) ?? "0";
    o.overlay?.current?.radius(values);
  };

  const end = (cancelled: boolean) => {
    detach();
    if (raf) {
      // Same race as the transform gesture's `finish`: a pointerup that beats
      // the scheduled frame must not drop it, or the commit below reads the
      // second-to-last position instead of where the pointer actually is.
      cancelAnimationFrame(raf);
      raf = 0;
      if (!cancelled) paint();
    }
    // Put the inline write back: `border-radius` may not be among the style
    // props React renders, in which case nothing else would ever clear it.
    el.style.borderRadius = restore;
    if (cancelled || values.every((value, i) => value === start[i])) {
      o.overlay?.current?.radius(start);
      return;
    }
    commitRadius(o, node, values, vertical);
  };

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== event.pointerId) return;
    client.x = ev.clientX;
    client.y = ev.clientY;
    solo = splitsCorners(ev);
    if (!raf) raf = requestAnimationFrame(paint);
  };
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId === event.pointerId) end(false);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      end(true);
      return;
    }
    if (splitsCorners(ev) === solo) return;
    solo = !solo;
    if (!raf) raf = requestAnimationFrame(paint);
  };
  const detach = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
}

/** The shorthand the style panel writes, from four px radii. */
function radiusCss(
  values: readonly number[],
  vertical: string | null,
): string | undefined {
  if (!vertical && values.every((value) => value === 0)) return undefined;
  const layer: Record<string, string> = {};
  RADIUS_PROPS.forEach((prop, i) => (layer[prop] = `${values[i]}px`));
  const css = serializeComposite("border-radius", { values: layer });
  return vertical ? `${css} / ${vertical}` : css;
}

// ---------------------------------------------------------------------------
// Starting a gesture
// ---------------------------------------------------------------------------

/** One diagram's share of a gesture, or `null` when it has nothing it may move. */
export type GestureSession = Session;

export function createGestureSession(
  o: TransformGestureOptions,
  event: PointerLike,
  mode: GestureMode,
  handle: Handle | null,
  overrides: SessionOverrides = {},
): Session | null {
  // Laid out, so a child of an auto-layout group starts the gesture from where
  // it is on screen rather than from an `x`/`y` nothing has honoured since it
  // was put in the group.
  const scene = laidOutScene(o.store.getScene());
  const ids = topMostIds(scene, o.getSelection());
  if (!ids.length) return null;

  const origin = o.clientToScene({ x: event.clientX, y: event.clientY });

  const starts: NodeStart[] = [];
  const nodes: SceneNode[] = [];
  for (const id of ids) {
    const node = findNode(scene, id);
    if (!node || node.locked) continue;
    const el = o.getElement(id);
    const sceneRot = absoluteRotation(scene, id);
    const parent = findParent(scene, id);
    nodes.push(node);
    starts.push({
      id,
      local: { x: node.x, y: node.y, w: node.w, h: node.h },
      rot: node.rot,
      flow: !!parent && isAutoLayout(parent),
      ancestorRot: sceneRot - node.rot,
      scene: absoluteRect(scene, id),
      sceneRot,
      el,
      transform: el?.style.transform ?? "",
      width: el?.style.width ?? "",
      height: el?.style.height ?? "",
      shape: el && mode === "resize" ? shapeWriter(node, el) : null,
    });
  }
  if (!starts.length) return null;

  const scratch: RotatedRect[] = starts.map((s) => ({ ...s.scene, rot: s.sceneRot }));
  const bounds = overrides.bounds ?? selectionBounds(scratch);
  const reach = unionBounds(scratch);
  const targets = boxTargets(bounds);
  const band = o.band?.() ?? null;
  const extra = o.snapExtra?.() ?? {};

  const session: Session = {
    mode,
    sole: overrides.sole ?? starts.length === 1,
    lockstep: overrides.lockstep ?? false,
    pointerId: event.pointerId,
    handle,
    scene,
    origin,
    startClient: { x: event.clientX, y: event.clientY },
    client: { x: event.clientX, y: event.clientY },
    mods: {
      shift: event.shiftKey,
      alt: event.altKey,
      free: event.metaKey || event.ctrlKey,
    },
    starts,
    frames: starts.map((s) => ({
      id: s.id,
      x: s.local.x,
      y: s.local.y,
      w: s.local.w,
      h: s.local.h,
      rot: s.rot,
      sx: s.scene.x,
      sy: s.scene.y,
      sw: s.scene.w,
      sh: s.scene.h,
      srot: s.sceneRot,
    })),
    scratch,
    bounds,
    fence: fenceFor(band, reach),
    reach,
    allowed: moveAllowed(band, reach),
    accepted: IDENTITY[mode],
    centre: { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
    startAngle: angleOf(
      { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
      origin,
    ),
    turn: 0,
    k: 1,
    anchor: ORIGIN,
    targets,
    targetsX: targets.filter((t) => t.axis === "x"),
    targetsY: targets.filter((t) => t.axis === "y"),
    snapper: createSnapper(
      collectSnapScope(scene, new Set(ids), { ...extra, foreign: overrides.foreign ?? extra.foreign }),
      {
        threshold: o.snapThreshold,
        grid: o.grid,
        moving: bounds,
      },
    ),
    reorder: null,
    flow: starts.some((s) => s.flow),
    active: false,
    ghosts: [],
    raf: 0,
    detach: () => {},
  };

  if (mode === "move") {
    session.reorder = createReorder(scene, nodes, o);
    if (session.reorder) session.mode = "reorder";
  }
  return session;
}

/**
 * A drag inside an auto-layout group is a reorder, not a move — the group's CSS
 * decides where its children sit, so there is nowhere for a free drag to put
 * one. Returns `null` when the selection is not a block of siblings inside one
 * auto-layout group, which is every other case.
 */
function createReorder(
  scene: Scene,
  nodes: SceneNode[],
  o: TransformGestureOptions,
): ReorderState | null {
  const parent = findParent(scene, nodes[0].id);
  if (!parent || !isAutoLayout(parent)) return null;
  if (nodes.some((node) => findParent(scene, node.id) !== parent)) return null;

  const layout = layoutOf(parent);
  const axis =
    layout.mode === "grid" ? "grid" : layout.flexDirection.startsWith("row") ? "x" : "y";
  const startRects = resolveLayout(parent);
  const movingIds = new Set(nodes.map((node) => node.id));
  const others: ReorderSibling[] = parent.children
    .filter((child) => !movingIds.has(child.id))
    .map((node) => {
      const el = o.getElement(node.id);
      return { node, el, transform: el?.style.transform ?? "" };
    })
    .sort((a, b) => {
      const ra = startRects.get(a.node.id);
      const rb = startRects.get(b.node.id);
      if (!ra || !rb) return 0;
      if (axis === "x") return ra.x - rb.x;
      if (axis === "y") return ra.y - rb.y;
      return ra.y - rb.y || ra.x - rb.x;
    });

  const block = startRects.get(nodes[0].id);
  const index = others.filter((other) => {
    const rect = startRects.get(other.node.id);
    if (!rect || !block) return false;
    if (axis === "x") return rect.x < block.x;
    if (axis === "y") return rect.y < block.y;
    return rect.y < block.y || (rect.y === block.y && rect.x < block.x);
  }).length;

  return {
    parent,
    moving: nodes,
    others,
    reversed: layout.flexDirection.endsWith("-reverse"),
    axis,
    startRects,
    offsets: new Map(),
    box: { ...absoluteRect(scene, parent.id), rot: absoluteRotation(scene, parent.id) },
    startIndex: index,
    index,
    dirty: false,
  };
}

/** Selected ids with no selected ancestor: a child moves with its group, once. */
function topMostIds(scene: Scene, ids: readonly NodeId[]): NodeId[] {
  const wanted = new Set(ids);
  const out: NodeId[] = [];
  walk(scene.nodes, (node) => {
    if (!wanted.has(node.id)) return;
    out.push(node.id);
    return false;
  });
  return out;
}

// ---------------------------------------------------------------------------
// The frame loop — exactly one visual update per frame
// ---------------------------------------------------------------------------

function schedule(session: Session, o: TransformGestureOptions) {
  if (session.raf) return;
  session.raf = requestAnimationFrame(() => {
    session.raf = 0;
    runFrame(session, o);
  });
}

export function readGestureMods(session: Session, event: PointerLike | KeyboardEvent) {
  session.mods.shift = event.shiftKey;
  session.mods.alt = event.altKey;
  session.mods.free = event.metaKey || event.ctrlKey;
}

/** Whether the pointer has travelled far enough from the press to be a drag. */
export function pastThreshold(start: Point, client: Point): boolean {
  return (
    Math.abs(client.x - start.x) >= DRAG_THRESHOLD ||
    Math.abs(client.y - start.y) >= DRAG_THRESHOLD
  );
}

/**
 * The press became a drag. `announce` tells the overlay what its readout
 * should say — the one overlay a gesture spanning several diagrams draws in.
 */
export function activateGesture(session: Session, o: TransformGestureOptions, announce = true) {
  session.active = true;
  if (announce) o.overlay?.current?.mode(READOUT[session.mode]);
  o.onActiveChange?.(true);
}

function runFrame(session: Session, o: TransformGestureOptions) {
  if (!session.active) {
    if (!pastThreshold(session.startClient, session.client)) return;
    activateGesture(session, o);
  }

  const point = o.clientToScene(session.client);

  if (session.mode === "reorder") {
    applyReorder(session, point);
    writeOverlay(session, o, NO_GUIDES);
    o.onFrame?.(NO_FRAMES, -Infinity);
    return;
  }

  const { decision, guides } = decideGesture(session, o, point);
  const min = o.minSize ?? 1;
  let shown = guides;
  if (applyDecision(session, decision, min)) {
    session.accepted = decision;
  } else {
    applyDecision(session, session.accepted, min);
    shown = NO_GUIDES;
  }
  writeGesture(session, o, shown, true);
  // After the writes: whatever reads the shapes' live boxes must read them as
  // they are this frame, not as they were last one.
  o.onFrame?.(session.frames, liveBottomOf(session.frames));
}

const NO_FRAMES: readonly LiveFrame[] = [];

/**
 * What the pointer at `point` (scene px) asks of this frame — snapped, and
 * held inside the band wherever that is exact.
 */
export function decideGesture(
  session: Session,
  o: TransformGestureOptions,
  point: Point,
): { decision: Decision; guides: readonly SnapGuide[] } {
  const scale = o.screenScale();
  switch (session.mode) {
    case "resize":
      return decideResize(session, point, scale);
    case "scale":
      return { decision: decideScale(session, point, o.minSize ?? 1), guides: NO_GUIDES };
    case "rotate":
      return { decision: decideRotate(session, point), guides: NO_GUIDES };
    default:
      return decideMove(session, point, scale);
  }
}

/**
 * Every frame placed as `decision` says. False when a resize or a rotation
 * would take a box past the fence — the caller then places the last one that
 * did not, for this diagram and every other one moving with it.
 */
export function applyDecision(session: Session, decision: Decision, minSize: number): boolean {
  switch (decision.kind) {
    case "move":
      placeMove(session, decision.dx, decision.dy);
      return true;
    case "resize":
      if (!session.handle) return true;
      placeResize(
        session,
        session.handle,
        { x: decision.dx, y: decision.dy },
        session.mods.shift,
        session.mods.alt,
        minSize,
      );
      return !escapes(session);
    case "scale":
      placeScale(session, decision.k);
      return true;
    case "rotate":
      placeRotate(session, decision.deg);
      return !escapes(session);
  }
}

/** The frame's writes, in one pass: the shapes, the overlay if it is this session's, the band. */
export function writeGesture(
  session: Session,
  o: TransformGestureOptions,
  guides: readonly SnapGuide[],
  overlay: boolean,
) {
  // A scale previews as a transform, which no layout can see — so an
  // auto-layout parent has nothing to reflow from until the gesture lands, and
  // asking it where things would go would only move the overlay off the pixels.
  if (session.flow && session.mode !== "scale") relayout(session);
  syncGhosts(session);
  if (session.mode === "scale") writeScale(session);
  else writeFrames(session, session.mode === "resize");
  if (overlay) writeOverlay(session, o, guides);
  o.grow?.(liveBottomOf(session.frames));
}

/** A frame's scene box as drawn, turned by its rotation. */
function drawnBounds(f: Frame): Rect {
  return nodeBounds({ x: f.sx, y: f.sy, w: f.sw, h: f.sh, rot: f.srot });
}

/** The lowest scene y the boxes reach, each turned by its rotation; `-Infinity` for none. */
export function liveBottomOf(
  frames: readonly { sx: number; sy: number; sw: number; sh: number; srot: number }[],
): number {
  let bottom = -Infinity;
  for (const f of frames) {
    const b = nodeBounds({ x: f.sx, y: f.sy, w: f.sw, h: f.sh, rot: f.srot });
    bottom = Math.max(bottom, b.y + b.h);
  }
  return bottom;
}

/** Every box this frame, in scene px with its rotation — what a union overlay is drawn from. */
export function liveBoxes(session: Session): readonly RotatedRect[] {
  for (let i = 0; i < session.frames.length; i++) {
    const frame = session.frames[i];
    const box = session.scratch[i];
    box.x = frame.sx;
    box.y = frame.sy;
    box.w = frame.sw;
    box.h = frame.sh;
    box.rot = frame.srot;
  }
  return session.scratch;
}

/** Whether this frame's boxes have gone past the fence. */
function escapes(session: Session): boolean {
  const fence = session.fence;
  if (!fence) return false;
  for (const f of session.frames) {
    const b = drawnBounds(f);
    if (
      b.x < fence.left - FENCE_EPS ||
      b.x + b.w > fence.right + FENCE_EPS ||
      b.y < fence.top - FENCE_EPS
    ) {
      return true;
    }
  }
  return false;
}

function decideMove(
  session: Session,
  point: Point,
  scale: number,
): { decision: Decision; guides: readonly SnapGuide[] } {
  let dx = point.x - session.origin.x;
  let dy = point.y - session.origin.y;

  // Shift axis-locks, and the locked axis must not be snapped back to life.
  let targets = session.targets;
  if (session.mods.shift) {
    if (Math.abs(dx) >= Math.abs(dy)) {
      dy = 0;
      targets = session.targetsX;
    } else {
      dx = 0;
      targets = session.targetsY;
    }
  }

  const snapped = session.snapper.snap(
    targets,
    { x: dx, y: dy },
    scale,
    !session.mods.free,
    // The one gesture that carries a rigid box, so the one that can be offered
    // an equal gap on either side of it.
    WITH_SPACING,
  );
  dx = snapped.dx;
  dy = snapped.dy;

  const allowed = session.allowed;
  if (allowed) {
    dx = Math.min(allowed.maxDx, Math.max(allowed.minDx, dx));
    dy = Math.max(allowed.minDy, dy);
  }
  return { decision: { kind: "move", dx, dy }, guides: snapped.guides };
}

function placeMove(session: Session, dx: number, dy: number) {
  for (let i = 0; i < session.starts.length; i++) {
    const start = session.starts[i];
    const frame = session.frames[i];
    const local = rotatePoint({ x: dx, y: dy }, -start.ancestorRot);
    frame.x = start.local.x + local.x;
    frame.y = start.local.y + local.y;
    frame.sx = start.scene.x + dx;
    frame.sy = start.scene.y + dy;
  }
}

function decideResize(
  session: Session,
  point: Point,
  scale: number,
): { decision: Decision; guides: readonly SnapGuide[] } {
  const handle = session.handle;
  let delta = { x: point.x - session.origin.x, y: point.y - session.origin.y };
  if (!handle) return { decision: { kind: "resize", dx: 0, dy: 0 }, guides: NO_GUIDES };

  const aspect = session.mods.shift;
  const fromCentre = session.mods.alt;
  let guides: readonly SnapGuide[] = NO_GUIDES;

  // A rotated node resizes along its own axes and an aspect lock owns the
  // second axis outright; in both cases a snapped edge would fight the drag.
  const snappable =
    !aspect && !session.mods.free && !(session.sole && session.starts[0].sceneRot !== 0);
  if (snappable) {
    const snapped = session.snapper.snap(
      resizeTargets(session.bounds, handle, fromCentre),
      delta,
      scale,
      true,
      // An edge handle drives one axis. Saying so keeps its guide as long as
      // what actually moved, rather than as long as the pointer wandered.
      RESIZE_DRIVES[handle],
    );
    delta = { x: snapped.dx, y: snapped.dy };
    guides = snapped.guides;
  } else {
    session.snapper.reset();
  }

  if (session.fence && !session.lockstep) {
    delta = fenceResize(session, handle, delta, aspect, fromCentre);
  }
  return { decision: { kind: "resize", dx: delta.x, dy: delta.y }, guides };
}

/**
 * The drag with the edges it moves stopped at the fence. Exact wherever an
 * edge follows the pointer one for one — an unrotated box, no aspect lock
 * tying one axis to the other; anything else is left to the refusal in
 * {@link applyDecision}. The bottom is never stopped: the band grows.
 */
function fenceResize(
  session: Session,
  handle: Handle,
  delta: Point,
  aspect: boolean,
  fromCentre: boolean,
): Point {
  const fence = session.fence;
  const single = session.sole;
  if (!fence || aspect || (single && session.starts[0].sceneRot !== 0)) return delta;
  const b = single ? session.starts[0].scene : session.bounds;
  const { hx, hy } = HANDLE_EDGES[handle];
  let { x, y } = delta;
  if (hx < 0) {
    x = Math.max(x, fence.left - b.x);
    if (fromCentre) x = Math.max(x, b.x + b.w - fence.right);
  } else if (hx > 0) {
    x = Math.min(x, fence.right - (b.x + b.w));
    if (fromCentre) x = Math.min(x, b.x - fence.left);
  }
  if (hy < 0) y = Math.max(y, fence.top - b.y);
  else if (hy > 0 && fromCentre) y = Math.min(y, b.y - fence.top);
  return { x, y };
}

/** Every frame of a resize, from the drag in scene px. */
function placeResize(
  session: Session,
  handle: Handle,
  delta: Point,
  aspect: boolean,
  fromCentre: boolean,
  minSize: number,
): void {
  if (session.sole && session.starts.length === 1) {
    const start = session.starts[0];
    const box = resizeRect(
      start.local,
      handle,
      rotatePoint(delta, -start.ancestorRot),
      { rot: start.rot, aspect, fromCentre },
    );
    box.w = Math.max(minSize, box.w);
    box.h = Math.max(minSize, box.h);
    setFromLocal(session.frames[0], start, box, start.rot);
    return;
  }

  const next = resizeRect(session.bounds, handle, delta, {
    rot: 0,
    aspect,
    fromCentre,
  });
  const sx = session.bounds.w === 0 ? 1 : next.w / session.bounds.w;
  const sy = session.bounds.h === 0 ? 1 : next.h / session.bounds.h;
  for (let i = 0; i < session.starts.length; i++) {
    const start = session.starts[i];
    const w = Math.max(minSize, start.scene.w * sx);
    const h = Math.max(minSize, start.scene.h * sy);
    const cx = next.x + (start.scene.x + start.scene.w / 2 - session.bounds.x) * sx;
    const cy = next.y + (start.scene.y + start.scene.h / 2 - session.bounds.y) * sy;
    setFromScene(
      session.frames[i],
      start,
      { x: cx - w / 2, y: cy - h / 2, w, h },
      start.sceneRot,
    );
  }
}

/**
 * The point a scale pins: the far side from the dragged handle, or with Alt
 * the centre, as a resize does.
 */
function scaleAnchor(session: Session): Point {
  const b = session.bounds;
  const { hx, hy } = HANDLE_EDGES[session.handle ?? "se"];
  const centre = session.mods.alt;
  const ax = centre ? 0.5 : hx > 0 ? 0 : hx < 0 ? 1 : 0.5;
  const ay = centre ? 0.5 : hy > 0 ? 0 : hy < 0 ? 1 : 0.5;
  return { x: b.x + ax * b.w, y: b.y + ay * b.h };
}

/**
 * One factor for the whole selection, taken from the dragged handle's distance
 * to the pinned point over what that distance was.
 *
 * Every handle scales, edges included: the tool's promise is that nothing
 * distorts, and it is the only reading a style has an answer for — a stroke has
 * one width whichever handle asked. So an edge handle reads the drag along its
 * own axis and ignores the rest, which falls out of the projection for free.
 * Alt pins the centre instead of the far side, as it does in a resize.
 */
function decideScale(session: Session, point: Point, minSize: number): Decision {
  const handle = session.handle;
  if (!handle) return IDENTITY.scale;

  const b = session.bounds;
  const { hx, hy } = HANDLE_EDGES[handle];
  const anchor = scaleAnchor(session);
  // The arm from the pinned point out to the handle, which the drag lengthens.
  const arm = {
    x: b.x + ((hx + 1) / 2) * b.w - anchor.x,
    y: b.y + ((hy + 1) / 2) * b.h - anchor.y,
  };
  const span = arm.x * arm.x + arm.y * arm.y;
  const dx = point.x - session.origin.x;
  const dy = point.y - session.origin.y;

  // Never through the anchor and out the other side: a mirrored scale would
  // need a negative stroke width to mean anything.
  const floor = minSize / Math.max(b.w, b.h, minSize);
  const k = span === 0 ? 1 : Math.max(floor, 1 + (dx * arm.x + dy * arm.y) / span);
  return { kind: "scale", k: capScale(session, k) };
}

/** `k`, no larger than keeps this session's selection inside its band. */
export function capScale(session: Session, k: number): number {
  if (!session.fence) return k;
  return Math.min(k, scaleCap(session.reach, scaleAnchor(session), session.fence));
}

function placeScale(session: Session, k: number) {
  const anchor = scaleAnchor(session);
  session.k = k;
  session.anchor = anchor;
  for (let i = 0; i < session.starts.length; i++) {
    const start = session.starts[i];
    const w = start.scene.w * k;
    const h = start.scene.h * k;
    const cx = anchor.x + (start.scene.x + start.scene.w / 2 - anchor.x) * k;
    const cy = anchor.y + (start.scene.y + start.scene.h / 2 - anchor.y) * k;
    setFromScene(
      session.frames[i],
      start,
      { x: cx - w / 2, y: cy - h / 2, w, h },
      start.sceneRot,
    );
  }
}

/**
 * The largest factor about `anchor` that keeps `box` inside the fence. A
 * uniform scale takes a rotated box's bounds with it, so the selection's own
 * bounds are all there is to check; at 1 it is inside by construction.
 */
function scaleCap(box: Rect, anchor: Point, fence: Fence): number {
  let cap = Infinity;
  if (box.x < anchor.x) cap = Math.min(cap, (anchor.x - fence.left) / (anchor.x - box.x));
  if (box.x + box.w > anchor.x) {
    cap = Math.min(cap, (fence.right - anchor.x) / (box.x + box.w - anchor.x));
  }
  if (box.y < anchor.y) cap = Math.min(cap, (anchor.y - fence.top) / (anchor.y - box.y));
  return cap;
}

/**
 * Re-derive the scene boxes of a gesture whose nodes an auto-layout group
 * places.
 *
 * Such a node's `x`/`y` are not where it is: resizing it moves it, because the
 * flow shifts around it and a hugging ancestor grows with it. So the frames are
 * put back into the model, the layout is run over that, and every box is read
 * off the result — the answer the browser is about to reach, arrived at without
 * measuring anything. Nodes their parent does *not* lay out keep the box the
 * gesture computed, since the patched `x`/`y` are exactly it.
 */
function relayout(session: Session) {
  const moved = new Map(session.frames.map((frame) => [frame.id, frame]));
  // Only the chains down to the moved nodes are rebuilt; every other subtree
  // is handed back by identity, so a frame allocates a few objects rather than
  // a copy of the diagram.
  const touched = new Set<NodeId>();
  for (const frame of session.frames) {
    for (const node of nodePath(session.scene, frame.id)) touched.add(node.id);
  }
  const patch = (nodes: SceneNode[]): SceneNode[] => {
    let changed = false;
    const out = nodes.map((node) => {
      if (!touched.has(node.id)) return node;
      const f = moved.get(node.id);
      let next: SceneNode = f
        ? { ...node, x: f.x, y: f.y, w: f.w, h: f.h, rot: f.rot }
        : node;
      if (isContainer(next)) {
        const children = patch(next.children);
        if (children !== next.children) next = { ...next, children };
      }
      if (next !== node) changed = true;
      return next;
    });
    return changed ? out : nodes;
  };

  const laid = laidOutScene(
    reflowHugs({ ...session.scene, nodes: patch(session.scene.nodes) }),
  );
  for (const frame of session.frames) {
    const rect = absoluteRect(laid, frame.id);
    frame.sx = rect.x;
    frame.sy = rect.y;
    frame.sw = rect.w;
    frame.sh = rect.h;
    frame.srot = absoluteRotation(laid, frame.id);
  }
}

function decideRotate(session: Session, point: Point): Decision {
  const angle = angleOf(session.centre, point) - session.startAngle;
  // `angleOf` wraps at 360; unwrap against the running total so a shape can be
  // spun round more than once without the rotation flipping sign.
  let turn = angle;
  while (turn - session.turn > 180) turn -= 360;
  while (turn - session.turn < -180) turn += 360;
  session.turn = turn;

  // Quantise the resulting *angle* of a lone node rather than the delta, so a
  // shape that starts crooked ends up square.
  const base = session.sole ? session.starts[0].sceneRot : 0;
  return { kind: "rotate", deg: quantizeRotation(base + turn, session.mods.shift) - base };
}

function placeRotate(session: Session, delta: number) {
  for (let i = 0; i < session.starts.length; i++) {
    const start = session.starts[i];
    const centre = rotateAround(
      { x: start.scene.x + start.scene.w / 2, y: start.scene.y + start.scene.h / 2 },
      session.centre,
      delta,
    );
    setFromScene(
      session.frames[i],
      start,
      {
        x: centre.x - start.scene.w / 2,
        y: centre.y - start.scene.h / 2,
        w: start.scene.w,
        h: start.scene.h,
      },
      start.sceneRot + delta,
    );
  }
}

/**
 * Shift lands on Figma's 15° grid. Otherwise rotation is free to the degree,
 * except near a cardinal angle — within a few degrees of a multiple of 45° the
 * shape is pulled onto it, which is what makes rotating past square feel guided
 * rather than fiddly.
 */
function quantizeRotation(angle: number, shift: boolean): number {
  if (shift) return snapAngle(angle, ROTATE_STEP);
  const cardinal = snapAngle(angle, CARDINAL_STEP);
  return Math.abs(angle - cardinal) <= CARDINAL_PULL
    ? cardinal
    : snapAngle(angle, 1);
}

/** Double-clicking a rotation zone stands the selection back up. */
export function resetGestureRotation(o: TransformGestureOptions) {
  const scene = o.store.getScene();
  const ids = topMostIds(scene, o.getSelection()).filter((id) => {
    const node = findNode(scene, id);
    return !!node && !node.locked && node.rot !== 0;
  });
  if (!ids.length) return;
  o.store.begin();
  o.store.dispatch([{ type: "rotate", ids, rot: 0 }]);
  o.store.commit();
}

function applyReorder(session: Session, point: Point) {
  const state = session.reorder;
  if (!state) return;

  const local = toLocal(point, state.box);
  const index = insertionIndex(state, local);
  if (index !== state.index) {
    state.index = index;
    state.dirty = true;
  }
  if (state.dirty) {
    state.dirty = false;
    recomputeOffsets(state);
    for (const other of state.others) {
      const offset = state.offsets.get(other.node.id);
      if (!other.el || !offset) continue;
      other.el.style.transform = offset.x === 0 && offset.y === 0
        ? other.transform
        : `translate3d(${offset.x}px, ${offset.y}px, 0) ${other.transform}`;
    }
  }

  // The dragged element is offset from wherever the browser laid it out, so the
  // translate is *relative* and composes in front of the transform it already
  // has instead of replacing it.
  const dx = point.x - session.origin.x;
  const dy = point.y - session.origin.y;
  const drag = rotatePoint({ x: dx, y: dy }, -state.box.rot);
  for (let i = 0; i < session.starts.length; i++) {
    const start = session.starts[i];
    const frame = session.frames[i];
    frame.sx = start.scene.x + dx;
    frame.sy = start.scene.y + dy;
    if (!start.el) continue;
    start.el.style.transform = `translate3d(${drag.x}px, ${drag.y}px, 0) ${start.transform}`;
  }
}

function insertionIndex(state: ReorderState, point: Point): number {
  let index = 0;
  for (const other of state.others) {
    const rect = state.startRects.get(other.node.id);
    if (!rect) continue;
    if (state.axis === "x") {
      if (rect.x + rect.w / 2 < point.x) index++;
    } else if (state.axis === "y") {
      if (rect.y + rect.h / 2 < point.y) index++;
    } else if (
      rect.y + rect.h <= point.y ||
      (rect.y <= point.y && rect.x + rect.w / 2 < point.x)
    ) {
      index++;
    }
  }
  return index;
}

/** Where every sibling would sit in the new order, straight from the layout engine. */
function recomputeOffsets(state: ReorderState) {
  const preview = resolveLayout({
    ...state.parent,
    children: reorderedChildren(state),
  });
  state.offsets.clear();
  for (const other of state.others) {
    const from = state.startRects.get(other.node.id);
    const to = preview.get(other.node.id);
    if (!from || !to) continue;
    state.offsets.set(other.node.id, { x: to.x - from.x, y: to.y - from.y });
  }
}

function reorderedChildren(state: ReorderState): SceneNode[] {
  const block = state.reversed ? [...state.moving].reverse() : state.moving;
  const before = state.others.slice(0, state.index).map((other) => other.node);
  const after = state.others.slice(state.index).map((other) => other.node);
  const visual = [...before, ...block, ...after];
  return state.reversed ? visual.reverse() : visual;
}

// ---------------------------------------------------------------------------
// Frame ⇄ space conversions
// ---------------------------------------------------------------------------

function rotatePoint(point: Point, deg: number): Point {
  return deg === 0 ? point : rotateAround(point, ORIGIN, deg);
}

/** Fill a frame from a box in the node's parent space. */
function setFromLocal(frame: Frame, start: NodeStart, box: Rect, rot: number) {
  frame.x = box.x;
  frame.y = box.y;
  frame.w = box.w;
  frame.h = box.h;
  frame.rot = rot;
  const delta = rotatePoint(
    {
      x: box.x + box.w / 2 - (start.local.x + start.local.w / 2),
      y: box.y + box.h / 2 - (start.local.y + start.local.h / 2),
    },
    start.ancestorRot,
  );
  frame.sw = box.w;
  frame.sh = box.h;
  frame.srot = rot + start.ancestorRot;
  frame.sx = start.scene.x + start.scene.w / 2 + delta.x - box.w / 2;
  frame.sy = start.scene.y + start.scene.h / 2 + delta.y - box.h / 2;
}

/** Fill a frame from a box in scene space. */
function setFromScene(frame: Frame, start: NodeStart, box: Rect, srot: number) {
  frame.sx = box.x;
  frame.sy = box.y;
  frame.sw = box.w;
  frame.sh = box.h;
  frame.srot = srot;
  const delta = rotatePoint(
    {
      x: box.x + box.w / 2 - (start.scene.x + start.scene.w / 2),
      y: box.y + box.h / 2 - (start.scene.y + start.scene.h / 2),
    },
    -start.ancestorRot,
  );
  frame.w = box.w;
  frame.h = box.h;
  frame.rot = srot - start.ancestorRot;
  frame.x = start.local.x + start.local.w / 2 + delta.x - box.w / 2;
  frame.y = start.local.y + start.local.h / 2 + delta.y - box.h / 2;
}

// ---------------------------------------------------------------------------
// Writing pixels
// ---------------------------------------------------------------------------

function writeFrames(session: Session, sized: boolean) {
  for (let i = 0; i < session.starts.length; i++) {
    const start = session.starts[i];
    const el = start.el;
    if (!el) continue;
    const frame = session.frames[i];
    // A node its parent lays out is positioned by the flow, exactly as
    // `ShapeView` renders it — translating it would move it off its own slot.
    el.style.transform = start.flow
      ? `rotate(${frame.rot}deg)`
      : `translate3d(${frame.x}px, ${frame.y}px, 0) rotate(${frame.rot}deg)`;
    if (sized) {
      el.style.width = `${frame.w}px`;
      el.style.height = `${frame.h}px`;
      start.shape?.write(frame.w, frame.h);
    }
  }
}

/**
 * A scale draws itself as a CSS transform rather than as a new width and
 * height: one write per node, and the browser scales the stroke, the corner and
 * the text along with the box — which is exactly what the committed scene will
 * say, and what no amount of setting `width` could preview.
 */
function writeScale(session: Session) {
  for (let i = 0; i < session.starts.length; i++) {
    const start = session.starts[i];
    const el = start.el;
    if (!el) continue;
    const frame = session.frames[i];
    // The element keeps its own size, and `scale` works about its centre — so
    // it is translated to where its *unscaled* box has to sit for the scaled
    // one to land on the frame.
    const x = frame.x + frame.w / 2 - start.local.w / 2;
    const y = frame.y + frame.h / 2 - start.local.h / 2;
    el.style.transform = start.flow
      ? `rotate(${frame.rot}deg) scale(${session.k})`
      : `translate3d(${x}px, ${y}px, 0) rotate(${frame.rot}deg) scale(${session.k})`;
  }
}

function writeOverlay(
  session: Session,
  o: TransformGestureOptions,
  guides: readonly SnapGuide[],
) {
  const overlay = o.overlay?.current;
  if (!overlay) return;
  if (session.frames.length === 1) {
    const frame = session.frames[0];
    overlay.update(
      { x: frame.sx, y: frame.sy, w: frame.sw, h: frame.sh },
      frame.srot,
      guides,
    );
    return;
  }
  overlay.update(unionBounds(liveBoxes(session)), 0, guides);
}

function restoreDom(session: Session) {
  for (const start of session.starts) {
    if (!start.el) continue;
    start.el.style.transform = start.transform;
    start.el.style.width = start.width;
    start.el.style.height = start.height;
    start.shape?.restore();
  }
  for (const other of session.reorder?.others ?? []) {
    if (other.el) other.el.style.transform = other.transform;
  }
}

/**
 * Alt-drag leaves the original behind. React knows nothing until pointerup, so
 * the thing left behind is a detached clone of the element — invisible to the
 * model, removed before anything is committed.
 */
function syncGhosts(session: Session) {
  const wanted = session.mode === "move" && session.mods.alt;
  const shown = session.ghosts.length > 0;
  if (wanted === shown) return;
  if (!wanted) {
    removeGhosts(session);
    return;
  }
  for (const start of session.starts) {
    const el = start.el;
    if (!el?.parentElement) continue;
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("id");
    ghost.style.transform = start.transform;
    ghost.style.pointerEvents = "none";
    el.parentElement.appendChild(ghost);
    session.ghosts.push(ghost);
  }
}

function removeGhosts(session: Session) {
  for (const ghost of session.ghosts) ghost.remove();
  session.ghosts.length = 0;
}

// ---------------------------------------------------------------------------
// Landing the gesture
// ---------------------------------------------------------------------------

function finish(
  session: Session,
  o: TransformGestureOptions,
  cancelled: boolean,
) {
  if (session.raf) {
    // A pointerup that lands before the scheduled frame paints (a fast
    // flick-release, or a main thread busy enough to miss a vsync) must not
    // just drop that frame — `runFrame` is what flips `session.active` once
    // the drag threshold is crossed, and skipping it here reads a genuine
    // drag as a no-op click, silently discarding the whole gesture.
    cancelAnimationFrame(session.raf);
    session.raf = 0;
    if (!cancelled) runFrame(session, o);
  }
  session.detach();
  const { ops, select } = finishGesture(session, o, cancelled);
  if (landGesture(o, ops) && select?.length) o.onSelect?.(select);
  endGesture(session, o);
}

/**
 * Puts the DOM back where the scene will take over, and says what the gesture
 * comes to — nothing, for a click or a cancel. Dispatches nothing: a gesture
 * spanning several diagrams lands all of them in one step.
 */
export function finishGesture(
  session: Session,
  o: TransformGestureOptions,
  cancelled: boolean,
): { ops: SceneOp[]; select: NodeId[] | null } {
  removeGhosts(session);

  let ops: SceneOp[] = [];
  let select: NodeId[] | null = null;
  if (cancelled || !session.active) {
    restoreDom(session);
  } else if (session.mode === "reorder") {
    // React re-lays the group out from the committed order; our preview offsets
    // would be added on top of it.
    restoreDom(session);
    ops = reorderOps(session);
  } else if (session.mode === "move" && session.mods.alt) {
    restoreDom(session);
    const duplicate = duplicateOps(session, o);
    ops = duplicate.ops;
    select = duplicate.ids;
  } else {
    // A scale previews as a CSS transform on the element, and React writes a
    // style key only when it changes. Scaled from a corner, `x`/`y` are what
    // they were, so the transform React would write is the one it wrote last
    // — and the preview's `scale(k)` would stay on an element whose box the
    // op has already grown by k, drawing it k times too large. The element
    // goes back to what React last wrote before the op lands, so the render
    // that follows starts from what it believes is there.
    if (session.mode === "scale") restoreDom(session);
    ops = transformOps(session);
  }
  return { ops, select };
}

/** One undo entry: the gesture's ops and whatever landing them implies. False for none. */
export function landGesture(o: TransformGestureOptions, ops: readonly SceneOp[]): boolean {
  if (!ops.length) return false;
  o.store.begin();
  o.store.dispatch([...ops]);
  o.onLand?.();
  o.store.commit();
  return true;
}

/** The gesture is over: the overlay draws from the scene again, and the host hears so. */
export function endGesture(session: Session, o: TransformGestureOptions) {
  if (!session.active) return;
  o.overlay?.current?.update(null, 0, NO_GUIDES);
  o.onActiveChange?.(false);
}

function moved(session: Session): boolean {
  for (let i = 0; i < session.starts.length; i++) {
    const start = session.starts[i];
    const frame = session.frames[i];
    if (
      frame.x !== start.local.x ||
      frame.y !== start.local.y ||
      frame.w !== start.local.w ||
      frame.h !== start.local.h ||
      frame.rot !== start.rot
    ) {
      return true;
    }
  }
  return false;
}

function framesOf(session: Session): NodeFrame[] {
  return session.frames.map((frame) => ({
    id: frame.id,
    x: frame.x,
    y: frame.y,
    w: frame.w,
    h: frame.h,
  }));
}

function transformOps(session: Session): SceneOp[] {
  if (!moved(session)) return [];
  const ids = session.starts.map((start) => start.id);

  if (session.mode === "move") {
    // One `move` only when every node's parent space is oriented the same way;
    // otherwise a single dx/dy would mean a different direction for each.
    const first = session.starts[0];
    const uniform = session.starts.every(
      (start) => start.ancestorRot === first.ancestorRot,
    );
    if (uniform) {
      return [
        {
          type: "move",
          ids,
          dx: session.frames[0].x - first.local.x,
          dy: session.frames[0].y - first.local.y,
        },
      ];
    }
    return [{ type: "resize", frames: framesOf(session) }];
  }

  if (session.mode === "resize") {
    return [{ type: "resize", frames: framesOf(session) }];
  }

  // The one gesture that lands as what it *is* rather than as the boxes it
  // worked out: the op carries the factor down through the children and the
  // styles the frames say nothing about.
  if (session.mode === "scale") {
    return [{ type: "scale", ids, k: session.k, anchor: session.anchor }];
  }

  // Rotation is absolute per node, so nodes that started at different angles
  // end at different angles; a shared centre also moves them.
  const byAngle = new Map<number, NodeId[]>();
  for (const frame of session.frames) {
    const bucket = byAngle.get(frame.rot);
    if (bucket) bucket.push(frame.id);
    else byAngle.set(frame.rot, [frame.id]);
  }
  const ops: SceneOp[] = [];
  for (const [rot, bucket] of byAngle) {
    ops.push({ type: "rotate", ids: bucket, rot });
  }
  if (session.starts.length > 1) {
    ops.push({ type: "resize", frames: framesOf(session) });
  }
  return ops;
}

function reorderOps(session: Session): SceneOp[] {
  const state = session.reorder;
  if (!state || state.index === state.startIndex) return [];
  const index = state.reversed ? state.others.length - state.index : state.index;
  return [
    {
      type: "reorder",
      ids: state.moving.map((node) => node.id),
      to: { at: "index", parentId: state.parent.id, index },
    },
  ];
}

/**
 * Alt-drag: the originals stay put and a copy lands where the pointer did. One
 * `insert` per node, each next to its own original, so a multi-parent selection
 * duplicates in place rather than collapsing to the top level.
 */
function duplicateOps(
  session: Session,
  o: TransformGestureOptions,
): { ops: SceneOp[]; ids: NodeId[] } {
  if (!moved(session)) return { ops: [], ids: [] };
  const scene = o.store.getScene();

  const sources: { node: SceneNode; frame: Frame }[] = [];
  let total = 0;
  for (let i = 0; i < session.starts.length; i++) {
    const node = findNode(scene, session.starts[i].id);
    if (!node) continue;
    sources.push({ node, frame: session.frames[i] });
    total += countNodes(node);
  }
  if (!sources.length) return { ops: [], ids: [] };

  const pool = mintIds(scene, total);
  const cursor = { i: 0 };
  const inserted = new Map<NodeId | null, number>();
  const ops: SceneOp[] = [];
  const ids: NodeId[] = [];

  for (const { node, frame } of sources) {
    const parent = findParent(scene, node.id);
    const parentId = parent?.id ?? null;
    const siblings = parent ? parent.children : scene.nodes;
    const shift = inserted.get(parentId) ?? 0;
    const at = siblings.findIndex((sibling) => sibling.id === node.id);
    const copy = { ...cloneWithNewIds(node, pool, cursor), x: frame.x, y: frame.y };
    ids.push(copy.id);
    ops.push({ type: "insert", nodes: [copy], parentId, index: at + 1 + shift });
    inserted.set(parentId, shift + 1);
  }

  return { ops, ids };
}

function countNodes(node: SceneNode): number {
  if (!isContainer(node)) return 1;
  let n = 1;
  for (const child of node.children) n += countNodes(child);
  return n;
}

function cloneWithNewIds(
  node: SceneNode,
  pool: readonly NodeId[],
  cursor: { i: number },
): SceneNode {
  const clone: SceneNode = { ...node, id: pool[cursor.i++] };
  if (isContainer(clone)) {
    clone.children = clone.children.map((child) =>
      cloneWithNewIds(child, pool, cursor),
    );
  }
  return clone;
}
