"use client";

import { useRef, useState } from "react";
import { Kit, useUi } from "../_kit/store";
import { Sparkle } from "../_kit/icons";
import { Pages } from "../_kit/Shell";
import { Doc } from "../_kit/Doc";
import { CanvasBar, Inspector, Layers } from "../_kit/Canvas";
import { Chrome } from "../_kit/Extras";
import { InlineAsk, StatusLine } from "./parts";
import "./style.css";

/*
  THESIS: the assistant is not a place you go. It answers inside the page, where
  you asked, and then folds to a line of record. What this refuses is the
  category's standing arrangement: a document with a chat room bolted to its side.
  OWN-WORLD: paper edge to edge; the whole chrome is one 32px line in the mono
  meta voice (tracked, uppercase, graphite) with hairline underlines that draw
  on hover. Ink for the one filled control. Amber appears only while the
  assistant is working: the dot, the stream head, a 1px rule beside the answer.
  STORY: you read where you are and what state it is in from one line; you ask
  at the line you are on; the answer and its changes are reviewed in place.
  FIRST VIEWPORT: status line (← PROJECTS / RATE LIMITING / page · 6 PAGES ·
  2 HERE · SAVED · HISTORY · ⌘K · SHARE · account), then the page, centred, with
  the ask open in the flow just above the diagram. Pages peek from the left edge.
  Entering the diagram hands the line's right half to LAYERS · DESIGN · ESC, drops
  two panels from under it, and raises the toolbar.
  FORM: structure 10 of 10 — the furthest the shell recedes.
*/

function World() {
  const { ui, act } = useUi();
  const [askAfter, setAskAfter] = useState("b5");
  const saved = useRef<HTMLSpanElement>(null);
  const gutter = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const diagram = ui.mode === "diagram";

  const hideGutter = () => {
    if (gutter.current) gutter.current.dataset.on = "false";
  };

  return (
    <div className="n-world">
      <StatusLine saved={saved} />

      <main
        className="n-page"
        onInput={() => {
          // Written to the element, not to state: typing must not re-render the shell.
          const el = saved.current;
          if (!el) return;
          el.dataset.saving = "true";
          clearTimeout(timer.current);
          timer.current = setTimeout(() => (el.dataset.saving = "false"), 900);
        }}
        onScroll={hideGutter}
        onPointerLeave={hideGutter}
        onPointerOver={(e) => {
          const btn = gutter.current;
          const target = e.target as HTMLElement;
          if (!btn || diagram || target.closest(".n-ask")) return;
          const block = target.closest<HTMLElement>(".ek-block");
          if (!block?.dataset.block || block.dataset.block === "blank") return;
          const r = block.getBoundingClientRect();
          btn.style.setProperty("--x", `${r.right + 10}px`);
          btn.style.setProperty("--y", `${r.top + 1}px`);
          btn.dataset.block = block.dataset.block;
          btn.dataset.on = "true";
        }}
      >
        <Doc slot={{ after: askAfter, node: <InlineAsk /> }} />
        <button
          ref={gutter}
          type="button"
          className="n-gutter"
          data-on="false"
          data-tip="Ask about this, here"
          data-keys="⌘J"
          onClick={(e) => {
            const id = e.currentTarget.dataset.block;
            if (id) setAskAfter(id);
            act.set({ right: true });
            hideGutter();
          }}
        >
          <Sparkle width={12} height={12} />
          Ask
        </button>
      </main>

      {/* Hover the window's left edge and the pages lean out over the paper. */}
      <aside className="n-edge" aria-label="Pages" data-off={diagram || undefined} inert={diagram}>
        <span className="n-edge-tick" aria-hidden />
        <div className="n-peek">
          <Pages />
        </div>
      </aside>

      <aside className="n-drop is-left" aria-label="Layers" data-on={diagram && ui.left} inert={!(diagram && ui.left)}>
        <Layers />
      </aside>
      <aside className="n-drop is-right" aria-label="Design" data-on={diagram && ui.right} inert={!(diagram && ui.right)}>
        <Inspector />
      </aside>
      <div className="n-dock" data-on={diagram} inert={!diagram}>
        <CanvasBar />
      </div>
    </div>
  );
}

export default function Inline() {
  return (
    <Kit className="n">
      <World />
      <Chrome />
    </Kit>
  );
}
