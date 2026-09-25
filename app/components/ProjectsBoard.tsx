"use client";

import { memo, useEffect, useLayoutEffect, useMemo, useRef, type PointerEvent } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { pages, when } from "@/app/lib/projectMeta";
import { resetBoard, useBoardLayout, writeBoard, type Point } from "@/app/lib/projectsBoard";
import { PagePreview } from "./PagePreview";
import {
  NameField,
  OpenProject,
  PrivateMark,
  RowMenu,
  roleLabel,
  sameProjectProps,
  type Project,
  type SharedProject,
} from "./projectParts";

/**
 * The projects screen as a canvas: every project a frame on a surface you pan,
 * where you left it.
 *
 * A frame that has never been moved is placed by the board — yours in a block,
 * most recent first, what is shared with you in a block beside it. Moving one
 * pins it, and nothing else moves because of it: its slot stays empty, and
 * frames are free to overlap. It is a canvas, and what sits on what is the
 * arrangement, not a collision to be resolved.
 *
 * Panning and dragging write the DOM directly and tell the store once, on
 * release. Every frame carries a live PagePreview, and a pointer move must not
 * be a render of all of them.
 */

const FRAME = { w: 240, h: 180, label: 28 };
const CELL = { w: FRAME.w + 48, h: FRAME.h + FRAME.label + 44 };
const MINE_COLS = 4;
const SHARED_COLS = 2;
const SHARED_X = MINE_COLS * CELL.w + 72;
const SNAP = 12;
const MAP = { w: 168, h: 112 };

type Placed = { id: string; x: number; y: number; pinned: boolean; z: number };

/** Where it was put, or else its slot: left to right, top to bottom, by place in the list. */
function place(ids: string[], at: Record<string, Point>, origin: number, cols: number): Placed[] {
  // The last frame moved is the last key written, and sits on top: `at` keeps
  // the order things were put down in, so it is the stacking order too.
  const order = Object.keys(at);
  return ids.map((id, slot) => {
    const pin = at[id];
    if (pin) return { id, ...pin, pinned: true, z: order.indexOf(id) + 1 };
    return {
      id,
      x: origin + (slot % cols) * CELL.w,
      y: Math.floor(slot / cols) * CELL.h,
      pinned: false,
      z: 0,
    };
  });
}

export function ProjectsBoard({
  projects,
  shared,
  editingId,
  onOpen,
  onRename,
  onCommit,
  onCancel,
  onExport,
  onDelete,
  onContext,
}: {
  projects: Project[];
  shared: SharedProject[];
  editingId: Id<"projects"> | null;
  onOpen: (id: Id<"projects">) => void;
  onRename: (project: Project) => void;
  onCommit: (id: Id<"projects">, name: string) => void;
  onCancel: () => void;
  onExport: (project: Project) => void;
  onDelete: (project: Project) => void;
  onContext: (project: Project, x: number, y: number) => void;
}) {
  const layout = useBoardLayout();
  const board = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const lens = useRef<HTMLElement>(null);
  const mini = useRef<HTMLDivElement>(null);

  const placed = useMemo(
    () => [
      ...place(projects.map((p) => p._id), layout.at, 0, MINE_COLS),
      ...place(shared.map((p) => p._id), layout.at, SHARED_X, SHARED_COLS),
    ],
    [projects, shared, layout.at],
  );
  const spot = new Map(placed.map((p) => [p.id, p]));

  // The world the minimap draws: every frame, with a margin.
  const bounds = useMemo(() => {
    const xs = placed.map((p) => p.x);
    const ys = placed.map((p) => p.y);
    const x = Math.min(0, ...xs) - 80;
    const y = Math.min(0, ...ys) - 80;
    return {
      x,
      y,
      w: Math.max(CELL.w, ...xs.map((v) => v + FRAME.w)) + 80 - x,
      h: Math.max(CELL.h, ...ys.map((v) => v + FRAME.h + FRAME.label)) + 80 - y,
    };
  }, [placed]);
  const k = Math.min(MAP.w / bounds.w, MAP.h / bounds.h);

  // The gesture in flight. `pan` is where the stage is right now, which during
  // a gesture is ahead of the store.
  const pan = useRef(layout.pan);
  const gesture = useRef<
    | { kind: "pan"; from: Point; start: Point }
    | { kind: "frame"; el: HTMLElement; id: string; from: Point; start: Point; moved: boolean }
    | null
  >(null);
  const suppressClick = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wheeled = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Where the stage sits in the window. Measured when that can change rather
  // than read in `draw`: a wheel gesture draws several times a frame, and a
  // layout read straight after the last draw's writes made each one lay out.
  const origin = useRef<Point>({ x: 0, y: 0 });

  const draw = (to: Point) => {
    const el = stage.current;
    if (!el) return;
    // Some of the board always stays in reach: it cannot be panned off-screen.
    const { x: ox, y: oy } = origin.current;
    const x = Math.min(innerWidth - 160 - ox - bounds.x, Math.max(160 - ox - bounds.x - bounds.w, to.x));
    const y = Math.min(innerHeight - 160 - oy - bounds.y, Math.max(160 - oy - bounds.y - bounds.h, to.y));
    pan.current = { x, y };
    el.style.translate = `${x}px ${y}px`;
    // The dots travel with the stage. Written as the property itself: a custom
    // property on the board is inherited by every frame and every thumbnail on
    // it, and restyled all of them on each pointer move.
    if (board.current) board.current.style.backgroundPosition = `${x}px ${y}px`;
    // The window, in the board's coordinates.
    const vx = -ox - x;
    const vy = -oy - y;
    if (lens.current) {
      lens.current.style.translate = `${(vx - bounds.x) * k}px ${(vy - bounds.y) * k}px`;
      lens.current.style.width = `${innerWidth * k}px`;
      lens.current.style.height = `${innerHeight * k}px`;
    }
    // A map of what is already all on screen is a map of nothing.
    if (mini.current) {
      mini.current.hidden =
        vx <= bounds.x + 80 &&
        vy <= bounds.y + 80 &&
        vx + innerWidth >= bounds.x + bounds.w - 80 &&
        vy + innerHeight >= bounds.y + bounds.h - 80;
    }
  };
  const drawRef = useRef(draw);
  useEffect(() => {
    drawRef.current = draw;
  });

  // The store is the truth between gestures; the window's size is part of what
  // the minimap shows.
  useLayoutEffect(() => {
    const measure = () => {
      const el = stage.current;
      if (el) origin.current = { x: el.offsetLeft, y: el.offsetTop };
    };
    measure();
    drawRef.current(layout.pan);
    const onResize = () => {
      measure();
      drawRef.current(pan.current);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [layout.pan, bounds, k]);

  useEffect(
    () => () => {
      clearTimeout(settle.current);
      clearTimeout(wheeled.current);
    },
    [],
  );

  const commitPan = () => writeBoard((l) => ({ ...l, pan: pan.current }));

  const down = (e: PointerEvent<HTMLDivElement>) => {
    // A drag that ended without a click leaves this set; the next press is a
    // new gesture and must not inherit it.
    suppressClick.current = false;
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button, [contenteditable], input, .nt-board-map")) return;
    const frame = target.closest<HTMLElement>("[data-frame]");
    const from = { x: e.clientX, y: e.clientY };
    if (frame) {
      const at = spot.get(frame.dataset.frame!);
      if (!at) return;
      gesture.current = { kind: "frame", el: frame, id: at.id, from, start: { x: at.x, y: at.y }, moved: false };
    } else {
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.dataset.panning = "true";
      gesture.current = { kind: "pan", from, start: pan.current };
    }
  };

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.from.x;
    const dy = e.clientY - g.from.y;
    if (g.kind === "pan") return draw({ x: g.start.x + dx, y: g.start.y + dy });
    if (!g.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      // Only now is it a drag. Capturing earlier would take the click away from
      // the link inside the frame, and a press that goes nowhere must open it.
      g.moved = true;
      suppressClick.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      g.el.dataset.dragging = "true";
    }
    g.el.style.translate = `${g.start.x + dx}px ${g.start.y + dy}px`;
  };

  const up = (e: PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    gesture.current = null;
    delete e.currentTarget.dataset.panning;
    if (!g) return;
    if (g.kind === "pan") return commitPan();
    // Judged again on release: a fast flick can arrive as a press and a release
    // with nothing between them, and it is still a move.
    const travelled = Math.hypot(e.clientX - g.from.x, e.clientY - g.from.y) >= 4;
    if (!g.moved && !travelled) return;
    suppressClick.current = true;
    const to = {
      x: Math.round((g.start.x + e.clientX - g.from.x) / SNAP) * SNAP,
      y: Math.round((g.start.y + e.clientY - g.from.y) / SNAP) * SNAP,
    };
    // Set down: it drops the last few pixels onto the grid as it lands.
    g.el.dataset.dragging = "settling";
    g.el.style.translate = `${to.x}px ${to.y}px`;
    const el = g.el;
    settle.current = setTimeout(() => delete el.dataset.dragging, 320);
    writeBoard((l) => {
      const { [g.id]: _before, ...rest } = l.at;
      return { ...l, at: { ...rest, [g.id]: to } };
    });
  };

  const wheel = (e: React.WheelEvent) => {
    draw({ x: pan.current.x - e.deltaX, y: pan.current.y - e.deltaY });
    clearTimeout(wheeled.current);
    wheeled.current = setTimeout(commitPan, 160);
  };

  const moved = Object.keys(layout.at).length > 0 || layout.pan.x !== 0 || layout.pan.y !== 0;
  const sharedAtHome = shared.some((p) => !spot.get(p._id)?.pinned);

  return (
    <div
      ref={board}
      className="nt-board"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onWheel={wheel}
      onDragStart={(e) => e.preventDefault()}
      onClickCapture={(e) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div ref={stage} className="nt-board-stage">
        {sharedAtHome && (
          <h2 className="nt-section-label nt-board-region" style={{ translate: `${SHARED_X}px -40px` }}>
            <span>Shared with me</span>
          </h2>
        )}
        {projects.map((p, i) => (
          <Frame
            key={p._id}
            project={p}
            x={spot.get(p._id)!.x}
            y={spot.get(p._id)!.y}
            z={spot.get(p._id)!.z}
            i={i}
            editing={editingId === p._id}
            onOpen={onOpen}
            onRename={onRename}
            onCommit={onCommit}
            onCancel={onCancel}
            onExport={onExport}
            onDelete={onDelete}
            onContext={onContext}
          />
        ))}
        {shared.map((p, i) => (
          <SharedFrame
            key={p._id}
            project={p}
            x={spot.get(p._id)!.x}
            y={spot.get(p._id)!.y}
            z={spot.get(p._id)!.z}
            i={projects.length + i}
          />
        ))}
      </div>

      <div className="nt-board-map">
        {moved && (
          <button onClick={resetBoard} className="nt-row nt-board-tidy">
            Tidy up
          </button>
        )}
        <div ref={mini} className="nt-board-mini" aria-hidden="true" style={{ width: bounds.w * k, height: bounds.h * k }}>
          {placed.map((p) => (
            <i
              key={p.id}
              style={{
                translate: `${(p.x - bounds.x) * k}px ${(p.y + FRAME.label - bounds.y) * k}px`,
                width: FRAME.w * k,
                height: FRAME.h * k,
              }}
            />
          ))}
          <b ref={lens} />
        </div>
      </div>
    </div>
  );
}

const frameStyle = (x: number, y: number, z: number, i: number) =>
  ({ translate: `${x}px ${y}px`, zIndex: z, "--i": i }) as React.CSSProperties;

/** Memoized for the reason every card is: a live PagePreview each. */
const Frame = memo(function Frame({
  project,
  x,
  y,
  z,
  i,
  editing,
  onOpen,
  onRename,
  onCommit,
  onCancel,
  onExport,
  onDelete,
  onContext,
}: {
  project: Project;
  x: number;
  y: number;
  z: number;
  i: number;
  editing: boolean;
  onOpen: (id: Id<"projects">) => void;
  onRename: (project: Project) => void;
  onCommit: (id: Id<"projects">, name: string) => void;
  onCancel: () => void;
  onExport: (project: Project) => void;
  onDelete: (project: Project) => void;
  onContext: (project: Project, x: number, y: number) => void;
}) {
  return (
    <div
      data-frame={project._id}
      className="nt-board-frame"
      style={frameStyle(x, y, z, i)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContext(project, e.clientX, e.clientY);
      }}
    >
      <div className="nt-board-label">
        {editing ? (
          <NameField
            initial={project.title}
            onCommit={(text) => onCommit(project._id, text)}
            onCancel={onCancel}
            className="nt-board-name relative"
          />
        ) : (
          <OpenProject project={project} className="nt-board-name nt-card-link">
            {project.title || "Untitled project"}
          </OpenProject>
        )}
        {project.visibility === "private" && <PrivateMark />}
        <span className="nt-board-meta">
          {pages(project.pageCount)} · {when(project.updatedAt)}
        </span>
        <RowMenu
          project={project}
          onOpen={() => onOpen(project._id)}
          onRename={() => onRename(project)}
          onExport={() => onExport(project)}
          onDelete={() => onDelete(project)}
          className="is-sm"
        />
      </div>
      <div className="nt-board-page">
        <PagePreview docId={project.firstPageDocId} />
      </div>
    </div>
  );
}, sameProjectProps);

const SharedFrame = memo(function SharedFrame({
  project,
  x,
  y,
  z,
  i,
}: {
  project: SharedProject;
  x: number;
  y: number;
  z: number;
  i: number;
}) {
  return (
    <div data-frame={project._id} className="nt-board-frame" style={frameStyle(x, y, z, i)}>
      <div className="nt-board-label">
        <OpenProject project={project} className="nt-board-name nt-card-link">
          {project.title || "Untitled project"}
        </OpenProject>
        <span className="nt-board-meta">
          {project.ownerName ? `${project.ownerName} · ` : ""}
          {roleLabel(project)}
        </span>
      </div>
      <div className="nt-board-page">
        <PagePreview docId={project.firstPageDocId} />
      </div>
    </div>
  );
});
