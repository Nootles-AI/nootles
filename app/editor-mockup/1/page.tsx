"use client";

import { Kit, useUi } from "../_kit/store";
import { IconBtn } from "../_kit/controls";
import { PanelLeft, PanelRight } from "../_kit/icons";
import { Account, BackLink, ContextRow, Facepile, FindButton, Pages, ProjectTitle, ShareButton } from "../_kit/Shell";
import { Doc } from "../_kit/Doc";
import { CanvasBar, Inspector, Layers } from "../_kit/Canvas";
import { Chat } from "../_kit/Chat";
import { Chrome } from "../_kit/Extras";
import "./style.css";

/*
  THESIS: the incumbent three-column shell, kept, and finished in the projects
  page's materials — the page is a sheet lying in a well, the rails are the well.
  OWN-WORLD: graphite on paper, one control height, ink for the one filled
  control, wells with travelling thumbs, surfaces that arrive on the damped spring.
  STORY: nothing to relearn; everything simply answers the hand now.
  FIRST VIEWPORT: 256px pages rail · the sheet, inset 8px with a 14px corner ·
  320px assistant rail. Entering the diagram hands both rails over: pages become
  layers, assistant becomes design, each sliding in from its own outer edge,
  and the toolbar rises under the sheet.
  FORM: structure 1 of 5 — the baseline the other four are measured against.
*/

function Shell() {
  const { ui, act } = useUi();
  const diagram = ui.mode === "diagram";
  return (
    <div className="q-shell" data-left={ui.left} data-right={ui.right}>
      <aside className="q-rail is-left" aria-label={diagram ? "Layers" : "Sidebar"} inert={!ui.left}>
        <div className="q-rail-body">
          <div className="q-face" data-on={!diagram} inert={diagram}>
            <header className="ek-panel-head">
              <BackLink />
              <span className="q-grow" />
              <ShareButton />
              <Account />
              <IconBtn tip="Collapse sidebar" keys="⌘\" side="bottom" onClick={() => act.set({ left: false })}>
                <PanelLeft width={16} height={16} />
              </IconBtn>
            </header>
            <div className="q-scroll">
              <ProjectTitle />
              <FindButton />
              <ContextRow />
              <Pages />
            </div>
          </div>
          <div className="q-face" data-on={diagram} inert={!diagram}>
            <div className="q-scroll">
              <Layers />
            </div>
          </div>
        </div>
      </aside>

      <main className="q-col">
        <div className="q-sheet">
          <div className="q-corner is-left" data-on={!ui.left}>
            <IconBtn tip="Open sidebar" keys="⌘\" side="bottom" onClick={() => act.set({ left: true })}>
              <PanelLeft width={16} height={16} />
            </IconBtn>
          </div>
          <div className="q-corner is-right">
            <Facepile />
            {!ui.right && (
              <IconBtn tip="Open assistant" keys="⌘J" side="bottom" onClick={() => act.set({ right: true })}>
                <PanelRight width={16} height={16} />
              </IconBtn>
            )}
          </div>
          <div className="q-page">
            <Doc />
          </div>
        </div>
        <div className="q-dock" data-on={diagram} inert={!diagram}>
          <CanvasBar />
        </div>
      </main>

      <aside className="q-rail is-right" aria-label={diagram ? "Design" : "Assistant"} inert={!ui.right}>
        <div className="q-rail-body">
          <div className="q-face" data-on={!diagram} inert={diagram}>
            <Chat
              end={
                <IconBtn tip="Collapse assistant" keys="⌘J" side="bottom" onClick={() => act.set({ right: false })}>
                  <PanelRight width={16} height={16} />
                </IconBtn>
              }
            />
          </div>
          <div className="q-face" data-on={diagram} inert={!diagram}>
            <div className="q-scroll">
              <Inspector />
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

export default function QuietRails() {
  return (
    <Kit className="q">
      <Shell />
      <Chrome />
    </Kit>
  );
}
