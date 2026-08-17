import type { Awareness } from "y-protocols/awareness";
import { laidOutScene } from "../scene/autoLayout";
import { absoluteRect, absoluteRotation } from "../scene/geometry";
import { findNode, nodePath, type Point, type Scene } from "../scene/types";
import { offsetIn, pointAt } from "./labelCaret";

/**
 * Canvas co-presence, Figma-grammar: whose attention is on this diagram (a
 * name leaf on its top-right corner), what they have selected (an outline in
 * their colour), and where their drag is RIGHT NOW (the outline follows,
 * sampled live, well ahead of the committed CRDT write).
 *
 * All of it rides the page's awareness channel in one `canvas` field —
 * ephemeral by construction, gone when they are. The painter is deliberately
 * imperative DOM: ghosts live INSIDE the transformed scene layer, positioned
 * in scene pixels, so pan and zoom carry them for free and nothing re-renders
 * a single shape. Every painted element is keyed and reused across paints, so
 * a position change rides a CSS transition — remote motion glides at the
 * awareness cadence instead of ticking — and chrome weights are counter-scaled
 * by `--k` (one screen px in scene px), exactly as the selection overlay does.
 */

export type CanvasSignal = {
  /** The diagram this person's shell is on. */
  b: string;
  ids: string[];
  /** Selected connectors — present only when any are. */
  eids?: string[];
  /** In-flight drag boxes, scene px — present only mid-gesture. */
  frames?: Record<string, { x: number; y: number; w: number; h: number }>;
  /**
   * A label being edited: the shape, and the selection as anchor/head offsets
   * in the label's visible text (see `labelCaret`). `a !== h` is a highlight.
   */
  edit?: { id: string; a: number; h: number };
  n: number;
};

type Api = {
  selection: {
    subscribe(cb: () => void): () => void;
    getSnapshot(): { ids: readonly string[]; edgeIds: readonly string[] };
  };
  store: {
    gesturing(): boolean;
    subscribe(cb: () => void): () => void;
    getScene(): Scene;
  };
  viewport: {
    containerRef: { current: HTMLDivElement | null };
    sceneRef: { current: HTMLDivElement | null };
    clientToScene(point: Point): Point;
    get(): { zoom: number };
    subscribe(cb: () => void): () => void;
  };
};

/** Drag sampling cadence — presence-grade, far under gesture frame rate. */
const SAMPLE_MS = 90;

/** Stillness after which a caret's name flag folds — the main editor's
 *  `showCursorLabels: "activity"` grammar, spoken here too. */
const CARET_IDLE_MS = 2000;

/** Live boxes shipped per sample. A select-all drag past this many shapes
 *  ships the first few live and lands the rest at the commit — a bounded
 *  signal beats a complete one on a presence channel. */
const MAX_LIVE_FRAMES = 64;

/** Ghosts painted per person. Presence is a gesture, not a render target —
 *  and awareness is remote input, so cardinality is capped, not trusted. */
const MAX_GHOSTS = 256;

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

export function broadcastCanvasPresence(
  awareness: Awareness,
  blockId: string,
  api: Api,
): () => void {
  let lastHadFrames = false;

  const measure = (): CanvasSignal["frames"] => {
    const layer = api.viewport.sceneRef.current;
    if (!layer) return undefined;
    const frames: NonNullable<CanvasSignal["frames"]> = {};
    let any = 0;
    for (const id of api.selection.getSnapshot().ids) {
      if (any >= MAX_LIVE_FRAMES) break;
      const el = layer.querySelector<HTMLElement>(
        `[data-id="${CSS.escape(id)}"]`,
      );
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const a = api.viewport.clientToScene({ x: rect.left, y: rect.top });
      const b = api.viewport.clientToScene({ x: rect.right, y: rect.bottom });
      frames[id] = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
      any += 1;
    }
    return any ? frames : undefined;
  };

  // The label caret, read off the live DOM selection: inside a `.nt-edit` on
  // this canvas means a label is open, and the offsets say where in it.
  const measureEdit = (): CanvasSignal["edit"] => {
    const container = api.viewport.containerRef.current;
    const selection = document.getSelection();
    const focus = selection?.focusNode;
    if (!container || !selection || !focus) return undefined;
    const editable = (
      focus.nodeType === 1 ? (focus as Element) : focus.parentElement
    )?.closest(".nt-edit");
    if (!editable || !container.contains(editable)) return undefined;
    // A caret is live only while the hand is in the label: a commit that
    // leaves the DOM selection where it was must still take the signal down.
    if (document.activeElement !== editable) return undefined;
    const id = editable.closest("[data-id]")?.getAttribute("data-id");
    if (!id || !selection.anchorNode) return undefined;
    const a = offsetIn(editable, selection.anchorNode, selection.anchorOffset);
    const h = offsetIn(editable, focus, selection.focusOffset);
    return a === null || h === null ? undefined : { id, a, h };
  };

  let lastEditKey = "";
  let lastShipped = "";
  const announce = (withFrames: boolean) => {
    const frames = withFrames ? measure() : undefined;
    lastHadFrames = frames !== undefined;
    const edit = measureEdit();
    lastEditKey = edit ? `${edit.id}:${edit.a}:${edit.h}` : "";
    const snapshot = api.selection.getSnapshot();
    const signal: CanvasSignal = {
      b: blockId,
      ids: [...snapshot.ids],
      ...(snapshot.edgeIds.length ? { eids: [...snapshot.edgeIds] } : {}),
      ...(frames ? { frames } : {}),
      ...(edit ? { edit } : {}),
      n: Date.now(),
    };
    // Identical signal, no ship: the sampler runs on a clock, not on change,
    // and a pointer held still (or an open label bracket) would otherwise
    // heartbeat the same geometry through the transport every sample.
    const key = JSON.stringify({ ...signal, n: 0 });
    if (key === lastShipped) return;
    lastShipped = key;
    awareness.setLocalStateField("canvas", signal);
  };

  announce(false);

  // The selection store also notifies for hover, which is not broadcast —
  // re-announce only when what we would say has changed, or every pixel of
  // mouse travel becomes an awareness heartbeat.
  let lastSelKey = selectionKey(api);
  const unsubSelection = api.selection.subscribe(() => {
    const key = selectionKey(api);
    if (key === lastSelKey) return;
    lastSelKey = key;
    announce(false);
  });

  // The caret moves without the canvas selection changing — follow the DOM
  // selection itself, and the input stream for the offsets typing shifts.
  // Re-announced only when the signal actually differs; `selectionchange`
  // fires document-wide.
  const onCaret = () => {
    const edit = measureEdit();
    const key = edit ? `${edit.id}:${edit.a}:${edit.h}` : "";
    if (key !== lastEditKey) announce(lastHadFrames);
  };
  document.addEventListener("selectionchange", onCaret);

  // The drag sampler. "Mid-gesture" cannot be read from the store — a plain
  // move drag is one op at its end, and per-frame work only touches the DOM —
  // so the pointer itself is the signal: while it is down on this canvas, the
  // selection's live boxes are sampled off the DOM; the release announcement
  // drops the frames. Bracketed gestures (sliders, resizes) count too.
  let pointerDown = false;
  const container = api.viewport.containerRef.current;
  const onDown = () => {
    pointerDown = true;
  };
  const onUp = () => {
    pointerDown = false;
  };
  container?.addEventListener("pointerdown", onDown, { capture: true });
  container?.addEventListener("input", onCaret, true);
  container?.addEventListener("focusout", onCaret, true);
  window.addEventListener("pointerup", onUp, { capture: true });
  window.addEventListener("pointercancel", onUp, { capture: true });

  const sampler = setInterval(() => {
    if (pointerDown || api.store.gesturing()) announce(true);
    else if (lastHadFrames) announce(false);
  }, SAMPLE_MS);

  return () => {
    unsubSelection();
    clearInterval(sampler);
    document.removeEventListener("selectionchange", onCaret);
    container?.removeEventListener("pointerdown", onDown, { capture: true });
    container?.removeEventListener("input", onCaret, true);
    container?.removeEventListener("focusout", onCaret, true);
    window.removeEventListener("pointerup", onUp, { capture: true });
    window.removeEventListener("pointercancel", onUp, { capture: true });
    awareness.setLocalStateField("canvas", null);
  };
}

function selectionKey(api: Api): string {
  const s = api.selection.getSnapshot();
  return `${s.ids.join(",")}|${s.edgeIds.join(",")}`;
}

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

type RemoteUser = { name?: string; color?: string };

type Box = { x: number; y: number; w: number; h: number };

const SVG = "http://www.w3.org/2000/svg";

// A signal is another CLIENT's word, not this codebase's: everything read
// from awareness is validated at the boundary, and anything malformed
// degrades to "paint nothing" — never to NaN styles or a crash.

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === "string")
        .slice(0, MAX_GHOSTS)
    : [];

const finiteBox = (box: Box | undefined): Box | undefined =>
  box &&
  Number.isFinite(box.x) &&
  Number.isFinite(box.y) &&
  Number.isFinite(box.w) &&
  Number.isFinite(box.h)
    ? box
    : undefined;

const editOf = (edit: CanvasSignal["edit"]): CanvasSignal["edit"] =>
  edit &&
  typeof edit.id === "string" &&
  Number.isFinite(edit.a) &&
  Number.isFinite(edit.h)
    ? edit
    : undefined;

const nameOf = (user: RemoteUser): string =>
  typeof user.name === "string" && user.name ? user.name : "Someone";

const colorOf = (user: RemoteUser): string =>
  typeof user.color === "string" && user.color ? user.color : "var(--muted)";

export function paintCanvasPresence(
  awareness: Awareness,
  selfClientId: number,
  blockId: string,
  api: Api,
): () => void {
  let leaves: HTMLDivElement | null = null;
  let ghosts: HTMLDivElement | null = null;
  let halos: SVGSVGElement | null = null;

  /** Who the last paint put on this diagram — the repaint gates below. */
  let painted = new Set<number>();
  /** Whether any chrome measured off the DOM (carets, halos) is up. */
  let domDerived = false;

  /**
   * The keyed children, kept across paints. Reuse is what lets a ghost's
   * transition run: the same element gets a new transform and glides, where a
   * rebuilt one would snap — and a leaf's entrance animation plays once, on
   * arrival, instead of on every awareness tick.
   */
  const kept = new Map<string, Element>();
  const alive = new Set<string>();

  const claim = <T extends Element>(key: string, make: () => T): T => {
    alive.add(key);
    let el = kept.get(key) as T | undefined;
    if (!el || !el.isConnected) {
      el = make();
      kept.set(key, el);
    }
    return el;
  };

  /** Attach after styling, so a fresh element paints in place, untransitioned. */
  const attach = (el: Element, parent: Element, before: Element | null = null) => {
    if (el.parentNode !== parent) parent.insertBefore(el, before);
  };

  /** A caret moved or typed: fly its name flag, and fold it after stillness. */
  const idles = new Map<Element, ReturnType<typeof setTimeout>>();
  const settle = (el: Element) => {
    el.classList.remove("is-idle");
    const timer = idles.get(el);
    if (timer !== undefined) clearTimeout(timer);
    idles.set(
      el,
      setTimeout(() => {
        el.classList.add("is-idle");
        idles.delete(el);
      }, CARET_IDLE_MS),
    );
  };

  const prune = () => {
    for (const [key, el] of kept) {
      if (alive.has(key)) continue;
      const timer = idles.get(el);
      if (timer !== undefined) {
        clearTimeout(timer);
        idles.delete(el);
      }
      el.remove();
      kept.delete(key);
    }
    alive.clear();
  };

  const mounts = () => {
    const container = api.viewport.containerRef.current;
    const layer = api.viewport.sceneRef.current;
    if (!container || !layer) return null;
    if (!leaves || !leaves.isConnected) {
      leaves?.remove();
      leaves = document.createElement("div");
      leaves.className = "nt-canvas-leaves";
      leaves.setAttribute("aria-hidden", "true");
      container.appendChild(leaves);
    }
    if (!ghosts || !ghosts.isConnected) {
      ghosts?.remove();
      ghosts = document.createElement("div");
      ghosts.className = "nt-copresence";
      ghosts.setAttribute("aria-hidden", "true");
      halos = document.createElementNS(SVG, "svg");
      halos.setAttribute("class", "nt-copresence-edges");
      ghosts.appendChild(halos);
      layer.appendChild(ghosts);
      syncScale();
    }
    return { leaves, ghosts, halos: halos!, layer };
  };

  // Ghost chrome — outline weight, caret bar, name flag — holds its screen
  // size at any zoom, the same `--k` bargain the selection overlay strikes.
  // One property on the mount; the geometry itself is scene px and needs
  // nothing on a zoom.
  const syncScale = () => {
    const zoom = api.viewport.get().zoom || 1;
    ghosts?.style.setProperty("--k", String(1 / zoom));
  };

  /**
   * An in-flight drag box arrives as an axis-aligned bound (the broadcaster
   * measures the DOM). For a rotated shape that bound is not the shape — so
   * when the local model's box, spun by its rotation, agrees with the bound,
   * the exact rotated frame is reconstructed about the same centre. A move
   * drag keeps size and rotation, so it agrees; mid-resize and mid-rotate it
   * will not, and the honest bound paints instead.
   */
  const rectify = (
    scene: Scene,
    id: string,
    frame: Box,
  ): { frame: Box; rot: number } => {
    const node = findNode(scene, id);
    const rot = node ? absoluteRotation(scene, id) : 0;
    if (!node || !rot) return { frame, rot: 0 };
    const r = (rot * Math.PI) / 180;
    const cos = Math.abs(Math.cos(r));
    const sin = Math.abs(Math.sin(r));
    const w = node.w * cos + node.h * sin;
    const h = node.w * sin + node.h * cos;
    if (Math.abs(w - frame.w) > 1.5 || Math.abs(h - frame.h) > 1.5) {
      return { frame, rot: 0 };
    }
    return {
      frame: {
        x: frame.x + (frame.w - node.w) / 2,
        y: frame.y + (frame.h - node.h) / 2,
        w: node.w,
        h: node.h,
      },
      rot,
    };
  };

  const update = () => {
    const mounted = mounts();
    if (!mounted) return;
    type Here = {
      clientId: number;
      user: RemoteUser;
      ids: string[];
      eids: string[];
      frames?: CanvasSignal["frames"];
      edit?: CanvasSignal["edit"];
    };
    const here: Here[] = [];
    for (const [clientId, state] of awareness.getStates()) {
      if (clientId === selfClientId) continue;
      const signal = (state as { canvas?: CanvasSignal | null }).canvas;
      if (!signal || signal.b !== blockId) continue;
      here.push({
        clientId,
        user: ((state as { user?: RemoteUser }).user ?? {}) as RemoteUser,
        ids: strings(signal.ids),
        eids: strings(signal.eids),
        frames: signal.frames,
        edit: editOf(signal.edit),
      });
    }
    here.sort((a, b) => a.clientId - b.clientId);

    // Leaves: one per person, stacking (and wrapping) from the corner.
    // Existing leaves stay put — re-inserting them would replay the entrance.
    for (const { clientId, user } of here) {
      const leaf = claim(`l:${clientId}`, () => {
        const el = document.createElement("span");
        el.className = "nt-canvas-leaf";
        el.dataset.client = String(clientId);
        return el;
      });
      const name = nameOf(user);
      if (leaf.textContent !== name) leaf.textContent = name;
      leaf.style.background = colorOf(user);
      if (leaf.parentNode !== mounted.leaves) {
        let before: Element | null = null;
        for (const other of mounted.leaves.children) {
          if (Number((other as HTMLElement).dataset.client) > clientId) {
            before = other;
            break;
          }
        }
        attach(leaf, mounted.leaves, before);
      }
    }

    // Ghost outlines: their selections — at live drag frames when present,
    // else at the shape's own place in the model, rotation and all, exactly
    // where the local selection frame would draw it.
    const scene = laidOutScene(api.store.getScene());
    const showing = (id: string) => {
      const chain = nodePath(scene, id);
      return chain.length > 0 && !chain.some((node) => node.hidden);
    };
    for (const { clientId, user, ids, eids, frames, edit } of here) {
      const color = colorOf(user);
      if (edit && showing(edit.id)) {
        paintCaret(api, mounted.layer, mounted.ghosts, edit, clientId, user, {
          claim,
          attach,
          settle,
        });
      }
      for (const id of ids) {
        const inFlight = finiteBox(frames?.[id]);
        let frame: Box;
        let rot: number;
        if (inFlight) {
          ({ frame, rot } = rectify(scene, id, inFlight));
        } else {
          // The whole chain: a shape inside a hidden group paints nothing,
          // and a ghost around nothing would be a phantom.
          if (!showing(id)) continue;
          frame = absoluteRect(scene, id);
          rot = absoluteRotation(scene, id);
        }
        const box = claim(`g:${clientId}:${id}`, () => {
          const el = document.createElement("div");
          el.className = "nt-copresence-ghost";
          return el;
        });
        box.style.width = `${frame.w}px`;
        box.style.height = `${frame.h}px`;
        box.style.transform = `translate(${frame.x}px, ${frame.y}px)${
          rot ? ` rotate(${rot}deg)` : ""
        }`;
        box.style.setProperty("--copresence", color);
        attach(box, mounted.ghosts);
      }
      // Selected connectors: a soft halo along the line, in their colour —
      // the path is read from the rendered edge, so re-routes carry it.
      for (const id of eids) {
        const d = mounted.layer
          .querySelector(`.nt-edge-line[data-edge="${CSS.escape(id)}"]`)
          ?.getAttribute("d");
        if (!d) continue;
        const halo = claim(`e:${clientId}:${id}`, () =>
          document.createElementNS(SVG, "path"),
        );
        if (halo.getAttribute("d") !== d) halo.setAttribute("d", d);
        halo.style.setProperty("--copresence", color);
        attach(halo, mounted.halos);
      }
    }
    prune();
    painted = new Set(here.map((person) => person.clientId));
    domDerived = here.some(
      (person) => person.edit !== undefined || person.eids.length > 0,
    );
  };

  update();

  // Awareness speaks for the whole page — every text caret in the document
  // rides the same channel — so repaint only when a change concerns THIS
  // diagram: someone painted here, or someone whose signal now names it.
  const onAwareness = (changes: {
    added: number[];
    updated: number[];
    removed: number[];
  }) => {
    const states = awareness.getStates();
    const concerns = (clientId: number) =>
      clientId !== selfClientId &&
      (painted.has(clientId) ||
        (states.get(clientId) as { canvas?: CanvasSignal | null } | undefined)
          ?.canvas?.b === blockId);
    if (
      changes.added.some(concerns) ||
      changes.updated.some(concerns) ||
      changes.removed.some(concerns)
    ) {
      update();
    }
  };
  awareness.on("update", onAwareness);

  // Shapes move under standing selections too — follow the scene, but only
  // while somebody is painted; alone, every keystroke would repaint nothing.
  // The store notifies before React commits the label runs and edge paths the
  // caret and halo measure, so those paint once more on the next frame.
  let raf = 0;
  const followUp = () => {
    if (!domDerived || raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      update();
    });
  };
  const unsubScene = api.store.subscribe(() => {
    if (painted.size === 0) return;
    update();
    followUp();
  });
  const unsubViewport = api.viewport.subscribe(syncScale);
  // And a label's DOM shifts under a painted caret as the local hand types.
  const onLabelInput = () => {
    if (domDerived) update();
  };
  const container = api.viewport.containerRef.current;
  container?.addEventListener("input", onLabelInput, true);

  return () => {
    awareness.off("update", onAwareness);
    unsubScene();
    unsubViewport();
    if (raf) cancelAnimationFrame(raf);
    container?.removeEventListener("input", onLabelInput, true);
    for (const timer of idles.values()) clearTimeout(timer);
    idles.clear();
    leaves?.remove();
    ghosts?.remove();
    kept.clear();
  };
}

// ---------------------------------------------------------------------------
// The label caret, painted
// ---------------------------------------------------------------------------

type Keyed = {
  claim: <T extends Element>(key: string, make: () => T) => T;
  attach: (el: Element, parent: Element) => void;
  settle: (el: Element) => void;
};

/**
 * One person's label selection, resolved against the local label DOM — the
 * rendered runs or, if this client has the same label open, its editable —
 * and painted as the main editor paints theirs: a name-flagged caret at the
 * head, translucent boxes over the selected words.
 */
function paintCaret(
  api: Api,
  layer: HTMLDivElement,
  mount: HTMLDivElement,
  edit: NonNullable<CanvasSignal["edit"]>,
  clientId: number,
  user: RemoteUser,
  { claim, attach, settle }: Keyed,
) {
  const color = colorOf(user);
  const shape = layer.querySelector<HTMLElement>(
    `[data-id="${CSS.escape(edit.id)}"]`,
  );
  const label = shape?.querySelector(":scope > .nt-edit, :scope > .nt-label");
  if (!label) return;
  const toScene = (r: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }): Box => {
    const a = api.viewport.clientToScene({ x: r.left, y: r.top });
    const b = api.viewport.clientToScene({ x: r.right, y: r.bottom });
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  };

  const [from, to] = edit.a <= edit.h ? [edit.a, edit.h] : [edit.h, edit.a];
  if (from !== to) {
    const range = document.createRange();
    const start = pointAt(label, from);
    const end = pointAt(label, to);
    try {
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
    } catch {
      return;
    }
    let i = 0;
    for (const rect of range.getClientRects()) {
      if (rect.width < 0.5 && rect.height < 0.5) continue;
      const f = toScene(rect);
      const hl = claim(`h:${clientId}:${edit.id}:${i++}`, () => {
        const el = document.createElement("div");
        el.className = "nt-copresence-hl";
        return el;
      });
      hl.style.transform = `translate(${f.x}px, ${f.y}px)`;
      hl.style.width = `${f.w}px`;
      hl.style.height = `${f.h}px`;
      hl.style.setProperty("--copresence", color);
      attach(hl, mount);
    }
  }

  const rect = caretRectAt(label, edit.h);
  if (!rect) return;
  const f = toScene(rect);
  const caret = claim(`c:${clientId}:${edit.id}`, () => {
    const el = document.createElement("div");
    el.className = "nt-copresence-caret";
    el.appendChild(document.createElement("span")).className =
      "nt-copresence-caret-name";
    return el;
  });
  caret.style.transform = `translate(${f.x}px, ${f.y}px)`;
  caret.style.height = `${f.h}px`;
  caret.style.setProperty("--copresence", color);
  const name = caret.firstElementChild as HTMLElement;
  const text = nameOf(user);
  if (name.textContent !== text) name.textContent = text;
  // Repaints land here on every awareness tick; only actual movement — the
  // hand typing or travelling — re-flies the flag.
  const sig = `${edit.a}:${edit.h}:${Math.round(f.x)}:${Math.round(f.y)}`;
  if (caret.dataset.sig !== sig) {
    caret.dataset.sig = sig;
    settle(caret);
  }
  attach(caret, mount);
}

/**
 * Where a collapsed range at this offset paints. A position between elements
 * (after a chip, on an empty label) measures as no rect at all, so those lean
 * on a neighbour's edge, and an empty label on the label box itself.
 */
function caretRectAt(label: Element, offset: number): DOMRect | null {
  const p = pointAt(label, offset);
  const range = document.createRange();
  try {
    range.setStart(p.node, p.offset);
  } catch {
    return null;
  }
  range.collapse(true);
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (rect && rect.height > 0.5) return rect;
  if (p.node.nodeType === 1) {
    const el = p.node as Element;
    const edgeOf = (n: Node | undefined, side: "right" | "left") => {
      if (!n || n.nodeType !== 1) return null;
      const r = (n as Element).getBoundingClientRect();
      if (r.height <= 0.5) return null;
      return new DOMRect(side === "right" ? r.right : r.left, r.top, 0, r.height);
    };
    const leaned =
      edgeOf(el.childNodes[p.offset - 1], "right") ??
      edgeOf(el.childNodes[p.offset], "left");
    if (leaned) return leaned;
  }
  const box = label.getBoundingClientRect();
  if (box.height > 0.5) return new DOMRect(box.left, box.top, 0, Math.min(box.height, 20));
  // An empty label has no line box to measure at all — not even a height.
  // Borrow one: a zero-width space knows where the first glyph would paint.
  const probe = document.createTextNode("\u200b");
  label.appendChild(probe);
  range.selectNode(probe);
  const borrowed = range.getBoundingClientRect();
  probe.remove();
  return borrowed.height > 0.5
    ? new DOMRect(borrowed.left, borrowed.top, 0, borrowed.height)
    : null;
}
