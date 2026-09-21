"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from "react";
import { STAGE, type Shape } from "./data";
import { useScene, useUi, type Tool } from "./store";
import { Editable, IconBtn } from "./controls";
import { Item, Pop, Sep } from "./overlays";
import { Expand, Shrink } from "./icons";

/**
 * The canvas block. A stand-in for the real engine, faithful in what the hand
 * feels: press-drag moves, corners resize, a drag over nothing bands, edges
 * follow their shapes, things snap and say that they snapped, and the one
 * accent (`--nt-select`) only ever marks the system's answer to an input.
 */

const TOOL_KEYS: Record<string, Tool> = { v: "move", k: "scale", h: "hand", z: "zoom", r: "rect", o: "ellipse", g: "polygon", d: "diamond", t: "text", c: "connector", p: "pen" };
const DRAWS: Tool[] = ["rect", "ellipse", "polygon", "diamond", "text"];
const SNAP = 5;

type Point = { x: number; y: number };
type Gesture =
  | { kind: "drag"; ids: string[]; from: Point; start: Map<string, Point>; moved: boolean }
  | { kind: "resize"; id: string; corner: string; from: Point; start: Shape }
  | { kind: "band"; from: Point }
  | { kind: "link"; fromId: string };

export function edgePath(a: Shape, b: Shape) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  // Side by side leaves by the sides; one above the other, by top and bottom.
  if (Math.abs(dx) >= (a.w + b.w) / 2) {
    const s = dx >= 0 ? 1 : -1;
    const x1 = ac.x + (s * a.w) / 2;
    const x2 = bc.x - (s * b.w) / 2 - s * 5;
    const mid = (x1 + x2) / 2;
    return `M${x1} ${ac.y}C${mid} ${ac.y} ${mid} ${bc.y} ${x2} ${bc.y}`;
  }
  const s = dy >= 0 ? 1 : -1;
  const y1 = ac.y + (s * a.h) / 2;
  const y2 = bc.y - (s * b.h) / 2 - s * 5;
  const mid = (y1 + y2) / 2;
  return `M${ac.x} ${y1}C${ac.x} ${mid} ${bc.x} ${mid} ${bc.x} ${y2}`;
}

function boundsOf(shapes: Shape[]) {
  const x = Math.min(...shapes.map((s) => s.x));
  const y = Math.min(...shapes.map((s) => s.y));
  return { x, y, w: Math.max(...shapes.map((s) => s.x + s.w)) - x, h: Math.max(...shapes.map((s) => s.y + s.h)) - y };
}

export function Diagram() {
  const { ui, act: uiAct } = useUi();
  const { scene, act } = useScene();
  const live = ui.mode === "diagram";
  const expanded = ui.expanded || (ui.autoStage && live);
  const view = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [fit, setFit] = useState(1);
  const [band, setBand] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [guides, setGuides] = useState<{ x?: number; y?: number }>({});
  const [link, setLink] = useState<{ from: string; to: Point; target: string | null } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<Point | null>(null);
  const [busy, setBusy] = useState(false);
  const begin = (g: Gesture) => {
    gesture.current = g;
    setBusy(true);
  };

  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const watch = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const byWidth = (width - 28) / STAGE.w;
      setFit(expanded ? Math.min(byWidth, (height - 140) / STAGE.h) : Math.min(byWidth, 1.25));
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, [expanded]);

  // The canvas's own keyboard, which it holds only while it has been entered.
  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable], [data-ek-pop], [role='dialog']")) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        return e.shiftKey ? act.redo() : act.undo();
      }
      if (mod || e.altKey) return;
      if (key === "escape") return scene.sel.length ? act.select([]) : uiAct.set({ mode: "page", expanded: false });
      if (key === "backspace" || key === "delete") return scene.sel.length ? act.remove() : undefined;
      if (key.startsWith("arrow") && scene.sel.length) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const d = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[key]!;
        act.record();
        return act.patch(scene.sel, (s) => ({ x: s.x + d[0], y: s.y + d[1] }));
      }
      if (TOOL_KEYS[key]) act.tool(TOOL_KEYS[key]);
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest(".ek-doc") && !t.closest(".ek-diagram")) uiAct.set({ mode: "page", expanded: false });
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [live, scene.sel, act, uiAct]);

  const scale = fit * (live ? scene.zoom : 1);
  const byId = new Map(scene.shapes.map((s) => [s.id, s]));
  const visible = scene.shapes.filter((s) => !s.hidden);
  const selected = visible.filter((s) => scene.sel.includes(s.id));
  const frame = selected.length ? boundsOf(selected) : null;
  const hovered = scene.hover && !scene.sel.includes(scene.hover) ? byId.get(scene.hover) : null;

  const at = (e: { clientX: number; clientY: number }): Point => {
    const r = stage.current!.getBoundingClientRect();
    const k = r.width / STAGE.w;
    return { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
  };
  const shapeAt = (p: Point) => [...visible].reverse().find((s) => !s.locked && p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h);

  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (!live) return uiAct.set({ mode: "diagram" });
    if (e.button !== 0 || editing) return;
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    const p = at(e);
    e.currentTarget.setPointerCapture(e.pointerId);

    const grip = target.closest<HTMLElement>("[data-grip]");
    if (grip && selected.length === 1) {
      act.record();
      begin({ kind: "resize", id: selected[0].id, corner: grip.dataset.grip!, from: p, start: selected[0] });
      return;
    }
    const edge = target.closest<SVGElement>("[data-edge]");
    if (edge && scene.tool === "move") return act.select([edge.dataset.edge!]);

    const hit = shapeAt(p);
    if (DRAWS.includes(scene.tool)) return act.add(scene.tool === "polygon" ? "polygon" : (scene.tool as Shape["kind"]), p.x, p.y);
    if (scene.tool === "zoom") return act.zoomBy(e.altKey ? 1 / 1.25 : 1.25);
    if (scene.tool === "connector") {
      if (hit) {
        begin({ kind: "link", fromId: hit.id });
        setLink({ from: hit.id, to: p, target: null });
      }
      return;
    }
    if (scene.tool !== "move" && scene.tool !== "scale") return;
    if (!hit) {
      if (!e.shiftKey) act.select([]);
      begin({ kind: "band", from: p });
      return;
    }
    const ids = e.shiftKey ? (scene.sel.includes(hit.id) ? scene.sel.filter((i) => i !== hit.id) : [...scene.sel, hit.id]) : scene.sel.includes(hit.id) ? scene.sel : [hit.id];
    act.select(ids);
    begin({ kind: "drag", ids, from: p, moved: false, start: new Map(ids.map((i) => [i, { x: byId.get(i)!.x, y: byId.get(i)!.y }])) });
  };

  const move = (e: RPointerEvent<HTMLDivElement>) => {
    if (!live) return;
    const p = at(e);
    const g = gesture.current;
    if (!g) return act.hover(shapeAt(p)?.id ?? null);

    if (g.kind === "band") {
      const rect = { x: Math.min(g.from.x, p.x), y: Math.min(g.from.y, p.y), w: Math.abs(p.x - g.from.x), h: Math.abs(p.y - g.from.y) };
      setBand(rect);
      return act.select(visible.filter((s) => !s.locked && s.x < rect.x + rect.w && s.x + s.w > rect.x && s.y < rect.y + rect.h && s.y + s.h > rect.y).map((s) => s.id));
    }
    if (g.kind === "link") {
      const over = shapeAt(p);
      return setLink({ from: g.fromId, to: p, target: over && over.id !== g.fromId ? over.id : null });
    }
    if (g.kind === "resize") {
      const dx = p.x - g.from.x;
      const dy = p.y - g.from.y;
      const s = g.start;
      const west = g.corner.includes("w");
      const north = g.corner.includes("n");
      const w = Math.max(24, Math.round(s.w + (west ? -dx : dx)));
      const h = Math.max(20, Math.round(s.h + (north ? -dy : dy)));
      return act.patch([g.id], { w, h, x: west ? s.x + s.w - w : s.x, y: north ? s.y + s.h - h : s.y });
    }
    let dx = p.x - g.from.x;
    let dy = p.y - g.from.y;
    if (!g.moved) {
      if (Math.hypot(dx, dy) < 3) return;
      g.moved = true;
      act.record();
    }
    // Snap the lead shape's edges and centre to everyone else's, and say so.
    const lead = byId.get(g.ids[0])!;
    const origin = g.start.get(lead.id)!;
    const others = visible.filter((s) => !g.ids.includes(s.id));
    const found: { x?: number; y?: number } = {};
    for (const axis of ["x", "y"] as const) {
      const size = axis === "x" ? lead.w : lead.h;
      const base = origin[axis] + (axis === "x" ? dx : dy);
      let best = SNAP;
      for (const o of others) {
        const oSize = axis === "x" ? o.w : o.h;
        for (const mine of [0, size / 2, size])
          for (const theirs of [0, oSize / 2, oSize]) {
            const gap = o[axis] + theirs - (base + mine);
            if (Math.abs(gap) < Math.abs(best)) {
              best = gap;
              found[axis] = o[axis] + theirs;
            }
          }
      }
      if (found[axis] !== undefined) {
        if (axis === "x") dx += best;
        else dy += best;
      }
    }
    setGuides(found);
    act.patch(g.ids, (s) => ({ x: Math.round(g.start.get(s.id)!.x + dx), y: Math.round(g.start.get(s.id)!.y + dy) }));
  };

  const up = () => {
    const g = gesture.current;
    gesture.current = null;
    setBusy(false);
    setBand(null);
    setGuides({});
    if (g?.kind === "link") {
      if (link?.target) act.connect(g.fromId, link.target);
      setLink(null);
    }
  };

  const linkFrom = link && byId.get(link.from);
  const linkTo = link?.target ? byId.get(link.target) : null;
  const plugged = scene.tool === "connector" && live ? (linkTo ?? (link ? null : byId.get(scene.hover ?? ""))) : null;

  return (
    <div className="ek-diagram" data-live={live} data-expanded={expanded} data-tool={scene.tool} data-busy={busy || undefined}>
      <div
        ref={view}
        className="ek-diagram-view"
        style={{ "--stage-h": `${STAGE.h * (expanded ? 1 : scale) + 28}px` } as CSSProperties}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={() => !busy && act.hover(null)}
        onDoubleClick={(e) => {
          const hit = live && shapeAt(at(e));
          if (hit) setEditing(hit.id);
        }}
        onContextMenu={(e) => {
          if (!live) return;
          e.preventDefault();
          const hit = shapeAt(at(e));
          if (hit && !scene.sel.includes(hit.id)) act.select([hit.id]);
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <div ref={stage} className="ek-stage" style={{ width: STAGE.w, height: STAGE.h, scale: String(scale) }}>
          <svg className="ek-edges" width={STAGE.w} height={STAGE.h} aria-hidden>
            <defs>
              <marker id="ek-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M1 1.5 9 5 1 8.500Z" className="ek-arrow" />
              </marker>
              <marker id="ek-arrow-on" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M1 1.5 9 5 1 8.500Z" className="ek-arrow is-on" />
              </marker>
            </defs>
            {scene.edges.map((edge) => {
              const a = byId.get(edge.from);
              const b = byId.get(edge.to);
              if (!a || !b || a.hidden || b.hidden) return null;
              const on = scene.sel.includes(edge.id);
              const d = edgePath(a, b);
              return (
                <g key={edge.id} data-edge={edge.id} data-on={on}>
                  <path d={d} className="ek-edge-hit" />
                  <path d={d} className="ek-edge" markerEnd={`url(#ek-arrow${on ? "-on" : ""})`} />
                </g>
              );
            })}
            {linkFrom && link && (
              <path
                d={linkTo ? edgePath(linkFrom, linkTo) : `M${linkFrom.x + linkFrom.w / 2} ${linkFrom.y + linkFrom.h / 2}L${link.to.x} ${link.to.y}`}
                className="ek-edge is-preview"
              />
            )}
          </svg>

          {visible.map((s) => (
            <div
              key={s.id}
              className="ek-shape"
              data-kind={s.kind}
              data-locked={s.locked || undefined}
              style={
                {
                  left: s.x,
                  top: s.y,
                  width: s.w,
                  height: s.h,
                  "--fill": s.fill,
                  "--line": s.stroke,
                  "--r": `${Math.min(s.r, s.h / 2)}px`,
                  opacity: s.opacity / 100,
                  fontSize: s.size,
                  fontWeight: s.weight,
                  color: s.fill === "#2B2B28" ? "#fff" : undefined,
                } as CSSProperties
              }
            >
              {(s.kind === "diamond" || s.kind === "polygon") && (
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
                  <polygon points={s.kind === "diamond" ? "50,1 99,50 50,99 1,50" : "50,2 98,98 2,98"} vectorEffect="non-scaling-stroke" />
                </svg>
              )}
              {editing === s.id ? (
                <Editable
                  tag="span"
                  initial={s.text}
                  autoFocus
                  className="ek-shape-text"
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) e.currentTarget.blur();
                  }}
                  onBlur={(text) => {
                    act.record();
                    act.patch([s.id], { text });
                    setEditing(null);
                  }}
                />
              ) : (
                <span className="ek-shape-text">{s.text}</span>
              )}
            </div>
          ))}

          {live && (
            <div className="ek-ov" style={{ "--k": 1 / scale } as CSSProperties}>
              {hovered && scene.tool === "move" && !busy && <i className="ek-ov-hover" style={{ left: hovered.x, top: hovered.y, width: hovered.w, height: hovered.h }} />}
              {guides.x !== undefined && <i className="ek-ov-guide is-v" style={{ left: guides.x }} />}
              {guides.y !== undefined && <i className="ek-ov-guide is-h" style={{ top: guides.y }} />}
              {band && <i className="ek-ov-band" style={{ left: band.x, top: band.y, width: band.w, height: band.h }} />}
              {plugged && (
                <i className="ek-ov-target" data-live={link !== null} style={{ left: plugged.x, top: plugged.y, width: plugged.w, height: plugged.h }}>
                  {["n", "e", "s", "w"].map((side) => (
                    <b key={side} data-plug={side} />
                  ))}
                </i>
              )}
              {frame && !editing && (
                <i className="ek-ov-frame" key={scene.sel.join()} style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}>
                  {selected.length === 1 && ["nw", "ne", "se", "sw"].map((c) => <b key={c} data-grip={c} />)}
                  <em className="ek-ov-chip">
                    {Math.round(frame.w)} × {Math.round(frame.h)}
                  </em>
                </i>
              )}
            </div>
          )}
        </div>
      </div>

      {live ? (
        <IconBtn tip={ui.expanded ? "Collapse stage" : "Expanded stage"} keys="⌘⇧F" className="ek-diagram-expand" onClick={() => uiAct.set({ expanded: !ui.expanded })}>
          {ui.expanded ? <Shrink /> : <Expand />}
        </IconBtn>
      ) : (
        <span className="ek-diagram-hint">A real canvas, not a picture — click in and drag a shape</span>
      )}

      <Pop open={menu !== null} onClose={() => setMenu(null)} anchor={menu ?? { x: 0, y: 0 }} gap={2} label="Canvas actions">
        <Item label="Copy as HTML" onSelect={() => uiAct.toast("Copied as HTML")} />
        <Item label="Copy as React" onSelect={() => uiAct.toast("Copied as React")} />
        <Sep />
        <Item label="Group" keys="⌘G" disabled={scene.sel.length < 2} />
        <Item label="Duplicate" keys="⌘D" disabled={!scene.sel.length} />
        <Item label="Delete" keys="⌫" danger disabled={!scene.sel.length} onSelect={act.remove} />
        <Sep />
        <Item label="Bring to front" keys="⌘⌥]" disabled={!scene.sel.length} onSelect={() => scene.sel[0] && act.reorder(scene.sel[0], scene.shapes.length)} />
        <Item label="Send to back" keys="⌘⌥[" disabled={!scene.sel.length} onSelect={() => scene.sel[0] && act.reorder(scene.sel[0], 0)} />
        <Sep />
        <Item
          label={selected[0]?.locked ? "Unlock" : "Lock"}
          keys="⌘⇧L"
          disabled={!scene.sel.length}
          onSelect={() => {
            act.record();
            act.patch(scene.sel, (s) => ({ locked: !s.locked }));
          }}
        />
        <Item
          label="Hide"
          keys="⌘⇧H"
          disabled={!scene.sel.length}
          onSelect={() => {
            act.record();
            act.patch(scene.sel, { hidden: true });
            act.select([]);
          }}
        />
      </Pop>
    </div>
  );
}
