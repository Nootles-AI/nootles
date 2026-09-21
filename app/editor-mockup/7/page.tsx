"use client";

import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Kit, useScene, useUi } from "../_kit/store";
import { IconBtn } from "../_kit/controls";
import { Pop } from "../_kit/overlays";
import { Chat as ChatIcon, ChevronDown, FileDoc, Layers as LayersIcon, Sliders, X } from "../_kit/icons";
import { Account, BackLink, ContextRow, Facepile, FindButton, Pages, ProjectTitle, ShareButton } from "../_kit/Shell";
import { Doc } from "../_kit/Doc";
import { Diagram } from "../_kit/Diagram";
import { CanvasBar, Inspector, Layers } from "../_kit/Canvas";
import { Chat } from "../_kit/Chat";
import { Chrome } from "../_kit/Extras";
import "./style.css";

/*
  THESIS: a page is 1:1 with a canvas surface, so show both — the writing and the
  drawing are two panes of one window, always. Refuses the document-with-a-
  diagram-stuck-in-it arrangement every block editor ships.
  OWN-WORLD: graphite on paper; the pane in use is paper, the other recedes into
  the well; one hairline divider with a grip, ink for the filled controls, and
  surfaces that arrive on the damped spring.
  STORY: you write on the left and draw on the right, and the window leans
  toward whichever you are doing. Tools stand between the two, on the seam.
  FIRST VIEWPORT: a 52px header in the projects page's grammar (account, back,
  pages button · project title · find, faces, ink Share); below it 58% writing /
  42% canvas preview split by a draggable divider; an ink "Ask" tab bottom-centre
  that raises the assistant as a drawer between the panes.
  FORM: structure 7 of 10 — split panes; the divider is the signature, snapping
  to thirds and halves and carrying the toolbar while you draw.
*/

const SNAPS = [1 / 3, 0.5, 2 / 3];
const clamp = (v: number) => Math.min(0.75, Math.max(0.25, v));
const settle = (v: number) => SNAPS.find((s) => Math.abs(s - v) < 0.03) ?? Math.round(v * 1000) / 1000;

function PagesButton() {
  const { ui } = useUi();
  // Open "for" a page: choosing another one closes it without an effect, and
  // it holds while a new page is still being named.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const open = openAt !== null && (openAt === ui.pageId || ui.renaming !== null);
  const title = ui.pages.find((p) => p.id === ui.pageId)?.title || "Untitled";
  return (
    <>
      <button ref={anchor} type="button" className="ek-row sl-pages-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpenAt(open ? null : ui.pageId)}>
        <FileDoc width={14} height={14} className="ek-row-icon" />
        <span className="ek-row-label">{title}</span>
        <ChevronDown width={12} height={12} className="sl-pages-caret" />
      </button>
      <Pop open={open} onClose={() => setOpenAt(null)} anchor={anchor} role="dialog" label="Pages" className="sl-pop-pages" exitMs={150}>
        <ContextRow />
        <Pages />
      </Pop>
    </>
  );
}

/**
 * The seam. Dragging writes `--split` straight onto the shell, so a pointer
 * move is never a render of two panes; release settles on a third or a half if
 * one is near, and the spring carries it the last few pixels.
 */
function Divider({ value, onChange, onReset }: { value: number; onChange: (v: number) => void; onReset: () => void }) {
  const drag = useRef<number | null>(null);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".ek-bar") || matchMedia("(max-width: 1000px)").matches) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = value;
    e.currentTarget.parentElement?.setAttribute("data-dragging", "true");
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget.parentElement;
    if (drag.current === null || !el) return;
    const r = el.getBoundingClientRect();
    drag.current = clamp((e.clientX - r.left) / r.width);
    el.style.setProperty("--split", String(drag.current));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget.parentElement;
    if (drag.current === null || !el) return;
    const to = settle(drag.current);
    drag.current = null;
    el.removeAttribute("data-dragging");
    el.style.setProperty("--split", String(to));
    onChange(to);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === "ArrowLeft") onChange(clamp(value - step));
    else if (e.key === "ArrowRight") onChange(clamp(value + step));
    else if (e.key === "Home") onChange(SNAPS[0]);
    else if (e.key === "End") onChange(SNAPS[2]);
    else if (e.key === "Enter") onReset();
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize the page and the canvas"
      aria-valuemin={25}
      aria-valuemax={75}
      aria-valuenow={Math.round(value * 100)}
      className="sl-divider"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={(e) => !(e.target as HTMLElement).closest(".ek-bar") && onReset()}
      onKeyDown={onKeyDown}
    >
      <span className="sl-grip" aria-hidden />
      <div className="sl-tools is-seam">
        <CanvasBar vertical />
      </div>
    </div>
  );
}

function Tray({ side, icon, label, meta, open, onToggle, children }: { side: "left" | "right"; icon: ReactNode; label: string; meta?: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className={`sl-tray is-${side}`} data-open={open} aria-label={label}>
      <button type="button" className="sl-tray-head" aria-expanded={open} onClick={onToggle}>
        {icon}
        <span>{label}</span>
        {meta && <span className="ek-meta">{meta}</span>}
        <ChevronDown width={12} height={12} className="sl-tray-caret" />
      </button>
      <div className="sl-tray-fold" inert={!open}>
        <div className="sl-tray-body">{children}</div>
      </div>
    </section>
  );
}

function Shell() {
  const { ui, act } = useUi();
  const { scene } = useScene();
  const shell = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  const [design, setDesign] = useState(true);
  const drawing = ui.mode === "diagram";
  // `ui.right` starts true and the drawer should start down, so it reads the
  // flag upside down: every ⌘J still flips it.
  const asking = !ui.right;
  const picked = scene.sel.filter((id) => scene.shapes.some((s) => s.id === id)).length;

  const reset = () => {
    shell.current?.style.removeProperty("--split");
    setRatio(null);
  };

  return (
    <div className="sl-frame" data-asking={asking}>
      <header className="sl-head">
        <div className="sl-head-side">
          <Account />
          <BackLink />
          <span className="sl-head-rule" aria-hidden />
          <PagesButton />
        </div>
        <ProjectTitle className="sl-title" />
        <div className="sl-head-side is-end">
          <FindButton compact />
          <Facepile />
          <ShareButton filled />
        </div>
      </header>

      <div ref={shell} className="sl-shell" data-dragged={ratio !== null || undefined} style={ratio !== null ? ({ "--split": ratio } as CSSProperties) : undefined}>
        {/* The kit leaves the canvas on a press inside the page's text; here the
            whole pane is the page, margins included. */}
        <section className="sl-pane is-write" aria-label="Page" onPointerDown={() => drawing && act.set({ mode: "page", expanded: false })}>
          <div className="sl-scroll">
            <Doc hideDiagram />
          </div>
        </section>

        <Divider value={ratio ?? (drawing ? 0.4 : 0.58)} onChange={setRatio} onReset={reset} />

        <section className="sl-pane is-canvas" aria-label="Canvas">
          <div className="sl-canvas-label" aria-hidden>
            <span>Current shape</span>
            <span>{scene.shapes.length} layers</span>
          </div>
          <Diagram />
          <div className="sl-trays" inert={!drawing}>
            <Tray side="left" icon={<LayersIcon width={14} height={14} />} label="Layers" meta={String(scene.shapes.length)} open={ui.left} onToggle={() => act.set({ left: !ui.left })}>
              <Layers />
            </Tray>
            <Tray side="right" icon={<Sliders width={14} height={14} />} label="Design" meta={picked > 1 ? `${picked} selected` : undefined} open={design} onToggle={() => setDesign((d) => !d)}>
              <Inspector />
            </Tray>
          </div>
          <div className="sl-tools is-floor" inert={!drawing}>
            <CanvasBar />
          </div>
        </section>
      </div>

      <button type="button" className="sl-ask" aria-expanded={asking} data-review={ui.review === "open" || ui.streaming !== null || undefined} onClick={() => act.set({ right: !ui.right })}>
        <ChatIcon width={14} height={14} />
        <span>Ask</span>
        <i className="sl-ask-dot" aria-hidden />
        <kbd>⌘J</kbd>
      </button>

      <aside
        className="sl-drawer"
        aria-label="Assistant"
        data-on={asking}
        inert={!asking}
        onKeyDown={(e) => {
          if (e.key === "Escape") act.set({ right: true });
        }}
      >
        <span className="sl-drawer-lip" aria-hidden />
        <Chat
          end={
            <IconBtn tip="Close assistant" keys="⌘J" onClick={() => act.set({ right: true })}>
              <X width={16} height={16} />
            </IconBtn>
          }
        />
      </aside>
    </div>
  );
}

export default function Split() {
  return (
    <Kit className="sl" stage>
      <Shell />
      <Chrome />
    </Kit>
  );
}
