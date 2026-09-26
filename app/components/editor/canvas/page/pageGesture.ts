import {
  activateGesture,
  applyDecision,
  capScale,
  convertDecision,
  createGestureSession,
  decideGesture,
  drivePointer,
  endGesture,
  finishGesture,
  intersectAllowed,
  landGesture,
  liveBottomOf,
  liveBoxes,
  pastThreshold,
  readGestureMods,
  resetGestureRotation,
  scaleAllowed,
  writeGesture,
  type GestureSession,
  type PointerLike,
  type TransformGestureOptions,
} from "../engine/gestures";
import { boxLines, type SnapGuide, type SnapLine } from "../engine/snapping";
import type { OverlayApi } from "../render/Overlay";
import { laidOutScene } from "../scene/autoLayout";
import { absoluteBounds, nodeBounds, normalizeRect, type Handle } from "../scene/geometry";
import { nodePath, type NodeId, type Point, type Rect } from "../scene/types";
import type { DiagramEntry } from "./PageCanvas";
import type { PageSelection } from "./pageSelection";

/**
 * What the page needs of a diagram to run its share of a gesture: the options
 * its own gesture runs with, as of its last render, and its overlay.
 */
export interface GestureHost {
  options(): TransformGestureOptions;
  overlay: { readonly current: OverlayApi | null };
}

export type PageGestureMode = "move" | "resize" | "scale" | "rotate";

/**
 * A move, resize, scale or rotation of shapes selected in several diagrams at
 * once.
 *
 * Each diagram keeps its gesture whole — its own session, its own DOM writes,
 * its own undo entry — and the page runs them in lockstep. The diagram the
 * page is focused on leads: it reads the pointer, snaps (to the other
 * diagrams' shapes too) and decides; the others follow the decision, converted
 * to their own px, and never read the pointer at all. Every one acts about the
 * page's selection box, so a resize stretches them all by the same factors and
 * a rotation turns them about one centre. The edges of every diagram's band
 * hold the whole gesture: a move stops where the first of them would leave its
 * band, and a resize or a rotation that would take any of them out is refused
 * for all. The landing is one undo step.
 */
export interface PageGesture {
  /** Whether a selection spans more than one diagram — the gesture is the page's, not the diagram's. */
  spans(): boolean;
  /** From a press in `blockId`. False when the selection does not span diagrams. */
  start(event: PointerLike, mode: PageGestureMode, handle: Handle | null, blockId: string): boolean;
  /** A rotation zone double-clicked: every diagram's selection stood up, in one step. */
  resetRotation(): boolean;
  /** Whether the last press became a drag — read on its release. */
  didDrag(): boolean;
  cancel(): void;
  /** A marquee from empty space in `blockId`, reaching into every band it crosses. */
  marquee(origin: Point, blockId: string, shift: boolean, onEnd: () => void): void;
}

type Lane = {
  blockId: string;
  entry: DiagramEntry;
  o: TransformGestureOptions;
  session: GestureSession;
  /** Screen px per scene px, at the press. */
  scale: number;
  min: number;
};

type Run = {
  lanes: Lane[];
  lead: Lane;
  start: Point;
  client: Point;
  active: boolean;
  raf: number;
  detach: () => void;
  end: (cancelled: boolean) => void;
};

const NO_GUIDES: readonly SnapGuide[] = [];

function visible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
}

/** `rect` in one diagram's px, carried into another's through the screen. */
function across(from: DiagramEntry, to: DiagramEntry, rect: Rect): Rect {
  const a = to.api.viewport.clientToScene(from.api.viewport.sceneToClient({ x: rect.x, y: rect.y }));
  const b = to.api.viewport.clientToScene(
    from.api.viewport.sceneToClient({ x: rect.x + rect.w, y: rect.y + rect.h }),
  );
  return normalizeRect(a, b);
}

/**
 * The other diagrams' shapes as lines in the lead's px: the top-level shapes
 * that are staying put, in every band on screen. Alignment only — a gap
 * measured across a paragraph is a coincidence, not a row.
 */
function foreignLines(
  lead: DiagramEntry,
  entries: readonly DiagramEntry[],
  moving: ReadonlyMap<string, readonly NodeId[]>,
): SnapLine[] {
  const lines: SnapLine[] = [];
  for (const entry of entries) {
    const band = entry.api.band.current;
    if (entry === lead || !band || !visible(band)) continue;
    const scene = laidOutScene(entry.api.store.getScene());
    const staying = new Set<NodeId>();
    for (const id of moving.get(entry.blockId) ?? []) {
      const top = nodePath(scene, id)[0];
      if (top) staying.add(top.id);
    }
    for (const node of scene.nodes) {
      if (node.hidden || staying.has(node.id)) continue;
      lines.push(...boxLines(across(entry, lead, absoluteBounds(scene, node.id))));
    }
  }
  return lines;
}

export function createPageGesture(deps: {
  entries(): DiagramEntry[];
  selection: PageSelection;
  batch<T>(fn: () => T): T;
}): PageGesture {
  let run: Run | null = null;
  let dragged = false;

  /** Diagrams holding shapes that may move, in document order. */
  const holders = () => {
    const parts = deps.selection.getSnapshot().parts;
    return deps.entries().filter((e) => !e.readOnly && (parts.get(e.blockId)?.ids.length ?? 0) > 0);
  };

  /** The page's frame this frame, in the lead's px. Reads the layout: once per frame, after every write. */
  const liveUnion = (lanes: readonly Lane[], lead: Lane): Rect | null => {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const lane of lanes) {
      for (const box of liveBoxes(lane.session)) {
        const r = lane === lead ? nodeBounds(box) : across(lane.entry, lead.entry, nodeBounds(box));
        x1 = Math.min(x1, r.x);
        y1 = Math.min(y1, r.y);
        x2 = Math.max(x2, r.x + r.w);
        y2 = Math.max(y2, r.y + r.h);
      }
    }
    return x1 <= x2 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
  };

  const frame = (state: Run) => {
    state.raf = 0;
    const { lanes, lead } = state;
    if (!state.active) {
      if (!pastThreshold(state.start, state.client)) return;
      state.active = true;
      dragged = true;
      for (const lane of lanes) {
        activateGesture(lane.session, lane.o, lane === lead);
        if (lane !== lead) lane.entry.api.gesture.overlay.current?.passive(true);
      }
    }

    const point = lead.o.clientToScene(state.client);
    let { decision, guides } = decideGesture(lead.session, lead.o, point);
    if (decision.kind === "scale") {
      let k = decision.k;
      for (const lane of lanes) k = capScale(lane.session, k);
      decision = { kind: "scale", k };
    }
    const decided = lanes.map((lane) => convertDecision(decision, lead.scale, lane.scale));
    let fits = true;
    lanes.forEach((lane, i) => {
      if (!applyDecision(lane.session, decided[i], lane.min)) fits = false;
    });
    if (fits) {
      lanes.forEach((lane, i) => (lane.session.accepted = decided[i]));
    } else {
      for (const lane of lanes) applyDecision(lane.session, lane.session.accepted, lane.min);
      guides = NO_GUIDES;
    }

    for (const lane of lanes) writeGesture(lane.session, lane.o, guides, false);
    const union = liveUnion(lanes, lead);
    if (union) lead.entry.api.gesture.overlay.current?.update(union, 0, guides);
    for (const lane of lanes) {
      lane.o.onFrame?.(lane.session.frames, liveBottomOf(lane.session.frames));
    }
  };

  const schedule = (state: Run) => {
    if (!state.raf) state.raf = requestAnimationFrame(() => frame(state));
  };

  const end = (state: Run, cancelled: boolean) => {
    if (run !== state) return;
    run = null;
    state.detach();
    if (state.raf) {
      // A release that beats the frame it scheduled still lands where it was.
      cancelAnimationFrame(state.raf);
      state.raf = 0;
      if (!cancelled) frame(state);
    }
    const { lanes, lead } = state;
    if (cancelled || !state.active) {
      for (const lane of lanes) finishGesture(lane.session, lane.o, true);
    } else {
      deps.batch(() => {
        for (const lane of lanes) {
          const { ops, select } = finishGesture(lane.session, lane.o, false);
          // The copies an Alt-drag leaves are this diagram's selection, and
          // the others' copies stay theirs.
          if (landGesture(lane.o, ops) && select?.length) {
            deps.selection.selectIn(lane.blockId, select, { keep: true });
          }
        }
      });
      deps.selection.focus(lead.blockId);
    }
    for (const lane of lanes) {
      endGesture(lane.session, lane.o);
      if (lane !== lead) lane.entry.api.gesture.overlay.current?.passive(false);
    }
  };

  return {
    spans: () => holders().length > 1,

    start: (event, mode, handle, blockId) => {
      if (run) return true;
      dragged = false;
      const holding = holders();
      if (holding.length < 2) return false;
      if (holding.some((e) => e.blockId === blockId)) deps.selection.focus(blockId);
      const leadId = deps.selection.getSnapshot().focused ?? blockId;
      const leader = holding.find((e) => e.blockId === leadId) ?? holding[0];
      const parts = deps.selection.getSnapshot().parts;
      const moving = new Map(holding.map((e) => [e.blockId, parts.get(e.blockId)?.ids ?? []]));

      const lanes: Lane[] = [];
      for (const entry of holding) {
        const o = entry.api.gesture.options();
        const bounds = deps.selection.unionIn(entry.blockId);
        const session = createGestureSession(o, event, mode, handle, {
          bounds: bounds ?? undefined,
          sole: false,
          lockstep: true,
          foreign: entry === leader ? foreignLines(leader, deps.entries(), moving) : undefined,
        });
        // A child of an auto-layout group would be reordered, which is a
        // question about its own group alone; across diagrams it stays put.
        if (!session || session.mode === "reorder") continue;
        lanes.push({ blockId: entry.blockId, entry, o, session, scale: o.screenScale(), min: o.minSize ?? 1 });
      }
      if (!lanes.length) return false;
      const lead = lanes.find((lane) => lane.entry === leader) ?? lanes[0];
      lead.session.allowed = lanes.reduce(
        (room, lane) => intersectAllowed(room, scaleAllowed(lane.session.allowed, lane.scale / lead.scale)),
        lead.session.allowed,
      );

      event.preventDefault();
      const state: Run = {
        lanes,
        lead,
        start: { x: event.clientX, y: event.clientY },
        client: { x: event.clientX, y: event.clientY },
        active: false,
        raf: 0,
        detach: () => {},
        end: (cancelled) => end(state, cancelled),
      };
      run = state;
      state.detach = drivePointer(event.pointerId, {
        move: (ev) => {
          state.client = { x: ev.clientX, y: ev.clientY };
          for (const lane of lanes) readGestureMods(lane.session, ev);
          schedule(state);
        },
        key: (ev) => {
          for (const lane of lanes) readGestureMods(lane.session, ev);
          schedule(state);
        },
        end: (cancelled, ev) => {
          if (ev) for (const lane of lanes) readGestureMods(lane.session, ev);
          end(state, cancelled);
        },
      });
      return true;
    },

    resetRotation: () => {
      const holding = holders();
      if (holding.length < 2) return false;
      deps.batch(() => {
        for (const entry of holding) resetGestureRotation(entry.api.gesture.options());
      });
      return true;
    },

    didDrag: () => dragged,

    cancel: () => run?.end(true),

    marquee: (origin, blockId, shift, onEnd) => {
      const start = deps.entries().find((e) => e.blockId === blockId);
      if (!start) return;
      const restores = deps.entries().map((entry) => entry.api.ownSelection.capture());
      const touched = new Set<string>();
      let latest: Point | null = null;
      let raf = 0;

      const paint = (client: Point) => {
        const rect = normalizeRect(origin, client);
        for (const entry of deps.entries()) {
          const band = entry.api.band.current;
          if (entry.readOnly || !band) continue;
          const r = band.getBoundingClientRect();
          const meets =
            r.left <= rect.x + rect.w && r.right >= rect.x && r.top <= rect.y + rect.h && r.bottom >= rect.y;
          // A band the rubber band has left is still asked, with a rect that
          // now misses it, so what it took there goes again.
          if (!meets && !touched.has(entry.blockId)) continue;
          touched.add(entry.blockId);
          const { viewport } = entry.api;
          const scene = normalizeRect(
            viewport.clientToScene({ x: rect.x, y: rect.y }),
            viewport.clientToScene({ x: rect.x + rect.w, y: rect.y + rect.h }),
          );
          deps.selection.marqueeIn(entry.blockId, scene, { shift });
        }
        start.api.gesture.overlay.current?.marquee(
          normalizeRect(start.api.viewport.clientToScene(origin), start.api.viewport.clientToScene(client)),
        );
      };

      const flush = () => {
        raf = 0;
        if (latest) paint(latest);
      };
      const move = (event: PointerEvent) => {
        latest = { x: event.clientX, y: event.clientY };
        if (!raf) raf = requestAnimationFrame(flush);
      };
      const detach = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        window.removeEventListener("keydown", key, true);
        start.api.gesture.overlay.current?.marquee(null);
      };
      // Escape puts every diagram's selection back as the press found it.
      const key = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        detach();
        deps.selection.keep(() => restores.forEach((restore) => restore()));
        onEnd();
      };
      const up = () => {
        if (raf) {
          cancelAnimationFrame(raf);
          flush();
        }
        detach();
        const parts = deps.selection.getSnapshot().parts;
        const holding = deps.entries().filter((e) => parts.get(e.blockId)?.ids.length);
        const focus = holding.find((e) => e === start) ?? holding[0];
        if (focus) deps.selection.focus(focus.blockId);
        onEnd();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
      window.addEventListener("keydown", key, true);
    },
  };
}
