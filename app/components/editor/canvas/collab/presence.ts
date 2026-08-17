import type { Awareness } from "y-protocols/awareness";
import type { Point } from "../scene/types";
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
 * a single shape.
 */

export type CanvasSignal = {
  /** The diagram this person's shell is on. */
  b: string;
  ids: string[];
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
    getSnapshot(): { ids: readonly string[] };
  };
  store: { gesturing(): boolean; subscribe(cb: () => void): () => void };
  viewport: {
    containerRef: { current: HTMLDivElement | null };
    sceneRef: { current: HTMLDivElement | null };
    clientToScene(point: Point): Point;
  };
};

/** Drag sampling cadence — presence-grade, far under gesture frame rate. */
const SAMPLE_MS = 90;

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
    let any = false;
    for (const id of api.selection.getSnapshot().ids) {
      const el = layer.querySelector<HTMLElement>(
        `[data-id="${CSS.escape(id)}"]`,
      );
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const a = api.viewport.clientToScene({ x: rect.left, y: rect.top });
      const b = api.viewport.clientToScene({ x: rect.right, y: rect.bottom });
      frames[id] = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
      any = true;
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
  const announce = (withFrames: boolean) => {
    const frames = withFrames ? measure() : undefined;
    lastHadFrames = frames !== undefined;
    const edit = measureEdit();
    lastEditKey = edit ? `${edit.id}:${edit.a}:${edit.h}` : "";
    awareness.setLocalStateField("canvas", {
      b: blockId,
      ids: [...api.selection.getSnapshot().ids],
      ...(frames ? { frames } : {}),
      ...(edit ? { edit } : {}),
      n: Date.now(),
    } satisfies CanvasSignal);
  };

  announce(false);
  const unsubSelection = api.selection.subscribe(() => announce(false));

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

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

type RemoteUser = { name?: string; color?: string };

export function paintCanvasPresence(
  awareness: Awareness,
  selfClientId: number,
  blockId: string,
  api: Api,
): () => void {
  let leaves: HTMLDivElement | null = null;
  let ghosts: HTMLDivElement | null = null;

  const mounts = () => {
    const container = api.viewport.containerRef.current;
    const layer = api.viewport.sceneRef.current;
    if (!container || !layer) return null;
    if (!leaves || !leaves.isConnected) {
      leaves?.remove();
      leaves = document.createElement("div");
      leaves.className = "nt-canvas-leaves";
      container.appendChild(leaves);
    }
    if (!ghosts || !ghosts.isConnected) {
      ghosts?.remove();
      ghosts = document.createElement("div");
      ghosts.className = "nt-copresence";
      layer.appendChild(ghosts);
    }
    return { leaves, ghosts, layer };
  };

  const update = () => {
    const mounted = mounts();
    if (!mounted) return;
    type Here = {
      clientId: number;
      user: RemoteUser;
      ids: string[];
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
        ids: signal.ids ?? [],
        frames: signal.frames,
        edit: signal.edit,
      });
    }
    here.sort((a, b) => a.clientId - b.clientId);

    // Leaves: one per person, stacking (and wrapping) from the corner.
    mounted.leaves.replaceChildren(
      ...here.map(({ clientId, user }) => {
        const leaf = document.createElement("span");
        leaf.className = "nt-canvas-leaf";
        leaf.textContent = user.name ?? "Someone";
        leaf.style.background = user.color ?? "var(--muted)";
        leaf.dataset.client = String(clientId);
        return leaf;
      }),
    );

    // Ghost outlines: their selections, at live drag frames when present,
    // else at the shape's current place.
    const boxes: HTMLElement[] = [];
    for (const { user, ids, frames, edit } of here) {
      if (edit) paintCaret(api, mounted.layer, edit, user, boxes);
      for (const id of ids) {
        let frame = frames?.[id];
        if (!frame) {
          const el = mounted.layer.querySelector<HTMLElement>(
            `[data-id="${CSS.escape(id)}"]`,
          );
          if (!el) continue;
          const rect = el.getBoundingClientRect();
          const a = api.viewport.clientToScene({ x: rect.left, y: rect.top });
          const b = api.viewport.clientToScene({
            x: rect.right,
            y: rect.bottom,
          });
          frame = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
        }
        const box = document.createElement("div");
        box.className = "nt-copresence-ghost";
        box.style.left = `${frame.x}px`;
        box.style.top = `${frame.y}px`;
        box.style.width = `${frame.w}px`;
        box.style.height = `${frame.h}px`;
        box.style.setProperty("--copresence", user.color ?? "var(--muted)");
        boxes.push(box);
      }
    }
    mounted.ghosts.replaceChildren(...boxes);
  };

  update();
  const onAwareness = () => update();
  awareness.on("update", onAwareness);
  // Shapes move under standing selections too — follow the scene.
  const unsubScene = api.store.subscribe(() => update());
  // And a label's DOM shifts under a painted caret as the local hand types.
  const container = api.viewport.containerRef.current;
  container?.addEventListener("input", onAwareness, true);

  return () => {
    awareness.off("update", onAwareness);
    unsubScene();
    container?.removeEventListener("input", onAwareness, true);
    leaves?.remove();
    ghosts?.remove();
  };
}

// ---------------------------------------------------------------------------
// The label caret, painted
// ---------------------------------------------------------------------------

/**
 * One person's label selection, resolved against the local label DOM — the
 * rendered runs or, if this client has the same label open, its editable —
 * and painted as the main editor paints theirs: a name-flagged caret at the
 * head, translucent boxes over the selected words.
 */
function paintCaret(
  api: Api,
  layer: HTMLDivElement,
  edit: NonNullable<CanvasSignal["edit"]>,
  user: RemoteUser,
  out: HTMLElement[],
) {
  const shape = layer.querySelector<HTMLElement>(
    `[data-id="${CSS.escape(edit.id)}"]`,
  );
  const label = shape?.querySelector(":scope > .nt-edit, :scope > .nt-label");
  if (!label) return;
  const color = user.color ?? "var(--muted)";
  const toScene = (r: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }) => {
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
    for (const rect of range.getClientRects()) {
      if (rect.width < 0.5 && rect.height < 0.5) continue;
      const f = toScene(rect);
      const hl = document.createElement("div");
      hl.className = "nt-copresence-hl";
      hl.style.left = `${f.x}px`;
      hl.style.top = `${f.y}px`;
      hl.style.width = `${f.w}px`;
      hl.style.height = `${f.h}px`;
      hl.style.setProperty("--copresence", color);
      out.push(hl);
    }
  }

  const rect = caretRectAt(label, edit.h);
  if (!rect) return;
  const f = toScene(rect);
  const caret = document.createElement("div");
  caret.className = "nt-copresence-caret";
  caret.style.left = `${f.x}px`;
  caret.style.top = `${f.y}px`;
  caret.style.height = `${f.h}px`;
  caret.style.setProperty("--copresence", color);
  const name = document.createElement("span");
  name.className = "nt-copresence-caret-name";
  name.textContent = user.name ?? "Someone";
  caret.append(name);
  out.push(caret);
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
