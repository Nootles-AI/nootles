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
  settleWiden,
  WIDEN_PUSH,
  widenGesture,
  writeGesture,
  type Allowed,
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

type PageGestureMode = "move" | "resize" | "scale" | "rotate";

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
 * for all. A move held at a column band's side is the lead's to push past, as
 * a diagram's own is: every column band in it shows its margins, then turns
 * wide. The landing is one undo step.
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
  /**
   * A marquee from empty space in `blockId`, reaching into every band it
   * crosses. False when that diagram is not on the page to start one.
   */
  marquee(origin: Point, blockId: string, shift: boolean, onEnd: () => void): boolean;
}

type Lane = {
  blockId: string;
  entry: DiagramEntry;
  o: TransformGestureOptions;
  session: GestureSession;
  /** Screen px per scene px, at the press. */
  scale: number;
  min: number;
  /** How far this diagram's own band lets the selection move, in its px. */
  room: Allowed | null;
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

/** The room every diagram's band leaves the selection, in the lead's px. */
function sharedRoom(lanes: readonly Lane[], lead: Lane): Allowed | null {
  return lanes.reduce<Allowed | null>(
    (room, lane) => intersectAllowed(room, scaleAllowed(lane.room, lane.scale / lead.scale)),
    null,
  );
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
    // Scale and offset are all that separate two bands' px: measured once a
    // band, not through the screen for every shape.
    const o = across(entry, lead, { x: 0, y: 0, w: 1, h: 1 });
    for (const node of scene.nodes) {
      if (node.hidden || staying.has(node.id)) continue;
      const b = absoluteBounds(scene, node.id);
      lines.push(...boxLines({ x: o.x + b.x * o.w, y: o.y + b.y * o.h, w: b.w * o.w, h: b.h * o.h }));
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
  let abandonMarquee: (() => void) | null = null;

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
    if (lead.o.widen && !lead.session.widened) {
      const push = lead.session.push;
      if (push > WIDEN_PUSH) {
        for (const lane of lanes) {
          if (!lane.o.widen) continue;
          widenGesture(lane.session, lane.o);
          lane.room = lane.session.allowed;
        }
        lead.session.allowed = sharedRoom(lanes, lead);
        ({ decision, guides } = decideGesture(lead.session, lead.o, point));
      } else {
        for (const lane of lanes) lane.o.pushing?.(push > 0);
      }
    }
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
      for (const lane of lanes) {
        finishGesture(lane.session, lane.o, true);
        settleWiden(lane.session, lane.o, { cancelled: true, landed: false });
      }
    } else {
      deps.batch(() => {
        for (const lane of lanes) {
          const { ops, select } = finishGesture(lane.session, lane.o, false);
          // The copies an Alt-drag leaves are this diagram's selection, and
          // the others' copies stay theirs.
          const landed = landGesture(lane.o, ops);
          if (landed && select?.length) {
            deps.selection.selectIn(lane.blockId, select, { keep: true });
          }
          settleWiden(lane.session, lane.o, { cancelled: false, landed });
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
        lanes.push({
          blockId: entry.blockId,
          entry,
          o,
          session,
          scale: o.screenScale(),
          min: o.minSize ?? 1,
          room: session.allowed,
        });
      }
      if (!lanes.length) return false;
      const lead = lanes.find((lane) => lane.entry === leader) ?? lanes[0];
      lead.session.allowed = sharedRoom(lanes, lead);

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

    cancel: () => {
      run?.end(true);
      abandonMarquee?.();
    },

    marquee: (origin, blockId, shift, onEnd) => {
      const start = deps.entries().find((e) => e.blockId === blockId);
      if (!start) return false;
      abandonMarquee?.();
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
        abandonMarquee = null;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", abandon);
        window.removeEventListener("keydown", key, true);
        start.api.gesture.overlay.current?.marquee(null);
      };
      // Given up — Escape, a cancelled pointer, the pane going — every
      // diagram's selection goes back as the press found it.
      const abandon = () => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        detach();
        deps.selection.keep(() => restores.forEach((restore) => restore()));
        onEnd();
      };
      const key = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        abandon();
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
      window.addEventListener("pointercancel", abandon);
      window.addEventListener("keydown", key, true);
      abandonMarquee = abandon;
      return true;
    },
  };
}
