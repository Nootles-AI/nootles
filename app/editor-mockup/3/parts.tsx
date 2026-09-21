"use client";

import { useEffect, useRef, useState } from "react";
import { useScene, useUi } from "../_kit/store";
import { IconBtn } from "../_kit/controls";
import { ArrowLeft, ArrowUp, ChevronDown, FileDoc, Layers as LayersIcon, Search, Sliders } from "../_kit/icons";
import { Account, BackLink, ContextRow, Pages, ProjectTitle, ShareButton } from "../_kit/Shell";
import { CanvasBar, Inspector, Layers } from "../_kit/Canvas";

type Panel = { kind: "none" } | { kind: "ask" } | { kind: "pages"; page: string };

/** The conversation, drawn on ink. Same script as everywhere: no model is called. */
function Transcript({ open }: { open: boolean }) {
  const { ui } = useUi();
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: open ? "smooth" : "auto" });
  }, [ui.msgs.length, ui.streaming, open]);

  return (
    <div ref={log} className="b-log">
      {ui.msgs.length === 0 && ui.streaming === null && (
        <div className="b-log-empty">
          <b>Ask about this project</b>
          <span>Questions are answered from what the pages actually say.</span>
        </div>
      )}
      {ui.msgs.map((m) =>
        m.from === "you" ? (
          <p key={m.id} className="b-turn is-you">
            {m.text}
          </p>
        ) : (
          <div key={m.id} className="b-turn is-ai">
            {m.steps?.map((s) => (
              <span key={s} className="b-step">
                {s}
              </span>
            ))}
            <p>{m.text}</p>
          </div>
        ),
      )}
      {ui.streaming !== null && (
        <div className="b-turn is-ai">
          {ui.streaming === "" ? (
            <span className="b-step">
              <i className="ek-dot" />
              Reading Rate limiting…
            </span>
          ) : (
            <p>
              {ui.streaming}
              <i className="ek-stream-head" />
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The whole chrome. One ink surface whose size is set per state and travels on
 * the spring; every face of it is always laid out, and only shown or clipped.
 */
export function Dock() {
  const { ui, act } = useUi();
  const scene = useScene();
  const [panel, setPanel] = useState<Panel>({ kind: "none" });
  const [draft, setDraft] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const ask = useRef<HTMLInputElement>(null);

  const canvas = ui.mode === "diagram";
  // Picking a page is what closes the pages panel, so it is open only for the
  // page it was opened on — unless a new page is still being named inside it.
  const pagesOpen = panel.kind === "pages" && (panel.page === ui.pageId || ui.renaming !== null);
  const state = canvas ? "canvas" : pagesOpen ? "pages" : panel.kind === "ask" ? "ask" : "rest";
  const busy = ui.streaming !== null;
  const page = ui.pages.find((p) => p.id === ui.pageId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest("input, textarea, [contenteditable]");
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        setPanel((p) => (p.kind === "none" ? p : { kind: "none" }));
        if (root.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
        return;
      }
      if (root.current?.closest(".ek")?.getAttribute("data-mode") === "diagram") return;
      if ((e.key === "/" && !typing && !mod) || (mod && e.key.toLowerCase() === "j")) {
        e.preventDefault();
        ask.current?.focus();
      }
    };
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (root.current?.contains(t) || t.closest("[data-ek-pop], .ek-modal")) return;
      setPanel({ kind: "none" });
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", away, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", away, true);
    };
  }, []);

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    act.send(text);
    setDraft("");
  };

  return (
    <div ref={root} className="b-anchor" data-state={state}>
      <aside className="b-tray is-left" aria-label="Layers" data-on={canvas && ui.left} inert={!(canvas && ui.left)}>
        <Layers />
      </aside>
      <aside className="b-tray is-right" aria-label="Design" data-on={canvas && ui.right} inert={!(canvas && ui.right)}>
        <Inspector />
      </aside>

      <div className="b-dock">
        <div className="b-up">
          <section className="b-panel is-pages" aria-label="Pages" data-on={state === "pages"} inert={state !== "pages"}>
            <div className="b-project">
              <BackLink />
              <ProjectTitle />
              <ContextRow />
              <p className="b-hint">
                <kbd className="ek-kbd">⌘K</kbd> finds a page by name from anywhere.
              </p>
            </div>
            <div className="b-tree">
              <Pages />
            </div>
          </section>

          <section className="b-panel is-ask" aria-label="Assistant" data-on={state === "ask"} inert={state !== "ask"}>
            <header className="b-ask-head">
              <span>{ui.thread}</span>
              <button type="button" className="b-ghost" onClick={act.newThread}>
                New chat
              </button>
            </header>
            <Transcript open={state === "ask"} />
            {ui.review === "open" && (
              <div className="b-review" role="status">
                <span>
                  <b>2 changes</b> · 1 page
                </span>
                <button type="button" className="b-ghost" onClick={() => act.set({ review: "discarded" })}>
                  Discard
                </button>
                <button
                  type="button"
                  className="b-paper"
                  onClick={() => {
                    act.set({ review: "kept" });
                    scene.act.applyProposal();
                    act.toast("Kept 2 changes", "Undo");
                  }}
                >
                  Keep
                </button>
              </div>
            )}
          </section>
        </div>

        <div className="b-bar">
          <div className="b-face is-rest" data-on={!canvas} inert={canvas}>
            <button
              type="button"
              className="b-pages-btn"
              aria-expanded={state === "pages"}
              data-tip={state === "pages" ? undefined : "Pages"}
              onClick={() => setPanel(pagesOpen ? { kind: "none" } : { kind: "pages", page: ui.pageId })}
            >
              <FileDoc width={14} height={14} />
              <span>{page?.title || "Untitled"}</span>
              <ChevronDown width={12} height={12} className="b-chev" />
            </button>
            <label className="b-ask" data-filled={draft.trim() !== "" || undefined}>
              <input
                ref={ask}
                aria-label="Ask Nootles"
                placeholder="Ask, or describe a change…"
                value={draft}
                onFocus={() => setPanel({ kind: "ask" })}
                onChange={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              {ui.review === "open" && state === "rest" && (
                <button type="button" className="b-chip" onClick={() => ask.current?.focus()}>
                  <i className="ek-dot" />2 changes
                </button>
              )}
              {state !== "ask" && !draft && <kbd className="ek-kbd">/</kbd>}
              <button type="button" className="b-send" aria-label={busy ? "Stop" : "Send"} disabled={!busy && !draft.trim()} onClick={send}>
                {busy ? <i className="b-stop" /> : <ArrowUp width={14} height={14} />}
              </button>
            </label>
            <IconBtn tip="Find or do" keys="⌘K" onClick={() => act.set({ palette: true })}>
              <Search width={16} height={16} />
            </IconBtn>
            <ShareButton />
            <Account align="end" />
          </div>

          <div className="b-face is-canvas" data-on={canvas} inert={!canvas}>
            <button type="button" className="b-back" onClick={() => act.set({ mode: "page", expanded: false })}>
              <ArrowLeft width={14} height={14} />
              <span>Page</span>
              <kbd className="ek-kbd">esc</kbd>
            </button>
            <i className="b-sep" />
            <CanvasBar />
            <i className="b-sep" />
            <button type="button" className="b-toggle" aria-pressed={ui.left} data-tip="Layers" data-keys="⌘\" onClick={() => act.set({ left: !ui.left })}>
              <LayersIcon />
              Layers
            </button>
            <button type="button" className="b-toggle" aria-pressed={ui.right} data-tip="Design" data-keys="⌘J" onClick={() => act.set({ right: !ui.right })}>
              <Sliders />
              Design
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
