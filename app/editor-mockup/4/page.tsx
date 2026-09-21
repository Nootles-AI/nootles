"use client";

import { useState } from "react";
import { Kit, useUi } from "../_kit/store";
import { IconBtn, Segmented } from "../_kit/controls";
import { PanelRight } from "../_kit/icons";
import { Account, BackLink, ContextRow, Facepile, FindButton, ProjectTitle, ShareButton } from "../_kit/Shell";
import { Doc } from "../_kit/Doc";
import { CanvasBar, Inspector, Layers } from "../_kit/Canvas";
import { Chat } from "../_kit/Chat";
import { Chrome } from "../_kit/Extras";
import { PageTabs } from "./parts";
import "./style.css";

/*
  THESIS: the rails dissolve into the paper. The workspace wears the projects
  page's header, pages are index tabs on the sheet's top edge, and everything
  that used to be a side panel is written in the sheet's own right margin.
  Refuses the three-column IDE shell.
  OWN-WORLD: graphite on paper in a well; the open tab is the sheet continued
  upward; one hairline between text and margin; wells with travelling thumbs;
  ink for the one filled control; arrivals on the damped spring.
  STORY: one object on the desk — a sheet with tabs and a margin. You write on
  the left, and whoever answers (the assistant, the inspector) answers beside it.
  FIRST VIEWPORT: 56px header — account, Projects, find · "Rate limiting"
  centred · faces, ink Share. Below, the tab strip with the open tab fused to a
  14px-cornered sheet: the page at --measure on the left, a 340px margin on the
  right holding the assistant. Entering the diagram raises an Assistant / Design
  / Layers well at the head of the margin, turns it to Design, and the toolbar
  springs in, upright, from the sheet's left edge.
  FORM: structure 4 of 5 — seed 4170806b.
  FINISH: unreviewed and undocumented is unfinished; this build ends with the
  finish review, the verdict, DESIGN.md, and every shipping raster carrying its
  provenance.
*/

const TABS = ["chat", "design", "layers"] as const;

function Margin() {
  const { ui, act } = useUi();
  const diagram = ui.mode === "diagram";
  // Entering a diagram turns the margin to Design, unless Assistant was asked
  // for by name since; leaving it forgets that, so the next entry starts fresh.
  const [pinned, setPinned] = useState(false);
  if (!diagram && pinned) setPinned(false);
  const tab = diagram ? (ui.rightTab === "chat" && !pinned ? "design" : ui.rightTab) : "chat";
  const at = TABS.indexOf(tab);
  const side = (i: number) => (i === at ? "on" : i < at ? "before" : "after");

  return (
    <aside className="m-margin" aria-label="Margin" inert={!ui.right}>
      <div className="m-margin-body">
        <div className="m-margin-pick" data-on={diagram} inert={!diagram}>
          <div>
            <Segmented
              label="Margin"
              value={tab}
              onChange={(rightTab) => {
                act.set({ rightTab });
                setPinned(rightTab === "chat");
              }}
              options={[
                { value: "chat", label: "Assistant" },
                { value: "design", label: "Design" },
                { value: "layers", label: "Layers" },
              ]}
            />
          </div>
        </div>
        <div className="m-faces">
          <div className="m-face" data-side={side(0)} inert={at !== 0}>
            <Chat
              end={
                <IconBtn tip="Close margin" keys="⌘J" side="bottom" onClick={() => act.set({ right: false })}>
                  <PanelRight width={16} height={16} />
                </IconBtn>
              }
            />
          </div>
          <div className="m-face" data-side={side(1)} inert={at !== 1}>
            <div className="m-scroll">
              <Inspector />
            </div>
          </div>
          <div className="m-face" data-side={side(2)} inert={at !== 2}>
            <div className="m-scroll">
              <Layers />
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function Shell() {
  const { ui, act } = useUi();
  const diagram = ui.mode === "diagram";
  return (
    <div className="m-shell">
      <header className="m-head">
        <div className="m-head-tools">
          <Account align="start" />
          <BackLink />
          <FindButton />
        </div>
        <ProjectTitle className="m-title" />
        <div className="m-head-end">
          <Facepile />
          <ShareButton filled />
        </div>
      </header>

      <div className="m-desk">
        <div className="m-strip">
          <PageTabs />
          <ContextRow />
        </div>

        <div className="m-sheet" data-right={ui.right}>
          <main className="m-main">
            <div className="m-page">
              <Doc />
            </div>
            <div className="m-dock" data-on={diagram} inert={!diagram}>
              <CanvasBar vertical />
            </div>
            <div className="m-corner" data-on={!ui.right}>
              <IconBtn tip="Open margin" keys="⌘J" side="bottom" onClick={() => act.set({ right: true })}>
                <PanelRight width={16} height={16} />
              </IconBtn>
            </div>
          </main>
          <button type="button" className="m-scrim" aria-label="Close margin" tabIndex={-1} onClick={() => act.set({ right: false })} />
          <Margin />
        </div>
      </div>
    </div>
  );
}

export default function MarginMockup() {
  return (
    <Kit className="m">
      <Shell />
      <Chrome />
    </Kit>
  );
}
