"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { track } from "@/app/lib/telemetry";
import { useColumnEdges } from "@/app/lib/columnEdges";
import { useSpineState, useWorkspaceHistory } from "@/app/lib/history/useWorkspaceHistory";
import type { LiveEditor, EditorRegistry } from "./editor/EditorRegistry";
import { useAutocomplete } from "./editor/ai/useAutocomplete";
import { ReachPopover, SPARK_PATH as SPARK } from "./editor/ai/ReachSlider";
import { Button, PaletteButton, REDO, TOOLS, ToolRow, UNDO } from "./editor/canvas/Toolbar";
import { isApplePlatform, shortcutHint, type CanvasTool, type ShortcutId } from "./editor/canvas/engine/shortcuts";
import { handTool } from "./editor/canvas/engine/handedTool";
import { defaultBox, newNode, type DrawKind } from "./editor/canvas/render/newShape";
import { emptyScene, migrateLegacyCanvas } from "./editor/canvas/scene/migrate";
import { mintId } from "./editor/canvas/scene/ops";
import { canvasHeightFor, FIXED, WIDTH_ATTR } from "./editor/canvas/types";
import { serializeScene } from "./editor/canvas/scene/serialize";

/**
 * Drawing on the page itself.
 *
 * The tool bar stays at the foot of the page when no diagram is being edited,
 * holding the tools that make sense there: Move, which leaves the page a
 * document, and the shapes. Arm a shape and a drag on the page draws it; on
 * release a diagram is made where it was drawn — between the blocks nearest
 * the top of the drag, or in place of an empty line — holding exactly that
 * shape, and what you drew settles into it.
 *
 * It is an insertion, never an annotation: a shape lives only inside a canvas
 * block, so a shape drawn across a paragraph becomes a diagram beside it, not
 * a mark on it. And it is made the way the slash menu makes one — a canvas
 * block whose scene is serialized from the same `newNode` the canvas's own
 * tools use — so nothing here is a path the assistant could not also take.
 */

/** The tools the page offers. Text, the pen and connectors need a diagram. */
const MOVE = TOOLS.filter((t) => t.tool === "move");
const PAGE_KINDS: ReadonlySet<CanvasTool> = new Set(["rect", "ellipse", "polygon", "diamond"]);

export type PageTool = "move" | DrawKind;

/** The page tool a key picks, if it is one of the page's. */
export function pageToolFor(id: ShortcutId | null): PageTool | null {
  if (id === "tool.move") return "move";
  const tool = id?.startsWith("tool.") ? (id.slice(5) as CanvasTool) : null;
  return tool && PAGE_KINDS.has(tool) ? (tool as PageTool) : null;
}

const glyph = {
  width: 17,
  height: 17,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
const AUTOCOMPLETE_ON = (
  <svg {...glyph}>
    <path d={SPARK} />
  </svg>
);
const AUTOCOMPLETE_OFF = (
  <svg {...glyph}>
    <path d={SPARK} />
    <path d="M4 4l16 16" />
  </svg>
);

const neverChanges = () => () => {};
const notApple = () => false;

/** The bar, for a page with no diagram in hand. */
export function PageToolbar({
  tool,
  onTool,
  onPalette,
}: {
  tool: PageTool;
  onTool: (tool: PageTool) => void;
  onPalette: () => void;
}) {
  const apple = useSyncExternalStore(neverChanges, isApplePlatform, notApple);
  const hint = (id: ShortcutId) => shortcutHint(id, apple);
  const spine = useWorkspaceHistory();
  const history = useSpineState(spine);
  const autocomplete = useAutocomplete();
  /** Where the switch was when a right-click asked for its reach. */
  const [reachAt, setReachAt] = useState<DOMRect | null>(null);
  const dock = useRef<HTMLDivElement>(null);
  useColumnEdges(dock);

  return (
    <div ref={dock} className="nt-toolbar-dock is-page" data-armed={tool !== "move" || undefined}>
      <div className="nt-toolbar" role="toolbar" aria-label="Page tools">
        <ToolRow
          tool={tool}
          lead={MOVE}
          tail={[]}
          grouped={false}
          hint={hint}
          onTool={(next) => onTool(pageToolFor(`tool.${next}` as ShortcutId) ?? "move")}
        />
        {spine && (
          <>
            <span className="nt-toolbar-sep" aria-hidden />
            <Button
              label="Undo"
              hint={hint("edit.undo")}
              disabled={!history.canUndo}
              onClick={() => void spine.undo()}
            >
              {UNDO}
            </Button>
            <Button
              label="Redo"
              hint={hint("edit.redo")}
              disabled={!history.canRedo}
              onClick={() => void spine.redo()}
            >
              {REDO}
            </Button>
          </>
        )}
        {autocomplete.loaded && (
          <>
            <span className="nt-toolbar-sep" aria-hidden />
            <Button
              label="Autocomplete"
              hint={autocomplete.on ? "On" : "Off"}
              pressed={autocomplete.on}
              toggle
              onClick={() => autocomplete.setOn(!autocomplete.on)}
              onContextMenu={(e) => {
                e.preventDefault();
                setReachAt(e.currentTarget.getBoundingClientRect());
              }}
            >
              {autocomplete.on ? AUTOCOMPLETE_ON : AUTOCOMPLETE_OFF}
            </Button>
            {reachAt && <ReachPopover anchor={reachAt} onClose={() => setReachAt(null)} />}
          </>
        )}
        <PaletteButton apple={apple} onOpen={onPalette} />
      </div>
    </div>
  );
}

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
 * whichever half of it the drag began in. Also the column it will stand in —
 * the text's own left edge and width, which the diagram's frame takes.
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
  const column = root
    ?.querySelector<HTMLElement>(`[data-id="${ref.id}"] .bn-block-content`)
    ?.getBoundingClientRect();
  return {
    column: column ? { left: column.left, width: column.width } : null,
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
 * that edge, and the frame widened if it runs past the column's right. Down,
 * it is centred in the height the block takes for it: the block goes between
 * lines, so where it lands vertically is the block's to decide anyway.
 */
function sceneFor(kind: DrawKind, drawn: Box, column: { left: number; width: number } | null) {
  const scene = emptyScene();
  const nodeId = mintId(scene);
  const w = Math.round(drawn.w);
  const h = Math.round(drawn.h);
  const x = column ? Math.max(0, Math.round(drawn.x - column.left)) : 0;
  const y = Math.max(0, Math.round((canvasHeightFor([{ y: 0, height: h }]) - h) / 2));
  scene.nodes = [newNode(kind, nodeId, { x, y, w, h })];
  if (column && x + w > column.width) {
    scene.w = x + w + WIDEN_PAD;
    scene.attrs[WIDTH_ATTR] = FIXED;
  }
  return { scene, nodeId };
}

/** Room left past a shape that widened its frame, so it does not touch the edge. */
const WIDEN_PAD = 24;

/**
 * The diagram already on the page that a shape drawn beside it belongs to:
 * one it lies to the right of, wholly between its top and bottom. Drawn there,
 * the shape is part of that diagram's picture, not the start of another one
 * underneath it. Diagram blocks only — a storyboard's frames are fixed.
 */
function besideDiagram(editor: LiveEditor, drawn: Box) {
  const root = editor.domElement as HTMLElement | undefined;
  for (const block of editor.document as { id: string; type: string; props: { data?: string } }[]) {
    if (block.type !== "canvas") continue;
    const el = root?.querySelector<HTMLElement>(`[data-id="${block.id}"] .nt-canvas`);
    const r = el?.getBoundingClientRect();
    if (!el || !r) continue;
    if (drawn.x >= r.right && drawn.y >= r.top && drawn.y + drawn.h <= r.bottom) {
      return { block, el };
    }
  }
  return null;
}

/**
 * Puts the shape into that diagram where it was drawn, widening the frame out
 * to it. Screen to scene through the view the diagram is showing, so it lands
 * under the pointer at whatever pan and zoom it has; written as the block's
 * whole scene — the same write an edit from outside the canvas makes, which
 * the diagram's own shapes merge through untouched.
 */
function extendDiagram(
  editor: LiveEditor,
  { block, el }: NonNullable<ReturnType<typeof besideDiagram>>,
  kind: DrawKind,
  drawn: Box,
): string {
  const scene = migrateLegacyCanvas(block.props.data ?? "");
  const view = el.querySelector<HTMLElement>(".nt-canvas-viewport");
  const layer = el.querySelector<HTMLElement>(".nt-canvas-scene");
  const frame = el.getBoundingClientRect();
  const origin = view?.getBoundingClientRect() ?? frame;
  const m = new DOMMatrixReadOnly(layer ? getComputedStyle(layer).transform : "none");
  const zoom = m.a || 1;
  const nodeId = mintId(scene);
  scene.nodes = [
    ...scene.nodes,
    newNode(kind, nodeId, {
      x: Math.round((drawn.x - origin.left - (view?.clientLeft ?? 0) - m.e) / zoom),
      y: Math.round((drawn.y - origin.top - (view?.clientTop ?? 0) - m.f) / zoom),
      w: Math.round(drawn.w / zoom),
      h: Math.round(drawn.h / zoom),
    }),
  ];
  const reach = Math.ceil(drawn.x + drawn.w - frame.left + WIDEN_PAD);
  if (reach > frame.width) {
    scene.w = reach;
    scene.attrs[WIDTH_ATTR] = FIXED;
  }
  editor.updateBlock(block, { props: { data: serializeScene(scene) } });
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

/** `--ease`-family curve the stage morph uses, so both settle alike. */
const SETTLE = "cubic-bezier(0.25, 0, 0, 1)";

/**
 * Arms the page for drawing while a shape tool is in hand. A press over the
 * page's text or between its blocks draws; a press on a diagram that is
 * already there draws in that diagram instead, since more shapes belong in
 * the one you pointed at rather than in a new one beside it.
 */
export function usePageDraw({
  well,
  tool,
  registry,
  onTool,
  onDrawn,
  onIntoDiagram,
}: {
  well: RefObject<HTMLElement | null>;
  tool: PageTool;
  registry: EditorRegistry;
  onTool: (tool: PageTool) => void;
  /** The diagram made, and the shape in it — to be opened and selected. */
  onDrawn: (blockId: string, nodeId: string) => void;
  /** A press went through to a diagram already on the page, to draw there. */
  onIntoDiagram: () => void;
}) {
  useEffect(() => {
    const el = well.current;
    if (!el || tool === "move") return;
    const kind = tool;
    el.setAttribute("data-drawing", "");

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as Element;
      const pane = target.closest<HTMLElement>(".nt-pane[data-page-id]");
      // The page's own controls — the mode switch, the corner buttons — still work.
      if (!pane || target.closest("button, a, input, textarea, select, [role='menu']")) return;
      // On a diagram — a canvas block or a storyboard's shot — the press goes
      // through to it carrying the shape: it opens as it would for any press,
      // and its own draw takes over from there.
      if (target.closest(".nt-canvas")) {
        handTool(kind);
        onIntoDiagram();
        return;
      }
      e.preventDefault();
      e.stopPropagation();

      const pageId = pane.dataset.pageId!;
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
        void land(pageId, drawn, ghost.el);
      };

      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("keyup", onKey, true);
    };

    /** Make the diagram, then let what was drawn settle into it. */
    const land = async (pageId: string, drawn: Box, ghost: HTMLElement) => {
      onTool("move");
      let blockId: string;
      let nodeId: string;
      try {
        const editor = await registry.editorFor(pageId);
        const beside = besideDiagram(editor, drawn);
        if (beside) {
          nodeId = extendDiagram(editor, beside, kind, drawn);
          blockId = beside.block.id;
        } else {
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
      if (!shape) {
        ghost.remove();
        onDrawn(blockId, nodeId);
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
      onDrawn(blockId, nodeId);
      // Held a beat longer, over the real shape, until the selection frame is up
      // in the place of its own.
      requestAnimationFrame(() => requestAnimationFrame(() => ghost.remove()));
    };

    el.addEventListener("pointerdown", onDown, true);
    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      el.removeAttribute("data-drawing");
    };
  }, [well, tool, registry, onTool, onDrawn, onIntoDiagram]);
}
