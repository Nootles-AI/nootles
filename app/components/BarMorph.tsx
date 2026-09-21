"use client";

import { Component, createRef, type ReactNode } from "react";

/**
 * The foot-of-the-page bar turning over between the page's tools and a
 * diagram's, as one object changing shape rather than one bar leaving and
 * another arriving.
 *
 * The two bars are different components, so there is nothing to animate
 * between in React's terms. What they share is what they show: the same
 * buttons under the same names. So the outgoing bar is measured the instant
 * before it is replaced (`getSnapshotBeforeUpdate`, the one moment the old
 * DOM and the new props coexist) and the incoming one is played back from it,
 * FLIP-style — its surface stretched from the old outline, each button it
 * shares sliding from where it was, the shapes folding into (or fanning out
 * of) their slot, and anything only one bar has fading through.
 */

type Part = { el: HTMLElement; rect: DOMRect; shape: boolean };
type Shot = { bar: DOMRect; parts: Map<string, Part>; slot: DOMRect | null };

const BAR = ".nt-toolbar-dock:not([data-leaving]) > .nt-toolbar";
const MS = 440;
const OUT_MS = 160;
const EASE = "cubic-bezier(0.25, 0, 0, 1)";

/** Every piece of a bar, by a name both bars would give it. */
function partsOf(bar: HTMLElement): Map<string, HTMLElement> {
  const parts = new Map<string, HTMLElement>();
  let sep = 0;
  for (const el of bar.querySelectorAll<HTMLElement>("button, .nt-toolbar-mark, .nt-toolbar-sep")) {
    const name = el.classList.contains("nt-toolbar-mark")
      ? "mark"
      : el.classList.contains("nt-toolbar-sep")
        ? `sep:${sep++}`
        : (el.getAttribute("aria-label") ?? el.textContent?.trim());
    if (name) parts.set(name, el);
  }
  return parts;
}

function measure(root: HTMLElement | null): Shot | null {
  const bar = root?.querySelector<HTMLElement>(BAR);
  if (!bar) return null;
  // Caught mid-morph, the outline is the skin's: the bar itself is already
  // at its destination size with its surface lent out.
  const skin = bar.parentElement?.querySelector<HTMLElement>(":scope > .nt-toolbar-skin");
  const parts = new Map<string, Part>();
  for (const [name, el] of partsOf(bar)) {
    parts.set(name, { el, rect: el.getBoundingClientRect(), shape: el.dataset.shape !== undefined });
  }
  const slot = bar.querySelector(".nt-toolbar-shapes")?.getBoundingClientRect() ?? null;
  return { bar: (skin ?? bar).getBoundingClientRect(), parts, slot };
}

const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/** The move from `to` back to `from`, as the `translate`/`scale` a FLIP starts at. */
function offset(from: DOMRect, to: DOMRect, scale = true) {
  const a = centre(from);
  const b = centre(to);
  return {
    translate: `${a.x - b.x}px ${a.y - b.y}px`,
    scale: scale ? `${from.width / to.width} ${from.height / to.height}` : "1",
  };
}

function play(root: HTMLElement | null, shot: Shot) {
  const bar = root?.querySelector<HTMLElement>(BAR);
  const dock = bar?.parentElement;
  if (!bar || !dock) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

  // It is not arriving, it is changing: no rise from below.
  for (const a of bar.getAnimations()) if (a instanceof CSSAnimation) a.cancel();
  const spring =
    getComputedStyle(document.documentElement).getPropertyValue("--spring").trim() || EASE;
  const now = bar.getBoundingClientRect();
  const home = dock.getBoundingClientRect();
  const slot = bar.querySelector(".nt-toolbar-shapes")?.getBoundingClientRect() ?? null;

  // The surface: lent to a skin behind the bar for the length of the morph,
  // so the outline can stretch while the buttons keep their true size.
  const look = getComputedStyle(bar);
  const skin = document.createElement("div");
  skin.className = "nt-toolbar-skin";
  Object.assign(skin.style, {
    position: "absolute",
    pointerEvents: "none",
    background: look.backgroundColor,
    boxShadow: look.boxShadow,
    borderRadius: look.borderRadius,
  });
  dock.prepend(skin);
  const lent = { background: bar.style.background, boxShadow: bar.style.boxShadow, position: bar.style.position };
  Object.assign(bar.style, { background: "transparent", boxShadow: "none", position: "relative" });
  const box = (r: DOMRect) => ({
    left: `${r.left - home.left}px`,
    top: `${r.top - home.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
  skin
    .animate([box(shot.bar), box(now)], { duration: MS, easing: spring, fill: "forwards" })
    .finished.then(
      () => {
        skin.remove();
        Object.assign(bar.style, lent);
      },
      () => skin.remove(),
    );

  const seen = new Set<string>();
  for (const [name, el] of partsOf(bar)) {
    const was = shot.parts.get(name);
    const is = el.getBoundingClientRect();
    // A fresh element's own transitions (the mark inking in) would replay what
    // the morph is already showing.
    for (const a of el.getAnimations()) if (a instanceof CSSTransition) a.finish();
    if (was) {
      seen.add(name);
      el.animate([offset(was.rect, is, name === "mark"), { translate: "0 0", scale: "1" }], {
        duration: MS,
        easing: spring,
      });
    } else if (el.dataset.shape !== undefined && shot.slot) {
      // Fanning out of the slot they were folded into.
      el.animate(
        [{ ...offset(shot.slot, is, false), scale: "0.5", opacity: 0 }, { translate: "0 0", scale: "1", opacity: 1 }],
        { duration: MS, easing: spring },
      );
    } else {
      el.animate([{ opacity: 0, scale: "0.6" }, { opacity: 1, scale: "1" }], {
        duration: MS,
        delay: 60,
        easing: spring,
        fill: "backwards",
      });
    }
  }

  // What only the old bar had is gone from the DOM; a copy of it stays for
  // long enough to leave — into the slot if it was a shape, else in place.
  for (const [name, part] of shot.parts) {
    if (seen.has(name)) continue;
    const ghost = part.el.cloneNode(true) as HTMLElement;
    ghost.setAttribute("inert", "");
    ghost.removeAttribute("aria-pressed");
    Object.assign(ghost.style, {
      position: "absolute",
      margin: "0",
      pointerEvents: "none",
      ...box(part.rect),
    });
    dock.append(ghost);
    const into = part.shape && slot;
    ghost
      .animate(
        into
          ? [{ opacity: 1 }, { ...offset(slot, part.rect, false), scale: "0.5", opacity: 0 }]
          : [{ opacity: 1 }, { opacity: 0, scale: "0.6" }],
        { duration: into ? MS * 0.6 : OUT_MS, easing: EASE, fill: "forwards" },
      )
      .finished.finally(() => ghost.remove());
  }
}

export class BarMorph extends Component<{ mode: string; children: ReactNode }> {
  private root = createRef<HTMLDivElement>();

  getSnapshotBeforeUpdate(prev: { mode: string }): Shot | null {
    return prev.mode !== this.props.mode ? measure(this.root.current) : null;
  }

  componentDidUpdate(_prev: unknown, _state: unknown, shot: Shot | null) {
    if (shot) play(this.root.current, shot);
  }

  render() {
    return (
      // The resize handles carry a z-index of their own — hence the stacking
      // context around the bar.
      <div ref={this.root} className="relative" style={{ zIndex: "var(--z-sticky)" }}>
        {this.props.children}
      </div>
    );
  }
}
