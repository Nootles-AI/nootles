"use client";

import { useLayoutEffect, useRef } from "react";
import { Diagram } from "@/app/components/Icons";
import { effectiveScale, onScaleWithin } from "@/app/lib/columnScale";

/** Off the band's edge, as the block handle is off the text's; and its box. */
const GAP = 4;
const SIZE = 24;
/** Kept off the pane's own edge, as the handle is. */
const EDGE_PAD = 2;

/** The nearest ancestor that clips — the pane's scroller, whose edge the mark may not cross. */
function clipperOf(el: Element): Element | null {
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX !== "visible" || style.overflowY !== "visible") return node;
  }
  return null;
}

/**
 * The diagram's symbol in the right margin, level with the block handle in the
 * left one: the page saying what this band is. It reads off the band's own
 * edge, so a wide band carries it out with it. With no room past that edge —
 * a narrow pane, or a wide band out to the pane's gutter — it comes in over
 * the band and takes the handle's paper, as the handle does on the other side.
 */
export function BandMark() {
  const mark = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = mark.current;
    // The band it stands off — its parent, read here since a parent's ref is
    // not yet attached when a child's layout effect runs.
    const host = el?.parentElement;
    if (!el || !host) return;
    const clipper = clipperOf(host);
    let frame = 0;
    const place = () => {
      frame = 0;
      const k = effectiveScale(host);
      const right = host.getBoundingClientRect().right;
      const edge = clipper
        ? clipper.getBoundingClientRect().left + clipper.clientLeft + clipper.clientWidth - EDGE_PAD
        : window.innerWidth - EDGE_PAD;
      const over = right + (GAP + SIZE) * k - edge;
      const nudge = over > 0 ? over / k : 0;
      const translate = nudge ? `${-nudge}px 0` : "";
      if (el.style.translate !== translate) el.style.translate = translate;
      el.toggleAttribute("data-tight", nudge > 0);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    place();
    const resize = new ResizeObserver(schedule);
    resize.observe(host);
    if (clipper) resize.observe(clipper);
    const offScale = onScaleWithin(() => host, schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      offScale();
    };
  }, []);

  return (
    <span ref={mark} className="nt-canvas-mark" aria-hidden>
      <Diagram width={14} height={14} />
    </span>
  );
}
