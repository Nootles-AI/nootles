"use client";

import { useRef } from "react";
import { Kit } from "../_kit/store";
import { IconBtn } from "../_kit/controls";
import { X } from "../_kit/icons";
import { Facepile } from "../_kit/Shell";
import { Doc } from "../_kit/Doc";
import { Inspector } from "../_kit/Canvas";
import { Chrome } from "../_kit/Extras";
import { Drawers, Minimap, Spine, useSpine } from "./parts";
import "./style.css";

/*
  THESIS: the chrome is one ink spine and the page is read at two scales. Panels
  are not columns here: they are cards kept behind the spine, pulled out over the
  page when wanted and pinned beside it only by choice. It refuses the standing
  three-column shell, and a toolbar that floats over the thing it edits.
  OWN-WORLD: graphite on paper; the spine is the projects page's ink control
  stood on end, one paper marker travelling it on the damped spring; drawers are
  elevated paper with 14px outer corners, flattening into the well when pinned.
  STORY: look left for where things are kept, right for where you are in the
  page; the middle is only ever the page.
  FIRST VIEWPORT: 52px ink spine (mark, Pages, Find, Assistant, Context; Share and
  account at its foot) · pages drawer pinned at 280px · the sheet, inset 8px · a
  72px minimap of the page on the sheet's right edge, its lens on the first
  screen. Entering the diagram turns the spine into the toolbar, the pages card
  into Layers, and Design slides in from the right over the minimap.
  FORM: structure 6 of 10 — the first of the five that go a step further out.
*/

function World() {
  const s = useSpine();
  const scroller = useRef<HTMLDivElement>(null);
  return (
    <div className="sp-shell" data-dock={s.dock} data-floating={s.floating} data-design={s.designShown}>
      <Spine s={s} />
      <Drawers s={s} />
      <main className="sp-col">
        <div className="sp-sheet">
          <div className="sp-corner">
            <Facepile />
          </div>
          <div ref={scroller} className="sp-page">
            <Doc />
          </div>
          <Minimap scroller={scroller} away={s.designShown} />
          <aside className="sp-design" aria-label="Design" data-on={s.designShown} inert={!s.designShown}>
            <IconBtn tip="Close" keys="⌘J" side="bottom" className="is-sm sp-design-close" onClick={s.toggleRight}>
              <X width={14} height={14} />
            </IconBtn>
            <Inspector />
          </aside>
        </div>
      </main>
    </div>
  );
}

export default function SpineMockup() {
  return (
    <Kit className="sp">
      <World />
      <Chrome />
    </Kit>
  );
}
