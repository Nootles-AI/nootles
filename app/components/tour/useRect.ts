"use client";

import { useEffect, useState } from "react";

export type Rect = { x: number; y: number; width: number; height: number };

/** Under this, a move is not worth a re-render. */
const SLOP = 0.5;

function same(a: Rect | null, b: Rect): boolean {
  if (!a) return false;
  return (
    Math.abs(a.x - b.x) < SLOP &&
    Math.abs(a.y - b.y) < SLOP &&
    Math.abs(a.width - b.width) < SLOP &&
    Math.abs(a.height - b.height) < SLOP
  );
}

/**
 * Where an element is on screen, kept current.
 *
 * A frame loop rather than ResizeObserver plus scroll listeners, because the
 * thing being watched during first run is a block with a suggestion streaming
 * into it: it grows a line at a time, the page reflows under it, and the caret
 * scrolls it. Observers would each catch some of that and none of them all of
 * it. Measuring every frame is what a spotlight actually needs, and it is
 * cheap — `getBoundingClientRect` on one element, with state written only when
 * the number moved.
 *
 * The measurement is stored WITH the element it was taken from, so a target
 * that changes reads as null for the frame before the new one is measured,
 * rather than reporting the old box at the old position.
 */
export function useRect(el: Element | null, padding = 0): Rect | null {
  const [taken, setTaken] = useState<{ el: Element; rect: Rect } | null>(null);

  useEffect(() => {
    if (!el) return;
    let frame = 0;
    let last: Rect | null = null;
    const tick = () => {
      const box = el.getBoundingClientRect();
      const next = {
        x: box.x - padding,
        y: box.y - padding,
        width: box.width + padding * 2,
        height: box.height + padding * 2,
      };
      if (!same(last, next)) {
        last = next;
        setTaken({ el, rect: next });
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [el, padding]);

  return taken?.el === el ? taken.rect : null;
}

/**
 * The element a selector names, while it names one.
 *
 * Re-resolved every frame rather than held, because blocks are replaced rather
 * than mutated when the document changes: a node kept from last render can be
 * detached and still measure, as a stale box at its old position, which is the
 * one failure a spotlight cannot survive.
 */
export function useTarget(selector: string | null): Element | null {
  const [found, setFound] = useState<{ selector: string; el: Element } | null>(null);

  useEffect(() => {
    if (!selector) return;
    let frame = 0;
    let held: Element | null = null;
    const find = () => {
      const el = document.querySelector(selector);
      // Identity, not presence: a re-rendered block is a different node behind
      // the same selector.
      if (el !== held) {
        held = el;
        setFound(el ? { selector, el } : null);
      }
      frame = requestAnimationFrame(find);
    };
    frame = requestAnimationFrame(find);
    return () => cancelAnimationFrame(frame);
  }, [selector]);

  return found?.selector === selector ? found.el : null;
}
