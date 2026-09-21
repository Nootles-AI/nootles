"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type RefObject, type SVGProps } from "react";
import { TOOLS } from "@/app/components/editor/canvas/Toolbar";
import { useScene, useUi, type Tool } from "../_kit/store";
import { IconBtn } from "../_kit/controls";
import { Group, Item, Pop, Sep } from "../_kit/overlays";
import { Brandmark, Chat as ChatIcon, Context, FileDoc, Layers as LayersIcon, Plus, Redo, Search, Sliders, Undo, X } from "../_kit/icons";
import { Account, ContextRow, Pages, ProjectTitle, ShareButton } from "../_kit/Shell";
import { Layers } from "../_kit/Canvas";
import { Chat } from "../_kit/Chat";

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

function Pin(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3zM12 14v6" />
    </svg>
  );
}

/**
 * Which drawer is out, which is pinned, and which is in front.
 *
 * The pages drawer IS `ui.left`. The assistant and the design drawer are local,
 * and each flips whenever `ui.right` changes — so ⌘J drives whichever of them
 * the mode puts on that side, without `ui.right`'s starting value (true, for
 * the mockups with a rail) pulling a drawer out over the page on load.
 */
export function useSpine() {
  const { ui, act } = useUi();
  const diagram = ui.mode === "diagram";
  const [seen, setSeen] = useState({ left: ui.left, right: ui.right });
  const [chatOpen, setChatOpen] = useState(false);
  const [designOpen, setDesignOpen] = useState(true);
  const [front, setFront] = useState<"pages" | "chat">("pages");
  const [pinned, setPinned] = useState<"pages" | "chat" | null>("pages");

  if (seen.left !== ui.left || seen.right !== ui.right) {
    setSeen({ left: ui.left, right: ui.right });
    if (seen.right !== ui.right) {
      if (diagram) setDesignOpen((o) => !o);
      else {
        setChatOpen((o) => !o);
        if (!chatOpen) setFront("chat");
      }
    }
    if (ui.left && !seen.left) setFront("pages");
  }

  const pinPages = pinned === "pages";
  const pinChat = pinned === "chat";
  const leftShown = ui.left && (diagram || front === "pages" || pinPages || !chatOpen);
  const chatShown = !diagram && chatOpen && (front === "chat" || pinChat || !ui.left);
  const floating = (leftShown && !pinPages) || (chatShown && !pinChat);

  return {
    diagram,
    leftShown,
    chatShown,
    designShown: diagram && designOpen,
    floating,
    pinPages,
    pinChat,
    front: diagram || !chatShown ? "pages" : front,
    dock: leftShown && pinPages ? "pages" : chatShown && pinChat ? "chat" : "none",
    pin: (which: "pages" | "chat") => setPinned((p) => (p === which ? null : which)),
    togglePages: () => {
      if (ui.left) return act.set({ left: false });
      if (!pinChat) setChatOpen(false);
      act.set({ left: true });
    },
    toggleRight: () => act.set({ right: !ui.right, ...(!diagram && !chatOpen && !pinPages ? { left: false } : {}) }),
    closeChat: () => setChatOpen(false),
    closeFloating: () => {
      if (ui.left && !pinPages) act.set({ left: false });
      if (chatOpen && !pinChat) setChatOpen(false);
    },
  };
}

export type SpineState = ReturnType<typeof useSpine>;

/** The ink spine. One paper marker travels it; in the diagram it carries the tools. */
export function Spine({ s }: { s: SpineState }) {
  const { ui, act } = useUi();
  const { scene, act: sa } = useScene();
  const [ctx, setCtx] = useState(false);
  const [zooming, setZooming] = useState(false);
  const ctxBtn = useRef<HTMLButtonElement>(null);
  const zoomBtn = useRef<HTMLButtonElement>(null);
  const busy = ui.streaming !== null || ui.review === "open";
  const at = s.chatShown && s.front === "chat" ? 2 : s.leftShown ? 0 : -1;
  const tool = TOOLS.findIndex((t) => t.tool === scene.tool);

  return (
    <nav className="sp-spine" aria-label="Workspace">
      <div className="sp-top">
        <Link href="/" className="sp-brand" data-on={!s.diagram} inert={s.diagram} aria-label="All projects" data-tip="All projects" data-tip-side="bottom">
          <Brandmark width={18} height={22} />
        </Link>
        <button type="button" className="sp-esc" data-on={s.diagram} inert={!s.diagram} aria-label="Back to the page" data-tip="Back to the page" data-tip-side="bottom" onClick={() => act.set({ mode: "page", expanded: false })}>
          esc
        </button>
      </div>

      <div className="sp-duty">
        <div className="sp-duty-face" data-on={!s.diagram} inert={s.diagram}>
          <div className="sp-nav ek-stagger" style={{ "--at": Math.max(0, at) } as CSSProperties}>
            <span className="sp-mark" data-none={at < 0 || undefined} aria-hidden />
            <button type="button" className="sp-btn" aria-label="Pages" aria-pressed={at === 0} data-tip="Pages" data-keys="⌘\" onClick={s.togglePages}>
              <FileDoc width={17} height={17} />
            </button>
            <button type="button" className="sp-btn" aria-label="Find or do" data-tip="Find or do" data-keys="⌘K" onClick={() => act.set({ palette: true })}>
              <Search width={17} height={17} />
            </button>
            <button type="button" className="sp-btn" aria-label="Assistant" aria-pressed={at === 2} data-tip="Assistant" data-keys="⌘J" onClick={s.toggleRight}>
              <ChatIcon width={17} height={17} />
              {busy && <i className="sp-dot" />}
            </button>
            <button ref={ctxBtn} type="button" className="sp-btn" aria-label="Context" aria-expanded={ctx} data-tip="What the assistant knows" onClick={() => setCtx((o) => !o)}>
              <Context width={17} height={17} />
            </button>
          </div>
        </div>

        <div className="sp-duty-face" data-on={s.diagram} inert={!s.diagram}>
          <button type="button" className="sp-btn is-tog" aria-label="Layers" aria-pressed={s.leftShown} data-tip="Layers" data-keys="⌘\" onClick={s.togglePages}>
            <LayersIcon width={17} height={17} />
          </button>
          <button type="button" className="sp-btn is-tog" aria-label="Design" aria-pressed={s.designShown} data-tip="Design" data-keys="⌘J" onClick={s.toggleRight}>
            <Sliders width={17} height={17} />
          </button>
          <span className="sp-sep" />
          <div className="sp-tools ek-stagger" role="toolbar" aria-label="Canvas" aria-orientation="vertical" style={{ "--at": tool } as CSSProperties}>
            <span className="sp-mark" aria-hidden />
            {TOOLS.map((t) => (
              <button
                key={t.tool}
                type="button"
                className="sp-btn"
                aria-label={TOOL_META[t.tool as Tool][0]}
                aria-pressed={scene.tool === t.tool}
                data-tip={TOOL_META[t.tool as Tool][0]}
                data-keys={TOOL_META[t.tool as Tool][1]}
                onClick={() => sa.tool(t.tool as Tool)}
              >
                {t.icon}
              </button>
            ))}
          </div>
          <span className="sp-sep" />
          <button type="button" className="sp-btn" aria-label="Undo" data-tip="Undo" data-keys="⌘Z" disabled={!scene.past.length} onClick={sa.undo}>
            <Undo />
          </button>
          <button type="button" className="sp-btn" aria-label="Redo" data-tip="Redo" data-keys="⌘⇧Z" disabled={!scene.future.length} onClick={sa.redo}>
            <Redo />
          </button>
          <button ref={zoomBtn} type="button" className="sp-zoom" aria-label="Zoom" aria-expanded={zooming} onClick={() => setZooming((o) => !o)}>
            {Math.round(scene.zoom * 100)}%
          </button>
        </div>
      </div>

      <div className="sp-foot">
        <ShareButton />
        <Account />
      </div>

      <Pop open={ctx} onClose={() => setCtx(false)} anchor={ctxBtn} side="right" gap={12} label="Context" className="ek-pop-wide">
        <Group>What the assistant knows</Group>
        <Item label="edge-gateway" hint="Repository · main" />
        <Item label="limits-service" hint="Repository · main" />
        <Sep />
        <Item icon={<FileDoc width={14} height={14} />} label="limits.csv" hint="4 files attached" />
        <Item icon={<Plus width={14} height={14} />} label="Add a repository or file…" />
      </Pop>
      <Pop open={zooming} onClose={() => setZooming(false)} anchor={zoomBtn} side="right" align="end" gap={12} label="Zoom">
        <Item label="Zoom in" keys="⌘=" keepOpen onSelect={() => sa.zoomBy(1.25)} />
        <Item label="Zoom out" keys="⌘-" keepOpen onSelect={() => sa.zoomBy(0.8)} />
        <Item label="Zoom to 100%" keys="⌘0" onSelect={() => sa.set({ zoom: 1 })} />
        <Sep />
        <Item label="Expanded stage" keys="⌘⇧F" checked={ui.expanded} onSelect={() => act.set({ expanded: !ui.expanded })} />
      </Pop>
    </nav>
  );
}

/** The cards kept behind the spine. Unpinned they lie over the page; pinned they are the well beside it. */
export function Drawers({ s }: { s: SpineState }) {
  const { act } = useUi();
  const close = useRef(s.closeFloating);
  useEffect(() => {
    close.current = s.closeFloating;
  });

  useEffect(() => {
    if (!s.floating) return;
    const away = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".sp-spine, .sp-drawer, [data-ek-pop], .ek-modal")) close.current();
    };
    // Escape belongs to the canvas while the diagram is entered.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !s.diagram && !(e.target as HTMLElement).closest("[data-ek-pop], [role='dialog']")) close.current();
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [s.floating, s.diagram]);

  const pinBtn = (which: "pages" | "chat", on: boolean) => (
    <IconBtn tip={on ? "Unpin — lie over the page" : "Pin beside the page"} side="bottom" on={on} className="is-sm" onClick={() => s.pin(which)}>
      <Pin />
    </IconBtn>
  );

  return (
    <div className="sp-drawers">
      <aside className="sp-drawer is-left" aria-label={s.diagram ? "Layers" : "Pages"} data-on={s.leftShown} data-pinned={s.pinPages} data-front={s.front === "pages"} inert={!s.leftShown}>
        <header className="sp-drawer-head">
          <div className="sp-drawer-title">{s.diagram ? <span className="sp-drawer-name">Current shape</span> : <ProjectTitle />}</div>
          {pinBtn("pages", s.pinPages)}
          <IconBtn tip="Close" keys="⌘\" side="bottom" className="is-sm" onClick={() => act.set({ left: false })}>
            <X width={14} height={14} />
          </IconBtn>
        </header>
        <div className="sp-faces">
          <div className="sp-face" data-on={!s.diagram} inert={s.diagram}>
            <ContextRow />
            <Pages />
          </div>
          <div className="sp-face" data-on={s.diagram} inert={!s.diagram}>
            <Layers />
          </div>
        </div>
      </aside>

      {/* Never unmounted: a reply that is streaming keeps streaming behind the spine. */}
      <aside className="sp-drawer is-chat" aria-label="Assistant" data-on={s.chatShown} data-pinned={s.pinChat} data-front={s.front === "chat"} inert={!s.chatShown}>
        <Chat
          end={
            <>
              {pinBtn("chat", s.pinChat)}
              <IconBtn tip="Close" keys="⌘J" side="bottom" className="is-sm" onClick={s.closeChat}>
                <X width={14} height={14} />
              </IconBtn>
            </>
          }
        />
      </aside>
    </div>
  );
}

type Geo = { k: number; items: { id: string; top: number; h: number }[]; total: number };

/**
 * The page, at a tenth. Bars are placed from the real blocks' geometry, so the
 * lens over them is honest; the diagram is drawn from the live scene, so a
 * shape dragged on the page moves here too. Scrolling writes two CSS variables
 * and never renders.
 */
export function Minimap({ scroller, away }: { scroller: RefObject<HTMLDivElement | null>; away: boolean }) {
  const { ui } = useUi();
  const { scene } = useScene();
  const track = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState<Geo>({ k: 0.1, items: [], total: 0 });

  const remeasure = useRef(() => {});

  useEffect(() => {
    const sc = scroller.current;
    const host = box.current;
    const doc = sc?.querySelector(".ek-doc");
    if (!sc || !host || !doc) return;
    const measure = () => {
      const total = sc.scrollHeight;
      const base = sc.getBoundingClientRect().top - sc.scrollTop;
      const items = [...sc.querySelectorAll<HTMLElement>(".ek-title, [data-block]")].map((n) => {
        const r = n.getBoundingClientRect();
        return { id: n.dataset.block ?? "title", top: r.top - base, h: r.height };
      });
      setGeo({ k: Math.min(0.1, (host.clientHeight - 12) / total), items, total });
    };
    remeasure.current = measure;
    const watch = new ResizeObserver(measure);
    watch.observe(sc);
    watch.observe(doc);
    return () => watch.disconnect();
  }, [scroller]);

  // A change that keeps the page's height (a tick, a kept hunk) still redraws.
  useEffect(() => {
    const id = requestAnimationFrame(() => remeasure.current());
    return () => cancelAnimationFrame(id);
  }, [ui.blocks, ui.pageId, ui.review, ui.docMode]);

  useEffect(() => {
    const sc = scroller.current;
    const el = track.current;
    if (!sc || !el) return;
    const place = () => {
      el.style.setProperty("--lens-y", `${sc.scrollTop * geo.k}px`);
      el.style.setProperty("--lens-h", `${sc.clientHeight * geo.k}px`);
    };
    place();
    sc.addEventListener("scroll", place, { passive: true });
    return () => sc.removeEventListener("scroll", place);
  }, [scroller, geo]);

  const seek = (e: RPointerEvent<HTMLDivElement>, smooth: boolean) => {
    const sc = scroller.current;
    if (!sc) return;
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    sc.scrollTo({ top: y / geo.k - sc.clientHeight / 2, behavior: smooth ? "smooth" : "auto" });
  };

  return (
    <div ref={box} className="sp-map" data-away={away || undefined} inert={away} aria-hidden>
      <div
        ref={track}
        className="sp-track"
        style={{ height: geo.total * geo.k, "--step": `${25.5 * geo.k}px` } as CSSProperties}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          seek(e, true);
        }}
        onPointerMove={(e) => e.buttons === 1 && seek(e, false)}
      >
        <span className="sp-lens" />
        {geo.items.map((it, i) => {
          const b = ui.blocks.find((x) => x.id === it.id);
          const type = it.id === "title" ? "title" : (b?.type ?? "p");
          const tip = type === "diagram" ? "Diagram · Current shape" : type === "code" ? "Code block" : type === "table" ? "Table" : b && "text" in b ? b.text.slice(0, 44) : undefined;
          return (
            <div
              key={it.id}
              className="sp-bar"
              data-type={type}
              data-done={(b?.type === "todo" && b.done) || undefined}
              data-tip={tip || undefined}
              style={{ top: it.top * geo.k, height: Math.max(2, it.h * geo.k), "--i": Math.min(i, 14) } as CSSProperties}
            >
              {type === "diagram" &&
                scene.shapes
                  .filter((sh) => !sh.hidden)
                  .map((sh) => (
                    <i
                      key={sh.id}
                      data-kind={sh.kind}
                      style={{
                        left: (14 + sh.x) * geo.k,
                        top: (14 + sh.y) * geo.k,
                        width: Math.max(2, sh.w * geo.k),
                        height: Math.max(1, (sh.kind === "text" ? 3 : sh.h) * geo.k),
                        borderRadius: Math.min(sh.r, sh.h / 2) * geo.k,
                        background: sh.kind === "text" ? undefined : sh.fill,
                      }}
                    />
                  ))}
              {b?.type === "bullet" && b.hunk && ui.review === "open" && (
                <>
                  <i className="sp-hunk is-del" />
                  <i className="sp-hunk is-add" />
                </>
              )}
              {b && "caret" in b && b.caret && <i className="sp-who" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
