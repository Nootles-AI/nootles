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
 * The diagram's symbol at the foot of the left margin, under the block handle
 * at its head: the page saying what this band is. A narrow pane's gutter may
 * not hold it, and then it comes in over the band on the handle's paper, as
 * the handle does. A wide band keeps it inside its own corner (canvas.css).
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
      const left = host.getBoundingClientRect().left;
      const edge = clipper ? clipper.getBoundingClientRect().left + clipper.clientLeft + EDGE_PAD : EDGE_PAD;
      const over = edge - (left - (GAP + SIZE) * k);
      // A wide band holds it inside its own corner (canvas.css), never out in a margin.
      const nudge = over > 0 && !host.hasAttribute("data-wide") ? over / k : 0;
      const translate = nudge ? `${nudge}px 0` : "";
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
