"use client";

import { Kit, useUi } from "../_kit/store";
import { IconBtn } from "../_kit/controls";
import { ArrowLeft, Layers as LayersIcon, PanelLeft, PanelRight, Sliders } from "../_kit/icons";
import { Account, BackLink, Facepile, FindButton, ProjectTitle, ShareButton } from "../_kit/Shell";
import { Doc } from "../_kit/Doc";
import { CanvasBar, Inspector, Layers } from "../_kit/Canvas";
import { Chat } from "../_kit/Chat";
import { Chrome } from "../_kit/Extras";
import { Film, StageAsk } from "./parts";
import "./style.css";

/*
  THESIS: the canvas is the flagship, so it gets a stage. A diagram is not
  edited inside 600px of a document with the window's rails borrowed for it —
  it lifts out of the page and takes the window, and its tools come to it.
  OWN-WORLD: graphite on paper. Pages are sheets lying in wells, at thumbnail
  size, with one ink ring that travels; the stage is a dotted ground with
  elevated trays that arrive from their own edges on the damped spring.
  STORY: read and write in a calm two-pane with your pages in the corner of
  your eye; click the diagram and the room changes to a studio; Esc and you are
  back in the sentence you left.
  FIRST VIEWPORT: 148px filmstrip of page sheets · the sheet, inset 8px · 320px
  assistant. Entering the diagram: the block opens to the full window from
  where it sat, the page dims behind it, Layers lands left, Design lands right,
  the toolbar rises, and a pill top-left says how to leave.
  FORM: structure 5 of 5 — the only one where the canvas leaves the document.
*/

function Shell() {
  const { ui, act } = useUi();
  const staged = ui.mode === "diagram";
  return (
    <div className="s-shell" data-left={ui.left} data-right={ui.right}>
      <aside className="s-film" aria-label="Pages" inert={!ui.left || staged}>
        <div className="s-film-body">
          <header className="s-film-head">
            <BackLink />
            <IconBtn tip="Collapse pages" keys="⌘\" side="bottom" className="is-sm" onClick={() => act.set({ left: false })}>
              <PanelLeft width={14} height={14} />
            </IconBtn>
          </header>
          <ProjectTitle />
          <Film />
        </div>
      </aside>

      <main className="s-col">
        <div className="s-sheet">
          <div className="s-corner is-left">
            {!ui.left && (
              <IconBtn tip="Open pages" keys="⌘\" side="bottom" onClick={() => act.set({ left: true })}>
                <PanelLeft width={16} height={16} />
              </IconBtn>
            )}
            <FindButton />
          </div>
          <div className="s-corner is-right">
            <Facepile />
            <Account align="end" />
            <ShareButton filled />
            {!ui.right && (
              <IconBtn tip="Open assistant" keys="⌘J" side="bottom" onClick={() => act.set({ right: true })}>
                <PanelRight width={16} height={16} />
              </IconBtn>
            )}
          </div>
          <div className="s-page">
            <Doc />
          </div>
        </div>
      </main>

      <aside className="s-rail" aria-label="Assistant" inert={!ui.right || staged}>
        <div className="s-rail-body">
          <Chat
            end={
              <IconBtn tip="Collapse assistant" keys="⌘J" side="bottom" onClick={() => act.set({ right: false })}>
                <PanelRight width={16} height={16} />
              </IconBtn>
            }
          />
        </div>
      </aside>
    </div>
  );
}

/** What comes to the diagram once it has the window. Siblings of the page, never inside it. */
function Stage() {
  const { ui, act } = useUi();
  const on = ui.mode === "diagram";
  return (
    <div className="s-stage" data-on={on} inert={!on}>
      <header className="s-stage-top">
        <button type="button" className="s-exit" onClick={() => act.set({ mode: "page", expanded: false })}>
          <ArrowLeft width={14} height={14} />
          <span>Rate limiting</span>
          <kbd className="ek-kbd">Esc</kbd>
        </button>
        <span className="s-stage-name">Current shape</span>
        <StageAsk />
      </header>

      <aside className="s-tray is-left" aria-label="Layers" data-open={ui.left} inert={!ui.left}>
        <IconBtn tip="Fold layers" keys="⌘\" className="is-sm s-tray-fold" onClick={() => act.set({ left: false })}>
          <PanelLeft width={14} height={14} />
        </IconBtn>
        <div className="s-tray-scroll">
          <Layers />
        </div>
      </aside>
      <button type="button" className="s-tab is-left" data-on={!ui.left} inert={ui.left} onClick={() => act.set({ left: true })}>
        <LayersIcon width={14} height={14} />
        Layers
      </button>

      <aside className="s-tray is-right" aria-label="Design" data-open={ui.right} inert={!ui.right}>
        <IconBtn tip="Fold design" keys="⌘J" className="is-sm s-tray-fold" onClick={() => act.set({ right: false })}>
          <PanelRight width={14} height={14} />
        </IconBtn>
        <div className="s-tray-scroll">
          <Inspector />
        </div>
      </aside>
      <button type="button" className="s-tab is-right" data-on={!ui.right} inert={ui.right} onClick={() => act.set({ right: true })}>
        <Sliders width={14} height={14} />
        Design
      </button>

      <div className="s-bar">
        <CanvasBar />
      </div>
    </div>
  );
}

export default function StageDirection() {
  return (
    <Kit className="s" stage>
      <Shell />
      <Stage />
      <Chrome />
    </Kit>
  );
}
