"use client";

import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { track } from "@/app/lib/telemetry";
import { COLUMN_WIDTH } from "@/app/lib/column";
import { effectiveScale, fitOf } from "@/app/lib/columnScale";
import type { Pane } from "./OpenPageContext";
import type { LiveEditor, EditorRegistry } from "./editor/EditorRegistry";
import type { CanvasTool } from "./editor/canvas/engine/shortcuts";
import type { DiagramEntry, PageCanvas, PageCanvasHub } from "./editor/canvas/page/PageCanvas";
import type { PageToolControl } from "./editor/canvas/page/tools";
import { defaultBox, newNode, type DrawKind } from "./editor/canvas/render/newShape";
import { BAND, bandFloor } from "./editor/canvas/scene/band";
import { emptyScene } from "./editor/canvas/scene/migrate";
import { mintId } from "./editor/canvas/scene/ops";
import { serializeScene } from "./editor/canvas/scene/serialize";
import type { Scene } from "./editor/canvas/scene/types";

/**
 * Drawing on the page itself.
 *
 * Arm a shape on the page's bar and a drag on the page draws it; on release a
 * diagram is made where it was drawn — between the blocks nearest the top of
 * the drag, or in place of an empty line — holding exactly that shape, and
 * what you drew settles into it. A press on a diagram already on the page is
 * that diagram's own draw, with the same tool.
 *
 * It is an insertion, never an annotation: a shape lives only inside a canvas
 * block, so a shape drawn across a paragraph becomes a diagram beside it, not
 * a mark on it. And it is made the way the slash menu makes one — a canvas
 * block whose scene is serialized from the same `newNode` the canvas's own
 * tools use — so nothing here is a path the assistant could not also take.
 */

/** The tools that draw on the page. Text, the pen and connectors need a diagram. */
const PAGE_KINDS: ReadonlySet<CanvasTool> = new Set(["rect", "ellipse", "polygon", "diamond"]);

type Box = { x: number; y: number; w: number; h: number };

/** Below this a drag was a click, and the shape takes the canvas's own size. */
const DRAWN_MIN = 4;

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

function normalise(a: { x: number; y: number }, b: { x: number; y: number }, square: boolean): Box {
  let w = b.x - a.x;
  let h = b.y - a.y;
  if (square) {
    const side = Math.max(Math.abs(w), Math.abs(h));
    w = Math.sign(w || 1) * side;
    h = Math.sign(h || 1) * side;
  }
  return { x: Math.min(a.x, a.x + w), y: Math.min(a.y, a.y + h), w: Math.abs(w), h: Math.abs(h) };
}

/**
 * Where a diagram drawn from `y` goes: in place of an empty line it was drawn
 * on, or else before or after the top-level block it was drawn against,
 * whichever half of it the drag began in. Also the left edge of the text it
 * will stand in, which is the diagram's origin.
 */
function placeAt(editor: LiveEditor, y: number) {
  const blocks = editor.document as { id: string; type: string; content?: unknown }[];
  const root = editor.domElement as HTMLElement | undefined;
  let ref = blocks[blocks.length - 1];
  let where: "before" | "after" = "after";
  // Drawn past the last block counts as drawn on it: that is where the next
  // line would go, and a trailing empty one is there to be written in.
  let on = true;
  for (const block of blocks) {
    const r = root?.querySelector<HTMLElement>(`[data-id="${block.id}"]`)?.getBoundingClientRect();
    if (!r || y >= r.bottom) continue;
    ref = block;
    on = y >= r.top;
    where = y < r.top + r.height / 2 ? "before" : "after";
    break;
  }
  const empty = ref.type === "paragraph" && Array.isArray(ref.content) && ref.content.length === 0;
  const content = root?.querySelector<HTMLElement>(`[data-id="${ref.id}"] .bn-block-content`);
  const column = content?.getBoundingClientRect();
  return {
    // A band is drawn at its own width and scaled to the page: the document's
    // zoom, and the column's fit where the pane is narrow.
    column: content && column
      ? { left: column.left, scale: effectiveScale(content) * fitOf(content, "normal") }
      : null,
    /** Puts the diagram there. Returns its block id. */
    insert(data: string): string {
      if (on && empty) {
        editor.updateBlock(ref, { type: "canvas", props: { data } });
        return ref.id;
      }
      const [made] = editor.insertBlocks([{ type: "canvas", props: { data } }], ref, where);
      return made.id;
    },
  };
}

/**
 * The diagram a shape drawn on the page becomes. Across, the shape stays where
 * it was drawn against the text's left edge — moved only if it was drawn past
 * that edge, and the diagram made wide if it runs past the column's right.
 * Down, it sits a band below the top: the block goes between lines, so where
 * it lands vertically is the block's to decide anyway.
 */
function sceneFor(kind: DrawKind, drawn: Box, column: { left: number; scale: number } | null) {
  const nodeId = mintId(emptyScene());
  const scale = column?.scale ?? 1;
  const w = Math.round(drawn.w / scale);
  const x = column ? Math.max(0, Math.round((drawn.x - column.left) / scale)) : 0;
  const drawnScene: Scene = {
    ...emptyScene(),
    nodes: [newNode(kind, nodeId, { x, y: BAND, w, h: Math.round(drawn.h / scale) })],
    ...(x + w > COLUMN_WIDTH ? { wide: true as const } : {}),
  };
  return { scene: { ...drawnScene, h: bandFloor(drawnScene) }, nodeId };
}

/**
 * The diagram already on the page that a shape drawn beside it belongs to:
 * one it lies to the right of, wholly between its top and bottom. Drawn there,
 * the shape is part of that diagram's picture, not the start of another one
 * underneath it. Diagram blocks only — a storyboard's frames are fixed.
 */
function besideDiagram(canvas: PageCanvas | null, drawn: Box): DiagramEntry | null {
  for (const entry of canvas?.entries() ?? []) {
    const r = entry.readOnly ? null : entry.api.band.current?.getBoundingClientRect();
    if (r && drawn.x >= r.right && drawn.y >= r.top && drawn.y + drawn.h <= r.bottom) {
      return entry;
    }
  }
  return null;
}

/**
 * Puts the shape into that diagram where it was drawn, making it wide: beside
 * it is past its right edge. Through the diagram's own store, as one step of
 * its history — its block prop trails its edits by seconds, and a write built
 * from the prop would put back whatever it had not caught up with yet.
 */
function extendDiagram({ api }: DiagramEntry, kind: DrawKind, drawn: Box): string {
  const a = api.viewport.clientToScene({ x: drawn.x, y: drawn.y });
  const b = api.viewport.clientToScene({ x: drawn.x + drawn.w, y: drawn.y + drawn.h });
  const nodeId = mintId(api.store.getScene());
  api.store.dispatch([
    {
      type: "insert",
      nodes: [
        newNode(kind, nodeId, {
          x: Math.round(a.x),
          y: Math.round(a.y),
          w: Math.round(b.x - a.x),
          h: Math.round(b.y - a.y),
        }),
      ],
    },
    { type: "setDiagram", wide: true },
  ]);
  return nodeId;
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

/** The `--ease` family, so the settle moves like the rest of the page. */
const SETTLE = "cubic-bezier(0.25, 0, 0, 1)";

/**
 * Arms the page for drawing while a shape tool is in hand. A press over the
 * page's text or between its blocks draws; a press on a diagram that is
 * already there is left to it, since it draws with the same tool.
 */
export function usePageDraw({
  well,
  tools,
  hub,
  registry,
}: {
  well: RefObject<HTMLElement | null>;
  tools: PageToolControl | null;
  hub: PageCanvasHub;
  registry: EditorRegistry;
}) {
  const tool = useSyncExternalStore(
    tools?.subscribe ?? noSubscribe,
    () => tools?.get() ?? "move",
    () => "move" as const,
  );
  useEffect(() => {
    const el = well.current;
    if (!el || !tools || !PAGE_KINDS.has(tool)) return;
    const kind = tool as DrawKind;
    el.setAttribute("data-drawing", "");

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as Element;
      const pane = target.closest<HTMLElement>(".nt-pane[data-page-id][data-pane]");
      // The page's own controls — the mode switch, the corner buttons — still work.
      if (!pane || target.closest("button, a, input, textarea, select, [role='menu']")) return;
      // A diagram — a canvas block or a storyboard's shot — draws for itself.
      if (target.closest(".nt-canvas")) return;
      e.preventDefault();
      e.stopPropagation();
      const pageId = pane.dataset.pageId!;
      const paneName = pane.dataset.pane as Pane;
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
        if (frame) cancelAnimationFrame(frame);
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("keyup", onKey, true);
      };
      const onUp = () => {
        stop();
        const drawn: Box = box.w < DRAWN_MIN && box.h < DRAWN_MIN ? defaultBox(kind, origin) : box;
        ghost.el.dataset.settling = "";
        ghost.paint(drawn);
        void land(paneName, pageId, drawn, ghost.el);
      };

      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("keyup", onKey, true);
    };

    /** Make the diagram, then let what was drawn settle into it. */
    const land = async (paneName: Pane, pageId: string, drawn: Box, ghost: HTMLElement) => {
      tools.settle();
      // The pane pressed in, not the first showing this page: both panes can.
      const canvas = hub.pane(paneName);
      let blockId: string;
      let nodeId: string;
      try {
        const beside = besideDiagram(canvas, drawn);
        if (beside) {
          nodeId = extendDiagram(beside, kind, drawn);
          blockId = beside.blockId;
        } else {
          const editor = await registry.editorFor(pageId);
          const place = placeAt(editor, drawn.y);
          const made = sceneFor(kind, drawn, place.column);
          nodeId = made.nodeId;
          blockId = place.insert(serializeScene(made.scene));
          track("block_created", { type: "canvas" });
        }
      } catch (error) {
        console.warn("[page-draw] could not place the diagram:", error);
        ghost.remove();
        return;
      }
      // The shape in its new home, once the canvas has drawn it. What was drawn
      // carries itself there — one shape the whole way, never a copy fading
      // out over another fading in — and the real one takes over where it
      // lands. Only then is the diagram opened on it, so its selection comes
      // up on a shape that has stopped moving.
      const shape = await when(
        () => document.querySelector<HTMLElement>(`[data-id="${blockId}"] .nt-canvas-scene [data-id="${nodeId}"]`),
        1500,
      );
      // Selected with the keyboard on it, so ⌫ takes the shape, not the text.
      const select = () =>
        void canvas?.whenRegistered(blockId).then((entry) => {
          entry?.api.selection.select([nodeId]);
          entry?.api.focus();
        });
      if (!shape) {
        ghost.remove();
        select();
        return;
      }
      shape.style.visibility = "hidden";
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
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
      requestAnimationFrame(() => requestAnimationFrame(() => ghost.remove()));
    };

    el.addEventListener("pointerdown", onDown, true);
    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      el.removeAttribute("data-drawing");
    };
  }, [well, tool, tools, hub, registry]);
}

const noSubscribe = () => () => {};
