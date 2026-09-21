"use client";

import type { ReactNode } from "react";
import { project } from "../_kit/data";
import { Kit, useUi } from "../_kit/store";
import { Chat as ChatIcon, ChevronDown, FileDoc, Layers as LayersIcon, Sliders } from "../_kit/icons";
import { Account, BackLink, ContextRow, Facepile, FindButton, Pages, ProjectTitle, ShareButton } from "../_kit/Shell";
import { Doc } from "../_kit/Doc";
import { CanvasBar, Inspector, Layers } from "../_kit/Canvas";
import { Chat } from "../_kit/Chat";
import { Chrome } from "../_kit/Extras";
import "./style.css";

/*
  THESIS: nothing is docked. The page is one sheet lying on a ground, and every
  panel is an island hovering over that ground — refusing the three-column
  frame that spends a third of the window on chrome whether or not it is in use.
  OWN-WORLD: a dotted ground, one paper sheet, elevated islands with 14px
  corners that fold to pills, and a single ink island for the canvas's tools.
  STORY: the page is the place; panels are things you keep near it or put away,
  and putting one away gives the sheet its room back.
  FIRST VIEWPORT: sheet (max 820px) centred between a 248px Pages island
  top-left and a 328px Assistant island full-height right; a pill-shaped
  island top-centre holds the crumb, who is here, the account and an ink Share.
  Entering the diagram turns Pages into Layers and Assistant into Design in
  place, and the ink toolbar rises bottom-centre.
  FORM: structure 2 of 5 — islands. Signature: an island and its pill are one
  surface; folding animates its rectangle, never swaps it for another element.
*/

/**
 * An island and its pill are the same element. The body is always laid out at
 * full width and the surface closes over it, so nothing inside reflows on the
 * way — the New project button's morph, given to a panel.
 */
function Island({
  side,
  open,
  onToggle,
  icon,
  label,
  keys,
  alert,
  children,
}: {
  side: "left" | "right";
  open: boolean;
  onToggle: () => void;
  icon: ReactNode;
  label: string;
  keys: string;
  alert?: boolean;
  children: ReactNode;
}) {
  return (
    <aside className={`i-island is-${side}`} data-open={open} aria-label={label}>
      <button type="button" className="i-pill" aria-expanded={open} data-tip={open ? `Fold ${label.toLowerCase()}` : `Open ${label.toLowerCase()}`} data-keys={keys} data-tip-side="bottom" onClick={onToggle}>
        <span className="i-pill-icon">{icon}</span>
        <span className="i-pill-label" key={label}>
          {label}
        </span>
        {alert && <i className="i-dot" aria-label="The assistant has something for you" />}
        <ChevronDown width={14} height={14} className="i-pill-twist" />
      </button>
      <div className="i-body" inert={!open}>
        {children}
      </div>
    </aside>
  );
}

function World() {
  const { ui, act } = useUi();
  const diagram = ui.mode === "diagram";
  const page = ui.pages.find((p) => p.id === ui.pageId);

  return (
    <div className="i-world" data-left={ui.left} data-right={ui.right}>
      <div className="i-ground">
        <div className="i-sheet">
          <Doc />
        </div>
      </div>

      <header className="i-top">
        <button type="button" className="i-crumb" data-tip="Find or do" data-keys="⌘K" data-tip-side="bottom" onClick={() => act.set({ palette: true })}>
          <span className="i-crumb-project">{project.title}</span>
          <span className="i-crumb-slash" aria-hidden>
            /
          </span>
          <span className="i-crumb-page" key={ui.pageId}>
            {page?.title || "Untitled"}
          </span>
        </button>
        <Facepile />
        <Account align="end" />
        <ShareButton filled />
      </header>

      <Island
        side="left"
        open={ui.left}
        onToggle={() => act.set({ left: !ui.left })}
        icon={diagram ? <LayersIcon width={14} height={14} /> : <FileDoc width={14} height={14} />}
        label={diagram ? "Layers" : "Pages"}
        keys="⌘\"
      >
        <div className="i-face is-left" data-on={!diagram} inert={diagram}>
          <div className="i-scroll">
            <BackLink />
            <ProjectTitle />
            <FindButton />
            <ContextRow />
            <Pages />
          </div>
        </div>
        <div className="i-face is-left" data-on={diagram} inert={!diagram}>
          <div className="i-scroll">
            <Layers />
          </div>
        </div>
      </Island>

      <Island
        side="right"
        open={ui.right}
        onToggle={() => act.set({ right: !ui.right })}
        icon={diagram ? <Sliders width={14} height={14} /> : <ChatIcon width={14} height={14} />}
        label={diagram ? "Design" : "Assistant"}
        keys="⌘J"
        alert={!diagram && (ui.streaming !== null || ui.review === "open")}
      >
        {/* Hidden, never unmounted: a reply that is streaming keeps streaming. */}
        <div className="i-face is-right" data-on={!diagram} inert={diagram}>
          <Chat />
        </div>
        <div className="i-face is-right" data-on={diagram} inert={!diagram}>
          <div className="i-scroll">
            <Inspector />
          </div>
        </div>
      </Island>

      <div className="i-dock" data-on={diagram} inert={!diagram}>
        <CanvasBar />
      </div>
    </div>
  );
}

export default function Islands() {
  return (
    <Kit className="i">
      <World />
      <Chrome />
    </Kit>
  );
}
