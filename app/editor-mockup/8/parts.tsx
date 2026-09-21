"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from "react";
import { TOOLS } from "@/app/components/editor/canvas/Toolbar";
import { swatches, type Shape } from "../_kit/data";
import { useScene, useUi, type Tool } from "../_kit/store";
import { usePresence } from "../_kit/presence";
import { IconBtn, NumberField } from "../_kit/controls";
import { Pop, Select } from "../_kit/overlays";
import { Align, ArrowUp, AspectLock, ChevronDown, Corner, Duplicate, Eye, FileDoc, FontSize, Lock, MoreHorizontal, Sparkle, Trash } from "../_kit/icons";
import { Account, BackLink, Facepile, FindButton, Pages, ProjectTitle, ShareButton } from "../_kit/Shell";
import { Inspector, Layers } from "../_kit/Canvas";
import { Chat } from "../_kit/Chat";

const TOOL_META: Record<string, [label: string, key: string]> = {
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

const ALIGNS = [
  ["Align left", "⌥A", "2.5,2,2.5,14", "3.5,4,9,3 3.5,9,6,3"],
  ["Align horizontal centres", "⌥H", "8,2,8,14", "3.5,4,9,3 5,9,6,3"],
  ["Align right", "⌥D", "13.5,2,13.5,14", "3.5,4,9,3 6.5,9,6,3"],
  ["Align top", "⌥W", "2,2.5,14,2.5", "4,3.5,3,9 9,3.5,3,6"],
  ["Align vertical centres", "⌥V", "2,8,14,8", "4,3.5,3,9 9,5,3,6"],
  ["Align bottom", "⌥S", "2,13.5,14,13.5", "4,3.5,3,9 9,6.5,3,6"],
] as const;

const WEIGHTS = { Regular: 400, Medium: 500, Semibold: 600, Bold: 700 } as const;

const typing = (e: Event) => (e.target as HTMLElement).closest?.("input, textarea, [contenteditable], [data-ek-pop], [role='dialog']") != null;

/* ---- Header: there when the pointer goes looking for it ------------------ */

export function Head() {
  const { ui } = useUi();
  const head = useRef<HTMLElement>(null);
  const pagesBtn = useRef<HTMLButtonElement>(null);
  // Opened for a page: choosing another page is what closes it, so nothing has
  // to watch for the change. A page being named keeps it up.
  const [pagesFor, setPagesFor] = useState<string | null>(null);
  const pagesOpen = pagesFor !== null && (pagesFor === ui.pageId || ui.renaming !== null);
  const page = ui.pages.find((p) => p.id === ui.pageId);

  useEffect(() => {
    const el = head.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout>;
    let y = 999;
    const rest = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (y < 80 || el.querySelector("[aria-expanded='true'], :focus-visible")) return rest();
        el.dataset.idle = "true";
      }, 2500);
    };
    const wake = () => {
      el.dataset.idle = "false";
      rest();
    };
    const onMove = (e: PointerEvent) => {
      y = e.clientY;
      if (y < 80) wake();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) wake();
    };
    rest();
    document.addEventListener("pointermove", onMove);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <header ref={head} className="h-head">
      <div className="h-head-side">
        <Account />
        <BackLink />
        <button ref={pagesBtn} type="button" className="ek-row h-pages-btn" aria-haspopup="dialog" aria-expanded={pagesOpen} onClick={() => setPagesFor(pagesOpen ? null : ui.pageId)}>
          <FileDoc width={14} height={14} className="ek-row-icon" />
          <span className="ek-row-label">{page?.title || "Untitled"}</span>
          <ChevronDown width={12} height={12} className="h-pages-caret" />
        </button>
        <Pop open={pagesOpen} onClose={() => setPagesFor(null)} anchor={pagesBtn} role="dialog" label="Pages" className="h-pop-pages" exitMs={150}>
          <Pages />
        </Pop>
      </div>
      <ProjectTitle className="h-title" />
      <div className="h-head-side is-end">
        <FindButton compact />
        <Facepile />
        <ShareButton filled />
      </div>
    </header>
  );
}

/* ---- Halo: the controls that hug the selection --------------------------- */

/**
 * Finds the selection frame and the canvas block on screen and writes where
 * they are onto the halo's layer. First among its siblings on purpose: its
 * layout effect runs before theirs, so a popover placing itself against a halo
 * button reads a position that is already this commit's.
 */
function Measure({ layer }: { layer: RefObject<HTMLDivElement | null> }) {
  const { ui } = useUi();
  const { scene } = useScene();

  useLayoutEffect(() => {
    const measure = () => {
      const el = layer.current;
      if (!el) return;
      const frame = document.querySelector(".h .ek-ov-frame")?.getBoundingClientRect();
      const block = document.querySelector(".h .ek-diagram")?.getBoundingClientRect();
      el.dataset.lost = String(!frame);
      if (frame) {
        el.style.setProperty("--x", `${frame.left}px`);
        el.style.setProperty("--y", `${frame.top}px`);
        el.style.setProperty("--w", `${frame.width}px`);
        el.style.setProperty("--h", `${frame.height}px`);
      }
      if (block) {
        el.style.setProperty("--dx", `${block.left}px`);
        el.style.setProperty("--dy", `${block.top}px`);
        el.style.setProperty("--dh", `${block.height}px`);
      }
    };
    // A zoom or a stage opening eases for a third of a second, and the frame
    // is somewhere new on every frame of it.
    const until = performance.now() + 400;
    let raf = 0;
    const follow = () => {
      measure();
      if (performance.now() < until) raf = requestAnimationFrame(follow);
    };
    follow();
    document.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [layer, scene.shapes, scene.sel, scene.zoom, ui.mode, ui.expanded]);

  return null;
}

function Swatch({ label, value, ring, onPick }: { label: string; value: string; ring?: boolean; onPick: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const shown = value === "transparent" ? "#FFFFFF" : value;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={`${label} colour`}
        aria-expanded={open}
        data-tip={label}
        className="h-swatch"
        data-ring={ring || undefined}
        style={{ "--c": shown } as CSSProperties}
        onClick={() => setOpen((o) => !o)}
      />
      <Pop open={open} onClose={() => setOpen(false)} anchor={anchor} side="top" align="center" gap={10} role="dialog" label={`${label} colours`} className="ek-pop-colors">
        <div className="ek-group-label">Document colours</div>
        <div className="ek-swatches">
          {swatches.map((c) => (
            <button key={c} type="button" aria-label={c} aria-pressed={c.toLowerCase() === shown.toLowerCase()} className="ek-swatch" style={{ "--c": c } as CSSProperties} onClick={() => onPick(c)} />
          ))}
        </div>
      </Pop>
    </>
  );
}

function One({ s }: { s: Shape }) {
  const { act } = useScene();
  const [aspect, setAspect] = useState(false);
  const [more, setMore] = useState(false);
  const dots = useRef<HTMLButtonElement>(null);
  const patch = (change: Partial<Shape>) => act.patch([s.id], change);
  const weight = (Object.entries(WEIGHTS).find(([, v]) => v === s.weight)?.[0] ?? "Medium") as keyof typeof WEIGHTS;

  return (
    <>
      <div className="h-at is-top">
        <div className="h-strip" role="toolbar" aria-label="Style">
          <Swatch label="Fill" value={s.fill} onPick={(fill) => (act.record(), patch({ fill }))} />
          <Swatch label="Stroke" value={s.stroke} ring onPick={(stroke) => (act.record(), patch({ stroke }))} />
          <i className="h-strip-sep" />
          <NumberField lead={<Corner />} label="Corner radius" value={Math.min(s.r, 99)} min={0} max={99} onStart={act.record} onChange={(r) => patch({ r })} />
          <NumberField lead={<FontSize />} label="Font size" value={s.size} min={8} max={64} onStart={act.record} onChange={(size) => patch({ size })} />
          <Select label="Weight" value={weight} options={Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]} onChange={(w) => (act.record(), patch({ weight: WEIGHTS[w] }))} className="is-quiet" />
          <i className="h-strip-sep" />
          <button ref={dots} type="button" className="ek-icon-btn is-sm" aria-label="All properties" aria-expanded={more} data-tip="All properties" onClick={() => setMore((o) => !o)}>
            <MoreHorizontal width={14} height={14} />
          </button>
        </div>
      </div>
      <Pop open={more} onClose={() => setMore(false)} anchor={dots} side="right" gap={12} role="dialog" label="Design" className="h-pop-inspector" at={`${s.x},${s.y},${s.w},${s.h}`} exitMs={150}>
        <Inspector />
      </Pop>

      <div className="h-at is-bottom">
        <div className="h-strip is-size" role="group" aria-label="Size">
          <NumberField lead="W" label="Width" value={s.w} min={24} onStart={act.record} onChange={(w) => patch(aspect ? { w, h: Math.max(20, Math.round((w * s.h) / s.w)) } : { w })} />
          <IconBtn tip={aspect ? "Unlock aspect ratio" : "Lock aspect ratio"} className="is-sm" on={aspect} onClick={() => setAspect((a) => !a)}>
            <AspectLock on={aspect} />
          </IconBtn>
          <NumberField lead="H" label="Height" value={s.h} min={20} onStart={act.record} onChange={(h) => patch(aspect ? { h, w: Math.max(24, Math.round((h * s.w) / s.h)) } : { h })} />
        </div>
      </div>
    </>
  );
}

function Many({ picked }: { picked: Shape[] }) {
  const { act } = useScene();
  const ids = picked.map((p) => p.id);
  const align = (i: number) => {
    act.record();
    const x0 = Math.min(...picked.map((p) => p.x));
    const x1 = Math.max(...picked.map((p) => p.x + p.w));
    const y0 = Math.min(...picked.map((p) => p.y));
    const y1 = Math.max(...picked.map((p) => p.y + p.h));
    act.patch(ids, (p) => [{ x: x0 }, { x: Math.round((x0 + x1) / 2 - p.w / 2) }, { x: x1 - p.w }, { y: y0 }, { y: Math.round((y0 + y1) / 2 - p.h / 2) }, { y: y1 - p.h }][i]);
  };
  return (
    <div className="h-at is-top">
      <div className="h-strip" role="toolbar" aria-label="Align and distribute">
        <span className="ek-meta h-strip-count">{picked.length} selected</span>
        <i className="h-strip-sep" />
        {ALIGNS.map(([label, keys, rule, bars], i) => (
          <IconBtn key={label} tip={label} keys={keys} className="is-sm" onClick={() => align(i)}>
            <Align rule={rule} bars={bars} />
          </IconBtn>
        ))}
        <i className="h-strip-sep" />
        <IconBtn tip="Distribute horizontally" className="is-sm" disabled={picked.length < 3}>
          <Align bars="2,4,3,8 6.5,4,3,8 11,4,3,8" />
        </IconBtn>
        <IconBtn tip="Distribute vertically" className="is-sm" disabled={picked.length < 3}>
          <Align bars="4,2,8,3 4,6.5,8,3 4,11,8,3" />
        </IconBtn>
      </div>
    </div>
  );
}

function Actions({ picked }: { picked: Shape[] }) {
  const { scene, act } = useScene();
  const ids = picked.map((p) => p.id);
  const locked = picked.every((p) => p.locked);
  const duplicate = () => {
    const stamp = Date.now();
    act.record();
    act.set((sc) => {
      const made = sc.shapes.filter((x) => ids.includes(x.id)).map((x, i) => ({ ...x, id: `dup-${stamp}-${i}`, x: x.x + 16, y: x.y + 16 }));
      return { shapes: [...sc.shapes, ...made], sel: made.map((m) => m.id) };
    });
  };
  return (
    <>
      <div className="h-at is-right">
        <div className="h-strip is-col" role="toolbar" aria-label="Arrange" aria-orientation="vertical">
          <IconBtn tip="Duplicate" keys="⌘D" className="is-sm" onClick={duplicate}>
            <Duplicate width={14} height={14} />
          </IconBtn>
          <IconBtn tip="Bring to front" keys="⌘⌥]" className="is-sm" onClick={() => act.reorder(ids[0], scene.shapes.length)}>
            <ArrowUp width={14} height={14} />
          </IconBtn>
          <IconBtn tip={locked ? "Unlock" : "Lock"} keys="⌘⇧L" className="is-sm" on={locked} onClick={() => (act.record(), act.patch(ids, { locked: !locked }))}>
            <Lock width={14} height={14} open={!locked} />
          </IconBtn>
          <IconBtn
            tip="Hide"
            keys="⌘⇧H"
            className="is-sm"
            onClick={() => {
              act.record();
              act.patch(ids, { hidden: true });
              act.select([]);
            }}
          >
            <Eye off />
          </IconBtn>
          <IconBtn tip="Delete" keys="⌫" className="is-sm h-danger" onClick={act.remove}>
            <Trash width={14} height={14} />
          </IconBtn>
        </div>
      </div>
      <div className="h-at is-left">
        <button type="button" className="h-link" aria-label="Connect from here" data-tip="Connect from here" data-keys="C" onClick={() => act.tool("connector")}>
          {TOOLS.find((t) => t.tool === "connector")?.icon}
        </button>
      </div>
    </>
  );
}

/** One tick per layer on the block's left edge; the rail opens into the full list. */
function Depth() {
  const { ui } = useUi();
  const { scene, act } = useScene();
  const live = ui.mode === "diagram";
  const rows = [...scene.shapes].reverse();
  return (
    <div className="h-depth" data-on={live} data-pinned={ui.left} onPointerLeave={() => act.hover(null)}>
      <div className="h-ticks" aria-hidden={ui.left}>
        {rows.map((s) => (
          <button
            key={s.id}
            type="button"
            tabIndex={live ? 0 : -1}
            aria-label={s.name}
            className="h-tick"
            data-sel={scene.sel.includes(s.id) || undefined}
            data-hover={scene.hover === s.id || undefined}
            data-dim={s.hidden || s.locked || undefined}
            onPointerEnter={() => act.hover(s.id)}
            onClick={(e) => act.select(e.shiftKey ? [...scene.sel, s.id] : [s.id])}
          />
        ))}
      </div>
      <div className="h-depth-card">
        <Layers />
      </div>
    </div>
  );
}

export function Halo() {
  const { ui } = useUi();
  const { scene } = useScene();
  const layer = useRef<HTMLDivElement>(null);
  const picked = scene.shapes.filter((s) => scene.sel.includes(s.id) && !s.hidden);
  const on = ui.mode === "diagram" && picked.length > 0;
  return (
    <div ref={layer} className="h-halo" data-on={on}>
      <Measure layer={layer} />
      {on && (
        // Keyed by the selection, so a new one is greeted rather than inherited.
        <div className="h-halo-parts" key={scene.sel.join()}>
          {picked.length === 1 ? <One s={picked[0]} /> : <Many picked={picked} />}
          <Actions picked={picked} />
        </div>
      )}
      <Depth />
    </div>
  );
}

/* ---- The wheel: tools come to the pointer -------------------------------- */

const SLICE = 360 / TOOLS.length;

export function Wheel() {
  const { ui } = useUi();
  const { scene, act } = useScene();
  const live = ui.mode === "diagram";
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [hot, setHot] = useState<number | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const centre = useRef({ x: 0, y: 0 });
  const held = useRef(false);
  const latest = useRef({ open, hot });
  useEffect(() => {
    latest.current = { open, hot };
  });
  const shown = open && live;
  const { mounted, state } = usePresence(shown, 170);

  useEffect(() => {
    if (!live) return;
    const raise = (x: number, y: number) => {
      const at = { x: Math.max(124, Math.min(innerWidth - 124, x)), y: Math.max(124, Math.min(innerHeight - 124, y)) };
      centre.current = at;
      setPos(at);
      setHot(null);
      setOpen(true);
    };
    const pick = (i: number | null) => {
      if (i !== null) act.tool(TOOLS[i].tool as Tool);
      setOpen(false);
    };
    const onMove = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      if (!latest.current.open) return;
      const dx = e.clientX - centre.current.x;
      const dy = e.clientY - centre.current.y;
      if (Math.hypot(dx, dy) < 30) return setHot(null);
      const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360;
      setHot(Math.round(deg / SLICE) % TOOLS.length);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " ") {
        // Space on a focused button is still that button's.
        if ((e.target as HTMLElement).closest("button, a")) return;
        e.preventDefault();
        if (e.repeat || latest.current.open) return;
        held.current = true;
        return raise(pointer.current.x, pointer.current.y);
      }
      if (e.key.toLowerCase() === "q") return latest.current.open ? setOpen(false) : raise(pointer.current.x, pointer.current.y);
      if (e.key === "Escape" && latest.current.open) {
        // The canvas hears Escape as "step out"; while the wheel is up it is the wheel's.
        e.stopPropagation();
        held.current = false;
        setOpen(false);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " " || !held.current) return;
      held.current = false;
      if (latest.current.open) pick(latest.current.hot);
    };
    const onContext = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".ek-diagram-view") || t.closest(".ek-shape, [data-edge]")) return;
      e.preventDefault();
      e.stopPropagation();
      raise(e.clientX, e.clientY);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("contextmenu", onContext, true);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("contextmenu", onContext, true);
    };
  }, [live, act]);

  if (!mounted) return null;
  const named = TOOLS[hot ?? Math.max(0, TOOLS.findIndex((t) => t.tool === scene.tool))];
  return (
    <div
      className="h-wheel-layer"
      data-state={state}
      onPointerDown={(e) => {
        e.preventDefault();
        if (hot !== null) act.tool(TOOLS[hot].tool as Tool);
        setOpen(false);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="h-wheel" role="menu" aria-label="Tools" data-state={state} style={{ left: pos.x, top: pos.y, "--hot": hot ?? 0, "--slice": `${SLICE}deg` } as CSSProperties}>
        <span className="h-wheel-ring" aria-hidden />
        <span className="h-wheel-wedge" data-on={hot !== null} aria-hidden />
        {TOOLS.map((t, i) => (
          <span key={t.tool} role="menuitem" aria-label={TOOL_META[t.tool][0]} className="h-wheel-item" data-hot={hot === i || undefined} data-active={scene.tool === t.tool || undefined} style={{ "--i": i } as CSSProperties}>
            <span>{t.icon}</span>
          </span>
        ))}
        <span className="h-wheel-hub">
          <b>{TOOL_META[named.tool][0]}</b>
          <kbd>{TOOL_META[named.tool][1]}</kbd>
        </span>
      </div>
    </div>
  );
}

/* ---- Ask: an orb that becomes the conversation --------------------------- */

const noop = () => () => {};

export function Ask() {
  const { ui, act } = useUi();
  // Closed until the page is this browser's, so the card never flashes open on
  // the way in (`ui.right` starts true; the mockup turns it off as it mounts).
  const hydrated = useSyncHydrated();
  const open = hydrated && ui.right;
  const busy = ui.streaming !== null || ui.review === "open";
  return (
    <aside className="h-ask" aria-label="Assistant" data-open={open}>
      <button type="button" className="h-ask-orb" aria-label="Ask Nootles" aria-expanded={open} data-tip="Ask" data-keys="⌘J" tabIndex={open ? -1 : 0} onClick={() => act.set({ right: true })}>
        <Sparkle width={20} height={20} />
        {busy && <i className="h-ask-dot" />}
      </button>
      <div className="h-ask-body" inert={!open}>
        <Chat
          end={
            <IconBtn tip="Put away" keys="⌘J" side="bottom" onClick={() => act.set({ right: false })}>
              <ChevronDown />
            </IconBtn>
          }
        />
      </div>
    </aside>
  );
}

function useSyncHydrated() {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}
