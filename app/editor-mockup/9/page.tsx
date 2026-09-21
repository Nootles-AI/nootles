"use client";

import { useEffect, useRef, useState } from "react";
import { Kit, useUi } from "../_kit/store";
import { IconBtn } from "../_kit/controls";
import { X } from "../_kit/icons";
import { Account, BackLink, Facepile, FindButton, ProjectTitle, ShareButton } from "../_kit/Shell";
import { Doc } from "../_kit/Doc";
import { CanvasBar, Inspector, Layers } from "../_kit/Canvas";
import { Chat } from "../_kit/Chat";
import { Chrome } from "../_kit/Extras";
import { Fan, Peek, type Dir } from "./parts";
import "./style.css";

/*
  THESIS: the projects page says its cards are pages lying in a well; this takes
  it literally. The project is a small stack of sheets on a desk and you can see
  that it is — it refuses the pages list, because the pages are right there.
  OWN-WORLD: paper on a sunken desk, nothing else: no wood, no texture. The open
  sheet flat and square; its neighbours real sheets behind it, a degree off true,
  their titles running up the edge that shows. Tools are paper pads with an ink
  binding; the one filled thing on the desk is ink.
  STORY: you see how much project there is and where you are in it, turn a page
  by taking the one that is sticking out, and fan the stack when you want them all.
  FIRST VIEWPORT: desk · top-left the stack object (back, project, "6 pages") ·
  centre the open sheet, 860px, with the previous sheet's edge at its left and the
  next one's at its right · right a 300px notepad holding the assistant, resting
  0.6° off square · top-right find, faces, account, ink Share. Entering the
  diagram clears the desk: neighbours slide under, the notepad turns over into
  Design, a Layers pad comes in from the left, an ink tray of tools rises.
  FORM: structure 9 of 10 — the stack made visible; turning a page is a gesture.
*/

function Desk() {
  const { ui, act } = useUi();
  const diagram = ui.mode === "diagram";
  const [dir, setDir] = useState<Dir>("next");
  const [turns, setTurns] = useState(0);
  const [bump, setBump] = useState<{ side: Dir; n: number } | null>(null);
  const [fan, setFan] = useState(false);
  // The pad turns over whenever the mode does, and only then: counted as the
  // mode is seen to change, so nothing flips on the way in.
  const [flip, setFlip] = useState({ mode: ui.mode, n: 0 });
  if (flip.mode !== ui.mode) setFlip({ mode: ui.mode, n: flip.n + 1 });

  const order = ui.pages;
  const at = order.findIndex((p) => p.id === ui.pageId);
  const prev = at > 0 ? order[at - 1] : undefined;
  const next = at >= 0 ? order[at + 1] : undefined;

  const turnTo = (id: string) => {
    const to = order.findIndex((p) => p.id === id);
    if (to < 0 || to === at) return;
    setDir(to > at ? "next" : "prev");
    setTurns((t) => t + 1);
    setBump(null);
    act.openPage(id);
  };
  const step = (side: Dir) => {
    if (diagram) return;
    const to = order[at + (side === "next" ? 1 : -1)];
    if (to) turnTo(to.id);
    // Nothing further that way: the sheet leans into it and comes back.
    else setBump((b) => ({ side, n: (b?.n ?? 0) + 1 }));
  };

  const stepRef = useRef(step);
  useEffect(() => {
    stepRef.current = step;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      // In text, ⌥← and ⌥→ are the caret's, a word at a time.
      if ((e.target as HTMLElement).closest("input, textarea, [contenteditable], [role='dialog']")) return;
      e.preventDefault();
      stepRef.current(e.key === "ArrowRight" ? "next" : "prev");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="d-desk" data-left={ui.left} data-right={ui.right}>
      <header className="d-top">
        <BackLink />
        <ProjectTitle />
        <button type="button" className="d-index" aria-haspopup="dialog" aria-expanded={fan} data-tip="Fan out every page" data-tip-side="bottom" onClick={() => setFan((f) => !f)}>
          <span className="d-index-glyph" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <span>
            {order.length} {order.length === 1 ? "page" : "pages"}
          </span>
          <span className="ek-meta">
            {at + 1}/{order.length}
          </span>
        </button>
        <span className="d-grow" />
        <FindButton compact />
        <Facepile />
        <Account align="end" />
        <ShareButton filled />
      </header>

      <div className="d-stage">
        <div className="d-stack">
          <div className="d-behind" inert={diagram}>
            {prev && <Peek key={prev.id} page={prev} seed={at - 1} side="prev" far={Math.min(3, at - 1)} onTurn={() => turnTo(prev.id)} />}
            {next && <Peek key={next.id} page={next} seed={at + 1} side="next" far={Math.min(3, order.length - at - 2)} onTurn={() => turnTo(next.id)} />}
          </div>
          {turns > 0 && <i key={turns} className="d-ghost" data-dir={dir} aria-hidden />}
          {/* Keyed on the page so the incoming sheet is a new sheet, arriving from
              the side it was peeking out of. It rests with no transform at all:
              a transformed ancestor would capture the expanded diagram. */}
          <div key={ui.pageId} className="d-sheet" data-dir={turns ? dir : "first"} data-bump={bump ? `${bump.side}-${bump.n % 2}` : undefined}>
            <div className="d-page">
              <Doc />
            </div>
          </div>
        </div>

        <div className="d-pad-slot" data-on={ui.right}>
          <aside className="d-pad" aria-label={diagram ? "Design" : "Assistant"} data-flip={flip.n ? (flip.n % 2 ? "a" : "b") : undefined} inert={!ui.right}>
            <div className="d-face" data-on={!diagram} inert={diagram}>
              <Chat
                end={
                  <IconBtn tip="Put the notepad away" keys="⌘J" side="bottom" onClick={() => act.set({ right: false })}>
                    <X width={16} height={16} />
                  </IconBtn>
                }
              />
            </div>
            <div className="d-face is-design" data-on={diagram} inert={!diagram}>
              <IconBtn tip="Put the design pad away" keys="⌘J" side="bottom" className="is-sm d-pad-close" onClick={() => act.set({ right: false })}>
                <X width={14} height={14} />
              </IconBtn>
              <div className="d-scroll">
                <Inspector />
              </div>
            </div>
          </aside>
        </div>
      </div>

      <aside className="d-pad d-layers" aria-label="Layers" data-on={diagram && ui.left} inert={!(diagram && ui.left)}>
        <IconBtn tip="Put the layers away" keys="⌘\" side="bottom" className="is-sm d-pad-close" onClick={() => act.set({ left: false })}>
          <X width={14} height={14} />
        </IconBtn>
        <div className="d-scroll">
          <Layers />
        </div>
      </aside>

      <button type="button" className="d-tab is-left" data-on={diagram && !ui.left} inert={!(diagram && !ui.left)} onClick={() => act.set({ left: true })}>
        Layers
      </button>
      <button type="button" className="d-tab is-right" data-on={!ui.right} inert={ui.right} data-tip={diagram ? "Bring back the design pad" : "Bring back the notepad"} data-keys="⌘J" onClick={() => act.set({ right: true })}>
        {diagram ? "Design" : "Ask"}
      </button>

      <div className="d-tray" data-on={diagram} inert={!diagram}>
        <CanvasBar />
      </div>

      <Fan
        open={fan && !diagram}
        onClose={() => setFan(false)}
        onTurn={turnTo}
        onAdd={() => {
          setDir("next");
          setTurns((t) => t + 1);
          act.addPage();
        }}
      />
    </div>
  );
}

export default function DeskMockup() {
  return (
    <Kit className="d">
      <Desk />
      <Chrome />
    </Kit>
  );
}
