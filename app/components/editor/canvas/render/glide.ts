"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { SceneStore } from "../engine/useScene";
import type { ViewportController } from "../engine/useViewport";
import { isAutoLayout, isPinned, laidOutScene } from "../scene/autoLayout";
import { absoluteBounds } from "../scene/geometry";
import { findNode, findParent, type EdgeId, type NodeId, type Scene } from "../scene/types";
import type { RotatedRect } from "../scene/geometry";
import {
  addOffsets,
  diffGlide,
  displace,
  edgesTouching,
  easingOf,
  enterKeyframes,
  frameAt,
  glideKeyframes,
  isBurst,
  negligible,
  placements,
  scaleOffset,
  tooMany,
  type Offset,
} from "./glidePlan";
import { glideEdges, settleEdges, type EdgeElements } from "./liveEdges";
import type { OverlayApi } from "./Overlay";

/**
 * Committed changes, shown landing: a shape an undo, a command, a typed value
 * or a collaborator moved glides from where it was drawn to where it now is;
 * a pasted one fades in, a deleted one fades out.
 *
 * Only what the store flags (`SceneStore.motion`) plays. Whatever follows a
 * hand — a drag, a scrub, a held arrow key — is never eased, and a gesture
 * starting cancels every glide outright ({@link ShapeGlide.cancel}), so a
 * press never picks up a shape between two places.
 *
 * It is FLIP on the model rather than on the DOM. The store's listener runs
 * before React renders, and diffing the laid-out scenes says where every
 * shape was and is without measuring anything; the layout effect after the
 * render then shows each one back where it was, through WAAPI on the
 * individual `translate`/`rotate` properties, and lets go. React's inline
 * `transform` is never written, and nothing a measurer reads — `offsetWidth`,
 * the model — is ever mid-flight. Sizes land as they are: a stretched box
 * would smear its text and strokes, and a width animated would reflow a label
 * under its measurer.
 *
 * The connectors and the selection frame are drawn from the scene, so they
 * would sit at the landing while the shapes travel. They are drawn a frame at
 * a time from the scene as it is mid-glide ({@link displace}) — the same
 * router and the same frame the renderer uses, so they stay attached exactly,
 * and the landing is the render's own geometry. No elements are measured.
 * Only the connectors with an end on a gliding shape are carried; one merely
 * routed around a gliding shape takes its landing route at once, which keeps
 * a frame's routing to the connectors that move rather than the diagram's.
 */

const GLIDE_ID = "nt-glide";
const ARRIVE_ID = "nt-arrive";

interface Tokens {
  ease: string;
  fast: number;
  dur: number;
  slow: number;
}

let tokens: Tokens | null = null;

/** The motion tokens off `:root`, read once — the JS side of `globals.css`. */
function motionTokens(el: Element): Tokens {
  if (tokens) return tokens;
  const css = getComputedStyle(el);
  const ms = (name: string, fallback: number) => {
    const raw = css.getPropertyValue(name).trim();
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return fallback;
    return raw.endsWith("ms") ? n : raw.endsWith("s") ? n * 1000 : n;
  };
  const ease = css.getPropertyValue("--ease").trim();
  // Unresolved, they are left unread so a later element can supply them.
  const read = { ease: ease || "cubic-bezier(0.25, 1, 0.5, 1)", fast: ms("--dur-fast", 95), dur: ms("--dur", 145), slow: ms("--dur-slow", 270) };
  if (ease) tokens = read;
  return read;
}

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

type Animated = HTMLElement | SVGElement;

function elementOf(root: ParentNode, id: NodeId): Animated | null {
  const el = root.querySelector<Animated>(`[data-id="${CSS.escape(id)}"]`);
  return el && typeof el.animate === "function" ? el : null;
}

/** The translation a node's own `transform` carries: none for a child its layout places. */
function translationOf(scene: Scene, id: NodeId): { x: number; y: number } | null {
  const node = findNode(scene, id);
  if (!node) return null;
  const parent = findParent(scene, id);
  return parent && isAutoLayout(parent) && !isPinned(node) ? { x: 0, y: 0 } : { x: node.x, y: node.y };
}

/**
 * A deleted shape, faded out where it stood. React unmounts the real one, so
 * what fades is a copy left beside it — inert, anonymous to every query that
 * finds shapes by id, and gone when the fade is. A child a layout places is
 * left out: a copy would take a slot in the flow and shove its siblings.
 */
function ghost(root: ParentNode, id: NodeId, duration: number, easing: string): Animation | null {
  const el = elementOf(root, id);
  if (!el || el.style.position !== "absolute") return null;
  const copy = el.cloneNode(true) as Animated;
  for (const node of [copy, ...copy.querySelectorAll("[data-id], [data-edge], [data-edge-label]")]) {
    node.removeAttribute("data-id");
    node.removeAttribute("data-edge");
    node.removeAttribute("data-edge-label");
  }
  copy.setAttribute("aria-hidden", "true");
  copy.removeAttribute("contenteditable");
  copy.style.pointerEvents = "none";
  el.after(copy);
  const fade = copy.animate([{ opacity: 0 }], { duration, easing, fill: "forwards" });
  const drop = () => copy.remove();
  fade.addEventListener("finish", drop);
  fade.addEventListener("cancel", drop);
  return fade;
}

interface Plan {
  moved: Map<NodeId, Offset>;
  entered: Set<NodeId>;
  duration: number;
  arrive: number;
  easing: string;
  still: boolean;
}

interface Flight {
  offsets: Map<NodeId, Offset>;
  anims: Map<NodeId, Animation>;
  duration: number;
  ease: (t: number) => number;
  /** The connectors carried along — never fewer as the flight goes, so one a release stops carrying is still drawn home. */
  touched: ReadonlySet<EdgeId>;
  edges: EdgeElements;
  raf: number;
}

/** What a glide draws into, reached once the surface is mounted. */
export interface GlideHost {
  /** The scene layer the shapes are drawn in. */
  root(): HTMLElement | null;
  overlay(): OverlayApi | null;
  /** The ids the overlay frames, or `null` while it frames something else — a selection spanning diagrams. */
  frameIds(): readonly NodeId[] | null;
}

export class ShapeGlide {
  /** The scene as of the last notification — what the DOM shows until React renders the next. */
  private last: Scene;
  /** Heard, not yet rendered. */
  private plan: Plan | null = null;
  private flight: Flight | null = null;
  private arrivals = new Set<Animation>();
  private drawers = new Set<() => void>();
  /** The scene as this frame of the flight draws it. */
  private shown: Scene | null = null;
  private lastAt = -Infinity;
  private host: GlideHost = {
    root: () => null,
    overlay: () => null,
    frameIds: () => null,
  };

  constructor(
    private readonly store: SceneStore,
    private readonly viewport: ViewportController,
  ) {
    this.last = store.getScene();
  }

  listen = (host: GlideHost): (() => void) => {
    this.host = host;
    this.last = this.store.getScene();
    return this.store.subscribe(this.heard);
  };

  /** The store's listener, before React renders: the DOM still shows `last`. */
  private heard = (): void => {
    const { store } = this;
    const next = store.getScene();
    const prev = this.last;
    if (next === prev) return;
    this.last = next;
    const motion = store.motion();
    if (!motion) {
      this.release(prev, next);
      return;
    }
    const now = performance.now();
    const burst = isBurst(now, this.lastAt);
    this.lastAt = now;
    const root = this.host.root();
    if (burst || !root) {
      this.cancel();
      return;
    }
    const a = laidOutScene(prev);
    const b = laidOutScene(next);
    const diff = diffGlide(a, b);
    if (tooMany(diff)) {
      this.cancel();
      return;
    }
    const t = motionTokens(root);
    for (const id of diff.exited) ghost(root, id, t.fast, t.ease);
    const still = reducedMotion();
    const moved = new Map<NodeId, Offset>();
    if (!still && diff.moved.size) {
      const seen = this.visible(a, b);
      for (const [id, off] of diff.moved) if (seen(id)) moved.set(id, off);
    }
    // Two commits before one render: the glide runs from before the first.
    const held = this.plan;
    if (!held && moved.size === 0 && diff.entered.length === 0) return;
    for (const [id, off] of held?.moved ?? []) moved.set(id, addOffsets(off, moved.get(id) ?? { dx: 0, dy: 0, dr: 0 }));
    this.plan = {
      moved,
      entered: new Set([...(held?.entered ?? []), ...diff.entered]),
      duration: motion === "nudge" ? t.fast : t.slow,
      arrive: t.dur,
      easing: t.ease,
      still,
    };
  };

  /**
   * An unflagged change — a hand at work somewhere, a measurement — that moved
   * a gliding shape lands that shape where the change put it: its glide was
   * relative to a position it no longer has.
   */
  private release(prev: Scene, next: Scene): void {
    const flight = this.flight;
    const plan = this.plan;
    if (!flight && !plan) return;
    const before = placements(laidOutScene(prev).nodes);
    const after = placements(laidOutScene(next).nodes);
    const shifted = (id: NodeId) => {
      const a = before.get(id);
      const b = after.get(id);
      return !a || !b || a.parent !== b.parent || a.node.x !== b.node.x || a.node.y !== b.node.y || a.node.rot !== b.node.rot;
    };
    if (plan) for (const id of [...plan.moved.keys()]) if (shifted(id)) plan.moved.delete(id);
    if (!flight) return;
    for (const id of [...flight.offsets.keys()]) {
      if (!shifted(id)) continue;
      flight.anims.get(id)?.cancel();
      flight.anims.delete(id);
      flight.offsets.delete(id);
    }
  }

  /** Whether a node is on screen before or after — nobody watches a glide off it. */
  private visible(a: Scene, b: Scene): (id: NodeId) => boolean {
    const { viewport } = this;
    const o = viewport.sceneToClient({ x: 0, y: 0 });
    const u = viewport.sceneToClient({ x: 100, y: 100 });
    const sx = (u.x - o.x) / 100;
    const sy = (u.y - o.y) / 100;
    const w = window.innerWidth;
    const h = window.innerHeight;
    return (id) => {
      const p = absoluteBounds(a, id);
      const q = absoluteBounds(b, id);
      const x0 = o.x + Math.min(p.x, q.x) * sx;
      const x1 = o.x + Math.max(p.x + p.w, q.x + q.w) * sx;
      const y0 = o.y + Math.min(p.y, q.y) * sy;
      const y1 = o.y + Math.max(p.y + p.h, q.y + q.h) * sy;
      return x1 >= 0 && x0 <= w && y1 >= 0 && y0 <= h;
    };
  }

  /** After React has drawn `rendered`, before it is painted: show each shape back where it was, and let go. */
  play = (rendered: Scene): void => {
    const plan = this.plan;
    if (!plan || rendered !== this.store.getScene()) return;
    this.plan = null;
    const root = this.host.root();
    if (!root) return;
    const laid = laidOutScene(rendered);

    for (const id of plan.entered) {
      const el = elementOf(root, id);
      const at = el && translationOf(laid, id);
      if (!el || !at) continue;
      const arrival = el.animate(enterKeyframes(at.x, at.y, plan.still), {
        duration: plan.arrive,
        easing: plan.easing,
        id: ARRIVE_ID,
      });
      this.arrivals.add(arrival);
      const done = () => this.arrivals.delete(arrival);
      arrival.addEventListener("finish", done);
      arrival.addEventListener("cancel", done);
    }

    // Nothing new to move: a glide under way is left to finish as it was.
    if (plan.moved.size === 0) return;
    // A glide already under way carries on from where it has got to.
    const offsets = new Map<NodeId, Offset>();
    const was = this.flight;
    if (was) {
      const k = 1 - this.progress(was);
      for (const [id, off] of was.offsets) offsets.set(id, scaleOffset(off, k));
      this.stop(was);
      this.flight = null;
    }
    for (const [id, off] of plan.moved) offsets.set(id, addOffsets(offsets.get(id), off));

    const anims = new Map<NodeId, Animation>();
    for (const [id, off] of offsets) {
      const el = negligible(off) ? null : elementOf(root, id);
      const at = el && translationOf(laid, id);
      if (!el || !at) {
        offsets.delete(id);
        continue;
      }
      anims.set(id, el.animate(glideKeyframes(off, at.x, at.y), { duration: plan.duration, easing: plan.easing, id: GLIDE_ID }));
    }
    if (anims.size === 0) {
      if (was) this.land();
      return;
    }
    this.flight = {
      offsets,
      anims,
      duration: plan.duration,
      ease: easingOf(plan.easing),
      touched: new Set([...edgesTouching(laid, offsets.keys()), ...(was?.touched ?? [])]),
      edges: new Map(),
      raf: 0,
    };
    // Now, not next frame: the connectors and the frame React just drew at
    // the landing must not be painted there even once.
    this.tick();
  };

  /** How far the flight has eased, off one of its own animations' clock. */
  private progress(flight: Flight): number {
    for (const anim of flight.anims.values()) {
      if (anim.playState === "idle") continue;
      const time = Number(anim.currentTime ?? 0);
      return flight.ease(Math.min(1, time / flight.duration));
    }
    return 1;
  }

  private tick = (): void => {
    const flight = this.flight;
    if (!flight) return;
    const p = this.progress(flight);
    if (p >= 1) {
      this.flight = null;
      this.land();
      return;
    }
    const scene = displace(laidOutScene(this.store.getScene()), flight.offsets, 1 - p);
    this.shown = scene;
    glideEdges(this.host.root(), scene, flight.touched, flight.edges);
    // A selection cleared or spread across diagrams mid-flight hands the frame back at once.
    const ids = this.host.frameIds();
    this.host.overlay()?.follow(ids?.length ? frameAt(scene, ids) : null);
    this.tell();
    flight.raf = requestAnimationFrame(this.tick);
  };

  /** The connectors and the frame back to exactly what the committed scene draws. */
  private land(): void {
    this.shown = null;
    settleEdges(this.host.root(), laidOutScene(this.store.getScene()));
    this.host.overlay()?.follow(null);
    this.tell();
  }

  private tell(): void {
    for (const listener of this.drawers) listener();
  }

  /** Told on every frame of a flight and as it lands — for anything drawn over the shapes, like a collaborator's outline. */
  onDraw = (listener: () => void): (() => void) => {
    this.drawers.add(listener);
    return () => void this.drawers.delete(listener);
  };

  /** Where a shape is drawn this frame of a flight, if it or a group holding it is gliding. */
  box(id: NodeId): RotatedRect | null {
    const { flight, shown } = this;
    if (!flight || !shown) return null;
    let carried = false;
    for (let at: NodeId | undefined = id; at && !carried; at = findParent(shown, at)?.id) carried = flight.offsets.has(at);
    return carried ? frameAt(shown, [id]) : null;
  }

  private stop(flight: Flight): void {
    cancelAnimationFrame(flight.raf);
    for (const anim of flight.anims.values()) anim.cancel();
  }

  /** Everything lands where the scene has it, now — a gesture is starting, or a burst. */
  cancel = (): void => {
    this.plan = null;
    for (const arrival of [...this.arrivals]) arrival.cancel();
    const flight = this.flight;
    if (!flight) return;
    this.flight = null;
    this.stop(flight);
    this.land();
  };
}

export interface ShapeGlideOptions {
  store: SceneStore;
  /** The scene as rendered this pass. */
  scene: Scene;
  sceneRef: RefObject<HTMLDivElement | null>;
  viewport: ViewportController;
  overlay: RefObject<OverlayApi | null>;
  frameIds: () => readonly NodeId[] | null;
}

/** A surface's glides; call `cancel` as a gesture takes hold. */
export function useShapeGlide({ store, scene, sceneRef, viewport, overlay, frameIds }: ShapeGlideOptions): ShapeGlide {
  const latest = useRef(frameIds);
  useEffect(() => {
    latest.current = frameIds;
  });
  const [glide] = useState(() => new ShapeGlide(store, viewport));
  useEffect(() => {
    const off = glide.listen({
      root: () => sceneRef.current,
      overlay: () => overlay.current,
      frameIds: () => latest.current(),
    });
    return () => {
      off();
      glide.cancel();
    };
  }, [glide, sceneRef, overlay]);
  useLayoutEffect(() => glide.play(scene), [glide, scene]);
  return glide;
}
