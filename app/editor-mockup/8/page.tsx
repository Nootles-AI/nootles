"use client";

import { useLayoutEffect } from "react";
import { Kit, useUi } from "../_kit/store";
import { Doc } from "../_kit/Doc";
import { CanvasBar } from "../_kit/Canvas";
import { Chrome } from "../_kit/Extras";
import { Ask, Halo, Head, Wheel } from "./parts";
import "./style.css";

/*
  THESIS: no panels. Controls come to the thing you are touching and leave when
  you let go — refusing the inspector-rail arrangement every canvas tool ships.
  OWN-WORLD: graphite on paper; small elevated pills with one control height
  that spring out of a selection's edges; ink for the one filled control and
  the active tool; --nt-select only on the frame the halo hugs.
  STORY: select a shape and its colour, corner, type and size are at its edges;
  hold Space and the tools are under the pointer; let go and the page is paper.
  FIRST VIEWPORT: full-bleed paper, the document centred, a slim header that
  leaves after 2.5s of stillness, an ink Ask orb bottom-right. In the diagram:
  style strip above the frame, W × H below, arrange strip right, connect left,
  a depth rail of layer ticks on the block's left edge, the tool wheel at the
  pointer, and a quiet toolbar kept bottom-centre as the discoverable fallback.
  FORM: structure 8 of 10 — contextual chrome; ⌘\ pins layers, ⌘J asks.
*/

function World() {
  const { ui, act } = useUi();
  const diagram = ui.mode === "diagram";
  // Both flags start true in the kit and here mean "put away": layers unpinned,
  // the assistant an orb. Before paint, so neither is ever seen open first.
  useLayoutEffect(() => {
    act.set({ left: false, right: false });
  }, [act]);

  return (
    <div className="h-world">
      <Head />
      <div className="h-page">
        <Doc />
      </div>
      <p className="h-hint" data-on={diagram} aria-hidden={!diagram}>
        <kbd className="ek-kbd">Space</kbd> tools at the pointer
        <kbd className="ek-kbd">⌘\</kbd> pin layers
      </p>
      <div className="h-dock" data-on={diagram} inert={!diagram}>
        <CanvasBar />
      </div>
      <Halo />
      <Wheel />
      <Ask />
    </div>
  );
}

export default function HaloDirection() {
  return (
    <Kit className="h">
      <World />
      <Chrome />
    </Kit>
  );
}
