import { track } from "@/app/lib/telemetry";
import { COLUMN_WIDTH } from "@/app/lib/column";
import { effectiveScale, fitOf } from "@/app/lib/columnScale";
import type { LiveEditor } from "@/app/components/editor/EditorRegistry";
import type { CanvasTool } from "../engine/shortcuts";
import { defaultBox, newNode, type DrawKind } from "../render/newShape";
import { BAND, bandFloor, bandLeft, bandWidth, EMPTY_BAND_H } from "../scene/band";
import { emptyScene } from "../scene/migrate";
import { mintId, mintIds } from "../scene/ops";
import { serializeScene } from "../scene/serialize";
import type { ImageNode, Point, Rect, Scene, SceneNode, SceneOp } from "../scene/types";
import { pageScope } from "./lifecycle";
import type { DiagramEntry, PageCanvas } from "./PageCanvas";

/**
 * Drawing on the page itself.
 *
 * Arm a shape on the page's bar and a drag anywhere on the page draws it. A
 * press on a diagram is that diagram's own draw. One just outside a diagram —
 * in the band's width of room above or below it, or beside it — lands in that
 * diagram, through its store, which grows to hold the shape. Anywhere else a
 * diagram is made where the drag began: in place of an empty line, or before
 * or after the block it began over, by which half. What was drawn settles
 * into its new home.
 *
 * It is an insertion, never an annotation: a shape lives only inside a canvas
 * block. And it is made the way the slash menu makes one — a canvas block
 * whose scene holds the same `newNode` the canvas's own tools make — so
 * nothing here is a path the assistant could not also take.
 *
 * The pen draws on the page too, by handing its first point to a diagram's
 * own pen: the one it landed in or beside, or one made for it. A file dropped
 * on a diagram becomes a picture in it.
 */

/** The tools that draw on the page by dragging. Text and connectors need a diagram. */
const PAGE_KINDS: ReadonlySet<CanvasTool> = new Set(["rect", "ellipse", "polygon", "diamond"]);

export type Box = { x: number; y: number; w: number; h: number };

/** A top-level block, in client px. */
export type BlockBox = { id: string; top: number; bottom: number };

/** A diagram's band, in client px, and client px per band px. */
export type BandBox = { blockId: string; left: number; top: number; right: number; bottom: number; scale: number };

/** Below this a drag was a click, and the shape takes the canvas's own size. */
const DRAWN_MIN = 4;

// ---------------------------------------------------------------------------
// Where a draw lands
// ---------------------------------------------------------------------------

/**
 * The diagram a draw that began at `origin` outside every band belongs to.
 * Begun within a band's width of room above or below one (the nearest, when
 * two are that close), it is that diagram's. Drawn wholly beside one, between
 * its top and bottom, it is part of that diagram's picture rather than the
 * start of another underneath it.
 */
export function landingIn(
  bands: readonly BandBox[],
  box: Box,
  origin: Point,
): { blockId: string; how: "gap" | "beside" } | null {
  let gap: string | null = null;
  let nearest = Infinity;
  for (const band of bands) {
    if (origin.x < band.left || origin.x > band.right) continue;
    const off = origin.y < band.top ? band.top - origin.y : origin.y - band.bottom;
    if (off > 0 && off <= BAND * band.scale && off < nearest) {
      gap = band.blockId;
      nearest = off;
    }
  }
  if (gap) return { blockId: gap, how: "gap" };
  for (const band of bands) {
    const within = box.y >= band.top && box.y + box.h <= band.bottom;
    const beside = box.x >= band.right || box.x + box.w <= band.left;
    if (within && beside) return { blockId: band.blockId, how: "beside" };
  }
  return null;
}

/**
 * Where a new diagram drawn from `y` goes: in place of the empty line it was
 * drawn on, or else before or after the top-level block it was drawn
 * against, whichever half of it the drag began in. Drawn past the last block
 * counts as drawn on it — that is where the next line would go. `replace`
 * off keeps the empty line, below the diagram.
 */
export function placeNew(
  blocks: Iterable<BlockBox>,
  y: number,
  isEmpty: (id: string) => boolean,
  { replace = true }: { replace?: boolean } = {},
): { ref: string; where: "before" | "after" | "replace" } | null {
  let last: BlockBox | null = null;
  for (const block of blocks) {
    last = block;
    if (y >= block.bottom) continue;
    const on = y >= block.top;
    if (on && isEmpty(block.id)) return { ref: block.id, where: replace ? "replace" : "before" };
    return { ref: block.id, where: y < block.top + (block.bottom - block.top) / 2 ? "before" : "after" };
  }
  if (!last) return null;
  if (isEmpty(last.id)) return { ref: last.id, where: replace ? "replace" : "before" };
  return { ref: last.id, where: "after" };
}

/**
 * The scene a diagram drawn with one shape starts as: the shape where it was
 * drawn across the column, moved only if it was drawn past the text's left
 * edge and the diagram made wide if it runs past its right; down, a band
 * below the top — the block goes between lines, so where it lands vertically
 * is the block's to decide anyway. `box` is in the column's px; the id is
 * minted against `scope`, the page's.
 */
export function sceneFor(kind: DrawKind, box: Rect, scope: Scene = emptyScene()): { scene: Scene; nodeId: string } {
  const nodeId = mintId(scope);
  const x = Math.max(0, Math.round(box.x));
  const w = Math.round(box.w);
  const drawn: Scene = {
    ...emptyScene(),
    nodes: [newNode(kind, nodeId, { x, y: BAND, w, h: Math.round(box.h) })],
    ...(x + w > COLUMN_WIDTH ? { wide: true as const } : {}),
  };
  return { scene: { ...drawn, h: bandFloor(drawn) }, nodeId };
}

/**
 * The ops that put a node drawn at its box into `scene`: the diagram made
 * wide when it runs past the column, and the node moved — never resized —
 * into the band and below its top. The band's store raises the height.
 */
export function landOps(scene: Scene, node: SceneNode): SceneOp[] {
  const past = node.x < 0 || node.x + node.w > COLUMN_WIDTH;
  const widen = past && !scene.wide;
  const min = bandLeft({ wide: scene.wide || widen });
  const max = min + bandWidth({ wide: scene.wide || widen });
  const placed = {
    ...node,
    x: Math.round(Math.max(min, Math.min(max - node.w, node.x))),
    y: Math.round(Math.max(0, node.y)),
  };
  return [...(widen ? [{ type: "setDiagram", wide: true } as const] : []), { type: "insert", nodes: [placed] }];
}

// ---------------------------------------------------------------------------
// Reading the page
// ---------------------------------------------------------------------------

/** The page's top-level blocks, read one at a time so a search can stop early. */
function* blockBoxes(editor: LiveEditor): Generator<BlockBox> {
  const group = (editor.domElement as HTMLElement | undefined)?.querySelector(":scope > .bn-block-group");
  for (const outer of group?.children ?? []) {
    const id = (outer as HTMLElement).dataset.id;
    if (!id) continue;
    const r = outer.getBoundingClientRect();
    yield { id, top: r.top, bottom: r.bottom };
  }
}

const outerOf = (editor: LiveEditor, id: string) =>
  (editor.domElement as HTMLElement | undefined)?.querySelector<HTMLElement>(`.bn-block-outer[data-id="${CSS.escape(id)}"]`) ?? null;

/** An empty paragraph, as BlockNote itself tells one: nothing but its trailing break. */
function isEmptyLine(editor: LiveEditor, id: string): boolean {
  return !!outerOf(editor, id)?.querySelector(
    ':scope > .bn-block > .bn-block-content[data-content-type="paragraph"] .ProseMirror-trailingBreak:only-child',
  );
}

/**
 * The text column a diagram made at `ref` stands in: its left edge, and the
 * scale a band is drawn at there — the document's zoom, and the column's fit.
 */
function columnAt(editor: LiveEditor, ref: string): { left: number; scale: number; width: number } | null {
  const content = outerOf(editor, ref)?.querySelector<HTMLElement>(
    ":scope > .bn-block > .bn-block-content, :scope > .bn-block > .react-renderer > .bn-block-content",
  );
  if (!content) return null;
  const r = content.getBoundingClientRect();
  const scale = effectiveScale(content) * fitOf(content, "normal");
  return { left: r.left, scale, width: COLUMN_WIDTH * scale };
}

/** Every id on the page, to mint against. */
const scopeOf = (canvas: PageCanvas) => pageScope(canvas.entries().map((entry) => entry.api.store.getScene()));

function bandBoxes(canvas: PageCanvas): BandBox[] {
  const out: BandBox[] = [];
  for (const entry of canvas.entries()) {
    const band = entry.readOnly ? null : entry.api.band.current;
    if (!band) continue;
    const r = band.getBoundingClientRect();
    out.push({
      blockId: entry.blockId,
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      scale: band.offsetHeight ? r.height / band.offsetHeight : 1,
    });
  }
  return out;
}

const entryAt = (canvas: PageCanvas, target: EventTarget | null): DiagramEntry | null =>
  target instanceof Node
    ? (canvas.entries().find((entry) => !entry.readOnly && entry.api.band.current?.contains(target)) ?? null)
    : null;

/** Puts a diagram with this source where `place` says. Returns its block id. */
function insertDiagram(
  editor: LiveEditor,
  place: { ref: string; where: "before" | "after" | "replace" },
  data: string,
): string {
  track("block_created", { type: "canvas" });
  // An empty line is taken out rather than turned into the diagram: a block
  // that changes kind is not a change every reader of the page can follow.
  return editor.transact(() => {
    const where = place.where === "replace" ? "before" : place.where;
    const [made] = editor.insertBlocks([{ type: "canvas", props: { data } }], place.ref, where);
    if (place.where === "replace") editor.removeBlocks([place.ref]);
    return made.id as string;
  });
}

// ---------------------------------------------------------------------------
// What the pointer sees before it presses
// ---------------------------------------------------------------------------

/**
 * While a tool that draws is in hand: the band a draw would land in, outlined
 * as the band's own hover is, and where a new diagram would go, a thin line
 * between the blocks. Neutral, both: it is where, not an answer to anything.
 */
function createPreview(canvas: PageCanvas) {
  let outlined: HTMLElement | null = null;
  let line: HTMLElement | null = null;
  const outline = (band: HTMLElement | null) => {
    if (outlined === band) return;
    outlined?.removeAttribute("data-target");
    outlined = band;
    band?.setAttribute("data-target", "");
  };
  const showLine = (at: { left: number; top: number; width: number } | null) => {
    if (!at) {
      line?.remove();
      line = null;
      return;
    }
    if (!line) {
      line = document.createElement("div");
      line.className = "nt-page-insert";
      document.body.append(line);
    }
    line.style.left = `${at.left}px`;
    line.style.top = `${at.top}px`;
    line.style.width = `${at.width}px`;
  };
  return {
    /** For a draw at `box` begun at `origin` — the pointer alone, before the press. */
    show(box: Box, origin: Point, over: EventTarget | null) {
      const on = entryAt(canvas, over);
      const hit = on ? null : landingIn(bandBoxes(canvas), box, origin);
      const into = on ?? (hit ? (canvas.get(hit.blockId) ?? null) : null);
      outline(into?.api.band.current ?? null);
      if (into) return showLine(null);
      const editor = canvas.editor();
      const place = editor ? placeNew(blockBoxes(editor), origin.y, (id) => isEmptyLine(editor, id)) : null;
      const column = editor && place ? columnAt(editor, place.ref) : null;
      const outer = editor && place ? outerOf(editor, place.ref) : null;
      if (!place || !column || !outer) return showLine(null);
      const r = outer.getBoundingClientRect();
      showLine({ left: column.left, width: column.width, top: place.where === "after" ? r.bottom : r.top });
    },
    clear() {
      outline(null);
      showLine(null);
    },
  };
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const POINTS: Partial<Record<DrawKind, string>> = {
  polygon: "50,1 99,99 1,99",
  diamond: "50,1 99,50 50,99 1,50",
};

/** The drawn-so-far shape, over the page: the shape itself, its frame, its size. */
function makeGhost(kind: DrawKind): { el: HTMLElement; paint: (b: Box) => void } {
  const el = document.createElement("div");
  el.className = "nt-page-ghost";
  el.dataset.kind = kind;
  const points = POINTS[kind];
  if (points) {
    el.innerHTML = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon points="${points}" vector-effect="non-scaling-stroke"/></svg>`;
  }
  const chip = document.createElement("span");
  chip.className = "nt-page-ghost-chip";
  el.append(chip);
  document.body.append(el);
  return {
    el,
    paint: (b) => {
      el.style.left = `${b.x}px`;
      el.style.top = `${b.y}px`;
      el.style.width = `${b.w}px`;
      el.style.height = `${b.h}px`;
      chip.textContent = `${Math.round(b.w)} × ${Math.round(b.h)}`;
    },
  };
}

function normalise(a: Point, b: Point, square: boolean): Box {
  let w = b.x - a.x;
  let h = b.y - a.y;
  if (square) {
    const side = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * side;
    h = Math.sign(h || 1) * side;
  }
  return { x: Math.min(a.x, a.x + w), y: Math.min(a.y, a.y + h), w: Math.abs(w), h: Math.abs(h) };
}

/** Resolves with what `find` finds, polled a frame at a time, or null by `ms`. */
function when<T>(find: () => T | null, ms: number): Promise<T | null> {
  const until = performance.now() + ms;
  return new Promise((resolve) => {
    const look = () => {
      const found = find();
      if (found) return resolve(found);
      if (performance.now() > until) return resolve(null);
      requestAnimationFrame(look);
    };
    look();
  });
}

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    const step = (left: number) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve());
    step(n);
  });

/** The `--ease` family, so the settle moves like the rest of the page. */
const SETTLE = "cubic-bezier(0.25, 0, 0, 1)";

/** A press the page draws from, rather than one of its own controls or a diagram's. */
function pagePress(e: PointerEvent): boolean {
  if (e.button !== 0) return false;
  const target = e.target as Element;
  if (target.closest("button, a, input, textarea, select, [role='menu']")) return false;
  // A diagram — a canvas block or a storyboard's shot — draws for itself.
  return !target.closest(".nt-canvas");
}

/**
 * Into a diagram already on the page, through its store: one step of its
 * history, never a write of its block prop, which trails its edits by
 * seconds and would put back whatever it had not caught up with.
 */
function drawInto(entry: DiagramEntry, kind: DrawKind, drawn: Box, clicked: Point | null, scope: Scene): string {
  const { store, viewport } = entry.api;
  const a = viewport.clientToScene({ x: drawn.x, y: drawn.y });
  const b = viewport.clientToScene({ x: drawn.x + drawn.w, y: drawn.y + drawn.h });
  const box = clicked
    ? defaultBox(kind, viewport.clientToScene(clicked))
    : { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(b.x - a.x), h: Math.round(b.y - a.y) };
  const nodeId = mintId(scope);
  store.dispatch(landOps(store.getScene(), newNode(kind, nodeId, box)));
  return nodeId;
}

function armShapes(canvas: PageCanvas, pane: HTMLElement, kind: DrawKind): () => void {
  const tools = canvas.tools!;
  const preview = createPreview(canvas);
  let drawing = false;
  let hover = 0;
  let over: { point: Point; target: EventTarget | null } | null = null;

  const onHover = (e: PointerEvent) => {
    if (drawing) return;
    over = { point: { x: e.clientX, y: e.clientY }, target: e.target };
    if (hover) return;
    hover = requestAnimationFrame(() => {
      hover = 0;
      if (!over || drawing) return;
      preview.show({ ...over.point, w: 0, h: 0 }, over.point, over.target);
    });
  };
  const onLeave = () => {
    over = null;
    if (!drawing) preview.clear();
  };

  const onDown = (e: PointerEvent) => {
    if (!pagePress(e)) return;
    e.preventDefault();
    e.stopPropagation();
    drawing = true;
    const origin = { x: e.clientX, y: e.clientY };
    const ghost = makeGhost(kind);
    let box: Box = { ...origin, w: 0, h: 0 };
    let last = { ...origin };
    let square = false;
    let frame = 0;
    const paint = () => {
      frame = 0;
      box = normalise(origin, last, square);
      ghost.paint(box);
      preview.show(box, origin, null);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    paint();

    const onMove = (ev: PointerEvent) => {
      last = { x: ev.clientX, y: ev.clientY };
      square = ev.shiftKey;
      schedule();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        stop();
        ghost.el.remove();
        return;
      }
      if (ev.key === "Shift") {
        square = ev.type === "keydown";
        schedule();
      }
    };
    const stop = () => {
      drawing = false;
      preview.clear();
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
    const onUp = () => {
      if (frame) paint();
      stop();
      const clicked = box.w < DRAWN_MIN && box.h < DRAWN_MIN;
      const drawn = clicked ? defaultBox(kind, origin) : box;
      ghost.el.dataset.settling = "";
      ghost.paint(drawn);
      void land(drawn, origin, clicked, ghost.el);
    };

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
  };

  /** Into a diagram, or a new one made for it; then what was drawn settles there. */
  const land = async (drawn: Box, origin: Point, clicked: boolean, ghost: HTMLElement) => {
    tools.settle();
    let blockId: string;
    let nodeId: string;
    try {
      const hit = landingIn(bandBoxes(canvas), drawn, origin);
      const into = hit ? canvas.get(hit.blockId) : undefined;
      if (into) {
        nodeId = drawInto(into, kind, drawn, clicked ? origin : null, scopeOf(canvas));
        blockId = into.blockId;
      } else {
        const editor = canvas.editor();
        const place = editor && placeNew(blockBoxes(editor), drawn.y, (id) => isEmptyLine(editor, id));
        if (!editor || !place) throw new Error("the page has no editor to make a diagram in");
        const { left, scale } = columnAt(editor, place.ref) ?? { left: drawn.x, scale: 1 };
        const made = sceneFor(
          kind,
          clicked
            ? defaultBox(kind, { x: (origin.x - left) / scale, y: 0 })
            : { x: (drawn.x - left) / scale, y: 0, w: drawn.w / scale, h: drawn.h / scale },
          scopeOf(canvas),
        );
        nodeId = made.nodeId;
        blockId = insertDiagram(editor, place, serializeScene(made.scene));
      }
    } catch (error) {
      console.warn("[page-draw] could not place the diagram:", error);
      ghost.remove();
      return;
    }
    // The shape in its new home, once the canvas has drawn it. What was drawn
    // carries itself there — one shape the whole way, never a copy fading out
    // over another fading in — and the real one takes over where it lands.
    // Only then is the diagram opened on it, so its selection comes up on a
    // shape that has stopped moving.
    const shape = await when(
      () =>
        canvas
          .get(blockId)
          ?.api.band.current?.querySelector<HTMLElement>(`.nt-canvas-scene [data-id="${CSS.escape(nodeId)}"]`) ?? null,
      1500,
    );
    // Selected with the keyboard on it, so ⌫ takes the shape, not the text.
    const select = () =>
      void canvas.whenRegistered(blockId).then((entry) => {
        entry?.api.selection.select([nodeId]);
        entry?.api.focus();
      });
    if (!shape) {
      ghost.remove();
      select();
      return;
    }
    shape.style.visibility = "hidden";
    await frames(2);
    const to = shape.getBoundingClientRect();
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    await ghost
      .animate(
        [
          { left: `${drawn.x}px`, top: `${drawn.y}px`, width: `${drawn.w}px`, height: `${drawn.h}px` },
          { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` },
        ],
        { duration: reduced ? 1 : 270, easing: SETTLE, fill: "forwards" },
      )
      .finished.catch(() => {});
    shape.style.visibility = "";
    select();
    // Held a beat longer, over the real shape, until the selection frame is up
    // in the place of its own.
    void frames(2).then(() => ghost.remove());
  };

  pane.setAttribute("data-drawing", "");
  pane.addEventListener("pointerdown", onDown, true);
  pane.addEventListener("pointermove", onHover);
  pane.addEventListener("pointerleave", onLeave);
  return () => {
    if (hover) cancelAnimationFrame(hover);
    preview.clear();
    pane.removeAttribute("data-drawing");
    pane.removeEventListener("pointerdown", onDown, true);
    pane.removeEventListener("pointermove", onHover);
    pane.removeEventListener("pointerleave", onLeave);
  };
}

// ---------------------------------------------------------------------------
// The pen
// ---------------------------------------------------------------------------

/**
 * A press on the page with the pen: its point handed to a diagram's own pen,
 * as the press it would have been there — the diagram mid-path, one it
 * landed in or beside, or one made for it where it was pressed. Held, the
 * pointer goes on pulling that point's handles, since the pen takes the
 * pointer with the press.
 */
function armPen(canvas: PageCanvas, pane: HTMLElement): () => void {
  const preview = createPreview(canvas);
  let hover = 0;
  const onHover = (e: PointerEvent) => {
    const at = { x: e.clientX, y: e.clientY };
    const target = e.target;
    if (hover) cancelAnimationFrame(hover);
    hover = requestAnimationFrame(() => {
      hover = 0;
      const drawing = canvas.entries().find((entry) => entry.api.pen.drawing());
      if (drawing) preview.clear();
      else preview.show({ ...at, w: 0, h: 0 }, at, target);
    });
  };
  const onLeave = () => preview.clear();

  const onDown = (e: PointerEvent) => {
    if (!pagePress(e)) return;
    e.preventDefault();
    e.stopPropagation();
    preview.clear();
    let released = false;
    const onUp = () => {
      released = true;
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
    };
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    void handPen(canvas, pane, e, () => released);
  };

  pane.setAttribute("data-drawing", "");
  pane.addEventListener("pointerdown", onDown, true);
  pane.addEventListener("pointermove", onHover);
  pane.addEventListener("pointerleave", onLeave);
  return () => {
    if (hover) cancelAnimationFrame(hover);
    preview.clear();
    pane.removeAttribute("data-drawing");
    pane.removeEventListener("pointerdown", onDown, true);
    pane.removeEventListener("pointermove", onHover);
    pane.removeEventListener("pointerleave", onLeave);
  };
}

async function handPen(canvas: PageCanvas, pane: HTMLElement, press: PointerEvent, released: () => boolean) {
  const origin = { x: press.clientX, y: press.clientY };
  let entry =
    canvas.entries().find((diagram) => !diagram.readOnly && diagram.api.pen.drawing()) ??
    (() => {
      const hit = landingIn(bandBoxes(canvas), { ...origin, w: 0, h: 0 }, origin);
      return hit ? (canvas.get(hit.blockId) ?? null) : null;
    })();
  let born: string | null = null;
  const editor = canvas.editor();
  if (!entry) {
    // Made beside the line it was pressed on rather than in its place: a
    // diagram given up with its path must leave the page as it found it.
    const place = editor && placeNew(blockBoxes(editor), origin.y, (id) => isEmptyLine(editor, id), { replace: false });
    if (!editor || !place) return;
    born = insertDiagram(editor, place, serializeScene({ ...emptyScene(), h: EMPTY_BAND_H }));
    entry = await canvas.whenRegistered(born);
    if (!entry) return;
    await frames(1);
  }
  const band = entry.api.band.current;
  const svg = band?.querySelector<SVGSVGElement>("svg.nt-pen");
  if (!band || !svg) return;

  let r = band.getBoundingClientRect();
  const inset = Math.min(BAND * (r.height / (band.offsetHeight || 1)), r.height / 2);
  if (born && (origin.y < r.top || origin.y > r.bottom)) {
    // Brought to the point rather than the point to it, as far as the page
    // will scroll; what is left over, the point makes up.
    const by = origin.y < r.top ? r.top - (origin.y - inset) : r.bottom - (origin.y + inset);
    pane.scrollBy({ top: by, behavior: "instant" });
    r = band.getBoundingClientRect();
  } else if (origin.y > r.bottom) {
    // Below a diagram it belongs to: the band reaches down to the point now,
    // and its store keeps the height once the point is written.
    const scale = r.height / (band.offsetHeight || 1);
    band.style.height = `${Math.ceil((origin.y - r.top) / scale + BAND)}px`;
    r = band.getBoundingClientRect();
  }
  const at = {
    x: Math.min(r.right - 1, Math.max(r.left + 1, origin.x)),
    y: Math.min(r.bottom - inset, Math.max(r.top + inset, origin.y)),
  };

  if (born && editor) {
    const blockId = born;
    const { store, pen } = entry.api;
    const off = pen.onFinish((id) => {
      off();
      if (id !== null || store.getScene().nodes.length > 0) return;
      // Given up before it was a path: the diagram goes as it came, with no
      // step on anyone's history — its own entries, and its block, off it.
      store.forget();
      editor.transact((tr: { setMeta(key: string, value: unknown): void }) => {
        tr.setMeta("addToHistory", false);
        editor.removeBlocks([blockId]);
      });
    });
  }

  const init = {
    bubbles: true,
    cancelable: true,
    clientX: at.x,
    clientY: at.y,
    button: 0,
    buttons: 1,
    pointerId: press.pointerId,
    pointerType: press.pointerType,
    isPrimary: true,
  };
  svg.dispatchEvent(new PointerEvent("pointerdown", init));
  if (released()) svg.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** The widest a dropped picture comes in, in band px. */
const PICTURE_MAX = 480;

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

async function pictureSize(src: string): Promise<{ w: number; h: number } | null> {
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    return null;
  }
  return img.naturalWidth && img.naturalHeight ? { w: img.naturalWidth, h: img.naturalHeight } : null;
}

/**
 * The pictures dropped on one diagram, at the drop, as pictures of its own:
 * read in as bytes, which the diagram block moves into storage once they land
 * — its string of record holds a URL, never the bytes (`CanvasBlock`'s hoist).
 */
export function pictureOps(
  scene: Scene,
  at: Point,
  pictures: readonly { src: string; w: number; h: number }[],
  scope: Scene = scene,
): { ops: SceneOp[]; ids: string[] } {
  const ids = mintIds(scope, pictures.length);
  const min = bandLeft(scene);
  const max = min + bandWidth(scene);
  const nodes: ImageNode[] = pictures.map((picture, i) => {
    const k = Math.min(1, PICTURE_MAX / picture.w, bandWidth(scene) / picture.w);
    const w = Math.round(picture.w * k);
    const h = Math.round(picture.h * k);
    const x = Math.round(at.x - w / 2 + i * BAND);
    const y = Math.round(at.y - h / 2 + i * BAND);
    return {
      id: ids[i],
      kind: "image",
      x: Math.max(min, Math.min(max - w, x)),
      y: Math.max(0, y),
      w,
      h,
      rot: 0,
      style: {},
      label: "",
      locked: false,
      hidden: false,
      attrs: {},
      src: picture.src,
    };
  });
  return { ops: nodes.length ? [{ type: "insert", nodes }] : [], ids };
}

function attachDrop(canvas: PageCanvas, pane: HTMLElement): () => void {
  const carriesFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
  const onOver = (e: DragEvent) => {
    if (!carriesFiles(e) || !entryAt(canvas, e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: DragEvent) => {
    const entry = carriesFiles(e) ? entryAt(canvas, e.target) : null;
    const files = [...(e.dataTransfer?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (!entry || files.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const at = entry.api.viewport.clientToScene({ x: e.clientX, y: e.clientY });
    void Promise.all(
      files.map(async (file) => {
        const src = await readAsDataUrl(file).catch(() => null);
        const size = src ? await pictureSize(src) : null;
        return src && size ? { src, ...size } : null;
      }),
    ).then((read) => {
      const pictures = read.filter((picture) => picture !== null);
      const { store, selection } = entry.api;
      const { ops, ids } = pictureOps(store.getScene(), at, pictures, scopeOf(canvas));
      if (!ops.length) return;
      store.dispatch(ops);
      selection.select(ids);
      entry.api.focus();
    });
  };
  pane.addEventListener("dragover", onOver, true);
  pane.addEventListener("drop", onDrop, true);
  return () => {
    pane.removeEventListener("dragover", onOver, true);
    pane.removeEventListener("drop", onDrop, true);
  };
}

// ---------------------------------------------------------------------------

/**
 * The page draws while a tool that draws is in hand, and takes pictures on
 * its diagrams always. Attached with the pane (see `PageCanvas.attach`).
 */
export function attachPageDraw(canvas: PageCanvas, pane: HTMLElement): () => void {
  const offDrop = attachDrop(canvas, pane);
  const tools = canvas.tools;
  if (!tools) return offDrop;
  let armed: { tool: CanvasTool; off: () => void } | null = null;
  const rearm = () => {
    const tool = tools.get();
    if (armed?.tool === tool) return;
    armed?.off();
    armed = null;
    if (PAGE_KINDS.has(tool)) armed = { tool, off: armShapes(canvas, pane, tool as DrawKind) };
    else if (tool === "pen") armed = { tool, off: armPen(canvas, pane) };
  };
  rearm();
  const offTools = tools.subscribe(rearm);
  return () => {
    offTools();
    armed?.off();
    offDrop();
  };
}
