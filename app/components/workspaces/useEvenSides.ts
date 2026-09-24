"use client";

import { useLayoutEffect, type RefObject } from "react";

/**
 * Keeps a workspace home's title on the page's centre line. The header's two
 * outer columns are each made at least as wide as the wider of what its first
 * and last children hold, written to `--ws-side` for `.nt-ws-head` to read.
 *
 * A grid can keep a column at least as wide as its contents, or keep two
 * columns equal, but not both at once — and with only the first, the title
 * slides toward whichever side holds less, which in a workspace is always the
 * tools, since the right side holds its people and the way to invite them.
 * Measured as the create button measures its label, and re-measured whenever
 * either side changes size: the people arriving, a name loading in.
 */
export function useEvenSides(head: RefObject<HTMLElement | null>, on: boolean) {
  useLayoutEffect(() => {
    const el = head.current;
    const sides = [el?.firstElementChild, el?.lastElementChild].filter(
      (side): side is Element => !!side,
    );
    if (!on || !el || sides.length < 2) return;
    const measure = () => {
      const widest = Math.max(...sides.map((side) => side.getBoundingClientRect().width));
      el.style.setProperty("--ws-side", `${Math.ceil(widest)}px`);
    };
    measure();
    const watch = new ResizeObserver(measure);
    for (const side of sides) watch.observe(side);
    return () => {
      watch.disconnect();
      el.style.removeProperty("--ws-side");
    };
  }, [head, on]);
}
