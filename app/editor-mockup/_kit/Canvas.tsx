"use client";

import { useRef, useState, type CSSProperties } from "react";
import { TOOLS } from "@/app/components/editor/canvas/Toolbar";
import type { Shape } from "./data";
import { useScene, useUi, type Tool } from "./store";
import { ColorField, IconBtn, NumberField, Section, Segmented, Slider } from "./controls";
import { Item, Pop, Select, Sep } from "./overlays";
import { Align, AspectLock, Corner, Eye, FontSize, Glyph, LetterSpacing, LineHeight, Lock, Plus, Redo, Rotation, Settings, StrokeWeight, Undo, X } from "./icons";

const TOOL_META: Record<Tool, [label: string, key: string]> = {
  move: ["Move", "V"],
  scale: ["Scale", "K"],
  hand: ["Hand", "H"],
  zoom: ["Zoom", "Z"],
  rect: ["Rectangle", "R"],
  ellipse: ["Ellipse", "O"],
  polygon: ["Polygon", "G"],
  diamond: ["Diamond", "D"],
  text: ["Text", "T"],
  connector: ["Connector", "C"],
  pen: ["Pen", "P"],
};

/** The toolbar. One highlight travels between tools (`--at`). */
export function CanvasBar({ vertical }: { vertical?: boolean }) {
  const { scene, act } = useScene();
  const [zoomOpen, setZoomOpen] = useState(false);
  const [setOpen, setSetOpen] = useState(false);
  const [snap, setSnap] = useState(true);
  const zoom = useRef<HTMLButtonElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const at = TOOLS.findIndex((t) => t.tool === scene.tool);
  const side = vertical ? "right" : "top";

  return (
    <div role="toolbar" aria-label="Canvas" aria-orientation={vertical ? "vertical" : "horizontal"} className="ek-bar" data-vertical={vertical || undefined}>
      <div className="ek-bar-tools" style={{ "--at": at } as CSSProperties}>
        <span className="ek-bar-mark" aria-hidden />
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            type="button"
            aria-label={TOOL_META[t.tool as Tool][0]}
            aria-pressed={scene.tool === t.tool}
            data-tip={TOOL_META[t.tool as Tool][0]}
            data-keys={TOOL_META[t.tool as Tool][1]}
            className="ek-bar-btn"
            onClick={() => act.tool(t.tool as Tool)}
          >
            {t.icon}
          </button>
        ))}
      </div>
      <span className="ek-bar-sep" />
      <button type="button" aria-label="Undo" data-tip="Undo" data-keys="⌘Z" className="ek-bar-btn" disabled={!scene.past.length} onClick={act.undo}>
        <Undo />
      </button>
      <button type="button" aria-label="Redo" data-tip="Redo" data-keys="⌘⇧Z" className="ek-bar-btn" disabled={!scene.future.length} onClick={act.redo}>
        <Redo />
      </button>
      <span className="ek-bar-sep" />
      <button ref={zoom} type="button" aria-label="Zoom" aria-expanded={zoomOpen} className="ek-bar-zoom" onClick={() => setZoomOpen((o) => !o)}>
        {Math.round(scene.zoom * 100)}%
      </button>
      <button ref={gear} type="button" aria-label="Settings" aria-expanded={setOpen} data-tip="Settings" className="ek-bar-btn" onClick={() => setSetOpen((o) => !o)}>
        <Settings width={16} height={16} />
      </button>

      <Pop open={zoomOpen} onClose={() => setZoomOpen(false)} anchor={zoom} side={side} align="end" gap={10} label="Zoom">
        <Item label="Zoom in" keys="⌘=" keepOpen onSelect={() => act.zoomBy(1.25)} />
        <Item label="Zoom out" keys="⌘-" keepOpen onSelect={() => act.zoomBy(0.8)} />
        <Item label="Zoom to 100%" keys="⌘0" onSelect={() => act.set({ zoom: 1 })} />
        <Item label="Zoom to fit" keys="⌘1" onSelect={() => act.set({ zoom: 1 })} />
        <Sep />
        <ExpandedItem />
        <Item label="Hide UI" keys="⌘." checked={false} />
      </Pop>
      <Pop open={setOpen} onClose={() => setSetOpen(false)} anchor={gear} side={side} align="end" gap={10} label="Canvas settings">
        <Item label="Snap to guides" checked={snap} keepOpen onSelect={() => setSnap((s) => !s)} />
      </Pop>
    </div>
  );
}

function ExpandedItem() {
  const { ui, act } = useUi();
  return <Item label="Expanded stage" keys="⌘⇧F" checked={ui.expanded} onSelect={() => act.set({ expanded: !ui.expanded })} />;
}

const KIND_GLYPH: Record<Shape["kind"], string> = {
  rect: "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
  tag: "M5 8h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Z",
  ellipse: "M3 12a9 7 0 1 0 18 0 9 7 0 1 0-18 0",
  text: "M5 6h14M12 6v12M9 18h6",
  polygon: "M12 4l8 15H4Z",
  diamond: "M12 3l9 9-9 9-9-9Z",
};
const ROW = 28;

/** Front-most at the top. Rows drag to reorder under the canvas's one accent. */
export function Layers() {
  const { scene, act } = useScene();
  const list = useRef<HTMLUListElement>(null);
  const [drag, setDrag] = useState<{ id: string; line: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const press = useRef<{ id: string; y: number; live: boolean } | null>(null);
  const rows = [...scene.shapes].reverse();
  const byId = new Map(scene.shapes.map((s) => [s.id, s]));

  const slotAt = (clientY: number) => {
    const top = list.current!.getBoundingClientRect().top;
    return Math.max(0, Math.min(rows.length, Math.round((clientY - top) / ROW)));
  };

  return (
    <div className="ek-layers" data-dragging={drag !== null || undefined}>
      <header className="ek-section-label">
        <span>Layers</span>
        <span className="ek-meta">{scene.shapes.length}</span>
      </header>
      <ul
        ref={list}
        role="tree"
        className="ek-lyr-list ek-stagger"
        onPointerMove={(e) => {
          const p = press.current;
          if (!p) return;
          if (!p.live && Math.abs(e.clientY - p.y) < 4) return;
          p.live = true;
          setDrag({ id: p.id, line: slotAt(e.clientY) });
        }}
        onPointerUp={(e) => {
          const p = press.current;
          press.current = null;
          if (p?.live) act.reorder(p.id, scene.shapes.length - slotAt(e.clientY));
          setDrag(null);
        }}
        onPointerLeave={() => act.hover(null)}
      >
        {rows.map((s) => (
          <li
            key={s.id}
            role="treeitem"
            aria-selected={scene.sel.includes(s.id)}
            className="ek-lyr"
            data-hover={scene.hover === s.id || undefined}
            data-dim={s.hidden || s.locked || undefined}
            data-moving={drag?.id === s.id || undefined}
            onPointerEnter={() => act.hover(s.id)}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest("button, input")) return;
              e.currentTarget.parentElement!.setPointerCapture(e.pointerId);
              press.current = { id: s.id, y: e.clientY, live: false };
              act.select(e.shiftKey ? [...scene.sel, s.id] : [s.id]);
            }}
            onDoubleClick={() => setRenaming(s.id)}
          >
            <Glyph d={KIND_GLYPH[s.kind]} className="ek-lyr-icon" />
            {renaming === s.id ? (
              <input
                autoFocus
                aria-label="Layer name"
                defaultValue={s.name}
                className="ek-row-edit"
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => {
                  act.patch([s.id], { name: e.currentTarget.value || s.name });
                  setRenaming(null);
                }}
                onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && e.currentTarget.blur()}
              />
            ) : (
              <span className="ek-lyr-name">{s.name}</span>
            )}
            <button type="button" className="ek-lyr-tog" data-on={s.locked || undefined} aria-label={s.locked ? "Unlock layer" : "Lock layer"} onClick={() => act.patch([s.id], { locked: !s.locked })}>
              <Lock width={12} height={12} open={!s.locked} />
            </button>
            <button type="button" className="ek-lyr-tog" data-on={s.hidden || undefined} aria-label={s.hidden ? "Show layer" : "Hide layer"} onClick={() => act.patch([s.id], { hidden: !s.hidden })}>
              <Eye off={s.hidden} />
            </button>
          </li>
        ))}
        {drag && <li className="ek-lyr-line" role="presentation" style={{ top: drag.line * ROW }} />}
      </ul>

      <header className="ek-section-label">
        <span>Connectors</span>
      </header>
      <ul role="listbox" aria-label="Connectors" className="ek-lyr-list">
        {scene.edges.map((e) => (
          <li key={e.id} role="option" aria-selected={scene.sel.includes(e.id)} className="ek-lyr" onClick={() => act.select([e.id])}>
            <Glyph d="M4 7h6a3 3 0 0 1 3 3v4a3 3 0 0 0 3 3h4" className="ek-lyr-icon" />
            <span className="ek-lyr-name">
              {byId.get(e.from)?.name} → {byId.get(e.to)?.name}
            </span>
            <button
              type="button"
              className="ek-lyr-tog"
              aria-label="Delete connector"
              onClick={(ev) => {
                ev.stopPropagation();
                act.record();
                act.set((s) => ({ edges: s.edges.filter((x) => x.id !== e.id) }));
              }}
            >
              <X width={12} height={12} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const ALIGNS = [
  ["Align left", "⌥A", "2.5,2,2.5,14", "3.5,4,9,3 3.5,9,6,3"],
  ["Align horizontal centres", "⌥H", "8,2,8,14", "3.5,4,9,3 5,9,6,3"],
  ["Align right", "⌥D", "13.5,2,13.5,14", "3.5,4,9,3 6.5,9,6,3"],
  ["Align top", "⌥W", "2,2.5,14,2.5", "4,3.5,3,9 9,3.5,3,6"],
  ["Align vertical centres", "⌥V", "2,8,14,8", "4,3.5,3,9 9,5,3,6"],
  ["Align bottom", "⌥S", "2,13.5,14,13.5", "4,3.5,3,9 9,6.5,3,6"],
] as const;

const WEIGHTS = { Regular: 400, Medium: 500, Semibold: 600, Bold: 700 } as const;

/** The style panel, in Figma's order. Every number scrubs from its own name. */
export function Inspector() {
  const { scene, act } = useScene();
  const picked = scene.shapes.filter((s) => scene.sel.includes(s.id));
  const s = picked[0];
  const ids = picked.map((p) => p.id);
  const [aspect, setAspect] = useState(false);
  const [font, setFont] = useState("Geist");
  const [blend, setBlend] = useState("Normal");
  const [fillType, setFillType] = useState("Solid");
  const [strokeAlign, setStrokeAlign] = useState("Inside");
  const [dash, setDash] = useState<"solid" | "dash" | "dot">("solid");
  const [effects, setEffects] = useState<string[]>([]);

  const align = (i: number) => {
    if (picked.length < 2) return;
    act.record();
    const x0 = Math.min(...picked.map((p) => p.x));
    const x1 = Math.max(...picked.map((p) => p.x + p.w));
    const y0 = Math.min(...picked.map((p) => p.y));
    const y1 = Math.max(...picked.map((p) => p.y + p.h));
    act.patch(ids, (p) => [{ x: x0 }, { x: Math.round((x0 + x1) / 2 - p.w / 2) }, { x: x1 - p.w }, { y: y0 }, { y: Math.round((y0 + y1) / 2 - p.h / 2) }, { y: y1 - p.h }][i]);
  };

  if (!s) {
    return (
      <div className="ek-inspector">
        <header className="ek-section-label">
          <span>Canvas</span>
        </header>
        <Section title="Canvas">
          <div className="ek-grid-2">
            <NumberField lead="W" label="Width" value={600} onChange={() => {}} />
            <NumberField lead="H" label="Height" value={298} onChange={() => {}} />
          </div>
          <div className="ek-field-row">
            <span className="ek-field-name">Background</span>
            <ColorField label="Background" value="#F7F7F5" onChange={() => {}} />
          </div>
        </Section>
        <p className="ek-note ek-inspector-empty">Select a shape to style it. Drag over the canvas to select several.</p>
      </div>
    );
  }

  const patch = (change: Partial<Shape>) => act.patch(ids, change);
  const weightName = (Object.entries(WEIGHTS).find(([, v]) => v === s.weight)?.[0] ?? "Medium") as keyof typeof WEIGHTS;

  return (
    <div className="ek-inspector" key={picked.length > 1 ? "many" : s.id}>
      <header className="ek-section-label">
        <span>Design</span>
        {picked.length > 1 && <span className="ek-meta">{picked.length} selected</span>}
      </header>

      <div className="ek-align" role="group" aria-label="Align and distribute">
        {ALIGNS.map(([label, keys, rule, bars], i) => (
          <IconBtn key={label} tip={label} keys={keys} className="is-sm" disabled={picked.length < 2} onClick={() => align(i)}>
            <Align rule={rule} bars={bars} />
          </IconBtn>
        ))}
        <span className="ek-align-gap" />
        <IconBtn tip="Distribute horizontally" className="is-sm" disabled={picked.length < 3}>
          <Align bars="2,4,3,8 6.5,4,3,8 11,4,3,8" />
        </IconBtn>
        <IconBtn tip="Distribute vertically" className="is-sm" disabled={picked.length < 3}>
          <Align bars="4,2,8,3 4,6.5,8,3 4,11,8,3" />
        </IconBtn>
      </div>

      <Section title="Transform">
        <div className="ek-grid-2 has-end">
          <NumberField lead="X" label="X position" value={s.x} onStart={act.record} onChange={(x) => patch({ x })} />
          <NumberField lead="Y" label="Y position" value={s.y} onStart={act.record} onChange={(y) => patch({ y })} />
          <span />
          <NumberField lead="W" label="Width" value={s.w} min={24} onStart={act.record} onChange={(w) => patch(aspect ? { w, h: Math.round((w * s.h) / s.w) } : { w })} />
          <NumberField lead="H" label="Height" value={s.h} min={20} onStart={act.record} onChange={(h) => patch(aspect ? { h, w: Math.round((h * s.w) / s.h) } : { h })} />
          <IconBtn tip={aspect ? "Unlock aspect ratio" : "Lock aspect ratio"} className="is-sm" on={aspect} onClick={() => setAspect((a) => !a)}>
            <AspectLock on={aspect} />
          </IconBtn>
          <NumberField lead={<Rotation />} label="Rotation" value={0} unit="°" onChange={() => {}} />
          <NumberField lead={<Corner />} label="Corner radius" value={Math.min(s.r, 99)} min={0} max={99} onStart={act.record} onChange={(r) => patch({ r })} />
        </div>
      </Section>

      <Section title="Text">
        <Select label="Font" lead="Font" value={font} options={["Geist", "Inter", "Caveat"]} onChange={setFont} />
        <div className="ek-grid-2">
          <Select label="Weight" value={weightName} options={Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]} onChange={(w) => { act.record(); patch({ weight: WEIGHTS[w] }); }} />
          <NumberField lead={<FontSize />} label="Font size" value={s.size} min={8} max={64} unit="px" onStart={act.record} onChange={(size) => patch({ size })} />
          <NumberField lead={<LineHeight />} label="Line height" value={120} unit="%" onChange={() => {}} />
          <NumberField lead={<LetterSpacing />} label="Letter spacing" value={0} unit="px" onChange={() => {}} />
        </div>
      </Section>

      <Section title="Appearance">
        <div className="ek-field-row">
          <Slider label="Opacity" value={s.opacity} onStart={act.record} onChange={(opacity) => patch({ opacity })} />
          <NumberField lead="" label="Opacity" value={s.opacity} min={0} max={100} unit="%" onStart={act.record} onChange={(opacity) => patch({ opacity })} />
        </div>
        <Select label="Blend mode" lead="Blend" value={blend} options={["Normal", "Multiply", "Screen", "Overlay"]} onChange={setBlend} />
      </Section>

      <Section title="Fill" end={<IconBtn tip="Add fill" className="is-sm"><Plus width={12} height={12} /></IconBtn>}>
        <Select label="Fill type" value={fillType} options={["Solid", "Linear", "Radial", "Image"]} onChange={setFillType} />
        <ColorField label="Fill" value={s.fill === "transparent" ? "#FFFFFF" : s.fill} onStart={act.record} onChange={(fill) => patch({ fill })} />
      </Section>

      <Section title="Stroke">
        <ColorField label="Stroke" value={s.stroke === "transparent" ? "#D8D8D4" : s.stroke} onStart={act.record} onChange={(stroke) => patch({ stroke })} />
        <div className="ek-grid-2">
          <NumberField lead={<StrokeWeight />} label="Stroke weight" value={1} unit="px" onChange={() => {}} />
          <Segmented
            label="Dash"
            value={dash}
            onChange={setDash}
            className="is-sm"
            options={[
              { value: "solid", label: <i className="ek-dash" />, tip: "Solid" },
              { value: "dash", label: <i className="ek-dash is-dash" />, tip: "Dashed" },
              { value: "dot", label: <i className="ek-dash is-dot" />, tip: "Dotted" },
            ]}
          />
        </div>
        <Select label="Stroke align" lead="Align" value={strokeAlign} options={["Inside", "Centre", "Outside"]} onChange={setStrokeAlign} />
      </Section>

      <Section
        title="Effects"
        end={
          <IconBtn tip="Add effect" className="is-sm" onClick={() => setEffects((e) => [...e, "Drop shadow"])}>
            <Plus width={12} height={12} />
          </IconBtn>
        }
      >
        {effects.length === 0 && <p className="ek-note">No effects</p>}
        {effects.map((name, i) => (
          <div key={i} className="ek-field-row ek-effect">
            <Select label="Effect type" value={name} options={["Drop shadow", "Inner shadow", "Layer blur", "Background blur"]} onChange={(v) => setEffects((e) => e.map((x, j) => (j === i ? v : x)))} />
            <IconBtn tip="Remove effect" className="is-sm" onClick={() => setEffects((e) => e.filter((_, j) => j !== i))}>
              <X width={12} height={12} />
            </IconBtn>
          </div>
        ))}
      </Section>
    </div>
  );
}
